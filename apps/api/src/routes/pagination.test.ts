import { ApiError } from '../http/errors';
import {
  encodeCursor,
  decodeCursor,
  parseLimit,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from './pagination';

describe('cursor encoding', () => {
  const when = new Date('2026-08-24T10:30:00.000Z');
  const id = '68a9f1c2e4b0a1d2c3f4e5d6';

  it('round-trips a createdAt and an id', () => {
    const decoded = decodeCursor(encodeCursor(when, id));
    expect(decoded).not.toBeNull();
    expect(decoded!.createdAt.toISOString()).toBe(when.toISOString());
    expect(decoded!.id).toBe(id);
  });

  it('does not leak the raw timestamp or id in the cursor text', () => {
    const cursor = encodeCursor(when, id);
    expect(cursor).not.toContain(id);
    expect(cursor).not.toContain('2026-08-24');
  });

  it('returns null for a cursor that is not valid base64url', () => {
    expect(decodeCursor('!!!not-base64!!!')).toBeNull();
  });

  it('returns null for a decodable cursor with a missing field', () => {
    const half = Buffer.from('2026-08-24T10:30:00.000Z').toString('base64url');
    expect(decodeCursor(half)).toBeNull();
  });

  it('returns null for a decodable cursor with an unparseable date', () => {
    const bad = Buffer.from(`not-a-date|${id}`).toString('base64url');
    expect(decodeCursor(bad)).toBeNull();
  });

  it('returns null for a decodable cursor whose id is not an ObjectId', () => {
    const bad = Buffer.from(`${when.toISOString()}|nope`).toString('base64url');
    expect(decodeCursor(bad)).toBeNull();
  });
});

/**
 * The list endpoints' bounds are exercised end-to-end by every paginated
 * route's integration tests. What those cannot see is the PARAMETERISATION
 * added for `GET /analytics/usage`: over HTTP, a caller-visible difference
 * between "default 24, max 100" and "default 5, max 50" only shows up on the
 * one route that passes its own bounds, so a regression that silently ignored
 * the arguments would still leave every list endpoint green.
 */
describe('parseLimit bounds', () => {
  it('falls back to the caller-supplied default rather than the list default', () => {
    expect(parseLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(parseLimit(undefined, 5, 50)).toBe(5);
  });

  it('enforces the caller-supplied maximum, and says which one it enforced', () => {
    expect(parseLimit('50', 5, 50)).toBe(50);

    // 51 is well inside the list endpoints' MAX_LIMIT of 100, so a parseLimit
    // that ignored its `max` argument would accept this.
    expect(() => parseLimit('51', 5, 50)).toThrow(ApiError);
    try {
      parseLimit('51', 5, 50);
      throw new Error('expected parseLimit to throw');
    } catch (err) {
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(400);
      expect(apiErr.message).toBe('limit must be between 1 and 50');
      expect(apiErr.fields?.[0]).toEqual({ path: 'limit', message: 'Expected 1..50, received 51' });
    }
  });

  it('still rejects zero, negatives and non-numerics under custom bounds', () => {
    for (const bad of ['0', '-1', '2.5', 'five', '']) {
      expect(() => parseLimit(bad, 5, 50)).toThrow(ApiError);
    }
  });

  it('keeps the list endpoints on their own bounds when none are passed', () => {
    expect(parseLimit('100')).toBe(MAX_LIMIT);
    expect(() => parseLimit(String(MAX_LIMIT + 1))).toThrow(ApiError);
  });
});
