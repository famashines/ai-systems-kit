import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { ConfigError, commonEnv, loadConfig } from "./index.ts";

const schema = commonEnv.extend({
  MONGO_URL: z.url(),
  API_KEY: z.string().min(40),
});

test("gives a typed frozen config with defaults", () => {
  const config = loadConfig(schema, {
    SERVICE_NAME: "gateway",
    MONGO_URL: "mongodb://localhost:27017",
    API_KEY: "k".repeat(40),
  });
  assert.equal(config.PORT, 8080);
  assert.equal(config.LOG_LEVEL, "info");
  assert.equal(config.RELEASE, "local");
  assert.ok(Object.isFrozen(config));
  assert.throws(() => {
    (config as { PORT: number }).PORT = 1;
  }, TypeError);
});

test("lists the bad names and never the values", () => {
  const error = (() => {
    try {
      loadConfig(schema, {
        PORT: "secret-port-value",
        LOG_LEVEL: "loud-secret",
        MONGO_URL: "not a url with password hunter2",
        API_KEY: "sk-short-secret",
      });
    } catch (caught) {
      return caught;
    }
    return undefined;
  })();
  assert.ok(error instanceof ConfigError);
  assert.deepEqual(
    error.issues.map((issue) => issue.name),
    ["SERVICE_NAME", "PORT", "LOG_LEVEL", "MONGO_URL", "API_KEY"],
  );
  const text = `${error.message} ${JSON.stringify(error.issues)} ${String(error.stack)}`;
  for (const value of ["secret-port-value", "loud-secret", "hunter2", "sk-short-secret"]) {
    assert.ok(!text.includes(value), value);
  }
  assert.match(error.message, /^The configuration is not valid: SERVICE_NAME: /);
});

test("hides the value when a transform throws", () => {
  const throwing = z.object({
    SERVICE_NAME: z.string(),
    FEATURES: z.string().transform((text) => JSON.parse(text) as unknown),
    WEBHOOK: z.string().transform((text) => new URL(text)),
  });
  for (const [env, name] of [
    [{ SERVICE_NAME: "a", FEATURES: "{secret-json", WEBHOOK: "https://x" }, "FEATURES"],
    [{ SERVICE_NAME: "a", FEATURES: "{}", WEBHOOK: "secret-url-value" }, "WEBHOOK"],
  ] as const) {
    let caught: unknown;
    try {
      loadConfig(throwing, env);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof ConfigError);
    assert.equal(caught.cause, undefined);
    assert.deepEqual(caught.issues, [{ name, message: "The value is not valid" }]);
    const text = `${caught.message} ${String(caught.stack)}`;
    assert.ok(!text.includes("secret"), text);
  }
  assert.throws(
    () =>
      loadConfig(
        z.string().transform(() => {
          throw new Error("secret");
        }),
        {},
      ),
    (error: unknown) => error instanceof ConfigError && error.issues[0]?.name === "(root)",
  );
});

test("freezes nested values", () => {
  const config = loadConfig(
    z.object({ LIST: z.string().transform((text) => ({ items: text.split(",") })) }),
    { LIST: "a,b" },
  );
  assert.ok(Object.isFrozen(config.LIST));
  assert.ok(Object.isFrozen(config.LIST.items));
});

test("names a root issue", () => {
  assert.throws(
    () => loadConfig(z.string(), {}),
    (error: unknown) => error instanceof ConfigError && error.issues[0]?.name === "(root)",
  );
});

test("reads process.env by default", () => {
  process.env.SERVICE_NAME = "from-env";
  assert.equal(loadConfig(commonEnv).SERVICE_NAME, "from-env");
});
