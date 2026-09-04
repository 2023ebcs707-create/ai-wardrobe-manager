import mongoose from 'mongoose';
import { connectDatabase } from '../db';
import { ClothingItem, toPublicItem, type ClothingItemDoc } from './ClothingItem';

const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://localhost:27017/wardrobe';
const userId = new mongoose.Types.ObjectId();

beforeAll(async () => {
  await connectDatabase(MONGO_URL);
  await ClothingItem.init();
}, 30000);

beforeEach(async () => {
  await ClothingItem.deleteMany({});
});

afterAll(async () => {
  await ClothingItem.deleteMany({});
  await mongoose.disconnect();
});

function base() {
  return {
    userId,
    imageKey: 'items/abc.jpg',
    category: 'tshirt' as const,
    colors: [{ hex: '#223344', name: 'navy' }],
    seasons: ['summer' as const],
    source: 'manual' as const,
  };
}

describe('ClothingItem against live MongoDB', () => {
  it('stores an item with its defaults applied', async () => {
    const doc = (await ClothingItem.create(base())) as ClothingItemDoc;
    expect(doc.laundryStatus).toBe('available');
    expect(doc.wearCount).toBe(0);
    expect(doc.lastWornAt).toBeUndefined();
  });

  it('rejects an unknown category', async () => {
    await expect(
      ClothingItem.create({ ...base(), category: 'spacesuit' as never }),
    ).rejects.toThrow();
  });

  it('rejects an unknown season', async () => {
    await expect(
      ClothingItem.create({ ...base(), seasons: ['monsoon'] as never }),
    ).rejects.toThrow();
  });

  it('rejects an item with no owner', async () => {
    const { userId: _drop, ...withoutOwner } = base();
    await expect(ClothingItem.create(withoutOwner as never)).rejects.toThrow();
  });

  it('rejects an item with no image key', async () => {
    const { imageKey: _drop, ...withoutImage } = base();
    await expect(ClothingItem.create(withoutImage as never)).rejects.toThrow();
  });

  it('exposes a public shape carrying no storage keys', async () => {
    const doc = (await ClothingItem.create(base())) as ClothingItemDoc;
    const pub = toPublicItem(doc, 'https://signed.example/abc.jpg');

    expect(pub.imageUrl).toBe('https://signed.example/abc.jpg');
    expect(pub.category).toBe('tshirt');
    expect(pub.wearCount).toBe(0);
    expect(typeof pub.createdAt).toBe('string');
    expect(JSON.stringify(pub)).not.toContain('imageKey');
    // aiConfidence was never set on this doc; the key must be absent, not
    // present-with-value-undefined, or a spread guard could be dropped
    // without any assertion noticing.
    expect('aiConfidence' in pub).toBe(false);
  });

  it('maps id, userId, colors, seasons, laundryStatus, source, and aiConfidence from the actual document rather than a hard-coded value', async () => {
    const doc = (await ClothingItem.create({
      ...base(),
      colors: [
        { hex: '#223344', name: 'navy' },
        { hex: '#ffffff', name: 'white' },
      ],
      seasons: ['summer', 'winter'],
      source: 'ai',
      aiConfidence: 0.87,
    })) as ClothingItemDoc;

    const pub = toPublicItem(doc, 'https://signed.example/abc.jpg');

    expect(pub.id).toBe(String(doc._id));
    // Guards specifically against id and userId being transposed: both are
    // ObjectId-shaped strings, so a swap would not fail a looser assertion.
    expect(pub.id).not.toBe(pub.userId);
    expect(pub.userId).toBe(String(userId));
    expect(pub.colors).toEqual([
      { hex: '#223344', name: 'navy' },
      { hex: '#ffffff', name: 'white' },
    ]);
    expect(pub.seasons).toEqual(['summer', 'winter']);
    expect(pub.laundryStatus).toBe('available');
    expect(pub.source).toBe('ai');
    expect(pub.aiConfidence).toBe(0.87);
  });

  // `share` is the TC-05 confidence signal (Phase 3 §3.2): 1.00 for a solid
  // colour, 0.55/0.45 for a two-tone stripe, ~0.37 across three clusters for
  // a pattern where "dominant colour" is meaningless. It is not in
  // colorSchema by name, and Mongoose's default strict mode silently drops
  // any field not declared on a subdocument schema -- a value that survives
  // validation on the way in but vanishes on the way out is exactly the kind
  // of gap this project has hit before. Pin both the stored document and the
  // public shape so a schema regression here fails loudly.
  it('carries `share` on each colour through storage and back out through toPublicItem', async () => {
    const doc = (await ClothingItem.create({
      ...base(),
      colors: [
        { hex: '#223344', name: 'navy', share: 0.55 },
        { hex: '#ffffff', name: 'white', share: 0.45 },
      ],
    })) as ClothingItemDoc;

    expect(doc.colors.map((c) => c.share)).toEqual([0.55, 0.45]);

    const pub = toPublicItem(doc, 'https://signed.example/abc.jpg');
    expect(pub.colors).toEqual([
      { hex: '#223344', name: 'navy', share: 0.55 },
      { hex: '#ffffff', name: 'white', share: 0.45 },
    ]);
  });

  // Items created before this stage (or any colour the AI service reports
  // without a usable cluster share) have no `share` at all. The key must be
  // absent from the public shape, not present-with-value-undefined, mirroring
  // how aiConfidence and lastWornAt are already handled above.
  it('omits `share` from a colour that never had one, rather than emitting it as undefined', async () => {
    const doc = (await ClothingItem.create(base())) as ClothingItemDoc;
    const pub = toPublicItem(doc, 'https://signed.example/abc.jpg');
    expect(pub.colors).toEqual([{ hex: '#223344', name: 'navy' }]);
    expect('share' in pub.colors[0]).toBe(false);
  });

  // `aiCategory` records what the MODEL said, next to the `category` the item
  // is filed under now -- the only record in the system that a user ever
  // overrode the AI, since PATCH /items/:id deliberately leaves `source` and
  // `aiConfidence` alone. Exactly the `share` hazard applies: undeclared in
  // the schema, Mongoose's strict mode drops it on write and it reads back as
  // "the AI suggested nothing", with nothing failing anywhere.
  it('carries `aiCategory` through storage and back out through toPublicItem', async () => {
    const doc = (await ClothingItem.create({
      ...base(),
      category: 'jacket',
      source: 'ai',
      aiConfidence: 0.87,
      aiCategory: 'shirt',
    })) as ClothingItemDoc;

    // The stored document first: a `toPublicItem`-only assertion would pass
    // even if the schema had dropped the path and the hydrated doc were
    // carrying it in memory alone.
    const reread = await ClothingItem.findById(doc._id);
    expect(reread!.aiCategory).toBe('shirt');

    const pub = toPublicItem(reread as ClothingItemDoc, 'https://signed.example/abc.jpg');
    // The two differ on purpose: this is the corrected-item shape the detail
    // screen has to be able to recognise.
    expect(pub.aiCategory).toBe('shirt');
    expect(pub.category).toBe('jacket');
  });

  // Absent means "unknown", not "not overridden" -- manual items never had a
  // model run, and every item stored before this field existed has no value
  // for it. Present-with-value-undefined would let a reader that checks
  // `'aiCategory' in item` conclude the opposite.
  it('omits `aiCategory` when no model ever assigned one', async () => {
    const doc = (await ClothingItem.create({ ...base(), source: 'manual' })) as ClothingItemDoc;
    const pub = toPublicItem(doc, 'https://signed.example/abc.jpg');
    expect('aiCategory' in pub).toBe(false);
  });

  it('maps a non-default wearCount through toPublicItem, not the schema default', async () => {
    const doc = (await ClothingItem.create({ ...base(), wearCount: 7 })) as ClothingItemDoc;
    const pub = toPublicItem(doc, 'https://signed.example/abc.jpg');
    expect(pub.wearCount).toBe(7);
  });

  it('maps lastWornAt through toPublicItem as an ISO string when set, and omits the key when unset', async () => {
    const wornAt = new Date('2026-01-15T10:30:00.000Z');
    const worn = (await ClothingItem.create({ ...base(), lastWornAt: wornAt })) as ClothingItemDoc;
    const wornPub = toPublicItem(worn, 'https://signed.example/abc.jpg');
    expect(wornPub.lastWornAt).toBe(wornAt.toISOString());

    const neverWorn = (await ClothingItem.create(base())) as ClothingItemDoc;
    const neverWornPub = toPublicItem(neverWorn, 'https://signed.example/abc.jpg');
    expect('lastWornAt' in neverWornPub).toBe(false);
  });

  it('maps a non-default category through toPublicItem, not a hard-coded one', async () => {
    const doc = (await ClothingItem.create({ ...base(), category: 'jacket' })) as ClothingItemDoc;
    const pub = toPublicItem(doc, 'https://signed.example/abc.jpg');
    expect(pub.category).toBe('jacket');
  });

  it('includes a thumbnail URL only when one is given, and never leaks the thumbnail storage key', async () => {
    const doc = (await ClothingItem.create({
      ...base(),
      thumbnailKey: 'items/abc-thumb.jpg',
    })) as ClothingItemDoc;

    const withThumbnail = toPublicItem(
      doc,
      'https://signed.example/abc.jpg',
      'https://signed.example/abc-thumb.jpg',
    );
    expect(withThumbnail.thumbnailUrl).toBe('https://signed.example/abc-thumb.jpg');
    expect(JSON.stringify(withThumbnail)).not.toContain('thumbnailKey');

    const withoutThumbnail = toPublicItem(doc, 'https://signed.example/abc.jpg');
    expect('thumbnailUrl' in withoutThumbnail).toBe(false);
  });

  it('indexes by owner so a wardrobe query is not a collection scan', async () => {
    const indexes = await ClothingItem.collection.indexes();
    const names = indexes.map((i) => JSON.stringify(i.key));
    expect(names.some((k) => k.includes('userId'))).toBe(true);
  });
});
