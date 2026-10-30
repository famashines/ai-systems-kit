export type ErrorCode =
  | "validation_failed"
  | "not_found"
  | "conflict"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "internal"
  | "unavailable"
  | "budget_refused";

export interface Issue {
  path: string;
  code: string;
  message: string;
}

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, status: number, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
  }
}

export class ValidationError extends DomainError {
  readonly issues: Issue[];

  constructor(message = "The request is not valid", issues: Issue[] = []) {
    super("validation_failed", 400, message);
    this.issues = issues;
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message = "Authentication is necessary") {
    super("unauthorized", 401, message);
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = "This action is not permitted") {
    super("forbidden", 403, message);
  }
}

export class NotFoundError extends DomainError {
  constructor(message = "The resource does not exist") {
    super("not_found", 404, message);
  }
}

export class ConflictError extends DomainError {
  constructor(message = "The resource changed, reload it") {
    super("conflict", 409, message);
  }
}

export class RateLimitedError extends DomainError {
  constructor(message = "Too many requests") {
    super("rate_limited", 429, message);
  }
}

export class UnavailableError extends DomainError {
  constructor(message = "The service is not available") {
    super("unavailable", 503, message);
  }
}
