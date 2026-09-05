import React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { PublicClothingItem } from '@wardrobe/shared';
import { IN_LAUNDRY_LABEL } from '../tracking/LaundryBadge';
import { categoryLabel } from '../format/text';
import { ItemTile } from './ItemTile';

type Element = ReturnType<typeof screen.getByTestId>;

/**
 * React Native's `<Image>` normalises `source` before it reaches the host
 * element, and for a remote uri it may hand down either the object it was
 * given or a one-element array of it. Reading through both shapes keeps this
 * assertion about *which url the tile chose* rather than about which
 * normalisation the installed RN happens to apply.
 */
function imageUri(el: Element): string | undefined {
  const source = el.props.source as { uri?: string } | { uri?: string }[] | undefined;
  return Array.isArray(source) ? source[0]?.uri : source?.uri;
}

/** The grid this tile is laid out in — see `numColumns` in app/(tabs)/index.tsx. */
const COLUMNS = 3;

/**
 * Opacity of a colour, 0..1. Handles the `rgba()`/`rgb()` and 6/8-digit hex
 * forms React Native accepts; anything else is treated as fully opaque, which
 * is what RN itself does with a bare colour name.
 */
function alphaOf(colour: string): number {
  const rgba = /^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(colour);
  if (rgba) return rgba[1] === undefined ? 1 : Number(rgba[1]);
  if (colour === 'transparent') return 0;
  const hex8 = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})$/.exec(colour);
  if (hex8) return parseInt(hex8[1], 16) / 255;
  return 1;
}

function item(overrides: Partial<PublicClothingItem> = {}): PublicClothingItem {
  return {
    id: 'item-1',
    userId: 'user-1',
    imageUrl: 'https://example.test/full/item-1.jpg',
    thumbnailUrl: 'https://example.test/thumb/item-1.jpg',
    category: 'jacket',
    colors: [
      { hex: '#001f3f', name: 'navy', share: 0.55 },
      { hex: '#ffffff', name: 'white', share: 0.45 },
    ],
    seasons: ['winter'],
    laundryStatus: 'available',
    retired: false,
    wearCount: 3,
    source: 'ai',
    createdAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  };
}

/**
 * An item as it exists for every upload made before Stage 4 Task 2: the key
 * is genuinely absent, not present-and-undefined, which is the state the
 * `thumbnailUrl ?? imageUrl` fallback exists for.
 */
function itemWithoutThumbnail(): PublicClothingItem {
  const base = item();
  delete base.thumbnailUrl;
  return base;
}

