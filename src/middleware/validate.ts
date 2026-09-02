import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodTypeAny, z } from 'zod';
import { BadRequestError } from '../lib/errors.js';

export interface RequestSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

const passthrough = z.any();

/**
 * Parses body, query and params in a single pass and stores the *parsed*
 * result on `req.valid`. Handlers read from there, never from the raw request,
 * so they always see coerced, bounded, whitelisted values.
 *
 * Note: Express 5 makes `req.query` a lazily-computed getter with no setter,
 * so overwriting it in place (the common Express 4 pattern) throws. Writing to
 * `req.valid` sidesteps that entirely.
 */
export function validate(schemas: RequestSchemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      req.valid = {
        body: (schemas.body ?? passthrough).parse(req.body),
        query: (schemas.query ?? passthrough).parse(req.query),
        params: (schemas.params ?? passthrough).parse(req.params),
      };
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        next(
          new BadRequestError(
            'Request validation failed',
            err.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
              code: i.code,
            })),
          ),
        );
        return;
      }
      next(err);
    }
  };
}

/** Typed accessors so handlers do not litter casts everywhere. */
export const body = <T>(req: Request): T => req.valid?.body as T;
export const query = <T>(req: Request): T => req.valid?.query as T;
export const params = <T>(req: Request): T => req.valid?.params as T;
