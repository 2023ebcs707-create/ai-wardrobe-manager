import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { PublicOutfit } from '@wardrobe/shared';
import { OutfitCard, UNNAMED_OUTFIT } from '../../src/outfits/OutfitCard';

// This file lives in `__tests__/` and NOT under `app/`. That is not required
// for a component in `src/` — it is where the brief puts this task's tests, and
// keeping all five of them together means one `--testPathPattern` reaches the
// lot. See README.md:161 for why anything under `app/` would be a defect.

type Element = ReturnType<typeof screen.getByTestId>;

/** See `imageUri` in ItemTile.test.tsx — RN may normalise `source` to an array. */
function imageUri(el: Element): string | undefined {
  const source = el.props.source as { uri?: string } | { uri?: string }[] | undefined;
  return Array.isArray(source) ? source[0]?.uri : source?.uri;
}

function outfit(overrides: Partial<PublicOutfit> = {}): PublicOutfit {
  return {
    id: 'outfit-1',
    userId: 'user-1',
    name: 'Work fit',
    itemIds: ['a', 'b', 'c'],
    itemCount: 3,
    coverUrl: 'https://example.test/cover/a.jpg',
    createdAt: '2026-08-24T09:00:00.000Z',
    ...overrides,
  };
}

const onPress = jest.fn();

describe('OutfitCard', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders the cover, name and item count', async () => {
    await render(<OutfitCard outfit={outfit()} onPress={onPress} />);

    expect(imageUri(screen.getByTestId('outfit-cover-outfit-1'))).toBe(
      'https://example.test/cover/a.jpg',
    );
    expect(screen.getByTestId('outfit-name-outfit-1')).toHaveTextContent('Work fit');
    expect(screen.getByTestId('outfit-count-outfit-1')).toHaveTextContent('3 items');
    // The placeholder tile is the cover's alternative, not a backdrop behind it.
    expect(screen.queryByTestId('outfit-cover-placeholder-outfit-1')).toBeNull();
    // One line. A name that reflows onto a second line pushes the count out of
    // every cell in its row, because a FlatList row is as tall as its tallest
    // cell — so this is a property of the whole row, not of one caption.
    expect(screen.getByTestId('outfit-name-outfit-1').props.numberOfLines).toBe(1);
    // The cover stays out of the accessibility tree, so the cell is one node
    // carrying one label rather than a photograph a screen reader stops on.
    // The prop is a no-op today — an un-labelled RN Image is not an
    // accessibility element, and the `accessible` Pressable above absorbs its
    // children anyway — which is exactly why it needs an assertion: two
    // mutations of it survived the whole suite before this line existed.
    expect(screen.getByTestId('outfit-cover-outfit-1').props.accessible).toBe(false);
  });

  it('renders a placeholder when the outfit has no cover', async () => {
    const { coverUrl: _dropped, ...withoutCover } = outfit();

    await render(<OutfitCard outfit={withoutCover} onPress={onPress} />);

    expect(screen.getByTestId('outfit-cover-placeholder-outfit-1')).toBeTruthy();
    // An <Image> with no uri renders a broken/blank box on a device, which is
    // exactly what the placeholder exists to replace. It must not be there at
    // all.
    expect(screen.queryByTestId('outfit-cover-outfit-1')).toBeNull();
    // A mark, not a blank grey square: the cell has to read as "no picture"
    // rather than "still loading". What is asserted here is only that an icon
    // is SUPPLIED — whether the glyph renders or comes out as a tofu box is
    // something RNTL cannot see, and every tab icon in this app rendered as
    // tofu for a whole stage while the tests were green. Task 6 photographs it.
    expect(screen.getByTestId('outfit-cover-icon-outfit-1')).toBeTruthy();
  });

  it('renders a placeholder rather than an empty-source image', async () => {
    // Not reachable through the API today — `toPublicOutfit` spreads `coverUrl`
    // in only when it is truthy — but nothing between the socket and here
    // validates the response: `apiRequest` ends in `return parsed as T`. A
    // `coverUrl: ''` would satisfy `coverUrl !== undefined` and render an
    // <Image> whose uri is empty, which is the broken tile in a different
    // costume.
    await render(<OutfitCard outfit={outfit({ coverUrl: '' })} onPress={onPress} />);

    expect(screen.getByTestId('outfit-cover-placeholder-outfit-1')).toBeTruthy();
    expect(screen.queryByTestId('outfit-cover-outfit-1')).toBeNull();
  });

  it('renders a neutral placeholder when the outfit has no name', async () => {
    const { name: _dropped, ...unnamed } = outfit();

    await render(<OutfitCard outfit={unnamed} onPress={onPress} />);

    // Neutral: it must not invent a name, and it must not leave the cell
    // captionless either — a grid of covers with no labels is unreadable.
    expect(screen.getByTestId('outfit-name-outfit-1')).toHaveTextContent(UNNAMED_OUTFIT);
    expect(UNNAMED_OUTFIT).not.toBe('');
  });

  it('calls onPress with the outfit id', async () => {
    await render(<OutfitCard outfit={outfit()} onPress={onPress} />);

    fireEvent.press(screen.getByTestId('outfit-card-outfit-1'));

    // The ID, never the outfit and never an index: the caller navigates with
    // it, and an index is meaningless the moment the list is refreshed.
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledWith('outfit-1');
  });

  it('counts a single item in the singular', async () => {
    await render(<OutfitCard outfit={outfit({ itemIds: ['a'], itemCount: 1 })} onPress={onPress} />);

    expect(screen.getByTestId('outfit-count-outfit-1')).toHaveTextContent('1 item');
  });

  it('reports the count the server recorded, not the ids it happens to hold', async () => {
    // `itemCount` is the field for this. Deriving it from `itemIds.length`
    // would be right today (`outfitBase` sets `itemCount: itemIds.length`) and
    // would silently stop being right the day the list response trims the ids.
    await render(
      <OutfitCard outfit={outfit({ itemIds: [], itemCount: 4 })} onPress={onPress} />,
    );

    expect(screen.getByTestId('outfit-count-outfit-1')).toHaveTextContent('4 items');
  });

  it('describes the outfit to a screen reader by name and count', async () => {
    await render(<OutfitCard outfit={outfit()} onPress={onPress} />);

    // A cover photograph is silent. The name and the count are the two things
    // that make one cell distinguishable from the next.
    expect(screen.getByTestId('outfit-card-outfit-1').props.accessibilityLabel).toBe(
      'Work fit, 3 items',
    );
  });

  it('describes an unnamed outfit without inventing a name', async () => {
    const { name: _dropped, ...unnamed } = outfit();

    await render(<OutfitCard outfit={unnamed} onPress={onPress} />);

    expect(screen.getByTestId('outfit-card-outfit-1').props.accessibilityLabel).toBe(
      `${UNNAMED_OUTFIT}, 3 items`,
    );
  });

  it('is a button that says what the tap does', async () => {
    await render(<OutfitCard outfit={outfit()} onPress={onPress} />);

    const card = screen.getByTestId('outfit-card-outfit-1');
    expect(card.props.accessibilityRole).toBe('button');
    expect(card.props.accessibilityHint).toBe("Opens this outfit's details");
  });
});
