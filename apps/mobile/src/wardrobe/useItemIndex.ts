/**
 * Every garment the user owns, keyed by id.
 *
 * WHY THIS EXISTS. `PublicWearEvent` snapshots `itemIds` and nothing else — no
 * photo, no colour — because a wear record must survive the outfit being
 * edited or deleted (see the field's own note in `@wardrobe/shared`). The
 * calendar's whole idea is that a worn day is a *photograph*, so it has to
 * resolve those ids to images itself, and there is no "items by id" endpoint
 * to ask.
 *
 * So it pages `GET /items`. That is a real cost, which is why this is a
 * separate hook rather than something `useWearHistory` grew: only the two
 * calendar screens pay it, and a screen that just lists wear rows still does
 * not fetch the wardrobe.
 *
 * DEGRADATION IS PART OF THE CONTRACT. A day whose items are not in the map
 * renders as a plain dated cell rather than a broken image — see `ready`. That
 * happens for a wardrobe past the cap below, and while the first page is still
 * in flight.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PublicClothingItem } from '@wardrobe/shared';
import { useAuth } from '../auth/AuthContext';
import { fetchItems } from './api';

/**
 * The server's maximum page size, and a hard stop on how many of them to ask
 * for. 500 garments is far past any real wardrobe; the cap is here so a
 * pathological account cannot turn opening the calendar into fifty round
 * trips, not because 500 is a meaningful number.
 */
const PAGE_SIZE = 100;
const MAX_PAGES = 5;

export interface UseItemIndexResult {
  byId: Record<string, PublicClothingItem>;
  /** False until the walk finishes. A cell must not decide "no photo" before this. */
  ready: boolean;
}

export function useItemIndex(): UseItemIndexResult {
  const { token } = useAuth();
  const [byId, setById] = useState<Record<string, PublicClothingItem>>({});
  const [ready, setReady] = useState(false);

  // Guards a walk that outlives its screen: several awaits happen between the
  // first request and the last `setState`, and a token change mid-walk would
  // otherwise merge one account's items into another's map.
  const walkIdRef = useRef(0);

  const walk = useCallback(async () => {
    const walkId = ++walkIdRef.current;
    setReady(false);

    const collected: Record<string, PublicClothingItem> = {};
    let cursor: string | undefined;

    try {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await fetchItems({
          token,
          limit: PAGE_SIZE,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (walkIdRef.current !== walkId) return;

        for (const item of result.items) collected[item.id] = item;
        cursor = result.nextCursor;
        if (cursor === undefined) break;
      }
    } catch {
      // Swallowed on purpose, and this is the one place in the app where that
      // is right: this hook is decoration for a screen that has its own error
      // channel from `useWearHistory`. A second banner saying the wardrobe
      // failed to load, on a calendar that is otherwise showing its month
      // correctly, would be noise about a fetch the user never asked for.
      // What they see instead is dated cells with no photographs.
    }

    if (walkIdRef.current !== walkId) return;
    setById(collected);
    setReady(true);
  }, [token]);

  useEffect(() => {
    void walk();
  }, [walk]);

  return { byId, ready };
}
