import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useFocusEffect } from 'expo-router';
import type { PublicPost } from '@wardrobe/shared';
import SearchScreen from '../../app/(tabs)/search';
import { useAuth } from '../../src/auth/AuthContext';
import { fetchFeed } from '../../src/community/api';
import {
  COMMUNITY_READERS,
  consumeCommunityDirty,
  markCommunityDirty,
} from '../../src/community/communityDirty';
import { SEARCH_DEBOUNCE_MS } from '../../src/community/useCommunityFeed';

// In `__tests__/` rather than beside the route — see the note in
// `search.test.tsx`.

/**
 * The one file in this task that runs the REAL `useCommunityFeed`, because
 * every property below is a property of the screen and the hook TOGETHER and is
 * unfalsifiable with the hook mocked: a mocked `setQuery` is a `jest.fn` that
 * cannot debounce, a mocked `refresh` is a `jest.fn` that cannot decline, and a
 * mocked `posts` array cannot be paged.
 *
 * `../../src/community/api` exports plain functions and (erased) interfaces —
 * no class — so a factory mock is safe here in the way a mock of
 * `../../src/api/client` would not be.
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

// Only `useAuth` is used, so the real module (and its expo-secure-store
// dependency) is never loaded.
jest.mock('../../src/auth/AuthContext', () => ({ useAuth: jest.fn() }));

/**
 * `useFocusEffect` reduced to its ordering-relevant core: expo-router runs the
 * callback from a `React.useEffect` declared in THIS component, and calls it
 * immediately when the screen is already focused. The substitution that matters
 * is that the effect is registered where the screen calls the hook, which is
 * what puts it AFTER `useCommunityFeed`'s own mount effect — the ordering the
 * "mounts focused with a pending change" test below depends on.
 */
jest.mock('expo-router', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  return {
    useFocusEffect: jest.fn((effect: () => void) => {
      ReactActual.useEffect(effect, [effect]);
    }),
  };
});

const mockedFetchFeed = jest.mocked(fetchFeed);
const mockedUseAuth = jest.mocked(useAuth);
const mockedUseFocusEffect = useFocusEffect as unknown as jest.Mock;

const TOKEN = 'tok-abc';

function post(id: string): PublicPost {
  return {
    id,
    author: { id: 'author-1', name: 'Ada Lovelace' },
    itemIds: [],
    items: [],
    caption: `Caption ${id}`,
    likeCount: 0,
    liked: false,
    saved: false,
    createdAt: '2026-08-24T09:00:00.000Z',
  };
}

/**
 * One keystroke into the search box.
 *
 * Invokes the input's own `onChangeText` inside an async `act` rather than
 * going through `fireEvent.changeText`, and the reason is a measured
 * interaction rather than a preference. `fireEvent` opens a SYNCHRONOUS act;
 * under fake timers React 19 cannot finish a concurrent render inside one, so
 * it queues its own flush on a macrotask — which is itself faked, and therefore
 * runs on the next `jest.advanceTimersByTime`, i.e. from inside the async act
 * on the very next line. React reports that on stderr as "You called
 * act(async () => ...) without await" and then as overlapping act calls, and it
 * leaves `IS_REACT_ACT_ENVIRONMENT` false for **every later test in the file**
 * — four of which failed with no mention of a timer.
 *
 * That `fireEvent.changeText` reaches `setQuery` at all is pinned separately,
 * under real timers and against the mocked hook, in `search.test.tsx`. What
 * this file is about is what the hook does with the keystrokes afterwards.
 */
async function type(text: string): Promise<void> {
  const onChangeText = screen.getByTestId('community-search-input').props
    .onChangeText as (next: string) => void;
  await act(async () => {
    onChangeText(text);
  });
}

function focusCallback(): () => void {
  return mockedUseFocusEffect.mock.calls[0][0] as () => void;
}

