import React from 'react';
import { FlatList } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ItemCategory, PublicClothingItem } from '@wardrobe/shared';
import AddScreen from '../../app/(tabs)/add';
import { suggestionKeyExtractor } from '../../src/suggestions/SuggestionCard';
import {
  useSuggestions,
  type DisplaySuggestion,
  type UseSuggestionsResult,
} from '../../src/suggestions/useSuggestions';
import { useAuth } from '../../src/auth/AuthContext';

// In `__tests__/` rather than under `app/` — see the note in
// `add-suggestions.test.tsx`. This file mirrors `__tests__/index.keys.test.tsx`
// and `__tests__/outfits/favorites.keys.test.tsx`, which pin the same property
// on the wardrobe grid and the outfit gallery.

jest.mock('../../src/images/capture');
jest.mock('../../src/images/compress');
jest.mock('../../src/images/thumbnail');
jest.mock('../../src/items/uploadItem');
jest.mock('../../src/suggestions/useSuggestions', () => ({ useSuggestions: jest.fn() }));
jest.mock('../../src/wardrobe/useWardrobe', () => ({ useWardrobe: jest.fn() }));
jest.mock('../../src/outfits/api', () => ({ createOutfit: jest.fn() }));
jest.mock('../../src/auth/AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('expo-router', () => ({ useRouter: jest.fn() }));

/**
 * The card is replaced by a probe that records, in a ref, the key it was
 * **first** rendered with, and renders that recorded key as text under a testID
 * keyed by its **current** key. A row React remounts starts a fresh ref, so
 * `probe-x-y` reads "x-y". A row React reuses keeps the old one, so `probe-x-y`
 * reads "top-bottom" — the mounted-thumbnails-in-the-wrong-row defect, made
 * textual.
 *
 * `suggestionKeyExtractor` is the REAL one (`requireActual`), so the identity
 * assertion below compares the very function `add.tsx` hands the list.
 */
jest.mock('../../src/suggestions/SuggestionCard', () => {
  const actual = jest.requireActual<typeof import('../../src/suggestions/SuggestionCard')>(
    '../../src/suggestions/SuggestionCard',
  );
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    ...actual,
    SuggestionCard: ({ suggestion }: { suggestion: DisplaySuggestion }) => {
      const key = actual.suggestionKeyExtractor(suggestion);
      const firstRenderedWith = ReactActual.useRef(key);
      return ReactActual.createElement(Text, { testID: `probe-${key}` }, firstRenderedWith.current);
    },
  };
});

const mockedUseSuggestions = jest.mocked(useSuggestions);
const mockedUseAuth = useAuth as jest.Mock;

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

function suggestion(ids: string[]): DisplaySuggestion {
  const items = ids.map((id) => item(id));
  return { items, saveItemIds: ids, score: 0.7, rationale: `${ids.join(' with ')}` };
}

function showing(overrides: Partial<UseSuggestionsResult> = {}): void {
  mockedUseSuggestions.mockReturnValue({
    snapshot: { suggestions: [], laundryNotice: null, retiredNotice: null },
    unavailable: false,
    activity: 'idle',
    error: null,
    refresh: jest.fn(),
    ...overrides,
  });
}

type FiberLike = { type: unknown; memoizedProps: Record<string, unknown>; return: FiberLike | null };

/**
 * The props the `<FlatList>` above `host` was actually rendered with.
 *
 * A React key never reaches the rendered tree — `toJSON()` returns
 * `{ type, props, children }` and nothing else — so no public query can observe
 * which key the list used. `unstable_fiber` is the escape hatch `TestInstance`
 * documents for exactly this, and `__tests__/index.test.tsx` already uses it to
 * pin the wardrobe grid extractor.
 */
function flatListProps(host: ReturnType<typeof screen.getByTestId>): Record<string, unknown> {
  let fiber = host.unstable_fiber as unknown as FiberLike | null;
  while (fiber !== null) {
    if (fiber.type === FlatList) return fiber.memoizedProps;
    fiber = fiber.return;
  }
  throw new Error('No <FlatList> found above the suggestions list element');
}

async function openSuggestions(): Promise<ReturnType<typeof render>> {
  const view = await render(<AddScreen />);
  await act(async () => {
    fireEvent.press(screen.getByTestId('add-mode-suggestion'));
  });
  return view;
}

describe('suggestion list row identity', () => {
  beforeEach(() => {
    mockedUseAuth.mockReturnValue({
      status: 'authenticated',
      user: { id: 'user-1', name: 'Zaid', email: 'z@example.com', createdAt: '2026-01-01T00:00:00.000Z' },
      token: 'tok-abc',
      signIn: jest.fn(),
      signUp: jest.fn(),
      signOut: jest.fn(),
    });
    showing();
  });

  afterEach(() => {
    // See the note in `add-suggestions.test.tsx`: `resetAllMocks` strips the
    // implementation off jest-expo own setup mocks too.
    jest.clearAllMocks();
  });

  it('hands the list the id extractor itself, which returns the ordered item set', async () => {
    // Two halves, and only together are they a test.
    //
    // This half reads the extractor the list was actually handed and checks
    // what it returns. It is NOT a paging test, and a paging test could not
    // stand in for it — this endpoint has no cursor at all, so there is nothing
    // to page. The other half is the replacement below.
    showing({ snapshot: { suggestions: [suggestion(['top', 'bottom'])], laundryNotice: null, retiredNotice: null } });
    await openSuggestions();

    expect(flatListProps(screen.getByTestId('suggestions-list')).keyExtractor).toBe(
      suggestionKeyExtractor,
    );
    expect(suggestionKeyExtractor(suggestion(['a', 'b', 'c']))).toBe('a-b-c');
  });

  it('remounts a row when a refresh replaces the suggestion that was in it', async () => {
    // `refresh()` sets `activity` to `'refreshing'` and deliberately leaves the
    // shortlist on screen, then replaces it wholesale when the response lands.
    // The list stays mounted throughout, so React reconciles the old rows
    // against the new suggestions — and with an index keyExtractor the row key
    // is unchanged, so every row is reused for a different proposed outfit.
    //
    // The consequence here is worse than a wrong photograph: the Save button in
    // a reused row would post the ids of the outfit the row is no longer
    // showing.
    const before = [suggestion(['top', 'bottom']), suggestion(['coat', 'skirt'])];
    showing({ snapshot: { suggestions: before, laundryNotice: null, retiredNotice: null } });
    const view = await openSuggestions();
    expect(screen.getByTestId('probe-top-bottom')).toHaveTextContent('top-bottom');

    showing({ snapshot: { suggestions: before, laundryNotice: null, retiredNotice: null }, activity: 'refreshing' });
    await act(async () => {
      view.rerender(<AddScreen />);
    });

    const after = [suggestion(['dress', 'heels']), suggestion(['jumper', 'jeans'])];
    showing({ snapshot: { suggestions: after, laundryNotice: null, retiredNotice: null } });
    await act(async () => {
      view.rerender(<AddScreen />);
    });

    expect(screen.getByTestId('probe-dress-heels')).toHaveTextContent('dress-heels');
    expect(screen.getByTestId('probe-jumper-jeans')).toHaveTextContent('jumper-jeans');
    expect(screen.queryByTestId('probe-top-bottom')).toBeNull();
  });
});
