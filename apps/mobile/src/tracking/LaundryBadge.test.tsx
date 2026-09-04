import React from 'react';
import { StyleSheet } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import type { PublicClothingItem } from '@wardrobe/shared';
import { IN_LAUNDRY_LABEL, LaundryBadge, isInLaundry } from './LaundryBadge';

type Element = ReturnType<typeof screen.getByTestId>;

function item(overrides: Partial<PublicClothingItem> = {}): PublicClothingItem {
  return {
    id: 'item-1',
    userId: 'user-1',
    imageUrl: 'https://example.test/full/item-1.jpg',
    thumbnailUrl: 'https://example.test/thumb/item-1.jpg',
    category: 'jacket',
    colors: [{ hex: '#001f3f', name: 'navy', share: 1 }],
    seasons: ['winter'],
    laundryStatus: 'available',
    wearCount: 3,
    source: 'ai',
    createdAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  };
}

function flat(el: Element): Record<string, unknown> {
  return (StyleSheet.flatten(el.props.style) ?? {}) as Record<string, unknown>;
}

/**
 * Opacity of a colour, 0..1. Same helper as `ItemTile.test.tsx`: handles the
 * `rgba()`/`rgb()` and 6/8-digit hex forms React Native accepts, and treats
 * anything else as fully opaque, which is what RN does with a bare name.
 */
function alphaOf(colour: string): number {
  const rgba = /^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(colour);
  if (rgba) return rgba[1] === undefined ? 1 : Number(rgba[1]);
  if (colour === 'transparent') return 0;
  const hex8 = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})$/.exec(colour);
  if (hex8) return parseInt(hex8[1], 16) / 255;
  return 1;
}

/** `#fff`, `#ffffff`, `#ffffffff`, `rgb(...)`, `rgba(...)` → `[r, g, b]`. */
function rgbOf(colour: string): [number, number, number] {
  const fn = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(colour);
  if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3])];

  const hex = /^#([0-9a-fA-F]{3,8})$/.exec(colour);
  if (hex === null) throw new Error(`Not a colour this helper can read: ${colour}`);
  const digits = hex[1];
  const pairs =
    digits.length === 3 || digits.length === 4
      ? [digits[0] + digits[0], digits[1] + digits[1], digits[2] + digits[2]]
      : [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 6)];
  return [parseInt(pairs[0], 16), parseInt(pairs[1], 16), parseInt(pairs[2], 16)];
}

/**
 * WCAG relative luminance — **which is the greyscale value of the pixel**.
 *
 * That equivalence is the whole point of the test that uses this. Converting
 * an image to greyscale is exactly computing this Y for every pixel and
 * throwing the hue away, so a contrast ratio computed from two relative
 * luminances is the contrast those two colours have *after* the screenshot has
 * been desaturated. Two colours that differ only in hue land on the same Y and
 * come out of this at a ratio of 1.0.
 */
