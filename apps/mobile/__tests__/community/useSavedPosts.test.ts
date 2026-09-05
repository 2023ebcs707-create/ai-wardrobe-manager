import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { PublicClothingItem, PublicPost } from '@wardrobe/shared';
// The real `ApiClientError` — not a mock. Automocking a class that extends
// Error yields something that cannot be constructed.
import { ApiClientError } from '../../src/api/client';
import { useAuth } from '../../src/auth/AuthContext';
import {
  fetchSavedPosts,
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
import { useSavedPosts } from '../../src/community/useSavedPosts';

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

jest.mock('../../src/auth/AuthContext', () => ({
  useAuth: jest.fn(),
}));

const mockedFetchSavedPosts = jest.mocked(fetchSavedPosts);
const mockedLikePost = jest.mocked(likePost);
const mockedUnlikePost = jest.mocked(unlikePost);
const mockedSavePost = jest.mocked(savePost);
const mockedUnsavePost = jest.mocked(unsavePost);
const mockedUseAuth = jest.mocked(useAuth);

const apiMocks = [
  mockedFetchSavedPosts,
  mockedLikePost,
  mockedUnlikePost,
  mockedSavePost,
  mockedUnsavePost,
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

function post(id: string, overrides: Partial<PublicPost> = {}): PublicPost {
  return {
    id,
    author: { id: 'author-1', name: 'Ada' },
    itemIds: [shirt.id],
    items: [shirt],
    caption: `caption for ${id}`,
    likeCount: 3,
    liked: false,
    // Everything in this list is saved by definition.
    saved: true,
    createdAt: '2026-08-20T10:00:00.000Z',
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function stallSurplusRequests() {
  mockedFetchSavedPosts.mockImplementation(() => new Promise(() => {}));
}

beforeEach(() => {
  // Targeted `mockReset` on this file's own factory mocks, never
  // `jest.resetAllMocks()` — that one strips the implementations off
  // jest-expo's setup mocks and the next `@expo/vector-icons` mount fails with
  // `Module "1" is missing from the asset registry`.
  apiMocks.forEach((mock) => mock.mockReset());
  mockedUseAuth.mockReset();
  mockedUseAuth.mockReturnValue(authValue(TOKEN));
  COMMUNITY_READERS.forEach((reader) => consumeCommunityDirty(reader));
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('useSavedPosts · loading', () => {
  it('loads page one on mount with nothing but the token', async () => {
    // Owner-scoped server-side by the token, and there is nothing here to say
    // whose list it is — the alternative would be a user id in a query string
    // that the API would rightly ignore.
    const pending = deferred<PostsPage>();
    mockedFetchSavedPosts.mockReturnValueOnce(pending.promise);

    const { result } = await renderHook(() => useSavedPosts());

    expect(result.current.activity).toBe('loading');
    expect(mockedFetchSavedPosts).toHaveBeenCalledWith({ token: TOKEN });

    await act(async () => {
      pending.resolve({ posts: [post('post-1')] });
    });

    expect(result.current.activity).toBe('idle');
    expect(result.current.posts.map((entry) => entry.id)).toEqual(['post-1']);
    expect(result.current.posts[0].saved).toBe(true);
  });

  it('keeps the server’s save order rather than re-sorting by post age', async () => {
    // "Newest first" here means newest SAVE: a user who bookmarks a year-old
    // outfit expects it at the top. The order is the server's and this layer
    // must not improve on it.
    mockedFetchSavedPosts.mockResolvedValueOnce({
      posts: [
        post('old-post', { createdAt: '2025-01-01T00:00:00.000Z' }),
        post('new-post', { createdAt: '2026-08-20T10:00:00.000Z' }),
      ],
    });

    const { result } = await renderHook(() => useSavedPosts());
    await waitFor(() => expect(result.current.posts).toHaveLength(2));

    expect(result.current.posts.map((entry) => entry.id)).toEqual(['old-post', 'new-post']);
  });

  it('offers no search axis and no delete', async () => {
    // `GET /community/saved` takes a cursor and nothing else, so a `query`
    // here would be a control with nothing behind it. Deleting a post is an
    // owner-only act that belongs on the feed's card — two hooks offering the
    // same delete would be two places for the pending-delete guard to be
    // wrong.
    mockedFetchSavedPosts.mockResolvedValueOnce({ posts: [] });

    const { result } = await renderHook(() => useSavedPosts());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    expect(result.current).not.toHaveProperty('query');
    expect(result.current).not.toHaveProperty('setQuery');
    expect(result.current).not.toHaveProperty('remove');

    // The type-level half — a runtime assertion cannot see a key that a screen
    // could still be written against.
    // @ts-expect-error the saved list has no search axis.
    expect(result.current.setQuery).toBeUndefined();
    // @ts-expect-error deleting a post belongs to the feed.
    expect(result.current.remove).toBeUndefined();
  });
});

describe('useSavedPosts · paging', () => {
  it('appends the next page and reports hasMore from the cursor', async () => {
    mockedFetchSavedPosts.mockResolvedValueOnce({ posts: [post('post-1')], nextCursor: 'cur-1' });

    const { result } = await renderHook(() => useSavedPosts());
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    mockedFetchSavedPosts.mockResolvedValueOnce({ posts: [post('post-2')] });
    await act(async () => {
      result.current.loadMore();
    });

    expect(mockedFetchSavedPosts).toHaveBeenLastCalledWith({ token: TOKEN, cursor: 'cur-1' });
    expect(result.current.posts.map((entry) => entry.id)).toEqual(['post-1', 'post-2']);
    expect(result.current.hasMore).toBe(false);
  });

  it('does not page when there is no cursor', async () => {
    mockedFetchSavedPosts.mockResolvedValueOnce({ posts: [post('post-1')] });

    const { result } = await renderHook(() => useSavedPosts());
    await waitFor(() => expect(result.current.posts).toHaveLength(1));

    await act(async () => {
      result.current.loadMore();
    });

    expect(mockedFetchSavedPosts).toHaveBeenCalledTimes(1);
  });

  it('issues one request for a burst of onEndReached calls', async () => {
    mockedFetchSavedPosts.mockResolvedValueOnce({ posts: [post('post-1')], nextCursor: 'cur-1' });

    const { result } = await renderHook(() => useSavedPosts());
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    const second = deferred<PostsPage>();
    stallSurplusRequests();
    mockedFetchSavedPosts.mockReturnValueOnce(second.promise);

    await act(async () => {
      result.current.loadMore();
      result.current.loadMore();
      result.current.loadMore();
    });

    expect(mockedFetchSavedPosts).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve({ posts: [post('post-2')] });
    });
    expect(result.current.posts.map((entry) => entry.id)).toEqual(['post-1', 'post-2']);
  });
});

describe('useSavedPosts · refresh and errors', () => {
  it('keeps the previous rows while refreshing and replaces them on success', async () => {
    mockedFetchSavedPosts.mockResolvedValueOnce({ posts: [post('post-1')] });

    const { result } = await renderHook(() => useSavedPosts());
    await waitFor(() => expect(result.current.posts).toHaveLength(1));

    const refreshing = deferred<PostsPage>();
    mockedFetchSavedPosts.mockReturnValueOnce(refreshing.promise);
    await act(async () => {
      result.current.refresh();
    });

    expect(result.current.activity).toBe('refreshing');
    expect(result.current.posts.map((entry) => entry.id)).toEqual(['post-1']);

    await act(async () => {
      refreshing.resolve({ posts: [post('post-2')] });
    });
    expect(result.current.posts.map((entry) => entry.id)).toEqual(['post-2']);
  });

  it('does not let the superseded append re-open paging while the refresh is still running', async () => {
    // The saved list's own copy of the feed's guard, written out rather than
    // assumed symmetric — it is a separate `finally` in a separate hook, and a
    // guard present in one and missing in the other passes every test on the
    // other side. Unguarded, the superseded append's `finally` marks this list
    // idle while its replacement is still in flight, and the next
    // `onEndReached` pages on top of a running refresh.
    mockedFetchSavedPosts.mockResolvedValueOnce({ posts: [post('post-1')], nextCursor: 'cur-1' });

    const { result } = await renderHook(() => useSavedPosts());
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    const append = deferred<PostsPage>();
    const refreshing = deferred<PostsPage>();
    stallSurplusRequests();
    mockedFetchSavedPosts
      .mockReturnValueOnce(append.promise)
      .mockReturnValueOnce(refreshing.promise);

    await act(async () => {
      result.current.loadMore();
    });
    await act(async () => {
      result.current.refresh();
    });
    expect(mockedFetchSavedPosts).toHaveBeenCalledTimes(3);

    // The superseded append answers first, while the refresh is still out.
    await act(async () => {
      append.resolve({ posts: [post('post-2')], nextCursor: 'cur-2' });
    });

    await act(async () => {
      result.current.loadMore();
    });

    // Still three: the refresh owns the flag until it settles.
    expect(mockedFetchSavedPosts).toHaveBeenCalledTimes(3);

    await act(async () => {
      refreshing.resolve({ posts: [post('post-5')] });
    });
    expect(result.current.posts.map((entry) => entry.id)).toEqual(['post-5']);
  });

  it('does not issue a second page-one request while one is already running', async () => {
    const first = deferred<PostsPage>();
    stallSurplusRequests();
    mockedFetchSavedPosts.mockReturnValueOnce(first.promise);

    const { result } = await renderHook(() => useSavedPosts());

    await act(async () => {
      result.current.refresh();
      result.current.refresh();
    });

    expect(mockedFetchSavedPosts).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve({ posts: [] });
    });
  });

  it('keeps the rows and the cursor when a page load fails', async () => {
    mockedFetchSavedPosts.mockResolvedValueOnce({ posts: [post('post-1')], nextCursor: 'cur-1' });

    const { result } = await renderHook(() => useSavedPosts());
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    mockedFetchSavedPosts.mockRejectedValueOnce(
      new ApiClientError('NETWORK', 'Cannot reach the server. Check your connection.'),
    );
    await act(async () => {
      result.current.loadMore();
    });

    expect(result.current.error).toBe('Cannot reach the server. Check your connection.');
    expect(result.current.posts.map((entry) => entry.id)).toEqual(['post-1']);
    expect(result.current.hasMore).toBe(true);
  });

  it('falls back to its own message for a non-API failure', async () => {
    mockedFetchSavedPosts.mockRejectedValueOnce(new Error('boom'));

    const { result } = await renderHook(() => useSavedPosts());

    await waitFor(() =>
      expect(result.current.error).toBe('Something went wrong loading your saved posts.'),
    );
  });
});

describe('useSavedPosts · stale responses', () => {
  it('discards a success from a request three tokens ago, even when the token matches again', async () => {
    // A → B → A. A value comparison cannot separate these: the responses carry
    // nothing that says which request they answer, and the first and third
    // requests are byte-identical.
    const a1 = deferred<PostsPage>();
    const b = deferred<PostsPage>();
    const a2 = deferred<PostsPage>();
    stallSurplusRequests();
    mockedFetchSavedPosts
      .mockReturnValueOnce(a1.promise)
      .mockReturnValueOnce(b.promise)
      .mockReturnValueOnce(a2.promise);

    const { result, rerender } = await renderHook(() => useSavedPosts());

    mockedUseAuth.mockReturnValue(authValue('tok-other'));
    await act(async () => {
      await rerender(undefined);
    });
    mockedUseAuth.mockReturnValue(authValue(TOKEN));
    await act(async () => {
      await rerender(undefined);
    });

    expect(mockedFetchSavedPosts).toHaveBeenCalledTimes(3);

    await act(async () => {
      a2.resolve({ posts: [post('fresh')], nextCursor: 'fresh-cursor' });
    });
    await waitFor(() => expect(result.current.posts.map((e) => e.id)).toEqual(['fresh']));

    await act(async () => {
      a1.resolve({ posts: [post('stale')], nextCursor: 'stale-cursor' });
    });

    expect(result.current.posts.map((e) => e.id)).toEqual(['fresh']);

    // The cursor had to be discarded too, or the next page comes from the
    // superseded request's position in a list belonging to another session.
    mockedFetchSavedPosts.mockReturnValueOnce(new Promise(() => {}));
    await act(async () => {
      result.current.loadMore();
    });
    expect(mockedFetchSavedPosts).toHaveBeenLastCalledWith({
      token: TOKEN,
      cursor: 'fresh-cursor',
    });

    await act(async () => {
      b.resolve({ posts: [post('older-still')] });
    });
    expect(result.current.posts.map((e) => e.id)).toEqual(['fresh']);
  });

  it('discards a failure from a request three tokens ago, even when the token matches again', async () => {
    // A separate mechanism from the success-path guard: one `if` cannot cover
    // both, and this is the half written after the success path already works.
    const a1 = deferred<PostsPage>();
    const b = deferred<PostsPage>();
    const a2 = deferred<PostsPage>();
    stallSurplusRequests();
    mockedFetchSavedPosts
      .mockReturnValueOnce(a1.promise)
      .mockReturnValueOnce(b.promise)
      .mockReturnValueOnce(a2.promise);

    const { result, rerender } = await renderHook(() => useSavedPosts());

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

    await act(async () => {
      b.reject(new ApiClientError('UNAUTHORIZED', 'Session expired', 401));
    });
    expect(result.current.error).toBeNull();
  });

  it('clears the previous user’s saved list when the token changes', async () => {
    mockedFetchSavedPosts.mockResolvedValueOnce({ posts: [post('post-1')] });
    const { result, rerender } = await renderHook(() => useSavedPosts());
    await waitFor(() => expect(result.current.posts).toHaveLength(1));

    const next = deferred<PostsPage>();
    stallSurplusRequests();
    mockedFetchSavedPosts.mockReturnValueOnce(next.promise);
    mockedUseAuth.mockReturnValue(authValue('tok-other'));

    await act(async () => {
      await rerender(undefined);
    });

    // A saved list is private. Another user's bookmarks must not sit under a
    // spinner for even one frame.
    expect(result.current.posts).toEqual([]);
    expect(result.current.activity).toBe('loading');

    await act(async () => {
      next.resolve({ posts: [] });
    });
  });
});

describe('useSavedPosts · interactions', () => {
  async function savedWith(first: PublicPost) {
    mockedFetchSavedPosts.mockResolvedValueOnce({ posts: [first] });
    const rendered = await renderHook(() => useSavedPosts());
    await waitFor(() => expect(rendered.result.current.posts).toHaveLength(1));
    return rendered;
  }

  it('likes and unlikes from the saved list on the same optimistic terms', async () => {
    const { result } = await savedWith(post('post-1', { likeCount: 3, liked: false }));

    const pending = deferred<PostLikeResult>();
    mockedLikePost.mockReturnValueOnce(pending.promise);

    await act(async () => {
      void result.current.toggleLike('post-1');
    });
    expect(result.current.posts[0].liked).toBe(true);
    expect(result.current.posts[0].likeCount).toBe(4);

    await act(async () => {
      pending.resolve({ likeCount: 7, liked: true });
    });
    expect(result.current.posts[0].likeCount).toBe(7);
  });

  it('rolls a failed like back to the state that was there before the tap', async () => {
    // Two `act`s, not one, for the reason `useCommunityFeed.test.ts` spells
    // out at the same test: with the tap and the failure in a single `act` the
    // optimistic write never commits first, so a rollback reading the live row
    // and a rollback reading the pre-tap snapshot produce identical output and
    // the test discriminates nothing.
    const { result } = await savedWith(post('post-1', { likeCount: 3, liked: false }));

    const pending = deferred<PostLikeResult>();
    mockedLikePost.mockReturnValueOnce(pending.promise);

    await act(async () => {
      void result.current.toggleLike('post-1');
    });

    expect(result.current.posts[0].liked).toBe(true);
    expect(result.current.posts[0].likeCount).toBe(4);

    await act(async () => {
      pending.reject(new ApiClientError('UNKNOWN', 'Request failed (500)', 500));
    });

    expect(result.current.posts[0].liked).toBe(false);
    expect(result.current.posts[0].likeCount).toBe(3);
    expect(result.current.error).toBe('Request failed (500)');
  });

  it('keeps an unsaved post in the array it is holding, with a hollow bookmark', async () => {
    // A statement about THIS HOOK's array, not about what a screen draws —
    // `app/(tabs)/favorites.tsx` renders `posts.filter(post => post.saved)`, so
    // the row does leave the saved list on screen. Keeping the post here is
    // what makes that safe: the patch that restores `saved: true` after a
    // failed unsave can only reach posts this list is still holding, so a post
    // dropped from the array on the optimistic write would stay dropped when
    // the request failed — an optimistic update with no rollback, arriving
    // through list membership instead of through a flag.
    const { result } = await savedWith(post('post-1', { saved: true }));

    mockedUnsavePost.mockResolvedValueOnce({ saved: false });
    await act(async () => {
      await result.current.toggleSave('post-1');
    });

    expect(result.current.posts.map((entry) => entry.id)).toEqual(['post-1']);
    expect(result.current.posts[0].saved).toBe(false);
    // The next focus reloads page one, and that is where the post goes for
    // good — the screen's filter hides it in the meantime.
    expect(consumeCommunityDirty('saved')).toBe(true);
  });

  it('lets an accidental unsave be undone without a refetch', async () => {
    const { result } = await savedWith(post('post-1', { saved: true }));

    mockedUnsavePost.mockResolvedValueOnce({ saved: false });
    await act(async () => {
      await result.current.toggleSave('post-1');
    });
    expect(result.current.posts[0].saved).toBe(false);

    mockedSavePost.mockResolvedValueOnce({ saved: true });
    await act(async () => {
      await result.current.toggleSave('post-1');
    });

    expect(mockedSavePost).toHaveBeenCalledWith('post-1', TOKEN);
    expect(result.current.posts[0].saved).toBe(true);
  });

  it('rolls a failed unsave back so the bookmark does not lie', async () => {
    // Split for the same reason as the like above. The bookmark has to be
    // observed hollow BEFORE the request fails, or "restore the snapshot" and
    // "restore whatever the row now says" are the same instruction.
    const { result } = await savedWith(post('post-1', { saved: true }));

    const pending = deferred<PostSaveResult>();
    mockedUnsavePost.mockReturnValueOnce(pending.promise);

    await act(async () => {
      void result.current.toggleSave('post-1');
    });

    expect(result.current.posts[0].saved).toBe(false);

    await act(async () => {
      pending.reject(new ApiClientError('UNKNOWN', 'Request failed (500)', 500));
    });

    expect(result.current.posts[0].saved).toBe(true);
    expect(result.current.error).toBe('Request failed (500)');
    expect(consumeCommunityDirty('saved')).toBe(false);
  });
});
