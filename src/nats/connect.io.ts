import { connect, type NatsConnection } from "@nats-io/transport-node";
import type { CloseHook, ReadinessCheck } from "../http/server.ts";

export interface NatsOptions {
  servers: string | string[];
  user?: string;
  pass?: string;
  service: string;
}

export interface Nats {
  connection: NatsConnection;
  service: string;
  ready: ReadinessCheck;
  close: CloseHook;
}

export async function connectNats(options: NatsOptions): Promise<Nats> {
  const { service } = options;
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
    ready: () =>
      connection.rtt().then(
        () => true,
        () => false,
      ),
    close: () => connection.drain(),
  };
}
