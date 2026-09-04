import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { useFocusEffect } from 'expo-router';
import type { PublicClothingItem } from '@wardrobe/shared';
import SearchScreen from '../../app/(tabs)/search';
import { useAuth } from '../../src/auth/AuthContext';
import {
  COMMUNITY_READERS,
  consumeCommunityDirty,
  markCommunityDirty,
} from '../../src/community/communityDirty';
import type { DisplayPost } from '../../src/community/posts';
import {
  useCommunityFeed,
  type UseCommunityFeedResult,
} from '../../src/community/useCommunityFeed';

// In `__tests__/` rather than beside the route: expo-router's Android
// require-context is recursive and bundles any `.tsx` beneath the app root as a
// route, `__tests__/` included.

// Only `useAuth` is mocked, not the whole module: a bare automock would also
// replace `AuthProvider`, which nothing here renders — and the real module
// pulls in expo-secure-store.
jest.mock('../../src/auth/AuthContext', () => ({ useAuth: jest.fn() }));

jest.mock('../../src/community/useCommunityFeed', () => ({
  ...jest.requireActual<typeof import('../../src/community/useCommunityFeed')>(
    '../../src/community/useCommunityFeed',
  ),
  useCommunityFeed: jest.fn(),
}));

/**
 * `useFocusEffect` reduced to its ordering-relevant core, exactly as
 * `__tests__/outfits/favorites.focus.test.tsx` does it: expo-router runs the
 * callback from a `React.useEffect` declared in the calling component, and
 * calls it immediately when the screen is already focused. The captured
 * callback is invoked directly below to stand for a later re-focus.
 */
jest.mock('expo-router', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  return {
    useFocusEffect: jest.fn((effect: () => void) => {
      ReactActual.useEffect(effect, [effect]);
    }),
  };
});

const mockedUseCommunityFeed = jest.mocked(useCommunityFeed);
const mockedUseAuth = jest.mocked(useAuth);

/** The signed-in user this screen reads the viewer id from. */
const VIEWER = {
  id: 'viewer-1',
  name: 'Grace Hopper',
  email: 'grace@example.test',
  createdAt: '2026-08-01T10:00:00.000Z',
};
const mockedUseFocusEffect = useFocusEffect as unknown as jest.Mock;

const loadMore = jest.fn();
const refresh = jest.fn();
const setQuery = jest.fn();
const toggleLike = jest.fn<Promise<boolean>, [string]>();
const toggleSave = jest.fn<Promise<boolean>, [string]>();
const remove = jest.fn<Promise<boolean>, [string]>();

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
    wearCount: 0,
    source: 'manual',
    createdAt: '2026-08-20T10:00:00.000Z',
  };
}

function post(id: string, overrides: Partial<DisplayPost> = {}): DisplayPost {
  return {
    id,
    author: { id: 'author-1', name: 'Ada Lovelace' },
    items: [item(`${id}-a`)],
    caption: `Caption ${id}`,
    likeCount: 0,
    liked: false,
    saved: false,
    createdAt: '2026-08-24T09:00:00.000Z',
    missingItemsNotice: null,
    ...overrides,
  };
}

/** The hook's contract, defaulted to "idle and empty" so each test states only
 *  the axis it is about. */
function community(overrides: Partial<UseCommunityFeedResult> = {}): UseCommunityFeedResult {
  return {
    posts: [],
    activity: 'idle',
    error: null,
    loadMore,
    refresh,
    hasMore: false,
    query: '',
    setQuery,
    toggleLike,
    toggleSave,
    remove,
    ...overrides,
  };
}

