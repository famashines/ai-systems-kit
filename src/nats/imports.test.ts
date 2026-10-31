import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const resolved: string[] = [];
registerHooks({
  resolve(specifier, context, nextResolve) {
    resolved.push(specifier);
    if (specifier === "mongodb" || specifier.startsWith("mongodb/")) {
      throw new Error(`mongodb is not available: ${specifier}`);
    }
    return nextResolve(specifier, context);
  },
});

test("the built ./nats export loads with mongodb not available", async () => {
  const nats = await import("@famashines/ai-systems-kit/nats");
  assert.equal(typeof nats.connectNats, "function");
  assert.equal(typeof nats.orderedStream, "function");
  assert.equal(typeof nats.observeGauge, "function");
});

test("the ./nats source loads with mongodb not available", async () => {
  const nats = await import("./index.ts");
  assert.equal(typeof nats.connectNats, "function");
  assert.ok(resolved.includes("@nats-io/transport-node"));
  assert.ok(!resolved.some((specifier) => specifier.startsWith("mongodb")));
});

test("the check finds mongodb in ./messaging", async () => {
  await assert.rejects(import("../messaging/index.ts"), /mongodb is not available/);
});