describe('Search tab against the real useCommunityFeed', () => {
  beforeEach(() => {
    mockedUseAuth.mockReturnValue({
      status: 'authenticated',
      user: null,
      token: TOKEN,
      signIn: jest.fn(),
      signUp: jest.fn(),
      signOut: jest.fn(),
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
    COMMUNITY_READERS.forEach((reader) => consumeCommunityDirty(reader));
  });

  describe('the search box', () => {
    // Fake timers only in this block: the debounce is the one thing here
    // measured in milliseconds, and pinning the clock for the paging tests
    // would buy nothing and complicate every `waitFor`.
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('does not send a request per keystroke', async () => {
      // `?q=` costs O(feed size), not O(result size): at 5000 posts a RARE
      // term scans 5000 index keys to return nothing while a common one scans
      // 59 to return 20. The expensive query is the one that finds nothing —
      // which is what every prefix of a word is. Typing "blue" unthrottled is
      // four whole-feed scans to render one result.
      mockedFetchFeed.mockResolvedValue({ posts: [post('p1')] });
      await render(<SearchScreen />);
      expect(mockedFetchFeed).toHaveBeenCalledTimes(1);

      // Spaced 100ms apart, which is what a person typing looks like — and it
      // is the only spacing that can see the mechanism. Typed in one
      // synchronous burst, four uncancelled timers come due in the same tick
      // and React batches their four updates into the single last value, so a
      // box with no debounce at all is hidden by the batching rather than
      // caught. Spread out, the first keystroke's request goes out while the
      // user is still typing.
      const GAP = 100;
      for (const typed of ['b', 'bl', 'blu', 'blue']) {
        await type(typed);
        // The box tracks the typing; only the REQUEST waits.
        expect(screen.getByTestId('community-search-input').props.value).toBe(typed);
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
      // The whole word, once — not four prefixes.
      expect(mockedFetchFeed).toHaveBeenLastCalledWith({ token: TOKEN, q: 'blue' });
    });

    it('renders the results of the settled search', async () => {
      mockedFetchFeed.mockResolvedValue({ posts: [post('p1')] });
      await render(<SearchScreen />);

      mockedFetchFeed.mockResolvedValue({ posts: [post('p2')] });
      await type('blue');
      await act(async () => {
        jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
      });

      expect(screen.getByTestId('post-card-p2')).toBeTruthy();
      expect(screen.queryByTestId('post-card-p1')).toBeNull();
    });
  });

  describe('the focus gate', () => {
    it('does not issue a second page-one request when the screen mounts focused', async () => {
      mockedFetchFeed.mockResolvedValue({ posts: [post('p1')] });

      await render(<SearchScreen />);
      await waitFor(() => {
        expect(screen.getByTestId('post-card-p1')).toBeTruthy();
      });

      // ONE. Nothing has changed, so the gate does not even reach `refresh`.
      expect(mockedFetchFeed).toHaveBeenCalledTimes(1);
    });

    it('does not issue a second page-one request when it mounts focused with a pending change', async () => {
      // The real sequence: the user shares an outfit from the Add tab and then
      // opens the Search tab for the first time this session. The flag is set
      // BEFORE this screen mounts, so the mount load and the focus gate both
      // want page one — and the hook's in-flight guard is what makes the
      // second a no-op. That only works because `useCommunityFeed`'s effect is
      // registered earlier in this component than the focus effect.
      markCommunityDirty(['feed']);
      mockedFetchFeed.mockResolvedValue({ posts: [post('p1')] });

      await render(<SearchScreen />);
      await waitFor(() => {
        expect(screen.getByTestId('post-card-p1')).toBeTruthy();
      });

      expect(mockedFetchFeed).toHaveBeenCalledTimes(1);
      // Consumed rather than left pending: the request that swallowed it was
      // itself a page-one load, so the feed on screen already reflects the
      // change.
      expect(consumeCommunityDirty('feed')).toBe(false);
    });

    it('keeps pages already loaded when the tab regains focus', async () => {
      // THE regression this gate exists for, reproduced end to end against the
      // real hook: page one, a real scroll to the end that appends page two,
      // then a focus event. Ungated, the focus fires `refresh()` — a page-ONE
      // load that REPLACES the list — and p2 disappears while the last request
      // goes out with no cursor at all.
      mockedFetchFeed.mockResolvedValueOnce({ posts: [post('p1')], nextCursor: 'cur-1' });
      mockedFetchFeed.mockResolvedValueOnce({ posts: [post('p2')] });

      await render(<SearchScreen />);
      await waitFor(() => {
        expect(screen.getByTestId('post-card-p1')).toBeTruthy();
      });

      await act(async () => {
        fireEvent.scroll(screen.getByTestId('community-feed'), {
          nativeEvent: {
            contentOffset: { x: 0, y: 2000 },
            contentSize: { width: 400, height: 2100 },
            layoutMeasurement: { width: 400, height: 800 },
          },
        });
      });
      await waitFor(() => {
        expect(screen.getByTestId('post-card-p2')).toBeTruthy();
      });
      expect(mockedFetchFeed).toHaveBeenCalledTimes(2);
      expect(mockedFetchFeed).toHaveBeenLastCalledWith({ token: TOKEN, cursor: 'cur-1' });

      await act(async () => {
        focusCallback()();
      });

      // No third request, and BOTH pages still on screen.
      expect(mockedFetchFeed).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('post-card-p1')).toBeTruthy();
      expect(screen.getByTestId('post-card-p2')).toBeTruthy();
    });

    it('refetches page one when the tab is focused after a change', async () => {
      mockedFetchFeed.mockResolvedValue({ posts: [post('p1')] });

      await render(<SearchScreen />);
      await waitFor(() => {
        expect(mockedFetchFeed).toHaveBeenCalledTimes(1);
      });

      markCommunityDirty(['feed']);
      mockedFetchFeed.mockResolvedValue({ posts: [post('p2')] });
      await act(async () => {
        focusCallback()();
      });

      await waitFor(() => {
        expect(mockedFetchFeed).toHaveBeenCalledTimes(2);
      });
      // Page one, not a cursor: something changed, and a share puts the new
      // post at the TOP of a newest-first feed, so a `?cursor=` would page
      // straight past the only row that moved.
      expect(mockedFetchFeed).toHaveBeenLastCalledWith({ token: TOKEN });
      await waitFor(() => {
        expect(screen.getByTestId('post-card-p2')).toBeTruthy();
      });
      expect(screen.queryByTestId('post-card-p1')).toBeNull();
    });
  });
});
