import { randomUUID } from "node:crypto";
import {
  parseEvent,
  type EventEnvelopeV1,
  type RegisteredEvent,
} from "@famashines/ai-systems-contracts";
import type { ClientSession } from "mongodb";
import { ConflictError } from "../http/errors.ts";

export class ConcurrencyError extends ConflictError {
  constructor(message = "The stream changed, reload it") {
    super(message);
  }
}

export type Upcaster = (payload: unknown) => unknown;
export type Upcasters = Readonly<Record<string, Readonly<Record<number, Upcaster>>>>;
export type Parse<E> = (input: unknown) => E;

export type NewEvent<E extends EventEnvelopeV1> = E extends unknown
  ? Omit<E, "eventId" | "streamId" | "version" | "occurredAt">
  : never;

export type StoredEvent<E extends EventEnvelopeV1> = E & { position: number };

export interface AppendInput<E extends EventEnvelopeV1, A> {
  streamId: string;
  expectedVersion?: number;
  events: readonly NewEvent<E>[];
  command?: { commandId: string; answer: A };
  also?: (session: ClientSession) => Promise<void>;
}

export interface AppendResult<E extends EventEnvelopeV1, A> {
  events: StoredEvent<E>[];
  answer: A | undefined;
  replayed: boolean;
}

export interface EventStore<E extends EventEnvelopeV1 = RegisteredEvent> {
  append<A = undefined>(input: AppendInput<E, A>): Promise<AppendResult<E, A>>;
  readStream(streamId: string, options?: { fromVersion?: number }): Promise<StoredEvent<E>[]>;
  readAll(options?: { afterPosition?: number; limit?: number }): Promise<StoredEvent<E>[]>;
}

export interface StoreOptions<E extends EventEnvelopeV1> {
  upcasters?: Upcasters;
  parse?: Parse<E>;
  now?: () => Date;
  newId?: () => string;
}

export interface Rules<E extends EventEnvelopeV1> {
  build: (streamId: string, events: readonly NewEvent<E>[], last: number) => E[];
  decode: (raw: unknown) => E;
  now: () => Date;
}

export function checkVersion(last: number, expected: number | undefined): void {
  if (expected !== undefined && expected !== last) throw new ConcurrencyError();
}

export function upcast(raw: unknown, upcasters: Upcasters): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const { type, schemaVersion, payload } = raw as Record<string, unknown>;
  if (typeof type !== "string" || !Object.hasOwn(upcasters, type)) return raw;
  const steps = upcasters[type] ?? {};
  let version = schemaVersion;
  let value = payload;
  while (typeof version === "number" && Object.hasOwn(steps, version)) {
    value = (steps[version] as Upcaster)(value);
    version += 1;
  }
  return version === schemaVersion ? raw : { ...raw, schemaVersion: version, payload: value };
}

export function rules<E extends EventEnvelopeV1>(options: StoreOptions<E>): Rules<E> {
  const parse = options.parse ?? (parseEvent as Parse<E>);
  const upcasters = options.upcasters ?? {};
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  return {
    build: (streamId, events, last) =>
      events.map((event, index) =>
        parse({
          ...event,
          eventId: newId(),
          streamId,
          version: last + index + 1,
          occurredAt: now().toISOString(),
        }),
      ),
    decode: (raw) => parse(upcast(raw, upcasters)),
    now,
  };
}
