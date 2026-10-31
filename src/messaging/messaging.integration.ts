import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, test } from "node:test";
import { EventEnvelopeV1, TaskSubmittedEventPayloadV1 } from "@famashines/ai-systems-contracts";
import {
  jetstream,
  jetstreamManager,
  type JetStreamManager,
  type StoredMsg,
} from "@nats-io/jetstream";
import { headers } from "@nats-io/transport-node";
import { MongoNetworkError, type ClientSession, type Db, type MongoClient } from "mongodb";
import { pino } from "pino";
import { z } from "zod";
import { createEventStore, eventStoreMigration } from "../event-store/index.ts";
import { DomainError } from "../http/errors.ts";
import type { CloseHook } from "../http/server.ts";
import { connectMongo, runMigrations } from "../mongo/index.ts";
import { startTelemetry, type Telemetry } from "../observability/index.ts";
import { createStreams, startMongo, startNats, waitFor, type Started } from "../testing/index.ts";
import { connectNats, processedMigration, startConsumer, startRelay, type Nats } from "./index.ts";

const consumerGrants = (stream: string, filter: string): string[] => [
  `"$JS.API.STREAM.INFO.${stream}"`,
  `"$JS.API.CONSUMER.CREATE.${stream}.worker.${filter}"`,
  `"$JS.API.CONSUMER.INFO.${stream}.worker"`,
  `"$JS.API.CONSUMER.MSG.NEXT.${stream}.worker"`,
  `"$JS.ACK.${stream}.worker.>"`,
];

const config = `
jetstream { store_dir: /data }
accounts {
  AISYSTEMS {
    jetstream { max_file: 1073741824, max_memory: 0 }
    users = [
      {
        user: admin, password: admin
        permissions {
          publish { allow: ["$JS.API.>", "$JS.ACK.>", "orchestration.>", "llm.>", "dlq.>"] }
          subscribe { allow: ["_INBOX_admin.>"] }
        }
      }
      {
        user: worker, password: worker
        permissions {
          publish {
            allow: [
              "orchestration.>", "dlq.worker.>", "rpc.test.echo", "$JS.API.INFO",
              ${consumerGrants("ORCHESTRATION", "orchestration.TaskSubmitted").join(", ")},
              ${consumerGrants("LLM", "llm.>").join(", ")},
              "$JS.API.STREAM.INFO.LATE"
            ]
          }
          subscribe { allow: ["_INBOX_worker.>"] }
        }
      }
      {
        user: intruder, password: intruder
        permissions {
          publish { allow: ["rpc.test.echo"] }
          subscribe { allow: ["_INBOX_intruder.>"] }
        }
      }
      {
        user: echo, password: echo
        permissions {
          publish { allow: ["$JS.API.INFO"] }
          subscribe { allow: ["_INBOX_echo.>", "rpc.test.echo"] }
          allow_responses: true
        }
      }
    ]
  }
}
`;

const logger = pino({ level: "silent" });
let mongo: Started;
let nats: Started;
let client: MongoClient;
let db: Db;
let admin: Nats;
let worker: Nats;
let manager: JetStreamManager;
let telemetry: Telemetry;
let scrape: HttpServer;
let metricsUrl: string;

const metric = async (name: string): Promise<number> => {
  const text = await (await fetch(metricsUrl)).text();
  const pattern = new RegExp(`^${name}(?:\\{[^}]*\\})? (\\S+)$`, "gm");
  return Math.max(0, ...[...text.matchAll(pattern)].map((match) => Number(match[1])));
};

