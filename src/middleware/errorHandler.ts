import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { isProd } from '../config/env.js';

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `Cannot ${req.method} ${req.path}` },
  } satisfies ErrorBody);
}

/**
 * Single place where any thrown value becomes an HTTP response.
 * Every branch produces the same envelope so clients parse one shape.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    if (err.statusCode >= 500) logger.error({ err }, err.message);
    else logger.debug({ err: err.message, code: err.code }, 'Handled application error');
    res.status(err.statusCode).json({
      error: { code: err.code, message: err.message, details: err.details },
    } satisfies ErrorBody);
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'BAD_REQUEST',
        message: 'Request validation failed',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    } satisfies ErrorBody);
    return;
  }

  if (err instanceof mongoose.Error.ValidationError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Document validation failed',
        details: Object.values(err.errors).map((e) => ({ path: e.path, message: e.message })),
      },
    } satisfies ErrorBody);
    return;
  }

  if (err instanceof mongoose.Error.CastError) {
    res.status(400).json({
      error: { code: 'BAD_REQUEST', message: `Invalid value for '${err.path}'` },
    } satisfies ErrorBody);
    return;
  }

  /*
   * Duplicate key - surfaced as a 409 rather than leaking the index name.
   * The driver error class is reached through mongoose's own re-export rather
   * than by importing 'mongodb' directly: that package is a transitive
   * dependency, present in a hoisted local install but not guaranteed to be
   * resolvable from application code in a production install.
   */
  if (err instanceof mongoose.mongo.MongoServerError && err.code === 11000) {
    const field = Object.keys((err.keyPattern as Record<string, unknown>) ?? {})[0] ?? 'field';
    res.status(409).json({
      error: { code: 'CONFLICT', message: `A record with that ${field} already exists` },
    } satisfies ErrorBody);
    return;
  }

  /*
   * Errors raised by Express middleware (body-parser's 413 for an oversized
   * payload, its 400 for malformed JSON) follow the http-errors shape: a
   * numeric `status` plus `expose` marking the message as client-safe. Without
   * this branch they would surface as a 500, hiding a legitimate 4xx.
   */
  const httpError = err as {
    status?: number;
    statusCode?: number;
    type?: string;
    expose?: boolean;
    message?: string;
  };
  const status = httpError.status ?? httpError.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    const code =
      httpError.type === 'entity.too.large'
        ? 'PAYLOAD_TOO_LARGE'
        : httpError.type === 'entity.parse.failed'
          ? 'MALFORMED_JSON'
          : 'BAD_REQUEST';
    res.status(status).json({
      error: {
        code,
        message: httpError.expose && httpError.message ? httpError.message : 'Request rejected',
      },
    } satisfies ErrorBody);
    return;
  }

  logger.error({ err }, 'Unhandled error');
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      // Never leak internals in production.
      message: isProd ? 'Internal server error' : String((err as Error)?.message ?? err),
    },
  } satisfies ErrorBody);
}
