import type { EventEnvelopeV1, RegisteredEvent } from "@famashines/ai-systems-contracts";
import { context, propagation } from "@opentelemetry/api";
import { MongoServerError, type ChangeStream, type ClientSession, type Db } from "mongodb";
import type { Migration } from "../mongo/migrations.io.ts";
import {
  checkVersion,
  ConcurrencyError,
  rules,
  type AppendResult,
  type EventStore,
  type StoredEvent,
  type StoreOptions,
} from "./rules.ts";

type EventDoc = Omit<EventEnvelopeV1, "eventId"> & {
  _id: string;
  position: number;
  publishedAt: Date | null;
  traceparent?: string;
};

interface CommandDoc {
  _id: string;
  answer: unknown;
  createdAt: Date;
}

const keepDays = 45;

export const eventStoreMigration: Migration = {
  name: "000-event-store",
  up: async (db) => {
    const events = db.collection("events");
    await events.createIndex({ streamId: 1, version: 1 }, { unique: true }, undefined);
    await events.createIndex({ publishedAt: 1, position: 1 }, undefined, undefined);
    await events.createIndex({ position: 1 }, { unique: true }, undefined);
    await db
      .collection("commands")
      .createIndex({ createdAt: 1 }, { expireAfterSeconds: keepDays * 86400 }, undefined);
    await db
      .collection<{ _id: string; position: number }>("counters")
      .updateOne({ _id: "events" }, { $setOnInsert: { position: 0 } }, { upsert: true });
  },
};

export interface Unpublished {
  envelope: EventEnvelopeV1;
  traceparent?: string;
}

export interface MongoEventStore<
  E extends EventEnvelopeV1 = RegisteredEvent,
> extends EventStore<E> {
  pending(limit: number): Promise<Unpublished[]>;
  markPublished(eventId: string): Promise<void>;
  watch(): ChangeStream;
}

function activeTraceparent(): string | undefined {
  const carrier: { traceparent?: string } = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent;
}

const envelopeOf = (doc: EventDoc): EventEnvelopeV1 => ({
  eventId: doc._id,
  type: doc.type,
  schemaVersion: doc.schemaVersion,
  streamId: doc.streamId,
  version: doc.version,
  occurredAt: doc.occurredAt,
  correlationId: doc.correlationId,
  causationId: doc.causationId,
  actor: doc.actor,
  payload: doc.payload,
});

const isStreamConflict = (error: unknown): boolean =>
  error instanceof MongoServerError &&
  error.code === 11000 &&
  Object.hasOwn((error.keyPattern ?? {}) as object, "streamId");

export function createEventStore<E extends EventEnvelopeV1 = RegisteredEvent>(
  db: Db,
  options: StoreOptions<E> = {},
): MongoEventStore<E> {
  const events = db.collection<EventDoc>("events");
  const commands = db.collection<CommandDoc>("commands");
  const counters = db.collection<{ _id: string; position: number }>("counters");
  const { build, decode, now } = rules(options);

  const toStored = (doc: EventDoc): StoredEvent<E> => ({
    ...decode(envelopeOf(doc)),
    position: doc.position,
  });

  const replay = async <A>(
    commandId: string,
    session?: ClientSession,
  ): Promise<AppendResult<E, A> | undefined> => {
    const earlier = await commands.findOne({ _id: commandId }, session ? { session } : {});
    return earlier ? { events: [], answer: earlier.answer as A, replayed: true } : undefined;
  };

  return {
    async append(input) {
      const { streamId, expectedVersion, events: newEvents, command, also } = input;
      const session = db.client.startSession();
      try {
        return await session.withTransaction(async () => {
          const earlier =
            command && (await replay<typeof command.answer>(command.commandId, session));
          if (earlier) return earlier;
          const [head] = await events
            .find({ streamId }, { session, sort: { version: -1 }, limit: 1 })
            .toArray();
          const last = head?.version ?? 0;
          checkVersion(last, expectedVersion);
          const built = build(streamId, newEvents, last);
          const counter = await counters.findOneAndUpdate(
            { _id: "events" },
            { $inc: { position: built.length } },
            { session, returnDocument: "after" },
          );
          if (!counter) throw new Error("The event store migration did not run");
          const first = counter.position - built.length + 1;
          const stored = built.map((event, index) => ({ ...event, position: first + index }));
          const traceparent = activeTraceparent();
          if (stored.length > 0) {
            await events.insertMany(
              stored.map(({ eventId, ...event }) => ({
                _id: eventId,
                ...event,
                publishedAt: null,
                ...(traceparent === undefined ? {} : { traceparent }),
              })),
              { session },
            );
          }
          if (command) {
            await commands.insertOne(
              { _id: command.commandId, answer: command.answer, createdAt: now() },
              { session },
            );
          }
          await also?.(session);
          return { events: stored, answer: command?.answer, replayed: false };
        });
      } catch (error) {
        const earlier =
          input.command && (await replay<typeof input.command.answer>(input.command.commandId));
        if (earlier) return earlier;
        if (isStreamConflict(error)) throw new ConcurrencyError();
        throw error;
      } finally {
        await session.endSession();
      }
    },

    async readStream(streamId, { fromVersion = 1 } = {}) {
      const docs = await events
        .find({ streamId, version: { $gte: fromVersion } }, { sort: { version: 1 } })
        .toArray();
      return docs.map(toStored);
    },

    async readAll({ afterPosition = 0, limit = 100 } = {}) {
      const docs = await events
        .find({ position: { $gt: afterPosition } }, { sort: { position: 1 }, limit })
        .toArray();
      return docs.map(toStored);
    },

    async pending(limit) {
      const docs = await events
        .find({ publishedAt: null }, { sort: { position: 1 }, limit })
        .toArray();
      return docs.map((doc) => ({
        envelope: envelopeOf(doc),
        ...(doc.traceparent === undefined ? {} : { traceparent: doc.traceparent }),
      }));
    },

    async markPublished(eventId) {
      await events.updateOne({ _id: eventId, publishedAt: null }, { $set: { publishedAt: now() } });
    },

    watch: () => events.watch([{ $match: { operationType: "insert" } }, { $project: { _id: 1 } }]),
  };
}