before(async () => {
  telemetry = startTelemetry({ serviceName: "worker", release: "test" });
  scrape = createHttpServer(telemetry.metricsHandler);
  await new Promise<void>((resolve) => scrape.listen(0, "127.0.0.1", resolve));
  metricsUrl = `http://127.0.0.1:${String((scrape.address() as AddressInfo).port)}/metrics`;
  [mongo, nats] = await Promise.all([startMongo(), startNats({ config })]);
  ({ client, db } = await connectMongo({ url: mongo.url, database: "messaging" }));
  await runMigrations(db, [eventStoreMigration, processedMigration]);
  const connect = (service: string) =>
    connectNats({ servers: nats.url, user: service, pass: service, service, logger });
  [admin, worker] = await Promise.all([connect("admin"), connect("worker")]);
  manager = await jetstreamManager(admin.connection);
  await createStreams(admin.connection, [
    { name: "ORCHESTRATION", subjects: ["orchestration.>"] },
    { name: "LLM", subjects: ["llm.>"] },
    { name: "DLQ", subjects: ["dlq.>"] },
  ]);
});

const running: { close: CloseHook }[] = [];
const track = <T extends { close: CloseHook }>(item: T): T => {
  running.push(item);
  return item;
};

after(async () => {
  await Promise.all(running.map(async (item) => item.close()));
  await Promise.all([admin.close(), worker.close(), client.close()]);
  await Promise.all([mongo.stop(), nats.stop()]);
  await new Promise((resolve) => scrape.close(resolve));
  await telemetry.shutdown();
});

const envelope = (overrides: Partial<EventEnvelopeV1> = {}): EventEnvelopeV1 => {
  const taskId = randomUUID();
  return {
    eventId: randomUUID(),
    type: "orchestration.TaskSubmitted",
    schemaVersion: 1,
    streamId: `task-${taskId}`,
    version: 1,
    occurredAt: new Date().toISOString(),
    correlationId: taskId,
    causationId: taskId,
    actor: { kind: "owner", id: "owner" },
    payload: { taskId, text: "Write a plan", mode: "auto" },
    ...overrides,
  };
};

const publish = async (
  subject: string,
  data: string,
  meta?: Record<string, string>,
): Promise<void> => {
  const options = meta ? { headers: headers() } : {};
  for (const [name, value] of Object.entries(meta ?? {})) options.headers?.set(name, value);
  await jetstream(admin.connection).publish(subject, data, options);
};

const processed = () => db.collection<{ _id: string }>("processed");

const deliveries = async (): Promise<number> =>
  (await manager.consumers.info("ORCHESTRATION", "worker")).delivered.consumer_seq;

const drained = async (stream = "ORCHESTRATION"): Promise<boolean> => {
  const info = await manager.consumers.info(stream, "worker");
  return info.num_pending === 0 && info.num_ack_pending === 0;
};

const subjectMessages = async (stream: string, subject: string) => {
  const { state } = await manager.streams.info(stream);
  const found: StoredMsg[] = [];
  for (let seq = state.first_seq; seq <= state.last_seq && state.messages > 0; seq += 1) {
    const message = await manager.streams.getMessage(stream, { seq }).catch(() => null);
    if (message?.subject === subject) found.push(message);
  }
  return found;
};

async function tcpGate(host: string, port: number) {
  const sockets = new Set<Socket>();
  let server: Server | undefined;
  const listen = (on: number) =>
    new Promise<number>((resolve) => {
      server = createServer((client) => {
        const upstream = connect(port, host);
        for (const socket of [client, upstream]) {
          sockets.add(socket);
          socket.on("error", () => undefined);
          socket.on("close", () => {
            sockets.delete(socket);
            client.destroy();
            upstream.destroy();
          });
        }
        client.pipe(upstream).pipe(client);
      });
      server.listen(on, "127.0.0.1", () => {
        resolve((server?.address() as AddressInfo).port);
      });
    });
  const gatePort = await listen(0);
  const cut = async () => {
    const closing = new Promise((resolve) => server?.close(resolve));
    for (const socket of sockets) socket.destroy();
    await closing;
  };
  return {
    port: gatePort,
    cut,
    open: () => listen(gatePort),
    close: cut,
  };
}

const permissive = (input: unknown) => EventEnvelopeV1(z.unknown()).parse(input);
const fast = [100, 100, 100, 100];