describe('ItemTile', () => {
  it('renders the thumbnail when one is present', async () => {
    await render(<ItemTile item={item()} onPress={jest.fn()} />);
    expect(imageUri(screen.getByTestId('item-image-item-1'))).toBe('https://example.test/thumb/item-1.jpg');
  });

  it('falls back to the full image when no thumbnail exists', async () => {
    // The pre-Task-2 item case.
    await render(<ItemTile item={itemWithoutThumbnail()} onPress={jest.fn()} />);
    expect(imageUri(screen.getByTestId('item-image-item-1'))).toBe('https://example.test/full/item-1.jpg');
  });

  it('shows the item category on the tile', async () => {
    await render(<ItemTile item={item({ category: 'shoes' })} onPress={jest.fn()} />);
    // Asserted against the label's own testID rather than the badge's, and
    // deliberately so: RNTL 14's `toHaveTextContent` compares a string
    // matcher by EXACT equality after normalisation (see
    // node_modules/@testing-library/react-native/dist/matches.js), and the
    // badge now also contains the tag glyph, which is rendered as text.
    // Reading the badge would therefore mean loosening this to a substring
    // regex; reading the label keeps it exact — the label is the category
    // and nothing else.
    expect(screen.getByTestId('item-category-item-1')).toHaveTextContent(categoryLabel('shoes'));
  });

  // Phase 3's feature list promises a "Tag icon on each item for quick
  // attribute viewing". Task 4 shipped the badge as text only — correctly,
  // because no icon font was installed at the time — and Task 6 adds the
  // glyph now that `@expo/vector-icons` is present.
  it('puts a non-empty tag glyph in the category badge', async () => {
    await render(<ItemTile item={item()} onPress={jest.fn()} />);
    const glyph = screen.getByTestId('item-tag-icon-item-1');
    // `createIconSet` renders a literal '?' for a name that is not in the
    // font's glyph map (see the vendored create-icon-set.js), so this rules
    // out a typo'd icon name shipping as a question mark. It does NOT prove
    // the glyph draws — that is a pixel property RNTL cannot reach, and
    // Task 7's device screenshot is what settles it.
    expect(glyph).not.toHaveTextContent('?');
    expect(glyph).not.toHaveTextContent('');
  });

  // The glyph must not track the OS font-size setting. It is `<Text>`
  // underneath (`@expo/vector-icons` renders glyphs as text), so it would
  // otherwise grow with body text and squeeze the longest category names out
  // of a plate capped at 90% of a one-third-width tile. `@expo/vector-icons`
  // already sets this in the icon class's `defaultProps`, so this test is
  // guarding an inherited default as much as an explicit prop — which is the
  // reason to have it: React 19 already dropped `defaultProps` for function
  // components, and the day this library converts `Icon` to one, the default
  // vanishes silently and nothing else here would notice.
  //
  // The category LABEL is deliberately left scalable — see `badgeText` in
  // ItemTile.tsx — so this is asserted on the glyph only.
  it('keeps the tag glyph out of OS font scaling', async () => {
    await render(<ItemTile item={item()} onPress={jest.fn()} />);
    expect(screen.getByTestId('item-tag-icon-item-1').props.allowFontScaling).toBe(false);
  });

  it('lays the badge out as a row, so the glyph and the label sit side by side', async () => {
    // Without an explicit `flexDirection`, React Native's default is
    // `column`: the glyph would sit stacked ON TOP of the category word
    // inside a plate sized for one line. Every other assertion in this file
    // passes in that state, and RNTL renders no layout — so this is asserted
    // as intent, and Task 7 looks at the result.
    await render(<ItemTile item={item()} onPress={jest.fn()} />);
    const badge = StyleSheet.flatten(screen.getByTestId('item-badge-item-1').props.style) as {
      flexDirection?: string;
      alignItems?: string;
    };
    expect(badge.flexDirection).toBe('row');
    // Different glyph and text heights otherwise leave the icon baseline-
    // adrift from the word it labels.
    expect(badge.alignItems).toBe('center');
  });

  it('is a square fraction of the row, not a grown-to-fit or fixed-height box', async () => {
    // Two separate contract decisions, both device-only in their effect and so
    // both asserted as intent rather than as layout — RNTL renders nothing:
    //  * `aspectRatio: 1` instead of a computed pixel height, so three columns
    //    are square on any screen width without measuring one.
    //  * a width fraction instead of `flex: 1`, because a flexed cell stretches
    //    to fill a partial last row — an 8-item wardrobe would end in two
    //    full-bleed squares under six small ones.
    await render(<ItemTile item={item()} onPress={jest.fn()} />);
    const tile = StyleSheet.flatten(screen.getByTestId('item-tile-item-1').props.style) as {
      aspectRatio?: number;
      height?: number | string;
      width?: number | string;
      flex?: number;
    };
    expect(tile.aspectRatio).toBe(1);
    expect(tile.height).toBeUndefined();
    expect(tile.flex).toBeUndefined();
    // Pinned, not merely "defined": at `'25%'` every assertion above still
    // passes while three columns occupy three quarters of the row and the
    // remaining quarter of the screen sits blank.
    expect(tile.width).toBe(`${(100 / COLUMNS).toFixed(3)}%`);
  });

  it('gives the category badge a solid background rather than bare text over the photo', async () => {
    await render(<ItemTile item={item()} onPress={jest.fn()} />);
    const badge = StyleSheet.flatten(screen.getByTestId('item-badge-item-1').props.style) as {
      backgroundColor?: string;
    };
    expect(badge.backgroundColor).toBeDefined();
    // Alpha, not `!== 'transparent'`: `rgba(0, 0, 0, 0)` is not the string
    // "transparent" and is exactly as invisible, so the weaker check would
    // pass while shipping the unreadable-text-over-a-photo defect this test
    // exists to prevent. What alpha is *enough* to read black-on-white text
    // over an arbitrary photograph is a pixel question Task 7 answers; this
    // only rules out a plate you can see through.
    expect(alphaOf(badge.backgroundColor as string)).toBeGreaterThanOrEqual(0.75);
  });

  it('renders one swatch per colour', async () => {
    await render(<ItemTile item={item()} onPress={jest.fn()} />);
    const swatches = screen.getAllByTestId('item-swatch-item-1');
    expect(swatches).toHaveLength(2);
    // Not just "two boxes exist" — each has to carry its own colour, or the
    // dot row is decoration rather than the attribute view the document
    // promises.
    expect(StyleSheet.flatten(swatches[0].props.style)).toMatchObject({ backgroundColor: '#001f3f' });
    expect(StyleSheet.flatten(swatches[1].props.style)).toMatchObject({ backgroundColor: '#ffffff' });
  });

  it('renders no swatches for an item with no colours', async () => {
    await render(<ItemTile item={item({ colors: [] })} onPress={jest.fn()} />);
    expect(screen.queryAllByTestId('item-swatch-item-1')).toHaveLength(0);
  });

  it('calls onPress with the item id', async () => {
    const onPress = jest.fn();
    await render(<ItemTile item={item({ id: 'item-42' })} onPress={onPress} />);
    await fireEvent.press(screen.getByTestId('item-tile-item-42'));
    expect(onPress).toHaveBeenCalledWith('item-42');
  });

  it('exposes an accessible label naming the category', async () => {
    // A grid of images is unusable with a screen reader otherwise.
    await render(<ItemTile item={item()} onPress={jest.fn()} />);
    expect(screen.getByLabelText(/jacket/)).toBeTruthy();
  });

  it('names the colours in the accessible label too', async () => {
    await render(<ItemTile item={item()} onPress={jest.fn()} />);
    const label = screen.getByTestId('item-tile-item-1').props.accessibilityLabel as string;
    expect(label).toContain('navy');
    expect(label).toContain('white');
  });

  // NOT TESTED HERE, deliberately: that the badge is legible over a dark
  // photograph. RNTL can assert the badge has a background colour (it does,
  // via the style above) but not that the rendered result is readable — that
  // is a pixel property of a real screen. Task 7 photographs it.
});

