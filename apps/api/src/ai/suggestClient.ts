import type { ItemCategory, ItemColor, Season } from '@wardrobe/shared';
import type { Config } from '../config';
import { ApiError } from '../http/errors';

/**
 * How long to wait for the AI service's `/suggest`.
 *
 * `POST /suggest` is pure arithmetic over the body it was just handed — it
 * loads no model and touches no network (see `services/ai/app/suggest.py`) —
 * so this is generous by an order of magnitude on purpose: it is a
 * hang-breaker, not a latency budget. A quarter of `TAG_TIMEOUT_MS`, which
 * fronts real inference.
 *
 * PINNED, and asserted directly by a test, because the slow-path test proves
 * only that *a* timeout fires. Stage 9 owns the "AI suggestion 1-2s" number
 * and will change this deliberately; that is a different thing from it
 * drifting.
 */
export const SUGGEST_TIMEOUT_MS = 5_000;

/** One wardrobe item in the shape `POST /suggest` accepts. */
export interface SuggestEngineItem {
  id: string;
  category: ItemCategory;
  /**
   * `colours`, with a u — the Python service's spelling. Mongo stores
   * `colors`. The rename happens in the route that builds these, and it is
   * load-bearing: an item whose colours never arrive is not an error
   * anywhere, it is an item the only ranking rule family has nothing to say
   * about.
   */
  colours: ItemColor[];
  seasons: Season[];
  /**
   * Deliberately no `laundryStatus`. The engine's request shape has no such
   * field and `suggest.py` documents its absence rather than ignoring it
   * silently, so this type cannot express the thought that the engine might
   * do the filtering. It does not; the caller does, before it gets here.
   */
}

export interface EngineSuggestion {
  itemIds: string[];
  score: number;
  rationale: string;
}

export interface EngineResult {
  suggestions: EngineSuggestion[];
  /** Parameters the engine accepted and did not act on, e.g. `occasion`. */
  ignored?: string[];
}

export interface SuggestOptions {
  season?: Season;
  occasion?: string;
  limit: number;
}

/**
 * The one failure this client produces, as the response the client will get.
 *
 * Built here rather than in the route so that "what counts as unavailable" is
 * decided in exactly one place, and so no route can accidentally catch it and
 * substitute an empty list.
 */
function unavailable(): ApiError {
  return new ApiError(
    503,
    'AI_UNAVAILABLE',
    'Outfit suggestions are temporarily unavailable',
  );
}

function invalidSuggestionReason(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null) return 'a suggestion is not an object';
  const { itemIds, score, rationale } = entry as Record<string, unknown>;
  if (!Array.isArray(itemIds)) return 'a suggestion\'s itemIds is not an array';
  if (itemIds.length === 0) return 'a suggestion has no items';
  if (!itemIds.every((id) => typeof id === 'string')) return 'a suggestion has a non-string itemId';
  if (typeof score !== 'number' || !Number.isFinite(score)) return 'a suggestion\'s score is not a number';
  if (score < 0 || score > 1) return 'a suggestion\'s score is outside [0,1]';
  if (typeof rationale !== 'string') return 'a suggestion\'s rationale is not a string';
  return null;
}

/**
 * Returns null when `body` is a well-formed engine result, otherwise a short
 * human-readable reason — used both to decide validity and to say what
 * specifically was wrong when logging a rejected response.
 *
 * A malformed entry rejects the WHOLE response rather than being filtered
 * out, for the reason `tagClient` gives: a partially-correct list is a drift
 * signal between two services, not something to silently repair.
 */
function invalidResultReason(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return 'response body is not an object';
  const { suggestions, ignored } = body as Record<string, unknown>;
  if (!Array.isArray(suggestions)) return 'suggestions is not an array';
  for (const entry of suggestions) {
    const reason = invalidSuggestionReason(entry);
    if (reason) return reason;
  }
  if (ignored !== undefined) {
    if (!Array.isArray(ignored) || !ignored.every((name) => typeof name === 'string')) {
      return 'ignored is not an array of strings';
    }
  }
  return null;
}

/**
 * Ask the rule engine to rank the outfits this wardrobe can form.
 *
 * THROWS on every failure. That is the deliberate opposite of `tagImage`,
 * which returns null so an upload can proceed: tagging is best-effort and
 * storing the item untagged is a real fallback, whereas a failed suggestion
 * request has nothing to fall back to. The only two things a client can say
 * are "suggestions are unavailable" and "you have no suggestions", and those
 * are different sentences of which exactly one is true. Returning an empty
 * list here would make the client say the false one, silently, with nothing
 * anywhere to notice.
 *
 * Every failure mode — unreachable, slow, 500, 422, malformed — becomes one
 * `503 AI_UNAVAILABLE`, and every one of them logs first. A 422 is really
 * THIS API's bug rather than an outage (it means the body broke the engine's
 * own validation), but the client's two available sentences are the same
 * either way; the status in the log is what tells an operator which happened.
 *
 * IN-LAUNDRY FILTERING IS NOT DONE HERE and cannot be: `SuggestEngineItem`
 * carries no laundry state, exactly as the engine's request shape does not.
 * The route filters before calling.
 */
export async function requestSuggestions(
  items: SuggestEngineItem[],
  options: SuggestOptions,
  config: Config,
): Promise<EngineResult> {
  let res: Response;
  try {
    res = await fetch(`${config.aiServiceUrl}/suggest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items,
        // Omitted rather than sent as null when absent: the engine defaults
        // both, and a key that is present-but-null is a third state neither
        // side needs.
        ...(options.season !== undefined ? { season: options.season } : {}),
        ...(options.occasion !== undefined ? { occasion: options.occasion } : {}),
        // Always sent. Letting the engine default the limit would make this
        // API's `?limit=` mean nothing, and a caller asking for one
        // suggestion would pay for five.
        limit: options.limit,
      }),
      signal: AbortSignal.timeout(SUGGEST_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn('requestSuggestions: request to the AI service failed', err);
    throw unavailable();
  }

  if (!res.ok) {
    console.warn(`requestSuggestions: AI service responded with status ${res.status}`);
    throw unavailable();
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch (err) {
    console.warn('requestSuggestions: AI service returned a body that is not JSON', err);
    throw unavailable();
  }

  const invalidReason = invalidResultReason(parsed);
  if (invalidReason) {
    console.warn(`requestSuggestions: rejected an invalid response (${invalidReason})`);
    throw unavailable();
  }

  const { suggestions, ignored } = parsed as EngineResult;
  return {
    suggestions: suggestions.map(({ itemIds, score, rationale }) => ({
      itemIds,
      score,
      rationale,
    })),
    ...(ignored ? { ignored } : {}),
  };
}
