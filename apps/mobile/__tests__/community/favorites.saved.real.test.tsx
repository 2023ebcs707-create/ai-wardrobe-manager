import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useFocusEffect } from 'expo-router';
import type { PublicClothingItem, PublicPost } from '@wardrobe/shared';
import FavoritesScreen from '../../app/(tabs)/favorites';
// The real `ApiClientError` — not a mock. Automocking a class that extends
// Error yields something that cannot be constructed.
import { ApiClientError } from '../../src/api/client';
import { useAuth } from '../../src/auth/AuthContext';
import { fetchSavedPosts, unsavePost } from '../../src/community/api';
import {
  COMMUNITY_READERS,
  consumeCommunityDirty,
  markCommunityDirty,
} from '../../src/community/communityDirty';
import { fetchOutfits } from '../../src/outfits/api';

// In `__tests__/` rather than beside the route — see the note in
// `favorites.saved.test.tsx`.

/**
 * The one file in this task that runs the REAL `useSavedPosts`, `usePostList`
 * and `MasonryFeed`, because the properties below are properties of the hook
 * and the screen TOGETHER and are unfalsifiable with the hook mocked.
 *
 * 1. **An unsave takes the row off this list.** The screen renders
 *    `posts.filter(post => post.saved)` and the hook deliberately KEEPS the
 *    post in `posts`, so with a mocked hook the filter can only be shown a
 *    fixture; here the flag really is flipped by a real optimistic write
 *    travelling through the interaction channel.
 * 2. **A failed unsave puts the row back.** That is the reason the hook keeps
 *    the post rather than dropping it, and it is the direction a
 *    "removes the row" test on its own cannot see. A mocked `toggleSave` cannot
 *    roll anything back.
 * 3. **Choosing the saved mode with a change already pending costs one
 *    request, not two.** The gate consumes on a mount whose page-one load is
 *    already in flight, and `refresh` is a no-op while a full-list load is
 *    running. That is a claim about effect ordering across two modules — the
 *    hook's effect is registered earlier in `SavedPostsPane` than the focus
 *    effect, so it runs first. If it were wrong, every first visit after a save
 *    would issue two page-one requests and no test in this repo would notice.
 *
 * `../../src/community/api` and `../../src/outfits/api` export plain functions
 * and (erased) interfaces — no class — so factory mocks here are safe in the
 * way a mock of `../../src/api/client` would not be.
 */
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

jest.mock('../../src/outfits/api', () => ({
  createOutfit: jest.fn(),
  fetchOutfits: jest.fn(),
  fetchOutfit: jest.fn(),
  updateOutfit: jest.fn(),
  deleteOutfit: jest.fn(),
}));

// Only `useAuth` is used, so the real module (and its expo-secure-store
// dependency) is never loaded.
jest.mock('../../src/auth/AuthContext', () => ({ useAuth: jest.fn() }));

/**
 * `useFocusEffect` reduced to its ordering-relevant core: expo-router's own
 * implementation runs the callback from inside a `React.useEffect` declared in
 * the calling component, and calls it immediately when the screen is already
 * focused — which is what choosing a mode on a tab the user is standing on is.
 * The substitution that matters is that the effect is registered at the point
 * the component calls the hook, which is what puts it after `useSavedPosts`'s
 * own mount effect.
 */
jest.mock('expo-router', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: jest.fn(),
    useFocusEffect: jest.fn((effect: () => void) => {
      ReactActual.useEffect(effect, [effect]);
    }),
  };
});

const mockedFetchSavedPosts = jest.mocked(fetchSavedPosts);
const mockedUnsavePost = jest.mocked(unsavePost);
const mockedFetchOutfits = jest.mocked(fetchOutfits);
const mockedUseAuth = jest.mocked(useAuth);
const mockedUseFocusEffect = useFocusEffect as unknown as jest.Mock;

const TOKEN = 'tok-abc';

