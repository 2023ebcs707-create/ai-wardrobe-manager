import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ItemColor, PublicClothingItem } from '@wardrobe/shared';
import { IN_LAUNDRY_LABEL, LaundryBadge, isInLaundry } from '../tracking/LaundryBadge';
import { RETIRED_LABEL, RetiredBadge, isRetired } from './RetiredBadge';
import { categoryLabel } from '../format/text';
import { color, radius, shadow, space } from '../theme/tokens';
import { font, text } from '../theme/type';
import { Glow, Pip } from '../theme/ui';

export interface ItemTileProps {
  item: PublicClothingItem;
  /** Called with the item's id — never with the item, and never with an index. */
  onPress: (id: string) => void;
  /**
   * Whether this tile is part of the outfit being composed (Stage 5, FR5 /
   * TC-07) — and, by its mere PRESENCE, whether the tile is part of a
   * selection UI at all.
   *
   * - `undefined` — the wardrobe grid. The tap opens the item's details.
   * - `false` / `true` — the outfit composer. The tap toggles membership.
   *
   * **Optional on purpose, and that is load-bearing.** `app/(tabs)/index.tsx`
   * renders `<ItemTile item={item} onPress={openItem} />` with neither
   * selection prop; making this required breaks Stage 4's grid at compile
   * time. (That is deliberately checkable — it is one of this task's
   * mutations.)
   *
   * Deriving "selectable" from the presence of this prop rather than adding a
   * third one keeps the composer's two-state tap (add / remove) and the grid's
   * one-state tap (open) apart without the grid changing at all.
   */
  selected?: boolean;
  /**
   * 1-based position in the selection — the number the user sees on the tile.
   *
   * Ignored unless `selected` is true, so a stale index left behind by a
   * deselect cannot paint a number onto an unselected tile. The composer
   * derives this from the *position* of the id in its selection array rather
   * than storing it, which is what makes a middle deselect renumber the rest.
   */
  selectionIndex?: number;
  /**
   * Which of the two grids this tile is in. Two layouts, because the two grids
   * are answering different questions.
   *
   * - `'card'` — the wardrobe (`app/(tabs)/index.tsx`), two up. A garment gets
   *   room for its name, its dominant colour and how often it has been worn,
   *   and the card is lit from behind by the item's own extracted palette.
   *   This is where the Soft direction's signature lives; a third column would
   *   leave no space for any of it.
   * - `'tile'` — the outfit composer, three up. Nothing but the photograph and
   *   the four corner marks, because the user is scanning for a garment they
   *   already have in mind and density is the whole point.
   *
   * Defaults to `'tile'`: the composer is the caller that has always existed,
   * and a default that silently changed its grid would be the wrong way round.
   *
   * The cell's width comes from this rather than from the host's `numColumns`,
   * which is a coupling worth naming — a caller that passes `numColumns={3}`
   * and `layout="card"` gets three half-width cells in a row. The alternative
   * is `flex: 1`, and that is worse for the reason the `tile` style records:
   * a final row holding one item would stretch it across the whole screen.
   */
  layout?: 'card' | 'tile';
}

/**
 * One square cell of the wardrobe grid (FR4 / TC-06), carrying the "tag icon
 * for quick attribute viewing" the Phase 3 feature list promises: a category
 * badge plus a dot row of the item's colours.
 *
 * The tile is square via `aspectRatio: 1` rather than a computed pixel height,
 * so three columns lay out correctly on any screen width without measuring one.
 */
