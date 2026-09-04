import type { PublicClothingItem, PublicSuggestions } from '@wardrobe/shared';
// The real client runs here on purpose. A bare `jest.mock('../../src/api/client')`
// automocks `ApiClientError` as well, and Jest's automock of a class that
// `extends Error` does not run the real constructor — the resulting object has
// no `.code` and is not `instanceof Error`, so every assertion below about the
// 503 could never pass. Stage 2 lost time to exactly that, and Stage 4's
// `src/wardrobe/api.test.ts`, Stage 5's `__tests__/outfits/api.test.ts` and
// Stage 6's `__tests__/tracking/api.test.ts` all carry the same note. `fetch`
// is the seam.
import { ApiClientError } from '../../src/api/client';
import { API_BASE_URL } from '../../src/config';
import { fetchSuggestions, isSuggestionsUnavailable } from '../../src/suggestions/api';

// A fresh Response per call: a `Response` body can only be read once, so a
// single `mockResolvedValue` instance makes the *second* call in a test fail
// with "Body is unusable" rather than with whatever the test is checking.
function mockFetch(body: unknown, status = 200): jest.SpyInstance {
  return jest
    .spyOn(global, 'fetch')
    .mockImplementation(async () => new Response(JSON.stringify(body), { status }));
}

function requestedUrl(spy: jest.SpyInstance, call = 0): string {
  return String(spy.mock.calls[call][0]);
}

function requestedInit(spy: jest.SpyInstance, call = 0): RequestInit {
  return spy.mock.calls[call][1] as RequestInit;
}

function requestedHeaders(spy: jest.SpyInstance, call = 0): Record<string, string> {
  return requestedInit(spy, call).headers as Record<string, string>;
}

const shirt: PublicClothingItem = {
  id: '507f1f77bcf86cd799439011',
  userId: 'user-1',
  imageUrl: 'https://example.test/shirt.jpg',
  category: 'shirt',
  colors: [{ hex: '#123456', name: 'navy', share: 1 }],
  seasons: ['winter'],
  laundryStatus: 'available',
  wearCount: 3,
  source: 'ai',
  createdAt: '2026-08-01T10:00:00.000Z',
};

const trousers: PublicClothingItem = {
  id: '507f1f77bcf86cd799439012',
  userId: 'user-1',
  imageUrl: 'https://example.test/trousers.jpg',
  category: 'trousers',
  colors: [],
  seasons: [],
  laundryStatus: 'available',
  wearCount: 0,
  source: 'manual',
  createdAt: '2026-07-30T09:00:00.000Z',
};

const body: PublicSuggestions = {
  suggestions: [
    {
      itemIds: [shirt.id, trousers.id],
      items: [shirt, trousers],
      score: 0.82,
      rationale: 'navy shirt and beige trousers — top with bottom, neutral pairing',
    },
  ],
  excludedInLaundry: 2,
};

afterEach(() => {
  jest.restoreAllMocks();
});

