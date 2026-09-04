import type { ItemCategory, PublicClothingItem } from '@wardrobe/shared';
import { apiRequest } from '../api/client';

export interface FetchItemsOptions {
  token: string | null;
  /** Omitted entirely when absent — see `buildItemsQuery`. */
  category?: ItemCategory;
  /** Opaque, server-issued. Never parsed or constructed here. */
  cursor?: string;
  /** 1..100. Omitted to take the server's default of 24. */
  limit?: number;
}

export interface ItemsPage {
  items: PublicClothingItem[];
  /**
   * Absent — not null — once the last page has been served. `GET /items`
   * spreads the key in conditionally, so "no more pages" is
   * `nextCursor === undefined` and nothing else.
   */
  nextCursor?: string;
}

/**
 * Builds the `GET /items` query string.
 *
 * Every parameter is *omitted* when it is absent rather than sent empty. The
 * API deliberately never coerces an empty value to a default — `?limit=`
 * fails its digits check, `?category=` is not one of ITEM_CATEGORIES, and
 * `?cursor=` fails to decode — so all three answer 400. Interpolating
 * `` `?limit=${limit ?? ''}` `` would therefore break the very first page.
 *
 * `URLSearchParams` also does the percent-encoding, which matters for the
 * cursor: it is opaque, and although the server currently issues base64url
 * (which has no '+' or '/'), nothing here may rely on that.
 */
function buildItemsQuery(opts: FetchItemsOptions): string {
  const params = new URLSearchParams();
  if (opts.category !== undefined) params.set('category', opts.category);
  if (opts.cursor !== undefined) params.set('cursor', opts.cursor);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));

  const query = params.toString();
  return query ? `?${query}` : '';
}

/** One page of the signed-in user's wardrobe. Ownership comes from the token. */
export async function fetchItems(opts: FetchItemsOptions): Promise<ItemsPage> {
  return apiRequest<ItemsPage>(`/items${buildItemsQuery(opts)}`, { token: opts.token });
}

/** A single item, unwrapped from the API's `{ item }` envelope. */
export async function fetchItem(id: string, token: string | null): Promise<PublicClothingItem> {
  // Encoded rather than interpolated: an id that is not a well-formed ObjectId
  // should reach the route and get its 404, not silently address some other
  // path.
  const res = await apiRequest<{ item: PublicClothingItem }>(`/items/${encodeURIComponent(id)}`, {
    token,
  });
  return res.item;
}