function item(id: string): PublicClothingItem {
  return {
    id,
    userId: 'author-1',
    imageUrl: `https://example.test/full/${id}.jpg`,
    thumbnailUrl: `https://example.test/thumb/${id}.jpg`,
    category: 'shirt',
    colors: [{ hex: '#001f3f', name: 'navy', share: 1 }],
    seasons: ['summer'],
    laundryStatus: 'available',
    retired: false,
    wearCount: 0,
    source: 'manual',
    createdAt: '2026-08-20T10:00:00.000Z',
  };
}

/** The wire shape — this file goes through `toDisplayPost` rather than around
 *  it. Saved by definition: it came back from `GET /community/saved`. */
function wirePost(id: string): PublicPost {
  return {
    id,
    author: { id: 'author-1', name: 'Ada Lovelace' },
    itemIds: [`${id}-a`],
    items: [item(`${id}-a`)],
    caption: `Caption ${id}`,
    likeCount: 0,
    liked: false,
    saved: true,
    createdAt: '2026-08-24T09:00:00.000Z',
  };
}

/** Choose the saved-posts mode, which is what mounts the pane and its hook. */
async function chooseSavedMode(): Promise<void> {
  await act(async () => {
    fireEvent.press(screen.getByTestId('favorites-mode-saved'));
  });
}

/** The focus callback the SAVED pane registered — the last one, because the
 *  pane always renders after the screen that holds it. See the same helper in
 *  `favorites.saved.test.tsx`. */
function savedFocusCallback(): () => void {
  const { calls } = mockedUseFocusEffect.mock;
  return calls[calls.length - 1][0] as () => void;
}

