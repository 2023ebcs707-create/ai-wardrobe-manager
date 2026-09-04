import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { ItemCategory, PublicClothingItem, PublicOutfitDetail } from '@wardrobe/shared';
// The real `ApiClientError`, not a mock: automocking a class that extends Error
// yields something that cannot be constructed, so `src/api/client` is never
// `jest.mock`ed anywhere in this repo.
import { ApiClientError } from '../../src/api/client';
import { useAuth } from '../../src/auth/AuthContext';
import { sharePost } from '../../src/community/api';
// The REAL signal module: it is a few lines of module state with no
// dependencies, and `__tests__/community/communityDirty.test.ts` pins its
// contract separately. Asserting through `consumeCommunityDirty` tests that the
// share actually moved the bit rather than that something called a function.
import {
  COMMUNITY_READERS,
  consumeCommunityDirty,
} from '../../src/community/communityDirty';
import type { DisplayPost } from '../../src/community/posts';
import { fetchOutfit } from '../../src/outfits/api';
import { consumeOutfitsDirty } from '../../src/outfits/outfitsDirty';
import { TRACKING_READERS, consumeTrackingDirty } from '../../src/tracking/trackingDirty';
import { useLogWear } from '../../src/tracking/useLogWear';
import OutfitDetailScreen from '../../app/outfits/[id]';

// Under `apps/mobile/__tests__/`, OUTSIDE the Expo Router app root:
// `expo-router/_ctx.android.js` builds its route context recursively and
// excludes only `+api`/`+html`/`+middleware`, so a colocated test drags
// @testing-library/react-native into the production Android bundle.

// This file is about the SHARE entry point only — the rest of this screen has
// its own suite in `__tests__/outfits/[id].test.tsx`, and stating one thing per
// file is the convention `favorites.focus`, `MasonryFeed.keys` and
// `search.focus` already follow here.

jest.mock('../../src/outfits/api', () => ({
  createOutfit: jest.fn(),
  fetchOutfits: jest.fn(),
  fetchOutfit: jest.fn(),
  updateOutfit: jest.fn(),
  deleteOutfit: jest.fn(),
}));

// `sharePost` alone: a factory mock is safe because the module exports plain
// functions and (erased) interfaces, no class. What it actually sends is pinned
// in `__tests__/community/api.test.ts`; this file is about what the SCREEN does.
jest.mock('../../src/community/api', () => ({ sharePost: jest.fn() }));

jest.mock('../../src/auth/AuthContext', () => ({ useAuth: jest.fn() }));

jest.mock('expo-router', () => ({
  useLocalSearchParams: jest.fn(),
  useRouter: jest.fn(),
}));

jest.mock('../../src/tracking/useLogWear', () => ({ useLogWear: jest.fn() }));

const mockedFetchOutfit = jest.mocked(fetchOutfit);
const mockedSharePost = jest.mocked(sharePost);
const mockedUseAuth = jest.mocked(useAuth);
const mockedUseLogWear = jest.mocked(useLogWear);
const mockedUseLocalSearchParams = useLocalSearchParams as unknown as jest.Mock;
const mockedUseRouter = useRouter as unknown as jest.Mock;

const TOKEN = 'tok-abc';

function item(id: string, category: ItemCategory): PublicClothingItem {
  return {
    id,
    userId: 'user-1',
    imageUrl: `https://example.test/full/${id}.jpg`,
    thumbnailUrl: `https://example.test/thumb/${id}.jpg`,
    category,
    colors: [],
    seasons: [],
    laundryStatus: 'available',
    wearCount: 0,
    source: 'manual',
    createdAt: '2026-08-01T10:00:00.000Z',
  };
}

const TOP = item('a', 'jacket');
const BOTTOM = item('b', 'trousers');

/** `PublicOutfitDetail` — the HEAVY shape `GET /outfits/:id` answers with. */
function detail(overrides: Partial<PublicOutfitDetail> = {}): PublicOutfitDetail {
  const items = overrides.items ?? [TOP, BOTTOM];
  return {
    id: 'outfit-1',
    userId: 'user-1',
    name: 'Work fit',
    itemIds: items.map((each) => each.id),
    itemCount: items.length,
    createdAt: '2026-08-24T09:00:00.000Z',
    ...overrides,
    items,
  };
}

