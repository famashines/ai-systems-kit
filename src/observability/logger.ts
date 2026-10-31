import { isSpanContextValid, trace } from "@opentelemetry/api";
import { pino, type DestinationStream, type Logger } from "pino";
import { getContext } from "../http/context.ts";

const secretKeys = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "apikey",
  "xapikey",
  "password",
  "secret",
  "clientsecret",
  "prompt",
  "messages",
]);

const isSecret = (key: string): boolean => secretKeys.has(key.toLowerCase().replace(/[-_]/g, ""));

function censor(value: unknown, ancestors: Set<object>): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (ancestors.has(value)) return "[Circular]";
  if (value instanceof URL) {
    if (!value.username && !value.password) return value.href;
    const user = value.username ? "[Redacted]" : "";
    const password = value.password ? ":[Redacted]" : "";
    return `${value.protocol}//${user}${password}@${value.host}${value.pathname}${value.search}${value.hash}`;
  }
  if (!(value instanceof Error) && "toJSON" in value) return value;
  ancestors.add(value);
  let result: unknown;
  if (Array.isArray(value)) {
    result = value.map((item) => censor(item, ancestors));
  } else {
    const source: Record<string, unknown> =
      value instanceof Error
        ? {
            ...Object.fromEntries(Object.entries(value)),
            type: value.constructor.name || value.name,
            message: value.message,
            stack: value.stack,
            ...(value.cause === undefined ? {} : { cause: value.cause }),
          }
        : (value as Record<string, unknown>);
    result = Object.fromEntries(
      Object.entries(source).map(([key, item]) => [
        key,
        isSecret(key) ? "[Redacted]" : censor(item, ancestors),
      ]),
    );
  }
  ancestors.delete(value);
  return result;
}

const redact = (object: Record<string, unknown>): Record<string, unknown> =>
  censor(object, new Set()) as Record<string, unknown>;

export interface LoggerOptions {
  service: string;
  release: string;
  level?: string;
  destination?: DestinationStream;
}

export function createLogger(options: LoggerOptions): Logger {
  const logger = pino(
    {
      level: options.level ?? "info",
      base: { service: options.service, release: options.release },
      formatters: { log: redact },
      serializers: { err: (error: unknown) => error },
      mixin: () => {
        const span = trace.getActiveSpan()?.spanContext();
        return {
          ...getContext(),
          ...(span && isSpanContextValid(span) ? { traceId: span.traceId } : {}),
        };
      },
    },
    options.destination ?? process.stdout,
  );
  const proto = Object.getPrototypeOf(logger) as {
    child: (this: Logger, bindings: Record<string, unknown>, options?: object) => Logger;
  };
  function child(this: Logger, bindings: Record<string, unknown>, childOptions?: object): Logger {
    return proto.child.call(this, redact(bindings), childOptions);
  }
  Object.assign(logger, { child });
  return logger;
}
