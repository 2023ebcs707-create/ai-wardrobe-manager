import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import { MasonryFeed } from '../../src/community/MasonryFeed';
import type { MasonryFeedProps } from '../../src/community/MasonryFeed';
import type { DisplayPost } from '../../src/community/posts';

/**
 * The card is replaced by a probe that records, in a ref, the id it was
 * **first** rendered with, and renders that recorded id as text under a testID
 * keyed by its **current** id. A card React remounts starts a fresh ref, so
 * `probe-x` reads "x". A card React reuses keeps the old one, so `probe-x`
 * reads "p1" — a stranger's outfit under the wrong author's name, made textual.
 *
 * The same instrument as `__tests__/outfits/favorites.keys.test.tsx`, and it is
 * the one that catches an index key through public queries only: reading the
 * key extractor's return value proves what the extractor does and nothing about
 * what the feed passes it.
 *
 * The probe replaces the card rather than wrapping it so that this file states
 * one thing only; `PostCard.test.tsx` exercises the real card.
 */
jest.mock('../../src/community/PostCard', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    PostCard: ({ post }: { post: DisplayPost }) => {
      const firstRenderedWith = ReactActual.useRef(post.id);
      return ReactActual.createElement(
        Text,
        { testID: `probe-${post.id}` },
        firstRenderedWith.current,
      );
    },
  };
});

/**
 * Every post here has the SAME shape, so `postCardHeight` gives them all the
 * same number and the column assignment is `[[0, 2], [1, 3]]` before and after
 * every swap below.
 *
 * That is deliberate rather than incidental. A replacement that also moved a
 * post between columns would remount it whatever the key was, and the test
 * would pass against an index key — the fixture would be hiding the mechanism
 * it is named for. Holding the assignment still is what leaves the key as the
 * only thing that can decide whether a card is reused.
 */
function post(id: string): DisplayPost {
  return {
    id,
    author: { id: 'author-1', name: 'Ada Lovelace' },
    items: [],
    caption: 'Same shape, same height',
    likeCount: 0,
    liked: false,
    saved: false,
    createdAt: '2026-08-24T09:00:00.000Z',
    missingItemsNotice: null,
  };
}

function feed(overrides: Partial<MasonryFeedProps> = {}): MasonryFeedProps {
  return {
    posts: [],
    activity: 'idle',
    error: null,
    onRetry: jest.fn(),
    onEndReached: jest.fn(),
    onRefresh: jest.fn(),
    onToggleLike: jest.fn<Promise<boolean>, [string]>(),
    onToggleSave: jest.fn<Promise<boolean>, [string]>(),
    // Irrelevant here — the card is a probe — but required, so that a host
    // cannot mount this list without deciding who is looking at it.
    viewerId: null,
    ...overrides,
  };
}

describe('community feed card identity', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('remounts a card when a refresh replaces the post that was in it', async () => {
    // The sequence this screen produces more than any other in the app: a
    // pull-to-refresh, a focus refetch after a share, and every settled search
    // term all swap `posts` wholesale while the columns stay mounted —
    // `activity` goes to `'refreshing'`, not `'loading'`, so nothing unmounts.
    // With an index key the card, and the garment images already mounted in
    // it, are reused for a different post.
    //
    // This is the case a paging test cannot reach: a pure append leaves every
    // existing card's position untouched, so id keys and index keys reconcile
    // identically there.
    const before = [post('p1'), post('p2'), post('p3'), post('p4')];
    const view = await render(<MasonryFeed {...feed({ posts: before })} />);
    expect(screen.getByTestId('probe-p1')).toHaveTextContent('p1');
    expect(screen.getByTestId('probe-p2')).toHaveTextContent('p2');

    await act(async () => {
      view.rerender(<MasonryFeed {...feed({ posts: before, activity: 'refreshing' })} />);
    });

    const after = [post('x1'), post('x2'), post('x3'), post('x4')];
    await act(async () => {
      view.rerender(<MasonryFeed {...feed({ posts: after, activity: 'idle' })} />);
    });

    // Each card must be showing the post it is labelled with, not the one that
    // occupied that slot a moment ago.
    expect(screen.getByTestId('probe-x1')).toHaveTextContent('x1');
    expect(screen.getByTestId('probe-x2')).toHaveTextContent('x2');
    expect(screen.getByTestId('probe-x3')).toHaveTextContent('x3');
    expect(screen.getByTestId('probe-x4')).toHaveTextContent('x4');
  });

  it('remounts a card when a delete shortens the list under it', async () => {
    // The other route to a reused card, and it needs no network: the author
    // deletes their own post, so every post after it shifts up one position
    // while the columns stay mounted.
    const view = await render(
      <MasonryFeed {...feed({ posts: [post('p1'), post('p2'), post('p3'), post('p4')] })} />,
    );
    expect(screen.getByTestId('probe-p3')).toHaveTextContent('p3');

    await act(async () => {
      view.rerender(<MasonryFeed {...feed({ posts: [post('p1'), post('p3'), post('p4')] })} />);
    });

    expect(screen.getByTestId('probe-p1')).toHaveTextContent('p1');
    expect(screen.getByTestId('probe-p3')).toHaveTextContent('p3');
    expect(screen.getByTestId('probe-p4')).toHaveTextContent('p4');
  });

  it('keeps a card mounted when a page is appended beneath it', async () => {
    // The other half of the contract, and the reason the two tests above have
    // to exist: paging must NOT remount what is already on screen, or every
    // `onEndReached` re-downloads the images the user is looking at. An index
    // key passes this one too, which is exactly why it is not evidence on its
    // own.
    const page1 = [post('p1'), post('p2')];
    const view = await render(<MasonryFeed {...feed({ posts: page1 })} />);
    expect(screen.getByTestId('probe-p1')).toHaveTextContent('p1');

    await act(async () => {
      view.rerender(
        <MasonryFeed {...feed({ posts: [...page1, post('p3'), post('p4')] })} />,
      );
    });

    expect(screen.getByTestId('probe-p1')).toHaveTextContent('p1');
    expect(screen.getByTestId('probe-p2')).toHaveTextContent('p2');
    expect(screen.getByTestId('probe-p3')).toHaveTextContent('p3');
  });
});
