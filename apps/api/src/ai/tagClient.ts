import { ITEM_CATEGORIES, type TagResult, type ItemCategory, type ItemColor } from '@wardrobe/shared';
import type { Config } from '../config';

export const TAG_TIMEOUT_MS = 10_000;

// `category` and `colours` come from the same Python response and drift
// together, so both get validated with the same rigour — checking only that
// `colours` is an array (without checking its elements) would let a colour
// missing `hex`/`name` reach `ClothingItem.create`, which requires both, and
// turn a should-be-null result into an unhandled 500 instead.
function invalidColourReason(colour: unknown): string | null {
  if (typeof colour !== 'object' || colour === null) return 'a colour entry is not an object';
  const { hex, name, share } = colour as Record<string, unknown>;
  if (typeof hex !== 'string') return 'a colour is missing a string hex';
  if (typeof name !== 'string') return 'a colour is missing a string name';
  if (share !== undefined && (typeof share !== 'number' || share < 0 || share > 1)) {
    return 'a colour has a share outside [0,1]';
  }
  return null;
}

// Returns null when `body` is a well-formed TagResult, otherwise a short
// human-readable reason — used both to decide validity and to say what
// specifically was wrong when logging a rejected response.
function invalidResultReason(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return 'response body is not an object';
  const { category, confidence, colours } = body as Record<string, unknown>;
  if (typeof category !== 'string') return 'category is not a string';
  if (!ITEM_CATEGORIES.includes(category as ItemCategory)) return `category "${String(category)}" is not recognised`;
  if (typeof confidence !== 'number') return 'confidence is not a number';
  if (confidence < 0 || confidence > 1) return 'confidence is outside [0,1]';
  if (colours !== undefined) {
    if (!Array.isArray(colours)) return 'colours is not an array';
    // Reject the whole result on the first malformed entry rather than
    // filtering bad colours out — a partially-correct list is a drift
    // signal, not something to silently repair.
    for (const colour of colours) {
      const reason = invalidColourReason(colour);
      if (reason) return reason;
    }
  }
  return null;
}

/**
 * Tag an image, or return null. NEVER throws.
 *
 * Tagging is an enhancement, not a precondition: a user photographing a shirt
 * must not be blocked because a model container is restarting. Every failure
 * mode - unreachable, slow, 500, malformed, or a category this API does not
 * recognise - collapses to null, and the caller stores the item untagged.
 *
 * Every failure branch logs via `console.warn` before returning null. An
 * unreachable service, a timeout, and a benign restart all look identical
 * from the caller's side (a null return); without a trace, tagging can stop
 * working in production while every test stays green.
 */
export async function tagImage(
  body: Buffer,
  contentType: string,
  config: Config,
): Promise<TagResult | null> {
  try {
    const form = new FormData();
    // `Buffer`'s `buffer` property is typed `ArrayBufferLike` (it may be
    // backed by a `SharedArrayBuffer`), which lib.dom's `BlobPart` no longer
    // accepts under this TS/@types-node combination even though a `Buffer`
    // works fine as a Blob part at runtime (Node's Blob/fetch implementation
    // accepts it directly, unchanged, with no extra copy). Cast at the type
    // level only.
    form.append('image', new Blob([body as BlobPart], { type: contentType }), 'upload.jpg');

    const res = await fetch(`${config.aiServiceUrl}/tag`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(TAG_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`tagImage: AI service responded with status ${res.status}`);
      return null;
    }

    const parsed: unknown = await res.json();
    const invalidReason = invalidResultReason(parsed);
    if (invalidReason) {
      console.warn(`tagImage: rejected an invalid response (${invalidReason})`);
      return null;
    }

    const { category, confidence, colours } = parsed as TagResult;
    return { category, confidence, colours: (colours ?? []) as ItemColor[] };
  } catch (err) {
    console.warn('tagImage: request to the AI service failed', err);
    return null;
  }
}