describe("outbox relay", () => {
  test("readiness is false until the streams exist", async () => {
    const relay = track(
      startRelay({
        store: createEventStore(db),
        nats: worker,
        streams: ["ORCHESTRATION", "LATE"],
      }),
    );
    assert.equal(await relay.ready(), false);
    await createStreams(admin.connection, [{ name: "LATE", subjects: ["late.>"] }]);
    await waitFor(() => relay.ready());
    await relay.close();
    await assert.rejects(manager.streams.info("NOT_THERE"));
  });

  test("publishes in position order, once, also after a crash between the PubAck and publishedAt", async () => {
    const relayDb = client.db("relay");
    await runMigrations(relayDb, [eventStoreMigration]);
    const store = createEventStore(relayDb, { parse: permissive });
    const taskId = randomUUID();
    const draft = {
      type: "orchestration.RelayChecked",
      schemaVersion: 1,
      correlationId: taskId,
      causationId: taskId,
      actor: { kind: "system" as const, id: "test" },
      payload: {},
    };
    for (let round = 0; round < 3; round += 1) {
      await store.append({ streamId: `task-${taskId}`, events: [draft, draft] });
    }
    const before = await relayDb
      .collection<{ _id: string; publishedAt: Date | null }>("events")
      .find()
      .sort({ position: 1 })
      .toArray();
    let crashes = 0;
    const relay = track(
      startRelay({
        store: {
          ...store,
          markPublished: async (eventId) => {
            if (crashes === 0 && eventId === before[2]?._id) {
              crashes += 1;
              throw new Error("crash after the PubAck");
            }
            await store.markPublished(eventId);
          },
        },
        nats: worker,
        streams: ["ORCHESTRATION"],
        pollMs: 60_000,
      }),
    );
    await waitFor(async () => (await store.pending(10)).length === 0);
    await store.append({ streamId: `task-${taskId}`, events: [draft] });
    await waitFor(async () => (await store.pending(10)).length === 0, 5000);
    await relay.close();
    assert.equal(crashes, 1);

    const after = await relayDb
      .collection<{ _id: string; publishedAt: Date | null }>("events")
      .find()
      .sort({ position: 1 })
      .toArray();
    const messages = await subjectMessages("ORCHESTRATION", "orchestration.RelayChecked");
    assert.deepEqual(
      messages.map((message) => message.json<EventEnvelopeV1>().eventId),
      after.map((doc) => doc._id),
    );
    const first = messages[0];
    assert.ok(first);
    assert.equal(first.header.get("Nats-Msg-Id"), after[0]?._id);
    assert.equal(first.header.get("correlation-id"), taskId);
    assert.equal(first.header.get("causation-id"), taskId);
    for (const [index, doc] of before.entries()) {
      const { publishedAt, ...rest } = after[index] ?? { publishedAt: null };
      const { publishedAt: unpublished, ...original } = doc;
      assert.equal(unpublished, null);
      assert.ok(publishedAt instanceof Date);
      assert.deepEqual(rest, original);
    }
    const stamp = after[0]?.publishedAt as Date;
    await store.markPublished(String(after[0]?._id));
    await store.readStream(`task-${taskId}`);
    await store.readAll();
    const again = await relayDb
      .collection<{ _id: string; publishedAt: Date | null }>("events")
      .find()
      .sort({ position: 1 })
      .toArray();
    assert.deepEqual(again, after);
    assert.deepEqual(again[0]?.publishedAt, stamp);
  });
});

