import type { ZodType } from 'zod';
import type { ApiFieldError } from '@wardrobe/shared';
import { ApiError } from './errors';

export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;

  const fields: ApiFieldError[] = result.error.issues.map((issue) => ({
    path: issue.path.join('.') || '(body)',
    message: issue.message,
  }));

  throw new ApiError(400, 'VALIDATION_FAILED', 'Request validation failed', fields);
}
