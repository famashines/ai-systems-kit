import assert from "node:assert/strict";
import { once } from "node:events";
import { get } from "node:http";
import { connect } from "node:net";
import { after, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pino } from "pino";
import { z } from "zod";
import {
  ConflictError,
  DomainError,
  ForbiddenError,
  getContext,
  NotFoundError,
  RateLimitedError,
  UnauthorizedError,
  UnavailableError,
  validate,
  ValidationError,
  createService,
  type Route,
  type ServiceOptions,
} from "./index.ts";

const lines: string[] = [];
const logger = pino({ level: "debug" }, { write: (line: string) => lines.push(line) });
const services: { close(): Promise<boolean> }[] = [];

after(async () => {
  await Promise.all(services.map((service) => service.close()));
});

async function start(options: Partial<ServiceOptions> = {}) {
  const service = createService({ routes: [], logger, drainDelayMs: 0, ...options });
  services.push(service);
  const { port } = await service.listen(0, "127.0.0.1");
  return { service, port, url: `http://127.0.0.1:${String(port)}` };
}

const uuid = (n: number): string => `6f1c3c7e-2d0a-4f3b-9a7e-${String(n).padStart(12, "0")}`;

const json = (body: unknown, type = "application/json"): RequestInit => ({
  method: "POST",
  headers: { "content-type": type },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

describe("routing", () => {
  const routes: Route[] = [
    {
      method: "GET",
      path: "/api/tasks/:taskId",
      handler: (request) => ({ body: { taskId: request.params.taskId } }),
    },
    {
      method: "DELETE",
      path: "/api/tasks/:taskId",
      handler: () => ({ status: 204 }),
    },
    {
      method: "GET",
      path: "/api/tasks",
      handler: (request) => ({
        headers: { "x-total": "0" },
        body: { status: request.query.get("status") },
      }),
    },
  ];

  test("matches a path with params", async () => {
    const { url } = await start({ routes });
    const response = await fetch(`${url}/api/tasks/t%201`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { taskId: "t 1" });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  });

  test("gives the query, reply headers and an empty 204", async () => {
    const { url } = await start({ routes });
    const list = await fetch(`${url}/api/tasks?status=open`);
    assert.equal(list.headers.get("x-total"), "0");
    assert.deepEqual(await list.json(), { status: "open" });
    const removed = await fetch(`${url}/api/tasks/a`, { method: "DELETE" });
    assert.equal(removed.status, 204);
    assert.equal(await removed.text(), "");
  });

  test("gives 404 problem JSON for an unknown path", async () => {
    const { url } = await start({ routes });
    const response = await fetch(`${url}/api/nothing?x=1`);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("content-type"), "application/problem+json");
    assert.deepEqual(await response.json(), {
      type: "about:blank",
      title: "Not Found",
      status: 404,
      code: "not_found",
      detail: "The route does not exist",
      instance: "/api/nothing",
    });
  });

  test("gives 405 with an allow header for a known path", async () => {
    const { url } = await start({ routes });
    const response = await fetch(`${url}/api/tasks/a`, { method: "PUT" });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, DELETE");
    const body = (await response.json()) as { title: string; code: string };
    assert.equal(body.title, "Method Not Allowed");
    assert.equal(body.code, "method_not_allowed");
  });

  test("gives 400 for a param that does not decode or is a path", async () => {
    const { port } = await start({ routes });
    const status = (path: string) =>
      new Promise<number | undefined>((resolve, reject) => {
        get({ host: "127.0.0.1", port, path }, (response) => {
          response.resume();
          resolve(response.statusCode);
        }).on("error", reject);
      });
    for (const param of ["%E0%A4%A", "a%2Fb", "a%5Cb", "%2E", "%2E%2E", "%2e%2e"]) {
      assert.equal(await status(`/api/tasks/${param}`), 400, param);
    }
    assert.equal(await status("/api/tasks/a.b"), 200);
  });
});

describe("body and validation", () => {
  const schema = z.object({ title: z.string().min(1), password: z.string() });
  const routes: Route[] = [
    {
      method: "POST",
      path: "/echo",
      handler: async (request) => ({ status: 201, body: await request.json() }),
    },
    {
      method: "POST",
      path: "/tasks/:taskId",
      handler: async (request) => {
        const input = await validate(request, {
          body: schema,
          params: z.object({ taskId: z.uuid() }),
          query: z.object({ dry: z.enum(["yes", "no"]).optional() }),
        });
        return { body: { title: input.body.title, taskId: input.params.taskId } };
      },
    },
    {
      method: "POST",
      path: "/twice",
      handler: async (request) => {
        const first = await request.json();
        const second = await request.json();
        return { body: { same: first === second } };
      },
    },
  ];

  test("reads a JSON body", async () => {
    const { url } = await start({ routes });
    const response = await fetch(`${url}/echo`, json({ a: 1 }, "application/json; charset=utf-8"));
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { a: 1 });
  });

  test("accepts a +json content type and reads the body once", async () => {
    const { url } = await start({ routes });
    const response = await fetch(`${url}/twice`, json({ a: 1 }, "application/merge-patch+json"));
    assert.deepEqual(await response.json(), { same: true });
  });

  test("gives 415 for a wrong content type", async () => {
    const { url } = await start({ routes });
    const response = await fetch(`${url}/echo`, json("a=1", "text/plain"));
    assert.equal(response.status, 415);
    assert.equal(response.headers.get("connection"), "close");
    assert.equal(((await response.json()) as { code: string }).code, "unsupported_media_type");
    const missing = await fetch(`${url}/echo`, { method: "POST", body: "{}" });
    assert.equal(missing.status, 415);
  });

  test("gives 400 for bad JSON", async () => {
    const { url } = await start({ routes });
    const response = await fetch(`${url}/echo`, json("{bad"));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("connection"), "close");
    assert.equal(
      ((await response.json()) as { detail: string }).detail,
      "The body is not valid JSON",
    );
  });

  test("gives 413 for a declared length above the limit", async () => {
    const { url } = await start({ routes, bodyLimit: 10 });
    const response = await fetch(`${url}/echo`, json({ text: "more than ten bytes" }));
    assert.equal(response.status, 413);
    assert.equal(response.headers.get("connection"), "close");
    const body = (await response.json()) as { title: string; code: string };
    assert.equal(body.title, "Payload Too Large");
    assert.equal(body.code, "payload_too_large");
  });

  test("closes the socket within 1 s when a chunked flood passes the limit", async () => {
    const { port } = await start({ routes, bodyLimit: 1024 });
    const socket = connect(port, "127.0.0.1");
    await once(socket, "connect");
    let received = "";
    socket.on("data", (data: Buffer) => {
      received += data.toString();
    });
    socket.on("error", () => undefined);
    socket.write(
      "POST /echo HTTP/1.1\r\nhost: kit\r\ncontent-type: application/json\r\n" +
        "transfer-encoding: chunked\r\n\r\n",
    );
    const chunk = `4000\r\n${"a".repeat(0x4000)}\r\n`;
    const flood = setInterval(() => {
      if (socket.writable) socket.write(chunk);
    }, 1);
    const closed = new Promise<string>((resolve) => {
      socket.once("close", () => {
        clearInterval(flood);
        resolve("closed");
      });
    });
    const result = await Promise.race([closed, sleep(1000).then(() => "open")]);
    clearInterval(flood);
    socket.destroy();
    assert.equal(result, "closed");
    assert.match(received, /^HTTP\/1\.1 413/);
    assert.match(received, /connection: close/i);
  });

  test("gives 400 with issue paths and no values", async () => {
    const { url } = await start({ routes });
    const response = await fetch(
      `${url}/tasks/not-a-uuid?dry=maybe`,
      json({ title: "", password: 12345678 }),
    );
    assert.equal(response.status, 400);
    const text = await response.text();
    assert.ok(!text.includes("12345678"));
    assert.ok(!text.includes("maybe"));
    const body = JSON.parse(text) as { code: string; errors: { path: string; code: string }[] };
    assert.equal(body.code, "validation_failed");
    assert.deepEqual(
      body.errors.map((issue) => issue.path),
      ["params.taskId", "query.dry", "body.title", "body.password"],
    );
  });

  test("gives the parsed values on success", async () => {
    const { url } = await start({ routes });
    const id = "6f1c3c7e-2d0a-4f3b-9a7e-1c2b3d4e5f60";
    const response = await fetch(`${url}/tasks/${id}`, json({ title: "a", password: "p" }));
    assert.deepEqual(await response.json(), { title: "a", taskId: id });
  });
});

