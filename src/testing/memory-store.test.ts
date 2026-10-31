import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ConcurrencyError } from "../event-store/index.ts";
import { createMemoryEventStore, fakeClock, fakeIds, waitFor } from "./index.ts";

const ids = fakeIds(1);
const taskId = ids();
const streamId = `task-${taskId}`;
const draft = (text: string) => ({
  type: "orchestration.TaskSubmitted" as const,
  schemaVersion: 1 as const,
  correlationId: taskId,
  causationId: taskId,
  actor: { kind: "owner" as const, id: "owner" },
  payload: { taskId, text, mode: "auto" as const },
});

const newStore = () => {
  const clock = fakeClock();
  return { clock, store: createMemoryEventStore({ now: clock.now, newId: fakeIds(2) }) };
};

describe("in-memory event store", () => {
  test("append gives versions, positions, ids and times", async () => {
    const { store, clock } = newStore();
    const first = await store.append({
      streamId,
      expectedVersion: 0,
      events: [draft("a"), draft("b")],
    });
    clock.advance(1000);
    const second = await store.append({ streamId: "task-other", events: [draft("c")] });
    assert.deepEqual(
      [...first.events, ...second.events].map((event) => [
        event.version,
        event.position,
        event.eventId,
        event.occurredAt,
      ]),
      [
        [1, 1, "00000002-0000-4000-8000-000000000001", "2026-01-01T00:00:00.000Z"],
        [2, 2, "00000002-0000-4000-8000-000000000002", "2026-01-01T00:00:00.000Z"],
        [1, 3, "00000002-0000-4000-8000-000000000003", "2026-01-01T00:00:01.000Z"],
      ],
    );
    assert.equal(first.replayed, false);
    assert.equal(first.answer, undefined);
  });

  test("expectedVersion: absent, 0 and n", async () => {
    const { store } = newStore();
    await store.append({ streamId, expectedVersion: 0, events: [draft("a")] });
    await assert.rejects(
      store.append({ streamId, expectedVersion: 0, events: [draft("b")] }),
      ConcurrencyError,
    );
    await assert.rejects(
      store.append({ streamId, expectedVersion: 2, events: [draft("b")] }),
      ConcurrencyError,
    );
    await store.append({ streamId, expectedVersion: 1, events: [draft("b")] });
    await store.append({ streamId, events: [draft("c")] });
    assert.deepEqual(
      (await store.readStream(streamId)).map((event) => event.version),
      [1, 2, 3],
    );
  });

  test("two appends at the same version: one wins", async () => {
    const { store } = newStore();
    const results = await Promise.allSettled([
      store.append({ streamId, expectedVersion: 0, events: [draft("a")] }),
      store.append({ streamId, expectedVersion: 0, events: [draft("b")] }),
    ]);
    assert.deepEqual(
      results.map((result) => result.status),
      ["fulfilled", "rejected"],
    );
    const [, lost] = results;
    assert.ok(lost.status === "rejected" && lost.reason instanceof ConcurrencyError);
    assert.equal((await store.readAll()).length, 1);
  });

  test("the same commandId gives the first answer and writes nothing", async () => {
    const { store } = newStore();
    const command = { commandId: ids(), answer: { taskId } };
    const first = await store.append({
      streamId,
      expectedVersion: 0,
      events: [draft("a")],
      command,
    });
    const again = await store.append({
      streamId,
      expectedVersion: 0,
      events: [draft("b")],
      command: { commandId: command.commandId, answer: { taskId: "other" } },
    });
    assert.deepEqual(first.answer, { taskId });
    assert.deepEqual(again, { events: [], answer: { taskId }, replayed: true });
    assert.equal((await store.readAll()).length, 1);
  });

  test("a failing also or a bad event writes nothing", async () => {
    const { store } = newStore();
    let calls = 0;
    await assert.rejects(
      store.append({
        streamId,
        events: [draft("a")],
        command: { commandId: ids(), answer: 1 },
        also: () => {
          calls += 1;
          return Promise.reject(new Error("no"));
        },
      }),
      /no/,
    );
    await assert.rejects(store.append({ streamId, events: [draft("")] }));
    await store.append({ streamId, events: [draft("b")], also: () => Promise.resolve() });
    assert.equal(calls, 1);
    assert.deepEqual(
      (await store.readAll()).map((event) => [event.version, event.position]),
      [[1, 1]],
    );
  });

  test("readStream from a version and readAll by position", async () => {
    const { store } = newStore();
    await store.append({ streamId, events: [draft("a"), draft("b"), draft("c")] });
    await store.append({ streamId: "task-other", events: [draft("d")] });
    assert.deepEqual(
      (await store.readStream(streamId, { fromVersion: 2 })).map((event) => event.payload.text),
      ["b", "c"],
    );
    assert.deepEqual(
      (await store.readAll({ afterPosition: 1, limit: 2 })).map((event) => event.position),
      [2, 3],
    );
    assert.deepEqual(await store.readAll({ afterPosition: 4 }), []);
  });

  test("read results are copies", async () => {
    const { store } = newStore();
    const { events } = await store.append({ streamId, events: [draft("a")] });
    if (events[0]) events[0].payload.text = "changed";
    const [read] = await store.readStream(streamId);
    assert.equal(read?.payload.text, "a");
  });
});

describe("fakes", () => {
  test("fakeIds gives lower-case UUID v4 values in order", () => {
    const next = fakeIds(255);
    assert.deepEqual(
      [next(), next()],
      ["000000ff-0000-4000-8000-000000000001", "000000ff-0000-4000-8000-000000000002"],
    );
    assert.match(
      fakeIds()(),
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test("fakeClock moves only when told", () => {
    const clock = fakeClock(new Date("2026-10-31T00:00:00.000Z"));
    clock.advance(1500);
    assert.equal(clock.now().toISOString(), "2026-10-31T00:00:01.500Z");
    clock.set(new Date("2027-01-01T00:00:00.000Z"));
    assert.equal(clock.now().toISOString(), "2027-01-01T00:00:00.000Z");
  });
});

describe("waitFor", () => {
  test("ends when the check is true, and fails after the timeout", async () => {
    let calls = 0;
    await waitFor(() => (calls += 1) >= 3, 1000, 1);
    assert.equal(calls, 3);
    await assert.rejects(
      waitFor(() => Promise.resolve(false), 20, 5),
      /after 20 ms/,
    );
  });
});
