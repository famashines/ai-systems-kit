import type { ErrorCode } from "@famashines/ai-systems-contracts";

export type { ErrorCode };

export type ErrorHeaders = Readonly<Record<string, string>>;

export interface Issue {
  path: string;
  code: string;
  message: string;
}

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly headers: ErrorHeaders;

  constructor(code: ErrorCode, status: number, message: string, headers: ErrorHeaders = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.headers = headers;
  }
}

export class ValidationError extends DomainError {
  readonly issues: Issue[];

  constructor(
    message = "The request is not valid",
    issues: Issue[] = [],
    headers: ErrorHeaders = {},
  ) {
    super("validation_failed", 400, message, headers);
    this.issues = issues;
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message = "Authentication is necessary", headers: ErrorHeaders = {}) {
    super("unauthorized", 401, message, headers);
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = "This action is not permitted", headers: ErrorHeaders = {}) {
    super("forbidden", 403, message, headers);
  }
}

export class NotFoundError extends DomainError {
  constructor(message = "The resource does not exist", headers: ErrorHeaders = {}) {
    super("not_found", 404, message, headers);
  }
}

export class ConflictError extends DomainError {
  constructor(message = "The resource changed, reload it", headers: ErrorHeaders = {}) {
    super("conflict", 409, message, headers);
  }
}

export class RateLimitedError extends DomainError {
  constructor(message = "Too many requests", headers: ErrorHeaders = {}) {
    super("rate_limited", 429, message, headers);
  }
}

export class UnavailableError extends DomainError {
  constructor(message = "The service is not available", headers: ErrorHeaders = {}) {
    super("unavailable", 503, message, headers);
  }
}
