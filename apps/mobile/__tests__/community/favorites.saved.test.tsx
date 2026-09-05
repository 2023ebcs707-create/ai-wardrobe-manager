import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useFocusEffect } from 'expo-router';
import type { PublicClothingItem } from '@wardrobe/shared';
import FavoritesScreen from '../../app/(tabs)/favorites';
import { useAuth } from '../../src/auth/AuthContext';
import { PostCard } from '../../src/community/PostCard';
import {
  COMMUNITY_READERS,
  consumeCommunityDirty,
  markCommunityDirty,
} from '../../src/community/communityDirty';
import type { DisplayPost } from '../../src/community/posts';
import { useSavedPosts, type UseSavedPostsResult } from '../../src/community/useSavedPosts';
import { useOutfits, type UseOutfitsResult } from '../../src/outfits/useOutfits';

// In `__tests__/` rather than beside the route: expo-router's Android
// require-context is recursive and bundles any `.tsx` beneath the app root as a
// route, `__tests__/` included.

// Both hooks are mocked at the module boundary. Each has its own suite
// (`useSavedPosts.test.ts`, 19 tests; `useOutfits.test.ts`, 26), so this file is
// about what the SCREEN derives from those contracts — and mocking them keeps
// `src/api/client`, whose `ApiClientError` cannot survive automocking, out of
// the graph. The properties that are only true of the hook and the screen
// TOGETHER are in `favorites.saved.real.test.tsx`, which runs the real one.
jest.mock('../../src/community/useSavedPosts', () => ({ useSavedPosts: jest.fn() }));
jest.mock('../../src/outfits/useOutfits', () => ({ useOutfits: jest.fn() }));

// Only `useAuth` is replaced, not the whole module: a bare automock would also
// replace `AuthProvider`, and the real module pulls in expo-secure-store.
jest.mock('../../src/auth/AuthContext', () => ({ useAuth: jest.fn() }));

/**
 * `useFocusEffect` reduced to its ordering-relevant core, exactly as
 * `__tests__/community/search.test.tsx` and `__tests__/outfits/favorites.focus.test.tsx`
 * do it: expo-router runs the callback from a `React.useEffect` declared in the
 * calling component, and calls it immediately when the screen is already
 * focused. The captured callback is invoked directly below to stand for a later
 * re-focus.
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

const mockedUseSavedPosts = jest.mocked(useSavedPosts);
const mockedUseOutfits = jest.mocked(useOutfits);
const mockedUseAuth = jest.mocked(useAuth);
const mockedUseFocusEffect = useFocusEffect as unknown as jest.Mock;

/** The signed-in user this screen reads the viewer id from. */
const VIEWER = {
  id: 'viewer-1',
  name: 'Grace Hopper',
  email: 'grace@example.test',
  createdAt: '2026-08-01T10:00:00.000Z',
};

const loadMore = jest.fn();
const refresh = jest.fn();
const toggleLike = jest.fn<Promise<boolean>, [string]>();
const toggleSave = jest.fn<Promise<boolean>, [string]>();

const outfitsLoadMore = jest.fn();
const outfitsRefresh = jest.fn();
const outfitsRemove = jest.fn<Promise<boolean>, [string]>();

type Element = ReturnType<typeof screen.getByTestId>;

/**
 * Minimal shape of a React fiber, declared locally so this file does not take a
 * dependency on react-reconciler's types for two assertions.
 */
type FiberLike = { type: unknown; memoizedProps: Record<string, unknown>; return: FiberLike | null };

/**
 * The props the `<PostCard>` above `host` was actually rendered with.
 *
 * The same escape hatch `__tests__/outfits/favorites.test.tsx` uses for
 * `numColumns` and `keyExtractor`, and used here for the same reason: RNTL 14
 * exposes host elements only, and `viewerId` and `onRemove` reach no host node
 * at all while `canRetract` is false — which on this screen it always is. A
 * query therefore cannot tell `viewerId={user?.id ?? null}` from
 * `viewerId={null}`, and this file would otherwise be unable to state that the
 * saved list hands the card a real viewer.
 *
 * What this proves: the card was handed these two props. What it does NOT
 * prove: anything about what the card draws from them — `PostCard.test.tsx`
 * owns that, and the two `queryByTestId` assertions below cover this screen's
 * half through public queries.
 */
