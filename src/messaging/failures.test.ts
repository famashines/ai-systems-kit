import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { z } from "zod";
import { NotFoundError } from "../http/errors.ts";
import { backoff, consumerBackoffMs, dlqHeaders, onFailure } from "./index.ts";
import { describeError, headerText } from "./failures.ts";

describe("backoff", () => {
  test("doubles from the base up to the maximum", () => {
    assert.deepEqual(
      [0, 1, 2, 3, 4, 5, 6, 10].map((failures) => backoff(failures)),
      [1000, 1000, 2000, 4000, 8000, 16000, 30000, 30000],
    );
    assert.equal(backoff(3, 10, 25), 25);
  });
});

describe("onFailure", () => {
  test("retries with the consumer backoff, then sends to the DLQ on delivery 5", () => {
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6].map((count) => onFailure(count, consumerBackoffMs)),
      [
        { action: "retry", delayMs: 1000 },
        { action: "retry", delayMs: 5000 },
        { action: "retry", delayMs: 30000 },
        { action: "retry", delayMs: 120000 },
        { action: "dlq" },
        { action: "dlq" },
      ],
    );
  });
});

describe("DLQ headers", () => {
  test("a JSON error has fixed text, with no part of the payload", () => {
    let error: unknown;
    try {
      JSON.parse('{"password":"hunter2"');
    } catch (caught) {
      error = caught;
    }
    assert.deepEqual(dlqHeaders(error), {
      "error-class": "SyntaxError",
      "error-message": "The message is not valid JSON",
    });
  });

  test("a zod error has paths and codes only", () => {
    const result = z
      .object({ payload: z.object({ secret: z.literal("x") }), n: z.int() })
      .safeParse({ payload: { secret: "hunter2" }, n: "1" });
    assert.ok(!result.success);
    const headers = dlqHeaders(result.error);
    assert.equal(headers["error-class"], "ZodError");
    assert.equal(
      headers["error-message"],
      "The event is not valid: payload.secret invalid_value, n invalid_type",
    );
    assert.doesNotMatch(JSON.stringify(headers), /hunter2/);
    const root = z.string().safeParse(1);
    assert.ok(!root.success);
    assert.equal(describeError(root.error).message, "The event is not valid: (root) invalid_type");
  });

  test("other errors keep the class and the message, with no control characters", () => {
    assert.deepEqual(dlqHeaders(new NotFoundError("no task\r\nx-evil: 1")), {
      "error-class": "NotFoundError",
      "error-message": "no task x-evil: 1",
    });
    assert.deepEqual(dlqHeaders("text"), {
      "error-class": "Error",
      "error-message": "A value that is not an Error was thrown",
    });
    assert.equal(headerText("é".repeat(10) + "a".repeat(600)).length, 500);
  });
});
