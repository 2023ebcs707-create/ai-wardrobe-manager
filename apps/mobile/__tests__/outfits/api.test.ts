import type { PublicClothingItem, PublicOutfit, PublicOutfitDetail } from '@wardrobe/shared';
// The real client runs here on purpose. A bare `jest.mock('../../src/api/client')`
// automocks `ApiClientError` as well, and Jest's automock of a class that
// `extends Error` does not run the real constructor — the resulting object has
// no `.code` and is not `instanceof Error`, so `propagates ApiClientError`
// below could never pass. Stage 2 lost time to exactly that, and Stage 4's
// `src/wardrobe/api.test.ts` carries the same note. `fetch` is the seam.
import { ApiClientError } from '../../src/api/client';
import { API_BASE_URL } from '../../src/config';
import {
  createOutfit,
  deleteOutfit,
  fetchOutfit,
  fetchOutfits,
  updateOutfit,
} from '../../src/outfits/api';

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

function requestedBody(spy: jest.SpyInstance, call = 0): unknown {
  return JSON.parse(String(requestedInit(spy, call).body));
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
  retired: false,
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
  laundryStatus: 'available',
  retired: false,
  wearCount: 0,
  source: 'manual',
  createdAt: '2026-07-30T09:00:00.000Z',
};

const outfit: PublicOutfit = {
  id: 'outfit-1',
  userId: 'user-1',
  name: 'Rainy Monday',
  itemIds: ['item-1', 'item-2'],
  itemCount: 2,
  coverUrl: 'https://example.test/item-1-thumb.jpg',
  createdAt: '2026-08-02T10:00:00.000Z',
};

// An unnamed outfit is valid — neither FR5 nor TC-07 mentions naming one — and
// so is one whose cover could not be resolved. Both keys are simply absent.
const unnamed: PublicOutfit = {
  id: 'outfit-2',
  userId: 'user-1',
  itemIds: ['item-2'],
  itemCount: 1,
  createdAt: '2026-08-01T09:00:00.000Z',
};

const detail: PublicOutfitDetail = {
  id: 'outfit-1',
  userId: 'user-1',
  name: 'Rainy Monday',
  itemIds: ['item-1', 'item-2'],
  itemCount: 2,
  items: [jacket, shoes],
  createdAt: '2026-08-02T10:00:00.000Z',
};

afterEach(() => {
  jest.restoreAllMocks();
});

describe('outfits api', () => {
  it('sends the auth token on every call', async () => {
    // One assertion per verb rather than one per function: the token is what
    // ownership derives from server-side, so a call that forgets it is a 401
    // and there is no other place this could be caught.
    const spy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify({ outfit, outfits: [] }), { status: 200 }));

    await createOutfit({ token: 'tok-abc', itemIds: ['item-1'] });
    await fetchOutfits({ token: 'tok-abc' });
    await fetchOutfit('outfit-1', 'tok-abc');
    await updateOutfit('outfit-1', { token: 'tok-abc', name: 'New' });
    await deleteOutfit('outfit-1', 'tok-abc');

    expect(spy).toHaveBeenCalledTimes(5);
    for (let call = 0; call < 5; call += 1) {
      expect(requestedHeaders(spy, call).Authorization).toBe('Bearer tok-abc');
    }
  });
});

describe('fetchOutfits', () => {
  it('omits limit and cursor entirely when not supplied', async () => {
    // The API never coerces an empty parameter to a default: `?limit=` fails
    // its digits check and `?cursor=` fails to decode, so both answer 400. A
    // client that interpolates `?limit=${limit ?? ''}` therefore breaks on
    // page one. The URL must carry no query string at all.
    const spy = mockFetch({ outfits: [] });

    await fetchOutfits({ token: 'tok-abc' });

    expect(requestedUrl(spy)).toBe(`${API_BASE_URL}/outfits`);
  });

  it('includes cursor and limit when supplied', async () => {
    const spy = mockFetch({ outfits: [] });

    await fetchOutfits({ token: 'tok-abc', cursor: 'Y3Vyc29y', limit: 12 });

    const url = new URL(requestedUrl(spy));
    expect(url.pathname).toBe('/outfits');
    expect(url.searchParams.get('cursor')).toBe('Y3Vyc29y');
    expect(url.searchParams.get('limit')).toBe('12');
  });

  it('url-encodes the cursor', async () => {
    // The cursor is opaque. base64url happens to avoid '+' and '/', but
    // nothing in this layer may depend on that — a cursor is whatever the
    // server said it was, and interpolating it raw would corrupt it silently.
    const spy = mockFetch({ outfits: [] });

    await fetchOutfits({ token: 'tok-abc', cursor: 'a+b/c==' });

    const url = requestedUrl(spy);
    expect(url).toContain('cursor=a%2Bb%2Fc%3D%3D');
    expect(url).not.toContain('a+b/c==');
    expect(new URL(url).searchParams.get('cursor')).toBe('a+b/c==');
  });

  it('returns outfits and nextCursor', async () => {
    mockFetch({ outfits: [outfit, unnamed], nextCursor: 'bmV4dA' });

    await expect(fetchOutfits({ token: 'tok-abc' })).resolves.toEqual({
      outfits: [outfit, unnamed],
      nextCursor: 'bmV4dA',
    });
  });

  it('leaves nextCursor undefined on the final page', async () => {
    // `GET /outfits` spreads the key in conditionally, so "no more pages" is
    // `nextCursor === undefined` and never `null`.
    mockFetch({ outfits: [outfit] });

    const page = await fetchOutfits({ token: 'tok-abc' });

    expect(page.outfits).toEqual([outfit]);
    expect(page.nextCursor).toBeUndefined();
  });

  it('propagates ApiClientError', async () => {
    mockFetch({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);

    await expect(fetchOutfits({ token: null })).rejects.toBeInstanceOf(ApiClientError);
    await expect(fetchOutfits({ token: null })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      status: 401,
    });
  });
});

