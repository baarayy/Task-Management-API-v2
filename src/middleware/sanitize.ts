import type { NextFunction, Request, Response } from 'express';
import sanitizeHtml from 'sanitize-html';

/**
 * Two distinct threats, handled in one pass over the request body:
 *
 * 1. NoSQL operator injection - a body like { "email": { "$ne": null } } turns
 *    a lookup into a match-anything query. Any key starting with `$`, or
 *    containing a `.` (dotted-path injection), is dropped.
 * 2. Stored XSS - free-text fields are rendered by clients later, so all HTML
 *    is stripped on the way in. Text-only is the right default for a task API.
 */
const MAX_DEPTH = 10;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return undefined;

  if (typeof value === 'string') {
    return sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} }).trim();
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1));
  }

  if (isPlainObject(value)) {
    const clean: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (key.startsWith('$') || key.includes('.')) continue;
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      clean[key] = sanitizeValue(val, depth + 1);
    }
    return clean;
  }

  return value;
}

export function sanitizeRequest(req: Request, _res: Response, next: NextFunction): void {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeValue(req.body);
  }
  next();
}
