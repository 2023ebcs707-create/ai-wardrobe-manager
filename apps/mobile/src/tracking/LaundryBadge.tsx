import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { PublicClothingItem } from '@wardrobe/shared';
import { color, radius } from '../theme/tokens';
import { font } from '../theme/type';

/**
 * The words on the badge, and the words a screen reader speaks.
 *
 * ONE constant for both, deliberately. `ItemTile` appends this to its
 * `accessibilityLabel`, so a badge that said one thing and a label that said
 * another would be two descriptions of the same garment that can drift apart —
 * and only one of them is ever looked at. Capitalisation is a rendering
 * property; TalkBack speaks "In laundry" and "in laundry" identically.
 *
 * Exported so tests assert against the shipped string rather than a copy of
 * it: a test carrying its own literal passes after a typo is introduced.
 */
export const IN_LAUNDRY_LABEL = 'In laundry';

/**
 * Is this garment in the wash?
 *
 * A named predicate rather than two `=== 'in_laundry'` comparisons, because
 * the badge and the tile's dimming must come from ONE reading of the status.
 * Two independent comparisons are two things that can be changed apart, and
 * the state they would produce — a dimmed photograph with no caption — is
 * exactly the "this image failed to load" misreading the whole treatment is
 * built to avoid.
 *
 * Written as an equality against the one member that means "in the wash"
 * rather than `!== 'available'`, because nothing between the socket and here
 * validates the response: `apiRequest` ends in `return parsed as T`, so a
 * third status only the server has heard of arrives typed as one of these two.
 * Under `!== 'available'` such a value would dim the tile and caption it "In
 * laundry" — a confident falsehood about a garment the user owns. Under this,
 * it reads as "not in laundry", which is the cheaper error.
 */
export function isInLaundry(item: PublicClothingItem): boolean {
  return item.laundryStatus === 'in_laundry';
}

export interface LaundryBadgeProps {
  /**
   * The item, whole — **not** a `status` or an `inLaundry` boolean.
   *
   * The status already travels on every `PublicClothingItem` the grid renders.
   * A separate prop would let a caller hand over a garment that is in the wash
   * together with a `false` beside it, and the type system would be perfectly
   * happy: the tile would render a lie, and the only way to catch it would be
   * to look. Taking the item means the badge reads the same field the API
   * answered with and there is nothing else to disagree with.
   */
  item: PublicClothingItem;
}

/**
 * FR7 / TC-09: "item visually distinguished in wardrobe".
 *
 * ## Why this is a captioned badge and not a tint
 *
 * Three independent channels carry the message, and none of them is hue:
 *
 * 1. **A word.** "In laundry", rendered as text.
 * 2. **A shape.** A droplet glyph beside the word.
 * 3. **Luminance.** White ink on a near-black plate, and (in `ItemTile`) a
 *    dimmed photograph behind it.
 *
 * That list is the response to two specific, paid-for failures. Roughly one
 * man in twelve cannot rely on a colour change at all. And this stage's device
 * gate reads a screenshot: Stage 5's category filter shipped rendering only
 * the top few pixels of every label — the apex of the "A" in "All" — through
 * four gates and three device screenshots, because the pills still sized
 * correctly per label and the row read as deliberate. No test in this repo can
 * see a clipped glyph, so the treatment has to survive being read at a glance
 * and in greyscale. `LaundryBadge.test.tsx` computes the plate/ink contrast
 * from WCAG relative luminance, which IS the greyscale value of a pixel, so
 * that claim is checked rather than asserted.
 *
 * ## Why it takes the centre of the tile
 *
 * The three existing marks own three corners: the category badge is top-left,
 * the selection ordinal top-right, the colour swatches bottom-right. The
 * centre is the only region none of them can reach, and it is also where a
 * caption reads as being *about* the garment rather than as another attribute
 * chip. That makes the layout free of collisions by construction rather than
 * by measurement — but whether it is free of them at the narrowest supported
 * width is still a pixel property, and the device gate is what settles it.
 *
 * ## What `pointerEvents: 'none'` is, and is not, doing
 *
 * Two revisions of this comment have now been wrong, in opposite directions,
 * so this one states only what was measured.
 *
 * It is NOT what makes an in-laundry tile pressable today. The overlay is
 * rendered INSIDE the tile's `Pressable` and carries no responder props, and
 * React Native only offers the responder to views that ask for it — so a tap
 * on the caption reaches the `Pressable` with or without this line.
 *
 * It IS load-bearing for the change it defends against, and that IS observable
 * — the second wrong revision claimed otherwise, on the strength of a probe
 * that only covered the handler-less case. `@testing-library/react-native`
 * 14.0.1 reads this property, from the style as well as the prop:
 *
 *   // dist/helpers/pointer-events.js:16-17
 *   const pointerEvents = instance?.props.pointerEvents
 *     ?? StyleSheet.flatten(instance?.props.style)?.pointerEvents;
 *
 * and `isPointerEventEnabled` walks parents, so a `'none'` overlay disqualifies
 * itself and its subtree as press targets while leaving the `Pressable` above
 * it eligible. Give this overlay an `onPress` and the difference is immediate:
 * with the line, a tap on the caption still runs the TILE's handler; without
 * it, the overlay's handler swallows the tap and opening an in-laundry item
 * stops working. That pair is a recorded mutation, not an argument.
 *
 * Wearing something that is in the wash is a real choice; the treatment tells
 * the user and the decision stays theirs.
 */
