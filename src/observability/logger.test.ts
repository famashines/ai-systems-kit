import assert from "node:assert/strict";
import { test } from "node:test";
import { runWithContext } from "../http/context.ts";
import { createLogger } from "./index.ts";

function capture(level?: string) {
  const lines: string[] = [];
  const logger = createLogger({
    service: "gateway",
    release: "v1.2.3",
    ...(level === undefined ? {} : { level }),
    destination: { write: (line: string) => lines.push(line) },
  });
  return { logger, lines };
}

test("redacts secrets and prompt text in any case, at any depth", () => {
  const { logger, lines } = capture();
  const error = Object.assign(new Error("request failed"), {
    response: { config: { headers: { Authorization: "Bearer top-secret-1" } } },
    cause: Object.assign(new Error("inner"), { api_key: "top-secret-2" }),
  });
  logger.info(
    {
      headers: {
        Authorization: "top-secret-3",
        "x-api-key": "top-secret-4",
        "proxy-authorization": "top-secret-5",
        Cookie: "top-secret-6",
        "Set-Cookie": ["top-secret-7"],
      },
      oauth: { access_token: "top-secret-8", id_token: "top-secret-9" },
      client: { client_secret: "top-secret-10", password: "top-secret-11", refreshToken: "x" },
      a: { b: { c: { d: { e: { f: { token: "top-secret-12" } } } } } },
      list: [{ secret: "top-secret-13" }, [{ apiKey: "top-secret-14" }]],
      llm: { request: { prompt: "PROMPT-TEXT-1", messages: [{ content: "PROMPT-TEXT-2" }] } },
      err: error,
      failure: error,
      model: "gpt",
      at: new Date(0),
    },
    "call",
  );
  const line = lines.join("");
  assert.ok(!/top-secret|PROMPT-TEXT/.test(line), line);
  const entry = JSON.parse(line) as Record<string, unknown>;
  assert.equal(entry.model, "gpt");
  assert.equal(entry.at, "1970-01-01T00:00:00.000Z");
  assert.equal(entry.service, "gateway");
  assert.equal(entry.release, "v1.2.3");
  assert.match(String((entry.err as Record<string, unknown>).message), /request failed/);
  const failure = entry.failure as Record<string, unknown>;
  assert.equal(failure.message, "request failed");
  assert.equal(failure.type, "Error");
  assert.equal((failure.cause as Record<string, unknown>).message, "inner");
  assert.match(String(failure.stack), /request failed/);
});

test("redacts child bindings and survives cycles", () => {
  const { logger, lines } = capture();
  const loop: Record<string, unknown> = { name: "loop" };
  loop.self = loop;
  const shared = { ok: 1 };
  logger
    .child({ authorization: "top-secret-15" })
    .child({ headers: { Cookie: "top-secret-16" } })
    .info({ loop, pair: [shared, shared] }, "x");
  const line = lines.join("");
  assert.ok(!line.includes("top-secret"), line);
  const entry = JSON.parse(line) as { loop: { self: string }; pair: unknown[] };
  assert.equal(entry.loop.self, "[Circular]");
  assert.deepEqual(entry.pair, [{ ok: 1 }, { ok: 1 }]);
});

test("adds request and correlation ids from the context", async () => {
  const { logger, lines } = capture("debug");
  logger.debug("outside");
  await runWithContext({ requestId: "req-1", correlationId: "task-1" }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    logger.debug("inside");
  });
  const [outside, inside] = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(outside?.requestId, undefined);
  assert.equal(inside?.requestId, "req-1");
  assert.equal(inside.correlationId, "task-1");
});

test("uses info as the default level", () => {
  const { logger } = capture();
  assert.equal(logger.level, "info");
});
