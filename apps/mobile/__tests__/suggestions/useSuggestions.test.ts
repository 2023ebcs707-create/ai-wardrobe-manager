import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { PublicClothingItem, PublicSuggestions } from '@wardrobe/shared';
// The real `ApiClientError` — not a mock. Automocking a class that extends
// Error yields something that cannot be constructed, which is why
// `src/api/client` is never `jest.mock`ed anywhere in this repo.
import { ApiClientError } from '../../src/api/client';
import { useAuth } from '../../src/auth/AuthContext';
import { fetchSuggestions } from '../../src/suggestions/api';
import {
  laundryNoticeFor,
  retiredNoticeFor,
  useSuggestions,
} from '../../src/suggestions/useSuggestions';

// `./api` exports two plain functions and (erased) interfaces — no class — so
// a factory mock here is safe in the way a mock of `../../src/api/client`
// would not be. `isSuggestionsUnavailable` is deliberately NOT mocked: it is
// the classification under test on the 503 path, and `api.test.ts` pins it
// against real API bodies through the fetch seam.
jest.mock('../../src/suggestions/api', () => ({
  ...jest.requireActual('../../src/suggestions/api'),
  fetchSuggestions: jest.fn(),
}));

jest.mock('../../src/auth/AuthContext', () => ({
  useAuth: jest.fn(),
}));

const mockedFetchSuggestions = jest.mocked(fetchSuggestions);
const mockedUseAuth = jest.mocked(useAuth);

const TOKEN = 'tok-abc';

function authValue(token: string | null) {
  return {
    status: token ? ('authenticated' as const) : ('anonymous' as const),
    user: null,
    token,
    signIn: jest.fn(),
    signUp: jest.fn(),
    signOut: jest.fn(),
  };
}

function item(id: string, category: PublicClothingItem['category']): PublicClothingItem {
  return {
    id,
    userId: 'user-1',
    imageUrl: `https://example.test/${id}.jpg`,
    category,
    colors: [],
    seasons: [],
    laundryStatus: 'available',
    retired: false,
    wearCount: 0,
    source: 'ai',
    createdAt: '2026-08-01T10:00:00.000Z',
  };
}

const shirt = item('507f1f77bcf86cd799439011', 'shirt');
const trousers = item('507f1f77bcf86cd799439012', 'trousers');
const shoes = item('507f1f77bcf86cd799439013', 'shoes');

function body(overrides: Partial<PublicSuggestions> = {}): PublicSuggestions {
  return {
    suggestions: [
      {
        itemIds: [shirt.id, trousers.id],
        items: [shirt, trousers],
        score: 0.82,
        rationale: 'navy shirt and beige trousers — top with bottom, neutral pairing',
      },
    ],
    excludedInLaundry: 0,
    excludedRetired: 0,
    ...overrides,
  };
}

/** A promise whose settlement this test controls, so request *ordering* can be
 *  written down explicitly instead of being left to the microtask queue. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // An unhandled rejection would be reported by Jest even though the hook does
  // handle it, because the handler is attached only once the hook awaits.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** Any request beyond the ones a test queues up gets a promise that never
 *  settles, so a surplus request shows up as the call count it is rather than
 *  resolving to `undefined` and dying inside the hook. */
function stallSurplusRequests() {
  mockedFetchSuggestions.mockImplementation(() => new Promise(() => {}));
}

const unavailableError = new ApiClientError(
  'AI_UNAVAILABLE',
  'Outfit suggestions are temporarily unavailable',
  503,
);

const first = body();
const second = body({
  suggestions: [
    {
      itemIds: [shirt.id, shoes.id],
      items: [shirt, shoes],
      score: 0.5,
      rationale: 'navy shirt and white shoes — top with shoes, neutral pairing',
    },
  ],
});

beforeEach(() => {
  mockedUseAuth.mockReturnValue(authValue(TOKEN));
});

afterEach(() => {
  // `reset`, not `clear`: some tests install a lasting `mockImplementation`,
  // and `clearAllMocks` wipes only the call log, so that implementation would
  // leak into every test after it.
  jest.resetAllMocks();
});

