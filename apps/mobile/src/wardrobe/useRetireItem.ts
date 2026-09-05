import { useCallback } from 'react';
import type { PublicClothingItem } from '@wardrobe/shared';
import { useAuth } from '../auth/AuthContext';
import { setRetired as setRetiredRequest } from './api';
import { useGuardedMutation } from '../tracking/useGuardedMutation';

export interface UseRetireItemResult {
  /**
   * Take an item into, or back out of, the active wardrobe — resolving the
   * updated item or `null` on failure, in which case `error` carries the
   * message.
   *
   * Two calls in the same frame for the same item issue ONE request and share
   * one result, exactly as `useLaundryStatus.setStatus` does, and for the same
   * reason: a same-frame double tap must not fire the write twice.
   */
  setRetired: (id: string, retired: boolean) => Promise<PublicClothingItem | null>;
  /** True while a toggle is in flight. AGGREGATE, not per key — see
   *  `useGuardedMutation`. */
  pending: boolean;
  /** The last failure's message, or `null`. AGGREGATE, not per key. */
  error: string | null;
}

/**
 * The Active/Retired toggle, for the item detail screen.
 *
 * No optimistic update, deliberately — the same reason `useLaundryStatus`
 * gives: the response carries the updated item, so the caller re-renders from
 * a fact rather than a guess, and a failed toggle cannot leave the screen
 * claiming a state the wardrobe is not in.
 */
export function useRetireItem(): UseRetireItemResult {
  const { token } = useAuth();
  const { run, pending, error } = useGuardedMutation<PublicClothingItem>(
    'Something went wrong updating that item.',
  );

  const setRetired = useCallback(
    (id: string, retired: boolean) =>
      // Keyed by item: a grid can have two rows toggled at once and both must
      // reach the server.
      run(id, () => setRetiredRequest(id, { token, retired })),
    [run, token],
  );

  return { setRetired, pending, error };
}