/**
 * Stage 5 Task 4 — the outfit composer selects wardrobe items through this
 * same tile, so `selected` and `selectionIndex` were added to it rather than
 * a second, drifting copy of the grid cell being written.
 *
 * Both props are OPTIONAL, and that is load-bearing: `app/(tabs)/index.tsx`
 * renders `<ItemTile item={item} onPress={openItem} />` with neither. Making
 * `selected` required is mutation 4 of this task and fails `tsc` at that call
 * site — which is the proof the grid is covered by the compiler rather than
 * by hope.
 */
describe('ItemTile selection (Stage 5 Task 4)', () => {
  it('is not selected by default', async () => {
    await render(<ItemTile item={item()} onPress={jest.fn()} />);
    // Falsy rather than `false` on purpose: the wardrobe grid passes no
    // selection prop at all, and either "absent" or "explicitly false" is a
    // correct answer to "is this tile part of an outfit".
    expect(screen.getByTestId('item-tile-item-1').props.accessibilityState?.selected).toBeFalsy();
    expect(screen.queryByTestId('item-selection-item-1')).toBeNull();
  });

  it('reports selected through accessibilityState', async () => {
    // The only assertion RNTL can make about selection — a border is a pixel
    // property — and independently the correct accessibility semantic: a
    // screen reader announces the state, it cannot see the ring.
    await render(<ItemTile item={item()} onPress={jest.fn()} selected selectionIndex={1} />);
    expect(screen.getByTestId('item-tile-item-1').props.accessibilityState?.selected).toBe(true);
  });

  it('shows the selection ordinal when selected', async () => {
    // Not decoration: the order is what `POST /outfits` stores and what makes
    // "top, trousers, shoes" read correctly, so the user has to be able to
    // see which position a tile holds.
    await render(<ItemTile item={item()} onPress={jest.fn()} selected selectionIndex={2} />);
    expect(screen.getByTestId('item-selection-item-1')).toHaveTextContent('2');
  });

  it('shows no ordinal when not selected', async () => {
    // An index is passed deliberately: it is `selected` that gates the badge,
    // so a stale index left behind by a deselect cannot paint a number on an
    // unselected tile.
    await render(<ItemTile item={item()} onPress={jest.fn()} selected={false} selectionIndex={2} />);
    expect(screen.queryByTestId('item-selection-item-1')).toBeNull();
  });

  it('marks a selected tile with a border as well as the ordinal', async () => {
    // "Distinguishable without relying on colour alone" cuts both ways, so
    // the tile carries two independent marks: a border (which a colour-blind
    // user perceives as a shape change) and the ordinal (which is text). What
    // the border LOOKS like is a pixel property — Task 6 photographs it; this
    // only rules out shipping a colour swap on its own.
    await render(<ItemTile item={item()} onPress={jest.fn()} selected selectionIndex={1} />);
    const surface = StyleSheet.flatten(screen.getByTestId('item-surface-item-1').props.style) as {
      borderWidth?: number;
      borderColor?: string;
    };
    expect(surface.borderWidth).toBeGreaterThan(0);
    expect(surface.borderColor).toBeDefined();
  });

  it('draws no border on a tile that is not selected', async () => {
    // The other half of the border test above, and the half that matters to a
    // screen this component did not change: applying `surfaceSelected`
    // unconditionally paints a 3pt blue ring on EVERY cell of Stage 4's
    // wardrobe grid, and every other assertion in this file still passes. The
    // ordinal is pinned in both directions; the border has to be too.
    await render(<ItemTile item={item()} onPress={jest.fn()} />);
    const unselectable = StyleSheet.flatten(screen.getByTestId('item-surface-item-1').props.style) as {
      borderWidth?: number;
    };
    expect(unselectable.borderWidth).toBeUndefined();
  });

  it('draws no border on a selectable tile that is not currently selected', async () => {
    // Inside the composer, where the prop IS passed, an unselected tile must
    // look like an unselected tile.
    await render(<ItemTile item={item()} onPress={jest.fn()} selected={false} />);
    const unselected = StyleSheet.flatten(screen.getByTestId('item-surface-item-1').props.style) as {
      borderWidth?: number;
    };
    expect(unselected.borderWidth).toBeUndefined();
  });

  it('names the outfit position in the accessible label of a selected tile', async () => {
    // TalkBack announces "selected" from accessibilityState, but not *which*
    // position — the one piece of information the visible badge carries and
    // the state does not.
    await render(<ItemTile item={item()} onPress={jest.fn()} selected selectionIndex={3} />);
    const label = screen.getByTestId('item-tile-item-1').props.accessibilityLabel as string;
    expect(label).toContain('3');
  });

  // The wardrobe grid's hint ("Opens this item's details") is a lie inside the
  // composer, where the same tap adds or removes the item instead. The
  // PRESENCE of `selected` — not its value — is what tells the tile which
  // screen it is on, which is what lets the composer reuse the grid cell
  // without a third prop and without the grid changing at all.
  //
  // Two tests rather than one render-unmount-render: RNTL's `screen` follows
  // the most recent `render`, and a second render inside one test leaves the
  // NEXT test unable to find anything at all. Verified — it cost the first
  // red run of this task.
  it('keeps the "opens the item" hint when no selection prop is passed', async () => {
    await render(<ItemTile item={item()} onPress={jest.fn()} />);
    expect(screen.getByTestId('item-tile-item-1').props.accessibilityHint).toMatch(/details/i);
  });

  it('says the tap adds the item to the outfit when the tile is selectable', async () => {
    await render(<ItemTile item={item()} onPress={jest.fn()} selected={false} />);
    expect(screen.getByTestId('item-tile-item-1').props.accessibilityHint).toMatch(/adds/i);
  });

  it('says the tap removes the item once it is in the outfit', async () => {
    await render(<ItemTile item={item()} onPress={jest.fn()} selected selectionIndex={1} />);
    expect(screen.getByTestId('item-tile-item-1').props.accessibilityHint).toMatch(/removes/i);
  });

  it('calls onPress with the item id from a selected tile too', async () => {
    // The composer's deselect path runs through the same handler; a tile that
    // only reported taps while unselected could never be deselected.
    const onPress = jest.fn();
    await render(<ItemTile item={item({ id: 'item-9' })} onPress={onPress} selected selectionIndex={1} />);
    await fireEvent.press(screen.getByTestId('item-tile-item-9'));
    expect(onPress).toHaveBeenCalledWith('item-9');
  });
});

