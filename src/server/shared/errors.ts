// Typed application errors. Every error that should produce a specific HTTP
// response (as opposed to a 500) extends AppError. Route handlers catch
// AppError via server/shared/http.ts's errorResponse() and never leak a raw
// Error/stack trace to the client — see that file for the mapping.
//
// Why typed errors instead of throwing plain strings or returning
// {ok:false} result objects: every repository/service function in
// server/modules/* can `throw` as soon as it detects a problem, the calling
// route handler doesn't need to know the full catalogue of failure modes for
// every service it calls, and a service function's success-path return type
// stays the success type (no `| ErrorResult` union polluting every call
// site). The cost — exceptions as control flow — is acceptable here because
// these are genuinely exceptional, non-retryable conditions (not-found,
// forbidden, conflict, validation), not expected branches of normal logic.

export abstract class AppError extends Error {
  abstract readonly httpStatus: number;
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ValidationError extends AppError {
  readonly httpStatus = 400;
  readonly code = "VALIDATION_ERROR";
  readonly issues?: unknown;

  constructor(message: string, issues?: unknown) {
    super(message);
    this.issues = issues;
  }
}

export class UnauthorizedError extends AppError {
  readonly httpStatus = 401;
  readonly code = "UNAUTHORIZED";

  constructor(message = "Authentication required") {
    super(message);
  }
}

export class ForbiddenError extends AppError {
  readonly httpStatus = 403;
  readonly code = "FORBIDDEN";

  constructor(message = "You do not have permission to perform this action") {
    super(message);
  }
}

export class NotFoundError extends AppError {
  readonly httpStatus = 404;
  readonly code = "NOT_FOUND";

  constructor(entity: string) {
    super(`${entity} not found`);
  }
}

export class ConflictError extends AppError {
  readonly httpStatus = 409;
  readonly code = "CONFLICT";

  constructor(message: string) {
    super(message);
  }
}
