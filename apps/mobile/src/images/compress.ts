import { ImageManipulator, SaveFormat, type ImageRef } from 'expo-image-manipulator';
import type { CapturedImage } from './capture';

/** Longest edge, in pixels, that we upload. */
export const MAX_UPLOAD_DIMENSION = 1280;

/** 0..1, where 1 is no compression. */
export const COMPRESSION_QUALITY = 0.7;

/**
 * MIME type of the file `compressForUpload` produces. Tied to the
 * `format: SaveFormat.JPEG` passed to `saveAsync` below — the two must be
 * changed together. `uploadItem.ts` imports this constant (rather than
 * hardcoding `'image/jpeg'` itself) to declare the multipart file part's
 * `type`, so the declared type can never drift from what compression
 * actually emits. If this format ever changes, the server's magic-byte
 * check in `apps/api/src/routes/items.ts` would reject a mismatched
 * declared type, so keeping these in sync matters beyond just this file.
 */
export const COMPRESSED_MIME_TYPE = 'image/jpeg';

export interface CompressedImage {
  uri: string;
  width: number;
  height: number;
}

export async function compressForUpload(image: CapturedImage): Promise<CompressedImage> {
  // `ImageManipulator.manipulate` returns a chainable context; `manipulateAsync`
  // is deprecated in SDK 57 and warns at runtime.
  const context = ImageManipulator.manipulate(image.uri);

  const longestEdge = Math.max(image.width, image.height);
  if (longestEdge > MAX_UPLOAD_DIMENSION) {
    // Passing only one dimension preserves aspect ratio, so we must cap
    // whichever dimension is the longer edge — otherwise the long edge
    // stays oversized after "resizing".
    context.resize(
      image.width >= image.height
        ? { width: MAX_UPLOAD_DIMENSION }
        : { height: MAX_UPLOAD_DIMENSION },
    );
  }

  let rendered: ImageRef | undefined;
  try {
    rendered = await context.renderAsync();
    const saved = await rendered.saveAsync({
      compress: COMPRESSION_QUALITY,
      // Keep in sync with COMPRESSED_MIME_TYPE above.
      format: SaveFormat.JPEG,
    });

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
    context.release();
    rendered?.release();
  }
}
