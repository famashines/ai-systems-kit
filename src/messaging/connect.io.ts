import type { Subscription } from "@nats-io/transport-node";
import type { Logger } from "pino";
import type { z } from "zod";
import {
  connectNats as connectCore,
  type Nats as CoreNats,
  type NatsOptions as CoreOptions,
} from "../nats/connect.io.ts";
import { request, serve, type ServeOptions } from "./rpc.ts";

export interface NatsOptions extends CoreOptions {
  logger: Logger;
}

export interface Nats extends CoreNats {
  logger: Logger;
  request<I extends z.ZodType, O extends z.ZodType>(
    subject: string,
    schemaIn: I,
    schemaOut: O,
    payload: z.input<I>,
    timeoutMs?: number,
  ): Promise<z.output<O>>;
  serve<I extends z.ZodType, O extends z.ZodType>(
    subject: string,
    schemaIn: I,
    schemaOut: O,
    handler: (input: z.output<I>) => z.input<O> | Promise<z.input<O>>,
    options: ServeOptions,
  ): Subscription;
}

export async function connectNats(options: NatsOptions): Promise<Nats> {
  const { logger, ...core } = options;
  const nats = await connectCore(core);
  const { connection } = nats;
  return {
    ...nats,
    logger,
    request: (subject, schemaIn, schemaOut, payload, timeoutMs) =>
      request(connection, subject, schemaIn, schemaOut, payload, timeoutMs),
    serve: (subject, schemaIn, schemaOut, handler, serveOptions) =>
      serve(connection, logger, subject, schemaIn, schemaOut, handler, serveOptions),
  };
}
