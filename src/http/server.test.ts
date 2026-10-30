import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
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
const services: { close(): Promise<void> }[] = [];

after(async () => {
  await Promise.all(services.map((service) => service.close()));
});

async function start(options: Partial<ServiceOptions> = {}) {
  const service = createService({ routes: [], logger, ...options });
  services.push(service);
  const { port } = await service.listen(0, "127.0.0.1");
  return { service, url: `http://127.0.0.1:${String(port)}` };
}

function gate() {
  const started = Promise.withResolvers<undefined>();
  const released = Promise.withResolvers<undefined>();
  return {
    started: started.promise,
    release: () => {
      released.resolve(undefined);
    },
    wait: () => {
      started.resolve(undefined);
      return released.promise;
    },
  };
}

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
    const body = (await response.json()) as { title: string };
    assert.equal(body.title, "Method Not Allowed");
  });

  test("gives 400 for a param that does not decode", async () => {
    const { url } = await start({ routes });
    const response = await fetch(`${url}/api/tasks/%E0%A4%A`);
    assert.equal(response.status, 400);
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
    assert.equal(((await response.json()) as { code: string }).code, "validation_failed");
    const missing = await fetch(`${url}/echo`, { method: "POST", body: "{}" });
    assert.equal(missing.status, 415);
  });

  test("gives 400 for bad JSON", async () => {
    const { url } = await start({ routes });
    const response = await fetch(`${url}/echo`, json("{bad"));
    assert.equal(response.status, 400);
    assert.equal(
      ((await response.json()) as { detail: string }).detail,
      "The body is not valid JSON",
    );
  });

  test("gives 413 for a declared length above the limit", async () => {
    const { url } = await start({ routes, bodyLimit: 10 });
    const response = await fetch(`${url}/echo`, json({ text: "more than ten bytes" }));
    assert.equal(response.status, 413);
    assert.equal(((await response.json()) as { title: string }).title, "Payload Too Large");
  });

  test("gives 413 for a streamed body above the limit", async () => {
    const { url } = await start({ routes });
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        `${url}/echo`,
        { method: "POST", headers: { "content-type": "application/json" } },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on("error", reject);
      request.write(`"${"a".repeat(2 * 1024 * 1024)}`);
      request.end('"');
    });
    assert.equal(status, 413);
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
    assert.ok(lines.some((line) => line.includes("hunter2") && line.includes("unhandled error")));
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
    assert.match(requestId, /^[0-9a-f-]{36}$/);
    assert.equal(response.headers.get("x-correlation-id"), requestId);
    const body = (await response.json()) as { context: unknown };
    assert.deepEqual(body.context, { requestId, correlationId: requestId });
  });

  test("keeps given ids through async code and drops bad ones", async () => {
    const { url } = await start({ routes });
    const response = await fetch(`${url}/ids`, {
      headers: { "x-request-id": "req-1", "x-correlation-id": "task 1\n" },
    });
    assert.equal(response.headers.get("x-request-id"), "req-1");
    assert.equal(response.headers.get("x-correlation-id"), "req-1");
    const ok = await fetch(`${url}/ids`, {
      headers: { "x-request-id": "req-2", "x-correlation-id": "task-9" },
    });
    const body = (await ok.json()) as { context: unknown };
    assert.deepEqual(body.context, { requestId: "req-2", correlationId: "task-9" });
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

describe("shutdown", () => {
  test("waits for an in-flight request, then runs close hooks in reverse", async () => {
    const order: string[] = [];
    const slow = gate();
    const { service, url } = await start({
      routes: [
        {
          method: "GET",
          path: "/slow",
          handler: async () => {
            await slow.wait();
            order.push("request done");
            return { body: { done: true } };
          },
        },
      ],
      closeHooks: [
        () => {
          order.push("mongo");
        },
        () => {
          throw new Error("nats close failed");
        },
        async () => {
          await sleep(1);
          order.push("telemetry");
        },
      ],
    });
    const inFlight = fetch(`${url}/slow`);
    await slow.started;
    const closed = service.close();
    assert.equal(service.close(), closed);
    await sleep(20);
    assert.deepEqual(order, []);
    slow.release();
    const response = await inFlight;
    assert.deepEqual(await response.json(), { done: true });
    await closed;
    assert.deepEqual(order, ["request done", "telemetry", "mongo"]);
    assert.ok(lines.some((line) => line.includes("close hook failed")));
    await assert.rejects(fetch(`${url}/slow`));
  });

  test("ready gives 503 while it shuts down", async () => {
    const check = gate();
    const { service, url } = await start({
      readiness: { mongo: () => check.wait().then(() => true) },
    });
    const ready = fetch(`${url}/ready`);
    await check.started;
    const closed = service.close();
    check.release();
    const response = await ready;
    assert.equal(response.status, 503);
    assert.deepEqual(((await response.json()) as { failing: string[] }).failing, ["shutdown"]);
    await closed;
  });

  test("closes open connections after the timeout", async () => {
    const hang = gate();
    const { service, url } = await start({
      shutdownTimeoutMs: 50,
      routes: [
        {
          method: "GET",
          path: "/hang",
          handler: async () => {
            await hang.wait();
            return {};
          },
        },
      ],
    });
    const inFlight = fetch(`${url}/hang`);
    await hang.started;
    const started = Date.now();
    await service.close();
    assert.ok(Date.now() - started < 1000);
    await assert.rejects(inFlight);
    assert.ok(lines.some((line) => line.includes("shutdown timeout")));
  });

  test("handles SIGTERM and exits with 0", async () => {
    const { service } = await start();
    const code = await new Promise<number>((resolve) => {
      service.handleSignals(resolve);
      process.emit("SIGTERM", "SIGTERM");
    });
    assert.equal(code, 0);
    process.removeAllListeners("SIGINT");
  });

  test("listen rejects when the port is in use", async () => {
    const { service } = await start();
    const address = service.server.address();
    assert.ok(address && typeof address === "object");
    const other = createService({ routes: [], logger });
    await assert.rejects(other.listen(address.port, "127.0.0.1"), { code: "EADDRINUSE" });
  });
});
