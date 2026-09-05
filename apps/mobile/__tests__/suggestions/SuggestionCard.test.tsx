import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import type { ItemCategory, PublicClothingItem, PublicOutfit } from '@wardrobe/shared';
import { SuggestionCard, suggestionKeyExtractor } from '../../src/suggestions/SuggestionCard';
import type { DisplaySuggestion } from '../../src/suggestions/useSuggestions';
import { createOutfit } from '../../src/outfits/api';
import { useAuth } from '../../src/auth/AuthContext';
import { ApiClientError } from '../../src/api/client';

// This file lives in `__tests__/` and NOT under `app/`. Expo Router's Android
// require-context is recursive and excludes only `+api`/`+html`/`+middleware`,
// so any `.tsx` beneath the app root — including one inside a `__tests__/`
// subdirectory — is bundled as a route. See README.md:161.

// `createOutfit` has its own suite (`__tests__/outfits/api.test.ts`). A FACTORY
// mock, never a bare `jest.mock('../../src/api/client')`: an automocked
// `ApiClientError` is a class that cannot be constructed, so the failure tests
// below could never run. The real error class is imported above and rejected
// with.
jest.mock('../../src/outfits/api', () => ({ createOutfit: jest.fn() }));

// Only `useAuth` is mocked, not the whole module: a bare automock would also
// replace `AuthProvider`, which nothing here renders.
jest.mock('../../src/auth/AuthContext', () => ({ useAuth: jest.fn() }));

// `ItemTile` is deliberately NOT mocked. The card's claim is that it renders
// the app's real thumbnail — the one that falls back to `imageUrl`, carries the
// category badge and speaks the item to a screen reader — rather than a second
// renderer that can drift from it. A stub here would make that claim
// unfalsifiable.

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

const TOP = item('top', 'shirt');
const BOTTOM = item('bottom', 'trousers');
const SHOES = item('shoes', 'shoes');

/**
 * The shape `useSuggestions` hands a card.
 *
 * `saveItemIds` defaults to `items.map(i => i.id)` — what `toDisplaySuggestion`
 * actually derives — so every test that is not ABOUT the two diverging gets the
 * real relationship.
 */
function suggestion(overrides: Partial<DisplaySuggestion> = {}): DisplaySuggestion {
  const items = overrides.items ?? [TOP, BOTTOM, SHOES];
  return {
    items,
    saveItemIds: items.map((each) => each.id),
    score: 0.8,
    rationale: 'navy shirt and beige trousers — top with bottom, neutral pairing',
    ...overrides,
  };
}