describe('useSuggestions', () => {
  it('loads the shortlist on mount, sending no query parameters at all', async () => {
    const pending = deferred<PublicSuggestions>();
    mockedFetchSuggestions.mockReturnValueOnce(pending.promise);

    const { result } = await renderHook(() => useSuggestions());

    expect(result.current.activity).toBe('loading');
    // `null`, not an empty snapshot: "not loaded yet" and "loaded, and this
    // wardrobe produced nothing" render differently, and only the API can tell
    // the screen which one it is looking at.
    expect(result.current.snapshot).toBeNull();
    expect(result.current.unavailable).toBe(false);
    // No `season`, `occasion` or `limit` key: each is a 400 when sent empty,
    // not the server's default.
    expect(mockedFetchSuggestions).toHaveBeenCalledWith({ token: TOKEN });

    await act(async () => {
      pending.resolve(first);
    });

    await waitFor(() => expect(result.current.activity).toBe('idle'));
    expect(result.current.snapshot?.suggestions).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it('exposes no paging surface, because a shortlist has no pages', async () => {
    // `GET /suggestions` returns a bounded shortlist, not a page: there is no
    // cursor in the response and no paging to drive. A `loadMore` here would
    // be a control with nothing behind it, and a screen wiring it to
    // onEndReached would silently do nothing forever. Asserted rather than
    // merely omitted, because "we chose not to add paging" and "we forgot to
    // add paging" look identical in a diff a year later.
    mockedFetchSuggestions.mockResolvedValueOnce(first);
    const { result } = await renderHook(() => useSuggestions());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    expect(result.current).not.toHaveProperty('loadMore');
    expect(result.current).not.toHaveProperty('hasMore');
    expect(result.current).not.toHaveProperty('nextCursor');
  });

  it('carries score and rationale through untouched', async () => {
    mockedFetchSuggestions.mockResolvedValueOnce(first);
    const { result } = await renderHook(() => useSuggestions());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    const card = result.current.snapshot?.suggestions[0];
    expect(card?.score).toBe(0.82);
    expect(card?.rationale).toBe(
      'navy shirt and beige trousers — top with bottom, neutral pairing',
    );
  });
});

describe('useSuggestions · the 503 is not an empty list', () => {
  it('reports an outage as unavailable and leaves the snapshot null', async () => {
    // THE WHOLE REASON `GET /suggestions` ANSWERS 503 RATHER THAN `[]`. The
    // API withholds the `suggestions` key entirely on an outage, so "the
    // engine is down" and "your wardrobe produced nothing" stay
    // distinguishable — one screen says "try again shortly", the other says
    // "add more items". A hook that substituted an empty list here would tell
    // a user with a full wardrobe that none of it goes together.
    mockedFetchSuggestions.mockRejectedValueOnce(unavailableError);

    const { result } = await renderHook(() => useSuggestions());

    await waitFor(() => expect(result.current.activity).toBe('idle'));
    expect(result.current.unavailable).toBe(true);
    expect(result.current.snapshot).toBeNull();
    // Specifically NOT an empty shortlist. Spelled out separately from the
    // `toBeNull` above: this is the assertion that names the failure mode.
    expect(result.current.snapshot?.suggestions).not.toEqual([]);
    expect(result.current.error).toBe('Outfit suggestions are temporarily unavailable');
  });

  it('reports an empty shortlist as a successful answer, not an outage', async () => {
    // The other half of the same distinction, and the reason the two tests are
    // written as a pair: a hook that collapsed them would pass whichever one
    // was written first.
    mockedFetchSuggestions.mockResolvedValueOnce({
      suggestions: [],
      excludedInLaundry: 0,
      excludedRetired: 0,
    });

    const { result } = await renderHook(() => useSuggestions());

    await waitFor(() => expect(result.current.activity).toBe('idle'));
    expect(result.current.unavailable).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.snapshot).toEqual({ suggestions: [], laundryNotice: null, retiredNotice: null });
  });

  it('never raises unavailable without an error to go with it', async () => {
    // `unavailable` is a REFINEMENT of `error`, not a fourth axis. A screen
    // with no outage-specific copy must be able to ignore it entirely and
    // render `error`, and that is only safe if the two cannot disagree.
    mockedFetchSuggestions
      .mockRejectedValueOnce(unavailableError)
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new ApiClientError('UNAUTHORIZED', 'Session expired', 401));

    const { result } = await renderHook(() => useSuggestions());
    await waitFor(() => expect(result.current.activity).toBe('idle'));
    expect(result.current.unavailable && result.current.error === null).toBe(false);

    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.activity).toBe('idle'));
    expect(result.current.unavailable).toBe(false);
    expect(result.current.error).toBeNull();

    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.error).toBe('Session expired'));
    // A 401 is not an outage: it has its own remedy, and "temporarily
    // unavailable" copy would tell the user to wait for something that will
    // never fix itself.
    expect(result.current.unavailable).toBe(false);
  });

  it('clears unavailable the moment a retry starts', async () => {
    // Not when it succeeds — when it *starts*. A screen rendering outage copy
    // on `unavailable` would otherwise keep saying "temporarily unavailable"
    // underneath the spinner of the request that is about to disprove it.
    mockedFetchSuggestions.mockRejectedValueOnce(unavailableError);
    const { result } = await renderHook(() => useSuggestions());
    await waitFor(() => expect(result.current.unavailable).toBe(true));

    const retry = deferred<PublicSuggestions>();
    stallSurplusRequests();
    mockedFetchSuggestions.mockReturnValueOnce(retry.promise);

    await act(async () => {
      result.current.refresh();
    });

    expect(result.current.activity).toBe('refreshing');
    expect(result.current.unavailable).toBe(false);
    expect(result.current.error).toBeNull();

    await act(async () => {
      retry.resolve(first);
    });
    await waitFor(() => expect(result.current.snapshot?.suggestions).toHaveLength(1));
  });

  it('keeps the last good shortlist on screen through an outage', async () => {
    // A stale shortlist beside an outage banner is strictly more useful than a
    // blank screen: those outfits were true a moment ago, and the garments in
    // them have not moved.
    mockedFetchSuggestions.mockResolvedValueOnce(first);
    const { result } = await renderHook(() => useSuggestions());
    await waitFor(() => expect(result.current.activity).toBe('idle'));
    const loaded = result.current.snapshot;

    mockedFetchSuggestions.mockRejectedValueOnce(unavailableError);
    await act(async () => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.unavailable).toBe(true));
    expect(result.current.snapshot).toEqual(loaded);
    expect(result.current.snapshot?.suggestions).toHaveLength(1);
  });
});