/** What `sharePost` resolves with: a `DisplayPost`, already converted. */
function created(overrides: Partial<DisplayPost> = {}): DisplayPost {
  return {
    id: 'post-1',
    author: { id: 'user-1', name: 'Grace Hopper' },
    items: [TOP],
    caption: 'Rainy Tuesday layers',
    likeCount: 0,
    liked: false,
    saved: false,
    createdAt: '2026-08-25T09:00:00.000Z',
    missingItemsNotice: null,
    ...overrides,
  };
}

/** Render the screen and wait for the first fetch to settle. */
async function open(outfit: PublicOutfitDetail = detail()): Promise<void> {
  mockedFetchOutfit.mockResolvedValue(outfit);
  await render(<OutfitDetailScreen />);
  await waitFor(() => {
    expect(screen.getByTestId('outfit-detail-name')).toBeTruthy();
  });
}

/** Every event goes through `await act(async () => …)`, the convention this
 *  screen's other suite uses. */
async function press(testID: string): Promise<void> {
  await act(async () => {
    fireEvent.press(screen.getByTestId(testID));
  });
}

async function typeCaption(text: string): Promise<void> {
  await act(async () => {
    fireEvent.changeText(screen.getByTestId('share-caption-input'), text);
  });
}

describe('Outfit detail — sharing to the community (FR9 / TC-11)', () => {
  beforeEach(() => {
    mockedUseRouter.mockReturnValue({ back: jest.fn(), replace: jest.fn(), canGoBack: () => true });
    mockedUseLocalSearchParams.mockReturnValue({ id: 'outfit-1' });
    mockedUseAuth.mockReturnValue({
      status: 'authenticated',
      user: {
        id: 'user-1',
        name: 'Grace Hopper',
        email: 'grace@example.test',
        createdAt: '2026-08-01T10:00:00.000Z',
      },
      token: TOKEN,
      signIn: jest.fn(),
      signUp: jest.fn(),
      signOut: jest.fn(),
    });
    mockedUseLogWear.mockReturnValue({ logWear: jest.fn(), pending: false, error: null });
    mockedSharePost.mockResolvedValue(created());
  });

  afterEach(() => {
    jest.clearAllMocks();
    // Module state outlives a test. Drained through the public door so a
    // leftover mark cannot make the next test's "did not mark" assertion depend
    // on execution order.
    COMMUNITY_READERS.forEach((reader) => consumeCommunityDirty(reader));
    consumeOutfitsDirty();
    TRACKING_READERS.forEach((reader) => consumeTrackingDirty(reader));
  });

  it('offers a share control on a saved outfit, and opens no composer uninvited', async () => {
    // Without this control `POST /community/posts` is unreachable from the
    // product: `sharePost` has exactly one caller in the app and it is the
    // sheet this button opens.
    await open();
    expect(screen.getByTestId('outfit-share')).toBeTruthy();
    expect(screen.getByTestId('outfit-share').props.accessibilityLabel).toBe(
      'Share this outfit to the community feed',
    );
    expect(screen.queryByTestId('share-outfit-sheet')).toBeNull();
  });

  it('opens the caption composer when asked', async () => {
    await open();
    await press('outfit-share');

    expect(screen.getByTestId('share-outfit-sheet')).toBeTruthy();
    expect(screen.getByTestId('share-caption-input')).toBeTruthy();
    // The button is replaced by the composer rather than sitting beside it: two
    // ways to open one sheet is one of them doing nothing.
    expect(screen.queryByTestId('outfit-share')).toBeNull();
  });

  it('shares the outfit that is on screen, with the typed caption', async () => {
    await open();
    await press('outfit-share');
    await typeCaption('Rainy Tuesday layers');
    await press('share-submit');

    expect(mockedSharePost).toHaveBeenCalledTimes(1);
    expect(mockedSharePost.mock.calls[0][0]).toEqual({
      token: TOKEN,
      outfitId: 'outfit-1',
      caption: 'Rainy Tuesday layers',
    });
  });

  it('dismisses the composer on success, says so, and leaves the feed stale', async () => {
    await open();
    await press('outfit-share');
    await typeCaption('Rainy Tuesday layers');
    await press('share-submit');

    expect(screen.queryByTestId('share-outfit-sheet')).toBeNull();
    expect(screen.getByTestId('outfit-share-done-text')).toHaveTextContent(
      'Shared to the community feed.',
    );
    // The Search tab's focus gate is what puts the new post on screen.
    expect(consumeCommunityDirty('feed')).toBe(true);
  });

  it('repeats the data layer’s missing-items sentence verbatim, from the response', async () => {
    // Worth saying at all because the post has just gone PUBLIC missing some of
    // the garments the outfit above still lists. It is read from the POST the
    // server created rather than recomputed from the outfit on screen, and it
    // is not reworded, wrapped in a larger claim, or turned back into a number.
    mockedSharePost.mockResolvedValue(
      created({ missingItemsNotice: '1 item is no longer available' }),
    );
    await open();
    await press('outfit-share');
    await typeCaption('Rainy Tuesday layers');
    await press('share-submit');

    expect(screen.getByTestId('outfit-share-missing')).toHaveTextContent(
      '1 item is no longer available',
    );
  });

  it('says nothing about missing garments when none are missing', async () => {
    await open();
    await press('outfit-share');
    await typeCaption('Rainy Tuesday layers');
    await press('share-submit');

    expect(screen.queryByTestId('outfit-share-missing')).toBeNull();
  });

  it('keeps the composer, and the caption, when the share fails', async () => {
    mockedSharePost.mockRejectedValueOnce(
      new ApiClientError('UNKNOWN', 'Cannot reach the server right now.', 0),
    );
    await open();
    await press('outfit-share');
    await typeCaption('Rainy Tuesday layers');
    await press('share-submit');

    expect(screen.getByTestId('share-outfit-sheet')).toBeTruthy();
    expect(screen.getByTestId('share-caption-input').props.value).toBe('Rainy Tuesday layers');
    expect(screen.getByTestId('share-error')).toHaveTextContent(
      'Cannot reach the server right now.',
    );
    // Nothing was published, so nothing claims it was.
    expect(screen.queryByTestId('outfit-share-done')).toBeNull();
    expect(consumeCommunityDirty('feed')).toBe(false);
  });

  it('backs out of the composer without sharing', async () => {
    await open();
    await press('outfit-share');
    await typeCaption('Rainy Tuesday layers');
    await press('share-cancel');

    expect(screen.queryByTestId('share-outfit-sheet')).toBeNull();
    expect(screen.getByTestId('outfit-share')).toBeTruthy();
    expect(mockedSharePost).not.toHaveBeenCalled();
  });

  it('re-opening the composer clears the previous confirmation', async () => {
    // Sharing one outfit twice is allowed — two captions are two posts — and a
    // confirmation left under the composer would claim the caption being typed
    // was already shared.
    await open();
    await press('outfit-share');
    await typeCaption('Rainy Tuesday layers');
    await press('share-submit');
    expect(screen.getByTestId('outfit-share-done')).toBeTruthy();

    await press('outfit-share');

    expect(screen.queryByTestId('outfit-share-done')).toBeNull();
    expect(screen.getByTestId('share-outfit-sheet')).toBeTruthy();
  });

  it('does not touch the outfit gallery or the wear history', async () => {
    // A share creates a POST. It renames nothing, deletes nothing and logs no
    // wear, so marking either of those signals would throw away a list's
    // scrolled pages to reload something that did not move.
    await open();
    await press('outfit-share');
    await typeCaption('Rainy Tuesday layers');
    await press('share-submit');

    expect(consumeOutfitsDirty()).toBe(false);
    expect(consumeTrackingDirty('profile')).toBe(false);
    expect(consumeTrackingDirty('wardrobe')).toBe(false);
  });
});