function postCardProps(host: Element): Record<string, unknown> {
  let fiber = host.unstable_fiber as unknown as FiberLike | null;
  while (fiber !== null) {
    if (fiber.type === PostCard) return fiber.memoizedProps;
    fiber = fiber.return;
  }
  throw new Error('No <PostCard> found above the given element');
}

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

/** Saved by default — this is the saved list, and every row the API returns for
 *  it carries `saved: true`. */
function post(id: string, overrides: Partial<DisplayPost> = {}): DisplayPost {
  return {
    id,
    author: { id: 'author-1', name: 'Ada Lovelace' },
    items: [item(`${id}-a`)],
    caption: `Caption ${id}`,
    likeCount: 0,
    liked: false,
    saved: true,
    createdAt: '2026-08-24T09:00:00.000Z',
    missingItemsNotice: null,
    ...overrides,
  };
}

/** The hook's contract, defaulted to "idle and empty" so each test states only
 *  the axis it is about. */
function saved(overrides: Partial<UseSavedPostsResult> = {}): UseSavedPostsResult {
  return {
    posts: [],
    activity: 'idle',
    error: null,
    loadMore,
    refresh,
    hasMore: false,
    toggleLike,
    toggleSave,
    ...overrides,
  };
}

function showing(overrides: Partial<UseSavedPostsResult> = {}): UseSavedPostsResult {
  const value = saved(overrides);
  mockedUseSavedPosts.mockReturnValue(value);
  return value;
}

function gallery(overrides: Partial<UseOutfitsResult> = {}): UseOutfitsResult {
  return {
    outfits: [],
    activity: 'idle',
    error: null,
    loadMore: outfitsLoadMore,
    refresh: outfitsRefresh,
    hasMore: false,
    remove: outfitsRemove,
    ...overrides,
  };
}

/** Choose the saved-posts mode. `act` because mounting the pane runs its focus
 *  effect, which is where the gate below lives. */
async function chooseSavedMode(): Promise<void> {
  await act(async () => {
    fireEvent.press(screen.getByTestId('favorites-mode-saved'));
  });
}

/**
 * The focus callback the SAVED pane registered.
 *
 * The last one, not the first: `FavoritesScreen` calls `useFocusEffect` during
 * its own render and `SavedPostsPane` calls it while rendering as its child, so
 * the pane's registration always follows the screen's in the same pass — and
 * the pane never renders without the screen having rendered first. The first
 * call is the outfit gallery's gate, which `__tests__/outfits/favorites.test.tsx`
 * owns.
 */
function savedFocusCallback(): () => void {
  const { calls } = mockedUseFocusEffect.mock;
  return calls[calls.length - 1][0] as () => void;
}