describe('useSuggestions · what a card renders and what it saves', () => {
  // `itemIds` length 5, `items` length 2 — the exact divergence a shipped API
  // integration test asserts. `items` is compacted and `itemIds` is not, so
  // the two are NOT parallel arrays: `items[0]` is the item for
  // `itemIds[2]` here, not for `itemIds[0]`.
  const divergent = body({
    suggestions: [
      {
        itemIds: ['stale-a', 'stale-b', shirt.id, 'stale-c', shoes.id],
        items: [shirt, shoes],
        score: 0.4,
        rationale: 'navy shirt and white shoes — top with shoes',
      },
    ],
  });

  it('renders the resolved items, never a parallel index into itemIds', async () => {
    // Pairing the two arrays by index puts the wrong garment under the wrong
    // id from the first gap onwards — here, the shirt would be labelled
    // 'stale-a' and the shoes 'stale-b'. Both ids belong to nothing, and the
    // photograph on screen would belong to a garment the user is not looking
    // at the name of.
    mockedFetchSuggestions.mockResolvedValueOnce(divergent);

    const { result } = await renderHook(() => useSuggestions());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    const card = result.current.snapshot?.suggestions[0];
    expect(card?.items).toEqual([shirt, shoes]);
    // Identity, not just length: an id read from the wrong array would still
    // give two items of the right shape.
    expect(card?.items.map((i) => i.id)).toEqual([shirt.id, shoes.id]);
    expect(card?.items.map((i) => i.id)).not.toContain('stale-a');
    expect(card?.items.map((i) => i.id)).not.toContain('stale-b');
  });

  it('saves the ids of what was displayed, never the ids the engine proposed', async () => {
    // Posting `itemIds` to `POST /outfits` saves the outfit the ENGINE
    // proposed; posting the displayed ids saves the outfit the USER WAS SHOWN.
    // When `items` is shorter these are different outfits, and persisting one
    // the user never saw is the worse failure of the two — it outlives the
    // session.
    mockedFetchSuggestions.mockResolvedValueOnce(divergent);

    const { result } = await renderHook(() => useSuggestions());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    const card = result.current.snapshot?.suggestions[0];
    expect(card?.saveItemIds).toEqual([shirt.id, shoes.id]);
    expect(card?.saveItemIds).not.toEqual(divergent.suggestions[0].itemIds);
    // Nor the engine's list truncated to the displayed length, which is the
    // other shape this mistake takes: `itemIds.slice(0, items.length)` is
    // ['stale-a', 'stale-b'] here — two ids belonging to nothing.
    expect(card?.saveItemIds).not.toEqual(['stale-a', 'stale-b']);
  });

  it('does not hand the engine’s id list to the screen at all', async () => {
    // A comment saying "render from `items`" is not a control; not handing
    // over the other array is. Task 4 cannot index `itemIds` in parallel, and
    // cannot post it, because it is not reachable from a card.
    mockedFetchSuggestions.mockResolvedValueOnce(divergent);

    const { result } = await renderHook(() => useSuggestions());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    expect(result.current.snapshot?.suggestions[0]).not.toHaveProperty('itemIds');
    expect(Object.keys(result.current.snapshot?.suggestions[0] ?? {}).sort()).toEqual([
      'items',
      'rationale',
      'saveItemIds',
      'score',
    ]);
  });

  it('saves exactly the displayed ids when nothing diverged either', async () => {
    // The ordinary case, so the property is not only pinned by the pathological
    // fixture: `saveItemIds` is read off `items` always, not "when they differ".
    mockedFetchSuggestions.mockResolvedValueOnce(first);

    const { result } = await renderHook(() => useSuggestions());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    expect(result.current.snapshot?.suggestions[0].saveItemIds).toEqual([shirt.id, trousers.id]);
  });
});

