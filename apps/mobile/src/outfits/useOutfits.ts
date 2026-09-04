import { useCallback, useEffect, useRef, useState } from 'react';
import type { PublicOutfit } from '@wardrobe/shared';
import { ApiClientError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { deleteOutfit, fetchOutfits } from './api';

/**
 * What is in flight *right now*. Deliberately orthogonal to `error`, which
 * says what happened *last*.
 *
 * This is Stage 4's `WardrobeActivity` contract carried forward unchanged, and
 * it is not re-derived here. An earlier draft of that hook folded the two into
 * one `status` union (`loading | ready | error | refreshing`) and it conflated
 * them: after a page-2 failure, calling `loadMore()` again really does issue
 * the request, but a combined status stays on `error` until that request
 * settles — so a retry button has no way to show that the retry started. Two
 * axes cost one field and remove the whole class of problem.
 *
 * - `idle`        — nothing in flight. Says nothing about success; read
 *                   `error` for that.
 * - `loading`     — a full-list load with nothing renderable behind it: first
 *                   mount, or a token change (both clear `outfits`).
 * - `refreshing`  — pull-to-refresh; the previous rows are still on screen.
 * - `loadingMore` — a page append; the rows already loaded stay valid.
 *
 * A delete is deliberately NOT one of these values: it is not a list load, and
 * a gallery must not spin its whole list because one row is being removed.
 * `remove` reports through its own resolved value (a usable per-row pending
 * signal on its own) and through `error`.
 */
export type OutfitsActivity = 'idle' | 'loading' | 'refreshing' | 'loadingMore';

/**
 * Which operation an error describes. Internal — `error` is exposed as a bare
 * string, because a screen renders a message and not a taxonomy.
 *
 * It exists because list loads and deletes are independent operations sharing
 * one channel, and "clear the error when a new request starts" is only correct
 * *within* an operation. Without the tag, two things went wrong in opposite
 * directions: an `onEndReached` fired by an idle scroll silently wiped a failed
 * delete's message, and a successful delete wiped a genuine "couldn't load
 * page 2" message while the list was still short. Both statements were still
 * true when they were erased.
 */
type ErrorSource = 'list' | 'delete';

interface ErrorState {
  source: ErrorSource;
  message: string;
}

export interface UseOutfitsResult {
  outfits: PublicOutfit[];
  activity: OutfitsActivity;
  /**
   * A ready-to-render message for the last operation that failed — a list load
   * or a delete — or `null`. A failure is only cleared by an operation of the
   * same kind, so a scroll cannot erase a delete's message and a delete cannot
   * erase a load's.
   */
  error: string | null;
  /** Safe to pass straight to `FlatList#onEndReached`; see the guard below. */
  loadMore: () => void;
  /** Safe to pass straight to `RefreshControl#onRefresh`. */
  refresh: () => void;
  hasMore: boolean;
  /**
   * Delete one outfit, dropping it from the list only once the server has
   * confirmed. Resolves `true` when the outfit is gone and `false` when it is
   * not — in which case the row is untouched and `error` carries the message.
   *
   * A 404 resolves `true`: the outfit is already gone server-side, which is
   * what the caller asked for, so the row drops and no error is raised. That
   * distinction matters — collapsing every failure to `false` leaves a row
   * that can never be deleted, because the one answer meaning "it is not
   * there" is treated as "it is still there".
   *
   * It resolves rather than rejects on failure, deliberately: a screen that
   * writes `onPress={() => remove(id)}` cannot then produce an unhandled
   * rejection, and one that wants to navigate away only on success can
   * `await` it.
   */
  remove: (id: string) => Promise<boolean>;
}

function messageFor(err: unknown, fallback: string): string {
  // ApiClientError messages are already written for a person to read (the
  // client turns a network failure into "Cannot reach the server…" and passes
  // the API's own message through otherwise).
  if (err instanceof ApiClientError) return err.message;
  return fallback;
}

/** A 404 from `DELETE`/`PATCH` means the outfit is not there — deleted from
 *  another device, or never the caller's to begin with (a foreign resource
 *  answers 404, not 403). Either way it is gone. */
function isAlreadyGone(err: unknown): boolean {
  return err instanceof ApiClientError && err.status === 404;
}

/**
 * Drop anything deleted this session from a list the server just sent.
 *
 * The server computes a page *before* a concurrent delete commits, so a
 * response already in flight can carry a row the user has removed — and a
 * pagination shift can re-serve one on a later page. Neither is a stale
 * *response* (the request-sequence guard is about ordering and would let both
 * through, correctly), so the filter has to be here, on every list write.
 *
 * Left unfiltered the row simply comes back and stays, and nothing in the app
 * will take it away again. `app/(tabs)/favorites.tsx` does now refetch on
 * focus (it did not when this comment was first written, and the claim that
 * nothing in `app/` ever did is no longer true) — but it refetches only when
 * `consumeOutfitsDirty()` says the list has changed, and a delete made through
 * THIS hook's `remove` does not set that flag: `remove` already drops the row
 * itself, so there is nothing for the gallery to be told. So a phantom
 * re-served by a response that predates the delete survives until the user
 * happens to pull to refresh. Tapping delete on it then answers 404 and paints
 * "Outfit not found" over a delete that in fact succeeded — the exact failure
 * `pendingDeletesRef` exists to prevent, walking back in through a different
 * door.
 */
function withoutDeleted(list: PublicOutfit[], deleted: Set<string>): PublicOutfit[] {
  return list.filter((outfit) => !deleted.has(outfit.id));
}

/**
 * The outfit gallery's data source (FR5 / TC-07).
 *
 * The list machinery is Stage 4's `useWardrobe`, minus the category axis and
 * plus a delete. The races it handles are the same ones, and they are handled
 * here rather than in the screen because none of them is visible until the
 * network is slow:
 *
 * 1. **Stale responses.** A page append and a pull-to-refresh can be in flight
 *    together and answer out of order. Every request carries a monotonic
 *    sequence number and only the newest may write state. A *value*
 *    comparison — "is this response for the cursor I currently hold?" — is not
 *    enough: it admits an A → B → A race, where a refresh hands back the same
 *    `nextCursor` the superseded append was already paging on, so the two
 *    requests cannot be told apart by their arguments at all.
 * 2. **Overlapping pages.** `onEndReached` fires many times through one fling.
 *    `loadMore` is a no-op while anything at all is in flight.
 * 3. **Duplicated refreshes.** Double-tapping "Try again" on a slow network
 *    would otherwise issue two identical page-one requests. `refresh` is a
 *    no-op while another full-list load is running — but it deliberately
 *    still *supersedes* a background page append, because a pull-to-refresh
 *    is an explicit gesture and silently dropping it is worse than one extra
 *    round trip.
 * 4. **Partial state on failure.** An error keeps `outfits` and the cursor, so
 *    the user keeps what they had and `onEndReached` can retry.
 * 5. **Double-tapped deletes.** `DELETE /outfits/:id` is not
 *    idempotent-silent, so a second delete of the same id answers 404 — which
 *    would paint "Outfit not found" over a delete that in fact succeeded.
 * 6. **A response that predates a delete.** See `withoutDeleted`: the request
 *    ordering is legitimate, so only a record of what was deleted can keep the
 *    row off the screen.
 *
 * The screen is only reachable when authenticated (`app/_layout.tsx` redirects
 * anonymous users and renders a splash while restoring), so the token is
 * present by the time this mounts; no guard for a null token is needed and a
 * 401 would surface through `error` anyway.
 */
export function useOutfits(): UseOutfitsResult {
  const { token } = useAuth();

  const [outfits, setOutfits] = useState<PublicOutfit[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [activity, setActivity] = useState<OutfitsActivity>('loading');
  const [errorState, setErrorState] = useState<ErrorState | null>(null);

  // Refs, not state: both are read and written inside one synchronous burst
  // (`onEndReached` firing three times before React can re-render), where a
  // state value would still be the stale one from the last commit. That is
  // exactly the case the guards exist for, so they cannot be built on state.
  const requestIdRef = useRef(0);
  const inFlightRef = useRef<OutfitsActivity>('idle');

  // Keyed by outfit id, not a single flag: two different rows may be deleted
  // at once, and only a repeat of the *same* id is the duplicate this guards.
  // The stored promise is handed back to the second caller so both observe the
  // same outcome rather than the second being told the delete failed.
  const pendingDeletesRef = useRef(new Map<string, Promise<boolean>>());

  // Everything deleted this session. Bounded by deletes the user actually
  // performs — a few per session, not a cache — and read on every list write.
  const deletedIdsRef = useRef(new Set<string>());

  // Only an operation of the same kind may clear an error, so a scroll cannot
  // erase a failed delete's message and a delete cannot erase a failed load's.
  // Stable across renders: `run` depends on it, and the mount effect depends
  // on `run`, so an unstable identity here would re-fetch on every render.
  const clearError = useCallback((source: ErrorSource) => {
    setErrorState((prev) => (prev?.source === source ? null : prev));
  }, []);

  const run = useCallback(
    async (kind: Exclude<OutfitsActivity, 'idle'>, mode: 'replace' | 'append', cursor?: string) => {
      const requestId = ++requestIdRef.current;
      inFlightRef.current = kind;
      setActivity(kind);
      // A new request makes the previous *load* failure history, not current
      // state. Without this a banner keyed on `error !== null` sits under the
      // refresh spinner still showing the message the refresh is trying to
      // clear.
      clearError('list');

      try {
        const page = await fetchOutfits({
          token,
          // Omitted, never sent empty: `?cursor=` is a 400, not "page one".
          ...(cursor === undefined ? {} : { cursor }),
        });

        // Superseded while we were waiting. Dropping the outfits is not enough
        // — the cursor has to go too, or the next `loadMore` pages the list
        // the user has already been moved off.
        if (requestIdRef.current !== requestId) return;

        setOutfits((prev) =>
          // Filtered on BOTH paths: a refresh can restore a deleted row and an
          // append can re-serve one after a pagination shift.
          withoutDeleted(
            mode === 'append' ? [...prev, ...page.outfits] : page.outfits,
            deletedIdsRef.current,
          ),
        );
        setNextCursor(page.nextCursor);
        setActivity('idle');
      } catch (err) {
        // The same guard on the catch path, which is the half that gets
        // forgotten because it is written after the success path already
        // works. Without it a request the user has moved on from paints an
        // error over a list that loaded fine.
        if (requestIdRef.current !== requestId) return;
        // `outfits` and `nextCursor` are deliberately untouched.
        setErrorState({
          source: 'list',
          message: messageFor(err, 'Something went wrong loading your outfits.'),
        });
        setActivity('idle');
      } finally {
        // Only the newest request owns the flag; a superseded one clearing it
        // would re-open `loadMore` while its replacement is still running.
        if (requestIdRef.current === requestId) inFlightRef.current = 'idle';
      }
    },
    [token, clearError],
  );

  // Mount and token change mean the same thing: the list on screen no longer
  // matches what was asked for.
  useEffect(() => {
    setOutfits([]);
    setNextCursor(undefined);
    void run('loading', 'replace');
  }, [run]);

  const loadMore = useCallback(() => {
    if (inFlightRef.current !== 'idle') return;
    // `!= null`, not `!== undefined`: nothing between here and the socket
    // validates the response shape (`apiRequest` ends in `return parsed as T`),
    // so a server that ever sent `nextCursor: null` would leave paging
    // permanently "on" and send `?cursor=null` — which the API rejects — on
    // every onEndReached. The declared type says that cannot happen; this
    // costs one character and does not rely on the declaration being true.
    if (nextCursor == null) return;
    void run('loadingMore', 'append', nextCursor);
  }, [run, nextCursor]);

  const refresh = useCallback(() => {
    // Another full-list load is already fetching exactly this; a second one is
    // pure duplicate work. A background `loadingMore` is not, and gets
    // superseded — see race 3 above.
    if (inFlightRef.current === 'loading' || inFlightRef.current === 'refreshing') return;
    // Page one, replacing the list on success. The rows stay on screen
    // meanwhile — a refresh is not a reset.
    void run('refreshing', 'replace');
  }, [run]);

  // Record the deletion first, then drop the row. The record is what keeps a
  // response that predates the delete from putting it back; the filter here is
  // what takes it off the screen now.
  const forget = useCallback((id: string) => {
    deletedIdsRef.current.add(id);
    setOutfits((prev) => prev.filter((outfit) => outfit.id !== id));
  }, []);

  const remove = useCallback(
    (id: string): Promise<boolean> => {
      const pending = pendingDeletesRef.current.get(id);
      if (pending) return pending;

      const attempt = (async () => {
        // A previous *delete* failure is history once a new one starts. A load
        // failure is not: the page it failed to fetch is still missing.
        clearError('delete');
        try {
          await deleteOutfit(id, token);
          // Only now. Dropping the row first would make a failed delete look
          // like a success until the next refresh silently brought the outfit
          // back, with nothing to explain it — and Phase 3 §5 claims delete
          // works, so it has to actually be gone before it leaves the screen.
          //
          // Deliberately NOT guarded by the request sequence: the delete is a
          // fact about the server, not a view of it. Bumping the sequence here
          // would be worse than useless — it would discard an in-flight page
          // load *and* latch `inFlightRef`, closing `loadMore` for the rest of
          // the session.
          forget(id);
          return true;
        } catch (err) {
          // Already gone is the outcome the caller wanted, not a failure.
          // Treating it as one leaves a row that can never be deleted: every
          // retry answers 404, and 404 is the one answer that means it is not
          // there.
          if (isAlreadyGone(err)) {
            forget(id);
            return true;
          }
          setErrorState({
            source: 'delete',
            message: messageFor(err, 'Something went wrong deleting that outfit.'),
          });
          return false;
        } finally {
          // Per in-flight request, not per id forever: a delete that failed
          // has to be retryable. This runs after an `await`, so it can never
          // beat the `set` below to the map.
          pendingDeletesRef.current.delete(id);
        }
      })();

      pendingDeletesRef.current.set(id, attempt);
      return attempt;
    },
    [token, clearError, forget],
  );

  return {
    outfits,
    activity,
    error: errorState?.message ?? null,
    loadMore,
    refresh,
    hasMore: nextCursor != null,
    remove,
  };
}
