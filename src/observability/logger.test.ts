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

test("redacts secrets and prompt text at any usual depth", () => {
  const { logger, lines } = capture();
  logger.info(
    {
      authorization: "Bearer top-secret-1",
      password: "top-secret-2",
      req: { headers: { cookie: "top-secret-3", "set-cookie": "top-secret-4" } },
      auth: { accessToken: "top-secret-5", refreshToken: "top-secret-6", token: "top-secret-7" },
      provider: { apiKey: "top-secret-8", secret: "top-secret-9" },
      llm: {
        request: { prompt: "PROMPT-TEXT-1", body: { messages: [{ content: "PROMPT-TEXT-2" }] } },
      },
      messages: [{ role: "user", content: "PROMPT-TEXT-3" }],
      model: "gpt",
    },
    "call",
  );
  const line = lines.join("");
  assert.ok(!/top-secret|PROMPT-TEXT/.test(line), line);
  const entry = JSON.parse(line) as Record<string, unknown>;
  assert.equal(entry.model, "gpt");
  assert.equal(entry.password, "[Redacted]");
  assert.equal(entry.service, "gateway");
  assert.equal(entry.release, "v1.2.3");
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