describe("stuck outbox", () => {
  test("the relay logs errors, counts failures and shows the age of the oldest event", async () => {
    const lines: string[] = [];
    const watched = await connectNats({
      servers: nats.url,
      user: "worker",
      pass: "worker",
      service: "worker",
      logger: pino({ level: "error" }, { write: (line: string) => lines.push(line) }),
    });
    const stuckDb = client.db("stuck");
    await runMigrations(stuckDb, [eventStoreMigration]);
    const store = createEventStore(stuckDb, { parse: permissive });
    const id = randomUUID();
    await store.append({
      streamId: `stuck-${id}`,
      events: [
        {
          type: "stuck.Event",
          schemaVersion: 1,
          correlationId: id,
          causationId: id,
          actor: { kind: "system", id: "test" },
          payload: {},
        },
      ],
    });
    const relay = startRelay({ store, nats: watched, streams: ["ORCHESTRATION"] });
    await waitFor(async () => (await metric("outbox_publish_failures_total")) >= 1);
    await waitFor(async () => (await metric("outbox_oldest_pending_seconds")) > 0);
    assert.equal(await relay.ready(), true);
    await relay.close();
    await watched.close();
    const failed = lines.map(
      (line) => JSON.parse(line) as { msg: string; error?: { errorClass: string } },
    );
    assert.ok(
      failed.some(
        (line) => line.msg === "the outbox relay failed; it tries again" && line.error?.errorClass,
      ),
    );
    assert.equal((await store.pending(10)).length, 1);
  });
});

