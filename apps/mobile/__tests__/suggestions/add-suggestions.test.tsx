import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { useRouter } from 'expo-router';
import type { ItemCategory, PublicClothingItem, PublicOutfit } from '@wardrobe/shared';
import AddScreen from '../../app/(tabs)/add';
import {
  useSuggestions,
  type DisplaySuggestion,
  type UseSuggestionsResult,
} from '../../src/suggestions/useSuggestions';
import { useWardrobe, type UseWardrobeResult } from '../../src/wardrobe/useWardrobe';
import { createOutfit } from '../../src/outfits/api';
import { useAuth } from '../../src/auth/AuthContext';
import { ApiClientError } from '../../src/api/client';
// The real signal module — a few lines of module state, no dependencies, and
// its own suite at `__tests__/outfits/outfitsDirty.test.ts`. Mocking it would
// test that a function was passed; consuming it tests that the bit moved.
import { consumeOutfitsDirty } from '../../src/outfits/outfitsDirty';

// This file lives in `__tests__/` and NOT under `app/`. Expo Router's Android
// require-context is recursive and excludes only `+api`/`+html`/`+middleware`,
// so any `.tsx` beneath the app root — including one inside a `__tests__/`
// subdirectory — is bundled as a route. See README.md:161.

// The Add tab's ITEM mode pulls in the whole capture pipeline at module load.
// Nothing here photographs anything; these keep expo-image-picker and friends
// out of a suite that is about the third mode.
jest.mock('../../src/images/capture');
jest.mock('../../src/images/compress');
jest.mock('../../src/images/thumbnail');
jest.mock('../../src/items/uploadItem');

// `useSuggestions` has its own suite (`__tests__/suggestions/useSuggestions.test.ts`).
// Mocking it at the module boundary keeps this file about what the SCREEN
// derives from that contract — and it is the only way to hold the screen in
// each of the five states the contract can produce.
jest.mock('../../src/suggestions/useSuggestions', () => ({ useSuggestions: jest.fn() }));

// The real `OutfitComposer` is used deliberately, unlike in `add.test.tsx`.
// "Modify" is a claim about what the composer OPENS HOLDING, and a stub cannot
// answer it. `useWardrobe` is mocked instead, which is what that component's
// own suites do.
jest.mock('../../src/wardrobe/useWardrobe', () => ({ useWardrobe: jest.fn() }));

