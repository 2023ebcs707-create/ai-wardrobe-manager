import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { ITEM_CATEGORIES, type ItemCategory } from '@wardrobe/shared';
import { categoryLabel } from '../format/text';
import { space } from '../theme/tokens';
import { Chip } from '../theme/ui';

export interface CategoryFilterProps {
  /** `null` is "All" — the same value the hook uses for "no filter". */
  value: ItemCategory | null;
  onChange: (next: ItemCategory | null) => void;
}

/**
 * The wardrobe's category chip row (FR4 / TC-06).
 *
 * Two things this component must never do:
 *
 * 1. **Emit the string `'all'`.** "All" means *no* `category` parameter is
 *    sent, not `category=all`: `all` is not a member of `ITEM_CATEGORIES` and
 *    `GET /items?category=all` answers 400 rather than returning everything.
 *    `null` is the value `useWardrobe().setCategory` reads as "no filter", and
 *    its fetch spreads the parameter in conditionally.
 * 2. **Hardcode the category list.** It is rendered from `ITEM_CATEGORIES`, so
 *    adding a category to the shared package cannot leave this row behind.
 *
 * Deviation from the plan, recorded deliberately: the plan drafted the "All"
 * chip as emitting `undefined`. Task 3's final hook contract settled on
 * `ItemCategory | null` for both `category` and `setCategory`, so `undefined`
 * would need a `?? null` shim at the only call site and would contradict this
 * component's own `value` type. `null` throughout is the same decision, spelled
 * consistently.
 */
export function CategoryFilter({ value, onChange }: CategoryFilterProps) {
  return (
    <ScrollView
      testID="category-filter"
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.scroller}
      contentContainerStyle={styles.row}
    >
      <Chip
        testID="filter-all"
        label="All"
        accessibilityLabel="Show All items"
        selected={value === null}
        onPress={() => onChange(null)}
      />
      {ITEM_CATEGORIES.map((category) => (
        <Chip
          key={category}
          testID={`filter-${category}`}
          // Written as a person writes it — "T-shirt", not the wire's
          // `tshirt`. `onChange` still emits the raw `ItemCategory`; a label
          // must never reach `GET /items?category=`, which would be a 400.
          label={categoryLabel(category)}
          // The spoken label keeps the wire spelling, so what a screen reader
          // announces still matches what every other surface in this app —
          // the empty-filter message, the item detail screen — calls it.
          accessibilityLabel={`Show ${category} items`}
          selected={value === category}
          onPress={() => onChange(category)}
        />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  /*
   * A horizontal ScrollView has no intrinsic height, so in a column flex
   * parent Yoga is free to give it whatever space is left over — and when a
   * sibling claims that space, the chips are clipped from the bottom rather
   * than the row scrolling. The symptom is nasty precisely because it is not a
   * crash: the pills still lay out at their correct per-label widths, so the
   * row looks deliberate while only the top few pixels of each label survive
   * (the apex of the "A" in "All", the ascenders of "tshirt"), leaving a filter
   * nobody can read.
   *
   * Pinning both directions here rather than in each host is deliberate: the
   * wardrobe grid renders this correctly today only because of how its own
   * siblings happen to be arranged, which is luck rather than a decision. The
   * outfit composer, which adds a fixed save bar below the list, is where that
   * luck ran out. Found on a device in Stage 5's gate; no test in this repo can
   * see a clipped glyph.
   */
  scroller: { flexGrow: 0, flexShrink: 0 },
  row: { flexDirection: 'row', gap: space.sm, paddingHorizontal: space.gutter, paddingBottom: 18 },
});
