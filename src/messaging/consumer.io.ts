import type { EventEnvelopeV1, RegisteredEvent } from "@famashines/ai-systems-contracts";
import { jetstream, type Consumer, type ConsumerMessages, type JsMsg } from "@nats-io/jetstream";
import { headers } from "@nats-io/transport-node";
import {
  context,
  metrics,
  propagation,
  ROOT_CONTEXT,
  type ObservableResult,
} from "@opentelemetry/api";
import type { ClientSession, Db } from "mongodb";
import { rules, type Parse, type Upcasters } from "../event-store/rules.ts";
import type { CloseHook, ReadinessCheck } from "../http/server.ts";
import type { Migration } from "../mongo/migrations.io.ts";
import type { Nats } from "./connect.io.ts";
import {
  backoff,
  backoffCapMs,
  consumerBackoffMs,
  describeError,
  dlqHeaders,
  isInfrastructure,
  onFailure,
} from "./failures.ts";
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
  ordered?: boolean;
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
  const ordered = options.ordered ?? false;
  const { logger, service: durable } = nats;
  const backoffMs = options.backoffMs ?? consumerBackoffMs;
  const { decode } = rules(options);
  const processed = db.collection<{ _id: string; processedAt: Date }>("processed");
  const js = jetstream(nats.connection);
  const timing = pauser();
  let consumer: Consumer | undefined;
  let messages: ConsumerMessages | undefined;
  const held = new Map<JsMsg, number>();
  const oldestHeld = metrics
    .getMeter("ai-systems-kit")
    .createObservableGauge("consumer_oldest_held_seconds", {
      description: "Age of the oldest message that the consumer holds and did not ack yet",
    });
  const observe = (result: ObservableResult): void => {
    const since = Math.min(...held.values());
    result.observe(held.size === 0 ? 0 : (Date.now() - since) / 1000, { stream, durable });
  };
  oldestHeld.addCallback(observe);

  async function healthy(): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<boolean>((resolve) => {
      timer = setTimeout(resolve, 2000, false);
    });
    const check = Promise.all([db.command({ ping: 1 }), nats.connection.rtt()]).then(
      () => true,
      () => false,
    );
    try {
      return await Promise.race([check, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function create(): Promise<Consumer> {
    const config = {
      durable_name: durable,
      filter_subject: filter,
      ack_policy: "explicit",
      deliver_policy: "all",
      max_deliver: backoffMs.length + 1,
      max_ack_pending: ordered ? 1 : 1000,
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

  async function retrying<T>(
    what: string,
    work: () => Promise<T>,
    again: (error: unknown) => boolean | Promise<boolean>,
  ): Promise<T> {
    for (let failures = 1; ; failures += 1) {
      try {
        return await work();
      } catch (error) {
        if (timing.stopped || !(await again(error))) throw error;
        const delayMs = backoff(failures);
        if (failures === 1 || delayMs === backoffCapMs) {
          logger.error(
            { error: describeError(error), what, failures },
            "the consumer waits and tries again",
          );
        }
        await timing.pause(delayMs, false);
      }
    }
  }

  async function deadLetter(message: JsMsg, error: unknown): Promise<void> {
    const meta = headers();
    for (const name of copiedHeaders) {
      const value = message.headers?.get(name);
      if (value) meta.set(name, value);
    }
    for (const [name, value] of Object.entries(dlqHeaders(error))) meta.set(name, value);
    const subject = `dlq.${durable}.${message.subject}`;
    await retrying(
      "DLQ publish",
      () => js.publish(subject, message.data, { headers: meta }),
      () => true,
    );
    message.ack();
    logger.error(
      {
        error: describeError(error),
        subject: message.subject,
        deliveries: message.info.deliveryCount,
      },
      "message sent to the DLQ",
    );
  }

  async function run(message: JsMsg, event: E): Promise<void> {
    const markProcessed = async (session: ClientSession): Promise<void> => {
      if (!session.inTransaction()) {
        throw new Error(
          "Call markProcessed in a transaction: session.withTransaction or also of append",
        );
      }
      await processed.insertOne({ _id: event.eventId, processedAt: new Date() }, { session });
    };
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

  async function handle(message: JsMsg): Promise<void> {
    let event: E;
    try {
      event = decode(JSON.parse(message.string()));
    } catch (error) {
      await deadLetter(message, error);
      return;
    }
    const seen = () =>
      retrying("processed check", () => isProcessed(event.eventId), isInfrastructure);
    const runHeld = async (): Promise<void> => {
      for (;;) {
        try {
          await run(message, event);
          return;
        } catch (error) {
          if (timing.stopped || (await healthy())) throw error;
          await retrying(
            "MongoDB and NATS health",
            async () => {
              if (!(await healthy())) throw error;
            },
            () => true,
          );
          if (await seen()) return;
        }
      }
    };
    for (let attempt = message.info.deliveryCount; ; attempt += 1) {
      try {
        if (!(await seen())) await runHeld();
        message.ack();
        return;
      } catch (error) {
        if (timing.stopped) return;
        if (await seen()) {
          message.ack();
          return;
        }
        const next = onFailure(attempt, backoffMs);
        if (next.action === "dlq") {
          await deadLetter(message, error);
          return;
        }
        logger.warn(
          { error: describeError(error), eventId: event.eventId, deliveries: attempt },
          "the handler failed; the message comes again",
        );
        if (!ordered) {
          message.nak(next.delayMs);
          return;
        }
        if (!(await timing.pause(next.delayMs, false))) return;
      }
    }
  }

  async function pull(from: Consumer): Promise<void> {
    messages = await from.fetch({ max_messages: options.batch ?? 10, expires: 5000 });
    if (timing.stopped) await messages.close();
    const timer = setInterval(
      () => {
        for (const message of held.keys()) message.working();
      },
      Math.max(10, (backoffMs[0] ?? 1000) / 3),
    );
    let chain = Promise.resolve();
    try {
      for await (const message of messages) {
        held.set(message, Date.now());
        chain = chain
          .then(() => handle(message))
          .catch((error: unknown) => {
            logger.error(
              { error: describeError(error), subject: message.subject },
              "message handling failed",
            );
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
          logger.warn(
            { error: describeError(error), stream },
            "the consumer failed; it tries again",
          );
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
      oldestHeld.removeCallback(observe);
      await messages?.close();
      await loop;
    },
  };
}
