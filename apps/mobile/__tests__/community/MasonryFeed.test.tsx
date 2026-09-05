import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import type { PublicClothingItem } from '@wardrobe/shared';
import {
  END_REACHED_THRESHOLD,
  MasonryFeed,
  postKeyExtractor,
} from '../../src/community/MasonryFeed';
import type { MasonryFeedProps } from '../../src/community/MasonryFeed';
import type { DisplayPost } from '../../src/community/posts';

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

function post(id: string, overrides: Partial<DisplayPost> = {}): DisplayPost {
  return {
    id,
    author: { id: 'author-1', name: 'Ada Lovelace' },
    items: [item(`${id}-a`), item(`${id}-b`)],
    caption: `Caption ${id}`,
    likeCount: 0,
    liked: false,
    saved: false,
    createdAt: '2026-08-24T09:00:00.000Z',
    missingItemsNotice: null,
    ...overrides,
  };
}

/** A garmentless post — 125pt, the shortest card the feed can produce. */
function shortPost(id: string): DisplayPost {
  return post(id, { items: [] });
}

/** A six-garment post — 433pt, three collage rows. */
function tallPost(id: string): DisplayPost {
  return post(id, { items: ['a', 'b', 'c', 'd', 'e', 'f'].map((suffix) => item(`${id}-${suffix}`)) });
}

const onRetry = jest.fn();
const onEndReached = jest.fn();
const onRefresh = jest.fn();
const onToggleLike = jest.fn<Promise<boolean>, [string]>();
const onToggleSave = jest.fn<Promise<boolean>, [string]>();
const onRemove = jest.fn<Promise<boolean>, [string]>();

function feed(overrides: Partial<MasonryFeedProps> = {}): MasonryFeedProps {
  return {
    posts: [],
    activity: 'idle',
    error: null,
    onRetry,
    onEndReached,
    onRefresh,
    onToggleLike,
    onToggleSave,
    // The default is a viewer who wrote none of these posts and a host with no
    // delete path, so the retract control is off unless a test asks for it.
    // Every post above is authored by `author-1`.
    viewerId: null,
    ...overrides,
  };
}

async function mount(overrides: Partial<MasonryFeedProps> = {}) {
  return render(<MasonryFeed {...feed(overrides)} />);
}

/** Scroll the feed so the bottom of the content is `distance` points away. */
function scrollTo(distance: number): void {
  fireEvent.scroll(screen.getByTestId('community-feed'), {
    nativeEvent: {
      contentOffset: { x: 0, y: 2000 - distance },
      contentSize: { width: 400, height: 2000 + 800 },
      layoutMeasurement: { width: 400, height: 800 },
    },
  });
}

/**
 * The `RefreshControl` the feed handed its `ScrollView`.
 *
 * Read off the ScrollView's own props rather than queried, because
 * `RefreshControl`'s `testID` does not reach the rendered host node — the tree
 * carries a bare `<RCTRefreshControl />`. RNTL cannot deliver a native pull
 * gesture either, so what is checked here is the wiring: the spinner tracks
 * `refreshing`, and the handler is the one the host passed in.
 */
function refreshControlProps(): { refreshing: boolean; onRefresh: () => void } {
  const element = screen.getByTestId('community-feed').props.refreshControl as {
    props: { refreshing: boolean; onRefresh: () => void };
  };
  return element.props;
}

/** The post ids rendered in one column, top to bottom. */
function idsIn(columnIndex: number): string[] {
  return within(screen.getByTestId(`community-column-${columnIndex}`))
    .queryAllByTestId(/^post-card-/)
    .map((el) => (el.props.testID as string).replace('post-card-', ''));
}

