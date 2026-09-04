import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { MAX_OUTFIT_ITEMS, type ItemCategory, type PublicClothingItem, type PublicOutfit } from '@wardrobe/shared';
import { OutfitComposer } from '../../src/outfits/OutfitComposer';
import { useWardrobe, type UseWardrobeResult } from '../../src/wardrobe/useWardrobe';
import { createOutfit } from '../../src/outfits/api';
import { useAuth } from '../../src/auth/AuthContext';

// In `__tests__/` rather than under `app/` — see the note in
// `OutfitComposer.test.tsx`. A file of its own rather than a describe block in
// that 900-line suite because this is one new prop with one job: Stage 7's
// "Modify", which opens the composer holding a suggestion's garments.

jest.mock('../../src/wardrobe/useWardrobe', () => ({ useWardrobe: jest.fn() }));
jest.mock('../../src/outfits/api', () => ({ createOutfit: jest.fn() }));
jest.mock('../../src/auth/AuthContext', () => ({ useAuth: jest.fn() }));

const mockedUseWardrobe = jest.mocked(useWardrobe);
const mockedCreateOutfit = createOutfit as jest.Mock;
const mockedUseAuth = useAuth as jest.Mock;

const TOKEN = 'tok-abc';

function item(id: string, category: ItemCategory = 'tshirt'): PublicClothingItem {
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

const A = item('a', 'tshirt');
const B = item('b', 'trousers');
const C = item('c', 'shoes');

function wardrobe(overrides: Partial<UseWardrobeResult> = {}): UseWardrobeResult {
  return {
    items: [A, B, C],
    category: null,
    setCategory: jest.fn(),
    activity: 'idle',
    error: null,
    loadMore: jest.fn(),
    refresh: jest.fn(),
    hasMore: false,
    ...overrides,
  };
}

function created(overrides: Partial<PublicOutfit> = {}): PublicOutfit {
  return {
    id: 'outfit-1',
    userId: 'user-1',
    itemIds: ['a', 'b'],
    itemCount: 2,
    coverUrl: 'https://example.test/cover/a.jpg',
    createdAt: '2026-08-25T09:00:00.000Z',
    ...overrides,
  };
}

/** The 1-based ordinal drawn on a tile, or `undefined` when it is unselected. */
function ordinalOf(id: string): string | undefined {
  const badge = screen.queryByTestId(`item-selection-${id}`);
  if (badge === null) return undefined;
  const text = badge.children[0];
  return typeof text === 'string' ? text : String((text as { children: unknown[] }).children[0]);
}

function selectedCount(): string {
  const text = screen.getByTestId('outfit-count').children[0];
  return String(text);
}

/** The `itemIds` `createOutfit` was posted with, on call `n` (0-based). */
function postedIds(n = 0): string[] {
  return (mockedCreateOutfit.mock.calls[n][0] as { itemIds: string[] }).itemIds;
}

async function tap(id: string): Promise<void> {
  await act(async () => {
    fireEvent.press(screen.getByTestId(`item-tile-${id}`));
  });
}

async function pressSave(): Promise<void> {
  await act(async () => {
    fireEvent.press(screen.getByTestId('outfit-save'));
  });
}

describe('OutfitComposer preselection (Stage 7 "Modify")', () => {
  beforeEach(() => {
    mockedUseAuth.mockReturnValue({
      status: 'authenticated',
      user: { id: 'user-1', name: 'Zaid', email: 'z@example.com', createdAt: '2026-01-01T00:00:00.000Z' },
      token: TOKEN,
      signIn: jest.fn(),
      signUp: jest.fn(),
      signOut: jest.fn(),
    });
    mockedUseWardrobe.mockReturnValue(wardrobe());
    mockedCreateOutfit.mockResolvedValue(created());
  });

  afterEach(() => {
    // `clearAllMocks`, NOT `resetAllMocks`. `jest.resetAllMocks()` strips the
    // IMPLEMENTATION off every mock in the registry — jest-expo's own setup
    // mocks included, one of which is what registers a bundled asset — so the
    // next `@expo/vector-icons` mount rejects with
    // `Module "1" is missing from the asset registry`, failing whichever test
    // happens to be the first one that draws a tile. This file mounts real
    // `ItemTile`s, so it is exposed the moment a test that renders no icon is
    // added at the top. `beforeEach` re-states every implementation this file
    // needs, so forgetting the CALLS is all that is required here.
    jest.clearAllMocks();
  });

  it('starts empty when no preselection is given', async () => {
    // The control for every assertion below: without it, a composer that
    // selected everything would pass most of them.
    await render(<OutfitComposer />);
    expect(selectedCount()).toBe('0 selected');
    expect(ordinalOf('a')).toBeUndefined();
  });

  it('opens holding the given ids, in the given order', async () => {
    // The order is the engine's — top, bottom, shoes — and it is what the
    // ordinals on the tiles must read, because that order is what
    // `POST /outfits` will store.
    await render(<OutfitComposer preselectedItemIds={['b', 'a', 'c']} />);

    expect(selectedCount()).toBe('3 selected');
    expect(ordinalOf('b')).toBe('1');
    expect(ordinalOf('a')).toBe('2');
    expect(ordinalOf('c')).toBe('3');
  });

  it('posts the preselected ids, in order, when saved untouched', async () => {
    await render(<OutfitComposer preselectedItemIds={['c', 'a']} />);
    await pressSave();
    expect(postedIds()).toEqual(['c', 'a']);
  });

  it('holds ids the wardrobe page has not loaded, and posts them', async () => {
    // The selection is the composer's own state, not a projection of `items` —
    // and it has to be here more than anywhere. A suggestion can name a garment
    // that is not on the wardrobe's first page (or not in the current category
    // filter), and dropping it would silently save a DIFFERENT outfit from the
    // one the card showed.
    await render(<OutfitComposer preselectedItemIds={['a', 'far-away']} />);

    expect(selectedCount()).toBe('2 selected');
    expect(screen.queryByTestId('item-tile-far-away')).toBeNull();

    await pressSave();
    expect(postedIds()).toEqual(['a', 'far-away']);
  });

  it('is a starting point, not a lock — the user can still edit it before saving', async () => {
    // "Save or MODIFY". A preselection the user cannot change would make the
    // second verb a lie, and the ordinals must renumber on a middle removal
    // exactly as they do for a hand-built selection.
    await render(<OutfitComposer preselectedItemIds={['a', 'b', 'c']} />);
    await tap('b');

    expect(selectedCount()).toBe('2 selected');
    expect(ordinalOf('a')).toBe('1');
    expect(ordinalOf('b')).toBeUndefined();
    expect(ordinalOf('c')).toBe('2');

    await pressSave();
    expect(postedIds()).toEqual(['a', 'c']);
  });

  it('applies a SECOND preselection to a composer that is already mounted', async () => {
    // The case `useState(initial)` gets wrong, and the only one that matters:
    // `useState` reads its argument on the first render alone, so a mounted
    // composer would ignore the second Modify entirely and the user would be
    // handed the FIRST suggestion's garments while looking at the second one's
    // card. Nothing about that failure is visible in a diff.
    const view = await render(<OutfitComposer preselectedItemIds={['a']} />);
    expect(selectedCount()).toBe('1 selected');
    expect(ordinalOf('a')).toBe('1');

    await act(async () => {
      view.rerender(<OutfitComposer preselectedItemIds={['b', 'c']} />);
    });

    expect(selectedCount()).toBe('2 selected');
    expect(ordinalOf('a')).toBeUndefined();
    expect(ordinalOf('b')).toBe('1');
    expect(ordinalOf('c')).toBe('2');

    await pressSave();
    // A REPLACEMENT, not a merge: modifying one proposed outfit must not build
    // a garment pile out of two suggestions.
    expect(postedIds()).toEqual(['b', 'c']);
  });

  it('does not undo the user edits when the host rebuilds an equal array', async () => {
    // The prop is compared by VALUE. A host that writes
    // `preselectedItemIds={[...ids]}` inline builds a new array on every
    // render, and a reference comparison would re-apply the preselection on
    // each one — silently putting back every tile the user had just removed,
    // for as long as they stayed on the screen.
    const view = await render(<OutfitComposer preselectedItemIds={['a', 'b']} />);
    await tap('b');
    expect(selectedCount()).toBe('1 selected');

    await act(async () => {
      view.rerender(<OutfitComposer preselectedItemIds={['a', 'b']} />);
    });

    expect(selectedCount()).toBe('1 selected');
    expect(ordinalOf('b')).toBeUndefined();
  });

  it('keeps the first MAX_OUTFIT_ITEMS of an over-long preselection, and says so', async () => {
    // `toggle` refuses a tap past the limit rather than sending a selection the
    // API would reject, because a 400 is the one error this screen's "press it
    // again" contract cannot answer. A preselection walking in over the limit
    // would defeat that guard from the other side: the save button enabled, the
    // POST 400ing, and the retry 400ing forever.
    const tooMany = Array.from({ length: MAX_OUTFIT_ITEMS + 3 }, (_, index) => `item-${index}`);
    await render(<OutfitComposer preselectedItemIds={tooMany} />);

    expect(selectedCount()).toBe(`${MAX_OUTFIT_ITEMS} selected`);
    // The limit notice renders AT the limit rather than past it, so the reason
    // is already on screen.
    expect(screen.getByTestId('outfit-limit')).toBeTruthy();

    await pressSave();
    // The FIRST of them, in order: the order is the engine's and the front of
    // it is the outfit's core — a top and a bottom before its accessories.
    expect(postedIds()).toEqual(tooMany.slice(0, MAX_OUTFIT_ITEMS));
  });

  it('drops a duplicated id rather than holding a selection it cannot represent', async () => {
    // The composer's selection is an ordered SET: `toggle` tests membership
    // with `includes` and removes with `filter`, so one tap on a repeated id
    // would remove both copies and the tile would carry two ordinals. The API
    // rejects a duplicate outright too — another unretryable 400.
    await render(<OutfitComposer preselectedItemIds={['a', 'b', 'a']} />);

    expect(selectedCount()).toBe('2 selected');
    expect(ordinalOf('a')).toBe('1');
    expect(ordinalOf('b')).toBe('2');

    await pressSave();
    expect(postedIds()).toEqual(['a', 'b']);
  });

  it('clears the previous outfit verdict when a new preselection arrives', async () => {
    // `toggle` already clears `saved` when the user picks a different garment,
    // for a stated reason: the confirmation describes an outfit they have
    // finished with. A new preselection is the same event arriving from the
    // other direction, and it is the WHOLE POINT of this sync — a host that
    // keeps the composer mounted is exactly the host where a second Modify
    // would otherwise land with the previous outfit's "Saved" still on screen,
    // over a selection that is no longer the one it describes.
    //
    // Invisible on `add.tsx`, whose modes are alternatives and so unmount this
    // component between Modifies. That is a property of one host, not of this
    // prop.
    const view = await render(<OutfitComposer preselectedItemIds={['a', 'b']} />);
    await pressSave();
    expect(screen.getByTestId('outfit-saved')).toBeTruthy();

    await act(async () => {
      view.rerender(<OutfitComposer preselectedItemIds={['c']} />);
    });

    expect(screen.queryByTestId('outfit-saved')).toBeNull();
    expect(selectedCount()).toBe('1 selected');
  });

  it('clears a previous save error when a new preselection arrives', async () => {
    // The same for the failure half, and it matters more: the error is offered
    // as retryable and the save button IS the retry, so leaving it up over a
    // different selection invites the user to "retry" an outfit they are no
    // longer composing.
    mockedCreateOutfit.mockRejectedValueOnce(new Error('nope'));
    const view = await render(<OutfitComposer preselectedItemIds={['a', 'b']} />);
    await pressSave();
    expect(screen.getByTestId('outfit-save-error')).toBeTruthy();

    await act(async () => {
      view.rerender(<OutfitComposer preselectedItemIds={['c']} />);
    });

    expect(screen.queryByTestId('outfit-save-error')).toBeNull();
  });

  it('clears the selection when the host drops the preselection entirely', async () => {
    // `undefined` means "start empty", and it is what the Add tab passes when
    // the composer is opened from the chip row rather than from a suggestion.
    // Treating it as "leave whatever was there" would seed a brand-new outfit
    // with a suggestion the user had moved on from.
    const view = await render(<OutfitComposer preselectedItemIds={['a', 'b']} />);
    expect(selectedCount()).toBe('2 selected');

    await act(async () => {
      view.rerender(<OutfitComposer />);
    });

    expect(selectedCount()).toBe('0 selected');
  });
});
