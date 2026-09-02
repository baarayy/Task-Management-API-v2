import pino from 'pino';
import { env, isProd, isTest } from '../config/env.js';

export const logger = pino({
  level: isTest ? 'silent' : env.LOG_LEVEL,
  // Pretty output in dev; structured JSON in production for log aggregation.
  transport: isProd || isTest ? undefined : { target: 'pino-pretty', options: { colorize: true } },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.password',
      'req.body.refreshToken',
      '*.passwordHash',
    ],
    censor: '[redacted]',
  },
});
