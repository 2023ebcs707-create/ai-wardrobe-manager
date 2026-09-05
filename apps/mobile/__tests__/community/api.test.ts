import type { PublicClothingItem, PublicPost } from '@wardrobe/shared';
// The real client runs here on purpose. A bare `jest.mock('../../src/api/client')`
// automocks `ApiClientError` as well, and Jest's automock of a class that
// `extends Error` does not run the real constructor — the resulting object has
// no `.code` and is not `instanceof Error`, so `propagates ApiClientError`
// below could never pass. `fetch` is the seam.
import { ApiClientError } from '../../src/api/client';
import { API_BASE_URL } from '../../src/config';
import {
  deletePost,
  fetchFeed,
  fetchSavedPosts,
  likePost,
  savePost,
  sharePost,
  unlikePost,
  unsavePost,
} from '../../src/community/api';

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
  id: 'item-1',
  userId: 'author-1',
  imageUrl: 'https://example.test/item-1.jpg',
  category: 'shirt',
  colors: [],
  seasons: [],
  laundryStatus: 'available',
  retired: false,
  wearCount: 0,
  source: 'ai',
  createdAt: '2026-08-01T10:00:00.000Z',
};

const post: PublicPost = {
  id: 'post-1',
  author: { id: 'author-1', name: 'Ada' },
  itemIds: ['item-1'],
  items: [shirt],
  caption: 'Rainy Monday',
  likeCount: 3,
  liked: false,
  saved: false,
  createdAt: '2026-08-20T10:00:00.000Z',
};

afterEach(() => {
  jest.restoreAllMocks();
});

describe('community api', () => {
  it('sends the auth token on every call', async () => {
    // One assertion per verb rather than one per function. Every one of these
    // eight endpoints is behind `requireAuth`, and the token is also what the
    // viewer-relative `liked`/`saved` flags are computed from — so a call that
    // forgets it is a 401 and there is no other place this could be caught.
    const spy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(
        async () => new Response(JSON.stringify({ post, posts: [], likeCount: 0, liked: false, saved: false }), { status: 200 }),
      );

    await fetchFeed({ token: 'tok-abc' });
    await fetchSavedPosts({ token: 'tok-abc' });
    await sharePost({ token: 'tok-abc', outfitId: 'outfit-1', caption: 'hi' });
    await likePost('post-1', 'tok-abc');
    await unlikePost('post-1', 'tok-abc');
    await savePost('post-1', 'tok-abc');
    await unsavePost('post-1', 'tok-abc');
    await deletePost('post-1', 'tok-abc');

    expect(spy).toHaveBeenCalledTimes(8);
    for (let call = 0; call < 8; call += 1) {
      expect(requestedHeaders(spy, call).Authorization).toBe('Bearer tok-abc');
    }
  });

  it('never sends a limit on either list endpoint', async () => {
    // Not an aesthetic point about tidy URLs. At `limit=100` a single feed
    // request issues up to 100 concurrent item lookups server-side, which is
    // the MongoDB driver's default pool size — so raising the page size for
    // "fewer round trips" buys a request that can occupy the whole pool. There
    // is no `limit` option on either function to pass, and this asserts that
    // no default one is smuggled into the query either.
    const spy = mockFetch({ posts: [] });

    await fetchFeed({ token: 'tok-abc', cursor: 'Y3Vyc29y', q: 'blue' });
    await fetchSavedPosts({ token: 'tok-abc', cursor: 'Y3Vyc29y' });

    expect(new URL(requestedUrl(spy, 0)).searchParams.has('limit')).toBe(false);
    expect(new URL(requestedUrl(spy, 1)).searchParams.has('limit')).toBe(false);
  });
});

