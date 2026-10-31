import { ErrorCode } from "@famashines/ai-systems-contracts";
import { headers, type Msg, type NatsConnection, type Subscription } from "@nats-io/transport-node";
import type { Logger } from "pino";
import type { z } from "zod";
import { DomainError, UnavailableError, ValidationError, type Issue } from "../http/errors.ts";
import { headerText } from "./failures.ts";

const issuesOf = (error: z.ZodError): Issue[] =>
  error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    code: issue.code,
    message: issue.message,
  }));

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

export async function request<I extends z.ZodType, O extends z.ZodType>(
  connection: NatsConnection,
  subject: string,
  schemaIn: I,
  schemaOut: O,
  payload: z.input<I>,
  timeoutMs = 2000,
): Promise<z.output<O>> {
  const input = schemaIn.safeParse(payload);
  if (!input.success)
    throw new ValidationError("The rpc request is not valid", issuesOf(input.error));
  let reply: Msg;
  try {
    reply = await connection.request(subject, JSON.stringify(input.data), { timeout: timeoutMs });
  } catch {
    throw new UnavailableError(`${subject} did not answer`);
  }
  const code = reply.headers?.get("error-code");
  if (code) {
    throw new DomainError(
      ErrorCode.catch("internal").parse(code),
      Number(reply.headers?.get("error-status")) || 500,
      reply.headers?.get("error-message") || "The rpc call failed",
    );
  }
  const output = schemaOut.safeParse(parseJson(reply.string()));
  if (!output.success)
    throw new DomainError("internal", 500, `The reply of ${subject} is not valid`);
  return output.data;
}

export function serve<I extends z.ZodType, O extends z.ZodType>(
  connection: NatsConnection,
  logger: Logger,
  subject: string,
  schemaIn: I,
  schemaOut: O,
  handler: (input: z.output<I>) => z.input<O> | Promise<z.input<O>>,
): Subscription {
  async function answer(message: Msg): Promise<void> {
    try {
      const input = schemaIn.safeParse(parseJson(message.string()));
      if (!input.success) {
        throw new ValidationError("The rpc request is not valid", issuesOf(input.error));
      }
      const output = schemaOut.safeParse(await handler(input.data));
      if (!output.success)
        throw new Error(`The rpc handler of ${subject} gave a reply that is not valid`);
      message.respond(JSON.stringify(output.data));
    } catch (error) {
      const known = error instanceof DomainError;
      if (!known) logger.error({ err: error, subject }, "rpc handler failed");
      const reply = known ? error : new DomainError("internal", 500, "The rpc handler failed");
      const meta = headers();
      meta.set("error-code", reply.code);
      meta.set("error-status", String(reply.status));
      meta.set("error-message", headerText(reply.message));
      message.respond("", { headers: meta });
    }
  }
  return connection.subscribe(subject, {
    queue: subject,
    callback: (error, message) => {
      if (!error) void answer(message);
    },
  });
}