/**
 * Stage 6 Task 4 — FR7 / TC-09, "item visually distinguished in wardrobe".
 *
 * The treatment is driven by `item.laundryStatus` and by NOTHING else. There
 * is deliberately no `inLaundry` prop: the status already travels on every
 * `PublicClothingItem` the grid renders, and a prop would let a caller pass a
 * garment that is in the wash and a `false` beside it — a tile rendering a
 * lie, with the type system content.
 *
 * The badge itself is `src/tracking/LaundryBadge.tsx` and has its own suite,
 * including the greyscale-contrast assertion. What is pinned HERE is the part
 * that belongs to the tile: that the badge appears exactly when it should,
 * that the garment is dimmed with it, that the status is spoken, and that
 * none of it changes what a tap does.
 */
describe('ItemTile laundry treatment (Stage 6 Task 4 — FR7 / TC-09)', () => {
  it('shows the laundry badge when the item is in_laundry', async () => {
    await render(<ItemTile item={item({ laundryStatus: 'in_laundry' })} onPress={jest.fn()} />);
    expect(screen.getByTestId('item-laundry-item-1')).toBeTruthy();
  });

  it('shows no badge when the item is available', async () => {
    await render(<ItemTile item={item({ laundryStatus: 'available' })} onPress={jest.fn()} />);
    expect(screen.queryByTestId('item-laundry-item-1')).toBeNull();
  });

  it('reads the status per item rather than decorating the whole grid', async () => {
    // Two tiles in one render, which is what the wardrobe grid actually does.
    // A treatment applied unconditionally passes every single-tile assertion
    // above and paints "In laundry" over a wardrobe where nothing is.
    await render(
      <>
        <ItemTile item={item({ id: 'clean', laundryStatus: 'available' })} onPress={jest.fn()} />
        <ItemTile item={item({ id: 'dirty', laundryStatus: 'in_laundry' })} onPress={jest.fn()} />
      </>,
    );
    expect(screen.queryByTestId('item-laundry-clean')).toBeNull();
    expect(screen.getByTestId('item-laundry-dirty')).toBeTruthy();
  });

  it('does not rely on colour alone — the badge carries a label', async () => {
    // The whole reason this treatment is a badge and not a tint. Stage 5
    // shipped a category filter that rendered only the top few pixels of every
    // label through four gates and three device screenshots, because no test
    // in this repo can see a rendered glyph. What a test CAN see is that the
    // word is there to be rendered at all.
    await render(<ItemTile item={item({ laundryStatus: 'in_laundry' })} onPress={jest.fn()} />);
    expect(screen.getByTestId('item-laundry-label-item-1')).toHaveTextContent(IN_LAUNDRY_LABEL);
  });

  it('dims the garment while it is in laundry', async () => {
    // The second channel: a luminance change, which survives desaturation as
    // the badge's contrast does.
    //
    // Pinned as a BAND, not as `< 1`. An earlier revision asserted only
    // `< 1 && >= 0.3`, and `opacity: 0.99` — a dimming nobody can see —
    // satisfied it with every test in this repo green, which made the second
    // greyscale channel one edit from decorative. Both ends are load-bearing
    // and both are recorded mutations:
    //
    //  * at most 0.6, because a reduction smaller than about 40% over the
    //    tile's own `#eee` surface is not readable as a deliberate state; it
    //    reads as a rendering artefact, if it reads at all;
    //  * at least 0.35, because below that the garment washes out toward the
    //    surface colour and the cell stops being recognisable — and an
    //    unrecognisable photograph under a small caption is precisely the
    //    "this image failed to load" misreading the treatment exists to avoid.
    //
    // What no test here can say is whether 0.45 specifically reads as
    // deliberate on a real screen. The band rules out the two ways of getting
    // it obviously wrong; the device gate judges the value inside it.
    await render(<ItemTile item={item({ laundryStatus: 'in_laundry' })} onPress={jest.fn()} />);
    const image = StyleSheet.flatten(screen.getByTestId('item-image-item-1').props.style) as {
      opacity?: number;
    };
    expect(image.opacity).toBeDefined();
    expect(image.opacity as number).toBeLessThanOrEqual(0.6);
    expect(image.opacity as number).toBeGreaterThanOrEqual(0.35);
    // Dimmed AND captioned, in the same render. A dimmed photograph on its own
    // is indistinguishable from an image that failed to load — the caption is
    // what makes it read as deliberate, so the two are asserted together
    // rather than in two tests that could pass one at a time.
    expect(screen.getByTestId('item-laundry-item-1')).toBeTruthy();
  });

  it('leaves an available item at full strength', async () => {
    // The other half, and the half that matters to Stage 4's grid: dimming
    // unconditionally greys out every cell of a wardrobe where nothing is in
    // the wash, and every assertion above still passes.
    await render(<ItemTile item={item({ laundryStatus: 'available' })} onPress={jest.fn()} />);
    const image = StyleSheet.flatten(screen.getByTestId('item-image-item-1').props.style) as {
      opacity?: number;
    };
    // Either absent or an explicit 1 — both are "not dimmed".
    expect(image.opacity ?? 1).toBe(1);
  });

  it("names the laundry status in the tile's accessible label", async () => {
    // A badge and a dimmed photograph are both invisible to a screen reader.
    // Read through the tile's own host props rather than a query, because
    // reachability is the thing being asserted as much as the text: Stage 5
    // shipped an item row whose label was never spoken, since the container
    // was not an accessibility element.
    await render(<ItemTile item={item({ laundryStatus: 'in_laundry' })} onPress={jest.fn()} />);
    const tile = screen.getByTestId('item-tile-item-1');
    expect(tile.props.accessibilityLabel as string).toContain(IN_LAUNDRY_LABEL);
    // Reachable: a `Pressable` with `accessibilityRole` is an accessibility
    // element, and `getByLabelText` finds only elements that are.
    expect(screen.getByLabelText(new RegExp(IN_LAUNDRY_LABEL, 'i'))).toBe(tile);
  });

  it('says nothing about laundry on an available item', async () => {
    await render(<ItemTile item={item({ laundryStatus: 'available' })} onPress={jest.fn()} />);
    const label = screen.getByTestId('item-tile-item-1').props.accessibilityLabel as string;
    expect(label).not.toMatch(/laundry/i);
  });

  it('does not report an in-laundry tile as disabled', async () => {
    // `accessibilityState={{ disabled: … }}` would be the wrong word for this.
    // An item in the wash is ANNOTATED, not disabled: the tap still opens its
    // details, and the composer still lets the user put it in an outfit.
    // TalkBack announces a disabled button as unavailable, which would tell a
    // screen-reader user the cell does nothing.
    await render(<ItemTile item={item({ laundryStatus: 'in_laundry' })} onPress={jest.fn()} />);
    const state = screen.getByTestId('item-tile-item-1').props.accessibilityState as
      | { disabled?: boolean; selected?: boolean }
      | undefined;
    expect(state?.disabled).toBeUndefined();
    expect(screen.getByTestId('item-tile-item-1').props.disabled).toBeFalsy();
  });

  it('keeps the tile pressable while in laundry', async () => {
    // Wearing something that is in the wash is a real choice; the treatment
    // tells the user and the decision stays theirs, so the cell must not go
    // inert.
    //
    // Fired on the PLATE — the pixel the user's finger actually lands on when
    // they tap an in-laundry cell — rather than on the tile root, because the
    // caption covers the middle of the cell.
    //
    // This is STRONGER than an earlier revision of this comment admitted. RNTL
    // 14.0.1 does model `pointerEvents`, reading it from the style as well as
    // the prop (`dist/helpers/pointer-events.js:16-17`) and walking parents.
    // So if the overlay ever grows an `onPress` of its own, this press runs the
    // OVERLAY's handler instead of the tile's and this test fails — unless
    // `pointerEvents: 'none'` is still there, in which case the overlay is not
    // an eligible target and the tile keeps working. That is the whole
    // interception property, and it is a recorded mutation pair rather than a
    // claim. The device gate is still the last word on a real touch.
    const onPress = jest.fn();
    await render(
      <ItemTile item={item({ id: 'item-7', laundryStatus: 'in_laundry' })} onPress={onPress} />,
    );
    await fireEvent.press(screen.getByTestId('item-laundry-plate-item-7'));
    expect(onPress).toHaveBeenCalledWith('item-7');

    onPress.mockClear();
    await fireEvent.press(screen.getByTestId('item-tile-item-7'));
    expect(onPress).toHaveBeenCalledWith('item-7');
  });

  it('keeps the category badge and the selection ordinal beside it', async () => {
    // The composer can select an item that is in the wash, so all three marks
    // are on screen at once. That they COEXIST is assertable; whether they
    // collide is a layout property RNTL renders none of — the badge takes the
    // centre of the tile precisely because the category owns top-left, the
    // ordinal top-right and the swatches bottom-right, but the device gate is
    // what confirms it.
    await render(
      <ItemTile
        item={item({ laundryStatus: 'in_laundry' })}
        onPress={jest.fn()}
        selected
        selectionIndex={2}
      />,
    );
    expect(screen.getByTestId('item-category-item-1')).toBeTruthy();
    expect(screen.getByTestId('item-selection-item-1')).toHaveTextContent('2');
    expect(screen.getByTestId('item-laundry-item-1')).toBeTruthy();
  });

  it('anchors the laundry plate away from the corners the other marks own', async () => {
    // Part of the collision question IS observable, and this is that part.
    //
    // The three existing marks are pinned to three corners by absolute offsets
    // in the stylesheet: the category badge to top-left, the selection ordinal
    // to top-right, the colour swatches to bottom-right. The laundry treatment
    // takes the centre — an absolute-fill overlay that CENTRES its plate,
    // rather than a fourth corner offset. So "does not collide" is not purely
    // a measurement: giving the plate `position: 'absolute', left: 4, top: 4`
    // would drop it exactly on top of the category badge, and every other
    // assertion in this file would still pass. That mutation fails here.
    //
    // What remains genuinely device-only is whether the centred plate's
    // rendered BOX overlaps the corner marks' rendered boxes at a given screen
    // width. This renderer runs no layout: react-test-renderer has no Yoga, so
    // nothing here has a measured position or size, and no `onLayout` ever
    // fires. The device gate is what measures it.
    await render(
      <ItemTile
        item={item({ laundryStatus: 'in_laundry' })}
        onPress={jest.fn()}
        selected
        selectionIndex={2}
      />,
    );

    const category = StyleSheet.flatten(screen.getByTestId('item-badge-item-1').props.style) as {
      left?: number;
      top?: number;
    };
    const ordinal = StyleSheet.flatten(
      screen.getByTestId('item-selection-item-1').props.style,
    ) as { right?: number; top?: number };
    const swatches = StyleSheet.flatten(
      screen.getByTestId('item-swatches-item-1').props.style,
    ) as { right?: number; bottom?: number };
    const overlay = StyleSheet.flatten(screen.getByTestId('item-laundry-item-1').props.style) as {
      position?: string;
      top?: number;
      left?: number;
      right?: number;
      bottom?: number;
      alignItems?: string;
      justifyContent?: string;
    };
    const plate = (StyleSheet.flatten(
      screen.getByTestId('item-laundry-plate-item-1').props.style,
    ) ?? {}) as Record<string, unknown>;

    // The three corners that were already taken. The swatch row is asserted
    // as well as the other two: the centring argument rests on all THREE being
    // corner-anchored, and an earlier revision of this test pinned only two of
    // them — which left a third of its own premise unchecked.
    expect(category.left).toBeDefined();
    expect(category.top).toBeDefined();
    expect(ordinal.right).toBeDefined();
    expect(ordinal.top).toBeDefined();
    expect(swatches.right).toBeDefined();
    expect(swatches.bottom).toBeDefined();

    // The overlay spans the whole tile and centres what is inside it.
    expect(overlay.position).toBe('absolute');
    expect([overlay.top, overlay.left, overlay.right, overlay.bottom]).toEqual([0, 0, 0, 0]);
    expect(overlay.alignItems).toBe('center');
    expect(overlay.justifyContent).toBe('center');

    // And the plate itself declares NO PLACEMENT OF ITS OWN — it is put where
    // it is entirely by the overlay's centring.
    //
    // Asserted as a blocklist of every placement property rather than as
    // `position === undefined`, and the difference is not pedantry: an earlier
    // revision checked only `position` and the four edge offsets, and
    // `{ alignSelf: 'flex-start', marginTop: -1000 }` landed the plate on the
    // category badge — the same destination, reached through flexbox instead
    // of absolute positioning — with every test green. A named property needs
    // a check as wide as the property.
    //
    // Adding a style to the plate is meant to be a deliberate act that comes
    // here first; that is the cost and it is the intended one.
    const PLACEMENT_KEYS = [
      'position',
      'top',
      'right',
      'bottom',
      'left',
      'start',
      'end',
      'margin',
      'marginTop',
      'marginRight',
      'marginBottom',
      'marginLeft',
      'marginStart',
      'marginEnd',
      'marginHorizontal',
      'marginVertical',
      'alignSelf',
      'transform',
    ];
    const declared = PLACEMENT_KEYS.filter(
      (key) => (plate as Record<string, unknown>)[key] !== undefined,
    );
    expect(declared).toEqual([]);
  });

  // NOT TESTED HERE, deliberately, and each of these is a device-gate item:
  //  * whether the badge is legible over a photograph of a white shirt or a
  //    black coat — the plate is opaque and its contrast is checked in
  //    greyscale terms in `LaundryBadge.test.tsx`, but "readable at 11pt on a
  //    real screen" is a pixel property;
  //  * whether the dimming reads as deliberate rather than as an image that
  //    failed to load — the centred caption is the argument that it does, and
  //    an argument is not a photograph;
  //  * whether the centred plate's rendered box overlaps the corner marks'
  //    rendered boxes at the narrowest supported width. The ANCHORING is
  //    asserted directly above — this renderer runs no Yoga, so there is no
  //    measured geometry to compare and no `onLayout` to wait for.
});