describe('fetchFeed', () => {
  it('omits cursor and q entirely when not supplied', async () => {
    // `?cursor=` fails to decode and answers 400, so a client that
    // interpolates `?cursor=${cursor ?? ''}` breaks on page one. The URL must
    // carry no query string at all.
    const spy = mockFetch({ posts: [] });

    await fetchFeed({ token: 'tok-abc' });

    expect(requestedUrl(spy)).toBe(`${API_BASE_URL}/community/posts`);
  });

  it('omits q when the term is blank or only whitespace', async () => {
    // An empty search box is not a search for the empty string. The route
    // treats `?q=` and `?q=%20` as "no filter" anyway, so sending one is a
    // parameter that means nothing — and it would make every "did the search
    // change?" assertion in the hook tests read a URL that always has a `q`.
    const spy = mockFetch({ posts: [] });

    await fetchFeed({ token: 'tok-abc', q: '' });
    await fetchFeed({ token: 'tok-abc', q: '   ' });

    expect(requestedUrl(spy, 0)).toBe(`${API_BASE_URL}/community/posts`);
    expect(requestedUrl(spy, 1)).toBe(`${API_BASE_URL}/community/posts`);
  });

  it('trims the search term and percent-encodes it', async () => {
    // `q` is free text: a user can type a space, an ampersand or a '+', and
    // '+' decodes to a space server-side if it is interpolated raw — so
    // searching for "a + b" would silently become a search for "a   b".
    const spy = mockFetch({ posts: [] });

    await fetchFeed({ token: 'tok-abc', q: '  navy & a+b  ' });

    const url = requestedUrl(spy);
    expect(url).toContain('q=navy+%26+a%2Bb');
    expect(new URL(url).searchParams.get('q')).toBe('navy & a+b');
  });

  it('url-encodes the cursor', async () => {
    // The cursor is opaque. base64url happens to avoid '+' and '/', but
    // nothing in this layer may depend on that.
    const spy = mockFetch({ posts: [] });

    await fetchFeed({ token: 'tok-abc', cursor: 'a+b/c==' });

    const url = requestedUrl(spy);
    expect(url).toContain('cursor=a%2Bb%2Fc%3D%3D');
    expect(new URL(url).searchParams.get('cursor')).toBe('a+b/c==');
  });

  it('returns posts and nextCursor', async () => {
    mockFetch({ posts: [post], nextCursor: 'bmV4dA' });

    await expect(fetchFeed({ token: 'tok-abc' })).resolves.toEqual({
      posts: [post],
      nextCursor: 'bmV4dA',
    });
  });

  it('leaves nextCursor undefined on the final page', async () => {
    // The route spreads the key in conditionally, so "no more pages" is
    // `nextCursor === undefined` and never `null`.
    mockFetch({ posts: [post] });

    const page = await fetchFeed({ token: 'tok-abc' });

    expect(page.nextCursor).toBeUndefined();
  });

  it('propagates ApiClientError', async () => {
    mockFetch(
      { error: { code: 'VALIDATION_FAILED', message: 'Malformed search term' } },
      400,
    );

    await expect(fetchFeed({ token: 'tok-abc', q: 'x' })).rejects.toBeInstanceOf(ApiClientError);
    await expect(fetchFeed({ token: 'tok-abc', q: 'x' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 400,
    });
  });
});

describe('fetchSavedPosts', () => {
  it('hits the owner-scoped saved route with no query when no cursor is given', async () => {
    const spy = mockFetch({ posts: [] });

    await fetchSavedPosts({ token: 'tok-abc' });

    expect(requestedUrl(spy)).toBe(`${API_BASE_URL}/community/saved`);
  });

  it('sends the cursor when supplied', async () => {
    const spy = mockFetch({ posts: [] });

    await fetchSavedPosts({ token: 'tok-abc', cursor: 'Y3Vyc29y' });

    expect(new URL(requestedUrl(spy)).searchParams.get('cursor')).toBe('Y3Vyc29y');
  });
});

describe('sharePost', () => {
  it('posts outfitId and caption and unwraps the envelope into a card-shaped post', async () => {
    const spy = mockFetch({ post }, 201);

    const shared = await sharePost({
      token: 'tok-abc',
      outfitId: 'outfit-1',
      caption: 'Rainy Monday',
    });

    // Not the wire post. `sharePost` answers a `DisplayPost`, the same rows
    // the two list hooks hand out.
    expect(shared).toEqual({
      id: 'post-1',
      author: { id: 'author-1', name: 'Ada' },
      items: [shirt],
      caption: 'Rainy Monday',
      likeCount: 3,
      liked: false,
      saved: false,
      createdAt: '2026-08-20T10:00:00.000Z',
      missingItemsNotice: null,
    });

    expect(requestedUrl(spy)).toBe(`${API_BASE_URL}/community/posts`);
    expect(requestedInit(spy).method).toBe('POST');
    expect(JSON.parse(String(requestedInit(spy).body))).toEqual({
      outfitId: 'outfit-1',
      caption: 'Rainy Monday',
    });
  });

  it('does not hand back itemIds, so a confirmation card cannot pair the two arrays', async () => {
    // THE FIREWALL HAS TO HOLD ON THIS PATH TOO. The obvious use of this
    // return value is a "shared!" card rendered without refetching, and the
    // obvious way to write that card wrong is `items[i]` beside `itemIds[i]`.
    // The wire post here names three snapshot ids and resolves two garments,
    // so the arrays are genuinely different lengths and the pairing would be
    // off by one from the first gap onwards. Not handing over the other array
    // is the only thing that stops it; a warning in a doc comment is not.
    mockFetch(
      {
        post: {
          ...post,
          itemIds: ['item-1', 'item-gone', 'item-also-gone'],
          items: [shirt],
        },
      },
      201,
    );

    const shared = await sharePost({
      token: 'tok-abc',
      outfitId: 'outfit-1',
      caption: 'Rainy Monday',
    });

    expect(shared).not.toHaveProperty('itemIds');
    expect(Object.keys(shared)).not.toContain('itemIds');
    // The type-level half, which is the one that refuses a future edit rather
    // than merely noticing it: `@ts-expect-error` fails the typecheck if the
    // property ever becomes readable again.
    // @ts-expect-error `sharePost` must not answer with the snapshot id list.
    expect(shared.itemIds).toBeUndefined();

    // The capability `itemIds` was kept uncompacted FOR is carried across as
    // the one sanctioned sentence, so nothing is lost by dropping the array.
    expect(shared.missingItemsNotice).toBe('2 items are no longer available');
  });
});

describe('like and save', () => {
  it('POSTs and DELETEs the like sub-resource and returns the count', async () => {
    const spy = mockFetch({ likeCount: 4, liked: true });

    await expect(likePost('post-1', 'tok-abc')).resolves.toEqual({ likeCount: 4, liked: true });
    await expect(unlikePost('post-1', 'tok-abc')).resolves.toEqual({ likeCount: 4, liked: true });

    expect(requestedUrl(spy, 0)).toBe(`${API_BASE_URL}/community/posts/post-1/like`);
    expect(requestedInit(spy, 0).method).toBe('POST');
    expect(requestedUrl(spy, 1)).toBe(`${API_BASE_URL}/community/posts/post-1/like`);
    expect(requestedInit(spy, 1).method).toBe('DELETE');
  });

  it('POSTs and DELETEs the save sub-resource', async () => {
    const spy = mockFetch({ saved: true });

    await expect(savePost('post-1', 'tok-abc')).resolves.toEqual({ saved: true });
    await expect(unsavePost('post-1', 'tok-abc')).resolves.toEqual({ saved: true });

    expect(requestedUrl(spy, 0)).toBe(`${API_BASE_URL}/community/posts/post-1/save`);
    expect(requestedInit(spy, 0).method).toBe('POST');
    expect(requestedInit(spy, 1).method).toBe('DELETE');
  });

  it('encodes the post id rather than interpolating it', async () => {
    // An id that is not a well-formed ObjectId must reach the route and get
    // its 404. Interpolated raw, `../..` walks the URL out of the sub-resource
    // and addresses something else entirely.
    const spy = mockFetch({ likeCount: 0, liked: false });

    await likePost('../../items', 'tok-abc');

    expect(requestedUrl(spy)).toBe(
      `${API_BASE_URL}/community/posts/..%2F..%2Fitems/like`,
    );
  });
});

describe('deletePost', () => {
  it('DELETEs the post and resolves on a 204 with no body', async () => {
    // 204 means `res.text()` is the empty string, which `apiRequest` turns
    // into `{}` rather than throwing on `JSON.parse('')`. A client that
    // insisted on a body here would report every successful delete as a
    // failure.
    const spy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async () => new Response(null, { status: 204 }));

    await expect(deletePost('post-1', 'tok-abc')).resolves.toBeUndefined();

    expect(requestedUrl(spy)).toBe(`${API_BASE_URL}/community/posts/post-1`);
    expect(requestedInit(spy).method).toBe('DELETE');
  });

  it('propagates the 404 a foreign or missing post answers with', async () => {
    mockFetch({ error: { code: 'NOT_FOUND', message: 'Post not found' } }, 404);

    await expect(deletePost('post-1', 'tok-abc')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });
});
