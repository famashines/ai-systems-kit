import { randomUUID } from "node:crypto";
import {
  STATUS_CODES,
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "pino";
import type { z } from "zod";
import { runWithContext } from "./context.ts";
import { DomainError, NotFoundError, ValidationError, type Issue } from "./errors.ts";
import { createRouter, type Request, type Route } from "./router.ts";

export type Hook = (request: Request) => void | Promise<void>;
export type ReadinessCheck = () => boolean | Promise<boolean>;
export type CloseHook = () => void | Promise<void>;
export type MetricsHandler = (request: IncomingMessage, response: ServerResponse) => void;

export interface ServiceOptions {
  routes: readonly Route[];
  logger: Logger;
  before?: readonly Hook[];
  readiness?: Readonly<Record<string, ReadinessCheck>>;
  closeHooks?: readonly CloseHook[];
  metrics?: MetricsHandler;
  bodyLimit?: number;
  readinessTimeoutMs?: number;
  drainDelayMs?: number;
  shutdownTimeoutMs?: number;
}

export interface Service {
  server: Server;
  listen(port: number, host?: string): Promise<AddressInfo>;
  close(): Promise<boolean>;
  handleSignals(exit?: (code: number) => void): void;
}

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const pickId = (value: string | string[] | undefined): string | undefined =>
  typeof value === "string" && uuidV4.test(value) ? value : undefined;

const closeConnection = { connection: "close" };

const tooLarge = (): DomainError =>
  new DomainError("payload_too_large", 413, "The body is larger than the limit", closeConnection);

async function readJson(raw: IncomingMessage, limit: number): Promise<unknown> {
  const type = raw.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type !== "application/json" && !type.endsWith("+json")) {
    throw new DomainError(
      "unsupported_media_type",
      415,
      "The content type must be application/json",
      closeConnection,
    );
  }
  if (Number(raw.headers["content-length"]) > limit) throw tooLarge();
  const text = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limit) {
        raw.off("data", onData);
        raw.pause();
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    };
    raw.on("data", onData);
    raw.once("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    raw.once("error", reject);
  });
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ValidationError("The body is not valid JSON", [], closeConnection);
  }
}

interface Schemas {
  body?: z.ZodType;
  params?: z.ZodType;
  query?: z.ZodType;
}

export type Validated<S extends Schemas> = {
  [K in keyof S]: S[K] extends z.ZodType ? z.output<S[K]> : never;
};

export async function validate<S extends Schemas>(
  request: Request,
  schemas: S,
): Promise<Validated<S>> {
  const result: Record<string, unknown> = {};
  const issues: Issue[] = [];
  for (const key of ["params", "query", "body"] as const) {
    const schema = schemas[key];
    if (!schema) continue;
    const input =
      key === "body"
        ? await request.json()
        : key === "params"
          ? request.params
          : Object.fromEntries(request.query);
    const parsed = schema.safeParse(input);
    if (parsed.success) {
      result[key] = parsed.data;
      continue;
    }
    for (const issue of parsed.error.issues) {
      issues.push({
        path: [key, ...issue.path.map(String)].join("."),
        code: issue.code,
        message: issue.message,
      });
    }
  }
  if (issues.length > 0) throw new ValidationError("The request is not valid", issues);
  return result as Validated<S>;
}

const isJson = (type: string): boolean => /^application\/([\w.-]+\+)?json\b/i.test(type);

function send(response: ServerResponse, status: number, body: unknown, type: string): void {
  if (body === undefined) {
    response.writeHead(status).end();
    return;
  }
  const payload =
    !isJson(type) && (typeof body === "string" || body instanceof Uint8Array)
      ? body
      : JSON.stringify(body);
  response
    .writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(payload) })
    .end(payload);
}

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  send(response, status, body, "application/json");
};

function sendProblem(
  response: ServerResponse,
  status: number,
  code: string,
  detail: string,
  instance: string,
  extra: Record<string, unknown> = {},
): void {
  send(
    response,
    status,
    { type: "about:blank", title: STATUS_CODES[status], status, code, detail, instance, ...extra },
    "application/problem+json",
  );
}

