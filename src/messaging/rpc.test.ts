import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { headers, type MsgHdrs, type NatsConnection } from "@nats-io/transport-node";
import { pino } from "pino";
import { z } from "zod";
import { DomainError, NotFoundError, UnavailableError, ValidationError } from "../http/errors.ts";
import { request, serve } from "./index.ts";

interface Reply {
  string: () => string;
  headers: MsgHdrs | undefined;
}
type Callback = (error: Error | null, message: unknown) => void;

function loopback(reply: string | null = "_INBOX_test.1"): NatsConnection {
  const callbacks = new Map<string, Callback>();
  return {
    subscribe: (subject: string, options: { callback: Callback }) => {
      callbacks.set(subject, options.callback);
      return {};
    },
    request: (subject: string, data: string, options: { timeout: number }) =>
      new Promise<Reply>((resolve, reject) => {
        const callback = callbacks.get(subject);
        if (!callback) {
          reject(new Error("503"));
          return;
        }
        setTimeout(() => {
          reject(new Error("timeout"));
        }, options.timeout);
        callback(null, {
          reply: reply ?? undefined,
          string: () => data,
          respond: (reply: string, opts?: { headers: MsgHdrs }) => {
            resolve({ string: () => reply, headers: opts?.headers });
            return true;
          },
        });
      }),
  } as unknown as NatsConnection;
}

const lines: string[] = [];
const logger = pino({ level: "error" }, { write: (line: string) => lines.push(line) });
const allow = { allowReplyPrefixes: ["_INBOX_test."] };
const Reserve = z.object({ amount: z.int().positive() });
const Reserved = z.object({ reservationId: z.string(), amount: z.int() });

async function rejects(work: Promise<unknown>, code: string, status: number): Promise<DomainError> {
  const error = await work.then(
    () => assert.fail("no error"),
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof DomainError);
  assert.equal(error.code, code);
  assert.equal(error.status, status);
  return error;
}

describe("rpc", () => {
  test("checks both ends with zod", async () => {
    const connection = loopback();
    const seen: unknown[] = [];
    serve(
      connection,
      logger,
      "rpc.budget.reserve",
      Reserve,
      Reserved,
      (input) => {
        seen.push(input);
        return { reservationId: "r1", amount: input.amount };
      },
      allow,
    );
    const reply = await request(connection, "rpc.budget.reserve", Reserve, Reserved, { amount: 5 });
    assert.deepEqual(reply, { reservationId: "r1", amount: 5 });
    await assert.rejects(
      request(connection, "rpc.budget.reserve", Reserve, Reserved, { amount: -1 }),
      ValidationError,
    );
    assert.equal(seen.length, 1);
  });

  test("the server drops a request from a reply subject that is not allowed", async () => {
    for (const reply of ["_INBOX_other.1", "_INBOX_test", null]) {
      const connection = loopback(reply);
      let calls = 0;
      serve(
        connection,
        logger,
        "rpc.x",
        z.unknown(),
        Reserved,
        () => {
          calls += 1;
          return { reservationId: "r", amount: 1 };
        },
        allow,
      );
      await assert.rejects(
        request(connection, "rpc.x", Reserve, Reserved, { amount: 1 }, 30),
        UnavailableError,
      );
      assert.equal(calls, 0);
    }
  });

  test("a remote ValidationError keeps its issues", async () => {
    const connection = loopback();
    serve(
      connection,
      logger,
      "rpc.x",
      Reserve,
      Reserved,
      () => ({ reservationId: "r", amount: 1 }),
      allow,
    );
    const error = await request(connection, "rpc.x", z.unknown(), Reserved, {
      amount: "a lot",
    }).catch((caught: unknown) => caught);
    assert.ok(error instanceof ValidationError);
    assert.deepEqual(
      error.issues.map((issue) => [issue.path, issue.code]),
      [["amount", "invalid_type"]],
    );
  });

  test("the server refuses input that is not valid or not JSON", async () => {
    const connection = loopback();
    serve(
      connection,
      logger,
      "rpc.x",
      Reserve,
      Reserved,
      () => ({
        reservationId: "r",
        amount: 1,
      }),
      allow,
    );
    await rejects(
      request(connection, "rpc.x", z.unknown(), Reserved, { amount: "a lot" }),
      "validation_failed",
      400,
    );
    await rejects(
      request(connection, "rpc.x", z.unknown(), Reserved, undefined),
      "validation_failed",
      400,
    );
  });

  test("a DomainError goes to the caller with its code, status and message", async () => {
    const connection = loopback();
    serve(
      connection,
      logger,
      "rpc.x",
      Reserve,
      Reserved,
      () => {
        throw new NotFoundError("No budget\nfor this scope");
      },
      allow,
    );
    const error = await rejects(
      request(connection, "rpc.x", Reserve, Reserved, { amount: 1 }),
      "not_found",
      404,
    );
    assert.equal(error.message, "No budget for this scope");
  });

  test("other errors and bad replies give internal, with no detail", async () => {
    const connection = loopback();
    serve(
      connection,
      logger,
      "rpc.crash",
      Reserve,
      Reserved,
      () => {
        throw new Error("secret detail");
      },
      allow,
    );
    serve(
      connection,
      logger,
      "rpc.bad",
      Reserve,
      Reserved,
      () => ({ reservationId: 1 }) as never,
      allow,
    );
    serve(
      connection,
      logger,
      "rpc.other",
      Reserve,
      z.object({ other: z.int() }),
      () => ({
        other: 1,
      }),
      allow,
    );
    const crash = await rejects(
      request(connection, "rpc.crash", Reserve, Reserved, { amount: 1 }),
      "internal",
      500,
    );
    assert.equal(crash.message, "The rpc handler failed");
    await rejects(
      request(connection, "rpc.bad", Reserve, Reserved, { amount: 1 }),
      "internal",
      500,
    );
    await rejects(
      request(connection, "rpc.other", Reserve, Reserved, { amount: 1 }),
      "internal",
      500,
    );
    assert.ok(lines.some((line) => line.includes("secret detail")));
  });

  test("an unknown error code becomes internal", async () => {
    const connection = loopback();
    connection.subscribe("rpc.odd", {
      callback: (_error, message) => {
        const meta = headers();
        meta.set("error-code", "teapot");
        meta.set("error-status", "x");
        message.respond("", { headers: meta });
      },
    });
    const error = await rejects(
      request(connection, "rpc.odd", Reserve, Reserved, { amount: 1 }),
      "internal",
      500,
    );
    assert.equal(error.message, "The rpc call failed");
  });

  test("no answer gives UnavailableError", async () => {
    const connection = loopback();
    connection.subscribe("rpc.slow", { callback: () => undefined });
    await assert.rejects(
      request(connection, "rpc.none", Reserve, Reserved, { amount: 1 }),
      UnavailableError,
    );
    await assert.rejects(
      request(connection, "rpc.slow", Reserve, Reserved, { amount: 1 }, 20),
      UnavailableError,
    );
  });
});
