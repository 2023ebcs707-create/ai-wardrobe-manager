import type { PublicClothingItem } from '@wardrobe/shared';
// The real client runs here on purpose. A bare `jest.mock('../api/client')`
// automocks `ApiClientError` as well, and Jest's automock of a class that
// `extends Error` does not run the real constructor — the resulting object has
// no `.code` and is not `instanceof Error`, so `propagates ApiClientError`
// below could never pass. Stage 2 lost time to exactly that. `fetch` is the
// seam instead (the same one `src/api/client.test.ts` uses).
import { ApiClientError } from '../api/client';
import { API_BASE_URL } from '../config';
import { deleteItem, fetchItem, fetchItems, setRetired } from './api';

// A fresh Response per call: a `Response` body can only be read once, so a
// single `mockResolvedValue` instance makes the *second* call in a test fail
// with "Body is unusable" rather than with whatever the test is checking.
function mockFetch(body: unknown, status = 200): jest.SpyInstance {
  return jest
    .spyOn(global, 'fetch')
    .mockImplementation(async () => new Response(JSON.stringify(body), { status }));
}

function requestedUrl(spy: jest.SpyInstance): string {
  return String(spy.mock.calls[0][0]);
}

function requestedHeaders(spy: jest.SpyInstance): Record<string, string> {
  return (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
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

// An item uploaded before Stage 4 has no thumbnail. Both shapes are valid and
// the grid, not this layer, decides what to draw when it is missing.
const shoes: PublicClothingItem = {
  id: 'item-2',
  userId: 'user-1',
  imageUrl: 'https://example.test/item-2.jpg',
  category: 'shoes',
  colors: [],
  seasons: [],
  laundryStatus: 'in_laundry',
  retired: false,
  wearCount: 0,
  source: 'manual',
  createdAt: '2026-07-30T09:00:00.000Z',
};

afterEach(() => {
  jest.restoreAllMocks();
});

describe('fetchItems', () => {
  it('sends the auth token', async () => {
    const spy = mockFetch({ items: [] });

    await fetchItems({ token: 'tok-abc' });

    expect(requestedHeaders(spy).Authorization).toBe('Bearer tok-abc');
  });

  it('omits the category parameter entirely when no category is set', async () => {
    // The API never coerces an empty parameter to a default: `?category=` is
    // not a valid category, `?limit=` fails the digits check and `?cursor=`
    // fails to decode, so all three 400. A client that interpolates
    // `?category=${category ?? ''}` therefore breaks on page one. The URL must
    // carry no query string at all.
    const spy = mockFetch({ items: [] });

    await fetchItems({ token: 'tok-abc' });

    expect(requestedUrl(spy)).toBe(`${API_BASE_URL}/items`);
  });

  it('includes category, cursor and limit when supplied', async () => {
    const spy = mockFetch({ items: [] });

    await fetchItems({ token: 'tok-abc', category: 'shoes', cursor: 'Y3Vyc29y', limit: 12 });

    const url = new URL(requestedUrl(spy));
    expect(url.pathname).toBe('/items');
    expect(url.searchParams.get('category')).toBe('shoes');
    expect(url.searchParams.get('cursor')).toBe('Y3Vyc29y');
    expect(url.searchParams.get('limit')).toBe('12');
  });

  it('url-encodes the cursor', async () => {
    // The cursor is opaque. base64url happens to avoid '+' and '/', but
    // nothing in this layer may depend on that — a cursor is whatever the
    // server said it was, and interpolating it raw would corrupt it silently.
    const spy = mockFetch({ items: [] });

    await fetchItems({ token: 'tok-abc', cursor: 'a+b/c==' });

    const url = requestedUrl(spy);
    expect(url).toContain('cursor=a%2Bb%2Fc%3D%3D');
    expect(url).not.toContain('a+b/c==');
    expect(new URL(url).searchParams.get('cursor')).toBe('a+b/c==');
  });

  it('returns items and nextCursor', async () => {
    mockFetch({ items: [jacket, shoes], nextCursor: 'bmV4dA' });

    await expect(fetchItems({ token: 'tok-abc' })).resolves.toEqual({
      items: [jacket, shoes],
      nextCursor: 'bmV4dA',
    });
  });

  it('leaves nextCursor undefined on the final page', async () => {
    // The API omits the key rather than sending null, so "no more pages" is
    // `nextCursor === undefined` and must not be read as a valid cursor.
    mockFetch({ items: [jacket] });

    const page = await fetchItems({ token: 'tok-abc' });

    expect(page.items).toEqual([jacket]);
    expect(page.nextCursor).toBeUndefined();
  });

  it('propagates ApiClientError', async () => {
    mockFetch({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);

    await expect(fetchItems({ token: null })).rejects.toBeInstanceOf(ApiClientError);
    await expect(fetchItems({ token: null })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      status: 401,
    });
  });
});

describe('fetchItem', () => {
  it('requests the item by id and unwraps it', async () => {
    const spy = mockFetch({ item: jacket });

    await expect(fetchItem('item-1', 'tok-abc')).resolves.toEqual(jacket);

    expect(requestedUrl(spy)).toBe(`${API_BASE_URL}/items/item-1`);
    expect(requestedHeaders(spy).Authorization).toBe('Bearer tok-abc');
  });

  it('url-encodes the id', async () => {
    const spy = mockFetch({ item: jacket });

    await fetchItem('../auth/me', 'tok-abc');

    expect(requestedUrl(spy)).toBe(`${API_BASE_URL}/items/..%2Fauth%2Fme`);
  });

  it('propagates ApiClientError', async () => {
    mockFetch({ error: { code: 'NOT_FOUND', message: 'Item not found' } }, 404);

    await expect(fetchItem('item-1', 'tok-abc')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });
});

describe('setRetired', () => {
  it('PATCHes the retire sub-path and unwraps the item', async () => {
    const retired = { ...jacket, retired: true };
    const spy = mockFetch({ item: retired });

    await expect(setRetired('item-1', { token: 'tok-abc', retired: true })).resolves.toEqual(
      retired,
    );

    expect(requestedUrl(spy)).toBe(`${API_BASE_URL}/items/item-1/retire`);
    const init = spy.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ retired: true });
    expect(requestedHeaders(spy).Authorization).toBe('Bearer tok-abc');
  });

  it('sends false as false, so un-retiring is reachable', async () => {
    const spy = mockFetch({ item: jacket });

    await setRetired('item-1', { token: 'tok-abc', retired: false });

    expect(JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      retired: false,
    });
  });

  it('url-encodes the id', async () => {
    const spy = mockFetch({ item: jacket });

    await setRetired('../auth/me', { token: 'tok-abc', retired: true });

    expect(requestedUrl(spy)).toBe(`${API_BASE_URL}/items/..%2Fauth%2Fme/retire`);
  });

  it('propagates ApiClientError', async () => {
    mockFetch({ error: { code: 'NOT_FOUND', message: 'Item not found' } }, 404);

    await expect(setRetired('item-1', { token: 'tok-abc', retired: true })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });
});

describe('deleteItem', () => {
  it('DELETEs the item and reads no body', async () => {
    // `DELETE /items/:id` answers 204 with no body at all. `apiRequest` reads
    // it as text and only parses when non-empty — a client that parsed
    // unconditionally would turn every successful delete into an error.
    const spy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async () => new Response(null, { status: 204 }));

    await expect(deleteItem('item-1', 'tok-abc')).resolves.toBeUndefined();

    expect(String(spy.mock.calls[0][0])).toBe(`${API_BASE_URL}/items/item-1`);
    expect((spy.mock.calls[0][1] as RequestInit).method).toBe('DELETE');
  });

  it('url-encodes the id', async () => {
    const spy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async () => new Response(null, { status: 204 }));

    await deleteItem('../auth/me', 'tok-abc');

    expect(String(spy.mock.calls[0][0])).toBe(`${API_BASE_URL}/items/..%2Fauth%2Fme`);
  });

  it('propagates ApiClientError rather than resolving on a 404', async () => {
    // The route is deliberately NOT idempotent-silent, so a caller must not
    // retry blindly on failure.
    mockFetch({ error: { code: 'NOT_FOUND', message: 'Item not found' } }, 404);

    await expect(deleteItem('item-1', 'tok-abc')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });
});