describe("errors", () => {
  const cases: [DomainError, number, string][] = [
    [new ValidationError(), 400, "validation_failed"],
    [new UnauthorizedError(), 401, "unauthorized"],
    [new ForbiddenError(), 403, "forbidden"],
    [new NotFoundError(), 404, "not_found"],
    [new ConflictError(), 409, "conflict"],
    [new RateLimitedError(), 429, "rate_limited"],
    [new UnavailableError(), 503, "unavailable"],
    [new DomainError("budget_refused", 402, "The budget is used up"), 402, "budget_refused"],
  ];

  for (const [error, status, code] of cases) {
    test(`maps ${error.name} to ${String(status)}`, async () => {
      const { url } = await start({
        routes: [
          {
            method: "GET",
            path: "/fail",
            handler: () => {
              throw error;
            },
          },
        ],
      });
      const response = await fetch(`${url}/fail`);
      assert.equal(response.status, status);
      const body = (await response.json()) as { code: string; detail: string };
      assert.equal(body.code, code);
      assert.equal(body.detail, error.message);
    });
  }

  test("maps an unknown error to 500 with no detail and logs it", async () => {
    const { url } = await start({
      routes: [
        {
          method: "GET",
          path: "/boom",
          handler: () => {
            throw new Error("database password is hunter2");
          },
        },
      ],
    });
    const response = await fetch(`${url}/boom`);
    assert.equal(response.status, 500);
    const text = await response.text();
    assert.ok(!text.includes("hunter2"));
    assert.equal((JSON.parse(text) as { code: string }).code, "internal");
    const logged = lines.find((line) => line.includes("unhandled error")) ?? "";
    assert.ok(logged.includes("hunter2"));
    assert.ok(logged.includes('"method":"GET"') && logged.includes('"path":"/boom"'));
  });

  test("destroys the response when an error comes after the headers", async () => {
    const { url } = await start({
      metrics: (_request, response) => {
        response.writeHead(200);
        throw new Error("late");
      },
    });
    await assert.rejects(fetch(`${url}/metrics`).then((response) => response.text()));
    assert.ok(lines.some((line) => line.includes("error after the response started")));
  });
});

