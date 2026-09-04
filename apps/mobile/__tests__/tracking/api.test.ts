import type {
  PublicClothingItem,
  PublicUsageAnalytics,
  PublicWearEvent,
} from '@wardrobe/shared';
// The real client runs here on purpose. A bare `jest.mock('../../src/api/client')`
// automocks `ApiClientError` as well, and Jest's automock of a class that
// `extends Error` does not run the real constructor — the resulting object has
// no `.code` and is not `instanceof Error`, so `propagates ApiClientError`
// below could never pass. Stage 2 lost time to exactly that, and Stage 4's
// `src/wardrobe/api.test.ts` and Stage 5's `__tests__/outfits/api.test.ts`
// carry the same note. `fetch` is the seam.
import { ApiClientError } from '../../src/api/client';
import { API_BASE_URL } from '../../src/config';
import {
  fetchUsageAnalytics,
  fetchWearHistory,
  logWear,
  setLaundryStatus,
} from '../../src/tracking/api';

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

function requestedBody(spy: jest.SpyInstance, call = 0): Record<string, unknown> {
  return JSON.parse(String(requestedInit(spy, call).body)) as Record<string, unknown>;
}

const jacket: PublicClothingItem = {
  id: 'item-1',
  userId: 'user-1',
  imageUrl: 'https://example.test/item-1.jpg',
  thumbnailUrl: 'https://example.test/item-1-thumb.jpg',
  category: 'jacket',
  colors: [{ hex: '#123456', name: 'navy', share: 1 }],
  seasons: ['winter'],
  laundryStatus: 'available',
  wearCount: 3,
  source: 'ai',
  aiConfidence: 0.82,
  createdAt: '2026-08-01T10:00:00.000Z',
};

const shoes: PublicClothingItem = {
  id: 'item-2',
  userId: 'user-1',
  imageUrl: 'https://example.test/item-2.jpg',
  category: 'shoes',
  colors: [],
  seasons: [],
  laundryStatus: 'in_laundry',
  wearCount: 0,
  source: 'manual',
  createdAt: '2026-07-30T09:00:00.000Z',
};

const event: PublicWearEvent = {
  id: 'wear-1',
  userId: 'user-1',
  outfitId: 'outfit-1',
  outfitName: 'Rainy Monday',
  itemIds: ['item-1', 'item-2'],
  wornAt: '2026-08-20T17:30:00.000Z',
  occasion: 'Work',
  createdAt: '2026-08-20T17:31:00.000Z',
};

const analytics: PublicUsageAnalytics = {
  mostWorn: [jacket],
  leastWorn: [shoes],
  totalWears: 3,
  itemsInLaundry: 1,
};

afterEach(() => {
  jest.restoreAllMocks();
});

describe('tracking api', () => {
  it('sends the auth token on every call', async () => {
    // One assertion per verb rather than one per function: the token is what
    // ownership derives from server-side, so a call that forgets it is a 401
    // and there is no other place this could be caught.
    const spy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ event, item: jacket, events: [], ...analytics }), {
            status: 200,
          }),
      );

    await logWear({ token: 'tok-abc', outfitId: 'outfit-1' });
    await fetchWearHistory({ token: 'tok-abc' });
    await setLaundryStatus('item-1', { token: 'tok-abc', status: 'in_laundry' });
    await fetchUsageAnalytics({ token: 'tok-abc' });

    expect(spy).toHaveBeenCalledTimes(4);
    for (let call = 0; call < 4; call += 1) {
      expect(requestedHeaders(spy, call).Authorization).toBe('Bearer tok-abc');
    }
  });
});

