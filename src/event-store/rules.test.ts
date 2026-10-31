import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { EventEnvelopeV1 } from "@famashines/ai-systems-contracts";
import { z } from "zod";
import { ConflictError, DomainError } from "../http/errors.ts";
import { checkVersion, ConcurrencyError, upcast, type Upcasters } from "./index.ts";
import { rules } from "./rules.ts";

const id = (n: number): string => `6f1c3c7e-2d0a-4f3b-9a7e-${String(n).padStart(12, "0")}`;

describe("checkVersion", () => {
  const cases: [number, number | undefined, boolean][] = [
    [0, undefined, true],
    [3, undefined, true],
    [0, 0, true],
    [2, 0, false],
    [2, 2, true],
    [2, 1, false],
    [0, 1, false],
  ];
  for (const [last, expected, ok] of cases) {
    test(`last ${String(last)}, expected ${String(expected)}`, () => {
      if (ok) checkVersion(last, expected);
      else {
        assert.throws(() => {
          checkVersion(last, expected);
        }, ConcurrencyError);
      }
    });
  }

  test("ConcurrencyError is a 409 conflict", () => {
    const error = new ConcurrencyError();
    assert.ok(error instanceof ConflictError && error instanceof DomainError);
    assert.equal(error.status, 409);
    assert.equal(error.code, "conflict");
    assert.equal(error.name, "ConcurrencyError");
  });
});

describe("upcast", () => {
  const upcasters: Upcasters = {
    "test.Thing": {
      1: (payload) => ({ ...(payload as object), size: 0 }),
      2: (payload) => {
        const { name, size } = payload as { name: string; size: number };
        return { title: name, size };
      },
    },
  };

  test("runs the chain to the last version", () => {
    assert.deepEqual(
      upcast({ type: "test.Thing", schemaVersion: 1, payload: { name: "a" } }, upcasters),
      { type: "test.Thing", schemaVersion: 3, payload: { title: "a", size: 0 } },
    );
  });

  test("starts at the stored version", () => {
    assert.deepEqual(
      upcast({ type: "test.Thing", schemaVersion: 2, payload: { name: "a", size: 4 } }, upcasters),
      { type: "test.Thing", schemaVersion: 3, payload: { title: "a", size: 4 } },
    );
  });

  test("keeps events with no upcaster", () => {
    const current = { type: "test.Thing", schemaVersion: 3, payload: { title: "a", size: 1 } };
    assert.equal(upcast(current, upcasters), current);
    const other = { type: "test.Other", schemaVersion: 1, payload: {} };
    assert.equal(upcast(other, upcasters), other);
  });

  test("ignores values that are not events and inherited keys", () => {
    assert.equal(upcast(null, upcasters), null);
    assert.equal(upcast("text", upcasters), "text");
    const proto = { type: "toString", schemaVersion: 1, payload: {} };
    assert.equal(upcast(proto, upcasters), proto);
    const noType = { schemaVersion: 1 };
    assert.equal(upcast(noType, upcasters), noType);
    const badVersion = { type: "test.Thing", schemaVersion: "1", payload: {} };
    assert.equal(upcast(badVersion, upcasters), badVersion);
  });
});

describe("rules", () => {
  const draft = {
    type: "orchestration.TaskSubmitted" as const,
    schemaVersion: 1 as const,
    correlationId: id(1),
    causationId: id(2),
    actor: { kind: "owner" as const, id: "owner" },
    payload: { taskId: id(3), text: "Write a plan", mode: "auto" as const },
  };

  test("build gives versions after the last one and checks with contracts", () => {
    let n = 10;
    const { build } = rules({
      now: () => new Date("2026-10-31T10:00:00.000Z"),
      newId: () => id((n += 1)),
    });
    const events = build(`task-${id(3)}`, [draft, draft], 4);
    assert.deepEqual(
      events.map((event) => [event.eventId, event.version, event.occurredAt]),
      [
        [id(11), 5, "2026-10-31T10:00:00.000Z"],
        [id(12), 6, "2026-10-31T10:00:00.000Z"],
      ],
    );
    assert.throws(() => build("not a stream id", [draft], 0), z.ZodError);
  });

  test("decode upcasts, then parses, and strips stored fields", () => {
    const schema = EventEnvelopeV1(z.object({ title: z.string(), size: z.int() })).extend({
      type: z.literal("test.Thing"),
      schemaVersion: z.literal(2),
    });
    const parse = (input: unknown) => schema.parse(input);
    const { decode } = rules({
      parse,
      upcasters: {
        "test.Thing": { 1: (payload) => ({ title: (payload as { name: string }).name, size: 1 }) },
      },
    });
    const stored = {
      _id: id(5),
      eventId: id(5),
      type: "test.Thing",
      schemaVersion: 1,
      streamId: "thing-1",
      version: 1,
      occurredAt: "2026-10-31T10:00:00.000Z",
      correlationId: id(1),
      causationId: id(2),
      actor: { kind: "system", id: "test" },
      payload: { name: "a" },
      publishedAt: null,
    };
    const event = decode(stored);
    assert.equal(event.schemaVersion, 2);
    assert.deepEqual(event.payload, { title: "a", size: 1 });
    assert.equal("publishedAt" in event, false);
    assert.throws(() => decode({ ...stored, schemaVersion: 2 }), z.ZodError);
  });

  test("defaults use contracts parseEvent, Date and randomUUID", () => {
    const { build, decode, now } = rules({});
    const [event] = build(`task-${id(3)}`, [draft], 0);
    assert.ok(event);
    assert.match(event.eventId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(decode(event), event);
    assert.ok(now() instanceof Date);
  });
});