export function LaundryBadge({ item }: LaundryBadgeProps) {
  // Renders nothing at all for an available item, rather than an empty view
  // or a transparent one: the wardrobe grid is mostly available items, and a
  // treatment that is *present but invisible* is one line away from being
  // present and visible on every cell.
  if (!isInLaundry(item)) return null;

  return (
    <View
      testID={`item-laundry-${item.id}`}
      // `pointerEvents` in the STYLE, not as the legacy prop React Native has
      // been deprecating — and RNTL reads both, so the modern form costs
      // nothing in testability. See the header for what it does and does not
      // buy.
      style={styles.overlay}
    >
      <View testID={`item-laundry-plate-${item.id}`} style={styles.plate}>
        {/* Decorative. The Pressable above the tile already speaks the status
            (see `ItemTile`'s accessibility label), and a screen reader has
            nothing useful to say about a pictogram of a water droplet — while
            leaving it reachable would make TalkBack read every in-laundry cell
            twice.

            `allowFontScaling={false}` is pinned rather than inherited, exactly
            as the category badge's glyph is: `@expo/vector-icons` renders a
            glyph as `<Text>` and sets this in the icon class's `defaultProps`,
            which React 19 has already removed for function components. The day
            the library converts `Icon` to one, an unpinned glyph would start
            growing with the OS font size and push the caption out of a plate
            sized for a single line. The LABEL below deliberately still
            scales. */}
        <Ionicons
          testID={`item-laundry-icon-${item.id}`}
          name="water-outline"
          size={11}
          color={LAUNDRY_INK}
          allowFontScaling={false}
          accessible={false}
        />
        {/* Deliberately NOT `allowFontScaling={false}`, unlike the glyph. A
            user who has turned up the OS font size needs to be able to read
            the caption; a pictogram carries no such information. The cost is
            that the words can outgrow the plate at large scales, and
            `numberOfLines={1}` is what handles that — an ellipsis is a better
            outcome than text nobody can read. */}
        <Text
          testID={`item-laundry-label-${item.id}`}
          style={styles.label}
          numberOfLines={1}
          accessible={false}
        >
          {IN_LAUNDRY_LABEL}
        </Text>
      </View>
    </View>
  );
}

/**
 * Near-black plate, white ink.
 *
 * Named constants because the glyph takes its colour through a `color` PROP
 * while the caption takes it through a style — two different mechanisms that
 * must not drift, and the badge's greyscale-contrast test reads both.
 *
 * FULLY OPAQUE, which is stricter than the category badge's `rgba(17, 17, 17,
 * 0.82)` and stricter on purpose. Two reasons. The tile behind this is a
 * photograph of anything at all, from a white shirt to a black coat, and this
 * caption is the one thing that has to be readable over every one of them. And
 * a translucent plate composites with an unknown backdrop, so its rendered
 * luminance is not knowable from the style at all — the greyscale claim could
 * not be checked, only asserted.
 */
// The Soft palette's own near-black and off-white, not a second pair of
// greys beside them. Fully opaque, and >= 4.5:1 either way — both are
// asserted by this component's own tests, because a caption nobody can read
// over a photograph is the failure this badge exists to prevent.
const LAUNDRY_PLATE = color.ink;
const LAUNDRY_INK = color.shell;

const styles = StyleSheet.create({
  // Written out rather than `StyleSheet.absoluteFillObject`: RN 0.86 no longer
  // declares that member (only `absoluteFill`), and four properties are
  // clearer than a helper that has to be spread anyway.
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
  },
  plate: {
    backgroundColor: LAUNDRY_PLATE,
    borderRadius: radius.pill,
    paddingHorizontal: 9,
    paddingVertical: 4,
    maxWidth: '92%',
    // React Native's default is `column`, which would stack the droplet on top
    // of the words inside a plate sized for a single line.
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    // A pale hairline so the near-black plate stays visible against a black
    // coat, the same trick the colour swatches use against a white garment.
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.75)',
  },
  label: { color: LAUNDRY_INK, fontFamily: font.bold, fontSize: 11 },
});