describe('logWear', () => {
  it('omits wornAt entirely when the wear is happening now', async () => {
    // THE CLIENT CONTRACT, and the whole reason this function takes `wornAt`
    // as optional rather than defaulting it.
    //
    // `POST /wear-history` rejects a future `wornAt` with a strict `>` against
    // a `now` it takes AFTER the request lands. The tolerance a client gets is
    // therefore one-way transit time and nothing more — measured against the
    // API, 1ms ahead passes and 5ms ahead is a 400 the user cannot act on. A
    // handset whose clock is a few milliseconds fast would fail every "Log
    // wear" tap, and it is INVISIBLE on a dev machine because the emulator and
    // the API share one clock there.
    //
    // So the body must carry no `wornAt` key at all. Omitting it hands the
    // dating to the server, which is what "now" means anyway.
    const spy = mockFetch({ event }, 201);

    await logWear({ token: 'tok-abc', outfitId: 'outfit-1' });

    const body = requestedBody(spy);
    expect(body).toEqual({ outfitId: 'outfit-1' });
    // Spelled out separately from the `toEqual` above: `toEqual` is the
    // assertion that fails if a clock reading is inserted, and this one is the
    // assertion that says why.
    expect('wornAt' in body).toBe(false);
  });

  it('serialises exactly one key for a wear happening now', async () => {
    // The same property asserted on the BYTES rather than on a parsed object,
    // because that is what actually goes over the wire. `toEqual` above would
    // still pass against a body carrying `wornAt: undefined` (JSON.stringify
    // drops it) — which is fine — but it is worth pinning that the request is
    // literally `{"outfitId":"outfit-1"}` and that no clock reading, no null
    // and no empty string has been inserted alongside it.
    const spy = mockFetch({ event }, 201);

    await logWear({ token: 'tok-abc', outfitId: 'outfit-1' });

    expect(String(requestedInit(spy).body)).toBe('{"outfitId":"outfit-1"}');
  });

  it('sends wornAt only when the user explicitly chose a past date', async () => {
    // Back-dating is ordinary use — "I wore this yesterday" — and it is the
    // one case that legitimately carries a client timestamp, because only the
    // client knows which day the user picked.
    const spy = mockFetch({ event }, 201);

    await logWear({
      token: 'tok-abc',
      outfitId: 'outfit-1',
      wornAt: '2026-08-20T17:30:00.000Z',
    });

    expect(requestedBody(spy)).toEqual({
      outfitId: 'outfit-1',
      wornAt: '2026-08-20T17:30:00.000Z',
    });
  });

  it('includes occasion when supplied and omits it otherwise', async () => {
    const spy = mockFetch({ event }, 201);

    await logWear({ token: 'tok-abc', outfitId: 'outfit-1', occasion: 'Work' });
    await logWear({ token: 'tok-abc', outfitId: 'outfit-1' });

    expect(requestedBody(spy, 0)).toEqual({ outfitId: 'outfit-1', occasion: 'Work' });
    expect('occasion' in requestedBody(spy, 1)).toBe(false);
  });

  it('POSTs to /wear-history and unwraps the event envelope', async () => {
    const spy = mockFetch({ event }, 201);

    const created = await logWear({ token: 'tok-abc', outfitId: 'outfit-1' });

    expect(requestedUrl(spy)).toBe(`${API_BASE_URL}/wear-history`);
    expect(requestedInit(spy).method).toBe('POST');
    expect(created).toEqual(event);
  });

  it('propagates ApiClientError for a rejected outfitId', async () => {
    mockFetch(
      {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Unknown outfit',
          fields: [{ path: 'outfitId', message: 'That outfit could not be found' }],
        },
      },
      400,
    );

    await expect(logWear({ token: 'tok-abc', outfitId: 'nope' })).rejects.toBeInstanceOf(
      ApiClientError,
    );
  });
});

describe('fetchWearHistory', () => {
  it('omits limit and cursor entirely when not supplied', async () => {
    // The API never coerces an empty parameter to a default: `?limit=` fails
    // its digits check and `?cursor=` fails to decode, so both answer 400. A
    // client that interpolates `?limit=${limit ?? ''}` therefore breaks on
    // page one. The URL must carry no query string at all.
    const spy = mockFetch({ events: [] });

    await fetchWearHistory({ token: 'tok-abc' });

    expect(requestedUrl(spy)).toBe(`${API_BASE_URL}/wear-history`);
  });

  it('includes cursor and limit when supplied', async () => {
    const spy = mockFetch({ events: [] });

    await fetchWearHistory({ token: 'tok-abc', cursor: 'abc123', limit: 10 });

    expect(requestedUrl(spy)).toBe(`${API_BASE_URL}/wear-history?cursor=abc123&limit=10`);
  });

  it('percent-encodes a cursor that is not URL-safe', async () => {
    // The cursor is opaque. The server currently issues base64url, which has
    // no '+' or '/', but nothing here may rely on that — an unencoded '+'
    // decodes as a space and the cursor fails to parse, which is a 400 on
    // every page but the first.
    const spy = mockFetch({ events: [] });

    await fetchWearHistory({ token: 'tok-abc', cursor: 'a+b/c=' });

    expect(requestedUrl(spy)).toBe(`${API_BASE_URL}/wear-history?cursor=a%2Bb%2Fc%3D`);
  });

  it('returns the page and its nextCursor', async () => {
    mockFetch({ events: [event], nextCursor: 'cursor-2' });

    const page = await fetchWearHistory({ token: 'tok-abc' });

    expect(page.events).toEqual([event]);
    expect(page.nextCursor).toBe('cursor-2');
  });

  it('reports the final page as an absent nextCursor', async () => {
    // `GET /wear-history` spreads the key in conditionally, so "no more pages"
    // is `nextCursor === undefined` and never `null`.
    mockFetch({ events: [event] });

    const page = await fetchWearHistory({ token: 'tok-abc' });

    expect(page.nextCursor).toBeUndefined();
  });
});

