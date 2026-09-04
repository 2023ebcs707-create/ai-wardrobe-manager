import { resolveWornAt } from './wearHistory';
import { ApiError } from '../http/errors';

/**
 * `resolveWornAt` is unit-tested rather than exercised only over HTTP because
 * its boundary is UNREACHABLE through the API.
 *
 * The route takes `now` after the request has landed, so a client-supplied
 * timestamp is always at least one-way transit time in the past. There is
 * therefore no HTTP request that can make `wornAt` exactly equal `now`, and
 * relaxing the check from `>` to `>=` passes all 32 integration tests. Calling
 * the function with both values supplied is the only way to pin which side of
 * "this exact instant" is accepted.
 */
const NOW = new Date('2026-08-24T12:00:00.000Z');

function reject(raw: string): ApiError {
  try {
    resolveWornAt(raw, NOW);
  } catch (err) {
    return err as ApiError;
  }
  throw new Error(`Expected resolveWornAt(${raw}) to throw, but it returned`);
}

describe('resolveWornAt', () => {
  it('defaults to the caller-supplied now when wornAt is omitted', () => {
    expect(resolveWornAt(undefined, NOW)).toBe(NOW);
  });

  it('accepts a wornAt of exactly now', () => {
    // THE BOUNDARY, lower side. The comparison must be strictly `>`: an
    // instant that IS the present is not the future. Relaxing it to `>=`
    // fails here and nowhere else in the suite.
    expect(resolveWornAt(NOW.toISOString(), NOW).toISOString()).toBe(NOW.toISOString());
  });

  it('accepts a wornAt one millisecond in the past', () => {
    const just = new Date(NOW.getTime() - 1);
    expect(resolveWornAt(just.toISOString(), NOW).toISOString()).toBe(just.toISOString());
  });

  it('rejects a wornAt one millisecond in the future', () => {
    // THE BOUNDARY, upper side. One millisecond of client clock skew is
    // enough, which is exactly why clients must omit `wornAt` for "now" --
    // see the contract on PublicWearEvent.wornAt.
    const err = reject(new Date(NOW.getTime() + 1).toISOString());
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.fields?.[0]?.path).toBe('wornAt');
  });

  it('rejects a wornAt seconds in the future, the realistic skew case', () => {
    const err = reject(new Date(NOW.getTime() + 5_000).toISOString());
    expect(err.status).toBe(400);
    expect(err.code).toBe('VALIDATION_FAILED');
  });

  it('accepts a back-dated wornAt without limit', () => {
    const lastYear = new Date('2025-01-01T00:00:00.000Z');
    expect(resolveWornAt(lastYear.toISOString(), NOW).toISOString()).toBe(lastYear.toISOString());
  });

  it('rejects an unparseable wornAt', () => {
    const err = reject('yesterday-ish');
    expect(err.status).toBe(400);
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.fields?.[0]?.path).toBe('wornAt');
  });

  it('gives different messages for unparseable and future, since they are different mistakes', () => {
    // A client that sent a malformed string and one whose clock is ahead need
    // to do different things about it.
    expect(reject('yesterday-ish').message).not.toBe(
      reject(new Date(NOW.getTime() + 1).toISOString()).message,
    );
  });
});
