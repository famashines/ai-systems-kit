import { connect, type NatsConnection, type Subscription } from "@nats-io/transport-node";
import type { Logger } from "pino";
import type { z } from "zod";
import type { CloseHook, ReadinessCheck } from "../http/server.ts";
import { request, serve, type ServeOptions } from "./rpc.ts";

export interface NatsOptions {
  servers: string | string[];
  user?: string;
  pass?: string;
  service: string;
  logger: Logger;
}

export interface Nats {
  connection: NatsConnection;
  service: string;
  logger: Logger;
  ready: ReadinessCheck;
  close: CloseHook;
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
  const { service, logger } = options;
  const connection = await connect({
    servers: options.servers,
    ...(options.user === undefined ? {} : { user: options.user }),
    ...(options.pass === undefined ? {} : { pass: options.pass }),
    name: service,
    inboxPrefix: `_INBOX_${service}`,
    maxReconnectAttempts: -1,
    waitOnFirstConnect: true,
  });
  return {
    connection,
    service,
    logger,
    ready: () =>
      connection.rtt().then(
        () => true,
        () => false,
      ),
    close: () => connection.drain(),
    request: (subject, schemaIn, schemaOut, payload, timeoutMs) =>
      request(connection, subject, schemaIn, schemaOut, payload, timeoutMs),
    serve: (subject, schemaIn, schemaOut, handler, serveOptions) =>
      serve(connection, logger, subject, schemaIn, schemaOut, handler, serveOptions),
  };
}
