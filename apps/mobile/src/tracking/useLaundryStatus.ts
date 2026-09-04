import { useCallback } from 'react';
import type { LaundryStatus, PublicClothingItem } from '@wardrobe/shared';
import { useAuth } from '../auth/AuthContext';
import { setLaundryStatus as setLaundryStatusRequest } from './api';
import { useGuardedMutation } from './useGuardedMutation';

export interface UseLaundryStatusResult {
  /**
   * Move one item into or out of the laundry, resolving the updated item or
   * `null` if it failed — in which case `error` carries the message.
   *
   * `status` is the shared `LaundryStatus` union, never a string literal
   * re-declared here: `PATCH /items/:id/laundry` validates against
   * `LAUNDRY_STATUSES`, and a value this hook could pass that the route
   * rejects would be a 400 the type system had no chance to catch.
   *
   * Two calls in the same frame for the same item issue ONE request and share
   * one result. The endpoint records EVERY transition, including a no-op one,
   * on purpose — so an unguarded double tap does not merely waste a round trip,
   * it appends a phantom row to the transition log for a change the user made
   * once.
   */
  setStatus: (id: string, status: LaundryStatus) => Promise<PublicClothingItem | null>;
  /** True while a transition is in flight. A render signal, not the guard —
   *  see `useGuardedMutation`. AGGREGATE, not per key. */
  pending: boolean;
  /** The last failure's message, or `null`. AGGREGATE, not per key — exactly
   *  as `pending` is, and the two must become keyed in the same change. See
   *  "the aggregate halves" in `useGuardedMutation`. */
  error: string | null;
}

/**
 * FR7/TC-09: the laundry toggle, for Task 4's item screen.
 *
 * There is no optimistic update, deliberately. The item's `laundryStatus` is
 * the server's answer and the response carries the updated item, so the caller
 * re-renders from a fact rather than from a guess — and a failed transition
 * therefore cannot leave a toggle showing a state the wardrobe is not in.
 * (It is also what makes a same-frame second tap unambiguously a duplicate:
 * the button still reads what it read before, so the second tap can only be
 * the same intent.)
 */
export function useLaundryStatus(): UseLaundryStatusResult {
  const { token } = useAuth();
  const { run, pending, error } = useGuardedMutation<PublicClothingItem>(
    'Something went wrong updating that item.',
  );

  const setStatus = useCallback(
    (id: string, status: LaundryStatus) =>
      // Keyed by item: a grid can have two rows toggled at once and both must
      // reach the server.
      run(id, () => setLaundryStatusRequest(id, { token, status })),
    [run, token],
  );

  return { setStatus, pending, error };
}
