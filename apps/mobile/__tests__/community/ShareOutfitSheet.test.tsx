import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { MAX_CAPTION_LENGTH, type PublicClothingItem } from '@wardrobe/shared';
import { ApiClientError } from '../../src/api/client';
import { useAuth } from '../../src/auth/AuthContext';
import { sharePost } from '../../src/community/api';
import {
  COMMUNITY_READERS,
  consumeCommunityDirty,
} from '../../src/community/communityDirty';
import type { DisplayPost } from '../../src/community/posts';
import { ShareOutfitSheet, remainingLabel } from '../../src/community/ShareOutfitSheet';

// In `__tests__/` and NOT under `app/`: expo-router's Android require-context is
// recursive and bundles any `.tsx` beneath the app root as a route, including
// one inside a `__tests__/` subdirectory.

// A FACTORY mock naming only what this component calls, never a bare
// `jest.mock('../../src/api/client')`: an automocked `ApiClientError` is a class
// that cannot be constructed, and the failure tests below reject with the real
// one. `sharePost` has its own suite in `__tests__/community/api.test.ts`.
jest.mock('../../src/community/api', () => ({ sharePost: jest.fn() }));

// Only `useAuth`, so `AuthProvider` — which nothing here renders — and its
// expo-secure-store dependency stay out of this suite.
jest.mock('../../src/auth/AuthContext', () => ({ useAuth: jest.fn() }));

const mockedSharePost = jest.mocked(sharePost);
const mockedUseAuth = jest.mocked(useAuth);

const TOKEN = 'tok-abc';

type Element = ReturnType<typeof screen.getByTestId>;
type FiberLike = { memoizedProps: Record<string, unknown>; return: FiberLike | null };

/**
 * The `onPress` handler the element was rendered with, as a callable.
 *
 * `fireEvent.press` cannot model a same-frame double tap: it wraps each press
 * in its own `act()`, so React re-renders between them and the second press
 * sees an already-disabled button. Two touch events dispatched in one frame do
 * not — they both call the handler instance that was on screen when the first
 * landed, which is exactly what this reproduces. (Two nested `fireEvent.press`
 * calls inside one outer `act` make React 19 log "You seem to have overlapping
 * act() calls", so that route is not available either.)
 *
 * The same helper as `__tests__/suggestions/SuggestionCard.test.tsx`;
 * duplicated rather than shared because a `.ts` helper module under
 * `__tests__/` is picked up by Jest's default testMatch and fails as a suite
 * with no tests.
 */
function onPressOf(host: Element): () => void {
  let fiber = host.unstable_fiber as unknown as FiberLike | null;
  while (fiber !== null) {
    const handler = fiber.memoizedProps?.onPress;
    if (typeof handler === 'function') return handler as () => void;
    fiber = fiber.return;
  }
  throw new Error('No onPress handler found above the element');
}

/** A promise this test resolves by hand, so a request can be held in flight
 *  while the intermediate state is asserted. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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
    wearCount: 0,
    source: 'manual',
    createdAt: '2026-08-20T10:00:00.000Z',
  };
}

/** What `sharePost` resolves with: a `DisplayPost`, already converted — it
 *  carries no `itemIds` at all, which is the firewall Task 4 put there. */
function created(overrides: Partial<DisplayPost> = {}): DisplayPost {
  return {
    id: 'post-1',
    author: { id: 'me', name: 'Grace Hopper' },
    items: [item('i1')],
    caption: 'Rainy Tuesday layers',
    likeCount: 0,
    liked: false,
    saved: false,
    createdAt: '2026-08-25T09:00:00.000Z',
    missingItemsNotice: null,
    ...overrides,
  };
}

const onShared = jest.fn<void, [DisplayPost]>();
const onCancel = jest.fn<void, []>();

async function mount() {
  return render(<ShareOutfitSheet outfitId="outfit-1" onShared={onShared} onCancel={onCancel} />);
}

/** Type a caption and press Share, awaiting the settled request. */
async function share(caption: string) {
  await fireEvent.changeText(screen.getByTestId('share-caption-input'), caption);
  await fireEvent.press(screen.getByTestId('share-submit'));
}

/** The single options object `sharePost` was called with. */
function callArg(): { token: string | null; outfitId: string; caption: string } {
  return mockedSharePost.mock.calls[0][0];
}