describe('createOutfit', () => {
  it('posts name and itemIds', async () => {
    const spy = mockFetch({ outfit }, 201);

    await createOutfit({ token: 'tok-abc', name: 'Rainy Monday', itemIds: ['item-1', 'item-2'] });

    expect(requestedUrl(spy)).toBe(`${API_BASE_URL}/outfits`);
    expect(requestedInit(spy).method).toBe('POST');
    expect(requestedBody(spy)).toEqual({ name: 'Rainy Monday', itemIds: ['item-1', 'item-2'] });
  });

  it('preserves the order the items were composed in', async () => {
    // The order is meaningful and the API reapplies it on read: "top,
    // trousers, shoes" reads correctly and "shoes, top, trousers" does not.
    // A client that sorted or Set-deduped here would lose it before the wire.
    const spy = mockFetch({ outfit }, 201);

    await createOutfit({ token: 'tok-abc', itemIds: ['item-2', 'item-1'] });

    expect(requestedBody(spy)).toEqual({ itemIds: ['item-2', 'item-1'] });
  });

  it('omits name from the POST body when not supplied', async () => {
    // Not `name: undefined` and not `name: ''`. `JSON.stringify` would drop an
    // explicit `undefined` anyway, but `''` is a *different request* — it is
    // how a name is cleared — so the two must not be conflated even here,
    // where the outfit has no name to clear.
    const spy = mockFetch({ outfit: unnamed }, 201);

    await createOutfit({ token: 'tok-abc', itemIds: ['item-2'] });

    const body = requestedBody(spy);
    expect(body).toEqual({ itemIds: ['item-2'] });
    expect(Object.keys(body as object)).not.toContain('name');
  });

  it('unwraps the created outfit from its envelope', async () => {
    // `POST /outfits` answers `201 { outfit }` with the light shape — a cover
    // and a count, not resolved items. Task 4's composer navigates straight to
    // the gallery with this, so the envelope must not leak out of this layer.
    mockFetch({ outfit }, 201);

    await expect(createOutfit({ token: 'tok-abc', itemIds: ['item-1'] })).resolves.toEqual(outfit);
  });

  it('propagates ApiClientError', async () => {
    mockFetch(
      {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Unknown item',
          fields: [{ path: 'itemIds', message: 'One or more items could not be found' }],
        },
      },
      400,
    );

    await expect(createOutfit({ token: 'tok-abc', itemIds: ['nope'] })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 400,
      fields: [{ path: 'itemIds', message: 'One or more items could not be found' }],
    });
  });
});

