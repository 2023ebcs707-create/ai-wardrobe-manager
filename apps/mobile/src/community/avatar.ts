/**
 * The initials avatar — what a post card draws when its author has no picture,
 * which is **every author in the product as it stands** (ruling 6).
 *
 * `User.avatarUrl` is a real field on the schema and `PostAuthor` carries it,
 * but nothing in this system ever writes one: there is no upload flow, and no
 * submitted document claims one. Phase 3 nonetheless claims "User avatars and
 * usernames displayed on each post card" in the present tense. A card that
 * renders "the picture, or else a blank circle" therefore renders a blank
 * circle on every post in the app — a documented UI element that is an empty
 * hole. An initials avatar is an avatar; a blank circle is not.
 *
 * Both functions here are pure and deterministic so they can be tested
 * directly, and the colour is checked the way Stage 6 checked the laundry
 * badge: **as luminance**, not as hue. See `AVATAR_COLOURS`.
 */

/**
 * The ink every initials avatar is written in.
 *
 * One colour rather than a per-background choice, because a contrast rule that
 * picks its ink can be satisfied by a palette entry that is unreadable under
 * the OTHER ink — and there is then no single pair to assert. With the ink
 * fixed, "is this readable?" is one question per palette entry.
 */
export const AVATAR_INK = '#ffffff';

/**
 * The backgrounds an initials avatar can take.
 *
 * **Every entry is dark enough to carry white text at WCAG AA (4.5:1), and
 * that is checked as a LUMINANCE ratio rather than asserted by eye.** Relative
 * luminance is the greyscale value of a pixel, so a ratio computed from two of
 * them is the contrast the disc and its letters have after a screenshot has
 * been desaturated — which is also the contrast a user who cannot separate
 * those two hues sees. A palette picked by hue would pass an "is it colourful"
 * review and fail both of those readers; the test in `avatar.test.ts` scores
 * every entry against `AVATAR_INK` and demonstrates, on the same helper, that a
 * red-on-blue pair does not reach the bound.
 *
 * Twelve entries: enough that two authors side by side in a two-column feed
 * rarely collide, few enough that they are all checked. Collisions are not a
 * defect in any case — the name is beside the disc, and the disc is
 * decoration, not identity.
 */
export const AVATAR_COLOURS = [
  '#1d4ed8',
  '#b91c1c',
  '#047857',
  '#6d28d9',
  '#b45309',
  '#0f766e',
  '#be185d',
  '#4338ca',
  '#15803d',
  '#c2410c',
  '#0369a1',
  '#7e22ce',
] as const;

/**
 * What an initials avatar shows when the name it is given has no letters in it
 * at all.
 *
 * Not reachable through the real API — `registerSchema` requires a name and
 * `PostAuthor.name` is documented as always present — but `apiRequest` ends in
 * `parsed as T`, so the declared type is an assertion about the wire rather
 * than a guarantee from it, and this function's whole job is to answer a
 * string. Returning `''` would put an empty coloured disc on the card, which is
 * the blank circle this module exists to avoid.
 */
export const AVATAR_FALLBACK_INITIAL = '?';

/**
 * A display name → the one or two letters drawn inside the disc.
 *
 * The FIRST and LAST words, so "Ada Lovelace" is `AL` and "Ada Byron King" is
 * `AK` — the convention a reader expects from a monogram. One word gives one
 * letter rather than two letters of the same word: `AD` for "Ada" reads as a
 * two-word name that does not exist.
 *
 * ## Two things this deliberately does not do
 *
 * It does not special-case `'Deleted user'`. A post outlives its author and
 * arrives as `{ id, name: 'Deleted user' }` when the account is gone — but that
 * is also a legal display name, byte-identical on the wire, so this layer
 * cannot tell a tombstone from a real person called that and must not try. It
 * gets `DU`, like any other two-word name.
 *
 * It does not slice with `[0]`. A name beginning with an astral character — an
 * emoji, or anything outside the Basic Multilingual Plane — is two UTF-16 code
 * units, and taking one of them yields a lone surrogate that renders as a
 * replacement character. `Array.from` iterates code points.
 */
export function initials(name: string): string {
  const words = name.split(/\s+/u).filter((word) => word.length > 0);
  if (words.length === 0) return AVATAR_FALLBACK_INITIAL;

  const first = Array.from(words[0])[0];
  // One word means one letter — see above.
  if (words.length === 1) return first.toUpperCase();

  const last = Array.from(words[words.length - 1])[0];
  return `${first}${last}`.toUpperCase();
}

/**
 * A user id → the same background colour every time, anywhere in the app.
 *
 * Keyed on the id rather than on the name, deliberately: a user who changes
 * their display name keeps their disc colour, and two different people who
 * happen to share a name do not get the same one. Author names are resolved on
 * every read rather than snapshotted (ruling 5), so a name-keyed colour would
 * visibly change under a post that did not.
 *
 * The hash is FNV-1a over UTF-16 code units — small, dependency-free, and with
 * no requirement on it beyond being a deterministic function of the string.
 * `>>> 0` keeps it unsigned so the modulus cannot go negative and index past
 * the start of the palette.
 */
export function avatarColor(userId: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < userId.length; index += 1) {
    hash ^= userId.charCodeAt(index);
    // FNV prime, via shifts: `hash * 16777619` overflows the 53-bit safe
    // integer range for long strings and starts losing low bits, which is
    // where a hash's variation lives.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return AVATAR_COLOURS[hash % AVATAR_COLOURS.length];
}