describe('ShareOutfitSheet (FR9 / TC-11 — "shares an outfit to community feed with caption")', () => {
  beforeEach(() => {
    mockedUseAuth.mockReturnValue({
      status: 'authenticated',
      user: {
        id: 'me',
        name: 'Grace Hopper',
        email: 'grace@example.test',
        createdAt: '2026-08-01T10:00:00.000Z',
      },
      token: TOKEN,
      signIn: jest.fn(),
      signUp: jest.fn(),
      signOut: jest.fn(),
    });
    mockedSharePost.mockResolvedValue(created());
  });

  afterEach(() => {
    jest.clearAllMocks();
    // Drained through the public door rather than a test-only reset, so these
    // tests use the same one the app does. Module scope outlives a test.
    COMMUNITY_READERS.forEach((reader) => consumeCommunityDirty(reader));
  });

  describe('the caption and its counter', () => {
    it('starts at the whole budget', async () => {
      await mount();
      expect(screen.getByTestId('share-caption-remaining')).toHaveTextContent('280 characters left');
      expect(remainingLabel(MAX_CAPTION_LENGTH)).toBe('280 characters left');
    });

    it('counts down live as the caption is typed', async () => {
      await mount();
      await fireEvent.changeText(screen.getByTestId('share-caption-input'), 'Rainy day');
      expect(screen.getByTestId('share-caption-remaining')).toHaveTextContent('271 characters left');
    });

    it('agrees with itself at one', async () => {
      await mount();
      await fireEvent.changeText(
        screen.getByTestId('share-caption-input'),
        'x'.repeat(MAX_CAPTION_LENGTH - 1),
      );
      expect(screen.getByTestId('share-caption-remaining')).toHaveTextContent('1 character left');
    });

    it('counts UTF-16 code units, which is what the API counts', async () => {
      // THE FIXTURE DIFFERS ON EXACTLY THE AXIS THIS IS NAMED FOR: 140 of this
      // emoji is 280 UTF-16 code units and 140 code points, so a counter over
      // code points reads 140 here where this one reads 0.
      //
      // That the API counts the same units is now MEASURED rather than argued:
      // `apps/api/src/routes/community.integration.test.ts` —
      // "bounds the caption in UTF-16 code units, not code points" — runs 140
      // emoji (201), 141 emoji (400) and 141 ASCII (201) against the real route
      // and a real mongod. All three rows are needed: the first two alone are
      // equally consistent with a code-point bound of 140, and only the third
      // rules that out.
      //
      // A code-point counter would promise a user 140 more characters the
      // server had already stopped accepting — and the field's own `maxLength`
      // (Android's `InputFilter.LengthFilter`, which counts Java chars) would
      // cut them off at a number the counter never reached.
      const emoji = '🧥'.repeat(140);
      expect(emoji.length).toBe(280);
      expect([...emoji].length).toBe(140);

      await mount();
      await fireEvent.changeText(screen.getByTestId('share-caption-input'), emoji);
      expect(screen.getByTestId('share-caption-remaining')).toHaveTextContent('0 characters left');
    });

    it('takes the bound from @wardrobe/shared rather than a literal of its own', async () => {
      // Two copies of one bound drift silently and asymmetrically: a composer
      // allowing more than the API turns Share into an unretryable dead end,
      // and one allowing less refuses keystrokes the server would have taken.
      await mount();
      expect(screen.getByTestId('share-caption-input').props.maxLength).toBe(MAX_CAPTION_LENGTH);
      expect(MAX_CAPTION_LENGTH).toBe(280);
    });
  });

  describe('what may be shared', () => {
    it('refuses to share nothing at all', async () => {
      await mount();
      expect(screen.getByTestId('share-submit').props.accessibilityState).toEqual({
        disabled: true,
      });

      await fireEvent.press(screen.getByTestId('share-submit'));
      expect(mockedSharePost).not.toHaveBeenCalled();
    });

    it('refuses a caption that is only whitespace', async () => {
      // The API answers a whitespace-only caption with a 400, which is an error
      // the user cannot act on: the field looks full.
      await mount();
      await fireEvent.changeText(screen.getByTestId('share-caption-input'), '    \n  ');

      expect(screen.getByTestId('share-submit').props.accessibilityState).toEqual({
        disabled: true,
      });
      await fireEvent.press(screen.getByTestId('share-submit'));
      expect(mockedSharePost).not.toHaveBeenCalled();
    });

    it('allows the share once there is something to say', async () => {
      await mount();
      await fireEvent.changeText(screen.getByTestId('share-caption-input'), 'Rainy day');
      expect(screen.getByTestId('share-submit').props.accessibilityState).toEqual({
        disabled: false,
      });
    });
  });

  describe('sharing', () => {
    it('posts the outfit it was given, with the caption trimmed and the viewer’s token', async () => {
      await mount();
      await share('  Rainy Tuesday layers  ');

      expect(mockedSharePost).toHaveBeenCalledTimes(1);
      expect(callArg()).toEqual({
        token: TOKEN,
        outfitId: 'outfit-1',
        caption: 'Rainy Tuesday layers',
      });
    });

    it('marks the community feed stale, and only the feed', async () => {
      // The Search tab's focus gate is what actually shows the new post: it is
      // a page-one refetch keyed on this bit, so without the mark the user
      // returns to a feed that does not contain what they just shared.
      //
      // `['feed']` and ONLY `'feed'`. The no-argument default marks every
      // reader, which would additionally throw away the saved list's scrolled
      // pages to reload a list a share did not move.
      await mount();
      await share('Rainy Tuesday layers');

      expect(consumeCommunityDirty('feed')).toBe(true);
      expect(consumeCommunityDirty('saved')).toBe(false);
    });

    it('marks the feed BEFORE handing back, so a host that navigates cannot lose it', async () => {
      // A host's `onShared` dismisses this sheet and may navigate. Marking
      // after the hand-off would be a flag set on a component that is already
      // going away.
      let markedWhenCalled: boolean | null = null;
      onShared.mockImplementation(() => {
        markedWhenCalled = consumeCommunityDirty('feed');
      });
      await mount();
      await share('Rainy Tuesday layers');

      expect(markedWhenCalled).toBe(true);
    });

    it('hands the host the post the SERVER created', async () => {
      // A `DisplayPost`, not the wire post and not what was typed: the caption
      // comes back as the server stored it and `missingItemsNotice` is worded
      // by the data layer, so a confirmation built from this describes the post
      // that exists rather than the request that was sent.
      const post = created({ caption: 'Rainy Tuesday layers', missingItemsNotice: '1 item is no longer available' });
      mockedSharePost.mockResolvedValue(post);
      await mount();
      await share('   Rainy Tuesday layers   ');

      expect(onShared).toHaveBeenCalledTimes(1);
      expect(onShared).toHaveBeenCalledWith(post);
      expect(onShared.mock.calls[0][0]).not.toHaveProperty('itemIds');
    });
  });

  describe('when the share fails', () => {
    const failure = new ApiClientError('UNKNOWN', 'Cannot reach the server right now.', 0);

    it('keeps every character the user typed', async () => {
      // Losing 280 typed characters to a network blip is a real defect, and the
      // button is the retry.
      mockedSharePost.mockRejectedValueOnce(failure);
      await mount();
      await share('Rainy Tuesday layers');

      expect(screen.getByTestId('share-caption-input').props.value).toBe('Rainy Tuesday layers');
    });

    it("shows the API's own message", async () => {
      mockedSharePost.mockRejectedValueOnce(failure);
      await mount();
      await share('Rainy Tuesday layers');

      expect(screen.getByTestId('share-error')).toHaveTextContent(
        'Cannot reach the server right now.',
      );
    });

    it('claims nothing was shared', async () => {
      mockedSharePost.mockRejectedValueOnce(failure);
      await mount();
      await share('Rainy Tuesday layers');

      expect(onShared).not.toHaveBeenCalled();
      // Nothing was published, so nothing downstream is stale. Marking here
      // would cost the user their scrolled feed to reload a list that did not
      // move.
      expect(consumeCommunityDirty('feed')).toBe(false);
    });

    it('clears the message when a new attempt starts', async () => {
      mockedSharePost.mockRejectedValueOnce(failure);
      await mount();
      await share('Rainy Tuesday layers');
      expect(screen.getByTestId('share-error')).toBeTruthy();

      await fireEvent.press(screen.getByTestId('share-submit'));
      expect(screen.queryByTestId('share-error')).toBeNull();
    });
  });

  describe('the in-flight guard', () => {
    it('issues ONE request for a same-frame double tap', async () => {
      // Two touches dispatched before React can re-render both invoke the
      // closure that was on screen when the first landed, so the button's
      // `disabled` prop and the `sharing` state are both still false for the
      // second. Only the ref sees it — and two identical public posts of one
      // outfit is what it costs, with nothing server-side de-duplicating a
      // share.
      //
      // The request is HELD IN FLIGHT across the whole burst: a guard test
      // whose first request has already settled cannot see the guard at all.
      const gate = deferred<DisplayPost>();
      mockedSharePost.mockReturnValueOnce(gate.promise);
      await mount();
      await fireEvent.changeText(screen.getByTestId('share-caption-input'), 'Rainy day');

      const press = onPressOf(screen.getByTestId('share-submit'));
      await act(async () => {
        press();
        press();
      });

      expect(mockedSharePost).toHaveBeenCalledTimes(1);

      await act(async () => {
        gate.resolve(created());
      });
    });

    it('shows the share in flight, and locks the field and the way out', async () => {
      // The intermediate state, asserted while it is committed rather than
      // inferred from the outcome. Cancelling mid-share would complete the
      // `POST` with nobody left to report it.
      const gate = deferred<DisplayPost>();
      mockedSharePost.mockReturnValueOnce(gate.promise);
      await mount();
      await fireEvent.changeText(screen.getByTestId('share-caption-input'), 'Rainy day');

      // `onPressOf` rather than `await fireEvent.press`: RNTL 14's `fireEvent`
      // is async and does not settle until the handler's own promise does, so
      // awaiting a press whose request is deliberately left in flight hangs the
      // test until Jest's timeout.
      const press = onPressOf(screen.getByTestId('share-submit'));
      await act(async () => {
        press();
      });

      expect(screen.getByTestId('share-submit').props.accessibilityState).toEqual({
        disabled: true,
      });
      expect(screen.getByTestId('share-cancel').props.accessibilityState).toEqual({
        disabled: true,
      });
      expect(screen.getByTestId('share-caption-input').props.editable).toBe(false);

      await act(async () => {
        gate.resolve(created());
      });
    });

    it('is usable again after a success, for a host that has not dismissed it', async () => {
      // This sheet cannot dismiss itself — `onShared` is the host's cue — so a
      // guard released only on the FAILURE path leaves a still-mounted sheet
      // spinning forever, with a caption in it and no way to send it. Sharing
      // one outfit twice is deliberately allowed: two captions are two posts,
      // and `app/outfits/[id].tsx` re-opens this composer for the second.
      await mount();
      await share('Rainy Tuesday layers');
      expect(mockedSharePost).toHaveBeenCalledTimes(1);

      expect(screen.getByTestId('share-submit').props.accessibilityState).toEqual({
        disabled: false,
      });
      await fireEvent.press(screen.getByTestId('share-submit'));

      expect(mockedSharePost).toHaveBeenCalledTimes(2);
    });

    it('lets a second press through after a failure — the guard is released either way', async () => {
      // Stage 6's review found a guard released only on the success path: the
      // control could never be used again, and the test named "retryable"
      // passed because it only ever pressed once. A guard that is never
      // released is worse than no guard.
      mockedSharePost.mockRejectedValueOnce(
        new ApiClientError('UNKNOWN', 'Cannot reach the server right now.', 0),
      );
      await mount();
      await share('Rainy Tuesday layers');
      expect(mockedSharePost).toHaveBeenCalledTimes(1);

      await fireEvent.press(screen.getByTestId('share-submit'));

      expect(mockedSharePost).toHaveBeenCalledTimes(2);
      expect(mockedSharePost.mock.calls[1][0].caption).toBe('Rainy Tuesday layers');
    });
  });

  describe('backing out', () => {
    it('hands the host a cancel without sharing anything', async () => {
      await mount();
      await fireEvent.changeText(screen.getByTestId('share-caption-input'), 'Rainy day');
      await fireEvent.press(screen.getByTestId('share-cancel'));

      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(mockedSharePost).not.toHaveBeenCalled();
      expect(onShared).not.toHaveBeenCalled();
    });
  });
});
