export const API_ERROR_CODES = [
  'VALIDATION_FAILED',
  'INVALID_CREDENTIALS',
  'EMAIL_TAKEN',
  'UNAUTHORIZED',
  'NOT_FOUND',
  /**
   * A dependency this API cannot answer without was unreachable, slow, or
   * answered with something it could not use. Today: the Python AI service
   * behind `GET /suggestions`.
   *
   * It is a SEPARATE code from INTERNAL, and that distinction is the whole
   * point of it. `tagImage` collapses every AI failure to null because
   * tagging has a fallback — the item is stored untagged and the upload
   * proceeds. A suggestion request has no fallback: the only two things the
   * client can say are "suggestions are unavailable" and "you have no
   * suggestions", and those are different sentences of which only one is
   * true. Without a code to test for, a client cannot tell them apart and
   * will pick the wrong one, silently, forever.
   */
  'AI_UNAVAILABLE',
  'INTERNAL',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiFieldError {
  path: string;
  message: string;
}

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    fields?: ApiFieldError[];
  };
}

function isValidFields(fields: unknown): fields is ApiFieldError[] {
  if (!Array.isArray(fields)) return false;
  return fields.every(
    (f) =>
      typeof f === 'object' &&
      f !== null &&
      typeof (f as { path?: unknown }).path === 'string' &&
      typeof (f as { message?: unknown }).message === 'string',
  );
}

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) return false;
  const err = (value as { error?: unknown }).error;
  if (typeof err !== 'object' || err === null) return false;
  const { code, message, fields } = err as { code?: unknown; message?: unknown; fields?: unknown };
  if (typeof code !== 'string' || !API_ERROR_CODES.includes(code as ApiErrorCode)) return false;
  if (typeof message !== 'string') return false;
  if (fields !== undefined && !isValidFields(fields)) return false;
  return true;
}
