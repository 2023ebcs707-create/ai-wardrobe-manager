import React from 'react';
import { FlatList } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import {
  MAX_OUTFIT_ITEMS,
  MAX_OUTFIT_NAME_LENGTH,
  type ItemCategory,
  type PublicClothingItem,
  type PublicOutfit,
} from '@wardrobe/shared';
import { OutfitComposer } from '../../src/outfits/OutfitComposer';
import { useWardrobe, type UseWardrobeResult } from '../../src/wardrobe/useWardrobe';
import { createOutfit } from '../../src/outfits/api';
import { useAuth } from '../../src/auth/AuthContext';
import { ApiClientError } from '../../src/api/client';

// This file lives in `__tests__/` and NOT under `app/`. Expo Router's Android
// require-context is recursive and excludes only `+api`/`+html`/`+middleware`,
// so any `.tsx` beneath the app root — including one inside a `__tests__/`
// subdirectory — is bundled as a route. See README.md:161.

// `useWardrobe` has its own 19-test suite. Mocking it at the module boundary
// keeps this file about what the COMPOSER derives from that contract, and
// stops `src/api/client` from being loaded through it.
jest.mock('../../src/wardrobe/useWardrobe', () => ({ useWardrobe: jest.fn() }));

// `createOutfit` has its own suite too (`__tests__/outfits/api.test.ts`). A
// FACTORY mock, never a bare `jest.mock('../../src/api/client')`: an
// automocked `ApiClientError` is a class that cannot be constructed, so the
// failure test below could never run. The real error class is imported above
// and rejected with.
jest.mock('../../src/outfits/api', () => ({ createOutfit: jest.fn() }));

// Only `useAuth` is mocked, not the whole module: a bare automock would also
// replace `AuthProvider`, which nothing here renders.
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
    retired: false,
    wearCount: 0,
    source: 'manual',
    createdAt: '2026-08-01T10:00:00.000Z',
  };
}

/** The three the composer sees unless a test says otherwise, in wardrobe order. */
const A = item('a', 'tshirt');
const B = item('b', 'trousers');
const C = item('c', 'shoes');