jest.mock('../../src/outfits/api', () => ({ createOutfit: jest.fn() }));
jest.mock('../../src/auth/AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('expo-router', () => ({ useRouter: jest.fn() }));

const mockedUseSuggestions = jest.mocked(useSuggestions);
const mockedUseWardrobe = jest.mocked(useWardrobe);
const mockedCreateOutfit = createOutfit as jest.Mock;
const mockedUseAuth = useAuth as jest.Mock;
const mockedUseRouter = useRouter as unknown as jest.Mock;

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

const TOP = item('top', 'shirt');
const BOTTOM = item('bottom', 'trousers');
const SHOES = item('shoes', 'shoes');
const COAT = item('coat', 'jacket');
const SKIRT = item('skirt', 'skirt');

function suggestion(items: PublicClothingItem[], rationale: string): DisplaySuggestion {
  return {
    items,
    saveItemIds: items.map((each) => each.id),
    score: 0.8,
    rationale,
  };
}

const FIRST = suggestion([TOP, BOTTOM, SHOES], 'top with bottom, neutral pairing');
const SECOND = suggestion([COAT, SKIRT], 'outerwear over a bottom');

const refresh = jest.fn();
/**
 * The router the screen pushes to. Module-level so the destination itself can
 * be asserted — `useRouter` handed a fresh `jest.fn()` in `beforeEach` is a
 * router nothing ever looks at, which is how `router.push(...)` → `void id;`
 * survived a full-suite mutation run.
 */
const push = jest.fn();

/** The hook's contract, defaulted to "loaded, with two suggestions". */
function suggestions(overrides: Partial<UseSuggestionsResult> = {}): UseSuggestionsResult {
  const value: UseSuggestionsResult = {
    snapshot: { suggestions: [FIRST, SECOND], laundryNotice: null },
    unavailable: false,
    activity: 'idle',
    error: null,
    refresh,
    ...overrides,
  };
  mockedUseSuggestions.mockReturnValue(value);
  return value;
}

function wardrobe(overrides: Partial<UseWardrobeResult> = {}): UseWardrobeResult {
  return {
    items: [TOP, BOTTOM, SHOES, COAT, SKIRT],
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
    itemIds: ['top', 'bottom', 'shoes'],
    itemCount: 3,
    coverUrl: 'https://example.test/cover/top.jpg',
    createdAt: '2026-08-25T09:00:00.000Z',
    ...overrides,
  };
}

type Element = ReturnType<typeof screen.getByTestId>;
type FiberLike = { memoizedProps: Record<string, unknown>; return: FiberLike | null };

/**
 * The `onPress` handler the element was rendered with, as a callable.
 *
 * Two un-awaited `fireEvent.press` calls overlap their `act()` scopes, which
 * React 19 logs about — and this project treats a warning line as a failure.
 * Invoking the captured handlers inside one `act` is also a closer model of two
 * touches landing in the same frame. Same helper as `__tests__/add.test.tsx`;
 * duplicated rather than shared because a `.ts` helper module under
 * `__tests__/` is picked up by Jest default testMatch and fails as a suite with
 * no tests.
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

async function chooseMode(mode: 'item' | 'outfit' | 'suggestion'): Promise<void> {
  await act(async () => {
    fireEvent.press(screen.getByTestId(`add-mode-${mode}`));
  });
}

async function showSuggestions(): Promise<void> {
  await render(<AddScreen />);
  await chooseMode('suggestion');
}

/** The cards on screen, in tree order, identified by their key. */
function renderedCardKeys(): string[] {
  return screen
    .getAllByTestId(/^suggestion-card-/)
    .map((card) => String(card.props.testID).replace('suggestion-card-', ''));
}

function itemIdsIn(key: string): string[] {
  return within(screen.getByTestId(`suggestion-items-${key}`))
    .getAllByTestId(/^item-tile-/)
    .map((tile) => String(tile.props.testID).replace('item-tile-', ''));
}

function selectedCount(): string {
  return String(screen.getByTestId('outfit-count').children[0]);
}

describe('AddScreen suggestions mode (Stage 7, FR8 / TC-10)', () => {
  beforeEach(() => {
    mockedUseAuth.mockReturnValue({
      status: 'authenticated',
      user: { id: 'user-1', name: 'Zaid', email: 'z@example.com', createdAt: '2026-01-01T00:00:00.000Z' },
      token: TOKEN,
      signIn: jest.fn(),
      signUp: jest.fn(),
      signOut: jest.fn(),
    });
    mockedUseRouter.mockReturnValue({ push });
    mockedUseWardrobe.mockReturnValue(wardrobe());
    mockedCreateOutfit.mockResolvedValue(created());
    suggestions();
    // Module state, so it survives between tests in this file even though Jest
    // gives every test FILE its own registry. Drained through the public door
    // the app uses rather than a test-only reset.
    consumeOutfitsDirty();
  });

  afterEach(() => {
    // `clearAllMocks`, NOT `resetAllMocks`, and the difference is load-bearing
    // rather than stylistic. `jest.resetAllMocks()` strips the IMPLEMENTATION
    // off every mock in the registry — including the ones jest-expo's own setup
    // installs — and one of those is what registers a bundled asset. Wipe it
    // and the next `@expo/vector-icons` mount (this screen renders real
    // `ItemTile`s, which carry an Ionicons badge) rejects with
    // `Module "1" is missing from the asset registry`, failing whichever test
    // happens to be the first one that draws a garment.
    //
    // The suites that already call `resetAllMocks` escape it only because
    // their FIRST test mounts an icon, which loads the font before anything is
    // reset. That is luck, not a property of those files. `clearAllMocks`
    // forgets the calls — which is all this file needs, since `beforeEach`
    // re-states every implementation — and leaves the harness alone.
    jest.clearAllMocks();
  });

  describe('the third mode', () => {
    it('is a chip beside the other two, and is not the default', async () => {
      await render(<AddScreen />);
      expect(screen.getByTestId('add-mode-suggestion')).toBeTruthy();
      expect(screen.getByTestId('add-mode-suggestion').props.accessibilityState?.selected).toBe(
        false,
      );
      expect(screen.getByTestId('add-item-form')).toBeTruthy();
      expect(screen.queryByTestId('suggestions-list')).toBeNull();
    });

    it('does not fetch suggestions until the mode is chosen', async () => {
      // `useSuggestions` fetches on mount. Called at the top of the screen it
      // would run the caller's whole wardrobe through the rule engine, and sign
      // a URL per returned item server-side, every time somebody opened this
      // tab to photograph a shirt.
      await render(<AddScreen />);
      expect(mockedUseSuggestions).not.toHaveBeenCalled();

      await chooseMode('suggestion');
      expect(mockedUseSuggestions).toHaveBeenCalled();
    });

    it('replaces the item form rather than appending to it', async () => {
      // Both the composer and this list are `FlatList`s, and React Native logs
      // "VirtualizedLists should never be nested inside plain ScrollViews with
      // the same orientation" when one is rendered inside a `ScrollView` — a
      // failure by this project's pristine-output rule, and broken scrolling on
      // a device.
      await showSuggestions();
      expect(screen.queryByTestId('add-item-form')).toBeNull();
      expect(screen.queryByTestId('composer-grid')).toBeNull();
      expect(screen.getByTestId('suggestions-list')).toBeTruthy();
    });
  });

  describe('the states the hook can produce', () => {
    it('says it is working while the first load runs', async () => {
      suggestions({ snapshot: null, activity: 'loading' });
      await showSuggestions();

      expect(screen.getByTestId('suggestions-loading')).toBeTruthy();
      expect(screen.queryByTestId('suggestions-empty')).toBeNull();
    });

    it('shows the error, with a retry that calls refresh', async () => {
      suggestions({
        snapshot: null,
        error: 'Cannot reach the server right now.',
      });
      await showSuggestions();

      expect(screen.getByTestId('suggestions-error-message')).toHaveTextContent(
        'Cannot reach the server right now.',
      );
      await act(async () => {
        fireEvent.press(screen.getByTestId('suggestions-retry'));
      });
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('does not call an error an empty wardrobe', async () => {
      // A failed request leaves the last good snapshot alone, so without the
      // `error === null` conjunct a user whose retry just failed would be told
      // to go and add items by a screen that had learned nothing.
      suggestions({ snapshot: { suggestions: [], laundryNotice: null }, error: 'Something broke' });
      await showSuggestions();

      expect(screen.queryByTestId('suggestions-empty')).toBeNull();
      expect(screen.getByTestId('suggestions-error-message')).toBeTruthy();
    });

    it('tells the user to add items when the engine genuinely had nothing to propose', async () => {
      suggestions({ snapshot: { suggestions: [], laundryNotice: null } });
      await showSuggestions();

      const empty = screen.getByTestId('suggestions-empty');
      expect(empty).toHaveTextContent(/add a few items first/i);
      expect(screen.queryByTestId('suggestions-unavailable')).toBeNull();
    });

    it('says an OUTAGE is an outage, and never that the user has no suggestions', async () => {
      // The whole reason `GET /suggestions` answers 503 with no `suggestions`
      // key rather than an empty list. Rendering this as the empty state would
      // tell a user with a full wardrobe that none of it goes together — and
      // would make three tasks of deliberate server-side design pointless.
      suggestions({
        snapshot: null,
        unavailable: true,
        error: 'Outfit suggestions are temporarily unavailable',
      });
      await showSuggestions();

      const banner = screen.getByTestId('suggestions-unavailable-message');
      expect(banner).toHaveTextContent(/temporarily unavailable/i);
      // Not merely "the empty state is absent": the wording itself must not
      // have become the empty state's claim.
      expect(banner).not.toHaveTextContent(/no (outfit )?suggestions/i);
      expect(banner).not.toHaveTextContent(/add a few items/i);
      expect(screen.queryByTestId('suggestions-empty')).toBeNull();
      expect(screen.queryByText(/add a few items first/i)).toBeNull();
    });

    it('never renders an outage as the empty state, even with no error string', async () => {
      // `showEmptyState`'s `!unavailable` conjunct. The hook sets `unavailable`
      // and `error` in one `catch` today, so this pairing cannot arrive from
      // it — which is exactly the point: the screen must not depend on one
      // block's internals for the single sentence three tasks exist to keep off
      // it. Split that catch and, without the conjunct, an outage silently
      // becomes "add a few items first".
      suggestions({
        snapshot: { suggestions: [], laundryNotice: null },
        unavailable: true,
        error: null,
      });
      await showSuggestions();

      expect(screen.getByTestId('suggestions-unavailable')).toBeTruthy();
      expect(screen.queryByTestId('suggestions-empty')).toBeNull();
      expect(screen.queryByText(/add a few items first/i)).toBeNull();
    });

    it('keeps the last good shortlist on screen underneath an outage banner', async () => {
      // The hook leaves the snapshot alone on failure on purpose: the
      // suggestions were true a moment ago, and a blank screen throws them away
      // for a fault that has nothing to do with them.
      suggestions({
        unavailable: true,
        error: 'Outfit suggestions are temporarily unavailable',
      });
      await showSuggestions();

      expect(screen.getByTestId('suggestions-unavailable')).toBeTruthy();
      expect(renderedCardKeys()).toEqual(['top-bottom-shoes', 'coat-skirt']);
    });

    it('retries an outage through refresh', async () => {
      suggestions({
        snapshot: null,
        unavailable: true,
        error: 'Outfit suggestions are temporarily unavailable',
      });
      await showSuggestions();

      await act(async () => {
        fireEvent.press(screen.getByTestId('suggestions-retry'));
      });
      expect(refresh).toHaveBeenCalledTimes(1);
    });
  });

  describe('the laundry notice', () => {
    it('renders the hook sentence VERBATIM', async () => {
      // The count behind it is every in-laundry item in the wardrobe, NOT a
      // number of suggestions withheld — a wardrobe of one shirt plus three
      // in-laundry accessories answers an empty shortlist with
      // `excludedInLaundry: 3`, and not one of those three could have produced
      // a suggestion. So "3 suggestions were hidden" asserts a causation this
      // number does not carry, and a user would act on it by fetching laundry
      // that would change nothing.
      //
      // `toHaveTextContent` compares a string matcher by exact equality after
      // normalisation, so this fails if anything at all is wrapped around the
      // sentence.
      suggestions({
        snapshot: { suggestions: [FIRST], laundryNotice: '3 items are in the laundry' },
      });
      await showSuggestions();

      expect(screen.getByTestId('suggestions-laundry-notice')).toHaveTextContent(
        '3 items are in the laundry',
      );
      // The specific rewordings that are forbidden, named so a reviewer can see
      // which claim is being kept off the screen.
      expect(screen.queryByText(/hidden/i)).toBeNull();
      expect(screen.queryByText(/withheld/i)).toBeNull();
      expect(screen.queryByText(/left out/i)).toBeNull();
      expect(screen.queryByText(/because/i)).toBeNull();
    });

    it('renders nothing when the wardrobe has nothing in the wash', async () => {
      // `null` at zero, so the screen does not say "0 items are in the laundry"
      // — which reads as a warning about a wardrobe that has none.
      suggestions({ snapshot: { suggestions: [FIRST], laundryNotice: null } });
      await showSuggestions();

      expect(screen.queryByTestId('suggestions-laundry-notice')).toBeNull();
    });

    it('shows the notice beside an empty shortlist, which is where it earns its place', async () => {
      // A thin result gets CONTEXT rather than an explanation.
      suggestions({ snapshot: { suggestions: [], laundryNotice: '2 items are in the laundry' } });
      await showSuggestions();

      expect(screen.getByTestId('suggestions-laundry-notice')).toHaveTextContent(
        '2 items are in the laundry',
      );
      expect(screen.getByTestId('suggestions-empty')).toBeTruthy();
    });
  });

  describe('the cards', () => {
    it('renders one per suggestion, in the order the engine ranked them', async () => {
      await showSuggestions();
      expect(renderedCardKeys()).toEqual(['top-bottom-shoes', 'coat-skirt']);
      expect(itemIdsIn('top-bottom-shoes')).toEqual(['top', 'bottom', 'shoes']);
      expect(itemIdsIn('coat-skirt')).toEqual(['coat', 'skirt']);
    });

    it('spins while a refresh is running, and not otherwise', async () => {
      // `refreshing` is the whole of the pull-to-refresh feedback: `refresh()`
      // keeps the shortlist on screen and sets `activity` to `'refreshing'`, so
      // a hard-coded `false` here leaves a control that starts a request and
      // shows nothing at all — indistinguishable, to the user, from a list that
      // ignored the pull. Read off the `RefreshControl` the list actually
      // renders rather than the prop handed in, so this follows the spinner.
      suggestions({ activity: 'refreshing' });
      await showSuggestions();
      expect(screen.getByTestId('suggestions-list').props.refreshControl.props.refreshing).toBe(
        true,
      );

      suggestions({ activity: 'idle' });
      await act(async () => {
        screen.rerender(<AddScreen />);
      });
      expect(screen.getByTestId('suggestions-list').props.refreshControl.props.refreshing).toBe(
        false,
      );
    });

    it('opens the item when one of a suggestion thumbnails is tapped', async () => {
      // The thumbnails are the app's real `ItemTile`, whose accessibility hint
      // says "Opens this item's details". Asserting the card CALLS its handler
      // is not this claim — it leaves the whole route unpinned, which is how a
      // `void id;` in place of the push survived the entire suite.
      await showSuggestions();
      await act(async () => {
        fireEvent.press(screen.getByTestId('item-tile-bottom'));
      });
      expect(push).toHaveBeenCalledWith('/items/bottom');
    });

    it('does not draw a card for a suggestion whose garments all failed to resolve', async () => {
      // Zero thumbnails is not "a complete outfit card", its Save would post
      // `itemIds: []` for a 400 that pressing again cannot fix, and its key
      // would be the empty string — which two of them would collide on, loud in
      // dev and SILENT in a release build.
      suggestions({
        snapshot: {
          suggestions: [
            { items: [], saveItemIds: [], score: 0.5, rationale: 'nothing resolved' },
            { items: [], saveItemIds: [], score: 0.5, rationale: 'nothing resolved either' },
            FIRST,
          ],
          laundryNotice: null,
        },
      });
      await showSuggestions();

      expect(renderedCardKeys()).toEqual(['top-bottom-shoes']);
      expect(screen.queryByText('nothing resolved')).toBeNull();
    });

    it('pulls to refresh through the hook', async () => {
      await showSuggestions();
      await act(async () => {
        fireEvent(screen.getByTestId('suggestions-list'), 'refresh');
      });
      expect(refresh).toHaveBeenCalledTimes(1);
    });
  });

  describe('Save', () => {
    it('posts the displayed ids and tells the outfit gallery its list is stale', async () => {
      // Without the signal, an outfit saved here does not appear on the
      // Favorites tab AT ALL until the user thinks to pull to refresh — the
      // same gap the composer's save closes.
      await showSuggestions();
      expect(consumeOutfitsDirty()).toBe(false);

      await act(async () => {
        fireEvent.press(screen.getByTestId('suggestion-save-coat-skirt'));
      });

      expect(mockedCreateOutfit).toHaveBeenCalledTimes(1);
      expect((mockedCreateOutfit.mock.calls[0][0] as { itemIds: string[] }).itemIds).toEqual([
        'coat',
        'skirt',
      ]);
      expect(consumeOutfitsDirty()).toBe(true);
    });

    it('says nothing to the gallery when a save failed', async () => {
      mockedCreateOutfit.mockRejectedValueOnce(
        new ApiClientError('UNKNOWN', 'Cannot reach the server right now.', 0),
      );
      await showSuggestions();

      await act(async () => {
        fireEvent.press(screen.getByTestId('suggestion-save-coat-skirt'));
      });

      expect(consumeOutfitsDirty()).toBe(false);
    });

    it('says nothing to the gallery merely because the list was looked at', async () => {
      await showSuggestions();
      expect(consumeOutfitsDirty()).toBe(false);
    });

    it('refuses to switch modes while a suggestion save is in flight', async () => {
      // `busy` is this screen's own upload and `composerSaving` is the
      // composer's; neither knows about a card. Without the third flag,
      // switching away unmounts the card mid-`POST`: the outfit is created and
      // the user never learns whether it exists.
      let resolveSave!: (outfit: PublicOutfit) => void;
      mockedCreateOutfit.mockReturnValue(
        new Promise<PublicOutfit>((resolve) => {
          resolveSave = resolve;
        }),
      );
      await showSuggestions();

      const pressed = fireEvent.press(screen.getByTestId('suggestion-save-coat-skirt'));
      await waitFor(() => expect(mockedCreateOutfit).toHaveBeenCalledTimes(1));

      await chooseMode('item');
      expect(screen.getByTestId('suggestions-list')).toBeTruthy();
      expect(screen.queryByTestId('add-item-form')).toBeNull();

      await act(async () => {
        resolveSave(created());
        await pressed;
      });

      // And released once it settles — a mode row that never re-enabled would
      // strand the user on this tab.
      await chooseMode('item');
      expect(screen.getByTestId('add-item-form')).toBeTruthy();
    });

    it('stays locked until the LAST of two overlapping saves settles', async () => {
      // Each card guards itself, so two saves really can overlap. With a
      // boolean the first to settle would re-enable the mode row while the
      // second `POST` was still running — exactly the state the flag exists to
      // prevent, arriving through the flag instead of past it.
      let resolveFirst!: (outfit: PublicOutfit) => void;
      let resolveSecond!: (outfit: PublicOutfit) => void;
      mockedCreateOutfit
        .mockReturnValueOnce(
          new Promise<PublicOutfit>((resolve) => {
            resolveFirst = resolve;
          }),
        )
        .mockReturnValueOnce(
          new Promise<PublicOutfit>((resolve) => {
            resolveSecond = resolve;
          }),
        );
      await showSuggestions();

      // Both handlers invoked inside ONE act: two un-awaited `fireEvent.press`
      // calls make React 19 log "You seem to have overlapping act() calls",
      // which is a warning and therefore a failure by this project's
      // pristine-output rule.
      const pressFirst = onPressOf(screen.getByTestId('suggestion-save-top-bottom-shoes'));
      const pressSecond = onPressOf(screen.getByTestId('suggestion-save-coat-skirt'));
      await act(async () => {
        pressFirst();
        pressSecond();
      });
      expect(mockedCreateOutfit).toHaveBeenCalledTimes(2);

      await act(async () => {
        resolveFirst(created());
      });
      await chooseMode('item');
      expect(screen.queryByTestId('add-item-form')).toBeNull();

      await act(async () => {
        resolveSecond(created({ id: 'outfit-2' }));
      });
      await chooseMode('item');
      expect(screen.getByTestId('add-item-form')).toBeTruthy();
    });
  });

  describe('Modify', () => {
    it('is refused on ANOTHER card while a save is in flight', async () => {
      // The hole the card's own ref cannot close: `savingRef` is per instance,
      // so a save on card 1 is invisible to card 2. Modify unmounts the whole
      // pane, so without a host-level bit the composer opens, card 1's `POST`
      // completes with nobody left to report it, and `markOutfitsDirty` fires
      // with the user in a different mode and no confirmation anywhere. The
      // mode chips are already guarded on exactly this condition; this is the
      // other way out of the list.
      let resolveSave!: (outfit: PublicOutfit) => void;
      mockedCreateOutfit.mockReturnValue(
        new Promise<PublicOutfit>((resolve) => {
          resolveSave = resolve;
        }),
      );
      await showSuggestions();

      const pressed = fireEvent.press(screen.getByTestId('suggestion-save-top-bottom-shoes'));
      await waitFor(() => expect(mockedCreateOutfit).toHaveBeenCalledTimes(1));

      // A DIFFERENT card — the one whose ref knows nothing about the save.
      await act(async () => {
        fireEvent.press(screen.getByTestId('suggestion-modify-coat-skirt'));
      });
      expect(screen.queryByTestId('composer-grid')).toBeNull();
      expect(screen.getByTestId('suggestions-list')).toBeTruthy();
      expect(consumeOutfitsDirty()).toBe(false);

      await act(async () => {
        resolveSave(created());
        await pressed;
      });

      // Released with the save, or the other cards are dead for the session.
      await act(async () => {
        fireEvent.press(screen.getByTestId('suggestion-modify-coat-skirt'));
      });
      expect(screen.getByTestId('composer-grid')).toBeTruthy();
    });

    it('opens the composer holding that suggestion garments, in order', async () => {
      await showSuggestions();
      await act(async () => {
        fireEvent.press(screen.getByTestId('suggestion-modify-coat-skirt'));
      });

      expect(screen.getByTestId('composer-grid')).toBeTruthy();
      expect(screen.getByTestId('add-mode-outfit').props.accessibilityState?.selected).toBe(true);
      expect(selectedCount()).toBe('2 selected');
      expect(screen.getByTestId('item-tile-coat').props.accessibilityState?.selected).toBe(true);
      expect(screen.getByTestId('item-tile-skirt').props.accessibilityState?.selected).toBe(true);
      expect(screen.getByTestId('item-tile-top').props.accessibilityState?.selected).toBe(false);
    });

    it('applies the SECOND Modify, not the first', async () => {
      // What this test can and cannot see, stated rather than implied.
      //
      // It covers the USER-VISIBLE journey: Modify one card, go back, Modify
      // another, and the composer holds the second suggestion's garments. It
      // does NOT discriminate the composer's value-sync, and naming
      // `useState(initial)` here would claim it does. This screen's modes are
      // alternatives, so leaving suggestion mode UNMOUNTS the composer and the
      // second Modify is a fresh mount — which `useState(initial)` gets right.
      // Deleting the sync leaves this test green.
      //
      // The sync is discriminated by the composer's own suite, where the
      // component stays mounted across a prop change: `applies a SECOND
      // preselection to a composer that is already mounted` and `clears the
      // selection when the host drops the preselection entirely`. Mutating the
      // sync's condition fails those two and not this one.
      await showSuggestions();
      await act(async () => {
        fireEvent.press(screen.getByTestId('suggestion-modify-top-bottom-shoes'));
      });
      expect(selectedCount()).toBe('3 selected');

      await chooseMode('suggestion');
      await act(async () => {
        fireEvent.press(screen.getByTestId('suggestion-modify-coat-skirt'));
      });

      expect(selectedCount()).toBe('2 selected');
      expect(screen.getByTestId('item-tile-coat').props.accessibilityState?.selected).toBe(true);
      expect(screen.getByTestId('item-tile-top').props.accessibilityState?.selected).toBe(false);
    });

    it('starts a composer opened from the chip row empty, not from a stale Modify', async () => {
      // "Create outfit" from the chip row means a NEW outfit. Ids left behind
      // by an earlier Modify would silently seed it with a suggestion the user
      // has moved on from.
      await showSuggestions();
      await act(async () => {
        fireEvent.press(screen.getByTestId('suggestion-modify-coat-skirt'));
      });
      expect(selectedCount()).toBe('2 selected');

      await chooseMode('item');
      await chooseMode('outfit');
      expect(selectedCount()).toBe('0 selected');
    });

    it('saves the modified outfit, not the proposed one', async () => {
      // The end of the "or modify" half of the sentence: the user drops a
      // garment and what reaches `POST /outfits` is what is left.
      await showSuggestions();
      await act(async () => {
        fireEvent.press(screen.getByTestId('suggestion-modify-top-bottom-shoes'));
      });
      await act(async () => {
        fireEvent.press(screen.getByTestId('item-tile-bottom'));
      });
      await act(async () => {
        fireEvent.press(screen.getByTestId('outfit-save'));
      });

      expect((mockedCreateOutfit.mock.calls[0][0] as { itemIds: string[] }).itemIds).toEqual([
        'top',
        'shoes',
      ]);
    });
  });
});