describe('laundryNoticeFor', () => {
  // THE WORDING IS THE CONTRACT. `excludedInLaundry` counts every in-laundry
  // item in the wardrobe, NOT suggestions that were withheld, and the
  // difference is observable: one shirt plus three in-laundry accessories
  // answers `suggestions: []` with `excludedInLaundry: 3`, and not one of
  // those three could have produced a suggestion — there was no bottom to pair
  // with. Any sentence asserting causation is therefore a false statement the
  // user would act on.
  it('states a fact about the wardrobe, in the sanctioned wording', () => {
    expect(laundryNoticeFor(3)).toBe('3 items are in the laundry');
  });

  it('agrees with its verb in the singular', () => {
    expect(laundryNoticeFor(1)).toBe('1 item is in the laundry');
  });

  it('says nothing at all when the wardrobe has no laundry', () => {
    // `null`, not "0 items are in the laundry", which reads as a warning about
    // a wardrobe that has none.
    expect(laundryNoticeFor(0)).toBeNull();
    expect(laundryNoticeFor(-1)).toBeNull();
  });

  it('says nothing rather than "undefined items are in the laundry"', () => {
    // `apiRequest` ends in `parsed as T`, so the `number` in this signature is
    // an assertion about the wire, not a guarantee from it. Both of these
    // compare `false` against `<= 0`, so without the runtime guard they fall
    // through to the template and render garbage in the one string this module
    // exists to constrain — and unlike a malformed `items`, which throws and
    // surfaces as an error, this one fails silently on screen.
    const missing = undefined as unknown as number;
    expect(laundryNoticeFor(missing)).toBeNull();
    expect(laundryNoticeFor(Number.NaN)).toBeNull();
    expect(laundryNoticeFor('3' as unknown as number)).toBeNull();
    expect(laundryNoticeFor(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('never asserts that the laundry caused a thin result', () => {
    // The forbidden phrasings, enumerated so a later edit that reintroduces
    // one fails here rather than shipping. "3 suggestions were hidden", "3
    // outfits unavailable" and "3 items were left out of these suggestions"
    // all claim a link to the result that this number does not carry.
    for (const count of [1, 2, 3, 17]) {
      const notice = laundryNoticeFor(count) as string;
      expect(notice).toBe(
        `${count} ${count === 1 ? 'item is' : 'items are'} in the laundry`,
      );
      expect(notice).not.toMatch(
        /suggestion|outfit|hidden|hiding|withheld|excluded|left out|unavailable|because|so that|fewer|would have/i,
      );
    }
  });
});

describe('retiredNoticeFor', () => {
  // Every word of the `laundryNoticeFor` contract above applies here, for the
  // same reason and against a different count: `excludedRetired` is every
  // retired item in the wardrobe, not a number of suggestions that were
  // withheld.
  it('states a fact about the wardrobe, in the sanctioned wording', () => {
    expect(retiredNoticeFor(3)).toBe('3 items are retired');
  });

  it('agrees with its verb in the singular', () => {
    expect(retiredNoticeFor(1)).toBe('1 item is retired');
  });

  it('says nothing at all when the wardrobe has nothing retired', () => {
    expect(retiredNoticeFor(0)).toBeNull();
    expect(retiredNoticeFor(-1)).toBeNull();
  });

  it('says nothing rather than "undefined items are retired"', () => {
    // `apiRequest` ends in `parsed as T`, so the `number` in this signature is
    // an assertion about the wire rather than a guarantee from it.
    const missing = undefined as unknown as number;
    expect(retiredNoticeFor(missing)).toBeNull();
    expect(retiredNoticeFor(Number.NaN)).toBeNull();
    expect(retiredNoticeFor('3' as unknown as number)).toBeNull();
    expect(retiredNoticeFor(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('never asserts that retiring caused a thin result', () => {
    for (const count of [1, 2, 3, 17]) {
      const notice = retiredNoticeFor(count) as string;
      expect(notice).toBe(`${count} ${count === 1 ? 'item is' : 'items are'} retired`);
      expect(notice).not.toMatch(
        /suggestion|outfit|hidden|hiding|withheld|excluded|left out|unavailable|because|so that|fewer|would have/i,
      );
    }
  });

  it('is a SEPARATE sentence from the laundry one, never merged', () => {
    // Merging the two counts would produce a number that cannot be un-added
    // back into "how many are in the wash" and "how many are retired" — two
    // different actions a user might take in response.
    expect(retiredNoticeFor(2)).not.toBe(laundryNoticeFor(2));
    expect(retiredNoticeFor(2)).not.toMatch(/laundry/i);
  });
});

describe('useSuggestions · the retired notice', () => {
  it('builds the notice from excludedRetired', async () => {
    mockedFetchSuggestions.mockResolvedValueOnce(body({ excludedRetired: 2 }));

    const { result } = await renderHook(() => useSuggestions());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    expect(result.current.snapshot?.retiredNotice).toBe('2 items are retired');
  });

  it('leaves the notice null when nothing is retired', async () => {
    mockedFetchSuggestions.mockResolvedValueOnce(body({ excludedRetired: 0 }));

    const { result } = await renderHook(() => useSuggestions());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    expect(result.current.snapshot?.retiredNotice).toBeNull();
  });

  it('carries both notices independently', async () => {
    mockedFetchSuggestions.mockResolvedValueOnce(
      body({ excludedInLaundry: 3, excludedRetired: 1 }),
    );

    const { result } = await renderHook(() => useSuggestions());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    expect(result.current.snapshot?.laundryNotice).toBe('3 items are in the laundry');
    expect(result.current.snapshot?.retiredNotice).toBe('1 item is retired');
  });
});

describe('useSuggestions · the laundry notice', () => {
  it('builds the notice from excludedInLaundry', async () => {
    mockedFetchSuggestions.mockResolvedValueOnce(body({ excludedInLaundry: 3 }));

    const { result } = await renderHook(() => useSuggestions());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    expect(result.current.snapshot?.laundryNotice).toBe('3 items are in the laundry');
  });

  it('leaves the notice null when nothing is in the wash', async () => {
    mockedFetchSuggestions.mockResolvedValueOnce(body({ excludedInLaundry: 0 }));

    const { result } = await renderHook(() => useSuggestions());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    expect(result.current.snapshot?.laundryNotice).toBeNull();
  });

  it('reports laundry on an empty shortlist without linking the two', async () => {
    // The case the wording rule exists for: one shirt plus three in-laundry
    // accessories. The shortlist is empty because there was no bottom to pair
    // with, and the three garments in the wash are a coincidence — so the
    // sentence beside the empty list must not claim they caused it.
    mockedFetchSuggestions.mockResolvedValueOnce({
      suggestions: [],
      excludedInLaundry: 3,
      excludedRetired: 0,
    });

    const { result } = await renderHook(() => useSuggestions());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    expect(result.current.snapshot).toEqual({
      suggestions: [],
      laundryNotice: '3 items are in the laundry', retiredNotice: null,
    });
  });

  it('does not expose the raw count beside the sentence', async () => {
    // For the same reason a card does not expose `itemIds`: handing over the
    // number next to the sanctioned sentence leaves the forbidden sentence one
    // template literal away, and a note asking the next task not to write it
    // is not a control.
    mockedFetchSuggestions.mockResolvedValueOnce(body({ excludedInLaundry: 3 }));

    const { result } = await renderHook(() => useSuggestions());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    expect(result.current.snapshot).not.toHaveProperty('excludedInLaundry');
    // `excludedRetired` is withheld for the identical reason — see
    // `retiredNoticeFor`. The key list is exhaustive on purpose: a raw count
    // added to the snapshot fails here rather than quietly becoming available
    // to whoever writes the next screen.
    expect(result.current.snapshot).not.toHaveProperty('excludedRetired');
    expect(Object.keys(result.current.snapshot ?? {}).sort()).toEqual([
      'laundryNotice',
      'retiredNotice',
      'suggestions',
    ]);
  });

  it('drops the ignored disclosure, which this hook can never provoke', async () => {
    // `ignored: ['occasion']` appears only when the caller sent an `occasion`,
    // and this hook never sends one — so surfacing it would be a control with
    // nothing behind it. Asserted rather than left implicit so that whoever
    // adds an occasion filter is made to decide about the disclosure in the
    // same change: this test fails the moment the hook starts sending one and
    // keeps dropping the answer.
    mockedFetchSuggestions.mockResolvedValueOnce(body({ ignored: ['occasion'] }));

    const { result } = await renderHook(() => useSuggestions());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    expect(result.current.snapshot).not.toHaveProperty('ignored');
    expect(mockedFetchSuggestions).toHaveBeenCalledWith({ token: TOKEN });
  });
});

describe('useSuggestions · refresh', () => {
  it('refreshes into refreshing rather than loading, keeping the old shortlist on screen', async () => {
    mockedFetchSuggestions.mockResolvedValueOnce(first);
    const { result } = await renderHook(() => useSuggestions());
    await waitFor(() => expect(result.current.activity).toBe('idle'));
    const loaded = result.current.snapshot;

    const refreshed = deferred<PublicSuggestions>();
    stallSurplusRequests();
    mockedFetchSuggestions.mockReturnValueOnce(refreshed.promise);

    await act(async () => {
      result.current.refresh();
    });

    expect(result.current.activity).toBe('refreshing');
    expect(result.current.snapshot).toEqual(loaded);

    await act(async () => {
      refreshed.resolve(second);
    });
    await waitFor(() =>
      expect(result.current.snapshot?.suggestions[0].saveItemIds).toEqual([shirt.id, shoes.id]),
    );
    expect(result.current.activity).toBe('idle');
  });

  it('does not issue a second refresh while one is in flight', async () => {
    // A "Try again" button double-tapped on a slow network. State stays
    // correct either way — the sequence guard discards the losers — so the
    // cost is duplicate round trips, each of which runs the whole wardrobe
    // through the engine and signs a URL per returned item.
    mockedFetchSuggestions.mockResolvedValueOnce(first);
    const { result } = await renderHook(() => useSuggestions());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    const refreshed = deferred<PublicSuggestions>();
    stallSurplusRequests();
    mockedFetchSuggestions.mockReturnValueOnce(refreshed.promise);

    await act(async () => {
      result.current.refresh();
      result.current.refresh();
      result.current.refresh();
    });

    // One for the mount, one for the first refresh. Nothing else.
    expect(mockedFetchSuggestions).toHaveBeenCalledTimes(2);

    await act(async () => {
      refreshed.resolve(second);
    });
    await waitFor(() => expect(result.current.activity).toBe('idle'));
  });

  it('does not refresh on top of the initial load', async () => {
    // The half of the in-flight guard the three-taps test above cannot see. A
    // guard narrowed to "another REFRESH is running" passes that test and
    // fails this one: pull-to-refresh and "Try again" are both reachable while
    // the first load is still in flight, and each duplicate runs the whole
    // wardrobe through the engine again.
    const pending = deferred<PublicSuggestions>();
    stallSurplusRequests();
    mockedFetchSuggestions.mockReturnValueOnce(pending.promise);

    const { result } = await renderHook(() => useSuggestions());
    expect(result.current.activity).toBe('loading');

    await act(async () => {
      result.current.refresh();
    });

    expect(mockedFetchSuggestions).toHaveBeenCalledTimes(1);
    // Still a first load, not downgraded to a refresh: there is nothing on
    // screen behind the spinner yet.
    expect(result.current.activity).toBe('loading');

    await act(async () => {
      pending.resolve(first);
    });
    await waitFor(() => expect(result.current.activity).toBe('idle'));
  });

  it('keeps refresh closed while a newer request is still running', async () => {
    // A superseded request finishing first must not hand the in-flight flag
    // back — the request that replaced it is still running, and re-opening
    // `refresh` would let a tap issue a third request against a screen that
    // already has two in flight.
    const stale = deferred<PublicSuggestions>();
    const fresh = deferred<PublicSuggestions>();
    stallSurplusRequests();
    mockedFetchSuggestions.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);

    const { result, rerender } = await renderHook(() => useSuggestions());

    mockedUseAuth.mockReturnValue(authValue('tok-other'));
    await act(async () => {
      await rerender(undefined);
    });
    expect(mockedFetchSuggestions).toHaveBeenCalledTimes(2);

    await act(async () => {
      stale.resolve(first);
    });
    await act(async () => {
      result.current.refresh();
    });

    expect(mockedFetchSuggestions).toHaveBeenCalledTimes(2);

    await act(async () => {
      fresh.resolve(second);
    });
    await waitFor(() => expect(result.current.activity).toBe('idle'));
    expect(result.current.snapshot?.suggestions[0].saveItemIds).toEqual([shirt.id, shoes.id]);
  });

  it('keeps the last good shortlist when a refresh fails', async () => {
    mockedFetchSuggestions.mockResolvedValueOnce(first);
    const { result } = await renderHook(() => useSuggestions());
    await waitFor(() => expect(result.current.activity).toBe('idle'));
    const loaded = result.current.snapshot;

    mockedFetchSuggestions.mockRejectedValueOnce(
      new ApiClientError('NETWORK', 'Cannot reach the server. Check your connection.'),
    );
    await act(async () => {
      result.current.refresh();
    });

    await waitFor(() =>
      expect(result.current.error).toBe('Cannot reach the server. Check your connection.'),
    );
    expect(result.current.snapshot).toEqual(loaded);
    expect(result.current.unavailable).toBe(false);
    expect(result.current.activity).toBe('idle');
  });

  it('clears the previous error as soon as a new request starts', async () => {
    // Not when it succeeds — when it *starts*. A screen rendering its banner
    // on `error !== null` would otherwise show the dead message underneath the
    // refresh spinner for the whole round trip.
    mockedFetchSuggestions.mockRejectedValueOnce(new ApiClientError('NETWORK', 'offline'));
    const { result } = await renderHook(() => useSuggestions());
    await waitFor(() => expect(result.current.error).toBe('offline'));

    const retry = deferred<PublicSuggestions>();
    stallSurplusRequests();
    mockedFetchSuggestions.mockReturnValueOnce(retry.promise);

    await act(async () => {
      result.current.refresh();
    });

    expect(result.current.activity).toBe('refreshing');
    expect(result.current.error).toBeNull();

    await act(async () => {
      retry.resolve(first);
    });
    await waitFor(() => expect(result.current.snapshot?.suggestions).toHaveLength(1));
  });

  it('falls back to a readable message for a non-ApiClientError', async () => {
    mockedFetchSuggestions.mockRejectedValueOnce(new TypeError('boom'));

    const { result } = await renderHook(() => useSuggestions());

    await waitFor(() =>
      expect(result.current.error).toBe('Something went wrong loading your suggestions.'),
    );
    expect(result.current.unavailable).toBe(false);
  });
});

describe('useSuggestions · stale responses', () => {
  it('discards a success from a request three tokens ago, even when the token matches again', async () => {
    // A → B → A, written out explicitly because a VALUE comparison passes the
    // obvious two-token test and fails this one. "Is this response for the
    // token I currently hold?" says yes to the first A response once the user
    // has signed back into A — and that response is three requests old and
    // describes a wardrobe as it was before B ever loaded.
    //
    // Only a monotonic sequence number separates them. Stage 5's reviewer
    // found this property present in code and defended by no test, on the one
    // property that stage's brief had named.
    const a1 = deferred<PublicSuggestions>();
    const b = deferred<PublicSuggestions>();
    const a2 = deferred<PublicSuggestions>();
    stallSurplusRequests();
    mockedFetchSuggestions
      .mockReturnValueOnce(a1.promise)
      .mockReturnValueOnce(b.promise)
      .mockReturnValueOnce(a2.promise);

    const { result, rerender } = await renderHook(() => useSuggestions());

    mockedUseAuth.mockReturnValue(authValue('tok-other'));
    await act(async () => {
      await rerender(undefined);
    });
    mockedUseAuth.mockReturnValue(authValue(TOKEN));
    await act(async () => {
      await rerender(undefined);
    });

    expect(mockedFetchSuggestions).toHaveBeenCalledTimes(3);
    expect(mockedFetchSuggestions).toHaveBeenLastCalledWith({ token: TOKEN });

    await act(async () => {
      a2.resolve(second);
    });
    await waitFor(() =>
      expect(result.current.snapshot?.suggestions[0].saveItemIds).toEqual([shirt.id, shoes.id]),
    );

    // The first request finally answers. It carries the same token as the one
    // in hand and must still lose.
    await act(async () => {
      a1.resolve(first);
    });

    expect(result.current.snapshot?.suggestions[0].saveItemIds).toEqual([shirt.id, shoes.id]);
    expect(result.current.activity).toBe('idle');

    await act(async () => {
      b.resolve(body({ excludedInLaundry: 99 }));
    });
    expect(result.current.snapshot?.laundryNotice).toBeNull();
  });

  it('discards a failure from a request three tokens ago, even when the token matches again', async () => {
    // The catch path carries the same guard as the success path, and it is a
    // SEPARATE mechanism: one `if` cannot cover both, and the catch half is
    // the one written after the success path already works. Without it, a
    // request the user moved on from — twice — paints an error over a
    // shortlist that loaded fine, and an outage banner over a working screen.
    const a1 = deferred<PublicSuggestions>();
    const b = deferred<PublicSuggestions>();
    const a2 = deferred<PublicSuggestions>();
    stallSurplusRequests();
    mockedFetchSuggestions
      .mockReturnValueOnce(a1.promise)
      .mockReturnValueOnce(b.promise)
      .mockReturnValueOnce(a2.promise);

    const { result, rerender } = await renderHook(() => useSuggestions());

    mockedUseAuth.mockReturnValue(authValue('tok-other'));
    await act(async () => {
      await rerender(undefined);
    });
    mockedUseAuth.mockReturnValue(authValue(TOKEN));
    await act(async () => {
      await rerender(undefined);
    });

    await act(async () => {
      a2.resolve(second);
    });
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    await act(async () => {
      a1.reject(unavailableError);
    });

    expect(result.current.error).toBeNull();
    expect(result.current.unavailable).toBe(false);
    expect(result.current.snapshot?.suggestions[0].saveItemIds).toEqual([shirt.id, shoes.id]);
    expect(result.current.activity).toBe('idle');

    await act(async () => {
      b.reject(new ApiClientError('UNAUTHORIZED', 'Session expired', 401));
    });
    expect(result.current.error).toBeNull();
  });

  it('clears the previous user’s shortlist when the token changes', async () => {
    mockedFetchSuggestions.mockResolvedValueOnce(first);
    const { result, rerender } = await renderHook(() => useSuggestions());
    await waitFor(() => expect(result.current.snapshot?.suggestions).toHaveLength(1));

    const next = deferred<PublicSuggestions>();
    stallSurplusRequests();
    mockedFetchSuggestions.mockReturnValueOnce(next.promise);
    mockedUseAuth.mockReturnValue(authValue('tok-other'));

    await act(async () => {
      await rerender(undefined);
    });

    // Another user's wardrobe is not this user's wardrobe: it goes away
    // immediately rather than lingering under a spinner.
    expect(result.current.snapshot).toBeNull();
    expect(result.current.activity).toBe('loading');
    expect(mockedFetchSuggestions).toHaveBeenLastCalledWith({ token: 'tok-other' });

    await act(async () => {
      next.resolve(second);
    });
    await waitFor(() => expect(result.current.snapshot?.suggestions).toHaveLength(1));
  });
});