function luminanceOf(colour: string): number {
  const linear = rgbOf(colour).map((channel) => {
    const scaled = channel / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/** WCAG contrast ratio, 1..21. See `luminanceOf`: in greyscale terms. */
function contrastRatio(a: string, b: string): number {
  const first = luminanceOf(a);
  const second = luminanceOf(b);
  const [lighter, darker] = first > second ? [first, second] : [second, first];
  return (lighter + 0.05) / (darker + 0.05);
}

describe('LaundryBadge (FR7 / TC-09 — "item visually distinguished in wardrobe")', () => {
  it('renders nothing for an available item', async () => {
    await render(<LaundryBadge item={item({ laundryStatus: 'available' })} />);
    expect(screen.queryByTestId('item-laundry-item-1')).toBeNull();
  });

  it('renders the badge for an item that is in laundry', async () => {
    await render(<LaundryBadge item={item({ laundryStatus: 'in_laundry' })} />);
    expect(screen.getByTestId('item-laundry-item-1')).toBeTruthy();
  });

  it('carries a written label rather than relying on colour', async () => {
    // The single most important assertion in this file. A treatment that is a
    // tint, a border colour or a filter and nothing else is invisible to
    // roughly one man in twelve and invisible in a greyscale screenshot — and
    // a greyscale screenshot is how this stage's device gate will read it.
    await render(<LaundryBadge item={item({ laundryStatus: 'in_laundry' })} />);
    // The label's own testID, not the plate's: RNTL 14's `toHaveTextContent`
    // compares a string matcher by EXACT equality after normalisation, and the
    // plate also contains the glyph, which renders as text.
    expect(screen.getByTestId('item-laundry-label-item-1')).toHaveTextContent(IN_LAUNDRY_LABEL);
    expect(IN_LAUNDRY_LABEL.trim().length).toBeGreaterThan(0);
  });

  it('carries a glyph beside the label', async () => {
    await render(<LaundryBadge item={item({ laundryStatus: 'in_laundry' })} />);
    const glyph = screen.getByTestId('item-laundry-icon-item-1');
    // `createIconSet` renders a literal '?' for a name that is not in the
    // font's glyph map, so this rules out a typo'd icon name shipping as a
    // question mark. It does NOT prove the glyph draws — that is a pixel
    // property RNTL cannot reach, and the device gate is what settles it.
    expect(glyph).not.toHaveTextContent('?');
    expect(glyph).not.toHaveTextContent('');
  });

  it('keeps the glyph out of OS font scaling', async () => {
    // `@expo/vector-icons` renders a glyph as `<Text>`, so without this it
    // grows with the OS font-size setting and squeezes the label out of a
    // plate sized for one line. The library sets it in `defaultProps`, which
    // React 19 has already removed for function components — so this pins an
    // inherited default that can vanish silently. The LABEL is deliberately
    // left scalable, exactly as the category badge's is.
    await render(<LaundryBadge item={item({ laundryStatus: 'in_laundry' })} />);
    expect(screen.getByTestId('item-laundry-icon-item-1').props.allowFontScaling).toBe(false);
  });

  it('sits the glyph and the label side by side', async () => {
    // React Native's default `flexDirection` is `column`: the droplet would
    // stack ON TOP of the words inside a plate sized for a single line. Every
    // other assertion in this file passes in that state and RNTL renders no
    // layout, so this is asserted as intent and the device gate looks.
    await render(<LaundryBadge item={item({ laundryStatus: 'in_laundry' })} />);
    const plate = flat(screen.getByTestId('item-laundry-plate-item-1'));
    expect(plate.flexDirection).toBe('row');
    expect(plate.alignItems).toBe('center');
  });

  it('puts the label on a fully opaque plate rather than over the photograph', async () => {
    await render(<LaundryBadge item={item({ laundryStatus: 'in_laundry' })} />);
    const plate = flat(screen.getByTestId('item-laundry-plate-item-1'));
    expect(plate.backgroundColor).toBeDefined();
    // FULLY opaque, which is stricter than the category badge's 0.82 and
    // deliberately so. Two reasons: the tile behind this is a photograph of
    // anything at all, and — the one that matters for the test below — a
    // translucent plate composites with an unknown backdrop, so its rendered
    // luminance is not knowable from the style and the greyscale claim could
    // not be checked at all.
    expect(alphaOf(plate.backgroundColor as string)).toBe(1);
  });

  it('survives a greyscale screenshot — its contrast is luminance, not hue', async () => {
    // The falsifiable half of "must not rely on colour alone". `luminanceOf`
    // computes the WCAG relative luminance, which IS the greyscale value of a
    // pixel: desaturating a screenshot is computing exactly this and
    // discarding the hue. So a ratio taken between two relative luminances is
    // the contrast the plate and its ink have AFTER the gate has desaturated
    // the photograph.
    //
    // A treatment that distinguished the badge by hue alone — say a red plate
    // under equally-light red text — lands both colours on the same Y and
    // scores 1.0 here.
    await render(<LaundryBadge item={item({ laundryStatus: 'in_laundry' })} />);
    const plate = flat(screen.getByTestId('item-laundry-plate-item-1'));
    const label = flat(screen.getByTestId('item-laundry-label-item-1'));
    // Read out of the glyph's flattened STYLE, not its props: the `color` prop
    // handed to an `@expo/vector-icons` icon is folded into the `<Text>` style
    // it renders and does not survive as a prop on the host element. Verified,
    // rather than assumed — the first version of this test read `props.color`
    // and threw on `undefined`.
    const glyph = flat(screen.getByTestId('item-laundry-icon-item-1')).color as string;

    // 4.5:1 is WCAG AA for body text. Asserted on the label and on the glyph
    // separately, because the two take their colour through different
    // mechanisms — a style and a prop — and only one of them would notice if
    // the other were changed.
    expect(contrastRatio(plate.backgroundColor as string, label.color as string)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(plate.backgroundColor as string, glyph)).toBeGreaterThanOrEqual(4.5);
  });

  it('declares itself decoration for the touch system', async () => {
    // A style read, and it is the weaker half on purpose — but NOT because the
    // property is unobservable. RNTL 14.0.1 reads `pointerEvents` from the
    // style as well as the prop (`dist/helpers/pointer-events.js:16-17`) and
    // `isPointerEventEnabled` walks parents, so a `'none'` overlay takes
    // itself and its subtree out of the press-target search while leaving the
    // tile's Pressable eligible.
    //
    // The reason it cannot be asserted behaviourally HERE is narrower: this
    // overlay carries no handler, so a tap on the caption reaches the tile
    // either way. The difference appears the moment the overlay grows one,
    // which is exactly the regression this line defends against — and that
    // pair is pinned as a mutation rather than left as prose.
    //
    // Declared in the STYLE rather than as the legacy `pointerEvents` prop,
    // which React Native has been deprecating.
    await render(<LaundryBadge item={item({ laundryStatus: 'in_laundry' })} />);
    expect(flat(screen.getByTestId('item-laundry-item-1')).pointerEvents).toBe('none');
  });

  it('is silent to a screen reader, because the tile speaks for it', async () => {
    // The status is in `ItemTile`'s own `accessibilityLabel` (pinned there).
    // Left reachable, this overlay would make TalkBack read every in-laundry
    // cell twice.
    await render(<LaundryBadge item={item({ laundryStatus: 'in_laundry' })} />);
    expect(screen.getByTestId('item-laundry-label-item-1').props.accessible).toBe(false);
    expect(screen.getByTestId('item-laundry-icon-item-1').props.accessible).toBe(false);
  });
});

describe('isInLaundry', () => {
  it('is true only for the in_laundry status', async () => {
    // The predicate is exported so the tile's dimming and the badge's presence
    // are driven by ONE reading of `item.laundryStatus`. Two independent
    // comparisons are two things that can disagree, and a dimmed tile with no
    // badge is the "failed image load" the treatment must never look like.
    expect(isInLaundry(item({ laundryStatus: 'in_laundry' }))).toBe(true);
    expect(isInLaundry(item({ laundryStatus: 'available' }))).toBe(false);
  });

  it('is false for a status only the server has heard of', async () => {
    // `apiRequest` ends in `return parsed as T`, so nothing between the socket
    // and here validates the response. An unknown status must read as "not in
    // laundry" rather than dimming the tile and captioning it "In laundry",
    // which would be a confident falsehood about a garment the user owns.
    const unknown = item();
    (unknown as { laundryStatus: string }).laundryStatus = 'at_the_dry_cleaner';
    expect(isInLaundry(unknown)).toBe(false);
  });
});
