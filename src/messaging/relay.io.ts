import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { headers } from "@nats-io/transport-node";
import type { MongoEventStore } from "../event-store/store.io.ts";
import type { CloseHook, ReadinessCheck } from "../http/server.ts";
import type { Nats } from "./connect.io.ts";
import { backoff } from "./failures.ts";
import { pauser } from "./pause.ts";

export interface RelayOptions {
  store: Pick<MongoEventStore, "pending" | "markPublished" | "watch">;
  nats: Nats;
  streams: readonly string[];
  pollMs?: number;
  batch?: number;
}

export interface Relay {
  ready: ReadinessCheck;
  close: CloseHook;
}

export function startRelay(options: RelayOptions): Relay {
  const { store, nats } = options;
  const { logger } = nats;
  const pollMs = options.pollMs ?? 1000;
  const batch = options.batch ?? 100;
  const js = jetstream(nats.connection);
  const manager = jetstreamManager(nats.connection, { checkAPI: false });
  const timing = pauser();
  const changes = store.watch();
  changes.on("change", () => {
    timing.wake();
  });
  changes.on("error", (error) => {
    logger.warn({ err: error }, "the outbox change stream failed; the relay still polls");
  });

  async function publishPending(): Promise<number> {
    let sent = 0;
    for (;;) {
      const pending = await store.pending(batch);
      for (const { envelope, traceparent } of pending) {
        const meta = headers();
        meta.set("correlation-id", envelope.correlationId);
        meta.set("causation-id", envelope.causationId);
        if (traceparent !== undefined) meta.set("traceparent", traceparent);
        await js.publish(envelope.type, JSON.stringify(envelope), {
          msgID: envelope.eventId,
          headers: meta,
        });
        await store.markPublished(envelope.eventId);
        sent += 1;
      }
      if (pending.length < batch || timing.stopped) return sent;
    }
  }

  const loop = (async () => {
    let failures = 0;
    while (!timing.stopped) {
      try {
        const sent = await publishPending();
        if (failures > 0) logger.info("the outbox relay works again");
        if (sent > 0) logger.debug({ sent }, "events published");
        failures = 0;
      } catch (error) {
        failures += 1;
        if (failures === 1) logger.warn({ err: error }, "the outbox relay failed; it tries again");
      }
      await (failures > 0 ? timing.pause(backoff(failures), false) : timing.pause(pollMs, true));
    }
  })();

  return {
    ready: async () => {
      try {
        const streams = (await manager).streams;
        await Promise.all(options.streams.map((name) => streams.info(name)));
        return true;
      } catch {
        return false;
      }
    },
    close: async () => {
      timing.stop();
      await changes.close();
      await loop;
    },
  };
}
