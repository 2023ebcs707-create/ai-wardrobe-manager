import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { PublicClothingItem, PublicPost } from '@wardrobe/shared';
// The real `ApiClientError` — not a mock. Automocking a class that extends
// Error yields something that cannot be constructed, which is why
// `src/api/client` is never `jest.mock`ed anywhere in this repo.
import { ApiClientError } from '../../src/api/client';
import { useAuth } from '../../src/auth/AuthContext';
import {
  deletePost,
  fetchFeed,
  likePost,
  savePost,
  unlikePost,
  unsavePost,
  type PostLikeResult,
  type PostSaveResult,
  type PostsPage,
} from '../../src/community/api';
import {
  COMMUNITY_READERS,
  consumeCommunityDirty,
} from '../../src/community/communityDirty';
import { SEARCH_DEBOUNCE_MS, useCommunityFeed } from '../../src/community/useCommunityFeed';

// `./api` exports plain functions and (erased) interfaces — no class — so a
// factory mock here is safe in the way a mock of `../../src/api/client` would
// not be. Mocking at this boundary keeps these tests about state machinery
// rather than about URLs, which `api.test.ts` already pins down against the
// real `fetch`.
jest.mock('../../src/community/api', () => ({
  fetchFeed: jest.fn(),
  fetchSavedPosts: jest.fn(),
  sharePost: jest.fn(),
  likePost: jest.fn(),
  unlikePost: jest.fn(),
  savePost: jest.fn(),
  unsavePost: jest.fn(),
  deletePost: jest.fn(),
}));

// Only `useAuth` is used here, so the real module (and its expo-secure-store
// dependency) is never loaded.
jest.mock('../../src/auth/AuthContext', () => ({
  useAuth: jest.fn(),
}));

const mockedFetchFeed = jest.mocked(fetchFeed);
const mockedLikePost = jest.mocked(likePost);
const mockedUnlikePost = jest.mocked(unlikePost);
const mockedSavePost = jest.mocked(savePost);
const mockedUnsavePost = jest.mocked(unsavePost);
const mockedDeletePost = jest.mocked(deletePost);
const mockedUseAuth = jest.mocked(useAuth);

const apiMocks = [
  mockedFetchFeed,
  mockedLikePost,
  mockedUnlikePost,
  mockedSavePost,
  mockedUnsavePost,
  mockedDeletePost,
];

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

function item(id: string): PublicClothingItem {
  return {
    id,
    userId: 'author-1',
    imageUrl: `https://example.test/${id}.jpg`,
    category: 'shirt',
    colors: [],
    seasons: [],
    laundryStatus: 'available',
    retired: false,
    wearCount: 0,
    source: 'ai',
    createdAt: '2026-08-01T10:00:00.000Z',
  };
}

const shirt = item('item-1');
const trousers = item('item-2');

