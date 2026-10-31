import {
  ConnectionError,
  NoRespondersError,
  RequestError,
  TimeoutError,
} from "@nats-io/transport-node";
import { MongoNetworkError, MongoServerError, MongoServerSelectionError } from "mongodb";
import { z } from "zod";

export const consumerBackoffMs: readonly number[] = [1000, 5000, 30000, 120000];

export const backoffCapMs = 30000;

export const backoff = (failures: number, baseMs = 1000, maxMs = backoffCapMs): number =>
  Math.min(maxMs, baseMs * 2 ** Math.max(0, failures - 1));

const infrastructure = [
  MongoNetworkError,
  MongoServerSelectionError,
  TimeoutError,
  NoRespondersError,
  RequestError,
  ConnectionError,
];

const networkCodes = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

export function isInfrastructure(error: unknown): boolean {
  for (let current = error, depth = 0; current instanceof Error && depth < 5; depth += 1) {
    if (infrastructure.some((kind) => current instanceof kind)) return true;
    const { code } = current as { code?: unknown };
    if (typeof code === "string" && networkCodes.has(code)) return true;
    current = current.cause;
  }
  return false;
}

export type Next = { action: "retry"; delayMs: number } | { action: "dlq" };

export function onFailure(deliveryCount: number, backoffMs: readonly number[]): Next {
  const delayMs = backoffMs[deliveryCount - 1];
  return delayMs === undefined ? { action: "dlq" } : { action: "retry", delayMs };
}

export const headerText = (text: string): string =>
  text
    .replace(/[^ -~]+/g, " ")
    .trim()
    .slice(0, 500);

export function describeError(error: unknown): { errorClass: string; message: string } {
  if (error instanceof z.ZodError) {
    const issues = error.issues.map((issue) => `${issue.path.join(".") || "(root)"} ${issue.code}`);
    return { errorClass: "ZodError", message: `The event is not valid: ${issues.join(", ")}` };
  }
  if (error instanceof MongoServerError) {
    const code = String(error.code ?? "unknown");
    return {
      errorClass: error.name,
      message: `MongoDB error ${code} ${error.codeName ?? ""}`.trim(),
    };
  }
  if (error instanceof SyntaxError) {
    return { errorClass: "SyntaxError", message: "The message is not valid JSON" };
  }
  if (error instanceof Error) return { errorClass: error.name, message: error.message };
  return { errorClass: "Error", message: "A value that is not an Error was thrown" };
}

export function dlqHeaders(error: unknown): Record<string, string> {
  const { errorClass, message } = describeError(error);
  return { "error-class": headerText(errorClass), "error-message": headerText(message) };
}
