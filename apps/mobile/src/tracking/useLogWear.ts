import { useCallback } from 'react';
import type { PublicWearEvent } from '@wardrobe/shared';
import { useAuth } from '../auth/AuthContext';
import { logWear as logWearRequest } from './api';
import { useGuardedMutation } from './useGuardedMutation';

export interface LogWearInput {
  outfitId: string;
  /**
   * **OMIT THIS FOR A WEAR THAT IS HAPPENING NOW** — pass it only for a date
   * the user explicitly picked in the past.
   *
   * A screen must never fill this in from the device clock. `POST
   * /wear-history` rejects a future `wornAt` against a `now` it takes after
   * the request lands, with no skew tolerance, so a handset a few
   * milliseconds fast gets a 400 the user cannot act on — and it is invisible
   * on a dev machine, where the emulator and the API share one clock. The full
   * reasoning is on `LogWearOptions.wornAt` in `./api` and on
   * `PublicWearEvent.wornAt` in `@wardrobe/shared`.
   */
  wornAt?: string;
  /** Bound by `MAX_OCCASION_LENGTH` from `@wardrobe/shared` — set a text
   *  input's `maxLength` from that constant rather than a literal. */
  occasion?: string;
}

export interface UseLogWearResult {
  /**
   * Log one wear, resolving the created event or `null` if it failed — in
   * which case `error` carries the message.
   *
   * Two calls in the same frame for the same outfit issue ONE request and
   * share one result. That is not a nicety: `POST /wear-history` is not
   * idempotent in any sense, and a second request writes a second event AND
   * increments every member item's `wearCount` a second time — corrupting the
   * exact number "most worn" ranks on, with no endpoint in the system able to
   * undo it.
   */
  logWear: (input: LogWearInput) => Promise<PublicWearEvent | null>;
  /** True while a wear is in flight. A render signal, not the guard — see
   *  `useGuardedMutation`. AGGREGATE, not per key. */
  pending: boolean;
  /** The last failure's message, or `null`. AGGREGATE, not per key — exactly
   *  as `pending` is, and the two must become keyed in the same change. See
   *  "the aggregate halves" in `useGuardedMutation`. */
  error: string | null;
}

/**
 * FR6/TC-08: the "Log wear" action, for Task 4's outfit screen.
 *
 * Deliberately NOT a member of `useWearHistory`. The screen that logs a wear
 * is an outfit screen and has no reason to fetch a page of history, and the
 * two operations must not share an `error` channel — a history load failing in
 * the background would otherwise erase the message a failed wear just wrote,
 * and vice versa. `useOutfits` needed a tagged error channel precisely because
 * it did put two operations on one; splitting the hooks removes the need.
 */
export function useLogWear(): UseLogWearResult {
  const { token } = useAuth();
  const { run, pending, error } = useGuardedMutation<PublicWearEvent>(
    'Something went wrong logging that wear.',
  );

  const logWear = useCallback(
    (input: LogWearInput) =>
      // Keyed by outfit: two different outfits logged at once are two
      // intents, and both must reach the server.
      //
      // The spread carries `wornAt` only when the CALLER supplied one. Nothing
      // here defaults it, and nothing here reads the clock.
      //
      // `token` GOES LAST, AFTER THE SPREAD, and that order is load-bearing.
      // Written `{ token, ...input }`, a `token` property that happens to
      // exist on the caller's object silently wins and goes out as the
      // Authorization header — a 401 at best and a cross-account write at
      // worst. TypeScript does not stop it: excess-property checking fires on
      // an object *literal* passed inline, and not on a variable, a widened
      // type, or an `as`, which is exactly how a screen builds a draft from
      // form state. `LogWearInput` declares no `token` precisely so that the
      // session's token is the only one that can ever be used, and this order
      // is what enforces the declaration at runtime.
      run(input.outfitId, () => logWearRequest({ ...input, token })),
    [run, token],
  );

  return { logWear, pending, error };
}