/** What `createOutfit` resolves with: `PublicOutfit`, the LIGHT create shape. */
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
 * `fireEvent.press` cannot model a same-frame double tap: it wraps each press
 * in its own `act()`, so React re-renders between them and the second press
 * sees an already-disabled button. Two touch events dispatched in one frame do
 * not — they both call the handler instance that was on screen when the first
 * landed, which is exactly what this reproduces. (Two nested `fireEvent.press`
 * calls inside one outer `act` make React 19 log "You seem to have overlapping
 * act() calls", so that route is not available either.)
 *
 * Same helper as `__tests__/add.test.tsx` and
 * `__tests__/outfits/OutfitComposer.test.tsx`; duplicated rather than shared
 * because a `.ts` helper module under `__tests__/` is picked up by Jest's
 * default testMatch and fails as a suite with no tests.
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

/**
 * The garment thumbnails inside one card, in tree order.
 *
 * `ItemTile`'s outermost element is `item-tile-<id>`, so the returned testIDs
 * ARE the rendered order — which is the property this card exists to preserve.
 * Scoped to one card so that a test can render two of them side by side.
 */
function itemIdsIn(key: string): string[] {
  return within(screen.getByTestId(`suggestion-items-${key}`))
    .getAllByTestId(/^item-tile-/)
    .map((tile) => String(tile.props.testID).replace('item-tile-', ''));
}

/** The single argument `createOutfit` was called with, on call `n` (0-based). */
function callArg(n = 0): Record<string, unknown> {
  return mockedCreateOutfit.mock.calls[n][0] as Record<string, unknown>;
}

interface CardHandlers {
  onItemPress: jest.Mock;
  onModify: jest.Mock;
  onSaved: jest.Mock;
  onSavingChange: jest.Mock;
}

async function renderCard(
  suggestionOverride?: DisplaySuggestion,
  extra: { blocked?: boolean; onSavingChange?: jest.Mock } = {},
): Promise<CardHandlers> {
  const handlers: CardHandlers = {
    onItemPress: jest.fn(),
    onModify: jest.fn(),
    onSaved: jest.fn(),
    onSavingChange: extra.onSavingChange ?? jest.fn(),
  };
  await render(
    <SuggestionCard
      suggestion={suggestionOverride ?? suggestion()}
      {...handlers}
      blocked={extra.blocked ?? false}
    />,
  );
  return handlers;
}

async function pressSave(key: string): Promise<void> {
  await act(async () => {
    fireEvent.press(screen.getByTestId(`suggestion-save-${key}`));
  });
}

const DEFAULT_KEY = 'top-bottom-shoes';

describe('SuggestionCard', () => {
  beforeEach(() => {
    mockedUseAuth.mockReturnValue({
      status: 'authenticated',
      user: { id: 'user-1', name: 'Zaid', email: 'z@example.com', createdAt: '2026-01-01T00:00:00.000Z' },
      token: TOKEN,
      signIn: jest.fn(),
      signUp: jest.fn(),
      signOut: jest.fn(),
    });
    mockedCreateOutfit.mockResolvedValue(created());
  });

  afterEach(() => {
    // `clearAllMocks`, NOT `resetAllMocks`: the latter strips the
    // implementation off every mock in the registry, jest-expo's own setup
    // mocks included, and one of those is what registers a bundled asset. Wipe
    // it and the next `@expo/vector-icons` mount — this file renders real
    // `ItemTile`s, which carry an Ionicons badge — rejects with
    // `Module "1" is missing from the asset registry`. `beforeEach` re-states
    // every implementation this file needs, so forgetting the calls is enough.
    jest.clearAllMocks();
  });

  describe('what the card shows', () => {
    it('renders each card from ITS OWN suggestion, not from a fixed outfit', async () => {
      // Two cards in one tree on purpose. A card that ignored its prop and drew
      // something constant would satisfy either assertion alone; only the pair
      // says "this is read from the data".
      const first = suggestion();
      const second = suggestion({
        items: [item('coat', 'jacket'), item('jeans', 'trousers')],
        rationale: 'grey coat and indigo jeans — outerwear over a bottom',
      });
      await render(
        <>
          <SuggestionCard
            suggestion={first}
            onItemPress={jest.fn()}
            onModify={jest.fn()}
            onSaved={jest.fn()}
            onSavingChange={jest.fn()}
          />
          <SuggestionCard
            suggestion={second}
            onItemPress={jest.fn()}
            onModify={jest.fn()}
            onSaved={jest.fn()}
            onSavingChange={jest.fn()}
          />
        </>,
      );

      expect(itemIdsIn(DEFAULT_KEY)).toEqual(['top', 'bottom', 'shoes']);
      expect(itemIdsIn('coat-jeans')).toEqual(['coat', 'jeans']);
      expect(screen.getByTestId(`suggestion-rationale-${DEFAULT_KEY}`)).toHaveTextContent(
        'navy shirt and beige trousers — top with bottom, neutral pairing',
      );
      expect(screen.getByTestId('suggestion-rationale-coat-jeans')).toHaveTextContent(
        'grey coat and indigo jeans — outerwear over a bottom',
      );
    });

    it('renders the garments IN THE ENGINE ORDER, not reversed or re-sorted', async () => {
      // The order is the outfit: "top, trousers, shoes" reads correctly and
      // "shoes, top, trousers" does not, and it is the order `POST /outfits`
      // stores. `getAllByTestId` walks the tree depth-first, so this list IS
      // what a person sees, left to right.
      await renderCard(suggestion({ items: [SHOES, TOP, BOTTOM] }));
      expect(itemIdsIn('shoes-top-bottom')).toEqual(['shoes', 'top', 'bottom']);
    });

    it('renders the rationale, because it is the only relevance signal on screen', async () => {
      // TC-10 claims the results are "relevant for most cases". Without this
      // sentence a suggestion is indistinguishable from a random pair of
      // garments, and nothing on the card lets a person judge it.
      await renderCard(suggestion({ rationale: 'both wool — season match' }));
      expect(screen.getByTestId(`suggestion-rationale-${DEFAULT_KEY}`)).toHaveTextContent(
        'both wool — season match',
      );
    });

    it('never renders the score as a percentage, because it is an ORDINAL rank key', async () => {
      // `score` is a mean over a four-valued scale — ANALOGOUS/COMPLEMENTARY
      // 1.0, NEUTRAL 0.7, UNMATCHED 0.35, SINGLE_ITEM 0.5 — so its ORDER is
      // meaningful and its magnitude is not. Drawn as a percentage it makes
      // claims the engine refuses to make, on the same card as the text that
      // contradicts them: the floor is 0.35, so an outfit where no colour rule
      // fired at all would read "35% colour match" directly under a rationale
      // saying so.
      await renderCard(
        suggestion({ score: 0.35, rationale: 'top with bottom — no colour rule matched' }),
      );

      expect(screen.queryByTestId(`suggestion-score-${DEFAULT_KEY}`)).toBeNull();
      expect(screen.queryByText(/%/)).toBeNull();
      expect(screen.queryByText(/colour match/i)).toBeNull();
      // The honest version of what the number was reaching for is still there.
      expect(screen.getByTestId(`suggestion-rationale-${DEFAULT_KEY}`)).toHaveTextContent(
        'top with bottom — no colour rule matched',
      );
    });

    it('opens an item when its thumbnail is tapped', async () => {
      // The thumbnails are the app's real `ItemTile`, whose accessibility hint
      // says "Opens this item's details". A handler that did nothing would make
      // that hint a lie.
      const { onItemPress } = await renderCard();
      await act(async () => {
        fireEvent.press(screen.getByTestId('item-tile-bottom'));
      });
      expect(onItemPress).toHaveBeenCalledWith('bottom');
    });
  });

  describe('Save', () => {
    it('posts saveItemIds, in order, with the token and no name', async () => {
      await renderCard();
      await pressSave(DEFAULT_KEY);

      expect(mockedCreateOutfit).toHaveBeenCalledTimes(1);
      expect(callArg()).toEqual({ token: TOKEN, itemIds: ['top', 'bottom', 'shoes'] });
      // Spelled out separately: `toEqual` above would also pass with
      // `name: undefined` present, and the API's name schema trims and accepts
      // `''`, so a name sent here would save an outfit deliberately named empty
      // rather than one with no name at all.
      expect(Object.keys(callArg())).toEqual(['token', 'itemIds']);
    });

    it('posts saveItemIds and NOT a list rebuilt from `items`', async () => {
      // The two cannot diverge through `toDisplaySuggestion`, which derives one
      // FROM the other. They are made to diverge here because a fixture in
      // which they agree cannot tell which array the button read — and getting
      // that wrong is the failure `useSuggestions` withholds `itemIds` to
      // prevent: saving an outfit the user was never shown.
      await renderCard({
        items: [TOP, BOTTOM, SHOES],
        saveItemIds: ['only-this', 'and-this'],
        score: 0.5,
        rationale: 'whatever',
      });
      await pressSave('only-this-and-this');

      expect(callArg().itemIds).toEqual(['only-this', 'and-this']);
    });

    it('issues ONE request for a same-frame double tap', async () => {
      // Two touches dispatched before React can re-render both invoke the
      // `onSave` closure that was on screen when the first landed, so the
      // button's `disabled` prop and a `saving` state are both still false for
      // the second. Only the ref sees it. Without the ref this creates two
      // identical outfits and nothing downstream de-duplicates them.
      await renderCard();
      const press = onPressOf(screen.getByTestId(`suggestion-save-${DEFAULT_KEY}`));
      await act(async () => {
        press();
        press();
      });

      expect(mockedCreateOutfit).toHaveBeenCalledTimes(1);
    });

    it('guards each card separately, so one card does not swallow another card save', async () => {
      // The guard is per INSTANCE. Two proposed outfits are two different
      // writes, and a module-level or shared flag would silently drop the
      // second — a Save button that does nothing at all.
      await render(
        <>
          <SuggestionCard
            suggestion={suggestion({ items: [TOP, BOTTOM] })}
            onItemPress={jest.fn()}
            onModify={jest.fn()}
            onSaved={jest.fn()}
            onSavingChange={jest.fn()}
          />
          <SuggestionCard
            suggestion={suggestion({ items: [SHOES] })}
            onItemPress={jest.fn()}
            onModify={jest.fn()}
            onSaved={jest.fn()}
            onSavingChange={jest.fn()}
          />
        </>,
      );

      const pressFirst = onPressOf(screen.getByTestId('suggestion-save-top-bottom'));
      const pressSecond = onPressOf(screen.getByTestId('suggestion-save-shoes'));
      await act(async () => {
        pressFirst();
        pressSecond();
      });

      expect(mockedCreateOutfit).toHaveBeenCalledTimes(2);
      expect(callArg(0).itemIds).toEqual(['top', 'bottom']);
      expect(callArg(1).itemIds).toEqual(['shoes']);
    });

    it('lets a second press through after a failure — the guard is released either way', async () => {
      // Stage 6's review found a variant of this guard released only on the
      // success path: the card could never be saved again, and the test named
      // "retryable" passed because it only ever pressed once. A guard that is
      // never released is worse than no guard.
      mockedCreateOutfit.mockRejectedValueOnce(
        new ApiClientError('UNKNOWN', 'Cannot reach the server right now.', 0),
      );
      await renderCard();

      await pressSave(DEFAULT_KEY);
      expect(screen.getByTestId(`suggestion-save-error-${DEFAULT_KEY}`)).toHaveTextContent(
        'Cannot reach the server right now.',
      );

      await pressSave(DEFAULT_KEY);
      expect(mockedCreateOutfit).toHaveBeenCalledTimes(2);
    });

    it('claims nothing was saved when the save failed', async () => {
      mockedCreateOutfit.mockRejectedValueOnce(
        new ApiClientError('VALIDATION_FAILED', 'Pick at least one item', 400),
      );
      const { onSaved } = await renderCard();

      await pressSave(DEFAULT_KEY);

      expect(screen.queryByTestId(`suggestion-saved-${DEFAULT_KEY}`)).toBeNull();
      expect(onSaved).not.toHaveBeenCalled();
      expect(screen.getByTestId(`suggestion-save-error-${DEFAULT_KEY}`)).toHaveTextContent(
        'Pick at least one item',
      );
    });

    it('reports the outfit the server actually created', async () => {
      const outfit = created({ id: 'outfit-9' });
      mockedCreateOutfit.mockResolvedValue(outfit);
      const { onSaved } = await renderCard();

      await pressSave(DEFAULT_KEY);

      expect(onSaved).toHaveBeenCalledWith(outfit);
      expect(screen.getByTestId(`suggestion-saved-${DEFAULT_KEY}`)).toBeTruthy();
    });

    it('reports the save starting and settling, so the host can lock its mode row', async () => {
      let resolveSave!: (outfit: PublicOutfit) => void;
      mockedCreateOutfit.mockReturnValue(
        new Promise<PublicOutfit>((resolve) => {
          resolveSave = resolve;
        }),
      );
      const { onSavingChange } = await renderCard();

      const pressed = fireEvent.press(screen.getByTestId(`suggestion-save-${DEFAULT_KEY}`));
      await waitFor(() => expect(mockedCreateOutfit).toHaveBeenCalledTimes(1));
      expect(onSavingChange).toHaveBeenCalledWith(true);
      expect(onSavingChange).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveSave(created());
        await pressed;
      });
      expect(onSavingChange).toHaveBeenLastCalledWith(false);
      expect(onSavingChange).toHaveBeenCalledTimes(2);
    });

    it('reports the save settling even when it failed', async () => {
      // The `finally` half. Without it the host's mode row stays disabled for
      // the rest of the session after one flaky request.
      mockedCreateOutfit.mockRejectedValueOnce(
        new ApiClientError('UNKNOWN', 'Cannot reach the server right now.', 0),
      );
      const { onSavingChange } = await renderCard();

      await pressSave(DEFAULT_KEY);

      expect(onSavingChange).toHaveBeenLastCalledWith(false);
    });

    it('refuses to post an EMPTY outfit, which the API answers with an unretryable 400', async () => {
      // A suggestion whose garments all failed to resolve. `SuggestionsPane`
      // drops it before a card is ever made, and this is the second line of
      // that defence for any other host: `POST /outfits` rejects `itemIds: []`
      // with a 400, and this card's whole error contract is "the button IS the
      // retry" — which has no answer at all for an error that repeats forever.
      await renderCard({ items: [], saveItemIds: [], score: 0.5, rationale: 'nothing resolved' });

      expect(screen.getByTestId('suggestion-save-').props.accessibilityState?.disabled).toBe(true);
      await pressSave('');
      expect(mockedCreateOutfit).not.toHaveBeenCalled();
    });

    it('releases the guard when the HOST onSavingChange throws', async () => {
      // `onSavingChange` is a prop, and it is called from inside the `try` for
      // this reason: called between taking the ref and entering it, a throwing
      // host handler would leave `savingRef` set for the life of the card — and
      // that ref gates Save AND Modify, so one bad render turns the card into
      // two dead buttons with no message anywhere.
      const onSavingChange = jest.fn().mockImplementationOnce(() => {
        throw new Error('the host blew up');
      });
      await renderCard(undefined, { onSavingChange });

      await pressSave(DEFAULT_KEY);
      expect(mockedCreateOutfit).not.toHaveBeenCalled();
      expect(screen.getByTestId(`suggestion-save-error-${DEFAULT_KEY}`)).toBeTruthy();

      // The retry the contract promises still works.
      await pressSave(DEFAULT_KEY);
      expect(mockedCreateOutfit).toHaveBeenCalledTimes(1);
    });

    it('refuses a deliberate second save once the outfit exists', async () => {
      // The ref stops the same-frame double tap; this stops the considered one.
      // A second press would create a second identical outfit that the user
      // then has to go and delete.
      await renderCard();
      await pressSave(DEFAULT_KEY);

      expect(
        screen.getByTestId(`suggestion-save-${DEFAULT_KEY}`).props.accessibilityState?.disabled,
      ).toBe(true);

      await pressSave(DEFAULT_KEY);
      expect(mockedCreateOutfit).toHaveBeenCalledTimes(1);
    });
  });

  describe('Modify', () => {
    it('hands the composer the DISPLAYED ids, in order', async () => {
      const { onModify } = await renderCard();
      await act(async () => {
        fireEvent.press(screen.getByTestId(`suggestion-modify-${DEFAULT_KEY}`));
      });
      expect(onModify).toHaveBeenCalledWith(['top', 'bottom', 'shoes']);
    });

    it('hands over saveItemIds and NOT a list rebuilt from `items`', async () => {
      // The same divergent fixture the Save path uses, and for the same reason:
      // the composer must open holding the outfit that was DISPLAYED. Rebuilding
      // the ids from anywhere else is how a user ends up editing garments they
      // were never shown, and a fixture where the two agree cannot see it.
      const { onModify } = await renderCard({
        items: [TOP, BOTTOM, SHOES],
        saveItemIds: ['only-this', 'and-this'],
        score: 0.5,
        rationale: 'whatever',
      });
      await act(async () => {
        fireEvent.press(screen.getByTestId('suggestion-modify-only-this-and-this'));
      });
      expect(onModify).toHaveBeenCalledWith(['only-this', 'and-this']);
    });

    it('is refused while ANOTHER card is saving, which this card ref cannot see', async () => {
      // The cross-card hole. `savingRef` is per INSTANCE, so a save on card 1
      // is invisible to card 2 — and Modify unmounts the whole shortlist, so
      // card 1's `POST` would complete with the user in the composer, no
      // confirmation anywhere and the outfit gallery marked stale behind their
      // back. `blocked` is the host's `savingSuggestions > 0`, the same bit its
      // mode chips read.
      //
      // Asserted through the CAPTURED HANDLER, not `fireEvent.press`. The two
      // defences here render together — `disabled` and the `blocked` the
      // handler closes over are set on the same render — so a press cannot tell
      // them apart, and a press-based assertion here passes on the `disabled`
      // prop alone while the guard itself is gone. (Measured: with the guard
      // removed and only `disabled` left, the press version of this test
      // SURVIVED the whole suite.) The handler is the half that has to hold
      // regardless of what a later edit does to the button's styling props.
      const { onModify } = await renderCard(undefined, { blocked: true });
      const modify = onPressOf(screen.getByTestId(`suggestion-modify-${DEFAULT_KEY}`));

      await act(async () => {
        modify();
      });
      expect(onModify).not.toHaveBeenCalled();

      // And it SAYS so, rather than being a silent dead control — MIN-4's half.
      expect(
        screen.getByTestId(`suggestion-modify-${DEFAULT_KEY}`).props.accessibilityState?.disabled,
      ).toBe(true);
    });

    it('is live again once no card is saving', async () => {
      // The other half: a refusal that outlived the save would be a dead
      // button, which is the failure mode this project has already paid for.
      const { onModify } = await renderCard(undefined, { blocked: false });
      const modify = onPressOf(screen.getByTestId(`suggestion-modify-${DEFAULT_KEY}`));
      await act(async () => {
        modify();
      });
      expect(onModify).toHaveBeenCalledWith(['top', 'bottom', 'shoes']);
      expect(
        screen.getByTestId(`suggestion-modify-${DEFAULT_KEY}`).props.accessibilityState?.disabled,
      ).toBe(false);
    });

    it('is disabled, not merely inert, while THIS card is saving', async () => {
      // MIN-4: the ref is the guard, but a guard the user cannot see is
      // indistinguishable from a broken button.
      let resolveSave!: (outfit: PublicOutfit) => void;
      mockedCreateOutfit.mockReturnValue(
        new Promise<PublicOutfit>((resolve) => {
          resolveSave = resolve;
        }),
      );
      await renderCard();

      const pressed = fireEvent.press(screen.getByTestId(`suggestion-save-${DEFAULT_KEY}`));
      await waitFor(() => expect(mockedCreateOutfit).toHaveBeenCalledTimes(1));
      expect(
        screen.getByTestId(`suggestion-modify-${DEFAULT_KEY}`).props.accessibilityState?.disabled,
      ).toBe(true);

      await act(async () => {
        resolveSave(created());
        await pressed;
      });
      expect(
        screen.getByTestId(`suggestion-modify-${DEFAULT_KEY}`).props.accessibilityState?.disabled,
      ).toBe(false);
    });

    it('is refused while this card has a save in flight, and allowed again after', async () => {
      // Modify switches the Add tab to the composer, which unmounts this card.
      // A Modify landing in the same frame as a Save would complete the POST
      // with the card gone and the user told nothing — which is exactly why the
      // mode chips are disabled during a save. This is the other way out, and a
      // `disabled` prop would not close it: two presses in one frame both see
      // the props that were on screen when the first landed.
      let resolveSave!: (outfit: PublicOutfit) => void;
      mockedCreateOutfit.mockReturnValue(
        new Promise<PublicOutfit>((resolve) => {
          resolveSave = resolve;
        }),
      );
      const { onModify } = await renderCard();

      const save = onPressOf(screen.getByTestId(`suggestion-save-${DEFAULT_KEY}`));
      const modify = onPressOf(screen.getByTestId(`suggestion-modify-${DEFAULT_KEY}`));
      await act(async () => {
        save();
        modify();
      });

      expect(onModify).not.toHaveBeenCalled();

      await act(async () => {
        resolveSave(created());
      });
      // Released afterwards — a refusal that outlived the save would be a dead
      // button, which is the failure mode this project has already paid for on
      // the composer's own guard.
      await act(async () => {
        fireEvent.press(screen.getByTestId(`suggestion-modify-${DEFAULT_KEY}`));
      });
      expect(onModify).toHaveBeenCalledWith(['top', 'bottom', 'shoes']);
    });
  });

  describe('suggestionKeyExtractor', () => {
    it('is the suggestion ordered item set, never the index', async () => {
      expect(suggestionKeyExtractor(suggestion({ items: [TOP, BOTTOM] }))).toBe('top-bottom');
      // Order-sensitive: the same garments in a different order are a different
      // proposed outfit, and a key that collapsed them would let React reuse one
      // row's mounted thumbnails for the other.
      expect(suggestionKeyExtractor(suggestion({ items: [BOTTOM, TOP] }))).toBe('bottom-top');
    });

    it('reads the ids a Save would post, so a key can never describe another outfit', async () => {
      expect(
        suggestionKeyExtractor({
          items: [TOP, BOTTOM, SHOES],
          saveItemIds: ['only-this', 'and-this'],
          score: 0.5,
          rationale: 'whatever',
        }),
      ).toBe('only-this-and-this');
    });
  });
});
