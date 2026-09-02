import express, { type Express, type Request, type Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import mongoose from 'mongoose';
import { pinoHttp } from 'pino-http';
import { corsOrigins, isTest } from './config/env.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { globalLimiter } from './middleware/rateLimit.js';
import { sanitizeRequest } from './middleware/sanitize.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { taskRouter } from './modules/tasks/task.routes.js';
import { userRouter } from './modules/users/user.routes.js';
import { notificationRouter } from './modules/notifications/notification.routes.js';

export function createApp(): Express {
  const app = express();

  // Behind an ALB/ingress, so req.ip must come from X-Forwarded-For for rate
  // limiting to key on the real client rather than the load balancer.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(cors({ origin: corsOrigins, credentials: true }));
  // Bounded body: an unbounded JSON parser is a trivial memory-exhaustion vector.
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(sanitizeRequest);

  if (!isTest) app.use(pinoHttp({ logger }));

  /** Liveness/readiness. Reports dependency state without requiring auth. */
  app.get('/health', (_req: Request, res: Response) => {
    const dbState = mongoose.connection.readyState;
    const healthy = dbState === 1;
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      uptime: process.uptime(),
      dependencies: {
        mongodb: ['disconnected', 'connected', 'connecting', 'disconnecting'][dbState] ?? 'unknown',
      },
      timestamp: new Date().toISOString(),
    });
  });

  app.use(globalLimiter);

  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/tasks', taskRouter);
  app.use('/api/v1/users', userRouter);
  app.use('/api/v1/notifications', notificationRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
