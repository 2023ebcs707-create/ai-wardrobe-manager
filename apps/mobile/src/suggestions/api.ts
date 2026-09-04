import type { PublicSuggestions, Season } from '@wardrobe/shared';
import { ApiClientError, apiRequest } from '../api/client';

export interface FetchSuggestionsOptions {
  token: string | null;
  /**
   * The shared union, never re-declared as string literals here. `GET
   * /suggestions` validates against `SEASONS` — the same array that guards
   * `ClothingItem.seasons` and that the engine's own `SEASONS` mirrors — and a
   * season this client could send that the route rejects would be a 400
   * nothing in the type system had a chance to catch.
   *
   * Omitted entirely when absent — see `buildSuggestionsQuery`.
   */
  season?: Season;
  /**
   * 1..64 characters. **The API accepts this and does not act on it**, and
   * says so by echoing `ignored: ['occasion']` in the response body; no item
   * in this system carries occasion data, so no ranking rule can read it.
   *
   * A caller that sends one is therefore taking on the obligation to surface
   * that disclosure. `useSuggestions` does not send one, which is why its
   * snapshot does not carry `ignored` — see the note there before wiring this
   * parameter to a screen.
   */
  occasion?: string;
  /**
   * 1..`MAX_SUGGESTION_LIMIT`. Omitted to take the server's
   * `DEFAULT_SUGGESTION_LIMIT` of 5.
   *
   * Deliberately NOT the list endpoints' bounds: a suggestion list is a
   * shortlist the user reads, not a page they scroll, and the ceiling is
   * shared with the AI service's own limit — a larger one is a 422 there,
   * which this API can only report as a 503.
   */
  limit?: number;
}

/**
 * Builds the `GET /suggestions` query string.
 *
 * Every parameter is *omitted* when it is absent rather than sent empty. The
 * API deliberately never coerces an empty value to a default: `?limit=` fails
 * `parseLimit`'s digits check, `?season=` is not one of `SEASONS`, and
 * `?occasion=` fails its 1..64 length check — so all three answer 400.
 * Interpolating `` `?season=${season ?? ''}` `` would therefore break the
 * unfiltered request, which is the only one `useSuggestions` ever makes.
 *
 * `URLSearchParams` also does the percent-encoding, which matters for
 * `occasion`: it is free text a user could type a space or an ampersand into.
 */
function buildSuggestionsQuery(opts: FetchSuggestionsOptions): string {
  const params = new URLSearchParams();
  if (opts.season !== undefined) params.set('season', opts.season);
  if (opts.occasion !== undefined) params.set('occasion', opts.occasion);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));

  const query = params.toString();
  return query ? `?${query}` : '';
}

/**
 * FR8/TC-10: the outfits the rule engine proposes for the signed-in user.
 *
 * Answered as a bare body rather than wrapped in an envelope — there is no
 * `{ suggestions }` key to reach *through*; `suggestions` IS a top-level field
 * beside `excludedInLaundry` — and it carries NO cursor. It is a snapshot, not
 * a page: the engine ranks combinations and returns a shortlist bounded by
 * `?limit=`, so there is nothing to page on and no `nextCursor` to read.
 *
 * Nothing is written. A suggestion becomes an outfit only when the user saves
 * one through `POST /outfits` — and the ids to post are the ones that were
 * DISPLAYED, which is what `DisplaySuggestion.saveItemIds` exists to hand over.
 *
 * ## This function does not have an "empty" failure mode, and must not grow one
 *
 * When the engine is unreachable, 500s, 422s, answers non-JSON, or simply
 * never replies, `GET /suggestions` answers **503 `AI_UNAVAILABLE` with no
 * `suggestions` key at all** — deliberately, so that "the engine is down" and
 * "your wardrobe produced nothing" stay distinguishable. `apiRequest` turns
 * that into a thrown `ApiClientError`, and this function lets it through.
 *
 * Catching it here and returning `{ suggestions: [] }` would erase the exact
 * distinction the whole server-side design exists to preserve, and the screen
 * would tell a user with a full wardrobe that none of it goes together.
 */
export async function fetchSuggestions(
  opts: FetchSuggestionsOptions,
): Promise<PublicSuggestions> {
  return apiRequest<PublicSuggestions>(`/suggestions${buildSuggestionsQuery(opts)}`, {
    token: opts.token,
  });
}

/**
 * Is this failure "the suggestion engine is down" rather than "the request was
 * wrong"?
 *
 * Keyed off the STATUS as well as the code. The two are NOT independently
 * load-bearing today, and saying so is the honest version:
 *
 * - `AI_UNAVAILABLE` is the code `GET /suggestions` sends, and today it is
 *   ALWAYS sent with a 503 (`apps/api/src/ai/suggestClient.ts` constructs it
 *   in exactly one place). So no input the real API can produce distinguishes
 *   this clause from the next one, and deleting it changes nothing that runs.
 *   It is kept as forward defence for the day the route answers `AI_UNAVAILABLE`
 *   with some other status — a 502 from a gateway rewrite, a 504 on the
 *   timeout path — and the test below pins that intent by constructing exactly
 *   that pairing, which is the only way this branch can be made to matter.
 * - A bare 503 with no error envelope never reaches this app's own route
 *   handler — it is what a proxy, a load balancer or a cold container answers
 *   with — and `apiRequest` reports that as `'UNKNOWN'` with `status: 503`.
 *   That is the same outage from the user's point of view, and calling it a
 *   generic error would put a wrong message on the screen.
 *
 * A 401, a 400 for an unknown season, and a network failure are all `false`:
 * they are not outages of the engine, they are conditions with their own
 * messages, and none of them justifies "suggestions are temporarily
 * unavailable" copy.
 */
export function isSuggestionsUnavailable(err: unknown): boolean {
  if (!(err instanceof ApiClientError)) return false;
  return err.code === 'AI_UNAVAILABLE' || err.status === 503;
}