function post(id: string, overrides: Partial<PublicPost> = {}): PublicPost {
  return {
    id,
    author: { id: 'author-1', name: 'Ada' },
    itemIds: [shirt.id, trousers.id],
    items: [shirt, trousers],
    caption: `caption for ${id}`,
    likeCount: 3,
    liked: false,
    saved: false,
    createdAt: '2026-08-20T10:00:00.000Z',
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
 *  resolving to `undefined` and dying inside the hook — failing loudly, but
 *  for a reason that is not the one the test is named for. */
function stallSurplusFeedRequests() {
  mockedFetchFeed.mockImplementation(() => new Promise(() => {}));
}

function stallSurplusLikes() {
  mockedLikePost.mockImplementation(() => new Promise(() => {}));
  mockedUnlikePost.mockImplementation(() => new Promise(() => {}));
}

// Two RNTL 14 rules this file depends on:
//
// 1. `renderHook` is async and must be awaited. Unawaited, `result` is a
//    promise and every `result.current` read throws.
// 2. Every `act` must be `await act(async () => …)`. RNTL exposes the hook's
//    value through a ref assigned inside a `useEffect`, and the synchronous
//    `act(() => …)` form does not flush that effect, so `result.current` stays
//    on the *previous* commit and an assertion made right after a state change
//    silently reads the old value.

beforeEach(() => {
  // Targeted `mockReset` on this file's OWN factory mocks, never
  // `jest.resetAllMocks()` — that one strips the implementations off
  // jest-expo's setup mocks and the next `@expo/vector-icons` mount fails with
  // `Module "1" is missing from the asset registry`. It is needed at all
  // because several tests install a lasting `mockImplementation` (see
  // `stallSurplus…`), which `clearAllMocks` does not remove.
  apiMocks.forEach((mock) => mock.mockReset());
  mockedUseAuth.mockReset();
  mockedUseAuth.mockReturnValue(authValue(TOKEN));
  // Drained through the public door, so these tests use the same mechanism the
  // app does. Module scope means the flag survives between tests in this file.
  COMMUNITY_READERS.forEach((reader) => consumeCommunityDirty(reader));
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('useCommunityFeed · loading', () => {
  it('loads page one on mount with no cursor and no search term', async () => {
    const pending = deferred<PostsPage>();
    mockedFetchFeed.mockReturnValueOnce(pending.promise);

    const { result } = await renderHook(() => useCommunityFeed());

    expect(result.current.activity).toBe('loading');
    expect(result.current.posts).toEqual([]);
    expect(result.current.error).toBeNull();
    // Neither key is present. `?cursor=` is a 400 rather than "page one", and
    // a blank `q` is a parameter that means nothing.
    expect(mockedFetchFeed).toHaveBeenCalledWith({ token: TOKEN });

    await act(async () => {
      pending.resolve({ posts: [post('post-1')] });
    });

    expect(result.current.activity).toBe('idle');
    expect(result.current.posts.map((entry) => entry.id)).toEqual(['post-1']);
  });

  it('sends nothing that narrows the feed to the signed-in user', async () => {
    // Ruling 2's client half. Every other list hook in this app is
    // owner-scoped, so the shape of the mistake here is a one-line filter that
    // looks exactly like `useWardrobe`'s — and it would turn a community feed
    // into an audience of one. The request may carry a token and a cursor and
    // a search term, and nothing else.
    mockedFetchFeed.mockResolvedValueOnce({ posts: [] });

    await renderHook(() => useCommunityFeed());
    await waitFor(() => expect(mockedFetchFeed).toHaveBeenCalledTimes(1));

    expect(Object.keys(mockedFetchFeed.mock.calls[0][0])).toEqual(['token']);
  });

  it('renders posts from other users, including one whose author is gone', async () => {
    mockedFetchFeed.mockResolvedValueOnce({
      posts: [
        post('post-1', { author: { id: 'author-1', name: 'Ada' } }),
        post('post-2', { author: { id: 'author-2', name: 'Grace' } }),
        post('post-3', { author: { id: 'gone-1', name: 'Deleted user' } }),
      ],
    });

    const { result } = await renderHook(() => useCommunityFeed());
    await waitFor(() => expect(result.current.posts).toHaveLength(3));

    expect(result.current.posts.map((entry) => entry.author.name)).toEqual([
      'Ada',
      'Grace',
      // Passed through as the name it is. This layer cannot tell a tombstone
      // from a real user called "Deleted user", and must not pretend to.
      'Deleted user',
    ]);
  });

  it('keeps a post whose garments have all been deleted', async () => {
    // `items: []` is a successful answer, not a failure: the post still has a
    // caption and an author. A feed that drops it develops holes as users tidy
    // their wardrobes.
    mockedFetchFeed.mockResolvedValueOnce({
      posts: [post('post-1', { items: [] }), post('post-2')],
    });

    const { result } = await renderHook(() => useCommunityFeed());
    await waitFor(() => expect(result.current.posts).toHaveLength(2));

    expect(result.current.posts[0].items).toEqual([]);
    expect(result.current.posts[0].missingItemsNotice).toBe('2 items are no longer available');
    expect(result.current.posts[1].missingItemsNotice).toBeNull();
  });
});

describe('useCommunityFeed · paging', () => {
  it('appends the next page and reports hasMore from the cursor', async () => {
    mockedFetchFeed.mockResolvedValueOnce({ posts: [post('post-1')], nextCursor: 'cur-1' });

    const { result } = await renderHook(() => useCommunityFeed());
    await waitFor(() => expect(result.current.posts).toHaveLength(1));
    expect(result.current.hasMore).toBe(true);

    mockedFetchFeed.mockResolvedValueOnce({ posts: [post('post-2')] });
    await act(async () => {
      result.current.loadMore();
    });

    expect(mockedFetchFeed).toHaveBeenLastCalledWith({ token: TOKEN, cursor: 'cur-1' });
    expect(result.current.posts.map((entry) => entry.id)).toEqual(['post-1', 'post-2']);
    // The key is absent on the final page rather than null, so paging is off.
    expect(result.current.hasMore).toBe(false);
  });

  it('does not page when there is no cursor', async () => {
    mockedFetchFeed.mockResolvedValueOnce({ posts: [post('post-1')] });

    const { result } = await renderHook(() => useCommunityFeed());
    await waitFor(() => expect(result.current.posts).toHaveLength(1));

    await act(async () => {
      result.current.loadMore();
    });

    expect(mockedFetchFeed).toHaveBeenCalledTimes(1);
  });

  it('issues one request for a burst of onEndReached calls', async () => {
    // `onEndReached` fires many times through a single fling, and every
    // duplicate is a whole page the server computes and signs image URLs for.
    // The guard is a ref rather than state because all three calls land in one
    // frame, before React can commit anything a state flag would be read from.
    mockedFetchFeed.mockResolvedValueOnce({ posts: [post('post-1')], nextCursor: 'cur-1' });

    const { result } = await renderHook(() => useCommunityFeed());
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    const second = deferred<PostsPage>();
    stallSurplusFeedRequests();
    mockedFetchFeed.mockReturnValueOnce(second.promise);

    await act(async () => {
      result.current.loadMore();
      result.current.loadMore();
      result.current.loadMore();
    });

    expect(mockedFetchFeed).toHaveBeenCalledTimes(2);
    expect(result.current.activity).toBe('loadingMore');

    await act(async () => {
      second.resolve({ posts: [post('post-2')] });
    });
    expect(result.current.posts.map((entry) => entry.id)).toEqual(['post-1', 'post-2']);
  });

  it('does not page while a refresh is running', async () => {
    mockedFetchFeed.mockResolvedValueOnce({ posts: [post('post-1')], nextCursor: 'cur-1' });

    const { result } = await renderHook(() => useCommunityFeed());
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    const refreshing = deferred<PostsPage>();
    stallSurplusFeedRequests();
    mockedFetchFeed.mockReturnValueOnce(refreshing.promise);

    await act(async () => {
      result.current.refresh();
    });
    expect(result.current.activity).toBe('refreshing');

    await act(async () => {
      result.current.loadMore();
    });

    expect(mockedFetchFeed).toHaveBeenCalledTimes(2);

    await act(async () => {
      refreshing.resolve({ posts: [post('post-9')] });
    });
    expect(result.current.posts.map((entry) => entry.id)).toEqual(['post-9']);
  });
});

describe('useCommunityFeed · refresh', () => {
  it('replaces the list and keeps the previous rows on screen meanwhile', async () => {
    mockedFetchFeed.mockResolvedValueOnce({ posts: [post('post-1')] });

    const { result } = await renderHook(() => useCommunityFeed());
    await waitFor(() => expect(result.current.posts).toHaveLength(1));

    const refreshing = deferred<PostsPage>();
    mockedFetchFeed.mockReturnValueOnce(refreshing.promise);

    await act(async () => {
      result.current.refresh();
    });

    // A refresh is not a reset: the rows stay while the request is in flight.
    expect(result.current.activity).toBe('refreshing');
    expect(result.current.posts.map((entry) => entry.id)).toEqual(['post-1']);

    await act(async () => {
      refreshing.resolve({ posts: [post('post-2')] });
    });
    expect(result.current.posts.map((entry) => entry.id)).toEqual(['post-2']);
  });

  it('does not issue a second page-one request while one is already running', async () => {
    const first = deferred<PostsPage>();
    stallSurplusFeedRequests();
    mockedFetchFeed.mockReturnValueOnce(first.promise);

    const { result } = await renderHook(() => useCommunityFeed());

    await act(async () => {
      result.current.refresh();
      result.current.refresh();
    });

    // Double-tapping "Try again" on a slow network is pure duplicate work.
    expect(mockedFetchFeed).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve({ posts: [] });
    });
  });

  it('supersedes a background page append', async () => {
    // A pull-to-refresh is an explicit gesture; silently dropping it is worse
    // than one extra round trip.
    mockedFetchFeed.mockResolvedValueOnce({ posts: [post('post-1')], nextCursor: 'cur-1' });

    const { result } = await renderHook(() => useCommunityFeed());
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    const append = deferred<PostsPage>();
    const refreshing = deferred<PostsPage>();
    stallSurplusFeedRequests();
    mockedFetchFeed.mockReturnValueOnce(append.promise).mockReturnValueOnce(refreshing.promise);

    await act(async () => {
      result.current.loadMore();
    });
    await act(async () => {
      result.current.refresh();
    });

    expect(mockedFetchFeed).toHaveBeenCalledTimes(3);

    await act(async () => {
      refreshing.resolve({ posts: [post('post-5')] });
    });
    expect(result.current.posts.map((entry) => entry.id)).toEqual(['post-5']);

    // The superseded append finally answers and must not be appended.
    await act(async () => {
      append.resolve({ posts: [post('post-2')] });
    });
    expect(result.current.posts.map((entry) => entry.id)).toEqual(['post-5']);
  });

  it('does not let the superseded append re-open paging while the refresh is still running', async () => {
    // A SECOND MECHANISM ON THE SAME PATH, and not the one above. The test
    // above pins what a superseded response may WRITE; this one pins what it
    // may CLEAR. `run`'s `finally` only hands the in-flight flag back when the
    // request that set it is still the newest one — unguarded, the superseded
    // append's `finally` marks the feed idle while its replacement is still in
    // flight, and the next `onEndReached` (they fire constantly through one
    // fling) pages on top of a running refresh with a cursor that refresh is
    // about to invalidate.
    mockedFetchFeed.mockResolvedValueOnce({ posts: [post('post-1')], nextCursor: 'cur-1' });

    const { result } = await renderHook(() => useCommunityFeed());
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    const append = deferred<PostsPage>();
    const refreshing = deferred<PostsPage>();
    stallSurplusFeedRequests();
    mockedFetchFeed.mockReturnValueOnce(append.promise).mockReturnValueOnce(refreshing.promise);

    await act(async () => {
      result.current.loadMore();
    });
    await act(async () => {
      result.current.refresh();
    });
    expect(mockedFetchFeed).toHaveBeenCalledTimes(3);

    // The superseded append answers first, while the refresh is still out.
    await act(async () => {
      append.resolve({ posts: [post('post-2')], nextCursor: 'cur-2' });
    });

    await act(async () => {
      result.current.loadMore();
    });

    // Still three. The refresh owns the flag until it settles, so paging is
    // shut for the whole of it and not merely until the loser answers.
    expect(mockedFetchFeed).toHaveBeenCalledTimes(3);

    await act(async () => {
      refreshing.resolve({ posts: [post('post-5')] });
    });
    expect(result.current.posts.map((entry) => entry.id)).toEqual(['post-5']);
  });
});

describe('useCommunityFeed · errors', () => {
  it('keeps the rows and the cursor when a page load fails', async () => {
    mockedFetchFeed.mockResolvedValueOnce({ posts: [post('post-1')], nextCursor: 'cur-1' });

    const { result } = await renderHook(() => useCommunityFeed());
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    mockedFetchFeed.mockRejectedValueOnce(
      new ApiClientError('NETWORK', 'Cannot reach the server. Check your connection.'),
    );
    await act(async () => {
      result.current.loadMore();
    });

    expect(result.current.error).toBe('Cannot reach the server. Check your connection.');
    expect(result.current.activity).toBe('idle');
    // The user keeps what they had, and `onEndReached` can retry.
    expect(result.current.posts.map((entry) => entry.id)).toEqual(['post-1']);
    expect(result.current.hasMore).toBe(true);
  });

  it('falls back to its own message for a non-API failure', async () => {
    mockedFetchFeed.mockRejectedValueOnce(new Error('boom'));

    const { result } = await renderHook(() => useCommunityFeed());

    await waitFor(() =>
      expect(result.current.error).toBe('Something went wrong loading the community feed.'),
    );
  });

  it('clears the message when the next request starts, not when it succeeds', async () => {
    // Without this a banner keyed on `error !== null` sits under the refresh
    // spinner still showing the message the refresh is trying to clear.
    mockedFetchFeed.mockRejectedValueOnce(new ApiClientError('UNKNOWN', 'Request failed (500)', 500));

    const { result } = await renderHook(() => useCommunityFeed());
    await waitFor(() => expect(result.current.error).toBe('Request failed (500)'));

    const retry = deferred<PostsPage>();
    mockedFetchFeed.mockReturnValueOnce(retry.promise);
    await act(async () => {
      result.current.refresh();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.activity).toBe('refreshing');

    await act(async () => {
      retry.resolve({ posts: [] });
    });
  });

  it('does not let a scroll erase a failed like’s message, or a like erase a failed load’s', async () => {
    // List loads and per-card actions are independent operations sharing one
    // channel, and "clear the error when a new request starts" is only correct
    // *within* an operation. Both statements below were still true when an
    // untagged implementation erased them.
    mockedFetchFeed.mockResolvedValueOnce({ posts: [post('post-1')], nextCursor: 'cur-1' });
    const { result } = await renderHook(() => useCommunityFeed());
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    mockedLikePost.mockRejectedValueOnce(new ApiClientError('UNKNOWN', 'Like failed (500)', 500));
    await act(async () => {
      await result.current.toggleLike('post-1');
    });
    expect(result.current.error).toBe('Like failed (500)');

    // A page append starting must not wipe it.
    const append = deferred<PostsPage>();
    mockedFetchFeed.mockReturnValueOnce(append.promise);
    await act(async () => {
      result.current.loadMore();
    });
    expect(result.current.error).toBe('Like failed (500)');

    await act(async () => {
      append.reject(new ApiClientError('UNKNOWN', 'Page failed (500)', 500));
    });
    expect(result.current.error).toBe('Page failed (500)');

    // And a successful like must not wipe the load's message: the page it
    // failed to fetch is still missing.
    mockedLikePost.mockResolvedValueOnce({ likeCount: 4, liked: true });
    await act(async () => {
      await result.current.toggleLike('post-1');
    });
    expect(result.current.error).toBe('Page failed (500)');
  });
});

describe('useCommunityFeed · stale responses', () => {
  it('discards a success from a request three tokens ago, even when the token matches again', async () => {
    // A → B → A, written out explicitly because a VALUE comparison passes the
    // obvious two-token test and fails this one. "Is this response for the
    // token I currently hold?" says yes to the first A response once the user
    // has signed back into A — and that response is three requests old and
    // describes the feed as it was before B ever loaded. Only a monotonic
    // sequence number separates them.
    const a1 = deferred<PostsPage>();
    const b = deferred<PostsPage>();
    const a2 = deferred<PostsPage>();
    stallSurplusFeedRequests();
    mockedFetchFeed
      .mockReturnValueOnce(a1.promise)
      .mockReturnValueOnce(b.promise)
      .mockReturnValueOnce(a2.promise);

    const { result, rerender } = await renderHook(() => useCommunityFeed());

    mockedUseAuth.mockReturnValue(authValue('tok-other'));
    await act(async () => {
      await rerender(undefined);
    });
    mockedUseAuth.mockReturnValue(authValue(TOKEN));
    await act(async () => {
      await rerender(undefined);
    });

    expect(mockedFetchFeed).toHaveBeenCalledTimes(3);
    expect(mockedFetchFeed).toHaveBeenLastCalledWith({ token: TOKEN });

    await act(async () => {
      a2.resolve({ posts: [post('fresh')], nextCursor: 'fresh-cursor' });
    });
    await waitFor(() => expect(result.current.posts.map((e) => e.id)).toEqual(['fresh']));

    // The first request finally answers. It carries the same token as the one
    // in hand and must still lose — the rows AND the cursor, or the next
    // `loadMore` pages a feed the user has been moved off.
    await act(async () => {
      a1.resolve({ posts: [post('stale')], nextCursor: 'stale-cursor' });
    });

    expect(result.current.posts.map((e) => e.id)).toEqual(['fresh']);
    expect(result.current.activity).toBe('idle');

    mockedFetchFeed.mockReturnValueOnce(new Promise(() => {}));
    await act(async () => {
      result.current.loadMore();
    });
    expect(mockedFetchFeed).toHaveBeenLastCalledWith({ token: TOKEN, cursor: 'fresh-cursor' });

    await act(async () => {
      b.resolve({ posts: [post('older-still')] });
    });
    expect(result.current.posts.map((e) => e.id)).toEqual(['fresh']);
  });

  it('discards a failure from a request three tokens ago, even when the token matches again', async () => {
    // The catch path carries the same guard as the success path, and it is a
    // SEPARATE mechanism: one `if` cannot cover both, and the catch half is
    // the one written after the success path already works. Without it, a
    // request the user moved on from — twice — paints an error over a feed
    // that loaded fine.
    const a1 = deferred<PostsPage>();
    const b = deferred<PostsPage>();
    const a2 = deferred<PostsPage>();
    stallSurplusFeedRequests();
    mockedFetchFeed
      .mockReturnValueOnce(a1.promise)
      .mockReturnValueOnce(b.promise)
      .mockReturnValueOnce(a2.promise);

    const { result, rerender } = await renderHook(() => useCommunityFeed());

    mockedUseAuth.mockReturnValue(authValue('tok-other'));
    await act(async () => {
      await rerender(undefined);
    });
    mockedUseAuth.mockReturnValue(authValue(TOKEN));
    await act(async () => {
      await rerender(undefined);
    });

    await act(async () => {
      a2.resolve({ posts: [post('fresh')] });
    });
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    await act(async () => {
      a1.reject(new ApiClientError('UNKNOWN', 'Request failed (500)', 500));
    });

    expect(result.current.error).toBeNull();
    expect(result.current.posts.map((e) => e.id)).toEqual(['fresh']);
    expect(result.current.activity).toBe('idle');

    await act(async () => {
      b.reject(new ApiClientError('UNAUTHORIZED', 'Session expired', 401));
    });
    expect(result.current.error).toBeNull();
  });

  it('clears the previous user’s feed when the token changes', async () => {
    mockedFetchFeed.mockResolvedValueOnce({ posts: [post('post-1')] });
    const { result, rerender } = await renderHook(() => useCommunityFeed());
    await waitFor(() => expect(result.current.posts).toHaveLength(1));

    const next = deferred<PostsPage>();
    stallSurplusFeedRequests();
    mockedFetchFeed.mockReturnValueOnce(next.promise);
    mockedUseAuth.mockReturnValue(authValue('tok-other'));

    await act(async () => {
      await rerender(undefined);
    });

    // `liked` and `saved` are viewer-relative, so another user's feed is not
    // this user's feed even where the posts would be the same.
    expect(result.current.posts).toEqual([]);
    expect(result.current.activity).toBe('loading');

    await act(async () => {
      next.resolve({ posts: [post('post-2')] });
    });
  });
});

describe('useCommunityFeed · search', () => {
  // Fake timers only in this block: the debounce is the one thing here that is
  // measured in milliseconds, and pinning the clock for the rest of the file
  // would buy nothing and complicate every `waitFor`.
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not issue a request per keystroke', async () => {
    // `?q=` costs O(feed size) rather than O(result size) — measured at 5000
    // posts, a rare term scans 5000 index keys for nothing while a common term
    // scans 59 for twenty. Every prefix of a word is a rare term, so an
    // undebounced box makes the EXPENSIVE query once per letter. Typing
    // "blue" unthrottled is four whole-feed scans to render one result.
    mockedFetchFeed.mockResolvedValueOnce({ posts: [post('post-1')] });
    const { result } = await renderHook(() => useCommunityFeed());
    expect(mockedFetchFeed).toHaveBeenCalledTimes(1);

    const searched = deferred<PostsPage>();
    stallSurplusFeedRequests();
    mockedFetchFeed.mockReturnValueOnce(searched.promise);

    // The keystrokes are spaced 100ms apart, which is what a person typing
    // looks like — and it is the only spacing that can see the difference
    // between "the timer is re-armed" and "the timer is re-armed AND the old
    // one is cancelled". Typed in one synchronous burst, four uncancelled
    // timers all come due in the same tick and React batches their four
    // `setTerm` calls into the single last value, so a missing `clearTimeout`
    // is invisible. Spread out, the first one comes due while the user is
    // still typing and searches the feed for "b".
    const GAP = 100;
    for (const typed of ['b', 'bl', 'blu', 'blue']) {
      await act(async () => {
        result.current.setQuery(typed);
      });
      // The box shows the keystroke immediately; only the request waits.
      expect(result.current.query).toBe(typed);
      await act(async () => {
        jest.advanceTimersByTime(GAP);
      });
      expect(mockedFetchFeed).toHaveBeenCalledTimes(1);
    }

    await act(async () => {
      jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS - GAP - 1);
    });
    expect(mockedFetchFeed).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(mockedFetchFeed).toHaveBeenCalledTimes(2);
    expect(mockedFetchFeed).toHaveBeenLastCalledWith({ token: TOKEN, q: 'blue' });

    await act(async () => {
      searched.resolve({ posts: [post('post-2')] });
    });
    expect(result.current.posts.map((entry) => entry.id)).toEqual(['post-2']);
  });

  it('clears the previous results while the new search loads', async () => {
    mockedFetchFeed.mockResolvedValueOnce({ posts: [post('post-1')] });
    const { result } = await renderHook(() => useCommunityFeed());
    expect(result.current.posts).toHaveLength(1);

    stallSurplusFeedRequests();
    await act(async () => {
      result.current.setQuery('blue');
    });
    await act(async () => {
      jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });

    // A new search is a new list, not an update of the old one: leaving the
    // previous results under a spinner shows results for a term the user has
    // already replaced.
    expect(result.current.posts).toEqual([]);
    expect(result.current.activity).toBe('loading');
    expect(result.current.hasMore).toBe(false);
  });

  it('does not re-search when only surrounding whitespace changes', async () => {
    mockedFetchFeed.mockResolvedValueOnce({ posts: [post('post-1')] });
    const { result } = await renderHook(() => useCommunityFeed());

    stallSurplusFeedRequests();
    await act(async () => {
      result.current.setQuery('blue');
    });
    await act(async () => {
      jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    expect(mockedFetchFeed).toHaveBeenCalledTimes(2);

    await act(async () => {
      result.current.setQuery('blue  ');
    });
    await act(async () => {
      jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });

    // The server trims too, so this would be the same whole-feed scan run a
    // second time for a term that cannot match anything different.
    expect(mockedFetchFeed).toHaveBeenCalledTimes(2);
    // The box still shows exactly what was typed.
    expect(result.current.query).toBe('blue  ');
  });

  it('pages the current search rather than page one of everything', async () => {
    mockedFetchFeed.mockResolvedValueOnce({ posts: [post('post-1')] });
    const { result } = await renderHook(() => useCommunityFeed());

    mockedFetchFeed.mockResolvedValueOnce({ posts: [post('post-2')], nextCursor: 'cur-q' });
    await act(async () => {
      result.current.setQuery('blue');
    });
    await act(async () => {
      jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    expect(result.current.hasMore).toBe(true);

    stallSurplusFeedRequests();
    await act(async () => {
      result.current.loadMore();
    });

    expect(mockedFetchFeed).toHaveBeenLastCalledWith({
      token: TOKEN,
      cursor: 'cur-q',
      q: 'blue',
    });
  });

  it('goes back to the unfiltered feed when the box is cleared', async () => {
    mockedFetchFeed.mockResolvedValueOnce({ posts: [post('post-1')] });
    const { result } = await renderHook(() => useCommunityFeed());

    stallSurplusFeedRequests();
    await act(async () => {
      result.current.setQuery('blue');
    });
    await act(async () => {
      jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    expect(mockedFetchFeed).toHaveBeenLastCalledWith({ token: TOKEN, q: 'blue' });

    await act(async () => {
      result.current.setQuery('');
    });
    await act(async () => {
      jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });

    // No `q` key at all rather than `q: ''`.
    expect(mockedFetchFeed).toHaveBeenLastCalledWith({ token: TOKEN });
  });
});

describe('useCommunityFeed · liking', () => {
  async function feedWith(first: PublicPost) {
    mockedFetchFeed.mockResolvedValueOnce({ posts: [first] });
    const rendered = await renderHook(() => useCommunityFeed());
    await waitFor(() => expect(rendered.result.current.posts).toHaveLength(1));
    return rendered;
  }

  it('flips the heart and the count before the server answers, then takes the server’s number', async () => {
    // A like that waits for the server feels broken — the round trip is
    // visible on a phone.
    const { result } = await feedWith(post('post-1', { likeCount: 3, liked: false }));

    const pending = deferred<PostLikeResult>();
    mockedLikePost.mockReturnValueOnce(pending.promise);

    await act(async () => {
      void result.current.toggleLike('post-1');
    });

    expect(mockedLikePost).toHaveBeenCalledWith('post-1', TOKEN);
    expect(result.current.posts[0].liked).toBe(true);
    expect(result.current.posts[0].likeCount).toBe(4);

    await act(async () => {
      pending.resolve({ likeCount: 9, liked: true });
    });

    // The server's answer accounts for every other user's likes since this
    // page was loaded, which the optimistic guess cannot.
    expect(result.current.posts[0].likeCount).toBe(9);
    expect(result.current.posts[0].liked).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('takes the server’s liked flag as well as its count, rather than keeping its own guess', async () => {
    // Both halves of one answer are applied on the same terms — absolutely,
    // with no branch that trusts one field and second-guesses the other. See
    // `PostLikeResult` in `api.ts` for why: `liked` is a fact about the
    // viewer's own like row, `likeCount` is the server's latest word on a
    // number this client cannot compute for itself.
    //
    // THE ANSWER HERE CONTRADICTS THE OPTIMISTIC GUESS, WHICH IS DELIBERATE
    // AND IS THE ONLY THING THAT MAKES THIS TEST MEASURE ANYTHING. Fed an
    // answer that agrees — which is all today's routes send, since `POST
    // /like` answers `true` whether or not it inserted — "apply the reply" and
    // "keep the guess" are the same code and neither is pinned. The property
    // under test is this hook's contract with `./api`: whatever a
    // `PostLikeResult` says is what the row ends up holding. It is not a claim
    // about what the server emits, and nothing here relies on one.
    const { result } = await feedWith(post('post-1', { likeCount: 3, liked: false }));

    mockedLikePost.mockResolvedValueOnce({ likeCount: 7, liked: false });

    await act(async () => {
      await result.current.toggleLike('post-1');
    });

    expect(result.current.posts[0].likeCount).toBe(7);
    expect(result.current.posts[0].liked).toBe(false);
  });

  it('does not leave the patch’s own postId on the row it patched', async () => {
    // The patch is spread field by field rather than `...patch`, because a
    // patch carries a `postId` that is addressing information and not a field
    // of a post. `...patch` would put a stray `postId` on every post in every
    // mounted list on every interaction — invisible to every assertion about
    // hearts and counts, and one `keyExtractor` or one equality check away
    // from being load-bearing.
    const { result } = await feedWith(post('post-1', { likeCount: 3, liked: false }));

    mockedLikePost.mockResolvedValueOnce({ likeCount: 4, liked: true });
    await act(async () => {
      await result.current.toggleLike('post-1');
    });

    expect(result.current.posts[0]).not.toHaveProperty('postId');
    expect(Object.keys(result.current.posts[0]).sort()).toEqual([
      'author',
      'caption',
      'createdAt',
      'id',
      'items',
      'likeCount',
      'liked',
      'missingItemsNotice',
      'saved',
    ]);
  });

  it('unlikes a post the viewer has already liked', async () => {
    const { result } = await feedWith(post('post-1', { likeCount: 4, liked: true }));

    mockedUnlikePost.mockResolvedValueOnce({ likeCount: 3, liked: false });

    await act(async () => {
      await result.current.toggleLike('post-1');
    });

    expect(mockedUnlikePost).toHaveBeenCalledWith('post-1', TOKEN);
    expect(mockedLikePost).not.toHaveBeenCalled();
    expect(result.current.posts[0].liked).toBe(false);
    expect(result.current.posts[0].likeCount).toBe(3);
  });

  it('rolls a failed like back to the state that was there before the tap', async () => {
    // A like that never rolls back lies.
    //
    // THE TAP AND THE FAILURE ARE IN SEPARATE `act`s, AND THAT IS THE FORCE OF
    // THIS TEST. Run in one `act`, the optimistic `setPosts` never commits
    // before the catch runs, so the list the hook can read is still the
    // pre-tap list — and a rollback that read the LIVE list would be
    // byte-for-byte indistinguishable from one that reads the snapshot taken
    // before the tap. Split, the optimistic 4 is committed and observed first,
    // which is what a phone does: the count moves hundreds of milliseconds
    // before the reply lands. A rollback reading the live list then restores
    // 4, and the like has lied.
    const { result } = await feedWith(post('post-1', { likeCount: 3, liked: false }));

    const pending = deferred<PostLikeResult>();
    mockedLikePost.mockReturnValueOnce(pending.promise);

    let outcome: Promise<boolean> | undefined;
    await act(async () => {
      outcome = result.current.toggleLike('post-1');
    });

    expect(result.current.posts[0].liked).toBe(true);
    expect(result.current.posts[0].likeCount).toBe(4);

    await act(async () => {
      pending.reject(
        new ApiClientError('NETWORK', 'Cannot reach the server. Check your connection.'),
      );
      await outcome;
    });

    expect(await outcome).toBe(false);
    expect(result.current.posts[0].liked).toBe(false);
    expect(result.current.posts[0].likeCount).toBe(3);
    expect(result.current.error).toBe('Cannot reach the server. Check your connection.');
  });

  it('restores a zero count rather than inventing a like when an unlike fails', async () => {
    // `{ liked: true, likeCount: 0 }` is a state the API really produces: a
    // like that did not insert answers with the count as it stood when the
    // handler read the post, and the measured case is eight simultaneous likes
    // where seven replies say 0. Unlike that post and the optimistic count
    // clamps at 0 rather than going negative — so the optimistic value and the
    // snapshot are the SAME NUMBER, and a rollback that undoes the delta
    // instead of restoring the snapshot adds one back, inventing a like on a
    // post that has none out of a failed unlike.
    // Split into two `act`s for the reason the test above gives: the
    // optimistic write has to be committed before the failure arrives, or the
    // rollback is never asked to choose between the snapshot and the live row.
    const { result } = await feedWith(post('post-1', { likeCount: 0, liked: true }));

    const pending = deferred<PostLikeResult>();
    mockedUnlikePost.mockReturnValueOnce(pending.promise);

    await act(async () => {
      void result.current.toggleLike('post-1');
    });

    expect(result.current.posts[0].likeCount).toBe(0);
    expect(result.current.posts[0].liked).toBe(false);

    await act(async () => {
      pending.reject(new ApiClientError('UNKNOWN', 'Request failed (500)', 500));
    });

    expect(result.current.posts[0].likeCount).toBe(0);
    expect(result.current.posts[0].liked).toBe(true);
  });

  it('never shows a negative count while an unlike is in flight', async () => {
    const { result } = await feedWith(post('post-1', { likeCount: 0, liked: true }));

    const pending = deferred<PostLikeResult>();
    mockedUnlikePost.mockReturnValueOnce(pending.promise);

    await act(async () => {
      void result.current.toggleLike('post-1');
    });

    expect(result.current.posts[0].likeCount).toBe(0);
    expect(result.current.posts[0].liked).toBe(false);

    await act(async () => {
      pending.resolve({ likeCount: 0, liked: false });
    });
  });

  it('issues one request for a same-frame double tap', async () => {
    // The server's unique index stops ITS count moving twice and can say
    // nothing about a client that fires twice. The guard is a ref rather than
    // state for the reason `useGuardedMutation` documents: React commits a
    // state flag on the next render, which is strictly after every handler
    // queued in this frame has already run.
    //
    // The call count is what catches a missing guard here. The like count
    // would read 4 either way, because a patch carries an absolute value
    // computed from a snapshot rather than an increment — which is the
    // channel's own idempotency and is asserted separately below.
    const { result } = await feedWith(post('post-1', { likeCount: 3, liked: false }));

    const pending = deferred<PostLikeResult>();
    stallSurplusLikes();
    mockedLikePost.mockReturnValueOnce(pending.promise);

    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    await act(async () => {
      first = result.current.toggleLike('post-1');
      second = result.current.toggleLike('post-1');
      pending.resolve({ likeCount: 4, liked: true });
      // Only the FIRST promise is awaited. An unguarded second call issues a
      // request that `stallSurplusLikes` never settles, and awaiting it would
      // wedge this `act` — turning one caught mutation into a timeout that
      // takes every later test in the file with it.
      await first;
    });

    expect(mockedLikePost).toHaveBeenCalledTimes(1);
    // Both callers observe the same outcome rather than the second being told
    // the like failed: the second tap is handed the first's promise, not a
    // second attempt.
    expect(second).toBe(first);
    await expect(first).resolves.toBe(true);
    expect(result.current.posts[0].likeCount).toBe(4);
  });

  it('lets a like be retried after one failed', async () => {
    // Per in-flight call, not per post forever.
    const { result } = await feedWith(post('post-1', { likeCount: 3, liked: false }));

    mockedLikePost.mockRejectedValueOnce(new ApiClientError('UNKNOWN', 'Request failed (500)', 500));
    await act(async () => {
      await result.current.toggleLike('post-1');
    });

    mockedLikePost.mockResolvedValueOnce({ likeCount: 4, liked: true });
    await act(async () => {
      await result.current.toggleLike('post-1');
    });

    expect(mockedLikePost).toHaveBeenCalledTimes(2);
    expect(result.current.posts[0].likeCount).toBe(4);
    expect(result.current.error).toBeNull();
  });

  it('does nothing at all for an id this list is not holding', async () => {
    // There is no snapshot to roll back to, so there is nothing this could
    // honestly do — and issuing the request anyway would leave a mutation
    // whose failure has nowhere to show.
    const { result } = await feedWith(post('post-1'));

    let resolved: boolean | undefined;
    await act(async () => {
      resolved = await result.current.toggleLike('not-in-this-list');
    });

    expect(resolved).toBe(false);
    expect(mockedLikePost).not.toHaveBeenCalled();
    expect(mockedUnlikePost).not.toHaveBeenCalled();
  });

  it('leaves the saved list alone: a like marks nothing dirty', async () => {
    // The patch already reached every mounted list, so there is no staleness
    // left for a flag to describe — and marking would buy a page-one reload
    // per like.
    const { result } = await feedWith(post('post-1'));

    mockedLikePost.mockResolvedValueOnce({ likeCount: 4, liked: true });
    await act(async () => {
      await result.current.toggleLike('post-1');
    });

    expect(consumeCommunityDirty('feed')).toBe(false);
    expect(consumeCommunityDirty('saved')).toBe(false);
  });
});

describe('useCommunityFeed · saving', () => {
  async function feedWith(first: PublicPost) {
    mockedFetchFeed.mockResolvedValueOnce({ posts: [first] });
    const rendered = await renderHook(() => useCommunityFeed());
    await waitFor(() => expect(rendered.result.current.posts).toHaveLength(1));
    return rendered;
  }

  it('fills the bookmark before the server answers and marks the saved list dirty after', async () => {
    const { result } = await feedWith(post('post-1', { saved: false }));

    const pending = deferred<PostSaveResult>();
    mockedSavePost.mockReturnValueOnce(pending.promise);

    await act(async () => {
      void result.current.toggleSave('post-1');
    });

    expect(mockedSavePost).toHaveBeenCalledWith('post-1', TOKEN);
    expect(result.current.posts[0].saved).toBe(true);
    // Nothing is marked until the server has actually done it.
    expect(consumeCommunityDirty('saved')).toBe(false);

    await act(async () => {
      pending.resolve({ saved: true });
    });

    expect(result.current.posts[0].saved).toBe(true);
    // A save adds a ROW to the saved list, and no live patch can conjure a row
    // a list is not holding — so this is the one interaction that leaves
    // another screen genuinely stale.
    expect(consumeCommunityDirty('saved')).toBe(true);
    expect(consumeCommunityDirty('feed')).toBe(false);
  });

  it('unsaves a post the viewer has saved', async () => {
    const { result } = await feedWith(post('post-1', { saved: true }));

    mockedUnsavePost.mockResolvedValueOnce({ saved: false });
    await act(async () => {
      await result.current.toggleSave('post-1');
    });

    expect(mockedUnsavePost).toHaveBeenCalledWith('post-1', TOKEN);
    expect(mockedSavePost).not.toHaveBeenCalled();
    expect(result.current.posts[0].saved).toBe(false);
    expect(consumeCommunityDirty('saved')).toBe(true);
  });

  it('rolls a failed save back and marks nothing dirty', async () => {
    const { result } = await feedWith(post('post-1', { saved: false }));

    mockedSavePost.mockRejectedValueOnce(new ApiClientError('UNKNOWN', 'Request failed (500)', 500));

    let resolved: boolean | undefined;
    await act(async () => {
      resolved = await result.current.toggleSave('post-1');
    });

    expect(resolved).toBe(false);
    expect(result.current.posts[0].saved).toBe(false);
    expect(result.current.error).toBe('Request failed (500)');
    // Nothing changed server-side, so no screen is stale.
    expect(consumeCommunityDirty('saved')).toBe(false);
  });

  it('lets a save be retried after one failed, clearing the message when the retry starts', async () => {
    // The mirror of the like path's retry test, and it needs writing out
    // rather than assuming symmetry: the `onError(null)` that clears a dead
    // message lives ONCE IN EACH TOGGLE, and deleting the one in `toggleSave`
    // is invisible to every other test in this repository. A screen keyed on
    // `error !== null` would otherwise show the failed save's message for the
    // whole round trip of the retry that is meant to clear it.
    const { result } = await feedWith(post('post-1', { saved: false }));

    mockedSavePost.mockRejectedValueOnce(
      new ApiClientError('UNKNOWN', 'Request failed (500)', 500),
    );
    await act(async () => {
      await result.current.toggleSave('post-1');
    });
    expect(result.current.error).toBe('Request failed (500)');

    const retrying = deferred<PostSaveResult>();
    mockedSavePost.mockReturnValueOnce(retrying.promise);
    await act(async () => {
      void result.current.toggleSave('post-1');
    });

    // Asserted WHILE THE RETRY IS STILL IN FLIGHT, which is the only moment
    // "cleared when it starts" and "cleared when it succeeds" differ.
    expect(result.current.error).toBeNull();

    await act(async () => {
      retrying.resolve({ saved: true });
    });
    expect(result.current.posts[0].saved).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('issues one request for a same-frame double tap', async () => {
    const { result } = await feedWith(post('post-1', { saved: false }));

    const pending = deferred<PostSaveResult>();
    mockedSavePost.mockImplementation(() => new Promise(() => {}));
    mockedSavePost.mockReturnValueOnce(pending.promise);

    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    await act(async () => {
      first = result.current.toggleSave('post-1');
      second = result.current.toggleSave('post-1');
      pending.resolve({ saved: true });
      // Only the first, for the reason the like's double-tap test gives.
      await first;
    });

    expect(mockedSavePost).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('runs a like and a save on one post at the same time', async () => {
    // The guard is keyed by post AND kind. Keyed by post alone, tapping the
    // bookmark while a like is in flight would hand the caller the like's
    // promise and never save anything.
    const { result } = await feedWith(post('post-1', { likeCount: 3, liked: false, saved: false }));

    const like = deferred<PostLikeResult>();
    const save = deferred<PostSaveResult>();
    mockedLikePost.mockReturnValueOnce(like.promise);
    mockedSavePost.mockReturnValueOnce(save.promise);

    await act(async () => {
      void result.current.toggleLike('post-1');
      void result.current.toggleSave('post-1');
    });

    expect(mockedLikePost).toHaveBeenCalledTimes(1);
    expect(mockedSavePost).toHaveBeenCalledTimes(1);
    expect(result.current.posts[0].liked).toBe(true);
    expect(result.current.posts[0].saved).toBe(true);

    await act(async () => {
      like.resolve({ likeCount: 4, liked: true });
      save.resolve({ saved: true });
    });

    // Neither patch clobbered the other's field, because a patch names only
    // the fields it changes.
    expect(result.current.posts[0].liked).toBe(true);
    expect(result.current.posts[0].likeCount).toBe(4);
    expect(result.current.posts[0].saved).toBe(true);
  });
});

describe('useCommunityFeed · deleting your own post', () => {
  async function feedWith(posts: PublicPost[], nextCursor?: string) {
    mockedFetchFeed.mockResolvedValueOnce({ posts, ...(nextCursor ? { nextCursor } : {}) });
    const rendered = await renderHook(() => useCommunityFeed());
    await waitFor(() => expect(rendered.result.current.posts).toHaveLength(posts.length));
    return rendered;
  }

  it('drops the row only once the server has confirmed', async () => {
    const { result } = await feedWith([post('post-1'), post('post-2')]);

    const pending = deferred<void>();
    mockedDeletePost.mockReturnValueOnce(pending.promise);

    await act(async () => {
      void result.current.remove('post-1');
    });

    // Dropping it first would make a failed delete look like a success until
    // the next refresh silently brought the post back.
    expect(result.current.posts.map((entry) => entry.id)).toEqual(['post-1', 'post-2']);

    await act(async () => {
      pending.resolve();
    });

    expect(result.current.posts.map((entry) => entry.id)).toEqual(['post-2']);
    // The server cascades the post's saves away, so any saved list holding it
    // is now wrong.
    expect(consumeCommunityDirty('saved')).toBe(true);
  });

  it('treats a 404 as success', async () => {
    // A foreign post, a post that never existed and a post already deleted
    // from another device all answer 404 — and 404 is the one answer that
    // means it is not there. Collapsing it to a failure leaves a row that can
    // never be deleted, because every retry answers 404 too.
    const { result } = await feedWith([post('post-1')]);

    mockedDeletePost.mockRejectedValueOnce(new ApiClientError('NOT_FOUND', 'Post not found', 404));

    let resolved: boolean | undefined;
    await act(async () => {
      resolved = await result.current.remove('post-1');
    });

    expect(resolved).toBe(true);
    expect(result.current.posts).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('marks the saved list dirty on both delete paths and leaves the feed’s pages alone', async () => {
    // `markCommunityDirty(['saved'])`, never the no-argument default that
    // marks every reader. The feed has already taken its own row off the
    // screen, so it has no staleness to record — while marking `'feed'` too
    // would throw away every page the user had scrolled to on the next focus,
    // in order to reload a list that is already correct. That is exactly the
    // regression `communityDirty.ts` says the reader split exists to prevent,
    // and it is one omitted argument away — so it is asserted in BOTH
    // directions, on both of the paths that mark.
    const { result } = await feedWith([post('post-1'), post('post-2')]);

    mockedDeletePost.mockResolvedValueOnce(undefined);
    await act(async () => {
      await result.current.remove('post-1');
    });

    expect(consumeCommunityDirty('saved')).toBe(true);
    expect(consumeCommunityDirty('feed')).toBe(false);

    // The already-gone path marks the same single reader, and no more.
    mockedDeletePost.mockRejectedValueOnce(
      new ApiClientError('NOT_FOUND', 'Post not found', 404),
    );
    await act(async () => {
      await result.current.remove('post-2');
    });

    expect(consumeCommunityDirty('saved')).toBe(true);
    expect(consumeCommunityDirty('feed')).toBe(false);
  });

  it('keeps the row and reports the message when the delete fails', async () => {
    const { result } = await feedWith([post('post-1')]);

    mockedDeletePost.mockRejectedValueOnce(new ApiClientError('UNKNOWN', 'Request failed (500)', 500));

    let resolved: boolean | undefined;
    await act(async () => {
      resolved = await result.current.remove('post-1');
    });

    expect(resolved).toBe(false);
    expect(result.current.posts.map((entry) => entry.id)).toEqual(['post-1']);
    expect(result.current.error).toBe('Request failed (500)');
    expect(consumeCommunityDirty('saved')).toBe(false);
  });

  it('issues one request for a same-frame double tap', async () => {
    // `DELETE /community/posts/:id` is not idempotent-silent, so a second
    // delete of the same id answers 404 — which would paint "Post not found"
    // over a delete that in fact succeeded.
    const { result } = await feedWith([post('post-1')]);

    const pending = deferred<void>();
    mockedDeletePost.mockImplementation(() => new Promise(() => {}));
    mockedDeletePost.mockReturnValueOnce(pending.promise);

    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    await act(async () => {
      first = result.current.remove('post-1');
      second = result.current.remove('post-1');
      pending.resolve();
      // Only the first, for the reason the like's double-tap test gives.
      await first;
    });

    expect(mockedDeletePost).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('does not let a response that predates the delete put the row back', async () => {
    // The server computes a page BEFORE a concurrent delete commits, so a
    // response already in flight can carry a row the user has removed. That is
    // not a stale response — the ordering is legitimate and the sequence guard
    // correctly lets it through — so only a record of what was deleted can
    // keep it off the screen.
    const { result } = await feedWith([post('post-1')], 'cur-1');

    const append = deferred<PostsPage>();
    stallSurplusFeedRequests();
    mockedFetchFeed.mockReturnValueOnce(append.promise);
    await act(async () => {
      result.current.loadMore();
    });

    mockedDeletePost.mockResolvedValueOnce(undefined);
    await act(async () => {
      await result.current.remove('post-1');
    });
    expect(result.current.posts).toEqual([]);

    await act(async () => {
      append.resolve({ posts: [post('post-1'), post('post-2')] });
    });

    expect(result.current.posts.map((entry) => entry.id)).toEqual(['post-2']);
  });

  it('keeps the deleted row off a later refresh too', async () => {
    const { result } = await feedWith([post('post-1'), post('post-2')]);

    mockedDeletePost.mockResolvedValueOnce(undefined);
    await act(async () => {
      await result.current.remove('post-1');
    });

    mockedFetchFeed.mockResolvedValueOnce({ posts: [post('post-1'), post('post-2')] });
    await act(async () => {
      result.current.refresh();
    });

    expect(result.current.posts.map((entry) => entry.id)).toEqual(['post-2']);
  });
});
