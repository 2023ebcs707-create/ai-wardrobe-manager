/**
 * Typography. Fraunces for display, Figtree for everything else.
 *
 * **Never set `fontWeight` beside one of these families.** React Native on
 * Android does not synthesise weights for a custom font: it looks up a
 * registered family by exact name, and `{ fontFamily: 'Figtree_400Regular',
 * fontWeight: '700' }` either renders the regular face or falls back to the
 * system font entirely, depending on the RN version. The weight IS the family
 * name here, which is why every preset below names its face in full and none
 * of them carry a `fontWeight`.
 *
 * The names are the export names of `@expo-google-fonts/*`, and `fonts.ts`
 * registers exactly this set — a preset naming a face that is not in that map
 * renders as the system font with no error.
 */
import { color } from './tokens';

export const font = {
  displayRegular: 'Fraunces_400Regular',
  displayItalic: 'Fraunces_400Regular_Italic',
  displayMedium: 'Fraunces_500Medium',
  body: 'Figtree_400Regular',
  medium: 'Figtree_500Medium',
  semibold: 'Figtree_600SemiBold',
  bold: 'Figtree_700Bold',
} as const;

export const text = {
  /** Screen titles. The mockup's `.disp`. */
  display: {
    fontFamily: font.displayMedium,
    fontSize: 30,
    lineHeight: 34,
    letterSpacing: -0.6,
    color: color.ink,
  },
  /** The second line of a two-line title, set in italic to break the block. */
  displayItalic: {
    fontFamily: font.displayItalic,
    fontSize: 30,
    lineHeight: 34,
    letterSpacing: -0.6,
    color: color.ink,
  },
  /** Section headings inside a screen. The mockup's `.sf-sec h2`. */
  heading: {
    fontFamily: font.displayMedium,
    fontSize: 20,
    lineHeight: 25,
    letterSpacing: -0.4,
    color: color.ink,
  },
  /** A named thing inside a panel — an outfit name, a stat's subject. */
  title: {
    fontFamily: font.displayMedium,
    fontSize: 18,
    lineHeight: 23,
    letterSpacing: -0.3,
    color: color.ink,
  },
  /** The serif italic used for the rule engine's own sentences. */
  rationale: {
    fontFamily: font.displayItalic,
    fontSize: 15,
    lineHeight: 22,
    color: color.ink,
  },
  /** Default running text. */
  body: {
    fontFamily: font.body,
    fontSize: 14,
    lineHeight: 22,
    color: color.ink,
  },
  /** A row's primary line. */
  name: {
    fontFamily: font.semibold,
    fontSize: 14,
    lineHeight: 19,
    letterSpacing: -0.14,
    color: color.ink,
  },
  /** A row's secondary line, and every piece of metadata. */
  meta: {
    fontFamily: font.body,
    fontSize: 12,
    lineHeight: 17,
    color: color.soft,
  },
  /** All-caps-ish eyebrow label. The mockup's `.lbl`. */
  label: {
    fontFamily: font.semibold,
    fontSize: 11,
    lineHeight: 15,
    letterSpacing: 0.44,
    color: color.soft,
  },
  /** Big serif numerals — wear counts, the profile stats. */
  numeral: {
    fontFamily: font.displayMedium,
    fontSize: 28,
    lineHeight: 30,
    color: color.ink,
  },
  /** Button faces. */
  button: {
    fontFamily: font.semibold,
    fontSize: 15,
    lineHeight: 20,
    letterSpacing: -0.15,
  },
} as const;