describe('fetchOutfit', () => {
  it('requests the outfit by id and unwraps it', async () => {
    const spy = mockFetch({ outfit: detail });

    await expect(fetchOutfit('outfit-1', 'tok-abc')).resolves.toEqual(detail);

    expect(requestedUrl(spy)).toBe(`${API_BASE_URL}/outfits/outfit-1`);
    expect(requestedInit(spy).method ?? 'GET').toBe('GET');
  });

  it('url-encodes the id', async () => {
    // An id that is not a well-formed ObjectId must reach the route and get
    // its 404, not silently address some other path.
    const spy = mockFetch({ outfit: detail });

    await fetchOutfit('../auth/me', 'tok-abc');

    expect(requestedUrl(spy)).toBe(`${API_BASE_URL}/outfits/..%2Fauth%2Fme`);
  });

  it('propagates ApiClientError', async () => {
    mockFetch({ error: { code: 'NOT_FOUND', message: 'Outfit not found' } }, 404);

    await expect(fetchOutfit('outfit-1', 'tok-abc')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });
});

describe('updateOutfit', () => {
  it('patches only the fields supplied', async () => {
    const spy = mockFetch({ outfit: detail });

    await updateOutfit('outfit-1', { token: 'tok-abc', itemIds: ['item-2', 'item-1'] });

    expect(requestedUrl(spy)).toBe(`${API_BASE_URL}/outfits/outfit-1`);
    expect(requestedInit(spy).method).toBe('PATCH');
    expect(requestedBody(spy)).toEqual({ itemIds: ['item-2', 'item-1'] });
  });

  it('sends an empty name to clear it, and omits the key to leave it alone', async () => {
    // These are two different operations server-side and the difference is
    // exactly "did the client send the key". `name: ''` clears the name; an
    // omitted `name` leaves it untouched. Collapsing them would mean either a
    // rename can never be partial or a name can never be removed.
    const spy = mockFetch({ outfit: detail });

    await updateOutfit('outfit-1', { token: 'tok-abc', name: '' });
    await updateOutfit('outfit-1', { token: 'tok-abc', itemIds: ['item-1'] });

    expect(requestedBody(spy, 0)).toEqual({ name: '' });
    expect(Object.keys(requestedBody(spy, 1) as object)).not.toContain('name');
  });

  it('refuses an empty patch without issuing a request', async () => {
    // `PATCH` with neither key is a 400 ("Nothing to update"). Spending a
    // round trip to be told so is waste — but the short-circuit only earns its
    // place if it is indistinguishable from the answer it replaces, so the
    // message, the status and the field error are all asserted against the
    // ones `apps/api/src/routes/outfits.ts` actually sends. Asserting only the
    // code would let this drift into a *different* error that happens to share
    // a name, which is worse than the round trip.
    const spy = mockFetch({ outfit: detail });

    const attempt = updateOutfit('outfit-1', { token: 'tok-abc' });

    await expect(attempt).rejects.toBeInstanceOf(ApiClientError);
    await expect(attempt).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'Nothing to update',
      status: 400,
      fields: [{ path: '(body)', message: 'Provide at least one of name or itemIds' }],
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('url-encodes the id', async () => {
    const spy = mockFetch({ outfit: detail });

    await updateOutfit('../auth/me', { token: 'tok-abc', name: 'x' });

    expect(requestedUrl(spy)).toBe(`${API_BASE_URL}/outfits/..%2Fauth%2Fme`);
  });

  it('propagates ApiClientError', async () => {
    mockFetch({ error: { code: 'NOT_FOUND', message: 'Outfit not found' } }, 404);

    await expect(updateOutfit('outfit-1', { token: 'tok-abc', name: 'x' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });
});

describe('deleteOutfit', () => {
  it('sends DELETE and resolves on 204 with no body', async () => {
    // `DELETE /outfits/:id` answers 204 with no body at all — no
    // Content-Length, no Transfer-Encoding, nothing to parse. `res.json()`
    // rejects on that and `JSON.parse('')` throws, so a client that parses
    // unconditionally turns a *successful* delete into an error the user sees.
    // The stub's `json()` throws so that calling it fails loudly rather than
    // silently succeeding on some other implementation's behalf.
    const json = jest.fn(async () => {
      throw new Error('json() must not be called on a 204');
    });
    const spy = jest.spyOn(global, 'fetch').mockImplementation(
      async () =>
        ({
          ok: true,
          status: 204,
          text: async () => '',
          json,
        }) as unknown as Response,
    );

    await expect(deleteOutfit('outfit-1', 'tok-abc')).resolves.toBeUndefined();

    expect(json).not.toHaveBeenCalled();
    expect(requestedUrl(spy)).toBe(`${API_BASE_URL}/outfits/outfit-1`);
    expect(requestedInit(spy).method).toBe('DELETE');
    expect(requestedInit(spy).body).toBeUndefined();
  });

  it('resolves against a real empty 204 Response', async () => {
    // The test above hand-rolls the response so it can prove `json()` is never
    // reached. This one runs the same path against the platform's own
    // `Response`, so the empty-body handling is pinned against real semantics
    // rather than against a stub that agrees with the implementation.
    jest.spyOn(global, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }));

    await expect(deleteOutfit('outfit-1', 'tok-abc')).resolves.toBeUndefined();
  });

  it('url-encodes the id', async () => {
    const spy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async () => new Response(null, { status: 204 }));

    await deleteOutfit('../auth/me', 'tok-abc');

    expect(requestedUrl(spy)).toBe(`${API_BASE_URL}/outfits/..%2Fauth%2Fme`);
  });

  it('propagates ApiClientError', async () => {
    mockFetch({ error: { code: 'NOT_FOUND', message: 'Outfit not found' } }, 404);

    await expect(deleteOutfit('outfit-1', 'tok-abc')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });
});