describe("ids and hooks", () => {
  const routes: Route[] = [
    {
      method: "GET",
      path: "/ids",
      handler: async (request) => {
        await sleep(5);
        await new Promise((resolve) => setImmediate(resolve));
        return { body: { context: getContext(), user: request.state.user } };
      },
    },
  ];

  test("makes a request id and uses it as correlation id", async () => {
    const { url } = await start({ routes });
    const response = await fetch(`${url}/ids`);
    const requestId = response.headers.get("x-request-id") ?? "";
    assert.match(
      requestId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.equal(response.headers.get("x-correlation-id"), requestId);
    const body = (await response.json()) as { context: unknown };
    assert.deepEqual(body.context, { requestId, correlationId: requestId });
  });

  test("keeps given UUID v4 ids through async code and drops others", async () => {
    const { url } = await start({ routes });
    for (const bad of ["req-1", uuid(1).toUpperCase(), "6f1c3c7e-2d0a-1f3b-9a7e-000000000001"]) {
      const response = await fetch(`${url}/ids`, {
        headers: { "x-request-id": bad, "x-correlation-id": bad },
      });
      const requestId = response.headers.get("x-request-id") ?? "";
      assert.notEqual(requestId, bad);
      assert.equal(response.headers.get("x-correlation-id"), requestId);
    }
    const ok = await fetch(`${url}/ids`, {
      headers: { "x-request-id": uuid(2), "x-correlation-id": uuid(3) },
    });
    assert.equal(ok.headers.get("x-request-id"), uuid(2));
    const body = (await ok.json()) as { context: unknown };
    assert.deepEqual(body.context, { requestId: uuid(2), correlationId: uuid(3) });
  });

  test("runs before hooks before routing", async () => {
    const { url } = await start({
      routes,
      before: [
        () => {
          throw new UnauthorizedError(undefined, { "www-authenticate": "Bearer" });
        },
      ],
    });
    for (const [path, method] of [
      ["/nothing", "GET"],
      ["/ids", "DELETE"],
    ] as const) {
      const response = await fetch(`${url}${path}`, { method });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("www-authenticate"), "Bearer");
      assert.equal(response.headers.get("allow"), null);
    }
  });

  test("runs before hooks in order and lets them reject", async () => {
    const order: string[] = [];
    const { url } = await start({
      routes,
      before: [
        (request) => {
          order.push("first");
          if (request.headers.authorization !== "Bearer ok") throw new UnauthorizedError();
        },
        async (request) => {
          await sleep(1);
          order.push("second");
          request.state.user = "owner";
        },
      ],
    });
    const denied = await fetch(`${url}/ids`);
    assert.equal(denied.status, 401);
    const allowed = await fetch(`${url}/ids`, { headers: { authorization: "Bearer ok" } });
    assert.equal(((await allowed.json()) as { user: string }).user, "owner");
    assert.deepEqual(order, ["first", "first", "second"]);
  });
});

