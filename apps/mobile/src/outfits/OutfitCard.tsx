import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { PublicOutfit } from '@wardrobe/shared';
import { color, radius, space } from '../theme/tokens';
import { text } from '../theme/type';

/**
 * What an outfit with no name is called on screen.
 *
 * Exported so a test can assert the placeholder without restating it, and so
 * the gallery and the detail screen cannot drift apart on the wording. It is
 * deliberately a description rather than an invented name: an unnamed outfit
 * is valid (neither FR5 nor TC-07 mentions naming one), and a cell with no
 * caption at all is a grid of photographs nobody can tell apart.
 */
export const UNNAMED_OUTFIT = 'Unnamed outfit';

export interface OutfitCardProps {
  /**
   * The LIGHT shape, from `GET /outfits` — a cover, a name and a count.
   *
   * `& { items?: never }` is a compile-time guard, not decoration. Task 3's
   * hand-off note is that the `PublicOutfit` / `PublicOutfitDetail` asymmetry
   * is only half compile-checked: `PublicOutfitDetail extends
   * Omit<PublicOutfit, 'coverUrl'>` and `coverUrl` is optional, so a detail
   * outfit (what `GET /outfits/:id` and `PATCH` answer with) is assignable to
   * `PublicOutfit` and silently carries no cover. The visible result is a cell
   * that falls back to the placeholder after every edit, with no error
   * anywhere. `items?: never` is the one property the two shapes differ on
   * that TypeScript can actually see, so declaring it here turns that silent
   * runtime degradation into a build failure.
   */
  outfit: PublicOutfit & { items?: never };
  /** Called with the outfit's id — never with the outfit, and never with an index. */
  onPress: (id: string) => void;
}

/** `3 items`, `1 item`. */
function countLabel(itemCount: number): string {
  return `${itemCount} ${itemCount === 1 ? 'item' : 'items'}`;
}

/**
 * One cell of the outfit gallery (FR5 / TC-07, "visible in outfit gallery").
 *
 * Two columns rather than the wardrobe's three, and that is a caption problem
 * rather than a taste one: a cell here carries a cover AND a name AND a count,
 * and a third of a phone's width leaves the name a two-word ellipsis.
 */
export function OutfitCard({ outfit, onPress }: OutfitCardProps) {
  /**
   * Whether there is a picture to draw.
   *
   * Wider than `coverUrl !== undefined`, deliberately. `toPublicOutfit`
   * spreads the key in only when it is truthy, so `''` is not reachable
   * through the API today — but nothing between the socket and here validates
   * the response (`apiRequest` ends in `return parsed as T`), and an `<Image>`
   * with an empty uri is the broken tile the placeholder exists to replace,
   * wearing a different costume.
   *
   * The cover itself is absent whenever the outfit's first item no longer
   * resolves. That is not an error state — there is no cascade delete in this
   * system, so deleting a garment leaves its id on every outfit that used it —
   * and a gallery must degrade to a placeholder rather than fail.
   */
  const cover = typeof outfit.coverUrl === 'string' && outfit.coverUrl !== '' ? outfit.coverUrl : null;
  const name = outfit.name ?? UNNAMED_OUTFIT;
  const count = countLabel(outfit.itemCount);

  return (
    <Pressable
      testID={`outfit-card-${outfit.id}`}
      style={styles.cell}
      onPress={() => onPress(outfit.id)}
      accessibilityRole="button"
      // A cover photograph is silent to a screen reader, and so is a grid of
      // them. The name and the count are the two things that make one cell
      // distinguishable from the next.
      accessibilityLabel={`${name}, ${count}`}
      accessibilityHint="Opens this outfit's details"
    >
      {/* The inner view carries the visible surface; the outer cell owns the
          width and the gutter. Keeping them separate is what lets the gutter be
          padding rather than a flex gap — a gap would be distributed across a
          partial last row, a padding is not. */}
      <View style={styles.surface}>
        {cover !== null ? (
          <Image
            testID={`outfit-cover-${outfit.id}`}
            source={{ uri: cover }}
            style={styles.cover}
            resizeMode="cover"
            // Explicit rather than inherited, and the comment that used to sit
            // here overstated it. An RN `Image` with no `accessibilityLabel` is
            // already not an accessibility element on Android, AND the
            // `accessible` Pressable above absorbs its children into one node
            // — so removing this prop changes nothing about what TalkBack says
            // TODAY, and two mutations of it survived the suite until this
            // assertion was added. What it does is make the decision explicit:
            // the cell's label is the outfit's name and count, and a future
            // label on this photograph would have to be a deliberate act
            // rather than an accident. Asserted so it cannot be dropped
            // silently.
            accessible={false}
          />
        ) : (
          <View testID={`outfit-cover-placeholder-${outfit.id}`} style={styles.coverPlaceholder}>
            {/* A neutral mark rather than a blank grey square, so the cell reads
                as "no picture" instead of "still loading". Whether the glyph
                actually renders is something RNTL cannot see — every tab icon
                in this app rendered as tofu for a whole stage while the tests
                were green — so Task 6's screenshot is what proves it. */}
            <Ionicons
              testID={`outfit-cover-icon-${outfit.id}`}
              name="shirt-outline"
              size={28}
              color={color.soft}
              allowFontScaling={false}
              accessible={false}
            />
          </View>
        )}
      </View>

      <Text testID={`outfit-name-${outfit.id}`} style={styles.name} numberOfLines={1}>
        {name}
      </Text>
      {/* `itemCount` rather than `itemIds.length`. They agree today —
          `outfitBase` sets `itemCount: itemIds.length` — and `itemCount` is the
          field that carries the meaning, so it stays right if the list response
          ever trims the ids it ships. */}
      <Text testID={`outfit-count-${outfit.id}`} style={styles.count}>
        {count}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Half the row, NOT `flex: 1`. With `flex: 1` a final row holding one cell
  // stretches it across the whole width, so an odd-numbered gallery ends in one
  // full-bleed cover under a column of half-width ones.
  cell: { width: '50%', padding: space.sm },
  surface: {
    // 4:3 rather than square: outfit covers are photographs of garments, and
    // the wardrobe grid's square crop already loses the top and bottom of a
    // portrait shot. Whether the crop actually looks right is a device
    // property; the device gate photographs it.
    aspectRatio: 4 / 3,
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: color.cloud,
  },
  // Written out rather than `StyleSheet.absoluteFillObject`: RN 0.86 no longer
  // declares that member (only `absoluteFill`).
  cover: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  coverPlaceholder: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.cloud,
  },
  // `numberOfLines={1}` above rather than a smaller font: a long name
  // ellipsised is readable, and a name that reflows pushes the count out of
  // every cell in its row.
  name: { ...text.title, fontSize: 16, paddingTop: 9 },
  count: { ...text.meta, paddingTop: 2 },
});
