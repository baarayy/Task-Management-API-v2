import { z } from 'zod';
import { ROLES, Role } from '../../models/types.js';

const password = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128)
  .refine((v) => /[a-z]/.test(v), 'Password must contain a lowercase letter')
  .refine((v) => /[A-Z]/.test(v), 'Password must contain an uppercase letter')
  .refine((v) => /[0-9]/.test(v), 'Password must contain a digit');

export const registerSchema = z.object({
  email: z.string().email().max(254).toLowerCase(),
  password,
  name: z.string().min(1).max(120),
  // Self-registration cannot mint an admin. Only an existing admin can create
  // privileged accounts, via POST /users - see users.routes.ts.
  role: z
    .enum(ROLES as [string, ...string[]])
    .optional()
    .default(Role.User),
});

export const loginSchema = z.object({
  email: z.string().email().max(254).toLowerCase(),
  password: z.string().min(1).max(128),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(10),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
