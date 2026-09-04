import type { PublicClothingItem } from '@wardrobe/shared';
import { toPublicItem, type ClothingItemDoc } from '../models/ClothingItem';
import type { StorageProvider } from '../storage/StorageProvider';

/**
 * How long a signed image URL stays valid.
 *
 * Shared by every route that hands one out. It has to be one number: the
 * outfit detail screen renders items signed here beside a cover signed here,
 * and a client that cached one lifetime and applied it to the other would
 * refresh at the wrong time.
 */
export const SIGNED_URL_TTL_SECONDS = 3600;

/**
 * The single wire shape for a clothing item, with both its URLs signed.
 *
 * Extracted so `GET /items`, `GET /items/:id` and `GET /outfits/:id` cannot
 * drift on it: the outfit detail screen renders `PublicClothingItem`s, and if
 * this route built them differently from the items routes the mobile client
 * would need two renderers for one type.
 *
 * The thumbnail signing stays conditional: every item uploaded before Stage 4
 * has no `thumbnailKey`, and signing an absent key would produce a URL to an
 * object that does not exist. Consumers fall back to `imageUrl` for those,
 * which is what lets them keep working with no backfill.
 */
export async function signItemUrls(
  storage: StorageProvider,
  doc: ClothingItemDoc,
): Promise<PublicClothingItem> {
  const [imageUrl, thumbnailUrl] = await Promise.all([
    storage.signUrl(doc.imageKey, SIGNED_URL_TTL_SECONDS),
    doc.thumbnailKey
      ? storage.signUrl(doc.thumbnailKey, SIGNED_URL_TTL_SECONDS)
      : Promise.resolve(undefined),
  ]);
  return toPublicItem(doc, imageUrl, thumbnailUrl);
}