export function createService(options: ServiceOptions): Service {
  const {
    logger,
    before = [],
    readiness = {},
    closeHooks = [],
    metrics,
    bodyLimit = 1024 * 1024,
    readinessTimeoutMs = 2000,
    drainDelayMs = 5000,
    shutdownTimeoutMs = 19_000,
  } = options;
  const route = createRouter(options.routes);
  const active = new Set<ServerResponse>();
  let state: "running" | "draining" | "closing" = "running";
  let closing: Promise<boolean> | undefined;
  let signalsHandled = false;

  async function runCheck(name: string, check: ReadinessCheck): Promise<string | undefined> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        resolve("timeout");
      }, readinessTimeoutMs);
    });
    try {
      const result = await Promise.race([Promise.resolve().then(check), timeout]);
      if (result === "timeout") {
        logger.warn({ check: name }, "readiness check timed out");
        return name;
      }
      return result ? undefined : name;
    } catch (error) {
      logger.warn({ err: error, check: name }, "readiness check failed");
      return name;
    } finally {
      clearTimeout(timer);
    }
  }

  async function ready(response: ServerResponse, path: string): Promise<void> {
    const results = await Promise.all(
      Object.entries(readiness).map(([name, check]) => runCheck(name, check)),
    );
    const failing = results.filter((name) => name !== undefined);
    if (state !== "running") failing.unshift("shutdown");
    if (failing.length > 0) {
      sendProblem(response, 503, "unavailable", "The service is not ready", path, { failing });
      return;
    }
    sendJson(response, 200, { status: "ready" });
  }

  async function dispatch(
    raw: IncomingMessage,
    response: ServerResponse,
    ids: { requestId: string; correlationId: string },
    path: string,
    search: string,
  ): Promise<void> {
    const method = raw.method ?? "GET";
    if (method === "GET" && path === "/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (method === "GET" && path === "/ready") {
      await ready(response, path);
      return;
    }
    if (metrics && method === "GET" && path === "/metrics") {
      metrics(raw, response);
      return;
    }
    let body: Promise<unknown> | undefined;
    const params: Record<string, string> = {};
    const request: Request = {
      method,
      path,
      params,
      query: new URLSearchParams(search),
      headers: raw.headers,
      raw,
      ...ids,
      state: {},
      json: () => (body ??= readJson(raw, bodyLimit)),
    };
    for (const hook of before) await hook(request);
    const match = route(method, path);
    if (!match) throw new NotFoundError("The route does not exist");
    if ("allow" in match) {
      throw new DomainError("method_not_allowed", 405, "The method is not allowed on this route", {
        allow: match.allow.join(", "),
      });
    }
    Object.assign(params, match.params);
    const reply = await match.route.handler(request);
    for (const [name, value] of Object.entries(reply.headers ?? {})) {
      response.setHeader(name, value);
    }
    const type = response.getHeader("content-type");
    send(response, reply.status ?? 200, reply.body, String(type ?? "application/json"));
  }

  function fail(
    raw: IncomingMessage,
    response: ServerResponse,
    error: unknown,
    path: string,
  ): void {
    if (error instanceof DomainError) {
      for (const [name, value] of Object.entries(error.headers)) response.setHeader(name, value);
      if (error.headers.connection === "close") {
        const socket = raw.socket;
        response.once("finish", () => {
          socket.destroy();
        });
      }
      const extra =
        error instanceof ValidationError && error.issues.length > 0 ? { errors: error.issues } : {};
      sendProblem(response, error.status, error.code, error.message, path, extra);
      return;
    }
    logger.error({ err: error, method: raw.method, path }, "unhandled error");
    sendProblem(response, 500, "internal", "An internal error occurred", path);
  }

  const server = createServer(
    { headersTimeout: 10_000, requestTimeout: 30_000, keepAliveTimeout: 95_000 },
    (raw, response) => {
      const requestId = pickId(raw.headers["x-request-id"]) ?? randomUUID();
      const correlationId = pickId(raw.headers["x-correlation-id"]) ?? requestId;
      response.setHeader("x-request-id", requestId);
      response.setHeader("x-correlation-id", correlationId);
      response.setHeader("x-content-type-options", "nosniff");
      response.setHeader("cache-control", "no-store");
      if (state !== "running") response.setHeader("connection", "close");
      active.add(response);
      response.once("close", () => {
        active.delete(response);
        if (state === "closing") server.closeIdleConnections();
      });
      const url = raw.url ?? "/";
      const mark = url.indexOf("?");
      const path = mark === -1 ? url : url.slice(0, mark);
      const search = mark === -1 ? "" : url.slice(mark + 1);
      void runWithContext({ requestId, correlationId }, () =>
        dispatch(raw, response, { requestId, correlationId }, path, search).catch(
          (error: unknown) => {
            if (response.headersSent) {
              logger.error(
                { err: error, method: raw.method, path },
                "error after the response started",
              );
              response.destroy();
              return;
            }
            fail(raw, response, error, path);
          },
        ),
      );
    },
  );
  server.maxHeadersCount = 100;

  async function shutdown(): Promise<boolean> {
    state = "draining";
    for (const response of active) {
      if (!response.headersSent) response.setHeader("connection", "close");
    }
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => {
        resolve("expired");
      }, shutdownTimeoutMs);
    });
    let clean = true;
    await Promise.race([sleep(drainDelayMs), expired]);
    state = "closing";
    const closed = new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    server.closeIdleConnections();
    if ((await Promise.race([closed, expired])) === "expired") {
      logger.error("shutdown deadline passed, closing open connections");
      server.closeAllConnections();
      clean = false;
    }
    for (const hook of [...closeHooks].reverse()) {
      const run = Promise.resolve()
        .then(hook)
        .then(
          () => true,
          (error: unknown) => {
            logger.error({ err: error }, "close hook failed");
            return false;
          },
        );
      const result = await Promise.race([run, expired]);
      if (result === "expired")
        logger.error("a close hook did not end before the shutdown deadline");
      if (result !== true) clean = false;
    }
    clearTimeout(timer);
    return clean;
  }

  function close(): Promise<boolean> {
    closing ??= shutdown();
    return closing;
  }

  return {
    server,
    listen: (port, host) =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve(server.address() as AddressInfo);
        });
      }),
    close,
    handleSignals(exit = (code) => process.exit(code)) {
      if (signalsHandled) return;
      signalsHandled = true;
      let exiting: Promise<void> | undefined;
      const onSignal = (signal: NodeJS.Signals): void => {
        logger.info({ signal }, "shutdown started");
        exiting ??= close().then((clean) => {
          exit(clean ? 0 : 1);
        });
      };
      process.on("SIGTERM", onSignal);
      process.on("SIGINT", onSignal);
    },
  };
}