describe('setLaundryStatus', () => {
  it('PATCHes the item sub-path with the status and unwraps the item', async () => {
    const spy = mockFetch({ item: { ...jacket, laundryStatus: 'in_laundry' } });

    const updated = await setLaundryStatus('item-1', { token: 'tok-abc', status: 'in_laundry' });

    expect(requestedUrl(spy)).toBe(`${API_BASE_URL}/items/item-1/laundry`);
    expect(requestedInit(spy).method).toBe('PATCH');
    expect(requestedBody(spy)).toEqual({ status: 'in_laundry' });
    expect(updated.laundryStatus).toBe('in_laundry');
  });

  it('sends available for the return leg', async () => {
    const spy = mockFetch({ item: jacket });

    await setLaundryStatus('item-1', { token: 'tok-abc', status: 'available' });

    expect(requestedBody(spy)).toEqual({ status: 'available' });
  });

  it('encodes the id rather than interpolating it', async () => {
    // An id that is not a well-formed ObjectId should reach the route and get
    // its 404, not silently address some other path.
    const spy = mockFetch({ item: jacket });

    await setLaundryStatus('a/b', { token: 'tok-abc', status: 'available' });

    expect(requestedUrl(spy)).toBe(`${API_BASE_URL}/items/a%2Fb/laundry`);
  });

  it('propagates ApiClientError for a foreign item', async () => {
    mockFetch({ error: { code: 'NOT_FOUND', message: 'Item not found' } }, 404);

    await expect(
      setLaundryStatus('item-9', { token: 'tok-abc', status: 'in_laundry' }),
    ).rejects.toBeInstanceOf(ApiClientError);
  });
});

describe('fetchUsageAnalytics', () => {
  it('omits limit entirely when not supplied', async () => {
    // `?limit=` is a 400 here too — `parseLimit` is the same parser the list
    // endpoints use, with analytics' own bounds.
    const spy = mockFetch(analytics);

    await fetchUsageAnalytics({ token: 'tok-abc' });

    expect(requestedUrl(spy)).toBe(`${API_BASE_URL}/analytics/usage`);
  });

  it('includes limit when supplied', async () => {
    const spy = mockFetch(analytics);

    await fetchUsageAnalytics({ token: 'tok-abc', limit: 10 });

    expect(requestedUrl(spy)).toBe(`${API_BASE_URL}/analytics/usage?limit=10`);
  });

  it('returns the snapshot with no envelope to unwrap', async () => {
    // `GET /analytics/usage` answers the body directly rather than wrapping it
    // — there is no `{ analytics }` key to reach through.
    mockFetch(analytics);

    const snapshot = await fetchUsageAnalytics({ token: 'tok-abc' });

    expect(snapshot).toEqual(analytics);
  });

  it('reads an empty wardrobe as zeroes rather than absent fields', async () => {
    mockFetch({ mostWorn: [], leastWorn: [], totalWears: 0, itemsInLaundry: 0 });

    const snapshot = await fetchUsageAnalytics({ token: 'tok-abc' });

    expect(snapshot.totalWears).toBe(0);
    expect(snapshot.itemsInLaundry).toBe(0);
    expect(snapshot.mostWorn).toEqual([]);
  });
});
