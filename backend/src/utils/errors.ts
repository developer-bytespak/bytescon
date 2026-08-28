// =============================================================
// AppError - Standardized error class
// =============================================================
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly code?: string;

  constructor(message: string, statusCode: number, code?: string) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    this.code = code;
    // `new.target.prototype`, NOT AppError.prototype. A subclass constructor's
    // body runs after super(), so hard-coding AppError.prototype here clobbered
    // the subclass prototype on every instance: `new AiUnavailableError()
    // instanceof AiUnavailableError` was FALSE and constructor.name was
    // 'AppError'. Nothing caught it because the codebase only ever tested
    // `instanceof AppError`, which stayed true either way. new.target is the
    // actually-constructed class, so subclass instanceof works and AppError
    // instanceof keeps working (subclass prototypes chain through it).
    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace(this, this.constructor);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403, 'FORBIDDEN');
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    // Defensive: some call sites pass a bare resource ("Opportunity"), others
    // pass a full phrase ("Opportunity not found"). Avoid "… not found not found".
    const message = /not found$/i.test(resource.trim())
      ? resource
      : `${resource} not found`;
    super(message, 404, 'NOT_FOUND');
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 422, 'VALIDATION_ERROR');
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, 'CONFLICT');
  }
}

// Optimistic-locking failure: the client's last-known updatedAt no longer
// matches the server row (someone else wrote in between). Distinct 'STALE_WRITE'
// code so the UI can show a reload-to-see-latest prompt rather than a generic
// conflict. Carries the current server updatedAt so the client can refresh.
export class StaleWriteError extends AppError {
  public readonly currentUpdatedAt?: string;
  constructor(currentUpdatedAt?: Date | string) {
    super('This record has been changed by someone else — reload to see latest', 409, 'STALE_WRITE');
    this.currentUpdatedAt =
      currentUpdatedAt instanceof Date ? currentUpdatedAt.toISOString() : currentUpdatedAt;
  }
}

export class AiUnavailableError extends AppError {
  constructor(
    message = 'AI generation is temporarily unavailable. Please try again in a few minutes.'
  ) {
    super(message, 503, 'AI_UNAVAILABLE');
  }
}
