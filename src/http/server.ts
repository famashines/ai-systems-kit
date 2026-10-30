import { randomUUID } from "node:crypto";
import {
  STATUS_CODES,
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
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
  shutdownTimeoutMs?: number;
}

export interface Service {
  server: Server;
  listen(port: number, host?: string): Promise<AddressInfo>;
  close(): Promise<void>;
  handleSignals(exit?: (code: number) => void): void;
}

const idPattern = /^[\w.:-]{1,128}$/;

const pickId = (value: string | string[] | undefined): string | undefined =>
  typeof value === "string" && idPattern.test(value) ? value : undefined;

const tooLarge = (): DomainError =>
  new DomainError("validation_failed", 413, "The body is larger than the limit");

async function readJson(raw: IncomingMessage, limit: number): Promise<unknown> {
  const type = raw.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type !== "application/json" && !type.endsWith("+json")) {
    throw new DomainError("validation_failed", 415, "The content type must be application/json");
  }
  if (Number(raw.headers["content-length"]) > limit) throw tooLarge();
  const text = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limit) {
        raw.off("data", onData);
        raw.resume();
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
    throw new ValidationError("The body is not valid JSON");
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

function send(
  response: ServerResponse,
  status: number,
  body: unknown,
  type = "application/json",
): void {
  if (body === undefined) {
    response.writeHead(status).end();
    return;
  }
  const text = JSON.stringify(body);
  response
    .writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(text) })
    .end(text);
}

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
    shutdownTimeoutMs = 15_000,
  } = options;
  const route = createRouter(options.routes);
  let closing: Promise<void> | undefined;

  async function ready(response: ServerResponse, path: string): Promise<void> {
    const results = await Promise.all(
      Object.entries(readiness).map(async ([name, check]) => {
        try {
          return (await check()) ? undefined : name;
        } catch (error) {
          logger.warn({ err: error, check: name }, "readiness check failed");
          return name;
        }
      }),
    );
    const failing = results.filter((name) => name !== undefined);
    if (closing) failing.unshift("shutdown");
    if (failing.length > 0) {
      sendProblem(response, 503, "unavailable", "The service is not ready", path, { failing });
      return;
    }
    send(response, 200, { status: "ready" });
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
      send(response, 200, { status: "ok" });
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
    const match = route(method, path);
    if (!match) throw new NotFoundError("The route does not exist");
    if ("allow" in match) {
      response.setHeader("allow", match.allow.join(", "));
      throw new DomainError("not_found", 405, "The method is not allowed on this route");
    }
    let body: Promise<unknown> | undefined;
    const request: Request = {
      method,
      path,
      params: match.params,
      query: new URLSearchParams(search),
      headers: raw.headers,
      raw,
      ...ids,
      state: {},
      json: () => (body ??= readJson(raw, bodyLimit)),
    };
    for (const hook of before) await hook(request);
    const reply = await match.route.handler(request);
    for (const [name, value] of Object.entries(reply.headers ?? {})) {
      response.setHeader(name, value);
    }
    send(response, reply.status ?? 200, reply.body);
  }

  function fail(response: ServerResponse, error: unknown, path: string): void {
    if (error instanceof DomainError) {
      const extra =
        error instanceof ValidationError && error.issues.length > 0 ? { errors: error.issues } : {};
      sendProblem(response, error.status, error.code, error.message, path, extra);
      return;
    }
    logger.error({ err: error }, "unhandled error");
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
      response.once("close", () => {
        if (closing) server.closeIdleConnections();
      });
      const url = raw.url ?? "/";
      const mark = url.indexOf("?");
      const path = mark === -1 ? url : url.slice(0, mark);
      const search = mark === -1 ? "" : url.slice(mark + 1);
      void runWithContext({ requestId, correlationId }, () =>
        dispatch(raw, response, { requestId, correlationId }, path, search).catch(
          (error: unknown) => {
            if (response.headersSent) {
              logger.error({ err: error }, "error after the response started");
              response.destroy();
              return;
            }
            fail(response, error, path);
          },
        ),
      );
    },
  );
  server.maxHeadersCount = 100;

  function close(): Promise<void> {
    closing ??= (async () => {
      const closed = new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      server.closeIdleConnections();
      const timer = setTimeout(() => {
        logger.warn("shutdown timeout, closing open connections");
        server.closeAllConnections();
      }, shutdownTimeoutMs);
      await closed;
      clearTimeout(timer);
      for (const hook of [...closeHooks].reverse()) {
        try {
          await hook();
        } catch (error) {
          logger.error({ err: error }, "close hook failed");
        }
      }
    })();
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
      const onSignal = (signal: NodeJS.Signals): void => {
        logger.info({ signal }, "shutdown started");
        void close().then(() => {
          exit(0);
        });
      };
      process.once("SIGTERM", onSignal);
      process.once("SIGINT", onSignal);
    },
  };
}
