import type { EventEnvelopeV1, RegisteredEvent } from "@famashines/ai-systems-contracts";
import type { ClientSession } from "mongodb";
import {
  checkVersion,
  rules,
  type AppendInput,
  type AppendResult,
  type EventStore,
  type StoredEvent,
  type StoreOptions,
} from "../event-store/rules.ts";

export function createMemoryEventStore<E extends EventEnvelopeV1 = RegisteredEvent>(
  options: StoreOptions<E> = {},
): EventStore<E> {
  const { build, decode } = rules(options);
  const log: { raw: unknown; position: number; streamId: string; version: number }[] = [];
  const commands = new Map<string, unknown>();
  let queue: Promise<unknown> = Promise.resolve();

  const toStored = (entry: (typeof log)[number]): StoredEvent<E> => ({
    ...decode(structuredClone(entry.raw)),
    position: entry.position,
  });

  async function append<A>(input: AppendInput<E, A>): Promise<AppendResult<E, A>> {
    const { command } = input;
    if (command && commands.has(command.commandId)) {
      return { events: [], answer: commands.get(command.commandId) as A, replayed: true };
    }
    const last = log.findLast((entry) => entry.streamId === input.streamId)?.version ?? 0;
    checkVersion(last, input.expectedVersion);
    const built = build(input.streamId, input.events, last);
    await input.also?.({} as ClientSession);
    const stored = built.map((event, index) => ({ ...event, position: log.length + index + 1 }));
    for (const event of stored) {
      log.push({
        raw: structuredClone(event),
        position: event.position,
        streamId: event.streamId,
        version: event.version,
      });
    }
    if (command) commands.set(command.commandId, structuredClone(command.answer));
    return { events: stored, answer: command?.answer, replayed: false };
  }

  return {
    append(input) {
      const result = queue.then(() => append(input));
      queue = result.catch(() => undefined);
      return result;
    },
    readStream: (streamId, { fromVersion = 1 } = {}) =>
      Promise.resolve(
        log
          .filter((entry) => entry.streamId === streamId && entry.version >= fromVersion)
          .map(toStored),
      ),
    readAll: ({ afterPosition = 0, limit = 100 } = {}) =>
      Promise.resolve(log.slice(afterPosition, afterPosition + limit).map(toStored)),
  };
}
