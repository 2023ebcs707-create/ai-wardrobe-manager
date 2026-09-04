/**
 * DIRECTION 05 — "SOFT". The design tokens, and the only place a colour,
 * radius or shadow is allowed to be written down.
 *
 * These are the same values the HTML mockup in `design/05-soft.html` declares
 * as CSS custom properties, transcribed rather than reinvented — that file is
 * the signed-off artefact, so a value here that drifts from it is a bug in
 * this file. Names match the CSS variables one-for-one (`--shell` -> `shell`)
 * so the two can be diffed by eye.
 *
 * The palette is warm-neutral on purpose. Every accent in this app is meant to
 * come from the user's own garments — the k-means colours the AI service
 * extracts — not from a brand colour, so the chrome deliberately has almost no
 * hue of its own and `sage`/`blush` appear only where a state genuinely needs
 * naming.
 */

export const color = {
  /** Page background. Warm off-white; never `#fff`, which reads clinical beside it. */
  shell: '#FDFBF7',
  /** Raised surfaces — cards and panels — so they separate from `shell` without a border. */
  card: '#FFFFFF',
  /** Primary text, and the fill of primary buttons. A warm near-black, not `#000`. */
  ink: '#2A2925',
  /**
   * Secondary text, icons at rest, and every label.
   *
   * DARKER THAN THE MOCKUP, which drew this as `#857F73`. That value is 3.98:1
   * on white and 3.5:1 on `cloud` — below WCAG 1.4.3's 4.5:1, and it is used
   * for 11-13pt text, which is normal text by the guideline's definition
   * (large starts at 18pt, or 14pt bold). It failed on every card caption,
   * every label and every chip at rest, which is most of the words in this app.
   *
   * This value is 5.9:1 on `card`, 5.7:1 on `shell` and 5.0:1 on `cloud` — the
   * three surfaces it is ever set on. Measured in `tokens.test.ts`, which
   * walks the pairings rather than trusting this comment.
   */
  soft: '#6B6559',
  /** Inactive chips, image placeholders, hairlines. The quietest surface. */
  cloud: '#F0EDE5',
  /**
   * The one green. A SURFACE and pip colour — an occasion dot, a service that
   * is up — and never a text colour: at 3.8:1 on white it fails WCAG 1.4.3 for
   * anything a person has to read. `success` below is what the same idea looks
   * like when it has to be legible.
   */
  sage: '#6F8A63',
  /** The one warm accent. Used for "dinner" and for the laundry state. */
  blush: '#DC9C88',

  /* --- derived states, all from the mockup's inline values --- */

  /** Laundry / error plate. Pale enough for `washInk` to clear WCAG AA on it. */
  wash: '#FBEDE8',
  /**
   * Text and glyphs on `wash`, and the colour of every error sentence.
   *
   * Also darker than the mockup's `#DC9C88`-family value: `#B4553C` on `wash`
   * is 4.27:1, which reads fine and fails the guideline. This is 5.0:1.
   */
  washInk: '#A54B33',
  /**
   * Every success sentence in the app — "Saved to your outfits.", "Logged …",
   * "Shared to the community feed."
   *
   * A darker `sage`, at 6.3:1 on `card` and 6.1:1 on `shell`. It replaced five
   * separate literals: two Tailwind greens (`#16a34a` at 3.30:1, which failed,
   * and `#15803d`, which did not) written independently in five files. One
   * token is what stops the next success line being written in a sixth green.
   */
  success: '#4E6644',
  /** Text on `ink` surfaces. */
  onInk: '#FDFBF7',
} as const;

/*
 * THERE IS NO THIRD GREY, and that is a decision rather than an omission.
 *
 * The mockup carried two more — a `faint` for input placeholders and an
 * `ahead` for the numerals on future calendar days — at roughly 2:1 and 1.7:1
 * against the surfaces they sat on. Both are text: a placeholder is the only
 * thing in an empty field and is what tells the user what the field is for,
 * and a date is a date. Neither can be a decorative grey.
 *
 * So both use `soft`, and the states they were drawing are carried by SHAPE
 * instead — a future day is outlined where a past one is filled, which is a
 * distinction that also survives greyscale and a colour-blind reader. That is
 * a better answer than the one the lighter greys were giving.
 */

/**
 * The four occasions the mockup's calendar legend names, plus a fallback.
 *
 * `occasion` is free text in this API (`PublicWearEvent.occasion`, bounded only
 * by `MAX_OCCASION_LENGTH`), so this is a *recognition* table, not an enum: a
 * user who types "gym" gets the neutral pip rather than nothing at all.
 * Lower-cased on lookup because "Work" and "work" are the same occasion to a
 * person looking at a month grid.
 */
const OCCASION_COLORS: Record<string, string> = {
  work: color.sage,
  dinner: color.blush,
  errands: '#8E9BAE',
  birthday: '#D9A441',
};

export function occasionColor(occasion: string | undefined): string {
  if (occasion === undefined) return color.soft;
  return OCCASION_COLORS[occasion.trim().toLowerCase()] ?? color.soft;
}

/** The legend rendered under the calendar grid, in the mockup's order. */
export const OCCASION_LEGEND = Object.entries(OCCASION_COLORS).map(([name, hex]) => ({
  name,
  hex,
}));

/**
 * A 4-point spacing scale. Screen gutters are 20 and card padding is 16 across
 * the whole design; those two are named rather than left as magic numbers
 * because every screen repeats them.
 */
export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  /** The horizontal gutter every screen aligns to. */
  gutter: 20,
} as const;

export const radius = {
  sm: 11,
  md: 13,
  lg: 16,
  card: 20,
  hero: 26,
  /** Anything that should read as a lozenge: chips, buttons, pips. */
  pill: 999,
} as const;

/**
 * The card lift. Two shadows in CSS — a 1px contact shadow and a wide soft one
 * — collapse to a single elevation on Android, which is the only platform this
 * app ships to, so the wide one is what is modelled here.
 */
export const shadow = {
  card: {
    shadowColor: '#2A2925',
    shadowOpacity: 0.09,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 2,
  },
} as const;
