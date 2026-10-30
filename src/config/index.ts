import { z } from "zod";

export interface ConfigIssue {
  name: string;
  message: string;
}

export class ConfigError extends Error {
  readonly issues: ConfigIssue[];

  constructor(issues: ConfigIssue[]) {
    super(
      `The configuration is not valid: ${issues.map((issue) => `${issue.name}: ${issue.message}`).join("; ")}`,
    );
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export function loadConfig<S extends z.ZodType>(
  schema: S,
  env: Record<string, string | undefined> = process.env,
): Readonly<z.output<S>> {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => ({
        name: issue.path.map(String).join(".") || "(root)",
        message: issue.message,
      })),
    );
  }
  return Object.freeze(parsed.data);
}

export const commonEnv = z.object({
  SERVICE_NAME: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  RELEASE: z.string().min(1).default("local"),
});