function wardrobe(overrides: Partial<UseWardrobeResult> = {}): UseWardrobeResult {
  return {
    items: [],
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

function showing(overrides: Partial<UseWardrobeResult> = {}): UseWardrobeResult {
  const value = wardrobe({ items: [A, B, C], ...overrides });
  mockedUseWardrobe.mockReturnValue(value);
  return value;
}

/**
 * What `createOutfit` resolves with: `PublicOutfit`, the LIGHT shape.
 *
 * It carries `coverUrl` and `itemCount` and has NO `items` — `PublicOutfitDetail`
 * (from `GET /outfits/:id` and `PATCH`) is the other way round. Task 3's
 * hand-off note is that the asymmetry is only half compile-checked, so this
 * fixture is deliberately the exact shape the create path returns.
 */
function created(overrides: Partial<PublicOutfit> = {}): PublicOutfit {
  return {
    id: 'outfit-1',
    userId: 'user-1',
    itemIds: ['a', 'b'],
    itemCount: 2,
    coverUrl: 'https://example.test/cover/a.jpg',
    createdAt: '2026-08-24T09:00:00.000Z',
    ...overrides,
  };
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

async function typeName(text: string): Promise<void> {
  await act(async () => {
    fireEvent.changeText(screen.getByTestId('outfit-name'), text);
  });
}

/** The single argument `createOutfit` was called with, on call `n` (0-based). */
function callArg(n = 0): Record<string, unknown> {
  return mockedCreateOutfit.mock.calls[n][0] as Record<string, unknown>;
}

function isSelected(id: string): unknown {
  return screen.getByTestId(`item-tile-${id}`).props.accessibilityState?.selected;
}

function saveDisabled(): unknown {
  return screen.getByTestId('outfit-save').props.accessibilityState?.disabled;
}

/**
 * Minimal shape of a React fiber, declared locally so this file does not take
 * a dependency on react-reconciler's types for one lookup. Same escape hatch
 * `__tests__/index.test.tsx` uses to read a `FlatList`'s props.
 */
type FiberLike = {
  type: unknown;
  memoizedProps: Record<string, unknown>;
  return: FiberLike | null;
};

/**
 * The props the `<FlatList>` above `host` was actually rendered with.
 *
 * A React key never reaches the rendered tree — `toJSON()` returns
 * `{ type, props, children }` and nothing else — and `extraData` is consumed
 * inside `VirtualizedList` rather than rendered, so no public query can see
 * either one. `unstable_fiber` is the escape hatch `TestInstance` documents
 * for exactly this, and `__tests__/index.test.tsx` already uses it to pin the
 * wardrobe grid's `keyExtractor` and `numColumns`.
 */
function flatListProps(host: ReturnType<typeof screen.getByTestId>): Record<string, unknown> {
  let fiber = host.unstable_fiber as unknown as FiberLike | null;
  while (fiber !== null) {
    if (fiber.type === FlatList) return fiber.memoizedProps;
    fiber = fiber.return;
  }
  throw new Error('No <FlatList> found above the composer grid element');
}

/**
 * The `onPress` handler the element was rendered with, as a callable.
 *
 * Needed because `fireEvent.press` wraps every press in its own `act()`, and
 * two of those nested inside one outer `act` make React 19 log "You seem to
 * have overlapping act() calls" — a warning, and therefore a failure by this
 * project's pristine-output rule. Invoking the captured handler twice is also
 * a *closer* model of the race being tested: two touch events dispatched in
 * the same frame both call the handler instance that was on screen when the
 * first one landed.
 */
function onPressOf(host: ReturnType<typeof screen.getByTestId>): () => void {
  let fiber = host.unstable_fiber as unknown as FiberLike | null;
  while (fiber !== null) {
    const handler = fiber.memoizedProps?.onPress;
    if (typeof handler === 'function') return handler as () => void;
    fiber = fiber.return;
  }
  throw new Error('No onPress handler found above the element');
}

describe('OutfitComposer', () => {
  beforeEach(() => {
    mockedUseAuth.mockReturnValue({
      status: 'authenticated',
      user: { id: 'user-1', name: 'Zaid', email: 'z@example.com', createdAt: '2026-01-01T00:00:00.000Z' },
      token: TOKEN,
      signIn: jest.fn(),
      signUp: jest.fn(),
      signOut: jest.fn(),
    });
    showing();
    mockedCreateOutfit.mockResolvedValue(created());
  });

  afterEach(() => {
    // `clearAllMocks`, NOT `resetAllMocks`, and the difference is a harness
    // hazard rather than a style choice. `jest.resetAllMocks()` strips the
    // IMPLEMENTATION off every mock in the registry — including the ones
    // jest-expo's own setup installs, one of which is what registers a bundled
    // asset — so after the first one the next `@expo/vector-icons` mount
    // rejects with `Module "1" is missing from the asset registry`. This file
    // mounts real `ItemTile`s (Ionicons badge and all) and escaped it only
    // because its FIRST test happens to draw one, loading the font before
    // anything is reset: insert a test above that renders no icon and 50-odd
    // tests fail with an error that has nothing to do with them.
    //
    // Nothing here needs the implementations gone. Several tests DO install a
    // lasting `mockImplementation`/`mockRejectedValue`, but `beforeEach`
    // overwrites both mocks outright — `showing()` re-sets `useWardrobe` and
    // `mockedCreateOutfit.mockResolvedValue(created())` re-sets `createOutfit`
    // — so none of them can reach the next test. What this file actually
    // relies on the teardown for is the CALL LOG, which is exactly what
    // `clearAllMocks` forgets, and it leaves the harness alone.
    jest.clearAllMocks();
  });

  it('renders the wardrobe items as selectable tiles', async () => {
    await render(<OutfitComposer />);
    // `false`, not merely falsy: the composer has to PASS the selection prop,
    // which is what turns a wardrobe cell into a selectable one — the tile
    // reads the prop's presence as "this tap toggles membership".
    expect(isSelected('a')).toBe(false);
    expect(isSelected('b')).toBe(false);
    expect(isSelected('c')).toBe(false);
    expect(screen.getByTestId('item-tile-a').props.accessibilityHint).toMatch(/adds/i);
  });

  it('selects an item on tap and shows the count', async () => {
    await render(<OutfitComposer />);
    await tap('b');
    expect(isSelected('b')).toBe(true);
    expect(screen.getByTestId('item-selection-b')).toHaveTextContent('1');
    expect(screen.getByTestId('outfit-count')).toHaveTextContent('1 selected');
  });

  it('deselects on a second tap', async () => {
    await render(<OutfitComposer />);
    await tap('b');
    await tap('b');
    expect(isSelected('b')).toBe(false);
    expect(screen.queryByTestId('item-selection-b')).toBeNull();
    expect(screen.getByTestId('outfit-count')).toHaveTextContent('0 selected');
  });

  it('renumbers the remaining ordinals after a middle deselect', async () => {
    // THE most likely defect in this task. Select a, b, c → deselect b → c
    // must read 2, not 3. A stale ordinal is what an implementation that
    // *stores* the number at selection time ships; the ordinal has to be
    // derived from the position in the selection, every render.
    await render(<OutfitComposer />);
    await tap('a');
    await tap('b');
    await tap('c');
    expect(screen.getByTestId('item-selection-c')).toHaveTextContent('3');

    await tap('b');

    expect(screen.getByTestId('item-selection-a')).toHaveTextContent('1');
    expect(screen.getByTestId('item-selection-c')).toHaveTextContent('2');
    expect(screen.queryByTestId('item-selection-b')).toBeNull();
    expect(screen.getByTestId('outfit-count')).toHaveTextContent('2 selected');
  });

  it('renumbers what is actually posted after a middle deselect, not just what is drawn', async () => {
    // The ordinal on screen and the array on the wire are the same fact seen
    // twice. A composer that renumbered only the badge would still post the
    // hole.
    await render(<OutfitComposer />);
    await tap('a');
    await tap('b');
    await tap('c');
    await tap('b');
    await pressSave();
    expect(callArg().itemIds).toEqual(['a', 'c']);
  });

  it('disables save with nothing selected', async () => {
    await render(<OutfitComposer />);
    expect(saveDisabled()).toBe(true);
    await tap('a');
    expect(saveDisabled()).not.toBe(true);
  });

  it('does not post an outfit when save is pressed with nothing selected', async () => {
    // `POST /outfits` requires 1..20 ids, so an empty save is a guaranteed 400.
    //
    // NOT independent of the test above it, and deliberately so: it passes
    // because RNTL refuses to dispatch to a disabled Pressable, which is the
    // same `disabled` prop that test asserts. `onSave` carries no second,
    // redundant empty check to make it independent — the same-frame race that
    // defeats `disabled` needs two presses on the SAME target, and "deselect
    // the last item" and "press save" are two different ones, so the state
    // behind `disabled` can never be stale here in the way it is for a double
    // tap. What this adds is the OUTCOME: `disabled` is asserted as a prop
    // above, and asserted to actually stop the request here.
    await render(<OutfitComposer />);
    await pressSave();
    expect(mockedCreateOutfit).not.toHaveBeenCalled();
  });

  it('posts the selected ids in selection order', async () => {
    // Wardrobe order is a, b, c. Selecting c, a, b must post [c, a, b] — the
    // order is what the API stores and what makes an outfit read correctly,
    // so it can never be re-derived from the order the grid happens to be in.
    await render(<OutfitComposer />);
    await tap('c');
    await tap('a');
    await tap('b');
    await pressSave();
    expect(mockedCreateOutfit).toHaveBeenCalledTimes(1);
    expect(callArg().itemIds).toEqual(['c', 'a', 'b']);
    expect(callArg().token).toBe(TOKEN);
  });

  it('sends the trimmed name when one is entered', async () => {
    await render(<OutfitComposer />);
    await tap('a');
    await typeName('  Beach day  ');
    await pressSave();
    expect(callArg().name).toBe('Beach day');
  });

  it('omits the name when the field is blank', async () => {
    // An unnamed outfit is valid — neither FR5 nor TC-07 mentions naming one.
    // The key must be ABSENT rather than `''`: the API's name schema trims and
    // accepts an empty string, so a blank field would otherwise save an outfit
    // whose name is deliberately empty rather than one with no name.
    await render(<OutfitComposer />);
    await tap('a');
    await typeName('   ');
    await pressSave();
    expect(Object.keys(callArg())).not.toContain('name');
    expect(callArg()).toEqual({ token: TOKEN, itemIds: ['a'] });
  });

  it('omits the name when the field was never touched', async () => {
    await render(<OutfitComposer />);
    await tap('a');
    await pressSave();
    expect(Object.keys(callArg())).not.toContain('name');
  });

  it('clears the selection after a successful save', async () => {
    await render(<OutfitComposer />);
    await tap('a');
    await tap('b');
    await pressSave();
    await waitFor(() => expect(screen.getByTestId('outfit-count')).toHaveTextContent('0 selected'));
    expect(isSelected('a')).toBe(false);
    expect(screen.queryByTestId('item-selection-a')).toBeNull();
    expect(saveDisabled()).toBe(true);
  });

  it('clears the name field after a successful save', async () => {
    // The next outfit is a different outfit. Leaving "Beach day" in the field
    // would make it the default name of whatever is composed next.
    await render(<OutfitComposer />);
    await tap('a');
    await typeName('Beach day');
    await pressSave();
    await waitFor(() => expect(screen.getByTestId('outfit-name').props.value).toBe(''));
  });

  it('confirms the save using the outfit the server recorded', async () => {
    // Read from the RESPONSE, not from the selection that was just cleared:
    // `itemCount` and `coverUrl` are what `POST /outfits` actually stored.
    // Both live on `PublicOutfit` — the light create shape — and `coverUrl`
    // in particular does NOT exist on `PublicOutfitDetail`, which is the trap
    // Task 3 handed over.
    mockedCreateOutfit.mockResolvedValue(
      created({ name: 'Beach day', itemCount: 2, coverUrl: 'https://example.test/cover/beach.jpg' }),
    );
    await render(<OutfitComposer />);
    await tap('a');
    await tap('b');
    await pressSave();
    await waitFor(() => expect(screen.getByTestId('outfit-saved')).toBeTruthy());
    expect(screen.getByTestId('outfit-saved')).toHaveTextContent(/Beach day/);
    expect(screen.getByTestId('outfit-saved')).toHaveTextContent(/2 items/);
    const source = screen.getByTestId('outfit-saved-cover').props.source as { uri?: string } | { uri?: string }[];
    expect(Array.isArray(source) ? source[0]?.uri : source?.uri).toBe('https://example.test/cover/beach.jpg');
  });

  it('confirms an unnamed save without inventing a name', async () => {
    mockedCreateOutfit.mockResolvedValue(created({ itemCount: 1 }));
    await render(<OutfitComposer />);
    await tap('a');
    await pressSave();
    await waitFor(() => expect(screen.getByTestId('outfit-saved')).toBeTruthy());
    expect(screen.getByTestId('outfit-saved')).toHaveTextContent(/1 item/);
    expect(screen.getByTestId('outfit-saved')).not.toHaveTextContent(/undefined/);
  });

  it('renders no cover when the server could not resolve one', async () => {
    // `coverUrl` is optional on purpose: it is absent when the first item no
    // longer resolves, which is a degraded gallery cell and not an error.
    const withoutCover = created();
    delete withoutCover.coverUrl;
    mockedCreateOutfit.mockResolvedValue(withoutCover);
    await render(<OutfitComposer />);
    await tap('a');
    await pressSave();
    await waitFor(() => expect(screen.getByTestId('outfit-saved')).toBeTruthy());
    expect(screen.queryByTestId('outfit-saved-cover')).toBeNull();
  });

  it('reports the created outfit through onSaved', async () => {
    const outfit = created({ name: 'Beach day' });
    mockedCreateOutfit.mockResolvedValue(outfit);
    const onSaved = jest.fn();
    await render(<OutfitComposer onSaved={onSaved} />);
    await tap('a');
    await pressSave();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(onSaved).toHaveBeenCalledWith(outfit);
  });

  it('keeps the selection and shows an error when the save fails', async () => {
    // Losing a nine-item selection to a flaky network is the worst possible
    // failure on this screen.
    mockedCreateOutfit.mockRejectedValue(
      new ApiClientError('NETWORK', 'Cannot reach the server. Check your connection.'),
    );
    await render(<OutfitComposer />);
    await tap('a');
    await tap('b');
    await pressSave();

    await waitFor(() =>
      expect(screen.getByTestId('outfit-save-error')).toHaveTextContent(
        'Cannot reach the server. Check your connection.',
      ),
    );
    expect(screen.getByTestId('outfit-count')).toHaveTextContent('2 selected');
    expect(screen.getByTestId('item-selection-a')).toHaveTextContent('1');
    expect(screen.getByTestId('item-selection-b')).toHaveTextContent('2');
    // Retryable: the save button is the retry, so it must not be left disabled.
    expect(saveDisabled()).not.toBe(true);
    expect(screen.queryByTestId('outfit-saved')).toBeNull();
  });

  it('describes a non-API failure in words rather than leaking one', async () => {
    mockedCreateOutfit.mockRejectedValue(new TypeError('undefined is not a function'));
    await render(<OutfitComposer />);
    await tap('a');
    await pressSave();
    await waitFor(() => expect(screen.getByTestId('outfit-save-error')).toBeTruthy());
    expect(screen.getByTestId('outfit-save-error')).not.toHaveTextContent(/undefined is not a function/);
  });

  it('saves the same selection on a retry after a failure, and clears the error', async () => {
    mockedCreateOutfit.mockRejectedValueOnce(new ApiClientError('NETWORK', 'Cannot reach the server.'));
    mockedCreateOutfit.mockResolvedValueOnce(created());
    await render(<OutfitComposer />);
    await tap('a');
    await tap('b');
    await pressSave();
    await waitFor(() => expect(screen.getByTestId('outfit-save-error')).toBeTruthy());

    await pressSave();

    await waitFor(() => expect(screen.queryByTestId('outfit-save-error')).toBeNull());
    expect(callArg(1).itemIds).toEqual(['a', 'b']);
    expect(screen.getByTestId('outfit-count')).toHaveTextContent('0 selected');
  });

  it('disables the save button while a save is in flight', async () => {
    let settle: ((outfit: PublicOutfit) => void) | undefined;
    mockedCreateOutfit.mockImplementation(
      () =>
        new Promise<PublicOutfit>((resolve) => {
          settle = resolve;
        }),
    );
    await render(<OutfitComposer />);
    await tap('a');
    await pressSave();
    expect(saveDisabled()).toBe(true);

    await act(async () => {
      settle?.(created());
    });
    await waitFor(() => expect(screen.getByTestId('outfit-count')).toHaveTextContent('0 selected'));
  });

  it('ignores a second press that lands before the button can disable itself', async () => {
    // The realistic double tap, and the one neither the disabled button nor a
    // `saving` STATE flag can stop. Both presses are fired inside a single
    // `act`, so React has not re-rendered between them: the button's
    // `disabled` prop is still false, and the `onSave` closure the second
    // press invokes is the same one the first did, still holding
    // `saving === false`. Only a ref — written synchronously, read
    // synchronously — is true by the time the second press reads it.
    //
    // This is the same reasoning `useWardrobe` states for `inFlightRef`:
    // "Refs, not state: both are read and written inside one synchronous
    // burst, where a state value would still be the stale one from the last
    // commit."
    //
    // Found by mutation, not by design: with the guard written against state,
    // removing EITHER half left all 33 tests green, because `pressSave()`
    // flushes React between presses and the two halves cover for each other.
    let settle: ((outfit: PublicOutfit) => void) | undefined;
    mockedCreateOutfit.mockImplementation(
      () =>
        new Promise<PublicOutfit>((resolve) => {
          settle = resolve;
        }),
    );
    await render(<OutfitComposer />);
    await tap('a');

    const press = onPressOf(screen.getByTestId('outfit-save'));
    await act(async () => {
      press();
      press();
    });

    expect(mockedCreateOutfit).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle?.(created());
    });
    await waitFor(() => expect(screen.getByTestId('outfit-count')).toHaveTextContent('0 selected'));
  });

  it('does not issue a second POST while the first is still in flight', async () => {
    // A double-tapped save button would otherwise create the same outfit
    // twice, and nothing downstream de-duplicates it.
    let settle: ((outfit: PublicOutfit) => void) | undefined;
    mockedCreateOutfit.mockImplementation(
      () =>
        new Promise<PublicOutfit>((resolve) => {
          settle = resolve;
        }),
    );
    await render(<OutfitComposer />);
    await tap('a');
    await pressSave();
    await pressSave();
    expect(mockedCreateOutfit).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle?.(created());
    });
    await waitFor(() => expect(screen.getByTestId('outfit-count')).toHaveTextContent('0 selected'));
  });

  it('saves a second outfit after the first', async () => {
    // The screen's whole purpose is composing outfit after outfit, and every
    // other save test stops at one. Anything that latches on the first save —
    // an in-flight ref reset only on the success path, a `saved` banner that
    // blocks the next compose — is invisible until the second one.
    mockedCreateOutfit.mockResolvedValueOnce(created({ id: 'outfit-1', itemCount: 2 }));
    mockedCreateOutfit.mockResolvedValueOnce(created({ id: 'outfit-2', itemCount: 1 }));
    await render(<OutfitComposer />);
    await tap('a');
    await tap('b');
    await pressSave();
    await waitFor(() => expect(screen.getByTestId('outfit-count')).toHaveTextContent('0 selected'));

    await tap('c');
    await pressSave();

    expect(mockedCreateOutfit).toHaveBeenCalledTimes(2);
    expect(callArg(1).itemIds).toEqual(['c']);
    await waitFor(() => expect(screen.getByTestId('outfit-saved')).toHaveTextContent(/1 item\./));
  });

  it('saves a second outfit after one that failed', async () => {
    mockedCreateOutfit.mockRejectedValueOnce(new ApiClientError('NETWORK', 'Cannot reach the server.'));
    mockedCreateOutfit.mockResolvedValueOnce(created({ itemCount: 1 }));
    await render(<OutfitComposer />);
    await tap('a');
    await pressSave();
    await waitFor(() => expect(screen.getByTestId('outfit-save-error')).toBeTruthy());

    // Not a retry of the same outfit — a different one, composed after the
    // failure. The failed save must not have latched the in-flight guard.
    await tap('a');
    await tap('c');
    await pressSave();

    expect(mockedCreateOutfit).toHaveBeenCalledTimes(2);
    expect(callArg(1).itemIds).toEqual(['c']);
  });

  it('puts a reselected item back at the end, not at the position it used to hold', async () => {
    // Which of the two is "correct" is a judgement, and this is the one that
    // ships: the array IS the order, and re-tapping an item is choosing it
    // now. An implementation that restored the old position would pass every
    // other test in this file while posting a different outfit.
    await render(<OutfitComposer />);
    await tap('a');
    await tap('b');
    await tap('c');
    await tap('a');

    expect(screen.getByTestId('item-selection-b')).toHaveTextContent('1');
    expect(screen.getByTestId('item-selection-c')).toHaveTextContent('2');

    await tap('a');

    expect(screen.getByTestId('item-selection-a')).toHaveTextContent('3');
    await pressSave();
    expect(callArg().itemIds).toEqual(['b', 'c', 'a']);
  });

  it('deselects the last item without disturbing the ones before it', async () => {
    // The middle deselect is the interesting case and has its own test; the
    // ends are where an off-by-one lives.
    await render(<OutfitComposer />);
    await tap('a');
    await tap('b');
    await tap('c');
    await tap('c');

    expect(screen.getByTestId('item-selection-a')).toHaveTextContent('1');
    expect(screen.getByTestId('item-selection-b')).toHaveTextContent('2');
    expect(screen.queryByTestId('item-selection-c')).toBeNull();
    await pressSave();
    expect(callArg().itemIds).toEqual(['a', 'b']);
  });

  it('goes back to nothing selected when every item is deselected', async () => {
    await render(<OutfitComposer />);
    await tap('a');
    await tap('b');
    await tap('b');
    await tap('a');

    expect(screen.getByTestId('outfit-count')).toHaveTextContent('0 selected');
    expect(saveDisabled()).toBe(true);
    expect(screen.queryByTestId('item-selection-a')).toBeNull();
    expect(screen.queryByTestId('item-selection-b')).toBeNull();
  });

  it('keeps a selection made while a save is in flight, and posts only what was sent', async () => {
    // The tiles stay tappable during a save, so this is reachable by anyone
    // who keeps composing while the spinner turns. Clearing the WHOLE
    // selection on success would throw away a choice the user made for the
    // next outfit — a selection lost without the user removing it, which is
    // the thing this screen is supposed to never do.
    let settle: ((outfit: PublicOutfit) => void) | undefined;
    mockedCreateOutfit.mockImplementation(
      () =>
        new Promise<PublicOutfit>((resolve) => {
          settle = resolve;
        }),
    );
    await render(<OutfitComposer />);
    await tap('a');
    await pressSave();

    await tap('c');
    expect(screen.getByTestId('outfit-count')).toHaveTextContent('2 selected');

    await act(async () => {
      settle?.(created({ itemCount: 1 }));
    });
    await waitFor(() => expect(screen.getByTestId('outfit-saved')).toBeTruthy());

    // `a` went, `a` is gone. `c` never went, and is still here — renumbered
    // to 1, because it is now the first item of the next outfit.
    expect(callArg().itemIds).toEqual(['a']);
    expect(screen.getByTestId('outfit-count')).toHaveTextContent('1 selected');
    expect(isSelected('a')).toBe(false);
    expect(screen.getByTestId('item-selection-c')).toHaveTextContent('1');
  });

  it('keeps a name typed while a save is in flight', async () => {
    let settle: ((outfit: PublicOutfit) => void) | undefined;
    mockedCreateOutfit.mockImplementation(
      () =>
        new Promise<PublicOutfit>((resolve) => {
          settle = resolve;
        }),
    );
    await render(<OutfitComposer />);
    await tap('a');
    await typeName('Monday');
    await pressSave();

    await typeName('Tuesday');
    await act(async () => {
      settle?.(created());
    });
    await waitFor(() => expect(screen.getByTestId('outfit-saved')).toBeTruthy());

    expect(callArg().name).toBe('Monday');
    expect(screen.getByTestId('outfit-name').props.value).toBe('Tuesday');
  });

  it('reports the save as in flight so the host can hold the screen still', async () => {
    // The composer cannot stop itself being unmounted mid-save; only its host
    // can, and the Add tab's own busy flag knows nothing about this one.
    let settle: ((outfit: PublicOutfit) => void) | undefined;
    mockedCreateOutfit.mockImplementation(
      () =>
        new Promise<PublicOutfit>((resolve) => {
          settle = resolve;
        }),
    );
    const onSavingChange = jest.fn();
    await render(<OutfitComposer onSavingChange={onSavingChange} />);
    await tap('a');
    await pressSave();
    expect(onSavingChange).toHaveBeenLastCalledWith(true);

    await act(async () => {
      settle?.(created());
    });
    expect(onSavingChange).toHaveBeenLastCalledWith(false);
  });

  it('reports the save as settled even when it fails', async () => {
    // A host left holding `true` forever would disable its own controls for
    // the rest of the session.
    mockedCreateOutfit.mockRejectedValue(new ApiClientError('NETWORK', 'Cannot reach the server.'));
    const onSavingChange = jest.fn();
    await render(<OutfitComposer onSavingChange={onSavingChange} />);
    await tap('a');
    await pressSave();
    await waitFor(() => expect(screen.getByTestId('outfit-save-error')).toBeTruthy());
    expect(onSavingChange).toHaveBeenLastCalledWith(false);
  });

  it('keeps the category filter usable while composing', async () => {
    // Composing an outfit IS picking a top, then trousers, then shoes.
    const setCategory = jest.fn();
    showing({ setCategory });
    await render(<OutfitComposer />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('filter-shoes'));
    });
    expect(setCategory).toHaveBeenCalledWith('shoes');
  });

  it('keeps items selected after the filter changes what is on screen', async () => {
    // The whole point of leaving the filter in. The selection is the
    // composer's own state and must survive the list being replaced under it —
    // otherwise filtering to `shoes` silently discards the top already chosen.
    mockedUseWardrobe.mockReturnValue(wardrobe({ items: [A, B] }));
    const view = await render(<OutfitComposer />);
    await tap('a');

    mockedUseWardrobe.mockReturnValue(wardrobe({ items: [C], category: 'shoes' }));
    await act(async () => {
      view.rerender(<OutfitComposer />);
    });

    expect(screen.queryByTestId('item-tile-a')).toBeNull();
    expect(screen.getByTestId('outfit-count')).toHaveTextContent('1 selected');
    // The count is a number; this is the cell. The tile that took `a`'s place
    // is a different garment and must carry no mark of the selection that
    // survived — which is what fails if the selection is keyed by POSITION
    // rather than by id, since `c` now occupies the index `a` did.
    expect(isSelected('c')).toBe(false);
    expect(screen.queryByTestId('item-selection-c')).toBeNull();
    await tap('c');
    await pressSave();
    expect(callArg().itemIds).toEqual(['a', 'c']);
  });

  it('refuses to select more items than the API accepts', async () => {
    // 1..20 is the API's bound, and `MAX_OUTFIT_ITEMS` here is literally the
    // constant `apps/api/src/routes/outfits.ts` builds `itemIdsSchema` from.
    // A 21st id is a 400 that no retry can fix, and this screen's whole error
    // contract is "the save is retryable" — so the refusal happens here, with
    // the reason on screen, rather than a round trip later.
    const many = Array.from({ length: MAX_OUTFIT_ITEMS + 1 }, (_, index) => item(`many-${index}`));
    mockedUseWardrobe.mockReturnValue(wardrobe({ items: many }));
    await render(<OutfitComposer />);
    for (const one of many) await tap(one.id);

    expect(screen.getByTestId('outfit-count')).toHaveTextContent(`${MAX_OUTFIT_ITEMS} selected`);
    expect(screen.getByTestId('outfit-limit')).toBeTruthy();
    expect(screen.queryByTestId(`item-selection-many-${MAX_OUTFIT_ITEMS}`)).toBeNull();

    await pressSave();
    expect((callArg().itemIds as string[]).length).toBe(MAX_OUTFIT_ITEMS);
  });

  it('says nothing about the limit until it is reached', async () => {
    await render(<OutfitComposer />);
    await tap('a');
    expect(screen.queryByTestId('outfit-limit')).toBeNull();
  });

  it('caps the name field at the length the API accepts', async () => {
    // Asserted against the SHARED constant, which is the same object the
    // route's `nameSchema` is built from — so this cannot pass against a
    // composer that has drifted from the API. Same reasoning as the item cap:
    // an 81-character name is an unretryable 400.
    await render(<OutfitComposer />);
    expect(screen.getByTestId('outfit-name').props.maxLength).toBe(MAX_OUTFIT_NAME_LENGTH);
  });

  it('shows the wardrobe load failure and retries through refresh', async () => {
    // Inherited from `useWardrobe` rather than re-derived — but the composer
    // still has to RENDER it, or a failed load leaves an empty grid with no
    // explanation and nothing to press.
    const refresh = jest.fn();
    mockedUseWardrobe.mockReturnValue(
      wardrobe({ items: [], error: 'Cannot reach the server.', refresh }),
    );
    await render(<OutfitComposer />);
    expect(screen.getByTestId('composer-wardrobe-error-message')).toHaveTextContent('Cannot reach the server.');
    await act(async () => {
      fireEvent.press(screen.getByTestId('composer-wardrobe-retry'));
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps the wardrobe error and the save error apart', async () => {
    // Two independent operations, two channels. One field would let a page
    // load erase a save failure the user still needs to see.
    mockedCreateOutfit.mockRejectedValue(new ApiClientError('NETWORK', 'Save failed.'));
    showing({ error: 'Load failed.' });
    await render(<OutfitComposer />);
    await tap('a');
    await pressSave();
    await waitFor(() => expect(screen.getByTestId('outfit-save-error')).toHaveTextContent('Save failed.'));
    expect(screen.getByTestId('composer-wardrobe-error-message')).toHaveTextContent('Load failed.');
  });

  it('shows a spinner instead of a grid while the first page loads', async () => {
    mockedUseWardrobe.mockReturnValue(wardrobe({ items: [], activity: 'loading' }));
    await render(<OutfitComposer />);
    expect(screen.getByTestId('composer-loading')).toBeTruthy();
    expect(screen.queryByTestId('composer-grid')).toBeNull();
  });

  it('keeps the rows on screen during a refresh', async () => {
    // A refresh is not a filter change: `activity === 'refreshing'` means the
    // previous rows are still valid, so blanking the grid would throw away a
    // selection the user can no longer see.
    showing({ activity: 'refreshing' });
    await render(<OutfitComposer />);
    expect(screen.getByTestId('item-tile-a')).toBeTruthy();
    expect(screen.queryByTestId('composer-loading')).toBeNull();
  });

  it('explains an empty wardrobe rather than showing a blank grid', async () => {
    mockedUseWardrobe.mockReturnValue(wardrobe({ items: [], activity: 'idle' }));
    await render(<OutfitComposer />);
    expect(screen.getByTestId('composer-empty')).toBeTruthy();
  });

  it('does not call an empty wardrobe empty when the load failed', async () => {
    mockedUseWardrobe.mockReturnValue(wardrobe({ items: [], activity: 'idle', error: 'Cannot reach the server.' }));
    await render(<OutfitComposer />);
    expect(screen.queryByTestId('composer-empty')).toBeNull();
  });

  it('keys the grid by item id, never by position', async () => {
    // Index keys survive every other test in this file, and the defect they
    // ship is worse here than on the wardrobe grid. `FlatList` keys each cell
    // WITHIN a row by its column index, so this extractor only sets the ROW
    // key, and a pure page append reconciles identically either way. It bites
    // on REPLACEMENT — a category change or a refresh swapping `items`
    // wholesale while the rows stay mounted — where React would reuse the
    // cell, and the image already mounted in it, for a different garment: the
    // selection ring and the ordinal disc left drawn over a garment that is
    // not in the outfit.
    //
    // `__tests__/outfits/OutfitComposer.keys.test.tsx` catches the same defect
    // through public queries only; this pins the mechanism directly.
    await render(<OutfitComposer />);
    const keyExtractor = flatListProps(screen.getByTestId('composer-grid')) as {
      keyExtractor: (item: PublicClothingItem, index: number) => string;
    };
    // The index is deliberately WRONG for the item, so an extractor that
    // returns anything positional cannot pass.
    expect(keyExtractor.keyExtractor(A, 7)).toBe('a');
    expect(keyExtractor.keyExtractor(C, 0)).toBe('c');
  });

  it('reads the selection through extraData, so cells are not memoised stale', async () => {
    // `VirtualizedList` memoises cells against `data` and `extraData`. The
    // ring and the ordinal depend on neither the row's data nor its index, so
    // without `extraData` a memoised cell keeps the mark it last drew.
    //
    // The PROP is what this asserts. The EFFECT — that a real
    // `VirtualizedList` re-renders those cells — is device-only, because this
    // renderer re-renders the whole tree on every state change and cell
    // memoisation never bites. Task 6 looks at that half.
    await render(<OutfitComposer />);
    expect(flatListProps(screen.getByTestId('composer-grid')).extraData).toBeInstanceOf(Map);
    expect([...(flatListProps(screen.getByTestId('composer-grid')).extraData as Map<string, number>)]).toEqual([]);

    await tap('b');

    // Tracks the selection, rather than merely being some constant object.
    expect([...(flatListProps(screen.getByTestId('composer-grid')).extraData as Map<string, number>)]).toEqual([
      ['b', 1],
    ]);
  });

  /**
   * Stage 6 Task 4 — the composer must NOT hide items that are in the wash.
   *
   * Wearing something that is in the laundry is a real choice a user may make
   * deliberately: it is their wardrobe, and "in laundry" is a note about
   * where a garment is, not a lock on it. Filtering these out would make items
   * vanish from the grid with no explanation and no way to get them back —
   * the user would have to guess that the toggle two screens away is what
   * emptied their wardrobe. The treatment on the tile tells them; the decision
   * stays theirs.
   *
   * The composer does no such filtering today, so this is a regression pin
   * rather than a new behaviour. It is written because the filter is the
   * obvious "helpful" change for someone to make later, and nothing else in
   * this suite would notice.
   */
  it('keeps the composer showing in-laundry items', async () => {
    const washing = { ...B, laundryStatus: 'in_laundry' as const };
    mockedUseWardrobe.mockReturnValue(wardrobe({ items: [A, washing, C] }));

    await render(<OutfitComposer />);

    expect(screen.getByTestId('item-tile-b')).toBeTruthy();
    // And it is DISTINGUISHED rather than merely present — the treatment is
    // what makes leaving it in the grid an informed choice instead of a
    // silent one.
    expect(screen.getByTestId('item-laundry-b')).toBeTruthy();
    // The others are untouched: the treatment is per item, not per grid.
    expect(screen.queryByTestId('item-laundry-a')).toBeNull();
    expect(screen.queryByTestId('item-laundry-c')).toBeNull();
  });

  it('lets an in-laundry item be selected into an outfit', async () => {
    // The other half of the same decision. A tile that renders but refuses the
    // tap is the same defect wearing a different mask.
    const washing = { ...B, laundryStatus: 'in_laundry' as const };
    mockedUseWardrobe.mockReturnValue(wardrobe({ items: [A, washing, C] }));

    await render(<OutfitComposer />);
    await tap('b');

    expect(isSelected('b')).toBe(true);
    expect(screen.getByTestId('outfit-count')).toHaveTextContent('1 selected');
  });

  /**
   * The deliberate OPPOSITE of the two in-laundry tests above, and the pair
   * has to be read together: an in-laundry garment stays selectable because
   * wearing something from the wash is a real choice the user is entitled to
   * make, while a RETIRED garment is one they have said is out of the wardrobe
   * altogether. `resolveOwnedItems` rejects it server-side too, so a tile that
   * rendered here would be a tap that 400s on save — the one error this
   * screen's "press save again" contract cannot recover from.
   */
  it('hides retired items from the composer grid', async () => {
    const retired = { ...B, retired: true };
    mockedUseWardrobe.mockReturnValue(wardrobe({ items: [A, retired, C] }));

    await render(<OutfitComposer />);

    expect(screen.queryByTestId('item-tile-b')).toBeNull();
    // The others are untouched: this is per item, not a grid that gave up.
    expect(screen.getByTestId('item-tile-a')).toBeTruthy();
    expect(screen.getByTestId('item-tile-c')).toBeTruthy();
  });

  it('cannot select a retired item, because there is no tile to tap', async () => {
    const retired = { ...B, retired: true };
    mockedUseWardrobe.mockReturnValue(wardrobe({ items: [A, retired, C] }));

    await render(<OutfitComposer />);

    expect(screen.queryByTestId('item-tile-b')).toBeNull();
    expect(screen.getByTestId('outfit-count')).toHaveTextContent('0 selected');
  });

  it('pages the wardrobe as the grid is scrolled', async () => {
    const loadMore = jest.fn();
    showing({ loadMore, hasMore: true });
    await render(<OutfitComposer />);
    await act(async () => {
      fireEvent(screen.getByTestId('composer-grid'), 'endReached');
    });
    expect(loadMore).toHaveBeenCalled();
  });

  // NOT TESTED HERE, deliberately, because RNTL renders no layout and no
  // pixels — Task 6 photographs the screen instead:
  //  * that the selected tile's border and its ordinal disc are actually
  //    visible over a photograph of a garment;
  //  * that the save bar stays reachable above the keyboard while the name
  //    field has focus;
  //  * that `extraData` really does re-render cells on a device.
  //    `VirtualizedList` memoises cells, and in this renderer every state
  //    change re-renders the whole tree anyway — so an omitted `extraData`
  //    passes every test in this file and still ships stale ordinals on a
  //    real list.
});
