import { useCallback, useRef, useState } from 'react';
import { ApiClientError } from '../api/client';

export interface GuardedMutation<TResult> {
  /**
   * Run `perform` unless an identical call (same `key`) is already in flight,
   * in which case the in-flight promise is handed back instead.
   *
   * Resolves `null` on failure rather than rejecting: a screen that writes
   * `onPress={() => setStatus(id, 'in_laundry')}` cannot then produce an
   * unhandled rejection, and one that wants to act only on success can
   * `await` it and check for `null`.
   */
  run: (key: string, perform: () => Promise<TResult>) => Promise<TResult | null>;
  /**
   * True while at least one call is in flight, and `error` is the last
   * failure's message. BOTH ARE AGGREGATE while `run` is keyed — see
   * "the aggregate halves" below. Neither is the guard.
   */
  pending: boolean;
  /** A ready-to-render message for the last failure, or `null`. Aggregate,
   *  exactly as `pending` is. */
  error: string | null;
}

/**
 * The double-submit guard both tracking mutations are built on.
 *
 * WHY A REF AND NOT STATE. Stage 5 shipped a same-frame double tap that
 * created two identical outfits, and the same bug was live on the item-upload
 * path. In both cases the intended guard was a `pending` state flag, and a
 * state flag cannot win this race: React commits it on the *next* render,
 * which is strictly after every handler queued in the current frame has
 * already run. The second tap therefore reads `pending === false` and the
 * guard does nothing at all. A ref is written synchronously, so the second
 * call in the same frame sees it.
 *
 * `pending` below is still exposed, because a button needs something to
 * disable itself on — but it is a *consequence* of the guard rather than the
 * guard, and nothing in this file reads it to make a decision.
 *
 * THE AGGREGATE HALVES. `run` is keyed, but `pending` and `error` are not:
 * `pending` is "something is in flight" and `error` is "the last failure,
 * whichever key it belonged to". That asymmetry is deliberate and adequate
 * only while each consumer drives ONE control — which is what Stage 6's
 * screens do (one "Log wear" button on an outfit, one laundry toggle on an
 * item). It is NOT adequate for a grid with a control per row, and the error
 * half is the sharper of the two: two rows failing at once leaves one message
 * with no way to say which row it is about, which is precisely the conflation
 * `useOutfits`' `ErrorSource` tag was invented to fix.
 *
 * So the rule, stated here rather than discovered later: THE TWO HALVES MOVE
 * TOGETHER. The first caller that needs per-key `pending` needs per-key
 * `error` in the same change, and vice versa. Keying one and leaving the other
 * aggregate is the state that reads as finished and is not. Nothing today
 * needs either, so neither is built.
 *
 * KEYED, NOT A SINGLE FLAG, for the reason `useOutfits`' `pendingDeletesRef`
 * is keyed: two different resources may legitimately be mutated at once, and
 * only a repeat of the *same* one is the duplicate this guards. The stored
 * promise is handed back to the second caller so both observe the same
 * outcome rather than the second being told the write failed.
 *
 * PER IN-FLIGHT CALL, NOT PER KEY FOREVER: the entry is removed when the call
 * settles, so a wear that failed can be retried and an outfit worn twice can
 * be logged twice. Only *concurrent* duplicates collapse.
 *
 * WHY THIS IS SHARED. One implementation of the race-critical part is better
 * than two near-copies that drift. It is deliberately not evidence that any
 * particular caller uses it, which is why `useLogWear` and `useLaundryStatus`
 * each have their own "two synchronous calls issue one request" test, and why
 * Task 4's screens are expected to have theirs.
 */
export function useGuardedMutation<TResult>(fallbackMessage: string): GuardedMutation<TResult> {
  const [pendingCount, setPendingCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // A ref, for the reason in the header. Keyed by resource id.
  const inFlightRef = useRef(new Map<string, Promise<TResult | null>>());

  const run = useCallback(
    (key: string, perform: () => Promise<TResult>): Promise<TResult | null> => {
      const existing = inFlightRef.current.get(key);
      if (existing) return existing;

      const attempt = (async (): Promise<TResult | null> => {
        // Cleared when the write *starts*, not when it succeeds: a screen
        // rendering its banner on `error !== null` would otherwise show the
        // dead message for the whole round trip of the retry that is meant to
        // clear it.
        setError(null);
        setPendingCount((count) => count + 1);
        try {
          // `perform()` is invoked here, synchronously, before the first
          // suspension point — so the request is issued before `run` returns
          // and the map entry below is set on a call that has really started.
          return await perform();
        } catch (err) {
          // ApiClientError messages are already written for a person to read
          // (the client turns a network failure into "Cannot reach the
          // server…" and passes the API's own message through otherwise).
          setError(err instanceof ApiClientError ? err.message : fallbackMessage);
          return null;
        } finally {
          setPendingCount((count) => count - 1);
          // This runs after an `await`, so it can never beat the `set` below
          // to the map.
          inFlightRef.current.delete(key);
        }
      })();

      inFlightRef.current.set(key, attempt);
      return attempt;
    },
    [fallbackMessage],
  );

  return { run, pending: pendingCount > 0, error };
}