export function ItemTile({ item, onPress, selected, selectionIndex, layout = 'tile' }: ItemTileProps) {
  const isCard = layout === 'card';
  // See `selected` above: the prop's presence is the mode switch, its value is
  // the state. `selected === true` rather than a truthiness check so that the
  // two are never conflated by accident.
  const selectable = selected !== undefined;
  const isSelected = selected === true;

  /**
   * FR7 / TC-09, the laundry treatment.
   *
   * Read off `item.laundryStatus` and off NOTHING else — there is deliberately
   * no `inLaundry` prop beside `selected`. The status already travels on every
   * `PublicClothingItem` the grid renders, so a prop would add a second source
   * for the same fact and let a caller pass a garment that is in the wash with
   * a `false` next to it. The type system would accept it and the tile would
   * render a lie.
   *
   * One reading, shared by the badge and the dimming below, so the two cannot
   * be changed apart: a dimmed photograph with no caption is indistinguishable
   * from an image that failed to load.
   */
  const inLaundry = isInLaundry(item);
  /**
   * Whether the item is out of the active wardrobe. Read off `item.retired`
   * and nothing else, for the identical reason `inLaundry` is: one reading,
   * shared by the badge and the dimming below.
   *
   * TAKES PRECEDENCE over the laundry treatment when both are true — see
   * `retiredOrInLaundry` below and `RetiredBadge`'s header for why: retired is
   * the more final of the two facts, and the tile's one free centre slot can
   * only hold one caption at a time.
   */
  const retired = isRetired(item);
  const retiredOrInLaundry = retired || inLaundry;

  // Pre-Stage-4 uploads have no thumbnail — nothing ever wrote `thumbnailKey`
  // until Task 2 of this stage — and the full image is what keeps them
  // visible. Every layer below this one treats the thumbnail as optional on
  // purpose (the API accepts an upload without one, `thumbnailUrl` is
  // optional on `PublicClothingItem`); this is where that optionality is
  // finally cashed in.
  const uri = item.thumbnailUrl ?? item.imageUrl;

  // Card layout only, but computed unconditionally: it is a reduce over at
  // most a handful of colours, and a hook-free conditional is not worth the
  // second code path.
  const dominant = dominantColour(item.colors);

  const colourNames = item.colors.map((colour) => colour.name).filter((name) => name.length > 0);
  // A grid of photographs is silent to a screen reader. The category is the
  // one attribute that makes a cell identifiable, and the colours are what
  // distinguish two cells of the same category from each other.
  const describedItem =
    colourNames.length > 0 ? `${item.category}, ${colourNames.join(', ')}` : item.category;

  // The ordinal is in the LABEL as well as on the tile because
  // `accessibilityState.selected` announces *that* an item is in the outfit
  // and never *where*. Position is the one thing the badge carries that the
  // state cannot, and it is the thing that makes "top, trousers, shoes" read
  // correctly — so a screen-reader user has to get it too.
  const selectionDescribed =
    isSelected && selectionIndex !== undefined
      ? `${describedItem}, item ${selectionIndex} of the outfit`
      : describedItem;

  // The retired/laundry status, spoken — retired taking the same precedence
  // as the visual badge, so the one thing a screen reader says never claims
  // more than the one caption a sighted user sees.
  //
  // A badge and a dimmed photograph are both invisible to a screen reader, so
  // without this the treatment simply does not exist for a TalkBack user — and
  // TC-09's claim is that the item is *distinguished*, not that it is
  // distinguished for people who can see it.
  //
  // It goes in the LABEL and NOT in `accessibilityState`. `disabled` would be
  // the wrong word and an actively harmful one: an item in the wash — or a
  // retired one — is annotated, not disabled. The tap still opens its
  // details, the composer still lets an in-laundry item into an outfit (a
  // retired one is filtered out upstream — see `OutfitComposer`), and
  // TalkBack announces a disabled control as unavailable — telling the user
  // the cell does nothing, which is false. There is no `accessibilityState`
  // member that means "annotated".
  const accessibilityLabel = retired
    ? `${selectionDescribed}, ${RETIRED_LABEL}`
    : inLaundry
      ? `${selectionDescribed}, ${IN_LAUNDRY_LABEL}`
      : selectionDescribed;

  // "Opens this item's details" is simply false inside the composer, where the
  // same tap adds or removes the item.
  const accessibilityHint = selectable
    ? isSelected
      ? 'Removes this item from the outfit'
      : 'Adds this item to the outfit'
    : "Opens this item's details";

  return (
    <Pressable
      testID={`item-tile-${item.id}`}
      style={isCard ? styles.cell : styles.tile}
      onPress={() => onPress(item.id)}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      // The one selection fact a test can assert and the one a screen reader
      // can hear. A border is a pixel property; this is not.
      //
      // Always set, including in the wardrobe grid where it is `false`:
      // Android maps this to `AccessibilityNodeInfo.setSelected(false)`, which
      // is already the default for every node, so the grid is unaffected.
      accessibilityState={{ selected: isSelected }}
    >
      {/* The inner view is what carries the visible surface; the outer cell
          owns the width and the gutter. Keeping them separate is what lets the
          gutter be padding rather than a flex gap — see the `tile` style. */}
      <View
        testID={`item-surface-${item.id}`}
        style={[isCard ? styles.card : styles.surface, isSelected && styles.surfaceSelected]}
      >
        {/* THE SIGNATURE. The card is lit from behind by the garment's own
            k-means colours, so a wardrobe screen takes on the palette of the
            clothes in it. Card layout only: at three columns there is no
            surface for it to bloom across, and it would read as a smudge.

            First child, so everything below paints over it — `Glow` is
            absolutely positioned and RN resolves overlap by document order. */}
        {isCard ? <Glow colors={item.colors} /> : null}

        <View style={isCard ? styles.shot : styles.fill}>
          <Image
            testID={`item-image-${item.id}`}
            source={{ uri }}
            // The second, independent channel of the laundry treatment: a
            // LUMINANCE change, which survives desaturation exactly as the
            // badge's contrast does — a tint would not. Applied to the image
            // alone rather than to the surface, so the caption over it stays at
            // full strength; dimming the whole surface would dim the one thing
            // that has to stay readable. Shared with the retired treatment —
            // same dip, whichever caption is showing above it.
            style={[styles.image, retiredOrInLaundry && styles.imageInLaundry]}
            resizeMode="cover"
            // Decorative here: the Pressable above already carries the label, so
            // an image label would make a screen reader read every cell twice.
            accessible={false}
          />

          {/* The category, as a plate over the photograph — TILE LAYOUT ONLY.

              Solid background, not coloured text laid straight over the photo:
              a tile's image can be anything from a white shirt to a black coat,
              and text without a plate behind it is unreadable over one of them.
              Whether the result is *actually* legible is a pixel property of a
              real screen; RNTL can only assert the plate exists.

              The card layout does not render it, and that is not a loss: there
              the category is the card's TITLE, in full and at 14pt, which is
              strictly more prominent than a 10pt overlay. A plate saying
              "jacket" directly above a caption saying "Jacket" would be the
              same word twice. */}
          {isCard ? null : (
            <View testID={`item-badge-${item.id}`} style={styles.badge}>
              {/* The "tag icon ... for quick attribute viewing" the Phase 3
                  feature list promises.

                  Decorative, hence `accessible={false}`: the Pressable above
                  already carries an accessibility label naming the category and
                  the colours, and a screen reader has nothing useful to say
                  about a pictogram of a price tag. Sized against `badgeText`'s
                  10pt rather than the icon default of 12, so the glyph reads as
                  a mark beside the word instead of looming over it.

                  `allowFontScaling={false}` is already the effective default —
                  `@expo/vector-icons` sets it in the icon class's `defaultProps`
                  — but it is pinned here rather than inherited. React has been
                  withdrawing `defaultProps` (already gone for function
                  components in React 19), so the day this library converts
                  `Icon` to a function component, the badge would silently start
                  growing its glyph with the OS font-size setting and squeezing
                  the longest category names out of a plate capped at 90% of a
                  one-third-width tile. The label below deliberately still
                  scales; see the note on `badgeText`. */}
              <Ionicons
                testID={`item-tag-icon-${item.id}`}
                name="pricetag-outline"
                size={10}
                color={color.shell}
                allowFontScaling={false}
                accessible={false}
              />
              {/* The category as a word. `tshirt` at 10pt inside a dark plate
                  reads as a typo rather than as a category; the accessible
                  label on the Pressable above keeps the wire spelling, which
                  is what a screen reader hears. */}
              <Text testID={`item-category-${item.id}`} style={styles.badgeText} numberOfLines={1}>
                {categoryLabel(item.category)}
              </Text>
            </View>
          )}

          {/* The selection ordinal (Stage 5, FR5 / TC-07).

              Rendered as well as the border, never instead of it: a border on
              its own is a colour change, and roughly one man in twelve cannot
              rely on one. It is also not decoration — the order is what
              `POST /outfits` stores and what makes an outfit read as "top,
              trousers, shoes" rather than "shoes, top, trousers" — so the user
              has to be able to see which position a tile holds.

              Top-right, the one free corner: the category badge owns top-left
              and the colour swatches own bottom-right.

              `allowFontScaling={false}`, unlike the category label above it,
              which deliberately scales. This number lives inside a fixed-
              diameter circle and would be clipped rather than merely cramped at
              large OS font sizes — and unlike the category, it is *also*
              carried by the accessibility label above, so a user who needs
              large text has a second, unclipped route to it. */}
          {isSelected ? (
            <View testID={`item-selection-${item.id}`} style={styles.selectionBadge}>
              <Text style={styles.selectionBadgeText} allowFontScaling={false} accessible={false}>
                {selectionIndex}
              </Text>
            </View>
          ) : null}

          {item.colors.length > 0 ? (
            <View testID={`item-swatches-${item.id}`} style={styles.swatches}>
              {item.colors.map((colour, index) => (
                <View
                  // Colours are a fixed, ordered attribute of one item and never
                  // reorder or page, so index is a legitimate key here — unlike
                  // the grid itself, where it would be a defect.
                  key={`${colour.hex}-${index}`}
                  testID={`item-swatch-${item.id}`}
                  style={[styles.swatch, { backgroundColor: colour.hex }]}
                />
              ))}
            </View>
          ) : null}

          {/* FR7 / TC-09, plus the retired treatment. Driven by the item, not
              by a prop — see `inLaundry`/`retired` above — and genuinely the
              LAST child of the photograph, so it paints over it AND over the
              other three marks rather than under them. It takes the centre,
              the one region the category badge (top-left), the selection
              ordinal (top-right) and the colour swatches (bottom-right)
              cannot reach.

              MUTUALLY EXCLUSIVE, never both: the centre slot holds one
              caption, and a retired item takes precedence — it is the more
              final of the two facts. See `RetiredBadge`'s header for why this
              is a second component rather than a third `LaundryBadge` state. */}
          {retired ? <RetiredBadge item={item} /> : <LaundryBadge item={item} />}
        </View>

        {/* The caption — CARD LAYOUT ONLY. What the garment is, the colour the
            AI actually measured, and how much use it has had. The third line
            is the one the wardrobe is for: a piece worn twice in a year is the
            thing this app exists to surface, and it is invisible on a grid of
            photographs alone. */}
        {isCard ? (
          <View style={styles.caption}>
            <Text testID={`item-category-${item.id}`} style={styles.name} numberOfLines={1}>
              {categoryLabel(item.category)}
            </Text>
            {dominant === undefined ? null : (
              <View style={styles.colourRow}>
                <Pip hex={dominant.hex} />
                <Text style={styles.meta} numberOfLines={1}>
                  {dominant.name}
                </Text>
              </View>
            )}
            <Text style={styles.meta}>
              {item.wearCount === 0 ? 'Not worn yet' : `Worn ${item.wearCount}\u00d7`}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

/**
 * The colour with the largest measured share, or the first when the service
 * did not report shares.
 *
 * `share` is optional on `ItemColor` and the k-means pass does not always fill
 * it in — an upload whose AI tagging degraded to `source: 'manual'` carries
 * colours with no proportions at all. Sorting by a missing share would put an
 * arbitrary colour first; falling back to the API's own order does not pretend
 * to know something it was not told.
 */
function dominantColour(colours: readonly ItemColor[]): ItemColor | undefined {
  if (colours.length === 0) return undefined;
  return colours.reduce((best, next) => ((next.share ?? 0) > (best.share ?? 0) ? next : best));
}

const styles = StyleSheet.create({
  // A third of the row, NOT `flex: 1`. With `flex: 1` a final row holding one
  // or two items stretches them across the whole width, so the last row of an
  // 8-item wardrobe renders two full-bleed squares under six small ones. A
  // fixed fraction keeps every cell the same size whatever the row holds, and
  // the gutter is this cell's padding rather than a flex `gap` for the same
  // reason — a gap would be distributed, a padding is not.
  tile: { width: '33.333%', aspectRatio: 1, padding: 4 },
  // The card layout's cell. Half the row, and deliberately NOT square: the
  // caption below the photograph is what makes the height, so pinning an
  // aspect ratio here would either clip it or leave a gap under it.
  cell: { width: '50%', padding: space.sm },

  surface: {
    flex: 1,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: color.cloud,
  },
  card: {
    backgroundColor: color.card,
    borderRadius: radius.card,
    padding: 10,
    paddingBottom: 13,
    // Required, and not merely tidy: `Glow` fills the card absolutely and
    // would otherwise paint over the rounded corners as a square.
    overflow: 'hidden',
    ...shadow.card,
  },
  // The photograph inside a card. Square here, where the caption is a sibling
  // rather than an overlay.
  shot: {
    aspectRatio: 1,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: color.cloud,
  },
  // The photograph inside a tile, where the surface IS the photograph. A
  // wrapper rather than putting the marks straight on the surface, so both
  // layouts position their overlays against the same box.
  fill: { flex: 1 },

  // The border is drawn on the surface rather than on the outer cell so it
  // hugs the image's rounded corners instead of the cell's transparent
  // padding. `overflow: 'hidden'` above already clips the image to that
  // radius, and a border on a clipped view insets the content rather than
  // overlapping it — which is what makes the ring read as a frame around the
  // garment. Whether 3pt is *visible enough* on a real screen is a pixel
  // property RNTL cannot reach. What is asserted here is only that the mark is
  // not colour alone (the ordinal is the other half).
  surfaceSelected: { borderWidth: 3, borderColor: color.ink },
  // Written out rather than `StyleSheet.absoluteFillObject`: RN 0.86 no longer
  // declares that member (only `absoluteFill`), and four properties are
  // clearer than a helper that has to be spread anyway.
  image: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  // Dimmed, not hidden and not greyed to nothing: the user still has to be
  // able to recognise the garment, because leaving in-laundry items in the
  // grid is the whole point — the treatment informs the choice rather than
  // making it. What value reads as "in the wash" rather than as "this image
  // failed to load" is a pixel property of a real screen; the centred caption
  // over it is the argument that this one does, and the device gate is what
  // settles whether the argument holds.
  imageInLaundry: { opacity: 0.45 },

  badge: {
    position: 'absolute',
    left: 5,
    top: 5,
    maxWidth: '90%',
    // The palette's own near-black at 82%, so the plate stays a plate rather
    // than becoming a second grey. Opacity, not a solid: a fully opaque block
    // on a small tile reads as a sticker.
    backgroundColor: 'rgba(42, 41, 37, 0.82)',
    borderRadius: radius.pill,
    paddingHorizontal: 7,
    paddingVertical: 3,
    // React Native's default is `column`, which would stack the tag glyph on
    // top of the category word inside a plate sized for a single line.
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  // Deliberately NOT `allowFontScaling={false}` on the label, unlike the
  // glyph beside it. A user who has turned up the OS font size needs to be
  // able to read the category; a pictogram carries no such information. The
  // cost is that the word can outgrow the plate at large scales, and
  // `numberOfLines={1}` is what handles that — an ellipsis is a better
  // outcome than text nobody can read.
  badgeText: { color: color.shell, fontFamily: font.semibold, fontSize: 10 },

  selectionBadge: {
    position: 'absolute',
    right: 5,
    top: 5,
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
    // Same solid plate as the category badge, and for the same reason: the
    // number sits over a photograph that can be any colour at all.
    backgroundColor: color.ink,
    // A pale ring so the dark disc stays visible against a dark garment.
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.9)',
  },
  selectionBadgeText: { color: color.shell, fontFamily: font.bold, fontSize: 12 },

  swatches: {
    position: 'absolute',
    right: 5,
    bottom: 5,
    flexDirection: 'row',
    gap: 3,
  },
  swatch: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: StyleSheet.hairlineWidth,
    // A white swatch on a white garment would otherwise be invisible.
    borderColor: 'rgba(255, 255, 255, 0.9)',
  },

  caption: { marginTop: 10, gap: 3 },
  name: { ...text.name },
  colourRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  meta: { ...text.meta },
});
