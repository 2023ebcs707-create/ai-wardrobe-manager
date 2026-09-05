import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { PublicClothingItem } from '@wardrobe/shared';
import { color, radius } from '../theme/tokens';
import { font } from '../theme/type';

/**
 * The words on the badge, and the words a screen reader speaks — same
 * one-constant-for-both discipline as `IN_LAUNDRY_LABEL` in
 * `../tracking/LaundryBadge`, and for the identical reason: `ItemTile` appends
 * this to its accessibility label, so a badge and a label that could drift
 * apart are two descriptions of the same garment and only one is ever read.
 */
export const RETIRED_LABEL = 'Retired';

/**
 * Is this garment retired — out of the active wardrobe, as opposed to merely
 * in the wash?
 *
 * A named predicate for the same reason `isInLaundry` is one: the badge and
 * `ItemTile`'s dimming must read the exact same fact, and two independent
 * `item.retired` checks are two things that could be changed apart.
 */
export function isRetired(item: PublicClothingItem): boolean {
  return item.retired;
}

export interface RetiredBadgeProps {
  /**
   * The item, whole — not a bare boolean. Same reasoning as `LaundryBadge`:
   * the fact already travels on every `PublicClothingItem` a tile renders, and
   * a separate prop would let a caller pass a retired garment with `false`
   * beside it with nothing to catch the lie.
   */
  item: PublicClothingItem;
}

/**
 * The retired treatment — a captioned centre badge, visually and
 * accessibly identical in structure to `LaundryBadge` (a word, a glyph, and a
 * luminance dip on the photo behind it), but for a different fact.
 *
 * A SEPARATE component rather than a second mode of `LaundryBadge`, and
 * rendered by `ItemTile` in `LaundryBadge`'s place — never alongside it — so
 * the tile's one free centre slot never has two captions competing for it.
 * `ItemTile` picks whichever applies, retired taking precedence: a retired
 * item is out of the wardrobe altogether, which is the more final of the two
 * facts when both happen to be true.
 */
export function RetiredBadge({ item }: RetiredBadgeProps) {
  if (!isRetired(item)) return null;

  return (
    <View testID={`item-retired-${item.id}`} style={styles.overlay}>
      <View testID={`item-retired-plate-${item.id}`} style={styles.plate}>
        {/* Decorative — the Pressable above already speaks the status via
            `ItemTile`'s accessibility label. */}
        <Ionicons
          testID={`item-retired-icon-${item.id}`}
          name="archive-outline"
          size={11}
          color={RETIRED_INK}
          allowFontScaling={false}
          accessible={false}
        />
        <Text
          testID={`item-retired-label-${item.id}`}
          style={styles.label}
          numberOfLines={1}
          accessible={false}
        >
          {RETIRED_LABEL}
        </Text>
      </View>
    </View>
  );
}

// Same near-black/off-white pair as `LaundryBadge`, for the same reason: fully
// opaque so the caption reads over any garment colour, and the pair the
// badge's own contrast test pins.
const RETIRED_PLATE = color.ink;
const RETIRED_INK = color.shell;

const styles = StyleSheet.create({
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
    backgroundColor: RETIRED_PLATE,
    borderRadius: radius.pill,
    paddingHorizontal: 9,
    paddingVertical: 4,
    maxWidth: '92%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.75)',
  },
  label: { color: RETIRED_INK, fontFamily: font.bold, fontSize: 11 },
});
