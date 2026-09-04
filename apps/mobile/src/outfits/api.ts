import type { PublicOutfit, PublicOutfitDetail } from '@wardrobe/shared';
import { ApiClientError, apiRequest } from '../api/client';

export interface CreateOutfitOptions {
  token: string | null;
  /**
   * Optional: an unnamed outfit is valid (neither FR5 nor TC-07 mentions
   * naming one) and the UI supplies a placeholder. Omitted from the body
   * entirely when absent — see `createOutfit`.
   */
  name?: string;
  /**
   * 1..20 ids, in the order the user composed them.
   *
   * The order is meaningful — "top, trousers, shoes" reads correctly and
   * "shoes, top, trousers" does not — and the API preserves it deliberately
   * rather than inheriting `$in`'s index order. Nothing here may sort or
   * de-duplicate it: a duplicate is a 400 the user should see, not something
   * to silently repair into an outfit they did not compose.
   */
  itemIds: string[];
}

export interface FetchOutfitsOptions {
  token: string | null;
  /** Opaque, server-issued. Never parsed or constructed here. */
  cursor?: string;
  /** 1..100. Omitted to take the server's default of 24. */
  limit?: number;
}

export interface OutfitsPage {
  outfits: PublicOutfit[];
  /**
   * Absent — not null — once the last page has been served. `GET /outfits`
   * spreads the key in conditionally, so "no more pages" is
   * `nextCursor === undefined` and nothing else.
   */
  nextCursor?: string;
}

export interface UpdateOutfitOptions {
  token: string | null;
  /**
   * Sending `''` **clears** the name; omitting the key leaves it unchanged.
   *
   * These are two different requests and this layer must not conflate them.
   * JSON cannot carry `undefined`, so "the client sent this key" is exactly
   * `name !== undefined` — which is what the API keys the distinction on.
   */
  name?: string;
  /** A full replacement, not a delta. Same 1..20 bound as a create. */
  itemIds?: string[];
}

/**
 * Builds the `GET /outfits` query string.
 *
 * Every parameter is *omitted* when it is absent rather than sent empty. The
 * API deliberately never coerces an empty value to a default — `?limit=` fails
 * its digits check and `?cursor=` fails to decode — so both answer 400.
 * Interpolating `` `?limit=${limit ?? ''}` `` would therefore break the very
 * first page.
 *
 * `URLSearchParams` also does the percent-encoding, which matters for the
 * cursor: it is opaque, and although the server currently issues base64url
 * (which has no '+' or '/'), nothing here may rely on that.
 */
function buildOutfitsQuery(opts: FetchOutfitsOptions): string {
  const params = new URLSearchParams();
  if (opts.cursor !== undefined) params.set('cursor', opts.cursor);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));

  const query = params.toString();
  return query ? `?${query}` : '';
}

/**
 * Path for one outfit.
 *
 * Encoded rather than interpolated: an id that is not a well-formed ObjectId
 * should reach the route and get its 404, not silently address some other
 * path.
 */
function outfitPath(id: string): string {
  return `/outfits/${encodeURIComponent(id)}`;
}

/**
 * Create an outfit. `201 { outfit }` — the *light* shape, with a cover and a
 * count rather than resolved items, because a create is followed by a gallery
 * and not by a detail screen.
 */
export async function createOutfit(opts: CreateOutfitOptions): Promise<PublicOutfit> {
  const res = await apiRequest<{ outfit: PublicOutfit }>('/outfits', {
    method: 'POST',
    token: opts.token,
    body: {
      // Spread, not `name: opts.name`: `JSON.stringify` drops an explicit
      // `undefined` today, but relying on that would make `name: ''` — a
      // meaningful request on PATCH — indistinguishable from "no name" the
      // moment this shape is reused.
      ...(opts.name === undefined ? {} : { name: opts.name }),
      itemIds: opts.itemIds,
    },
  });
  return res.outfit;
}

/** One page of the signed-in user's outfits. Ownership comes from the token. */
export async function fetchOutfits(opts: FetchOutfitsOptions): Promise<OutfitsPage> {
  return apiRequest<OutfitsPage>(`/outfits${buildOutfitsQuery(opts)}`, { token: opts.token });
}

/**
 * One outfit with its items resolved, unwrapped from the `{ outfit }`
 * envelope.
 *
 * `PublicOutfitDetail`, not `PublicOutfit`: the detail read carries the items
 * themselves and no cover, so a screen rendering their images needs one round
 * trip rather than N. `items` may be SHORTER than `itemIds` if an item no
 * longer resolves — a tolerance the read path has deliberately, and one the
 * caller can see precisely because both fields are returned.
 */
export async function fetchOutfit(id: string, token: string | null): Promise<PublicOutfitDetail> {
  const res = await apiRequest<{ outfit: PublicOutfitDetail }>(outfitPath(id), { token });
  return res.outfit;
}

/**
 * Edit an outfit: rename it, replace its items, or both.
 *
 * Returns the detail shape, which is what `PATCH` answers with — the same
 * object `fetchOutfit` returns, so an edit screen can re-render from the
 * response without a follow-up read.
 */
export async function updateOutfit(
  id: string,
  opts: UpdateOutfitOptions,
): Promise<PublicOutfitDetail> {
  const body: { name?: string; itemIds?: string[] } = {};
  // `!== undefined`, so `name: ''` survives into the body: that is the clear,
  // and dropping it would make a name impossible to remove.
  if (opts.name !== undefined) body.name = opts.name;
  if (opts.itemIds !== undefined) body.itemIds = opts.itemIds;

  // A patch with neither key is a 400 ("Nothing to update") — the API refuses
  // to report a write that never happened. Spending a round trip to be told
  // that is waste, so the same rule is enforced here, and the error is
  // reproduced field for field: `PATCH /outfits/:id`'s exact message, its 400,
  // and its `(body)` field error. A near-miss would be worse than no
  // short-circuit at all, because a screen keying on `status` or on `fields`
  // would behave differently depending on which layer answered.
  //
  // ONE divergence remains and cannot be closed from here: the API resolves
  // the outfit BEFORE it inspects the body, so an empty patch against an id
  // that is malformed or not the caller's is a 404 server-side and this 400
  // client-side. Both are errors on a request that is a client bug twice over,
  // and this layer cannot know which id exists without making the round trip
  // the short-circuit exists to avoid.
  if (body.name === undefined && body.itemIds === undefined) {
    throw new ApiClientError('VALIDATION_FAILED', 'Nothing to update', 400, [
      { path: '(body)', message: 'Provide at least one of name or itemIds' },
    ]);
  }

  const res = await apiRequest<{ outfit: PublicOutfitDetail }>(outfitPath(id), {
    method: 'PATCH',
    token: opts.token,
    body,
  });
  return res.outfit;
}

/**
 * Delete an outfit. Resolves on success and throws `ApiClientError` otherwise.
 *
 * `DELETE /outfits/:id` answers **204 with no body at all** — no
 * Content-Length, no Transfer-Encoding, nothing to parse. `apiRequest` reads
 * the body as text and only parses when it is non-empty, which is what makes
 * this safe; `res.json()` on that response rejects, and `JSON.parse('')`
 * throws, so a client that parsed unconditionally would turn every successful
 * delete into an error the user sees. Nothing here may reach for the body.
 *
 * The 204 is deliberately not idempotent-silent: deleting an id that does not
 * exist (or belongs to someone else) is a 404, so a caller must not retry
 * blindly on failure.
 */
export async function deleteOutfit(id: string, token: string | null): Promise<void> {
  await apiRequest<Record<string, never>>(outfitPath(id), { method: 'DELETE', token });
}
