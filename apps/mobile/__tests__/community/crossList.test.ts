import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { PublicClothingItem, PublicPost } from '@wardrobe/shared';
import { ApiClientError } from '../../src/api/client';
import { useAuth } from '../../src/auth/AuthContext';
import {
  fetchFeed,
  fetchSavedPosts,
  likePost,
  savePost,
  unlikePost,
  unsavePost,
  type PostLikeResult,
} from '../../src/community/api';
import {
  COMMUNITY_READERS,
  consumeCommunityDirty,
} from '../../src/community/communityDirty';
import { useCommunityFeed } from '../../src/community/useCommunityFeed';
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

const mockedFetchFeed = jest.mocked(fetchFeed);
const mockedFetchSavedPosts = jest.mocked(fetchSavedPosts);
const mockedLikePost = jest.mocked(likePost);
const mockedUnlikePost = jest.mocked(unlikePost);
const mockedSavePost = jest.mocked(savePost);
const mockedUnsavePost = jest.mocked(unsavePost);
const mockedUseAuth = jest.mocked(useAuth);

const apiMocks = [
  mockedFetchFeed,
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

function post(id: string, overrides: Partial<PublicPost> = {}): PublicPost {
  return {
    id,
    author: { id: 'author-1', name: 'Ada' },
    itemIds: [shirt.id],
    items: [shirt],
    caption: `caption for ${id}`,
    likeCount: 3,
    liked: false,
    saved: false,
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

/**
 * Both lists mounted at once, which is the state the app is in as soon as a
 * user has visited the Search tab and the Favorites tab: a tab navigator keeps
 * a visited screen mounted.
 */
async function bothLists(feed: PublicPost[], saved: PublicPost[]) {
  mockedFetchFeed.mockResolvedValueOnce({ posts: feed });
  mockedFetchSavedPosts.mockResolvedValueOnce({ posts: saved });
  const rendered = await renderHook(() => ({
    feed: useCommunityFeed(),
    saved: useSavedPosts(),
  }));
  await waitFor(() => expect(rendered.result.current.feed.posts).toHaveLength(feed.length));
  await waitFor(() => expect(rendered.result.current.saved.posts).toHaveLength(saved.length));
  return rendered;
}

beforeEach(() => {
  apiMocks.forEach((mock) => mock.mockReset());
  mockedUseAuth.mockReset();
  mockedUseAuth.mockReturnValue(authValue(TOKEN));
  COMMUNITY_READERS.forEach((reader) => consumeCommunityDirty(reader));
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('one post held by two lists', () => {
  it('shows a like made in the feed on the saved list’s copy, optimistically and again on the server’s answer', async () => {
    // The failure this prevents is not subtle in use and is invisible in a
    // single-hook test: like a post on the Search tab, switch to Favorites,
    // and the same card sits there with a hollow heart and a count one lower.
    const { result } = await bothLists(
      [post('shared', { likeCount: 3, liked: false, saved: true }), post('feed-only')],
      [post('shared', { likeCount: 3, liked: false, saved: true })],
    );

    const pending = deferred<PostLikeResult>();
    mockedLikePost.mockReturnValueOnce(pending.promise);

    await act(async () => {
      void result.current.feed.toggleLike('shared');
    });

    expect(result.current.feed.posts[0].liked).toBe(true);
    expect(result.current.feed.posts[0].likeCount).toBe(4);
    expect(result.current.saved.posts[0].liked).toBe(true);
    expect(result.current.saved.posts[0].likeCount).toBe(4);

    await act(async () => {
      pending.resolve({ likeCount: 11, liked: true });
    });

    expect(result.current.feed.posts[0].likeCount).toBe(11);
    expect(result.current.saved.posts[0].likeCount).toBe(11);
    // One request, not one per list holding the post.
    expect(mockedLikePost).toHaveBeenCalledTimes(1);
  });

  it('shows a like made in the saved list on the feed’s copy', async () => {
    // The same channel in the other direction. Written out rather than assumed
    // symmetric: the two hooks subscribe separately, and a subscription
    // present in one and missing in the other would pass the test above.
    const { result } = await bothLists(
      [post('shared', { likeCount: 3, liked: false, saved: true })],
      [post('shared', { likeCount: 3, liked: false, saved: true })],
    );

    mockedLikePost.mockResolvedValueOnce({ likeCount: 4, liked: true });

    await act(async () => {
      await result.current.saved.toggleLike('shared');
    });

    expect(result.current.saved.posts[0].liked).toBe(true);
    expect(result.current.feed.posts[0].liked).toBe(true);
    expect(result.current.feed.posts[0].likeCount).toBe(4);
  });

  it('rolls a failed like back in both lists, and takes the saved list’s fresher count down with it', async () => {
    // Two things, and the second is a disclosure rather than a boast.
    //
    // 1. A rollback that reached only the list the tap came from would leave
    //    the other one showing a like that never happened — worse than no
    //    rollback, because the two screens now disagree.
    // 2. THE TWO FIXTURE COUNTS DIVERGE ON PURPOSE, 3 and 8. Lists loaded at
    //    different moments legitimately hold different counts for one post —
    //    the last test in this file documents exactly that — and giving both
    //    lists the same number here would make the saved list's post-rollback
    //    values identical to its initial ones. The test would then pass with
    //    the channel severed entirely, and "the saved list was reached" would
    //    be asserted by a coincidence of the fixture rather than measured.
    //
    // The optimistic patch is therefore observed ON THE SAVED LIST before the
    // failure, in its own `act`, which is the assertion the channel has to
    // earn. Splitting the two `act`s also stops the rollback being read on a
    // list that never committed the optimistic value.
    const { result } = await bothLists(
      [post('shared', { likeCount: 3, liked: false, saved: true })],
      [post('shared', { likeCount: 8, liked: false, saved: true })],
    );

    const pending = deferred<PostLikeResult>();
    mockedLikePost.mockReturnValueOnce(pending.promise);

    await act(async () => {
      void result.current.feed.toggleLike('shared');
    });

    // Absolute, never a delta: the patch says "this count is 4", so the saved
    // list's 8 becomes 4 rather than 9.
    expect(result.current.feed.posts[0].liked).toBe(true);
    expect(result.current.feed.posts[0].likeCount).toBe(4);
    expect(result.current.saved.posts[0].liked).toBe(true);
    expect(result.current.saved.posts[0].likeCount).toBe(4);

    await act(async () => {
      pending.reject(new ApiClientError('UNKNOWN', 'Request failed (500)', 500));
    });

    expect(result.current.feed.posts[0].liked).toBe(false);
    expect(result.current.feed.posts[0].likeCount).toBe(3);
    expect(result.current.saved.posts[0].liked).toBe(false);
    // AND HERE IS THE COST, WRITTEN DOWN RATHER THAN LEFT TO BE DISCOVERED:
    // the saved list held 8 before the tap and holds 3 after a like that did
    // nothing at all. The rollback can only name the snapshot the TAPPING list
    // took, because a patch carries an absolute number and nothing else; a
    // per-list restore would need a conditional patch — restore only where the
    // value is still the optimistic one — which is machinery this stage
    // deliberately does not have. Reaching it needs no concurrent refresh:
    // two lists loaded at different moments and one failed like are enough.
    expect(result.current.saved.posts[0].likeCount).toBe(3);
    // The error belongs to the list the user tapped in, and only to it.
    expect(result.current.feed.error).toBe('Request failed (500)');
    expect(result.current.saved.error).toBeNull();
  });

  it('lets a second tap from the other list through, and keeps whichever answer lands last', async () => {
    // The in-flight guard is per hook instance rather than module-wide, and
    // this is what that choice costs — measured here rather than reasoned
    // about in a comment, because the obvious account of it is wrong twice.
    //
    // The obvious account is "both taps go out and the server's second answer
    // wins". In fact:
    //
    //   * the SECOND TAP IS AN UNLIKE. The first tap's optimistic patch has
    //     already reached the saved list, so the second hook looks the post up
    //     and finds `liked: true`. One `POST` and one `DELETE` go out, which
    //     is what two taps of a toggle mean — neither is swallowed, which is
    //     the whole point of not sharing the guard across instances.
    //   * the answer that sticks is the LAST TO ARRIVE, not the second to be
    //     issued, because both are published absolutely.
    const { result } = await bothLists(
      [post('shared', { likeCount: 3, liked: false, saved: true })],
      [post('shared', { likeCount: 3, liked: false, saved: true })],
    );

    const liking = deferred<PostLikeResult>();
    const unliking = deferred<PostLikeResult>();
    mockedLikePost.mockReturnValueOnce(liking.promise);
    mockedUnlikePost.mockReturnValueOnce(unliking.promise);

    await act(async () => {
      void result.current.feed.toggleLike('shared');
    });
    await act(async () => {
      void result.current.saved.toggleLike('shared');
    });

    // Answers reordered: the DELETE settles first, the POST second. Both
    // deferreds are drained BEFORE anything is asserted, deliberately: an
    // assertion that fails here would otherwise leave a promise parked in the
    // in-flight guard and take every later test in this file down with it, and
    // a row of collateral failures is a mutation score that means nothing.
    await act(async () => {
      unliking.resolve({ likeCount: 3, liked: false });
    });
    await act(async () => {
      liking.resolve({ likeCount: 4, liked: true });
    });

    // Neither tap was swallowed: one POST and one DELETE went out.
    expect(mockedLikePost).toHaveBeenCalledTimes(1);
    expect(mockedUnlikePost).toHaveBeenCalledTimes(1);

    // Both lists agree with each other and disagree with the server, which
    // ends at `{ liked: false, likeCount: 3 }` — the DELETE was processed
    // last. It resolves on the next load of either list. This is the price of
    // the per-instance guard, and it takes two fingers on two tabs plus a
    // reordering to reach; module-wide would instead swallow an ordinary
    // second tap on one card.
    expect(result.current.feed.posts[0]).toMatchObject({ liked: true, likeCount: 4 });
    expect(result.current.saved.posts[0]).toMatchObject({ liked: true, likeCount: 4 });
  });

  it('shows an unsave made in the feed as a hollow bookmark on the saved list’s copy', async () => {
    const { result } = await bothLists(
      [post('shared', { saved: true })],
      [post('shared', { saved: true })],
    );

    mockedUnsavePost.mockResolvedValueOnce({ saved: false });

    await act(async () => {
      await result.current.feed.toggleSave('shared');
    });

    expect(result.current.feed.posts[0].saved).toBe(false);
    // Still present — the row leaves on the next focused reload, not under the
    // user's finger — but no longer claiming to be saved.
    expect(result.current.saved.posts.map((entry) => entry.id)).toEqual(['shared']);
    expect(result.current.saved.posts[0].saved).toBe(false);
    expect(consumeCommunityDirty('saved')).toBe(true);
  });

  it('does not disturb a list that is not holding the post', async () => {
    // Every mounted list sees every patch, so a fresh array per patch would
    // re-render both lists on every interaction anywhere in the app —
    // including for posts they do not hold. The array identity is the
    // observable form of "nothing happened here".
    const { result } = await bothLists([post('feed-only')], [post('saved-only')]);

    const savedPostsBefore = result.current.saved.posts;

    mockedLikePost.mockResolvedValueOnce({ likeCount: 4, liked: true });
    await act(async () => {
      await result.current.feed.toggleLike('feed-only');
    });

    expect(result.current.feed.posts[0].likeCount).toBe(4);
    expect(result.current.saved.posts).toBe(savedPostsBefore);
  });

  it('leaves a feed load out of the saved list entirely', async () => {
    // Only mutations broadcast. A page that arrives from the server is written
    // into the list that asked for it and nowhere else: a feed page is
    // computed at some moment server-side and may already be older than a like
    // another list has since made, so republishing it would let a stale read
    // overwrite a fresher truth.
    const { result } = await bothLists(
      [post('shared', { likeCount: 3, liked: false, saved: true })],
      [post('shared', { likeCount: 3, liked: false, saved: true })],
    );

    mockedLikePost.mockResolvedValueOnce({ likeCount: 4, liked: true });
    await act(async () => {
      await result.current.feed.toggleLike('shared');
    });
    expect(result.current.saved.posts[0].likeCount).toBe(4);

    // A refresh of the feed carrying the pre-like count.
    mockedFetchFeed.mockResolvedValueOnce({
      posts: [post('shared', { likeCount: 3, liked: false, saved: true })],
    });
    await act(async () => {
      result.current.feed.refresh();
    });

    expect(result.current.feed.posts[0].likeCount).toBe(3);
    expect(result.current.saved.posts[0].likeCount).toBe(4);
  });

  it('keeps two lists that loaded the same post at different moments independent until it is touched', async () => {
    // The honest statement of what the "mutations only" rule costs. Two lists
    // loaded at different times can hold different counts for one post; the
    // next interaction reconciles them, because the server's answer is applied
    // to both as an absolute number.
    const { result } = await bothLists(
      [post('shared', { likeCount: 3, liked: false, saved: true })],
      [post('shared', { likeCount: 8, liked: false, saved: true })],
    );

    expect(result.current.feed.posts[0].likeCount).toBe(3);
    expect(result.current.saved.posts[0].likeCount).toBe(8);

    mockedLikePost.mockResolvedValueOnce({ likeCount: 9, liked: true });
    await act(async () => {
      await result.current.feed.toggleLike('shared');
    });

    expect(result.current.feed.posts[0].likeCount).toBe(9);
    expect(result.current.saved.posts[0].likeCount).toBe(9);
  });
});
