import { ImageManipulator, SaveFormat, type ImageRef } from 'expo-image-manipulator';
import type { CapturedImage } from './capture';
import type { CompressedImage } from './compress';

/**
 * Longest edge, in pixels, of the grid thumbnail.
 *
 * Sized for the wardrobe grid Task 4 of this stage will build, which does not
 * exist yet -- so this is a chosen budget, not a measurement against a real
 * layout. The reasoning: a 3-column grid on a phone gives each tile roughly
 * 110dp, which is 220px at 2x density and 330px at 3x. 320 therefore clears
 * 2x comfortably and lands just under a true 3x tile -- close enough that the
 * shortfall is invisible at tile size, and a deliberate trade against
 * decoding a larger image 24 times per screen. If Task 4's tiles turn out
 * materially wider than 110dp, revisit this number rather than assuming it
 * still fits.
 */
export const THUMBNAIL_DIMENSION = 320;

/** 0..1, where 1 is no compression. Lower than the upload's 0.7: at tile size
 *  the extra loss is not visible, and the grid loads 24 of these at once. */
export const THUMBNAIL_QUALITY = 0.6;

/**
 * MIME type of the file `createThumbnail` produces. Tied to the
 * `format: SaveFormat.JPEG` passed to `saveAsync` below — the two must be
 * changed together, exactly as COMPRESSED_MIME_TYPE is in compress.ts.
 * `uploadItem.ts` imports this to declare the `thumbnail` multipart part's
 * type, and the API validates that declaration against the file's real magic
 * bytes, so a drift here would 400 every upload rather than fail quietly.
 */
export const THUMBNAIL_MIME_TYPE = 'image/jpeg';

/**
 * Produces the small image the wardrobe grid renders (FR4 / TC-06).
 *
 * Deliberately NOT folded into `compressForUpload`, despite the near-identical
 * shape: that function exists to bound what gets *stored* as the item's real
 * photo, this one exists to bound what a 24-tile grid has to *decode*. They
 * change for different reasons — upload fidelity vs. grid density — so a
 * shared helper would couple two independent decisions behind one set of
 * constants.
 *
 * The one behavioural difference from `compressForUpload`: this never
 * short-circuits. `compressForUpload` skips the resize when the source is
 * already within its cap; here the resize (and therefore the re-encode) always
 * runs, because returning the source untouched would upload a full-quality
 * image as the "thumbnail".
 */
export async function createThumbnail(image: CapturedImage): Promise<CompressedImage> {
  // `ImageManipulator.manipulate` returns a chainable context; `manipulateAsync`
  // is deprecated in SDK 57 and warns at runtime.
  const context = ImageManipulator.manipulate(image.uri);

  const longestEdge = Math.max(image.width, image.height);
  // A ceiling, not a target: a source already smaller than the cap keeps its
  // own longer edge. Upscaling to 320 would spend pixels — and the bytes to
  // encode them — inventing detail the source does not contain, which is the
  // opposite of what a thumbnail is for. Whether the upscaled file would
  // actually come out larger than the source depends on the source's own
  // encoding; that was never measured, and the argument does not need it.
  const target = Math.min(longestEdge, THUMBNAIL_DIMENSION);

  // Passing only one dimension preserves aspect ratio, so we must cap
  // whichever dimension is the longer edge — otherwise the long edge stays
  // oversized after "resizing".
  context.resize(image.width >= image.height ? { width: target } : { height: target });

  let rendered: ImageRef | undefined;
  try {
    rendered = await context.renderAsync();
    const saved = await rendered.saveAsync({
      compress: THUMBNAIL_QUALITY,
      // Keep in sync with THUMBNAIL_MIME_TYPE above.
      format: SaveFormat.JPEG,
    });

    // The produced dimensions, not the source's: the caller uses these to
    // describe the file it is about to upload.
    return { uri: saved.uri, width: saved.width, height: saved.height };
  } finally {
  // `release()` detaches the JS object from its native counterpart so the
  // native bitmap can be freed without waiting for the JS garbage collector.
  // expo-modules-core's own docs name this exact case -- "the native object is
  // known to exclusively retain some native memory (such as binary data or
  // image bitmap)" -- and the library's own deprecated `manipulateAsync` does
  // the same two calls with the comment "These shared objects will not be used
  // anymore, so free up some memory".
  //
  // In a `finally` rather than straight-line after `saveAsync` (which is what
  // `manipulateAsync` does): the failure this guards against is memory
  // pressure, so the error path is the one that can least afford to leak a
  // full-size bitmap. Precautionary -- no leak has been measured here.
    //
    // This module doubles the number of contexts and ImageRefs per save --
    // the caller runs `compressForUpload` on the same original first -- which
    // is why it matters more here than anywhere else.
    context.release();
    rendered?.release();
  }
}
