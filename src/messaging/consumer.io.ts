import type { EventEnvelopeV1, RegisteredEvent } from "@famashines/ai-systems-contracts";
import { jetstream, type Consumer, type ConsumerMessages, type JsMsg } from "@nats-io/jetstream";
import { headers } from "@nats-io/transport-node";
import { context, propagation, ROOT_CONTEXT } from "@opentelemetry/api";
import type { ClientSession, Db } from "mongodb";
import { rules, type Parse, type Upcasters } from "../event-store/rules.ts";
import type { CloseHook, ReadinessCheck } from "../http/server.ts";
import type { Migration } from "../mongo/migrations.io.ts";
import type { Nats } from "./connect.io.ts";
import { backoff, consumerBackoffMs, dlqHeaders, onFailure } from "./failures.ts";
import { pauser } from "./pause.ts";

export interface HandlerContext {
  session: ClientSession;
  markProcessed: (session: ClientSession) => Promise<void>;
}

export type EventHandler<E> = (event: E, context: HandlerContext) => Promise<void>;

export interface ConsumerOptions<E extends EventEnvelopeV1> {
  nats: Nats;
  db: Db;
  stream: string;
  filter: string;
  handler: EventHandler<E>;
  upcasters?: Upcasters;
  parse?: Parse<E>;
  batch?: number;
  backoffMs?: readonly number[];
}

export interface DurableConsumer {
  ready: ReadinessCheck;
  close: CloseHook;
}

export const processedMigration: Migration = {
  name: "000-processed",
  up: async (db) => {
    await db
      .collection("processed")
      .createIndex({ processedAt: 1 }, { expireAfterSeconds: 45 * 86400 }, undefined);
  },
};

const copiedHeaders = ["correlation-id", "causation-id", "traceparent"];

export function startConsumer<E extends EventEnvelopeV1 = RegisteredEvent>(
  options: ConsumerOptions<E>,
): DurableConsumer {
  const { nats, db, stream, filter, handler } = options;
  const { logger, service: durable } = nats;
  const backoffMs = options.backoffMs ?? consumerBackoffMs;
  const { decode } = rules(options);
  const processed = db.collection<{ _id: string; processedAt: Date }>("processed");
  const js = jetstream(nats.connection);
  const timing = pauser();
  let consumer: Consumer | undefined;
  let messages: ConsumerMessages | undefined;

  async function create(): Promise<Consumer> {
    const config = {
      durable_name: durable,
      filter_subject: filter,
      ack_policy: "explicit",
      deliver_policy: "all",
      max_deliver: backoffMs.length + 1,
      backoff: backoffMs.map((ms) => ms * 1_000_000),
    };
    const reply = await nats.connection.request(
      `$JS.API.CONSUMER.CREATE.${stream}.${durable}.${filter}`,
      JSON.stringify({ stream_name: stream, config, action: "" }),
      { timeout: 5000 },
    );
    const answer = reply.json<{ error?: { description: string } }>();
    if (answer.error) throw new Error(`The consumer was not made: ${answer.error.description}`);
    return js.consumers.get(stream, durable);
  }

  const isProcessed = async (eventId: string): Promise<boolean> =>
    (await processed.findOne({ _id: eventId })) !== null;

  async function deadLetter(message: JsMsg, error: unknown): Promise<void> {
    const meta = headers();
    for (const name of copiedHeaders) {
      const value = message.headers?.get(name);
      if (value) meta.set(name, value);
    }
    for (const [name, value] of Object.entries(dlqHeaders(error))) meta.set(name, value);
    await js.publish(`dlq.${durable}.${message.subject}`, message.data, { headers: meta });
    message.ack();
    logger.error(
      { err: error, subject: message.subject, deliveries: message.info.deliveryCount },
      "message sent to the DLQ",
    );
  }

  async function handle(message: JsMsg): Promise<void> {
    let event: E;
    try {
      event = decode(JSON.parse(message.string()));
    } catch (error) {
      await deadLetter(message, error);
      return;
    }
    const markProcessed = async (session: ClientSession): Promise<void> => {
      await processed.insertOne({ _id: event.eventId, processedAt: new Date() }, { session });
    };
    try {
      if (!(await isProcessed(event.eventId))) {
        const parent = propagation.extract(ROOT_CONTEXT, {
          traceparent: message.headers?.get("traceparent") ?? "",
        });
        const session = db.client.startSession();
        try {
          await context.with(parent, () => handler(event, { session, markProcessed }));
        } finally {
          await session.endSession();
        }
      }
      message.ack();
    } catch (error) {
      if (await isProcessed(event.eventId)) {
        message.ack();
        return;
      }
      const next = onFailure(message.info.deliveryCount, backoffMs);
      if (next.action === "dlq") {
        await deadLetter(message, error);
        return;
      }
      message.nak(next.delayMs);
      logger.warn(
        { err: error, eventId: event.eventId, deliveries: message.info.deliveryCount },
        "handler failed; the message comes again",
      );
    }
  }

  async function pull(from: Consumer): Promise<void> {
    messages = await from.fetch({ max_messages: options.batch ?? 10, expires: 5000 });
    if (timing.stopped) await messages.close();
    const held = new Set<JsMsg>();
    const timer = setInterval(
      () => {
        for (const message of held) message.working();
      },
      Math.max(10, (backoffMs[0] ?? 1000) / 3),
    );
    let chain = Promise.resolve();
    try {
      for await (const message of messages) {
        held.add(message);
        chain = chain
          .then(() => handle(message))
          .catch((error: unknown) => {
            logger.error({ err: error, subject: message.subject }, "message handling failed");
          })
          .finally(() => held.delete(message));
      }
    } finally {
      await chain;
      clearInterval(timer);
    }
  }

  const loop = (async () => {
    let failures = 0;
    while (!timing.stopped) {
      try {
        consumer ??= await create();
        await pull(consumer);
        failures = 0;
      } catch (error) {
        consumer = undefined;
        failures += 1;
        if (failures === 1)
          logger.warn({ err: error, stream }, "the consumer failed; it tries again");
        await timing.pause(backoff(failures), false);
      }
    }
  })();

  return {
    ready: async () => {
      if (!consumer || timing.stopped) return false;
      return consumer.info().then(
        () => true,
        () => false,
      );
    },
    close: async () => {
      timing.stop();
      await messages?.close();
      await loop;
    },
  };
}
