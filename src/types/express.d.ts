import type { RoleType } from '../models/types.js';

declare global {
  namespace Express {
    interface Request {
      /** Populated by the `authenticate` middleware. */
      user?: {
        id: string;
        role: RoleType;
        email: string;
      };
      /**
       * Output of the `validate` middleware - parsed, coerced and typed.
       * Express 5 exposes `req.query` as a getter, so validated values are
       * written here rather than assigned back onto the request.
       */
      valid?: {
        body: unknown;
        query: unknown;
        params: unknown;
      };
    }
  }
}

export {};
