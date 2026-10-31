import { z } from "zod";

export const consumerBackoffMs: readonly number[] = [1000, 5000, 30000, 120000];

export const backoff = (failures: number, baseMs = 1000, maxMs = 30000): number =>
  Math.min(maxMs, baseMs * 2 ** Math.max(0, failures - 1));

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