describe("durable consumer", () => {
  const effects = () => db.collection<{ _id: string }>("effects");
  const consume = async (
    handler: Parameters<typeof startConsumer>[0]["handler"],
    backoffMs = fast,
  ) => {
    const consumer = track(
      startConsumer({
        nats: worker,
        db,
        stream: "ORCHESTRATION",
        filter: "orchestration.TaskSubmitted",
        handler,
        backoffMs,
      }),
    );
    await waitFor(() => consumer.ready());
    return consumer;
  };

  test("a handler that throws twice then works has its effect once; a later copy has no effect", async () => {
    const event = envelope();
    const calls: number[] = [];
    const store = createEventStore(db);
    const effect = (eventId: string) => store.readStream(`effect-${eventId}`);
    const consumer = await consume(async (received, { markProcessed }) => {
      calls.push(calls.length + 1);
      if (calls.length < 3) throw new Error("not yet");
      await store.append({
        streamId: `effect-${received.eventId}`,
        expectedVersion: 0,
        events: [
          {
            type: "orchestration.TaskSubmitted",
            schemaVersion: 1,
            correlationId: received.correlationId,
            causationId: received.eventId,
            actor: { kind: "system", id: "worker" },
            payload: TaskSubmittedEventPayloadV1.parse(received.payload),
          },
        ],
        also: markProcessed,
      });
    });
    await publish(event.type, JSON.stringify(event));
    await waitFor(async () => (await effect(event.eventId)).length === 1);
    await publish(event.type, JSON.stringify(event));
    const marker = envelope();
    await publish(marker.type, JSON.stringify(marker));
    await waitFor(() => calls.length === 4);
    await waitFor(drained);
    const start = performance.now();
    await consumer.close();
    assert.ok(performance.now() - start < 1000, "the close of an idle consumer is fast");
    assert.equal((await effect(event.eventId)).length, 1);
    assert.equal((await effect(marker.eventId)).length, 1);
    assert.ok(await processed().findOne({ _id: event.eventId }));
    assert.equal(calls.length, 4);
  });

  test("a duplicate key on the processed marker from another pod is acked with no retry", async () => {
    const event = envelope();
    let calls = 0;
    const consumer = await consume(async (received, { session, markProcessed }) => {
      calls += 1;
      await processed().insertOne({ _id: received.eventId });
      await session.withTransaction(async () => {
        await effects().insertOne({ _id: received.eventId }, { session });
        await markProcessed(session);
      });
    });
    const before = await deliveries();
    await publish(event.type, JSON.stringify(event));
    await waitFor(() => calls === 1);
    await waitFor(drained);
    await consumer.close();
    assert.equal((await deliveries()) - before, 1);
    assert.equal(calls, 1);
    assert.equal(await effects().countDocuments({ _id: event.eventId }), 0);
  });

  test("a handler that always throws: the message is in the DLQ after 5 deliveries, and the consumer goes on", async () => {
    const failing = envelope();
    const next = envelope();
    const counts = new Map<string, number>();
    const consumer = await consume(async (received, { session, markProcessed }) => {
      counts.set(received.eventId, (counts.get(received.eventId) ?? 0) + 1);
      if (received.eventId === failing.eventId)
        throw new DomainError("internal", 500, "always fails\nhere");
      await session.withTransaction(() => markProcessed(session));
    });
    await publish(failing.type, JSON.stringify(failing), {
      "correlation-id": failing.correlationId,
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    });
    await publish(next.type, JSON.stringify(next));
    const dlqSubject = "dlq.worker.orchestration.TaskSubmitted";
    await waitFor(async () =>
      (await subjectMessages("DLQ", dlqSubject)).some(
        (message) => message.json<EventEnvelopeV1>().eventId === failing.eventId,
      ),
    );
    await waitFor(async () => (await processed().countDocuments({ _id: next.eventId })) === 1);
    await consumer.close();
    assert.equal(counts.get(failing.eventId), 5);
    assert.equal(counts.get(next.eventId), 1);
    const dead = (await subjectMessages("DLQ", dlqSubject)).find(
      (message) => message.json<EventEnvelopeV1>().eventId === failing.eventId,
    );
    assert.ok(dead);
    assert.equal(dead.header.get("error-class"), "DomainError");
    assert.equal(dead.header.get("error-message"), "always fails here");
    assert.equal(dead.header.get("correlation-id"), failing.correlationId);
    assert.equal(
      dead.header.get("traceparent"),
      "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    );
    assert.equal(dead.header.get("Nats-Msg-Id"), "");
  });

  test("MongoDB down for longer than all backoffs: nothing is lost, and the effect happens once", async () => {
    const target = new URL(mongo.url);
    const gate = await tcpGate(target.hostname, Number(target.port));
    const proxied = await connectMongo({
      url: `mongodb://127.0.0.1:${String(gate.port)}/?directConnection=true`,
      database: "messaging",
      clientOptions: { serverSelectionTimeoutMS: 500 },
    });
    track({ close: () => proxied.close() });
    const event = envelope();
    let calls = 0;
    const consumer = track(
      startConsumer({
        nats: worker,
        db: proxied.db,
        stream: "ORCHESTRATION",
        filter: "orchestration.TaskSubmitted",
        backoffMs: fast,
        handler: async (received, { session, markProcessed }) => {
          calls += 1;
          await session.withTransaction(async () => {
            await proxied.db
              .collection<{ _id: string }>("effects")
              .insertOne({ _id: received.eventId }, { session });
            await markProcessed(session);
          });
        },
      }),
    );
    await waitFor(() => consumer.ready());
    const before = await deliveries();
    await gate.cut();
    await publish(event.type, JSON.stringify(event));
    await waitFor(async () => (await deliveries()) - before === 1);
    await sleep(3000);
    assert.equal((await deliveries()) - before, 1);
    assert.equal(calls, 0);
    await gate.open();
    await waitFor(async () => (await effects().countDocuments({ _id: event.eventId })) === 1);
    await waitFor(drained);
    await consumer.close();
    await gate.close();
    assert.equal(calls, 1);
    assert.equal((await deliveries()) - before, 1);
    const dead = await subjectMessages("DLQ", "dlq.worker.orchestration.TaskSubmitted");
    assert.equal(
      dead.some((message) => message.json<EventEnvelopeV1>().eventId === event.eventId),
      false,
    );
  });

  test("a handler that throws a MongoNetworkError by its own bug: DLQ after 5 tries, later messages go on", async () => {
    const bad = envelope();
    const later = [envelope(), envelope(), envelope()];
    let badCalls = 0;
    const consumer = await consume(async (received, { session, markProcessed }) => {
      if (received.eventId === bad.eventId) {
        badCalls += 1;
        throw new MongoNetworkError("a bug that looks like a network error");
      }
      await session.withTransaction(() => markProcessed(session));
    });
    await publish(bad.type, JSON.stringify(bad));
    for (const event of later) await publish(event.type, JSON.stringify(event));
    await waitFor(
      async () =>
        (await processed().countDocuments({
          _id: { $in: later.map((event) => event.eventId) },
        })) === 3,
    );
    await waitFor(async () =>
      (await subjectMessages("DLQ", "dlq.worker.orchestration.TaskSubmitted")).some(
        (message) => message.json<EventEnvelopeV1>().eventId === bad.eventId,
      ),
    );
    await waitFor(drained);
    await consumer.close();
    assert.equal(badCalls, 5);
  });

  test("MongoDB cut while the handler runs: the handler runs again later, with no new delivery", async () => {
    const target = new URL(mongo.url);
    const gate = await tcpGate(target.hostname, Number(target.port));
    const proxied = await connectMongo({
      url: `mongodb://127.0.0.1:${String(gate.port)}/?directConnection=true`,
      database: "messaging",
      clientOptions: { serverSelectionTimeoutMS: 500 },
    });
    track({ close: () => proxied.close() });
    const event = envelope();
    let calls = 0;
    const consumer = track(
      startConsumer({
        nats: worker,
        db: proxied.db,
        stream: "ORCHESTRATION",
        filter: "orchestration.TaskSubmitted",
        backoffMs: fast,
        handler: async (received, { session, markProcessed }) => {
          calls += 1;
          if (calls === 1) await gate.cut();
          await session.withTransaction(async () => {
            await proxied.db
              .collection<{ _id: string }>("effects")
              .insertOne({ _id: received.eventId }, { session });
            await markProcessed(session);
          });
        },
      }),
    );
    await waitFor(() => consumer.ready());
    const before = await deliveries();
    await publish(event.type, JSON.stringify(event));
    await waitFor(() => calls === 1);
    await sleep(3000);
    assert.equal(calls, 1);
    await gate.open();
    await waitFor(async () => (await effects().countDocuments({ _id: event.eventId })) === 1);
    await waitFor(drained);
    await consumer.close();
    await gate.close();
    assert.equal(calls, 2);
    assert.equal((await deliveries()) - before, 1);
  });

  test("MongoDB cut while the handler runs, and another pod processes the event: the handler does not run again", async () => {
    const target = new URL(mongo.url);
    const gate = await tcpGate(target.hostname, Number(target.port));
    const proxied = await connectMongo({
      url: `mongodb://127.0.0.1:${String(gate.port)}/?directConnection=true`,
      database: "messaging",
      clientOptions: { serverSelectionTimeoutMS: 500 },
    });
    track({ close: () => proxied.close() });
    const event = envelope();
    let calls = 0;
    const consumer = track(
      startConsumer({
        nats: worker,
        db: proxied.db,
        stream: "ORCHESTRATION",
        filter: "orchestration.TaskSubmitted",
        backoffMs: fast,
        handler: async (received, { session, markProcessed }) => {
          calls += 1;
          if (calls === 1) await gate.cut();
          await session.withTransaction(async () => {
            await proxied.db
              .collection<{ _id: string }>("effects")
              .insertOne({ _id: received.eventId }, { session });
            await markProcessed(session);
          });
        },
      }),
    );
    await waitFor(() => consumer.ready());
    const before = await deliveries();
    await publish(event.type, JSON.stringify(event));
    await waitFor(() => calls === 1);
    await sleep(2000);
    await processed().insertOne({ _id: event.eventId });
    await gate.open();
    await waitFor(drained);
    await consumer.close();
    await gate.close();
    assert.equal(calls, 1);
    assert.equal(await effects().countDocuments({ _id: event.eventId }), 0);
    assert.equal((await deliveries()) - before, 1);
  });

  test("a DLQ publish that fails for a while: the message is in the DLQ later", async () => {
    await manager.streams.delete("DLQ");
    const event = envelope();
    let calls = 0;
    const consumer = await consume(() => {
      calls += 1;
      return Promise.reject(new Error("always fails"));
    });
    await publish(event.type, JSON.stringify(event));
    await waitFor(() => calls === 5);
    await waitFor(async () => (await metric("consumer_oldest_held_seconds")) > 1);
    await createStreams(admin.connection, [{ name: "DLQ", subjects: ["dlq.>"] }]);
    await waitFor(async () =>
      (await subjectMessages("DLQ", "dlq.worker.orchestration.TaskSubmitted")).some(
        (message) => message.json<EventEnvelopeV1>().eventId === event.eventId,
      ),
    );
    await waitFor(drained);
    await waitFor(async () => (await metric("consumer_oldest_held_seconds")) === 0);
    await consumer.close();
    assert.equal(calls, 5);
  });

  test("ordered: a failed version 1 does not let version 2 pass, also with two consumers", async () => {
    const second = await connectNats({
      servers: nats.url,
      user: "worker",
      pass: "worker",
      service: "worker",
      logger,
    });
    track(second);
    const taskId = randomUUID();
    const events = [1, 2, 3].map((version) =>
      envelope({ streamId: `task-${taskId}`, version, correlationId: taskId }),
    );
    const seen: number[] = [];
    const handler = async (
      received: EventEnvelopeV1,
      {
        session,
        markProcessed,
      }: { session: ClientSession; markProcessed: (session: ClientSession) => Promise<void> },
    ): Promise<void> => {
      seen.push(received.version);
      if (received.version === 1 && seen.filter((version) => version === 1).length === 1) {
        throw new Error("version 1 fails once");
      }
      await session.withTransaction(() => markProcessed(session));
    };
    const consumers = [worker, second].map((nats) =>
      track(
        startConsumer({
          nats,
          db,
          stream: "ORCHESTRATION",
          filter: "orchestration.TaskSubmitted",
          backoffMs: fast,
          ordered: true,
          handler,
        }),
      ),
    );
    for (const consumer of consumers) await waitFor(() => consumer.ready());
    for (const event of events) await publish(event.type, JSON.stringify(event));
    await waitFor(() => seen.length === 4);
    await waitFor(drained);
    for (const consumer of consumers) await consumer.close();
    assert.deepEqual(seen, [1, 1, 2, 3]);
    const info = await manager.consumers.info("ORCHESTRATION", "worker");
    assert.equal(info.config.max_ack_pending, 1);
  });

  test("a poison message goes to the DLQ at once", async () => {
    let calls = 0;
    const consumer = await consume(() => {
      calls += 1;
      return Promise.resolve();
    });
    const invalid = envelope({ streamId: "not valid" });
    await publish("orchestration.TaskSubmitted", "{not json");
    await publish("orchestration.TaskSubmitted", JSON.stringify(invalid));
    await waitFor(async () => {
      const dead = await subjectMessages("DLQ", "dlq.worker.orchestration.TaskSubmitted");
      return (
        dead.some((message) => message.string() === "{not json") &&
        dead.some((message) => message.string() === JSON.stringify(invalid))
      );
    });
    await waitFor(drained);
    await consumer.close();
    assert.equal(calls, 0);
    const dead = await subjectMessages("DLQ", "dlq.worker.orchestration.TaskSubmitted");
    const json = dead.find((message) => message.string() === "{not json");
    const schema = dead.find((message) => message.string() === JSON.stringify(invalid));
    assert.ok(json && schema);
    assert.equal(json.header.get("error-class"), "SyntaxError");
    assert.equal(json.header.get("error-message"), "The message is not valid JSON");
    assert.equal(schema.header.get("error-class"), "ZodError");
    assert.equal(
      schema.header.get("error-message"),
      "The event is not valid: streamId invalid_format",
    );
  });

  test("a slow handler keeps all messages of its batch from a second delivery", async () => {
    const events = [envelope(), envelope(), envelope()];
    const seen: string[] = [];
    const consumer = await consume(
      async (received, { session, markProcessed }) => {
        seen.push(received.eventId);
        if (seen.length === 1) await new Promise((resolve) => setTimeout(resolve, 1500));
        await session.withTransaction(() => markProcessed(session));
      },
      [300, 300, 300, 300],
    );
    const before = await deliveries();
    for (const event of events) await publish(event.type, JSON.stringify(event));
    await waitFor(
      async () =>
        (await processed().countDocuments({
          _id: { $in: events.map((event) => event.eventId) },
        })) === 3,
    );
    await waitFor(drained);
    await consumer.close();
    assert.deepEqual(
      seen,
      events.map((event) => event.eventId),
    );
    assert.equal((await deliveries()) - before, 3);
  });
});

describe("ADR 0023 grants", () => {
  test("a wildcard filter works with the pinned subject", async () => {
    const event = envelope({ type: "llm.CallCompleted", payload: {} });
    const seen: string[] = [];
    const consumer = track(
      startConsumer({
        nats: worker,
        db,
        stream: "LLM",
        filter: "llm.>",
        parse: permissive,
        backoffMs: fast,
        handler: async (received, { session, markProcessed }) => {
          seen.push(received.eventId);
          await session.withTransaction(() => markProcessed(session));
        },
      }),
    );
    await waitFor(() => consumer.ready());
    await publish(event.type, JSON.stringify(event));
    await waitFor(() => seen.length === 1);
    await consumer.close();
    const info = await manager.consumers.info("LLM", "worker");
    assert.equal(info.config.filter_subject, "llm.>");
    assert.equal(info.config.max_deliver, 5);
  });

  test("the server refuses another filter, another durable and a stream create", async () => {
    const body = (filter: string, durable = "worker") =>
      JSON.stringify({
        stream_name: "ORCHESTRATION",
        config: { durable_name: durable, filter_subject: filter, ack_policy: "explicit" },
        action: "",
      });
    const refused = await worker.connection
      .request(
        "$JS.API.CONSUMER.CREATE.ORCHESTRATION.worker.orchestration.TaskSubmitted",
        body("orchestration.>"),
      )
      .then((reply) => reply.json<{ error?: { description: string } }>());
    assert.ok(refused.error, "a body with another filter must fail");
    await assert.rejects(
      worker.connection.request(
        "$JS.API.CONSUMER.CREATE.ORCHESTRATION.worker.orchestration.>",
        body("orchestration.>"),
        { timeout: 2000 },
      ),
    );
    await assert.rejects(
      worker.connection.request(
        "$JS.API.CONSUMER.CREATE.ORCHESTRATION.other.orchestration.TaskSubmitted",
        body("orchestration.TaskSubmitted", "other"),
        { timeout: 2000 },
      ),
    );
    const workerManager = await jetstreamManager(worker.connection, { checkAPI: false });
    await assert.rejects(
      workerManager.streams.add({ name: "ROGUE", subjects: ["orchestration.Rogue"] }),
    );
    await assert.rejects(manager.streams.info("ROGUE"));
  });

  test("rpc works between two users, and the inbox prefix is the service one", async () => {
    const echo = await connectNats({
      servers: nats.url,
      user: "echo",
      pass: "echo",
      service: "echo",
      logger,
    });
    const Input = z.object({ text: z.string() });
    const Output = z.object({ text: z.string(), length: z.int() });
    let calls = 0;
    const subscription = echo.serve(
      "rpc.test.echo",
      Input,
      Output,
      ({ text }) => {
        calls += 1;
        return { text, length: text.length };
      },
      { allowReplyPrefixes: ["_INBOX_worker."] },
    );
    await echo.connection.flush();
    const intruder = await connectNats({
      servers: nats.url,
      user: "intruder",
      pass: "intruder",
      service: "intruder",
      logger,
    });
    await assert.rejects(
      intruder.request("rpc.test.echo", Input, Output, { text: "flood" }, 500),
      /did not answer/,
    );
    await intruder.close();
    assert.equal(calls, 0);
    assert.deepEqual(await worker.request("rpc.test.echo", Input, Output, { text: "hello" }), {
      text: "hello",
      length: 5,
    });
    assert.equal(await worker.ready(), true);
    await assert.rejects(
      worker.request("rpc.test.missing", Input, Output, { text: "x" }, 500),
      /did not answer/,
    );
    assert.equal(calls, 1);
    subscription.unsubscribe();
    await echo.close();
  });
});
