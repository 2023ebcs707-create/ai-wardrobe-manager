import { color } from './tokens';

/**
 * The palette, measured rather than asserted by eye.
 *
 * Two of the mockup's values failed WCAG 1.4.3 as text — `#857F73` at 3.98:1
 * on white for every caption and label in the app, and `#B4553C` at 4.27:1 for
 * every error sentence — and neither is obviously wrong to look at. That is
 * exactly why this file exists: the failure mode of a warm, low-contrast
 * palette is that it stays pleasant right up until somebody cannot read it.
 *
 * This is the same technique `LaundryBadge.test.tsx` uses on the one badge
 * that has to survive a photograph behind it, applied to the palette as a
 * whole. It measures LUMINANCE contrast, so a passing pair is also readable in
 * greyscale and to a reader with any form of colour blindness.
 */

/** One channel of sRGB, linearised. */
function channel(eightBit: number): number {
  const c = eightBit / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminanceOf(hex: string): number {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = channel((n >> 16) & 255);
  const g = channel((n >> 8) & 255);
  const b = channel(n & 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1..21. */
function contrastRatio(a: string, b: string): number {
  const la = luminanceOf(a);
  const lb = luminanceOf(b);
  const [light, dark] = la > lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

/**
 * Every ink/surface pair this app actually renders TEXT in, named by where.
 *
 * Written out rather than generated as a cross product: most pairs never
 * occur, and a test that demanded 4.5:1 between colours nothing ever puts
 * together would be pinning decisions no one made.
 */
const TEXT_PAIRS: { where: string; ink: string; on: string }[] = [
  { where: 'body text on the page', ink: color.ink, on: color.shell },
  { where: 'body text on a card', ink: color.ink, on: color.card },
  { where: 'captions and labels on a card', ink: color.soft, on: color.card },
  { where: 'captions and labels on the page', ink: color.soft, on: color.shell },
  { where: 'a chip label at rest', ink: color.soft, on: color.cloud },
  { where: 'a lozenge on a quiet surface', ink: color.ink, on: color.cloud },
  { where: 'a selected chip', ink: color.shell, on: color.ink },
  { where: 'an error sentence', ink: color.washInk, on: color.wash },
  { where: 'an error sentence on the page', ink: color.washInk, on: color.shell },
  { where: 'the retry button', ink: color.wash, on: color.washInk },
  { where: 'the laundry badge', ink: color.shell, on: color.ink },
  { where: 'a success sentence', ink: color.success, on: color.card },
  { where: 'a success sentence on the page', ink: color.success, on: color.shell },
];

describe('the Soft palette', () => {
  // 4.5:1 and not 3:1: every pairing above is normal-size text. WCAG's large
  // text exemption starts at 18pt, or 14pt bold — and the smallest type in
  // this app is an 11pt label, which is nowhere near either.
  it.each(TEXT_PAIRS)('is readable for $where', ({ ink, on }) => {
    expect(contrastRatio(ink, on)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps secondary text visibly secondary', () => {
    // The other direction, and the one that a "just darken everything until it
    // passes" fix would break: `soft` has to stay distinguishable from `ink`,
    // or the hierarchy the captions rely on disappears.
    expect(contrastRatio(color.soft, color.ink)).toBeGreaterThanOrEqual(2);
  });

  it('keeps `sage` off the list of text colours', () => {
    // Recorded as a test rather than a comment, because `sage` is the obvious
    // thing to reach for the next time a success line is written: it is the
    // palette's green and it is right there. It is 3.8:1 on white, so it is a
    // surface and pip colour, and `success` is what the same idea looks like
    // when it has to be read.
    expect(contrastRatio(color.sage, color.card)).toBeLessThan(4.5);
    expect(contrastRatio(color.success, color.card)).toBeGreaterThanOrEqual(4.5);
  });

  it('has no colour that is only a colour', () => {
    // A sanity check on the greyscale claim above: every surface pairing is
    // measured on luminance alone, so a palette that passed only because of
    // hue could not pass this file at all. Stated as a test so the claim is
    // executable rather than a comment.
    expect(luminanceOf(color.ink)).toBeLessThan(luminanceOf(color.soft));
    expect(luminanceOf(color.soft)).toBeLessThan(luminanceOf(color.cloud));
    expect(luminanceOf(color.cloud)).toBeLessThan(luminanceOf(color.shell));
  });
});
