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

type Env = Record<string, string | undefined>;

function throwingName(schema: z.ZodType, env: Env): string {
  if (schema instanceof z.ZodObject) {
    for (const [name, field] of Object.entries<z.ZodType>(schema.shape)) {
      try {
        field.safeParse(env[name]);
      } catch {
        return name;
      }
    }
  }
  return "(root)";
}

function isPlain(value: unknown): value is object {
  if (Array.isArray(value)) return true;
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function deepFreeze<T>(value: T): T {
  if (isPlain(value) && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

export function loadConfig<S extends z.ZodType>(
  schema: S,
  env: Env = process.env,
): Readonly<z.output<S>> {
  let parsed: z.ZodSafeParseResult<z.output<S>>;
  try {
    parsed = schema.safeParse(env);
  } catch {
    throw new ConfigError([{ name: throwingName(schema, env), message: "The value is not valid" }]);
  }
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => ({
        name: issue.path.map(String).join(".") || "(root)",
        message: issue.message,
      })),
    );
  }
  return deepFreeze(parsed.data);
}

export const commonEnv = z.object({
  SERVICE_NAME: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  RELEASE: z.string().min(1).default("local"),
});
