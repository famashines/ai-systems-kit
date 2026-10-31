import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import type { Nats } from "./connect.io.ts";

export interface StreamHead {
  first: number;
  last: number;
}

export interface OrderedMessage {
  seq: number;
  subject: string;
  data: string;
}

export interface OrderedOptions {
  subjects: string[];
  startSeq: number;
  onMessage: (message: OrderedMessage) => void;
  onError: (error: unknown) => void;
  onGone: () => void;
}

export interface OrderedStream {
  head(): Promise<StreamHead>;
  consume(options: OrderedOptions): Promise<() => Promise<void>>;
}

export async function orderedStream(nats: Nats, stream: string): Promise<OrderedStream> {
  const js = jetstream(nats.connection);
  const manager = await jetstreamManager(nats.connection);
  return {
    async head() {
      const { state } = await manager.streams.info(stream);
      return { first: state.first_seq, last: state.last_seq };
    },
    async consume({ subjects, startSeq, onMessage, onError, onGone }) {
      const consumer = await js.consumers.get(stream, {
        filter_subjects: subjects,
        opt_start_seq: startSeq,
      });
      const messages = await consumer.consume();
      const stopped = new AbortController();
      void (async () => {
        for await (const status of messages.status()) {
          if (status.type === "consumer_deleted" || status.type === "stream_not_found") {
            if (!stopped.signal.aborted) onGone();
            return;
          }
        }
      })();
      const done = (async () => {
        for await (const message of messages) {
          onMessage({ seq: message.seq, subject: message.subject, data: message.string() });
        }
        if (!stopped.signal.aborted) throw new Error(`The ${stream} consumer stopped`);
      })().catch(onError);
      return async () => {
        stopped.abort();
        await messages.close();
        await done;
        await consumer.delete();
      };
    },
  };
}