describe('fetchSuggestions', () => {
  it('sends the auth token', async () => {
    // Ownership derives from the verified JWT server-side, so a call that
    // forgets it is a 401 and there is no other place this could be caught.
    const spy = mockFetch(body);

    await fetchSuggestions({ token: 'tok-abc' });

    expect(requestedHeaders(spy).Authorization).toBe('Bearer tok-abc');
  });

  it('omits every query parameter entirely when none is supplied', async () => {
    // THE CASE `useSuggestions` ACTUALLY MAKES, on every load and every
    // refresh. The API never coerces an empty parameter to a default:
    // `?season=` is not one of SEASONS, `?occasion=` fails its 1..64 length
    // check, and `?limit=` fails `parseLimit`'s digits check — so all three
    // answer 400. A client that interpolates `?season=${season ?? ''}`
    // therefore breaks the only request the screen ever issues, and it breaks
    // it on the very first load.
    const spy = mockFetch(body);

    await fetchSuggestions({ token: 'tok-abc' });

    expect(requestedUrl(spy)).toBe(`${API_BASE_URL}/suggestions`);
    // Spelled out separately from the exact-URL assertion above: that one is
    // what fails when an empty parameter is inserted, and these are the ones
    // that say which parameter and why.
    expect(requestedUrl(spy)).not.toContain('?');
    expect(requestedUrl(spy)).not.toContain('season=');
    expect(requestedUrl(spy)).not.toContain('occasion=');
    expect(requestedUrl(spy)).not.toContain('limit=');
  });

  it('includes season, occasion and limit when supplied', async () => {
    const spy = mockFetch(body);

    await fetchSuggestions({ token: 'tok-abc', season: 'summer', occasion: 'Work', limit: 3 });

    expect(requestedUrl(spy)).toBe(
      `${API_BASE_URL}/suggestions?season=summer&occasion=Work&limit=3`,
    );
  });

  it('percent-encodes a free-text occasion', async () => {
    // `occasion` is the one parameter a user types. An interpolated '&' or
    // ' ' would either split the query or produce a malformed URL, and the
    // API would answer 400 for a value the user is entitled to enter.
    const spy = mockFetch(body);

    await fetchSuggestions({ token: 'tok-abc', occasion: 'date night & drinks' });

    expect(requestedUrl(spy)).toBe(
      `${API_BASE_URL}/suggestions?occasion=date+night+%26+drinks`,
    );
  });

  it('returns the body verbatim, including the ignored disclosure', async () => {
    // The transport layer keeps `ignored`, even though `useSuggestions` drops
    // it: the hook drops it because it never sends an `occasion` for the API
    // to ignore, not because the field is unwanted. A caller that DOES send
    // one must be able to read the disclosure back.
    mockFetch({ ...body, ignored: ['occasion'] });

    const result = await fetchSuggestions({ token: 'tok-abc', occasion: 'formal' });

    expect(result).toEqual({ ...body, ignored: ['occasion'] });
  });

  it('resolves an empty shortlist as a successful answer', async () => {
    // 200 with `suggestions: []` is a real answer — "your wardrobe produced
    // nothing" — and must not be mistaken for a failure. `excludedInLaundry`
    // is present alongside it, including as 0.
    mockFetch({ suggestions: [], excludedInLaundry: 0 });

    await expect(fetchSuggestions({ token: 'tok-abc' })).resolves.toEqual({
      suggestions: [],
      excludedInLaundry: 0,
    });
  });

  it('rejects rather than inventing an empty list when the engine is unavailable', async () => {
    // THE 503 CONTRACT, at the layer that could quietly break it. `GET
    // /suggestions` answers 503 AI_UNAVAILABLE with NO `suggestions` key at
    // all — for an unreachable engine, a 500, a 422, a non-JSON body, a
    // malformed body, and a connection that is accepted and never answered.
    // The absent key is the discriminator, not an empty array.
    //
    // A `catch` here returning `{ suggestions: [] }` would erase the exact
    // distinction the whole server-side design exists to preserve, and it
    // would read as "your wardrobe produced nothing" on a screen belonging to
    // a user whose wardrobe is full.
    mockFetch(
      {
        error: {
          code: 'AI_UNAVAILABLE',
          message: 'Outfit suggestions are temporarily unavailable',
        },
      },
      503,
    );

    const err = await fetchSuggestions({ token: 'tok-abc' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as ApiClientError).code).toBe('AI_UNAVAILABLE');
    expect((err as ApiClientError).status).toBe(503);
    expect((err as ApiClientError).message).toBe('Outfit suggestions are temporarily unavailable');
  });

  it('propagates a 400 for an unknown season', async () => {
    mockFetch(
      {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Unknown season',
          fields: [{ path: 'season', message: 'Expected one of spring, summer, autumn, winter' }],
        },
      },
      400,
    );

    // Asserting only `instanceof ApiClientError` here would pass against a 503
    // as readily as a 400 — which is exactly the distinction this module
    // exists to make, so the assertions name it.
    const err = await fetchSuggestions({ token: 'tok-abc', season: 'summer' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as ApiClientError).code).toBe('VALIDATION_FAILED');
    expect((err as ApiClientError).status).toBe(400);
    expect((err as ApiClientError).message).toBe('Unknown season');
    expect((err as ApiClientError).fields).toEqual([
      { path: 'season', message: 'Expected one of spring, summer, autumn, winter' },
    ]);
    expect(isSuggestionsUnavailable(err)).toBe(false);
  });
});

describe('isSuggestionsUnavailable', () => {
  it('is true for the API 503 AI_UNAVAILABLE envelope', async () => {
    mockFetch(
      { error: { code: 'AI_UNAVAILABLE', message: 'Outfit suggestions are temporarily unavailable' } },
      503,
    );

    const err = await fetchSuggestions({ token: 'tok-abc' }).catch((e: unknown) => e);

    expect(isSuggestionsUnavailable(err)).toBe(true);
  });

  it('is true for a bare 503 carrying no error envelope', async () => {
    // A proxy, a load balancer or a cold container answers 503 with HTML or
    // nothing at all, which `apiRequest` reports as `UNKNOWN` with
    // `status: 503`. From the user's point of view that is the same outage,
    // and calling it a generic error would put the wrong message on screen.
    mockFetch({ nothing: 'useful' }, 503);

    const err = await fetchSuggestions({ token: 'tok-abc' }).catch((e: unknown) => e);

    expect((err as ApiClientError).code).toBe('UNKNOWN');
    expect(isSuggestionsUnavailable(err)).toBe(true);
  });

  it('is true for AI_UNAVAILABLE carried on a status other than 503', async () => {
    // The `err.code === 'AI_UNAVAILABLE'` disjunct is unreachable through the
    // route as it stands today — that code is only ever constructed with a 503
    // — so this is the ONLY input that can tell the two clauses apart, and
    // without it the disjunct is dead weight that no mutation can kill. It
    // pins the intent: the CODE decides, and the bare-503 clause is the
    // fallback for outages that never reached our handler at all.
    expect(
      isSuggestionsUnavailable(
        new ApiClientError('AI_UNAVAILABLE', 'Outfit suggestions are temporarily unavailable', 504),
      ),
    ).toBe(true);
  });

  it('is false for failures that are not an engine outage', async () => {
    // Each of these has its own message and its own remedy. None of them
    // justifies "suggestions are temporarily unavailable" copy, and a screen
    // that showed it would be telling the user to wait for something that is
    // never going to change on its own.
    expect(isSuggestionsUnavailable(new ApiClientError('UNAUTHORIZED', 'Session expired', 401))).toBe(
      false,
    );
    expect(
      isSuggestionsUnavailable(new ApiClientError('VALIDATION_FAILED', 'Unknown season', 400)),
    ).toBe(false);
    expect(
      isSuggestionsUnavailable(
        new ApiClientError('NETWORK', 'Cannot reach the server. Check your connection.'),
      ),
    ).toBe(false);
    expect(isSuggestionsUnavailable(new TypeError('boom'))).toBe(false);
    expect(isSuggestionsUnavailable(undefined)).toBe(false);
  });
});
