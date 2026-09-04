import { File } from 'expo-file-system';
import type { ItemCategory, PublicClothingItem, Season } from '@wardrobe/shared';
import { apiRequest } from '../api/client';
import { COMPRESSED_MIME_TYPE } from '../images/compress';
import { THUMBNAIL_MIME_TYPE } from '../images/thumbnail';

export interface UploadItemParams {
  /** URI of the file to upload. Callers must pass the *compressed* image
   *  (see `compressForUpload`), not the raw capture — this module does not
   *  compress on the caller's behalf. */
  uri: string;
  /** URI of the grid thumbnail (see `createThumbnail`), sent as a second file
   *  part so the wardrobe grid does not have to decode a 1280px photo per
   *  tile. Optional on purpose, mirroring the API: the part is not required,
   *  and `PublicClothingItem.thumbnailUrl` is optional, which is what lets
   *  items uploaded before this stage keep working with no backfill. */
  thumbnailUri?: string;
  category: ItemCategory;
  seasons?: Season[];
  token: string;
}

/**
 * POSTs a multipart `/items` request.
 *
 * Two device-only bugs found in Stage 2 Task 8, invisible to every unit and
 * integration test because Jest never exercises the real runtime pieces
 * involved:
 *
 * 1. React Native's classic `{ uri, name, type }` object in place of a
 *    `Blob` for a FormData file part — the idiom used everywhere pre-SDK-57
 *    — is NOT accepted by Expo SDK 57's own `fetch`/`FormData`
 *    (`expo/src/winter/fetch/convertFormData.ts`), which replaces the
 *    global `fetch` by default. It only accepts a real `Blob`, or an object
 *    exposing `.bytes()`. Every real upload failed instantly with
 *    "Unsupported FormDataPart implementation".
 * 2. The obvious fix — `expo-file-system`'s `File#slice()`, which builds a
 *    `Blob` via `new Blob([bytes], { type })` — throws on a real device:
 *    "Creating blobs from 'ArrayBuffer' and 'ArrayBufferView' are not
 *    supported". React Native's `Blob` on Android cannot be constructed
 *    from raw binary data in JS at all (confirmed independently in
 *    `expo/src/winter/fetch/createBlob.ts`'s own comment); `File#slice()`
 *    hits that same wall the moment there is real content to slice, which
 *    a `[]`-part-only test double can't reveal.
 *
 * The fix is to skip `Blob` entirely and pass the `File` instance straight
 * to `FormData`. `convertFormData` recognises anything exposing `.bytes()`
 * (which `File` does, backed by the native module reading the file
 * directly — no JS-side `Blob` construction involved) and reads content
 * through that path instead. `File#type` is derived from the URI's
 * extension, which is safe here specifically because `compressForUpload`
 * always saves with `format: SaveFormat.JPEG` (see compress.ts), so the
 * extension is always `.jpg`; the assertion below exists so a future
 * divergence between `COMPRESSED_MIME_TYPE` and that format fails loudly
 * here instead of silently at the server's magic-byte check.
 *
 * `apiRequest` detects the `FormData` body and omits the JSON Content-Type
 * header so the fetch runtime can set its own multipart boundary; see
 * client.ts.
 */
export async function uploadItem(params: UploadItemParams): Promise<PublicClothingItem> {
  const { uri, thumbnailUri, category, seasons = [], token } = params;

  const file = new File(uri);
  if (file.type !== COMPRESSED_MIME_TYPE) {
    throw new Error(
      `compressForUpload produced a ${file.type ?? 'unknown'} file but uploadItem expects ${COMPRESSED_MIME_TYPE}`,
    );
  }

  const form = new FormData();
  form.append('image', file as unknown as Blob);

  // Same `File`-straight-into-FormData shape as the image part above, for the
  // same SDK 57 reason documented there -- deliberately not a second variant.
  if (thumbnailUri) {
    const thumbnail = new File(thumbnailUri);
    // `File#type` comes from the uri's extension. The API checks the declared
    // part type against the file's real magic bytes and 400s on a mismatch,
    // so a drift between THUMBNAIL_MIME_TYPE and what `createThumbnail`
    // actually saves must fail here, with a message naming both, rather than
    // as an opaque validation error from the server.
    if (thumbnail.type !== THUMBNAIL_MIME_TYPE) {
      throw new Error(
        `createThumbnail produced a ${thumbnail.type ?? 'unknown'} file but uploadItem expects ${THUMBNAIL_MIME_TYPE}`,
      );
    }
    form.append('thumbnail', thumbnail as unknown as Blob);
  }

  form.append('category', category);
  for (const season of seasons) {
    form.append('seasons', season);
  }

  const res = await apiRequest<{ item: PublicClothingItem }>('/items', {
    method: 'POST',
    body: form,
    token,
  });

  return res.item;
}

export interface UpdateItemCategoryParams {
  id: string;
  category: ItemCategory;
  token: string;
}

/**
 * Corrects the category the AI tagged an item with, via `PATCH /items/:id`.
 *
 * Tagging happens server-side during upload, so the app cannot know the AI's
 * guess until after `uploadItem` has already saved the item (see add.tsx's
 * comment for why "save first, then offer to correct" was chosen over a
 * separate pre-save analyse step). This is the follow-up write the Add
 * screen's override chips call once that guess is on screen.
 */
export async function updateItemCategory(params: UpdateItemCategoryParams): Promise<PublicClothingItem> {
  const { id, category, token } = params;

  const res = await apiRequest<{ item: PublicClothingItem }>(`/items/${id}`, {
    method: 'PATCH',
    body: { category },
    token,
  });

  return res.item;
}
