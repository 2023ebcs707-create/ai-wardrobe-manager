import {
  AVATAR_COLOURS,
  AVATAR_FALLBACK_INITIAL,
  AVATAR_INK,
  avatarColor,
  initials,
} from '../../src/community/avatar';

/**
 * Opacity of a colour, 0..1. The same helper `LaundryBadge.test.tsx` uses:
 * handles the `rgba()`/`rgb()` and 6/8-digit hex forms React Native accepts,
 * and treats anything else as fully opaque, which is what RN does with a bare
 * name.
 */
function alphaOf(colour: string): number {
  const rgba = /^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(colour);
  if (rgba) return rgba[1] === undefined ? 1 : Number(rgba[1]);
  if (colour === 'transparent') return 0;
  const hex8 = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})$/.exec(colour);
  if (hex8) return parseInt(hex8[1], 16) / 255;
  return 1;
}

/** `#fff`, `#ffffff`, `#ffffffff`, `rgb(...)`, `rgba(...)` -> `[r, g, b]`. */
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
 * Lifted from `src/tracking/LaundryBadge.test.tsx`, where Stage 6 introduced it
 * to turn "the badge must not rely on colour alone" into something a test could
 * fail. The equivalence is the whole point: desaturating an image is computing
 * exactly this Y for every pixel and throwing the hue away, so a ratio taken
 * between two relative luminances is the contrast those two colours have after
 * the screenshot has been desaturated — and, equally, the contrast a reader who
 * cannot separate those two hues perceives. Two colours differing only in hue
 * land on the same Y and come out of this at 1.0.
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

/** WCAG AA for body text. */
const AA = 4.5;

describe('initials (ruling 6 — an initials avatar is an avatar, a blank circle is not)', () => {
  it('takes the first letter of the first and last words', () => {
    expect(initials('Ada Lovelace')).toBe('AL');
    // First and LAST, not first and second: a monogram of a three-part name is
    // the outer two, and `AB` for "Ada Byron King" names a person who is not
    // the author.
    expect(initials('Ada Byron King')).toBe('AK');
  });

  it('gives a one-word name one letter', () => {
    // Not `AD`. Two letters of one word reads as a two-word name that does not
    // exist, which is a small lie about a stranger printed on every post they
    // have made.
    expect(initials('Ada')).toBe('A');
  });

  it('uppercases whatever it is given', () => {
    expect(initials('ada lovelace')).toBe('AL');
  });

  it('ignores runs of whitespace rather than turning them into initials', () => {
    expect(initials('  Ada   Lovelace  ')).toBe('AL');
    expect(initials('Ada\tLovelace')).toBe('AL');
  });

  it('treats the tombstone name as the name it is', () => {
    // A post outlives its author and arrives as `'Deleted user'` when the
    // account is gone — but that is ALSO a legal display name, byte-identical
    // on the wire, so this layer cannot tell a tombstone from a real person
    // called that. It gets a monogram like anybody else.
    expect(initials('Deleted user')).toBe('DU');
  });

  it('takes a whole code point, not half a surrogate pair', () => {
    // A name beginning with an astral character is two UTF-16 code units, and
    // `name[0]` yields a lone high surrogate — which renders as a replacement
    // character, so the "avatar" is a coloured disc with a tofu box in it.
    const withEmoji = '\u{1F98A} Fox';
    expect(initials(withEmoji)).toBe('\u{1F98A}F');
    // Decomposed into code points, so the failure is legible rather than two
    // strings that print identically in a diff: `name[0]` answers the lone
    // high surrogate, which `Array.from` reports as its own element.
    expect(Array.from(initials(withEmoji))).toEqual(['\u{1F98A}', 'F']);
  });

  it('answers a visible character for a name with nothing in it', () => {
    // Unreachable through the real API — `registerSchema` requires a name —
    // but `apiRequest` ends in `parsed as T`, so the declared type is an
    // assertion about the wire rather than a guarantee from it. `''` here
    // would be the blank circle this module exists to avoid.
    expect(initials('')).toBe(AVATAR_FALLBACK_INITIAL);
    expect(initials('   ')).toBe(AVATAR_FALLBACK_INITIAL);
    expect(AVATAR_FALLBACK_INITIAL.trim().length).toBeGreaterThan(0);
  });
});

describe('avatarColor', () => {
  it('answers the same colour for the same user every time', () => {
    expect(avatarColor('user-1')).toBe(avatarColor('user-1'));
    expect(avatarColor('68b0f1c2e4a1b2c3d4e5f6a7')).toBe(
      avatarColor('68b0f1c2e4a1b2c3d4e5f6a7'),
    );
  });

  it('answers different colours for different users', () => {
    // A constant here would be a palette in name only — every disc in the feed
    // the same colour, which carries no information at all.
    expect(avatarColor('user-1')).not.toBe(avatarColor('user-2'));
  });

  it('only ever answers a colour from the palette', () => {
    // The palette is what the contrast test below checks. A hash that could
    // index past it would put an unchecked colour — or `undefined` — behind
    // white text.
    const ids = ['', 'a', 'user-1', 'user-2', ...Array.from({ length: 200 }, (_, n) => `u${n}`)];
    ids.forEach((id) => {
      expect(AVATAR_COLOURS).toContain(avatarColor(id));
    });
  });

  it('spreads real ids across the whole palette', () => {
    // Not a distribution guarantee, and not asserted as one: what this rules
    // out is a hash that collapses — one that ignores all but the first
    // character, say, would put every `68b0…` ObjectId on one colour.
    const used = new Set(Array.from({ length: 200 }, (_, n) => avatarColor(`user-${n}`)));
    expect(used.size).toBe(AVATAR_COLOURS.length);
  });
});

describe('avatar contrast — asserted as luminance, the way Stage 6 asserted the badge', () => {
  it('writes every disc in ink that survives a greyscale screenshot', () => {
    // The falsifiable half of "the palette is readable". A palette chosen by
    // hue passes an eye review and fails both a desaturated screenshot and
    // roughly one man in twelve; `luminanceOf` is the greyscale value of the
    // pixel, so this is the contrast that survives.
    AVATAR_COLOURS.forEach((colour) => {
      expect(contrastRatio(colour, AVATAR_INK)).toBeGreaterThanOrEqual(AA);
    });
  });

  it('rejects a red-on-blue disc, which is what makes the line above a bound', () => {
    // Without this the assertion above is a number with no demonstrated power
    // to reject anything. Red on blue is the archetype of a pair that is
    // obviously different in colour and nearly identical in lightness: it
    // scores about 2.15, well under AA, and would be illegible on a phone.
    expect(contrastRatio('#ff0000', '#0000ff')).toBeLessThan(AA);
  });

  it('scores a hue-only difference at 1.0, which is the property being used', () => {
    // The sharpest version of the same point. `#7f7f7f` is the grey with the
    // same relative luminance as pure red, so the two differ in hue and in
    // nothing else — and this helper, which is the greyscale reading, cannot
    // tell them apart at all. That is why a contrast rule stated in luminance
    // says something a rule stated in hue does not.
    expect(contrastRatio('#ff0000', '#7f7f7f')).toBeCloseTo(1, 2);
  });

  it('keeps every disc fully opaque', () => {
    // A translucent disc composites with whatever is behind it, so its
    // rendered luminance is not knowable from the colour and the check above
    // could not be made at all.
    AVATAR_COLOURS.forEach((colour) => {
      expect(alphaOf(colour)).toBe(1);
    });
    expect(alphaOf(AVATAR_INK)).toBe(1);
  });
});
