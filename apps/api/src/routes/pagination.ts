import { Types } from 'mongoose';
import { ApiError } from '../http/errors';

/**
 * The cursor is opaque on purpose. Clients that parse a cursor start depending
 * on the sort key, which then cannot change without breaking them.
 */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

export function decodeCursor(raw: string): { createdAt: Date; id: string } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const parts = decoded.split('|');
  if (parts.length !== 2) return null;

  const [when, id] = parts;
  const createdAt = new Date(when);
  // An invalid Date is not an error in JS -- it is a Date whose time is NaN.
  if (Number.isNaN(createdAt.getTime())) return null;
  if (!Types.ObjectId.isValid(id)) return null;

  return { createdAt, id };
}

/**
 * Shared limit bounds for every cursor-paginated list endpoint.
 *
 * These live here rather than in one route file because `GET /items` and
 * `GET /outfits` must agree: a client that learns the page size from one and
 * applies it to the other would silently mis-page. Two copies of the same
 * bound is exactly the kind of duplication that drifts.
 */
export const DEFAULT_LIMIT = 24;
export const MAX_LIMIT = 100;

/**
 * Validate a `?limit=` query parameter, or return the default when absent.
 *
 * Out-of-range and non-numeric values are rejected rather than clamped. A
 * silently clamped limit makes the client's paging arithmetic wrong with no
 * signal, which is worse than an error it can see.
 *
 */
/**
 * The single error shape every list endpoint returns for a bad `?limit=`.
 *
 * Lifted here rather than left duplicated per route: the extraction that moved
 * the bounds out of `items.ts` originally copied this factory into the second
 * route verbatim, which is the same drift the extraction existed to prevent.
 */
export function limitError(message: string, detail: string): ApiError {
  return new ApiError(400, 'VALIDATION_FAILED', message, [{ path: 'limit', message: detail }]);
}

/**
 * `fallback` and `max` are parameters rather than hard-wired constants because
 * `GET /analytics/usage` needs different bounds (5 / 50) from the cursor lists
 * (24 / 100): a top-N leaderboard is not a page of a list. The PARSING is
 * still shared, which is the part that must not drift -- what counts as a
 * numeric limit, the rejection rather than the clamp, and the exact error
 * shape a client parses. A second copy with its own bounds would have
 * duplicated all four to change two numbers.
 *
 * Both defaults keep every existing call site (`parseLimit(req.query.limit)`)
 * meaning exactly what it meant before.
 */
export function parseLimit(
  raw: unknown,
  fallback: number = DEFAULT_LIMIT,
  max: number = MAX_LIMIT,
): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw limitError('limit must be a positive integer', 'Expected a positive integer');
  }
  const value = Number(raw);
  if (value < 1 || value > max) {
    throw limitError(
      `limit must be between 1 and ${max}`,
      `Expected 1..${max}, received ${value}`,
    );
  }
  return value;
}
