import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authLimiter } from '../../middleware/rateLimit.js';
import { loginSchema, refreshSchema, registerSchema } from './auth.schema.js';
import {
  loginHandler,
  logoutHandler,
  meHandler,
  refreshHandler,
  registerHandler,
} from './auth.controller.js';

export const authRouter = Router();

// Credential endpoints carry the strictest rate limit in the app.
authRouter.post('/register', authLimiter, validate({ body: registerSchema }), registerHandler);
authRouter.post('/login', authLimiter, validate({ body: loginSchema }), loginHandler);
authRouter.post('/refresh', authLimiter, validate({ body: refreshSchema }), refreshHandler);
authRouter.post('/logout', authenticate, logoutHandler);
authRouter.get('/me', authenticate, meHandler);