describe("replies", () => {
  test("sends a text body with the content type of the handler", async () => {
    const { url } = await start({
      routes: [
        {
          method: "GET",
          path: "/text",
          handler: () => ({ headers: { "Content-Type": "text/plain" }, body: "plain" }),
        },
        {
          method: "GET",
          path: "/json",
          handler: () => ({ body: "quoted" }),
        },
      ],
    });
    const text = await fetch(`${url}/text`);
    assert.equal(text.headers.get("content-type"), "text/plain");
    assert.equal(await text.text(), "plain");
    const json = await fetch(`${url}/json`);
    assert.equal(json.headers.get("content-type"), "application/json");
    assert.equal(await json.text(), '"quoted"');
  });

  test("gives the headers of a DomainError", async () => {
    const { url } = await start({
      routes: [
        {
          method: "GET",
          path: "/limited",
          handler: () => {
            throw new RateLimitedError(undefined, { "retry-after": "30" });
          },
        },
      ],
    });
    const response = await fetch(`${url}/limited`);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "30");
  });
});

describe("health, readiness and metrics", () => {
  test("health is up and skips the before hooks", async () => {
    const { url } = await start({
      before: [
        () => {
          throw new UnauthorizedError();
        },
      ],
    });
    const response = await fetch(`${url}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  });

  test("ready gives 200 when all checks pass", async () => {
    const { url } = await start({
      readiness: { mongo: () => true, nats: () => Promise.resolve(true) },
    });
    const response = await fetch(`${url}/ready`);
    assert.equal(response.status, 200);
  });

  test("ready gives 503 with the failing check names", async () => {
    const { url } = await start({
      readiness: {
        mongo: () => true,
        nats: () => false,
        migrations: () => Promise.reject(new Error("not done")),
      },
    });
    const response = await fetch(`${url}/ready`);
    assert.equal(response.status, 503);
    const body = (await response.json()) as { code: string; failing: string[] };
    assert.equal(body.code, "unavailable");
    assert.deepEqual(body.failing, ["nats", "migrations"]);
  });

  test("ready lists a check that does not end before the timeout", async () => {
    const { url } = await start({
      readinessTimeoutMs: 50,
      readiness: { mongo: () => true, nats: () => new Promise<boolean>(() => undefined) },
    });
    const started = Date.now();
    const response = await fetch(`${url}/ready`);
    assert.ok(Date.now() - started < 1000);
    assert.equal(response.status, 503);
    assert.deepEqual(((await response.json()) as { failing: string[] }).failing, ["nats"]);
    assert.ok(lines.some((line) => line.includes("readiness check timed out")));
  });

  test("serves /metrics with the given handler", async () => {
    const { url } = await start({
      metrics: (_request, response) => {
        response.writeHead(200, { "content-type": "text/plain" }).end("up 1\n");
      },
    });
    const response = await fetch(`${url}/metrics`);
    assert.equal(await response.text(), "up 1\n");
  });
});
