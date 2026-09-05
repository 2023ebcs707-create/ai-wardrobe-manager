import type { PublicClothingItem, PublicPost } from '@wardrobe/shared';
import { missingItemsNoticeFor, toDisplayPost } from '../../src/community/posts';

function item(id: string): PublicClothingItem {
  return {
    id,
    userId: 'author-1',
    imageUrl: `https://example.test/${id}.jpg`,
    category: 'shirt',
    colors: [],
    seasons: [],
    laundryStatus: 'available',
    retired: false,
    wearCount: 0,
    source: 'ai',
    createdAt: '2026-08-01T10:00:00.000Z',
  };
}

const shirt = item('item-1');
const trousers = item('item-2');
const shoes = item('item-3');

function post(overrides: Partial<PublicPost> = {}): PublicPost {
  return {
    id: 'post-1',
    author: { id: 'author-1', name: 'Ada' },
    itemIds: [shirt.id, trousers.id, shoes.id],
    items: [shirt, trousers, shoes],
    caption: 'Rainy Monday',
    likeCount: 3,
    liked: false,
    saved: false,
    createdAt: '2026-08-20T10:00:00.000Z',
    ...overrides,
  };
}

describe('toDisplayPost', () => {
  it('does not expose itemIds at all', async () => {
    // The wire type carries two arrays that are NOT parallel: `items` is
    // compacted and de-duplicated, `itemIds` is neither. Pairing them by index
    // renders the wrong garment under the wrong id from the first gap onwards.
    //
    // A comment saying "render from items" is not a control; not handing over
    // the other array is. Asserted on the value AND on the type, because a key
    // that is absent at runtime but present on the declared type is still one
    // a screen can be written against.
    const display = toDisplayPost(post());

    expect(display).not.toHaveProperty('itemIds');
    expect(Object.keys(display)).not.toContain('itemIds');

    // The type-level half. `@ts-expect-error` fails the typecheck if the
    // property ever becomes readable, which is the only way to pin an absence
    // that a runtime assertion cannot see.
    // @ts-expect-error `DisplayPost` must not carry the snapshot id list.
    expect(display.itemIds).toBeUndefined();
  });

  it('carries the resolved items in the author’s composition order', async () => {
    const display = toDisplayPost(post());

    expect(display.items.map((entry) => entry.id)).toEqual([shirt.id, trousers.id, shoes.id]);
  });

  it('keeps a post whose garments are all gone, with an empty items array', async () => {
    // Not an error and it must not be dropped: items can be deleted from a
    // wardrobe after a post is shared, and when the last one goes the post
    // still exists and still renders with its caption and its author. A feed
    // that treats `[]` as a failure develops holes as users tidy up.
    const display = toDisplayPost(post({ items: [] }));

    expect(display.items).toEqual([]);
    expect(display.caption).toBe('Rainy Monday');
    expect(display.author.name).toBe('Ada');
    expect(display.missingItemsNotice).toBe('3 items are no longer available');
  });

  it('passes a “Deleted user” author through as an ordinary name', async () => {
    // The API answers `{ id, name: 'Deleted user' }` for a post whose author's
    // account is gone — and that string is a LEGAL display name:
    // `registerSchema` is min(1).max(80) with no reserved-name check, so a
    // real person called "Deleted user" is byte-identical on the wire to a
    // tombstone. This layer cannot tell them apart and must not pretend to,
    // which is why there is no flag here to assert — only the name.
    const display = toDisplayPost(
      post({ author: { id: 'gone-1', name: 'Deleted user' } }),
    );

    expect(display.author).toEqual({ id: 'gone-1', name: 'Deleted user' });
    expect(display).not.toHaveProperty('authorDeleted');
  });
});

describe('missingItemsNoticeFor', () => {
  it('is null when every snapshotted id resolved', async () => {
    expect(missingItemsNoticeFor([shirt.id, trousers.id], [shirt, trousers])).toBeNull();
  });

  it('counts the garments that no longer resolve, singular and plural', async () => {
    expect(missingItemsNoticeFor([shirt.id, trousers.id], [shirt])).toBe(
      '1 item is no longer available',
    );
    expect(missingItemsNoticeFor([shirt.id, trousers.id, shoes.id], [shirt])).toBe(
      '2 items are no longer available',
    );
  });

  it('does not count a collapsed duplicate as a missing garment', async () => {
    // `items` is de-duplicated and `itemIds` is not, so a snapshot naming one
    // id twice is THREE ids and TWO rendered garments with nothing missing.
    // The naive `itemIds.length - items.length` says "1 item is no longer
    // available" about a post whose every garment is on screen.
    expect(
      missingItemsNoticeFor([shirt.id, trousers.id, shirt.id], [shirt, trousers]),
    ).toBeNull();
  });

  it('counts a real gap correctly even when a duplicate is also present', async () => {
    // Four ids, three distinct, one of those three deleted: exactly one
    // garment is missing. Subtracting lengths would say two.
    expect(
      missingItemsNoticeFor([shirt.id, trousers.id, shirt.id, shoes.id], [shirt, trousers]),
    ).toBe('1 item is no longer available');
  });

  it('is null rather than a sentence built from garbage when the wire is malformed', async () => {
    // `apiRequest` ends in `parsed as T`, so the declared types are an
    // assertion about the wire rather than a guarantee from it. Without the
    // guard a missing key throws inside a `map` over a whole feed page and
    // takes the list down.
    expect(
      missingItemsNoticeFor(undefined as unknown as string[], [shirt]),
    ).toBeNull();
    expect(
      missingItemsNoticeFor([shirt.id], undefined as unknown as PublicClothingItem[]),
    ).toBeNull();
  });

  it('is null when items somehow outnumber the distinct snapshot ids', async () => {
    expect(missingItemsNoticeFor([shirt.id], [shirt, trousers])).toBeNull();
  });
});
