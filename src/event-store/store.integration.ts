import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { EventEnvelopeV1 } from "@famashines/ai-systems-contracts";
import type { Db, MongoClient } from "mongodb";
import { z } from "zod";
import { connectMongo, runMigrations, type Migration } from "../mongo/index.ts";
import { fakeIds, startMongo, type Started } from "../testing/index.ts";
import { ConcurrencyError, createEventStore, eventStoreMigration } from "./index.ts";

let mongo: Started;
let client: MongoClient;
let db: Db;

before(async () => {
  mongo = await startMongo();
  ({ client, db } = await connectMongo({ url: mongo.url, database: "store" }));
  await runMigrations(db, [eventStoreMigration]);
});

after(async () => {
  await client.close();
  await mongo.stop();
});

const ids = fakeIds(7);
const draft = (taskId: string, text = "Write a plan") => ({
  type: "orchestration.TaskSubmitted" as const,
  schemaVersion: 1 as const,
  correlationId: taskId,
  causationId: taskId,
  actor: { kind: "owner" as const, id: "owner" },
  payload: { taskId, text, mode: "auto" as const },
});

describe("migrations", () => {
  test("run once, in name order, and refuse bad lists", async () => {
    const calls: string[] = [];
    const step = (name: string): Migration => ({
      name,
      up: () => {
        calls.push(name);
        return Promise.resolve();
      },
    });
    const own = db.client.db("migrations-test");
    assert.deepEqual(await runMigrations(own, [step("002-b"), step("001-a")]), ["001-a", "002-b"]);
    assert.deepEqual(await runMigrations(own, [step("001-a"), step("002-b")]), []);
    assert.deepEqual(await runMigrations(own, [step("001-a"), step("002-b"), step("003-c")]), [
      "003-c",
    ]);
    assert.deepEqual(calls, ["001-a", "002-b", "003-c"]);
    assert.equal(await own.collection("migrations").countDocuments(), 3);
    await assert.rejects(runMigrations(own, [step("4-d")]), /not NNN-name/);
    await assert.rejects(runMigrations(own, [step("004-d"), step("004-d")]), /not unique/);
    assert.deepEqual(await runMigrations(db, [eventStoreMigration]), []);
  });
});