describe('Favorites tab — saved community posts (FR10, TC-12)', () => {
  beforeEach(() => {
    toggleLike.mockResolvedValue(true);
    toggleSave.mockResolvedValue(true);
    mockedUseAuth.mockReturnValue({
      status: 'authenticated',
      user: VIEWER,
      token: 'tok-abc',
      signIn: jest.fn(),
      signUp: jest.fn(),
      signOut: jest.fn(),
    });
    mockedUseOutfits.mockReturnValue(gallery());
    showing();
  });

  afterEach(() => {
    jest.clearAllMocks();
    // Drained through the public door rather than a test-only reset, so the
    // tests use the same one the app does. Module scope outlives a test.
    COMMUNITY_READERS.forEach((reader) => consumeCommunityDirty(reader));
  });

  describe('the mode row', () => {
    it('shows the outfit gallery and not the saved list by default', async () => {
      // Load-bearing for every other test in `__tests__/outfits/favorites*.tsx`,
      // all of which render this screen and query outfit testIDs without
      // choosing a mode.
      await render(<FavoritesScreen />);

      expect(screen.getByTestId('outfits-gallery')).toBeTruthy();
      expect(screen.queryByTestId('community-feed')).toBeNull();
      expect(screen.getByTestId('favorites-mode-outfits').props.accessibilityState?.selected).toBe(
        true,
      );
      expect(screen.getByTestId('favorites-mode-saved').props.accessibilityState?.selected).toBe(
        false,
      );
    });

    it('shows the saved list when the saved mode is chosen, and takes the gallery off the screen', async () => {
      await render(<FavoritesScreen />);
      await chooseSavedMode();

      expect(screen.getByTestId('community-feed')).toBeTruthy();
      // ONE list on screen at a time, and this half of it is the load-bearing
      // one: both are full-height scrolling lists, so the only way to show them
      // together is to stack them inside a third scroll container — which is
      // where the gallery's `FlatList` draws React Native's "VirtualizedLists
      // should never be nested inside plain ScrollViews with the same
      // orientation" on stderr, a failure by this project's pristine-output rule
      // before it is a scrolling bug on a device. Rendered as alternatives,
      // neither is ever inside the other and no third container exists.
      expect(screen.queryByTestId('outfits-gallery')).toBeNull();
      expect(screen.getByTestId('favorites-mode-saved').props.accessibilityState?.selected).toBe(
        true,
      );
    });

    it('goes back to the gallery, taking the feed off the screen', async () => {
      await render(<FavoritesScreen />);
      await chooseSavedMode();

      await act(async () => {
        fireEvent.press(screen.getByTestId('favorites-mode-outfits'));
      });

      expect(screen.getByTestId('outfits-gallery')).toBeTruthy();
      expect(screen.queryByTestId('community-feed')).toBeNull();
    });

    it('names each mode for a screen reader', async () => {
      // A chip announces its own text otherwise, and "Outfits" alone does not
      // say that pressing it changes what the tab is showing.
      await render(<FavoritesScreen />);

      expect(screen.getByTestId('favorites-mode-outfits').props.accessibilityLabel).toBe(
        'Outfits you have saved',
      );
      expect(screen.getByTestId('favorites-mode-saved').props.accessibilityLabel).toBe(
        'Posts you have saved from the community',
      );
    });
  });

  describe('the saved list', () => {
    it('renders a card per saved post', async () => {
      showing({ posts: [post('p1', { caption: 'Rainy Tuesday layers' }), post('p2')] });
      await render(<FavoritesScreen />);
      await chooseSavedMode();

      expect(screen.getByTestId('post-card-p1')).toBeTruthy();
      expect(screen.getByTestId('post-caption-p1')).toHaveTextContent('Rainy Tuesday layers');
      expect(screen.getByTestId('post-card-p2')).toBeTruthy();
    });


    it('draws the posts the viewer still has saved, and not the ones they no longer do', async () => {
      // BOTH DIRECTIONS, deliberately. A fixture of saved posts alone cannot
      // tell `posts.filter(post => post.saved)` from `posts`, and a fixture of
      // unsaved posts alone cannot tell it from `[]`. `useSavedPosts` keeps an
      // unsaved post in its array on purpose — it is what the rollback of a
      // failed unsave lands on — so this pairing is a state the real hook
      // produces, not a hypothetical one.
      showing({ posts: [post('kept'), post('dropped', { saved: false })] });
      await render(<FavoritesScreen />);
      await chooseSavedMode();

      expect(screen.getByTestId('post-card-kept')).toBeTruthy();
      expect(screen.queryByTestId('post-card-dropped')).toBeNull();
    });

    it('decides on the bookmark alone, on a post whose garments have all been deleted', async () => {
      // The rival rules that survive the fixture above all read something else
      // on the post, and `items: []` is where they come apart: a post whose
      // garments have every one been deleted still exists and still renders
      // (ruling 4), so BOTH of these are states this list can really hold.
      //
      // Both directions again, and for the same reason as before — a saved post
      // with no garments alone cannot tell `post.saved` from
      // `post.saved || post.items.length === 0`, and an unsaved one with no
      // garments alone cannot tell it from `post.saved && post.items.length > 0`.
      showing({
        posts: [
          post('bare-kept', { items: [], missingItemsNotice: 'One garment is no longer available.' }),
          post('bare-dropped', {
            saved: false,
            items: [],
            missingItemsNotice: 'One garment is no longer available.',
          }),
        ],
      });
      await render(<FavoritesScreen />);
      await chooseSavedMode();

      expect(screen.getByTestId('post-card-bare-kept')).toBeTruthy();
      expect(screen.queryByTestId('post-card-bare-dropped')).toBeNull();
    });

    it('wires a save to the hook, by id', async () => {
      // One press per test, deliberately: two settled-but-unawaited promises
      // inside one `act` scope are reported by React 19 as overlapping `act()`
      // calls on stderr, which would break the pristine-output rule whether or
      // not the assertions passed.
      showing({ posts: [post('p1')] });
      await render(<FavoritesScreen />);
      await chooseSavedMode();

      await act(async () => {
        fireEvent.press(screen.getByTestId('post-save-p1'));
      });

      expect(toggleSave).toHaveBeenCalledWith('p1');
    });

    it('wires a like to the hook, by id', async () => {
      showing({ posts: [post('p1')] });
      await render(<FavoritesScreen />);
      await chooseSavedMode();

      await act(async () => {
        fireEvent.press(screen.getByTestId('post-like-p1'));
      });

      expect(toggleLike).toHaveBeenCalledWith('p1');
    });

    it('wires the end of the list to the next page', async () => {
      showing({ posts: [post('p1')] });
      await render(<FavoritesScreen />);
      await chooseSavedMode();

      fireEvent.scroll(screen.getByTestId('community-feed'), {
        nativeEvent: {
          contentOffset: { x: 0, y: 2000 },
          contentSize: { width: 400, height: 2100 },
          layoutMeasurement: { width: 400, height: 800 },
        },
      });

      expect(loadMore).toHaveBeenCalled();
    });

    it('shows a loading state before the first page', async () => {
      showing({ activity: 'loading' });
      await render(<FavoritesScreen />);
      await chooseSavedMode();

      expect(screen.getByTestId('community-loading')).toBeTruthy();
      // A screen that says "nothing saved yet" while it is still finding out is
      // making a claim it cannot support.
      expect(screen.queryByTestId('community-empty-title')).toBeNull();
    });

    it('shows the failure with a retry that reloads page one', async () => {
      showing({ error: 'Cannot reach the server. Check your connection.' });
      await render(<FavoritesScreen />);
      await chooseSavedMode();

      expect(screen.getByTestId('community-error-message')).toHaveTextContent(
        'Cannot reach the server. Check your connection.',
      );

      fireEvent.press(screen.getByTestId('community-retry'));

      expect(refresh).toHaveBeenCalledTimes(1);
    });
  });

  describe('the empty state', () => {
    it('says the list is empty and points at the bookmark, without reading as an error', async () => {
      showing({ posts: [] });
      await render(<FavoritesScreen />);
      await chooseSavedMode();

      expect(screen.getByTestId('community-empty-title')).toHaveTextContent('Nothing saved yet');
      // Names the fix, and names the right place: the bookmark is on a post
      // card, and the feed those live in is the Search tab.
      expect(screen.getByTestId('community-empty-hint')).toHaveTextContent(
        'Tap the bookmark on a post in the Search tab to keep it here.',
      );
      // An empty list is not a failure. Rendering it through the error banner
      // would hand a new user a red box, a message about something going wrong
      // and a "Try again" button for a request that succeeded.
      expect(screen.queryByTestId('community-error')).toBeNull();
    });

    it('appears once the last saved post has been unsaved', async () => {
      // The empty state is derived from what is DRAWN, not from what the hook
      // is holding: the hook still has this post, with `saved: false`.
      showing({ posts: [post('p1', { saved: false })] });
      await render(<FavoritesScreen />);
      await chooseSavedMode();

      expect(screen.queryByTestId('post-card-p1')).toBeNull();
      expect(screen.getByTestId('community-empty-title')).toHaveTextContent('Nothing saved yet');
      expect(screen.queryByTestId('community-error')).toBeNull();
    });

    it('does not call an empty saved list empty when the load failed', async () => {
      showing({ posts: [], error: 'Cannot reach the server. Check your connection.' });
      await render(<FavoritesScreen />);
      await chooseSavedMode();

      // Telling a user whose request just failed that they have saved nothing
      // is both false and unrecoverable-looking — and the retry is in the
      // banner they would then be told to ignore.
      expect(screen.queryByTestId('community-empty-title')).toBeNull();
      expect(screen.getByTestId('community-error')).toBeTruthy();
    });
  });

  describe('writes in flight', () => {
    it('refuses to switch modes while a write is in flight', async () => {
      // Switching unmounts `useSavedPosts` with the request still out, so the
      // message a failed unsave is about to produce is written to a hook that
      // is no longer mounted — React has not warned about that since v18, so
      // the user simply never learns their unsave did not happen.
      let settleSave!: (value: boolean) => void;
      toggleSave.mockReturnValue(
        new Promise<boolean>((resolvePromise) => {
          settleSave = resolvePromise;
        }),
      );
      showing({ posts: [post('p1')] });
      await render(<FavoritesScreen />);
      await chooseSavedMode();

      await act(async () => {
        fireEvent.press(screen.getByTestId('post-save-p1'));
      });

      expect(screen.getByTestId('favorites-mode-outfits').props.accessibilityState?.disabled).toBe(
        true,
      );

      await act(async () => {
        fireEvent.press(screen.getByTestId('favorites-mode-outfits'));
      });

      // Still the saved list. The `disabled` prop is the whole guard — there is
      // no second check inside `onPress` — so a chip that is not disabled
      // switches.
      expect(screen.getByTestId('community-feed')).toBeTruthy();
      expect(screen.queryByTestId('outfits-gallery')).toBeNull();

      await act(async () => {
        settleSave(true);
      });
    });

    it('refuses to switch modes while a LIKE is in flight', async () => {
      // The second write source, and it needs its own fixture: a guard wired to
      // the bookmark alone passes the test above and leaves the heart able to
      // walk around it. `usePostList` keys its own guard by post AND kind, so
      // these really are two different writes.
      let settleLike!: (value: boolean) => void;
      toggleLike.mockReturnValue(
        new Promise<boolean>((resolvePromise) => {
          settleLike = resolvePromise;
        }),
      );
      showing({ posts: [post('p1')] });
      await render(<FavoritesScreen />);
      await chooseSavedMode();

      await act(async () => {
        fireEvent.press(screen.getByTestId('post-like-p1'));
      });

      expect(screen.getByTestId('favorites-mode-outfits').props.accessibilityState?.disabled).toBe(
        true,
      );

      await act(async () => {
        settleLike(true);
      });
    });

    it('keeps the mode row disabled while a second write is still in flight', async () => {
      // Why the screen counts rather than holding a flag. Two writes really can
      // overlap — `usePostList`'s guard is keyed by post AND kind, so a like and
      // a save on one card are not each other's second tap — and with a boolean
      // the first to settle would re-enable the chips while the second request
      // was still out, which is the exact state the guard exists to prevent.
      let settleLike!: (value: boolean) => void;
      let settleSave!: (value: boolean) => void;
      toggleLike.mockReturnValue(
        new Promise<boolean>((resolvePromise) => {
          settleLike = resolvePromise;
        }),
      );
      toggleSave.mockReturnValue(
        new Promise<boolean>((resolvePromise) => {
          settleSave = resolvePromise;
        }),
      );
      showing({ posts: [post('p1')] });
      await render(<FavoritesScreen />);
      await chooseSavedMode();

      await act(async () => {
        fireEvent.press(screen.getByTestId('post-like-p1'));
      });
      await act(async () => {
        fireEvent.press(screen.getByTestId('post-save-p1'));
      });

      await act(async () => {
        settleLike(true);
      });

      // One down, one still out.
      expect(screen.getByTestId('favorites-mode-outfits').props.accessibilityState?.disabled).toBe(
        true,
      );

      await act(async () => {
        settleSave(true);
      });

      expect(screen.getByTestId('favorites-mode-outfits').props.accessibilityState?.disabled).toBe(
        false,
      );
    });

    it('releases the mode row when a write REJECTS, not only when it fails', async () => {
      // `toggleLike`/`toggleSave` are contracted to RESOLVE — `false` is how
      // they report a failure — so `track`'s `finally` is defence against that
      // contract being broken later, and the test above covers only the
      // ordinary resolve-false path.
      //
      // An earlier comment on `track` said a rejection "cannot be tested from
      // here without an unhandled one", because `PostCard` invokes the handler
      // as `void onToggleSave(id)`. That is true of the PRESS path and not of
      // the component seam: reading the handler off the card's props — the
      // same escape hatch this file already uses for `viewerId` — calls it with
      // the rejection HANDLED, so no unhandled rejection is produced.
      //
      // Without the `finally`, `onWritingChange(false)` never runs and the mode
      // row stays disabled for the rest of the session: the dead-control shape,
      // in its worst form, because nothing on screen says why.
      toggleSave.mockRejectedValue(new Error('contract broken'));
      showing({ posts: [post('p1')] });
      await render(<FavoritesScreen />);
      await chooseSavedMode();

      const handler = postCardProps(screen.getByTestId('post-card-p1')).onToggleSave as (
        id: string,
      ) => Promise<boolean>;
      await act(async () => {
        await handler('p1').catch(() => undefined);
      });

      expect(screen.getByTestId('favorites-mode-outfits').props.accessibilityState?.disabled).toBe(
        false,
      );
    });

    it('lets the mode change again once a write that failed has settled', async () => {
      // `toggleSave` resolves `false` on failure rather than rejecting, so this
      // is the ordinary failure path and not a contract violation. A flag left
      // set here would leave the chips dead for the rest of the session after
      // one failed like — the dead-control shape this stage has found twice.
      let settleSave!: (value: boolean) => void;
      toggleSave.mockReturnValue(
        new Promise<boolean>((resolvePromise) => {
          settleSave = resolvePromise;
        }),
      );
      showing({ posts: [post('p1')] });
      await render(<FavoritesScreen />);
      await chooseSavedMode();

      await act(async () => {
        fireEvent.press(screen.getByTestId('post-save-p1'));
      });
      await act(async () => {
        settleSave(false);
      });

      expect(screen.getByTestId('favorites-mode-outfits').props.accessibilityState?.disabled).toBe(
        false,
      );

      await act(async () => {
        fireEvent.press(screen.getByTestId('favorites-mode-outfits'));
      });

      expect(screen.getByTestId('outfits-gallery')).toBeTruthy();
    });

    it('leaves the mode row alone when nothing is in flight', async () => {
      showing({ posts: [post('p1')] });
      await render(<FavoritesScreen />);
      await chooseSavedMode();

      expect(screen.getByTestId('favorites-mode-outfits').props.accessibilityState?.disabled).toBe(
        false,
      );
      expect(screen.getByTestId('favorites-mode-saved').props.accessibilityState?.disabled).toBe(
        false,
      );
    });
  });

  describe('the retract control this list deliberately does not have', () => {
    it("offers no retract control on the viewer's own post, or on anyone else's", async () => {
      // BOTH DIRECTIONS. `canRetract` is `ownPost && onRemove !== undefined`,
      // and a fixture of strangers' posts alone would pass with `onRemove`
      // wired to something that cannot work — no stranger's card carries the
      // control whatever the host passes. The viewer's own post is the only
      // fixture that can see the difference.
      //
      // `useSavedPosts` has no `remove`, so a control here would be a
      // destructive button with nothing behind it. Ruling 7 admitted
      // `DELETE /community/posts/:id` because publishing with no way to retract
      // is a user-harm gap; a control that silently fails is worse than none.
      // The feed on the Search tab is where a post is retracted from.
      showing({
        posts: [
          post('mine', { author: { id: VIEWER.id, name: VIEWER.name } }),
          post('theirs', { author: { id: 'author-1', name: 'Ada Lovelace' } }),
        ],
      });
      await render(<FavoritesScreen />);
      await chooseSavedMode();

      expect(screen.queryByTestId('post-retract-mine')).toBeNull();
      expect(screen.queryByTestId('post-retract-theirs')).toBeNull();
    });

    it('hands the card the signed-in viewer, and no delete path', async () => {
      // The seam, because no query can see it: with `onRemove` absent,
      // `canRetract` is false on every card and `viewerId` changes nothing that
      // renders — so `viewerId={null}` would draw exactly the same screen. It
      // is passed correctly anyway, because `viewerId` is REQUIRED by
      // `MasonryFeed` precisely so a host cannot quietly opt out of ownership,
      // and a `null` hard-coded here would become a live defect the day this
      // list gains a delete path.
      showing({ posts: [post('mine', { author: { id: VIEWER.id, name: VIEWER.name } })] });
      await render(<FavoritesScreen />);
      await chooseSavedMode();

      const props = postCardProps(screen.getByTestId('post-card-mine'));
      expect(props.viewerId).toBe(VIEWER.id);
      expect(props.onRemove).toBeUndefined();
    });

    it('passes a null viewer rather than throwing when nobody is signed in', async () => {
      // Reachable: `app/_layout.tsx` gates on `status` from a `useEffect`, so a
      // sign-out sets `user` to `null` and re-renders the tabs at least one
      // commit before the redirect replaces the route.
      mockedUseAuth.mockReturnValue({
        status: 'authenticated',
        user: null,
        token: 'tok-abc',
        signIn: jest.fn(),
        signUp: jest.fn(),
        signOut: jest.fn(),
      });
      showing({ posts: [post('p1')] });
      await render(<FavoritesScreen />);
      await chooseSavedMode();

      expect(postCardProps(screen.getByTestId('post-card-p1')).viewerId).toBeNull();
    });
  });

  describe('the focus gate', () => {
    it('does not reload merely because the tab came back', async () => {
      // `refresh()` is a page-ONE load that replaces the list, so an ungated
      // focus effect throws away every page the user has scrolled to.
      showing({ posts: [post('p1')] });
      await render(<FavoritesScreen />);
      await chooseSavedMode();
      const onFocus = savedFocusCallback();
      refresh.mockClear();

      await act(async () => {
        onFocus();
      });

      expect(refresh).not.toHaveBeenCalled();
    });

    it('reloads when a save or an unsave has changed the list', async () => {
      showing({ posts: [post('p1')] });
      await render(<FavoritesScreen />);
      await chooseSavedMode();
      const onFocus = savedFocusCallback();
      refresh.mockClear();

      markCommunityDirty(['saved']);
      await act(async () => {
        onFocus();
      });

      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('consumes the flag, so one change is one reload', async () => {
      showing({ posts: [post('p1')] });
      await render(<FavoritesScreen />);
      await chooseSavedMode();
      const onFocus = savedFocusCallback();
      refresh.mockClear();

      markCommunityDirty(['saved']);
      await act(async () => {
        onFocus();
      });
      await act(async () => {
        onFocus();
      });

      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it("ignores the feed's staleness, and leaves it for the feed", async () => {
      // The reader argument is the whole point of a per-reader signal. Reading
      // the wrong bit here would reload this list for a change that was not its
      // own AND swallow the flag the Search tab is waiting on, leaving that feed
      // permanently stale — a failure invisible from this screen entirely.
      showing({ posts: [post('p1')] });
      await render(<FavoritesScreen />);
      await chooseSavedMode();
      const onFocus = savedFocusCallback();
      refresh.mockClear();

      markCommunityDirty(['feed']);
      await act(async () => {
        onFocus();
      });

      expect(refresh).not.toHaveBeenCalled();
      expect(consumeCommunityDirty('feed')).toBe(true);
    });

    it('passes a stable focus callback, so the effect does not re-run every render', async () => {
      // `useFocusEffect` lists `effect` in its own `useEffect` deps, so a
      // callback rebuilt on every render re-runs the effect on every render —
      // and this one fetches, and a fetch renders.
      showing({ posts: [post('p1')] });
      const view = await render(<FavoritesScreen />);
      await chooseSavedMode();
      const first = savedFocusCallback();

      await act(async () => {
        view.rerender(<FavoritesScreen />);
      });

      expect(savedFocusCallback()).toBe(first);
    });
  });
});