describe('MasonryFeed (Phase 3 — "masonry-style grid layout displaying posts from all users")', () => {
  beforeEach(() => {
    onToggleLike.mockResolvedValue(true);
    onToggleSave.mockResolvedValue(true);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('the masonry', () => {
    it('lays the cards out in two columns', async () => {
      await mount({ posts: [post('p1'), post('p2'), post('p3')] });
      expect(screen.getByTestId('community-column-0')).toBeTruthy();
      expect(screen.getByTestId('community-column-1')).toBeTruthy();
      expect(screen.queryByTestId('community-column-2')).toBeNull();
    });

    it('leaves a tall card alone in its column rather than stacking under it', async () => {
      // THE assertion that separates masonry from a two-column list. One
      // six-garment post (433pt) and four garmentless ones (125pt each):
      // shortest-column puts the tall one alone on the left and all four short
      // ones on the right, 433 against 500. Strict alternation by position —
      // which is what a `numColumns={2}` grid does and what this is most
      // likely to be replaced by — would put s2 and s4 UNDER the tall card and
      // leave the right column holding two, 683 against 375.
      await mount({
        posts: [tallPost('tall'), shortPost('s1'), shortPost('s2'), shortPost('s3'), shortPost('s4')],
      });
      expect(idsIn(0)).toEqual(['tall']);
      expect(idsIn(1)).toEqual(['s1', 's2', 's3', 's4']);
    });

    it('alternates when every card is the same height', async () => {
      // The case where masonry and a plain grid genuinely agree, and the one
      // that makes the test above necessary: nothing here can tell them apart.
      // What it does pin is that the first card is on the LEFT.
      await mount({ posts: [post('p1'), post('p2'), post('p3'), post('p4')] });
      expect(idsIn(0)).toEqual(['p1', 'p3']);
      expect(idsIn(1)).toEqual(['p2', 'p4']);
    });

    it('renders every post exactly once', async () => {
      const posts = [tallPost('t1'), shortPost('s1'), post('p1'), shortPost('s2')];
      await mount({ posts });
      expect([...idsIn(0), ...idsIn(1)].sort()).toEqual(['p1', 's1', 's2', 't1']);
    });

    it('keys a card by its post id and never by its position', async () => {
      // See `MasonryFeed.keys.test.tsx` for the mount probe that catches the
      // defect through public queries; this only pins the extractor's contract.
      expect(postKeyExtractor(post('p7'))).toBe('p7');
    });
  });

  describe('the cards', () => {
    it('renders the post the way PostCard does', async () => {
      // A thin check that the feed is wired to the real card rather than to a
      // placeholder: the card's own file is where its contents are pinned.
      await mount({ posts: [post('p1', { caption: 'Rainy Tuesday layers' })] });
      expect(screen.getByTestId('post-caption-p1')).toHaveTextContent('Rainy Tuesday layers');
      expect(screen.getByTestId('post-author-p1')).toHaveTextContent('Ada Lovelace');
    });

    it('passes a like straight through, by id', async () => {
      await mount({ posts: [post('p1'), post('p2')] });
      fireEvent.press(screen.getByTestId('post-like-p2'));
      expect(onToggleLike).toHaveBeenCalledWith('p2');
      expect(onToggleLike).toHaveBeenCalledTimes(1);
    });

    it('passes a save straight through, by id', async () => {
      await mount({ posts: [post('p1'), post('p2')] });
      fireEvent.press(screen.getByTestId('post-save-p2'));
      expect(onToggleSave).toHaveBeenCalledWith('p2');
      expect(onToggleSave).toHaveBeenCalledTimes(1);
    });
  });

  describe('states', () => {
    it('shows a spinner for a first-page load with nothing behind it', async () => {
      await mount({ posts: [], activity: 'loading' });
      expect(screen.getByTestId('community-loading')).toBeTruthy();
      expect(screen.queryByTestId('community-feed')).toBeNull();
    });

    it('keeps the rows on screen for a load that has something behind it', async () => {
      // A pull-to-refresh is not a reset: blanking the feed every time the
      // user swipes down flashes a spinner over content that is fine.
      await mount({ posts: [post('p1')], activity: 'refreshing' });
      expect(screen.queryByTestId('community-loading')).toBeNull();
      expect(screen.getByTestId('post-card-p1')).toBeTruthy();
    });

    it("keeps the rows on screen for a 'loading' that has something behind it", async () => {
      // The `posts.length === 0` half of `showFirstPageSpinner`, which the
      // `refreshing` case above does NOT reach: `activity === 'loading'` is
      // already false there, so that test passes with the length check
      // removed. Measured — dropping the conjunct SURVIVED the whole suite
      // until this line existed.
      //
      // Be exact about what this pins and what it does not. Both hooks batch
      // `setPosts([])` into the same commit as `run('loading', …)`, so neither
      // can produce this pair TODAY; `MasonryFeed` is nonetheless an exported
      // component whose `posts` and `activity` arrive as independent props,
      // and Task 7 mounts it against a second hook. This is the component's
      // contract being pinned, not a state the current feed reaches.
      await mount({ posts: [post('p1')], activity: 'loading' });
      expect(screen.queryByTestId('community-loading')).toBeNull();
      expect(screen.getByTestId('post-card-p1')).toBeTruthy();
    });

    it('shows the empty state when nobody has shared anything', async () => {
      await mount({ posts: [], activity: 'idle' });
      expect(screen.getByTestId('community-empty')).toBeTruthy();
      expect(screen.getByTestId('community-empty-title')).toHaveTextContent('Nothing shared yet');
      // Names the fix. An empty state that does not say where to go is a dead
      // end, and this one is the first thing a new user sees on the tab.
      // And it names the place that actually has the control. This said "from
      // the Add tab" while no screen in the app could share an outfit at all;
      // the entry point is on a saved outfit's own screen, which is reached
      // from the Favorites tab.
      expect(screen.getByTestId('community-empty-hint')).toHaveTextContent(
        'Open one of your outfits on the Favorites tab and share it.',
      );
    });

    it('lets a host word the empty state for a different list', async () => {
      await mount({ posts: [], emptyTitle: 'No saved posts', emptyHint: 'Tap the bookmark.' });
      expect(screen.getByTestId('community-empty-title')).toHaveTextContent('No saved posts');
      expect(screen.getByTestId('community-empty-hint')).toHaveTextContent('Tap the bookmark.');
    });

    it('does not tell a user whose load failed that the feed is empty', async () => {
      // Both false and unrecoverable-looking: the retry is in the banner the
      // user would then be told to ignore.
      await mount({ posts: [], error: 'Cannot reach the server.' });
      expect(screen.queryByTestId('community-empty')).toBeNull();
      expect(screen.getByTestId('community-error-message')).toHaveTextContent(
        'Cannot reach the server.',
      );
    });

    it('offers a retry that actually retries', async () => {
      await mount({ posts: [], error: 'Cannot reach the server.' });
      fireEvent.press(screen.getByTestId('community-retry'));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('shows no banner when nothing has failed', async () => {
      await mount({ posts: [post('p1')] });
      expect(screen.queryByTestId('community-error')).toBeNull();
    });

    it('shows a footer spinner while a page is appending', async () => {
      await mount({ posts: [post('p1')], activity: 'loadingMore' });
      expect(screen.getByTestId('community-loading-more')).toBeTruthy();
      // And the rows it is appending to are still there.
      expect(screen.getByTestId('post-card-p1')).toBeTruthy();
    });

    it('shows no footer spinner when nothing is appending', async () => {
      await mount({ posts: [post('p1')], activity: 'idle' });
      expect(screen.queryByTestId('community-loading-more')).toBeNull();
    });
  });

  describe('paging and refresh', () => {
    it('asks for the next page when the user nears the bottom', async () => {
      await mount({ posts: [post('p1')] });
      scrollTo(END_REACHED_THRESHOLD - 1);
      expect(onEndReached).toHaveBeenCalled();
    });

    it('does not ask while the user is still well above the bottom', async () => {
      // Without this the feed pages on the very first scroll event of every
      // gesture, which on a slow connection means a page request for a user
      // who has moved forty points.
      await mount({ posts: [post('p1')] });
      scrollTo(END_REACHED_THRESHOLD + 1);
      expect(onEndReached).not.toHaveBeenCalled();
    });

    it('delivers a scroll event often enough to derive paging from', async () => {
      // `scrollEventThrottle` defaults to 0, which on Android is one event per
      // gesture — and this list's paging is derived from scroll events alone,
      // so the default would page only when the user happened to stop near the
      // bottom.
      await mount({ posts: [post('p1')] });
      expect(screen.getByTestId('community-feed').props.scrollEventThrottle).toBe(16);
    });

    it('spins the refresh control only while refreshing', async () => {
      const view = await mount({ posts: [post('p1')], activity: 'refreshing' });
      expect(refreshControlProps().refreshing).toBe(true);

      await act(async () => {
        view.rerender(<MasonryFeed {...feed({ posts: [post('p1')], activity: 'loadingMore' })} />);
      });
      expect(refreshControlProps().refreshing).toBe(false);
    });

    it('refreshes on a pull', async () => {
      await mount({ posts: [post('p1')] });
      refreshControlProps().onRefresh();
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });
  });
  describe('retraction, handed down to the cards', () => {
    it("puts a retract control on the viewer's own card and on no other", async () => {
      // The feed hands `viewerId` to EVERY card and lets the card decide. A
      // list that decided instead — handing the id only to the cards it
      // believed were the viewer's — would be a second implementation of the
      // ownership rule, in the one place that cannot be unit-tested against a
      // stranger's post.
      await mount({
        posts: [post('mine', { author: { id: 'me', name: 'Me' } }), post('theirs')],
        viewerId: 'me',
        onRemove,
      });

      expect(screen.getByTestId('post-retract-mine')).toBeTruthy();
      expect(screen.queryByTestId('post-retract-theirs')).toBeNull();
    });

    it('reaches the host handler with the id of the card that was retracted', async () => {
      onRemove.mockResolvedValue(true);
      await mount({
        posts: [post('mine', { author: { id: 'me', name: 'Me' } })],
        viewerId: 'me',
        onRemove,
      });

      await fireEvent.press(screen.getByTestId('post-retract-mine'));
      await fireEvent.press(screen.getByTestId('post-retract-confirm-mine'));

      expect(onRemove).toHaveBeenCalledTimes(1);
      expect(onRemove).toHaveBeenCalledWith('mine');
    });

    it('carries no retract control when the host passes no delete path', async () => {
      // The saved list: `useSavedPosts` has no `remove`, so its cards offer
      // none even on the viewer's own post.
      await mount({
        posts: [post('mine', { author: { id: 'me', name: 'Me' } })],
        viewerId: 'me',
      });
      expect(screen.queryByTestId('post-retract-mine')).toBeNull();
    });
  });
});