describe("event store on MongoDB", () => {
  test("concurrent appends at the same version: one wins, the others get ConcurrencyError", async () => {
    const events = createEventStore(db);
    const taskId = ids();
    const streamId = `task-${taskId}`;
    await events.append({ streamId, expectedVersion: 0, events: [draft(taskId)] });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        events.append({ streamId, expectedVersion: 1, events: [draft(taskId)] }),
      ),
    );
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    for (const result of results) {
      if (result.status === "rejected") assert.ok(result.reason instanceof ConcurrencyError);
    }
    assert.deepEqual(
      (await events.readStream(streamId)).map((event) => event.version),
      [1, 2],
    );
  });

  test("concurrent appends with no expected version get versions and positions with no gaps", async () => {
    const events = createEventStore(db);
    const taskId = ids();
    const streamId = `task-${taskId}`;
    await Promise.all(
      Array.from({ length: 8 }, () => events.append({ streamId, events: [draft(taskId)] })),
    );
    const stored = await events.readStream(streamId);
    assert.deepEqual(
      stored.map((event) => event.version),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    const positions = stored.map((event) => event.position);
    assert.deepEqual(
      positions,
      positions.toSorted((a, b) => a - b),
    );
    assert.equal(new Set(positions).size, 8);
  });

  test("the same commandId twice gives one event and the same answer", async () => {
    const events = createEventStore(db);
    const taskId = ids();
    const streamId = `task-${taskId}`;
    const commandId = ids();
    const first = await events.append({
      streamId,
      expectedVersion: 0,
      events: [draft(taskId)],
      command: { commandId, answer: { taskId } },
    });
    const again = await events.append({
      streamId,
      expectedVersion: 0,
      events: [draft(taskId)],
      command: { commandId, answer: { taskId: "other" } },
    });
    assert.equal(first.replayed, false);
    assert.deepEqual(again, { events: [], answer: { taskId }, replayed: true });

    const raceId = ids();
    const raceTask = ids();
    const race = await Promise.all(
      Array.from({ length: 4 }, () =>
        events.append({
          streamId: `task-${raceTask}`,
          expectedVersion: 0,
          events: [draft(raceTask)],
          command: { commandId: raceId, answer: { taskId: raceTask } },
        }),
      ),
    );
    assert.deepEqual(new Set(race.map((result) => JSON.stringify(result.answer))).size, 1);
    assert.equal(race.filter((result) => !result.replayed).length, 1);
    assert.equal((await events.readStream(streamId)).length, 1);
    assert.equal((await events.readStream(`task-${raceTask}`)).length, 1);
    const stored = await db.collection("commands").findOne({ _id: commandId as never });
    assert.ok(stored?.createdAt instanceof Date);
  });

  test("also writes in the same transaction, and a failure writes nothing", async () => {
    const events = createEventStore(db);
    const taskId = ids();
    const streamId = `task-${taskId}`;
    const state = db.collection<{ _id: string; text: string }>("tasks");
    await assert.rejects(
      events.append({
        streamId,
        events: [draft(taskId)],
        command: { commandId: ids(), answer: 1 },
        also: async (session) => {
          await state.insertOne({ _id: taskId, text: "x" }, { session });
          throw new Error("refused");
        },
      }),
      /refused/,
    );
    assert.equal(await state.countDocuments({ _id: taskId }), 0);
    assert.equal((await events.readStream(streamId)).length, 0);
    await events.append({
      streamId,
      events: [draft(taskId)],
      also: async (session) => {
        await state.insertOne({ _id: taskId, text: "x" }, { session });
      },
    });
    assert.equal(await state.countDocuments({ _id: taskId }), 1);
    await assert.rejects(events.append({ streamId, events: [draft(taskId, "")] }), z.ZodError);
  });

  test("replay: readAll by position gives every event once, in order", async () => {
    const replayDb = db.client.db("replay");
    await runMigrations(replayDb, [eventStoreMigration]);
    const events = createEventStore(replayDb);
    const streams = [ids(), ids(), ids()];
    for (let round = 0; round < 4; round += 1) {
      await Promise.all(
        streams.map((taskId) =>
          events.append({ streamId: `task-${taskId}`, events: [draft(taskId)] }),
        ),
      );
    }
    const seen: { eventId: string; position: number }[] = [];
    for (let after = 0; ;) {
      const page = await events.readAll({ afterPosition: after, limit: 5 });
      if (page.length === 0) break;
      seen.push(...page);
      after = page.at(-1)?.position ?? after;
    }
    assert.equal(seen.length, 12);
    assert.equal(new Set(seen.map((event) => event.eventId)).size, 12);
    assert.deepEqual(
      seen.map((event) => event.position),
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
  });

  test("upcasters run on read, and stored events do not change", async () => {
    const upDb = db.client.db("upcast");
    await runMigrations(upDb, [eventStoreMigration]);
    const v1 = createEventStore(upDb, {
      parse: (input) => EventEnvelopeV1(z.object({ name: z.string() })).parse(input),
    });
    const v2 = createEventStore(upDb, {
      parse: (input) =>
        EventEnvelopeV1(z.object({ title: z.string() }))
          .extend({ schemaVersion: z.literal(2) })
          .parse(input),
      upcasters: {
        "test.Thing": { 1: (payload) => ({ title: (payload as { name: string }).name }) },
      },
    });
    const id = ids();
    await v1.append({
      streamId: "thing-1",
      events: [
        {
          type: "test.Thing",
          schemaVersion: 1,
          correlationId: id,
          causationId: id,
          actor: { kind: "system", id: "test" },
          payload: { name: "a" },
        },
      ],
    });
    const read = await v2.readStream("thing-1");
    assert.deepEqual(
      read.map((event) => [event.schemaVersion, event.payload]),
      [[2, { title: "a" }]],
    );
    const raw = await upDb.collection("events").findOne({ streamId: "thing-1" });
    assert.deepEqual([raw?.schemaVersion, raw?.payload], [1, { name: "a" }]);
  });
});