describe('saved posts on the Favorites tab (real useSavedPosts)', () => {
  beforeEach(() => {
    mockedUseAuth.mockReturnValue({
      status: 'authenticated',
      user: { id: 'viewer-1', name: 'Grace Hopper', email: 'grace@example.test', createdAt: '2026-08-01T10:00:00.000Z' },
      token: TOKEN,
      signIn: jest.fn(),
      signUp: jest.fn(),
      signOut: jest.fn(),
    });
    mockedFetchOutfits.mockResolvedValue({ outfits: [] });
    mockedFetchSavedPosts.mockResolvedValue({ posts: [wirePost('p1')] });
  });

  afterEach(() => {
    jest.clearAllMocks();
    COMMUNITY_READERS.forEach((reader) => consumeCommunityDirty(reader));
  });

  it('does not fetch the saved list until the mode is chosen', async () => {
    // `useSavedPosts` fetches on mount, so WHERE it is called decides how often
    // `GET /community/saved` is issued. Declared inside `SavedPostsPane` rather
    // than at the top of the screen, it runs when the mode is chosen and not
    // when somebody opens this tab to look at their outfits — the reasoning
    // `SuggestionsPane` records on the Add tab, measured here rather than
    // asserted.
    await render(<FavoritesScreen />);
    await waitFor(() => {
      expect(mockedFetchOutfits).toHaveBeenCalledTimes(1);
    });

    expect(mockedFetchSavedPosts).not.toHaveBeenCalled();

    await chooseSavedMode();
    await waitFor(() => {
      expect(mockedFetchSavedPosts).toHaveBeenCalledTimes(1);
    });
  });

  it('takes the row off the list when the viewer unsaves it', async () => {
    mockedUnsavePost.mockResolvedValue({ saved: false });

    await render(<FavoritesScreen />);
    await chooseSavedMode();
    await waitFor(() => {
      expect(screen.getByTestId('post-card-p1')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(screen.getByTestId('post-save-p1'));
    });

    // Gone from the screen — a list called "Saved posts" showing something the
    // viewer has just unsaved is wrong about its own contents.
    expect(screen.queryByTestId('post-card-p1')).toBeNull();
    expect(mockedUnsavePost).toHaveBeenCalledWith('p1', TOKEN);
    // ...and the last row leaving is what the empty state is for.
    expect(screen.getByTestId('community-empty-title')).toHaveTextContent('Nothing saved yet');
    // The write raised the flag itself, inside `usePostList`. That is what makes
    // the next focus reload page one and drop the post for good.
    expect(consumeCommunityDirty('saved')).toBe(true);
  });

  it('puts the row back when the unsave fails', async () => {
    // THE OTHER DIRECTION, and the reason `useSavedPosts` keeps the post in its
    // array rather than dropping it: the patch that restores `saved: true` can
    // only reach posts the list is still holding. Filtering at the render is
    // what keeps that rollback reachable — a row dropped from the hook's array
    // would stay dropped, an optimistic update with no rollback.
    mockedUnsavePost.mockRejectedValue(new ApiClientError('UNKNOWN', 'Request failed (500)', 500));

    await render(<FavoritesScreen />);
    await chooseSavedMode();
    await waitFor(() => {
      expect(screen.getByTestId('post-card-p1')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(screen.getByTestId('post-save-p1'));
    });

    expect(screen.getByTestId('post-card-p1')).toBeTruthy();
    expect(screen.getByTestId('community-error-message')).toHaveTextContent('Request failed (500)');
    // Nothing changed on the server, so nothing is stale.
    expect(consumeCommunityDirty('saved')).toBe(false);
  });

  it('does not issue a second page-one request when the mode is opened with a pending change', async () => {
    // The real sequence: the user saves a post on the Search tab and then opens
    // the saved list for the first time this session. The flag is set BEFORE
    // this pane mounts, so the mount load and the focus gate both want page one
    // — and the hook's `inFlightRef` guard is what makes the second a no-op.
    // That only works because `useSavedPosts`'s effect is registered earlier in
    // `SavedPostsPane` than the focus effect, so it runs first.
    markCommunityDirty(['saved']);

    await render(<FavoritesScreen />);
    await chooseSavedMode();
    await waitFor(() => {
      expect(screen.getByTestId('post-card-p1')).toBeTruthy();
    });

    expect(mockedFetchSavedPosts).toHaveBeenCalledTimes(1);
    // Consumed rather than left pending: the request that swallowed it was
    // itself a page-one load, so the list on screen already reflects the change.
    expect(consumeCommunityDirty('saved')).toBe(false);
  });

  it('reloads page one when the tab is focused after a save made elsewhere', async () => {
    await render(<FavoritesScreen />);
    await chooseSavedMode();
    await waitFor(() => {
      expect(screen.getByTestId('post-card-p1')).toBeTruthy();
    });
    expect(mockedFetchSavedPosts).toHaveBeenCalledTimes(1);

    const onFocus = savedFocusCallback();
    mockedFetchSavedPosts.mockResolvedValue({ posts: [wirePost('p2')] });
    markCommunityDirty(['saved']);
    await act(async () => {
      onFocus();
    });

    await waitFor(() => {
      expect(screen.getByTestId('post-card-p2')).toBeTruthy();
    });
    // Page one, not a cursor: a save adds a row at the TOP of a
    // newest-save-first list, so a `?cursor=` would page straight past it.
    expect(mockedFetchSavedPosts).toHaveBeenLastCalledWith({ token: TOKEN });
    expect(screen.queryByTestId('post-card-p1')).toBeNull();
  });

  it('keeps the page it is holding when the tab regains focus with nothing changed', async () => {
    await render(<FavoritesScreen />);
    await chooseSavedMode();
    await waitFor(() => {
      expect(screen.getByTestId('post-card-p1')).toBeTruthy();
    });

    const onFocus = savedFocusCallback();
    await act(async () => {
      onFocus();
    });

    // `refresh()` is a page-ONE load that REPLACES the list, so an ungated
    // focus effect throws away every page the user has scrolled to. One request
    // and the rows still on screen.
    expect(mockedFetchSavedPosts).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('post-card-p1')).toBeTruthy();
  });
});