describe('Search tab (ruling 1 — the community feed lives here)', () => {
  beforeEach(() => {
    toggleLike.mockResolvedValue(true);
    toggleSave.mockResolvedValue(true);
    remove.mockResolvedValue(true);
    mockedUseAuth.mockReturnValue({
      status: 'authenticated',
      user: VIEWER,
      token: 'tok-abc',
      signIn: jest.fn(),
      signUp: jest.fn(),
      signOut: jest.fn(),
    });
    mockedUseCommunityFeed.mockReturnValue(community());
  });

  afterEach(() => {
    jest.clearAllMocks();
    // Drained through the public door rather than a test-only reset, so the
    // tests use the same one the app does. Module scope outlives a test.
    COMMUNITY_READERS.forEach((reader) => consumeCommunityDirty(reader));
  });

  describe('the feed', () => {
    it('renders posts from the community feed', async () => {
      mockedUseCommunityFeed.mockReturnValue(
        community({ posts: [post('p1', { caption: 'Rainy Tuesday layers' })] }),
      );
      await render(<SearchScreen />);
      expect(screen.getByTestId('post-card-p1')).toBeTruthy();
      expect(screen.getByTestId('post-caption-p1')).toHaveTextContent('Rainy Tuesday layers');
    });

    it('lays them out in the masonry', async () => {
      mockedUseCommunityFeed.mockReturnValue(community({ posts: [post('p1'), post('p2')] }));
      await render(<SearchScreen />);
      expect(screen.getByTestId('community-column-0')).toBeTruthy();
      expect(screen.getByTestId('community-column-1')).toBeTruthy();
    });

    it('wires the retry to a page-one load', async () => {
      mockedUseCommunityFeed.mockReturnValue(community({ error: 'Cannot reach the server.' }));
      await render(<SearchScreen />);
      fireEvent.press(screen.getByTestId('community-retry'));
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('wires the end of the list to the next page', async () => {
      mockedUseCommunityFeed.mockReturnValue(community({ posts: [post('p1')] }));
      await render(<SearchScreen />);
      fireEvent.scroll(screen.getByTestId('community-feed'), {
        nativeEvent: {
          contentOffset: { x: 0, y: 2000 },
          contentSize: { width: 400, height: 2100 },
          layoutMeasurement: { width: 400, height: 800 },
        },
      });
      expect(loadMore).toHaveBeenCalled();
    });

    it('wires a like to the hook, by id', async () => {
      mockedUseCommunityFeed.mockReturnValue(community({ posts: [post('p1')] }));
      await render(<SearchScreen />);
      fireEvent.press(screen.getByTestId('post-like-p1'));
      expect(toggleLike).toHaveBeenCalledWith('p1');
    });

    // One press per test, deliberately. Two presses in one test leave two
    // settled-but-unawaited promises inside RNTL's `act` scope, and React 19
    // reports that as overlapping `act()` calls on stderr — which would break
    // the pristine-output rule whether or not the assertions passed.
    it('wires a save to the hook, by id', async () => {
      mockedUseCommunityFeed.mockReturnValue(community({ posts: [post('p1')] }));
      await render(<SearchScreen />);
      fireEvent.press(screen.getByTestId('post-save-p1'));
      expect(toggleSave).toHaveBeenCalledWith('p1');
    });
  });

  /**
   * Ruling 7's control, reachable at last. `remove` and
   * `DELETE /community/posts/:id` were both built and neither had a caller, so
   * a user could publish to a public feed and had no way to take it back down
   * from anywhere in the app — the user-harm gap the endpoint was added FOR.
   */
  describe('retracting your own post', () => {
    it('offers the control on the signed-in user’s own post and on nobody else’s', async () => {
      mockedUseCommunityFeed.mockReturnValue(
        community({
          posts: [
            post('mine', { author: { id: VIEWER.id, name: VIEWER.name } }),
            post('theirs', { author: { id: 'author-1', name: 'Ada Lovelace' } }),
          ],
        }),
      );
      await render(<SearchScreen />);

      expect(screen.getByTestId('post-retract-mine')).toBeTruthy();
      expect(screen.queryByTestId('post-retract-theirs')).toBeNull();
    });

    it('takes the viewer id from AuthContext, not from anything on the post', async () => {
      // The same post, the same feed, a different signed-in user — and the
      // control goes away. `post.items[i].userId` is the AUTHOR's id, so a card
      // reading it would show this control on every post in the feed; the only
      // thing that separates these two runs is who `useAuth` says is looking.
      mockedUseAuth.mockReturnValue({
        status: 'authenticated',
        user: {
          id: 'somebody-else',
          name: 'Somebody Else',
          email: 'else@example.test',
          createdAt: '2026-08-01T10:00:00.000Z',
        },
        token: 'tok-abc',
        signIn: jest.fn(),
        signUp: jest.fn(),
        signOut: jest.fn(),
      });
      mockedUseCommunityFeed.mockReturnValue(
        community({ posts: [post('mine', { author: { id: VIEWER.id, name: VIEWER.name } })] }),
      );
      await render(<SearchScreen />);

      expect(screen.queryByTestId('post-retract-mine')).toBeNull();
    });

    it("wires a confirmed retract to the hook's remove, by id", async () => {
      mockedUseCommunityFeed.mockReturnValue(
        community({ posts: [post('mine', { author: { id: VIEWER.id, name: VIEWER.name } })] }),
      );
      await render(<SearchScreen />);

      await fireEvent.press(screen.getByTestId('post-retract-mine'));
      await fireEvent.press(screen.getByTestId('post-retract-confirm-mine'));

      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledWith('mine');
    });

    it('shows the failure the hook reports, on the feed’s own banner', async () => {
      // `remove` resolves `false` and writes its message to the hook's `error`
      // channel; this screen renders that channel in one place. A card with its
      // own error line would be a second message store that can disagree with
      // it.
      mockedUseCommunityFeed.mockReturnValue(
        community({
          posts: [post('mine', { author: { id: VIEWER.id, name: VIEWER.name } })],
          error: 'Something went wrong deleting that post.',
        }),
      );
      await render(<SearchScreen />);

      expect(screen.getByTestId('community-error-message')).toHaveTextContent(
        'Something went wrong deleting that post.',
      );
    });
  });

  describe('the search box', () => {
    it('shows what the user has typed', async () => {
      // The hook exposes the raw text separately from the term being searched
      // for, precisely so a controlled input never lags the keyboard.
      mockedUseCommunityFeed.mockReturnValue(community({ query: 'waistcoat' }));
      await render(<SearchScreen />);
      expect(screen.getByTestId('community-search-input').props.value).toBe('waistcoat');
    });

    it('hands every keystroke to the hook', async () => {
      // Cheap to call on every keystroke by contract: the text updates
      // immediately and the REQUEST is debounced inside the hook, where a
      // screen cannot forget it.
      await render(<SearchScreen />);
      fireEvent.changeText(screen.getByTestId('community-search-input'), 'wa');
      expect(setQuery).toHaveBeenCalledWith('wa');
    });

    it('is a single-line box', async () => {
      // Load-bearing rather than cosmetic: the API answers 400 for a term
      // containing a control character, and a newline typed into a multiline
      // box is the only way a user could produce one.
      await render(<SearchScreen />);
      expect(screen.getByTestId('community-search-input').props.multiline).toBe(false);
    });

    it('does not autocapitalise the term', async () => {
      await render(<SearchScreen />);
      expect(screen.getByTestId('community-search-input').props.autoCapitalize).toBe('none');
    });

    it('names itself for a screen reader', async () => {
      // A bare text box on a tab called "Search" announces as "text field" and
      // nothing else.
      await render(<SearchScreen />);
      expect(screen.getByTestId('community-search-input').props.accessibilityLabel).toBe(
        'Search community captions',
      );
    });
  });

  describe('the focus gate', () => {
    it('does not refetch merely because the tab came back', async () => {
      // `refresh()` is a page-ONE load that replaces the list, so an ungated
      // focus effect throws away every page the user has scrolled to. This is
      // the list a user scrolls deeply through, so the cost lands hardest here.
      await render(<SearchScreen />);
      const onFocus = mockedUseFocusEffect.mock.calls[0][0] as () => void;
      refresh.mockClear();

      onFocus();

      expect(refresh).not.toHaveBeenCalled();
    });

    it('refetches when something has changed the feed', async () => {
      await render(<SearchScreen />);
      const onFocus = mockedUseFocusEffect.mock.calls[0][0] as () => void;
      refresh.mockClear();

      markCommunityDirty(['feed']);
      onFocus();

      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('consumes the flag, so one change is one reload', async () => {
      await render(<SearchScreen />);
      const onFocus = mockedUseFocusEffect.mock.calls[0][0] as () => void;
      refresh.mockClear();

      markCommunityDirty(['feed']);
      onFocus();
      onFocus();

      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it("ignores the saved list's staleness, and leaves it for the saved list", async () => {
      // The reader argument is the whole point of a per-reader signal. Reading
      // the wrong bit here would reload this feed for a change that was not
      // its own AND swallow the flag the Favorites tab is waiting on, leaving
      // that list permanently stale — a failure that is invisible from this
      // screen entirely.
      await render(<SearchScreen />);
      const onFocus = mockedUseFocusEffect.mock.calls[0][0] as () => void;
      refresh.mockClear();

      markCommunityDirty(['saved']);
      onFocus();

      expect(refresh).not.toHaveBeenCalled();
      expect(consumeCommunityDirty('saved')).toBe(true);
    });
  });
});
