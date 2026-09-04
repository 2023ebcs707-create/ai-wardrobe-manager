import { useCallback, useEffect, useRef, useState } from 'react';
import type { PublicClothingItem, PublicSuggestion } from '@wardrobe/shared';
import { ApiClientError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { countLabel } from '../format/text';
import { fetchSuggestions, isSuggestionsUnavailable } from './api';

/**
 * The same two-axis contract the list hooks use, with `loadingMore` REMOVED
 * rather than carried along unused — the narrowing `useUsageAnalytics` made
 * for the same reason.
 *
 * `GET /suggestions` is a snapshot, not a page: the engine ranks combinations
 * and answers a shortlist bounded by `?limit=`, with no cursor in the response
 * to page on. A `loadingMore` value here would be a state nothing can ever
 * produce, and it would invite a screen to wire an `onEndReached` to a
 * `loadMore` that does not exist. Narrowing the union is a subtype of the list
 * hooks' one, so a screen that renders both can still key on a single type.
 */
export type SuggestionsActivity = 'idle' | 'loading' | 'refreshing';

/**
 * One proposed outfit, in the shape a card renders and saves.
 *
 * ## `PublicSuggestion.itemIds` is deliberately not here
 *
 * The wire type carries two arrays and **they are not parallel**: `items` is
 * compacted (an id the wardrobe no longer resolves is dropped from `items`
 * while `itemIds` keeps it), so `items` can be SHORTER and `items[i]` is not
 * `itemIds[i]`. A shipped API integration test asserts exactly that
 * divergence — `itemIds` length 5, `items` length 2.
 *
 * Two bugs follow from having both within reach, and both are silent:
 *
 * 1. Pairing them by index renders the wrong garment under the wrong id, from
 *    the first gap onwards.
 * 2. Posting `itemIds` to `POST /outfits` saves the outfit the ENGINE
 *    proposed, which — when `items` is shorter — is **not the outfit the user
 *    was shown**. Saving something the user never saw is the worse failure of
 *    the two, because it persists.
 *
 * A comment saying "render from `items`" is not a control; not handing over
 * the other array is. So this type carries the resolved items and one derived
 * id list taken FROM those items, and nothing that can be indexed against
 * them. Every id a screen needs is on `item.id`.
 */
export interface DisplaySuggestion {
  /**
   * The garments to render, in the engine's order — top, bottom, shoes — with
   * ObjectId hex canonicalised by the API. Trust the order; it is the outfit.
   *
   * The same `PublicClothingItem` the wardrobe grid and the outfit detail
   * screen already draw, so no new renderer is needed.
   */
  items: PublicClothingItem[];
  /**
   * **The exact payload for `POST /outfits`**, and the only id list this
   * module exposes.
   *
   * Derived from `items`, so it is by construction the set that was
   * DISPLAYED. That is the whole point: when the engine names an id the
   * wardrobe no longer resolves, the proposed outfit and the shown outfit
   * differ, and the one worth persisting is the one the user actually looked
   * at and chose.
   *
   * Pass it straight to `createOutfit({ itemIds })`. Do not sort it, do not
   * de-duplicate it, and do not rebuild it from anywhere else.
   */
  saveItemIds: string[];
  /** 0..1, rounded by the engine. Higher is a stronger colour match. */
  score: number;
  /**
   * Plain-language names of the rules that fired, e.g. "navy shirt and beige
   * trousers — top with bottom, neutral pairing". Rendered as-is: a suggestion
   * that cannot say why it was made is indistinguishable from a random pair of
   * garments, which is exactly what TC-10 claims it is not.
   */
  rationale: string;
}

/**
 * One whole answer from `GET /suggestions`.
 *
 * Grouped into one object rather than spread across sibling fields on the hook
 * so that the shortlist and the sentence beside it can never come from two
 * different requests: they are replaced together or not at all.
 *
 * ## `ignored` is deliberately dropped
 *
 * The wire body may carry `ignored: ['occasion']`, and it does so **only when
 * the caller sent an `occasion`**. This hook never sends one, so the field is
 * structurally unreachable here and surfacing it would be a control with
 * nothing behind it — a screen keying on it would render a disclosure that can
 * never fire. `fetchSuggestions` returns the body verbatim, so nothing is lost
 * at the transport layer.
 *
 * WHOEVER ADDS AN OCCASION FILTER TO THIS HOOK MUST CARRY `ignored` THROUGH IN
 * THE SAME CHANGE. Accepting an `occasion` and saying nothing leaves a user who
 * chose "formal" unable to learn that nothing in the ranking was affected by
 * it — the API and the AI service both disclose that fact at their own layer
 * precisely so a client can pass it on.
 */
export interface SuggestionsSnapshot {
  /**
   * The shortlist. `[]` is a real, successful answer meaning "the engine had
   * nothing to propose from this wardrobe" — it is NOT what an outage looks
   * like. An outage leaves the snapshot alone and raises `unavailable`.
   */
  suggestions: DisplaySuggestion[];
  /**
   * A ready-to-render sentence about the wardrobe's laundry, or `null` when
   * nothing is in the wash.
   *
   * Read `laundryNoticeFor` before touching this. The wording is a
   * constraint, not a default: the count behind it is every in-laundry item in
   * the wardrobe, NOT a number of suggestions that were withheld, and the two
   * are observably different.
   */
  laundryNotice: string | null;
}

export interface UseSuggestionsResult {
  /**
   * `null` until the first load lands, and `null` again after a token change.
   *
   * Deliberately not an empty snapshot: "not loaded yet" and "loaded, and this
   * wardrobe produced no suggestions" are different screens, and only the API
   * can say which one the user is looking at.
   *
   * A failed request leaves the last good snapshot in place, so a stale
   * shortlist sits beside the banner rather than a blank screen. The
   * suggestions were true a moment ago.
   */
  snapshot: SuggestionsSnapshot | null;
  /**
   * The last request failed *because the suggestion engine is down* — a 503,
   * as opposed to any other failure.
   *
   * ## Why this is a separate bit and not an empty list
   *
   * `GET /suggestions` answers 503 with **no `suggestions` key at all** when
   * the engine is unreachable, 500s, 422s, answers non-JSON, or never replies.
   * That is the entire reason it does not answer `[]`: "the engine is down"
   * and "your wardrobe produced nothing" need different screens — one says
   * "try again shortly", the other says "add more items" — and a client that
   * collapsed them would tell a user with a full wardrobe that none of it goes
   * together.
   *
   * ## Its relationship to `error`
   *
   * A REFINEMENT of `error`, never independent of it: `unavailable` is true
   * only when `error` is non-null, and it is cleared the moment a new request
   * starts. A screen with no special copy for an outage can ignore this field
   * entirely and render `error`, which already carries the API's own
   * user-readable sentence.
   */
  unavailable: boolean;
  activity: SuggestionsActivity;
  /** A ready-to-render message, or `null` if the last request succeeded. */
  error: string | null;
  /** Safe to pass straight to `RefreshControl#onRefresh`. */
  refresh: () => void;
}

/**
 * `excludedInLaundry` → the one sentence this app is allowed to build from it.
 *
 * ## The wording is the contract
 *
 * The count is **every in-laundry item in the caller's wardrobe**, not "how
 * many suggestions were withheld". Those are different numbers and the
 * difference is observable: a wardrobe of one shirt plus three in-laundry
 * accessories answers `suggestions: []` with `excludedInLaundry: 3`, and not
 * one of those three could have produced a suggestion — there was no bottom to
 * pair with. The list is empty because the wardrobe is thin, and the laundry
 * is a coincidence.
 *
 * So the sentence states a FACT ABOUT THE WARDROBE and asserts no causation.
 * "3 suggestions were hidden", "3 outfits unavailable", "3 items were left
 * out of these suggestions" are all forbidden: each claims a link to the
 * result that this number does not carry, and each is a sentence a user would
 * act on by fetching laundry that would not have changed anything.
 *
 * ## Why the raw count is not exposed alongside it
 *
 * For the same reason `DisplaySuggestion` does not expose `itemIds`: handing
 * over the number next to the sanctioned sentence leaves the wrong sentence
 * one template literal away, and "a note telling the next task not to" is not
 * a control. The number's only sanctioned use IS this sentence. A screen that
 * genuinely needs the integer should widen the snapshot deliberately and carry
 * this constraint with it.
 *
 * `null` at zero, so a caller renders nothing rather than "0 items are in the
 * laundry" — which reads as a warning about a wardrobe that has none.
 * Pluralised through `countLabel`, the pluraliser the rest of the app uses.
 *
 * ## Why a `number` parameter is still checked at runtime
 *
 * `apiRequest` ends in `parsed as T`, so the type is an assertion about the
 * wire, not a guarantee from it. `undefined <= 0` and `NaN <= 0` are both
 * `false`, so without this guard a missing or non-numeric key renders
 * "undefined items are in the laundry" — user-visible garbage in the one
 * string this module exists to constrain, and it fails SILENTLY rather than
 * throwing the way a malformed `items` would. `useWardrobe` applies the same
 * one-line defence to `nextCursor` for the same reason. Not reachable through
 * the real route, which builds the field as a literal; kept because "not
 * reachable today" is a statement about today's server.
 */
export function laundryNoticeFor(excludedInLaundry: number): string | null {
  if (typeof excludedInLaundry !== 'number' || !Number.isFinite(excludedInLaundry)) return null;
  if (excludedInLaundry <= 0) return null;
  return `${countLabel(excludedInLaundry)} ${excludedInLaundry === 1 ? 'is' : 'are'} in the laundry`;
}

/**
 * The wire suggestion → the card's suggestion.
 *
 * The one line that matters is `saveItemIds`: it is read off `items`, the
 * array that was displayed, and never off `itemIds`, the array the engine
 * proposed. See `DisplaySuggestion` for why those can differ and why only one
 * of them may be persisted.
 */
function toDisplaySuggestion(raw: PublicSuggestion): DisplaySuggestion {
  return {
    items: raw.items,
    saveItemIds: raw.items.map((item) => item.id),
    score: raw.score,
    rationale: raw.rationale,
  };
}

function messageFor(err: unknown): string {
  // ApiClientError messages are already written for a person to read (the
  // client turns a network failure into "Cannot reach the server…" and passes
  // the API's own message through otherwise — including the 503's "Outfit
  // suggestions are temporarily unavailable").
  if (err instanceof ApiClientError) return err.message;
  return 'Something went wrong loading your suggestions.';
}

/**
 * The suggestions screen's data source (FR8 / TC-10).
 *
 * There is NO `loadMore` and no cursor, and that is a property of the endpoint
 * rather than an omission: `GET /suggestions` answers a shortlist with no
 * `nextCursor`, so paging would be a control with nothing behind it.
 * `useSuggestions.test.ts` asserts the absence directly, because "we chose not
 * to add paging" and "we forgot to add paging" look identical in a diff a year
 * later.
 *
 * No `season`, `occasion` or `limit` is sent either. Each is omitted from the
 * query ENTIRELY rather than sent empty — `?season=` is a 400, not "any
 * season" — which is what `buildSuggestionsQuery` exists to guarantee.
 *
 * The three guards that DO apply:
 *
 * 1. **Stale responses.** A refresh cannot overlap another refresh (guard 2),
 *    but a token change can supersede one in flight — and the loser must not
 *    write one user's wardrobe over another's. A monotonic sequence number,
 *    not a value comparison: these requests carry no arguments that could tell
 *    them apart, and even if they did, signing out of A into B and back into A
 *    leaves the first A response indistinguishable from the third by VALUE
 *    while being three requests old. Only ordering separates them, and
 *    `useSuggestions.test.ts` writes that A → B → A sequence out explicitly.
 *    The guard covers the catch path as well as the success path — two
 *    mechanisms, two tests, because the catch half is the one written after
 *    the success path already works.
 * 2. **Duplicated refreshes.** Double-tapping "Try again" would otherwise
 *    issue two identical requests — each of which runs the whole wardrobe
 *    through the engine and signs a URL per returned item server-side.
 * 3. **Partial state on failure.** An error keeps the last good snapshot.
 *
 * The screen is only reachable when authenticated (`app/_layout.tsx` redirects
 * anonymous users and renders a splash while restoring), so the token is
 * present by the time this mounts; no guard for a null token is needed and a
 * 401 would surface through `error` anyway.
 */
export function useSuggestions(): UseSuggestionsResult {
  const { token } = useAuth();

  const [snapshot, setSnapshot] = useState<SuggestionsSnapshot | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [activity, setActivity] = useState<SuggestionsActivity>('loading');
  const [error, setError] = useState<string | null>(null);

  // Refs, not state, for the reason the other hooks give: both are read and
  // written inside one synchronous burst, where a state value would still be
  // the stale one from the last commit.
  const requestIdRef = useRef(0);
  const inFlightRef = useRef<SuggestionsActivity>('idle');

  const run = useCallback(
    async (kind: Exclude<SuggestionsActivity, 'idle'>) => {
      const requestId = ++requestIdRef.current;
      inFlightRef.current = kind;
      setActivity(kind);
      // A new request makes the previous failure history, not current state.
      // Without this a banner keyed on `error !== null` sits under the refresh
      // spinner still showing the message the refresh is trying to clear —
      // and, worse for this screen, "suggestions are unavailable" copy stays
      // up while the retry that might disprove it is in flight.
      setError(null);
      setUnavailable(false);

      try {
        // No `season`, `occasion` or `limit` key at all: each is omitted
        // rather than sent empty, because `?season=`/`?occasion=`/`?limit=`
        // are 400s rather than the server's defaults.
        const body = await fetchSuggestions({ token });

        // Superseded while we were waiting — most likely by a token change.
        if (requestIdRef.current !== requestId) return;

        setSnapshot({
          suggestions: body.suggestions.map(toDisplaySuggestion),
          laundryNotice: laundryNoticeFor(body.excludedInLaundry),
        });
        setActivity('idle');
      } catch (err) {
        // The same guard on the catch path, which is the half that gets
        // forgotten because it is written after the success path already
        // works.
        if (requestIdRef.current !== requestId) return;
        // `snapshot` is deliberately untouched: the last good shortlist stays
        // on screen beside the error.
        //
        // A 503 is NOT turned into an empty list here, and nothing downstream
        // may do it either. The API withholds the `suggestions` key entirely
        // on an outage so that this exact substitution is impossible to make
        // by accident; making it deliberately would tell a user with a full
        // wardrobe that none of it goes together.
        setUnavailable(isSuggestionsUnavailable(err));
        setError(messageFor(err));
        setActivity('idle');
      } finally {
        if (requestIdRef.current === requestId) inFlightRef.current = 'idle';
      }
    },
    [token],
  );

  // Mount and token change mean the same thing: the shortlist on screen is not
  // this user's.
  useEffect(() => {
    setSnapshot(null);
    void run('loading');
  }, [run]);

  const refresh = useCallback(() => {
    // Anything at all in flight is already fetching exactly this — there is
    // only one kind of request here, so unlike the list hooks there is no
    // background append for a refresh to legitimately supersede.
    if (inFlightRef.current !== 'idle') return;
    // The previous shortlist stays on screen meanwhile — a refresh is not a
    // reset.
    void run('refreshing');
  }, [run]);

  return { snapshot, unavailable, activity, error, refresh };
}
