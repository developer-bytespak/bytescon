// =============================================================
// Global Error Handler Middleware
// =============================================================
import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';
import { ApiResponse } from '../types';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  // Zod validation failures: surface the offending field with a 422 instead
  // of leaking a generic 500. Covers every `Schema.parse(req…)` call site.
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const field = first?.path.join('.');
    const message = first
      ? field
        ? `${field}: ${first.message}`
        : first.message
      : 'Validation failed';
    logger.warn('Validation error', { message, path: req.path, method: req.method });
    res.status(422).json({
      success: false,
      error: message,
      code: 'VALIDATION_ERROR',
      details: err.flatten(),
    } as ApiResponse);
    return;
  }

  // Malformed JSON body (express.json body-parser) → 400 rather than 500.
  if (
    (err as { type?: string }).type === 'entity.parse.failed' ||
    (err instanceof SyntaxError && 'body' in err)
  ) {
    logger.warn('Invalid JSON body', { path: req.path, method: req.method });
    res.status(400).json({
      success: false,
      error: 'Request body is not valid JSON',
      code: 'INVALID_JSON',
    } as ApiResponse);
    return;
  }

  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      logger.error('Operational error', {
        message: err.message,
        code: err.code,
        path: req.path,
        method: req.method,
        stack: err.stack,
      });
    } else {
      logger.warn('Client error', {
        message: err.message,
        code: err.code,
        path: req.path,
        statusCode: err.statusCode,
      });
    }

    const response: ApiResponse = {
      success: false,
      error: err.message,
      code: err.code,
    };

    // Optimistic-lock rejections carry the current server updatedAt so the
    // client can reconcile without a full round-trip.
    const currentUpdatedAt = (err as { currentUpdatedAt?: string }).currentUpdatedAt;
    if (currentUpdatedAt) {
      (response as ApiResponse & { currentUpdatedAt?: string }).currentUpdatedAt = currentUpdatedAt;
    }

    res.status(err.statusCode).json(response);
    return;
  }

  // Unhandled / unexpected errors
  logger.error('Unhandled error', {
    message: err.message,
    path: req.path,
    method: req.method,
    stack: err.stack,
  });

  res.status(500).json({
    success: false,
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
  } as ApiResponse);
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    error: `Route not found: ${req.method} ${req.path}`,
    code: 'ROUTE_NOT_FOUND',
  } as ApiResponse);
}
