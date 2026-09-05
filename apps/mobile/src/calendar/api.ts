import type { PublicOutfitPlan } from '@wardrobe/shared';
import { apiRequest } from '../api/client';

export interface CreateOutfitPlanOptions {
  token: string | null;
  outfitId: string;
  /**
   * An instant inside the LOCAL day the user picked — local noon, which is
   * what `plannedForOn` below produces.
   *
   * `POST /outfit-plans` rejects an instant in the past against a `now` it
   * takes after the request lands, with no skew tolerance. Local MIDNIGHT for
   * "today" is already hours in the past and would be refused; noon is the
   * value that is unambiguous on the day it names, in either DST direction.
   * See `PublicOutfitPlan.plannedFor` in `@wardrobe/shared`.
   */
  plannedFor: string;
  /** Bound by `MAX_OCCASION_LENGTH` from `@wardrobe/shared`. */
  occasion?: string;
}

export interface FetchOutfitPlansOptions {
  token: string | null;
  /** ISO instant. REQUIRED — the endpoint is unpaginated and refuses an
   *  unbounded range. */
  from: string;
  /** ISO instant. Required, and never earlier than `from`. */
  to: string;
}

/**
 * `YYYY-MM-DD` → local noon on that day, as an ISO instant.
 *
 * The mirror of `wornAtFor` in `app/calendar/[date].tsx`, and noon for the
 * identical reason: the server stores an instant and this app reads the local
 * day back out of it, so any time inside the chosen local day round-trips
 * correctly — and noon is the one that survives a daylight-saving shift in
 * either direction, where midnight can land on the adjacent day.
 *
 * Returns `null` for a key that is not a date, so a caller can refuse rather
 * than send `Invalid Date` to the API.
 */
export function plannedForOn(dayKey: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (match === null) return null;
  const [, y, m, d] = match;
  // Constructed from parts, never `new Date('2026-08-28')` — a bare date
  // string is parsed as UTC midnight, which in any negative offset is the
  // previous day locally.
  const date = new Date(Number(y), Number(m) - 1, Number(d), 12, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Plan an outfit for a future day. `201 { plan }`. */
export async function createOutfitPlan(
  opts: CreateOutfitPlanOptions,
): Promise<PublicOutfitPlan> {
  const res = await apiRequest<{ plan: PublicOutfitPlan }>('/outfit-plans', {
    method: 'POST',
    token: opts.token,
    body: {
      outfitId: opts.outfitId,
      plannedFor: opts.plannedFor,
      // Spread rather than `occasion: opts.occasion`, so a blank is never sent
      // as a deliberately-empty occasion.
      ...(opts.occasion === undefined ? {} : { occasion: opts.occasion }),
    },
  });
  return res.plan;
}

/**
 * The plans inside one date range, soonest first.
 *
 * There is no cursor and no `nextCursor` to read: the caller names a bounded
 * range, so the answer is a snapshot rather than a page — the same shape
 * `fetchSuggestions` has, and for the same reason.
 */
export async function fetchOutfitPlans(
  opts: FetchOutfitPlansOptions,
): Promise<PublicOutfitPlan[]> {
  const params = new URLSearchParams({ from: opts.from, to: opts.to });
  const res = await apiRequest<{ plans: PublicOutfitPlan[] }>(
    `/outfit-plans?${params.toString()}`,
    { token: opts.token },
  );
  return res.plans;
}

/**
 * Cancel a plan. Resolves on success and throws `ApiClientError` otherwise.
 *
 * `DELETE /outfit-plans/:id` answers 204 with no body — see `deleteOutfit` in
 * `../outfits/api` for why nothing here may reach for one. Not
 * idempotent-silent: cancelling an id that is already gone is a 404.
 */
export async function deleteOutfitPlan(id: string, token: string | null): Promise<void> {
  await apiRequest<Record<string, never>>(`/outfit-plans/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    token,
  });
}
