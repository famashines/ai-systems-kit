import { isSpanContextValid, trace } from "@opentelemetry/api";
import { pino, type DestinationStream, type Logger } from "pino";
import { getContext } from "../http/context.ts";

const secretKeys = [
  "authorization",
  "cookie",
  '["set-cookie"]',
  "token",
  "accessToken",
  "refreshToken",
  "apiKey",
  "password",
  "secret",
  "prompt",
  "messages",
];

const redactPaths = ["", "*.", "*.*.", "*.*.*."].flatMap((prefix) =>
  secretKeys.map((key) => (key.startsWith("[") ? `${prefix.slice(0, -1)}${key}` : prefix + key)),
);

export interface LoggerOptions {
  service: string;
  release: string;
  level?: string;
  destination?: DestinationStream;
}

export function createLogger(options: LoggerOptions): Logger {
  return pino(
    {
      level: options.level ?? "info",
      base: { service: options.service, release: options.release },
      redact: redactPaths,
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
}
