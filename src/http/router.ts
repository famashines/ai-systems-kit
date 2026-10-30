import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { ValidationError } from "./errors.ts";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface Request {
  readonly method: string;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly headers: IncomingHttpHeaders;
  readonly raw: IncomingMessage;
  readonly requestId: string;
  readonly correlationId: string;
  readonly state: Record<string, unknown>;
  json(): Promise<unknown>;
}

export interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type Handler = (request: Request) => Reply | Promise<Reply>;

export interface Route {
  method: Method;
  path: string;
  handler: Handler;
}

export type Match =
  { route: Route; params: Record<string, string> } | { allow: Method[] } | undefined;

const segments = (path: string): string[] => path.split("/").filter((part) => part !== "");

const decode = (part: string): string => {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new ValidationError("The path is not valid");
  }
};

export function createRouter(routes: readonly Route[]): (method: string, path: string) => Match {
  const compiled = routes.map((route) => ({ route, parts: segments(route.path) }));
  return (method, path) => {
    const parts = segments(path);
    const allow: Method[] = [];
    for (const { route, parts: pattern } of compiled) {
      if (pattern.length !== parts.length) continue;
      const params: Record<string, string> = {};
      const matches = pattern.every((part, index) => {
        const actual = parts[index] ?? "";
        if (part.startsWith(":")) {
          params[part.slice(1)] = decode(actual);
          return true;
        }
        return part === actual;
      });
      if (!matches) continue;
      if (route.method === method) return { route, params };
      allow.push(route.method);
    }
    return allow.length > 0 ? { allow } : undefined;
  };
}
