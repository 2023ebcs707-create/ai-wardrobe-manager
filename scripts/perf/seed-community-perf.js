'use strict';

/**
 * Seeds the COMMUNITY half of `wardrobe_perf` -- Task 2's fixture.
 *
 * Task 1 left `wardrobe_perf` holding 25 users and 46,128 clothing items and
 * nothing else: `communityposts`, `outfits`, `postlikes`, `postsaves`,
 * `wearhistories` and `laundrystatuses` were all empty. Claims 4, 6 and 13 are
 * about the community feed, so they cannot be measured against an empty feed:
 * a feed page over zero posts issues one query and returns `{posts: []}`, which
 * is a measurement of the empty case wearing the loaded case's name.
 *
 * WHAT THIS SCRIPT WILL AND WILL NOT TOUCH.
 *   - It DROPS and rebuilds: `outfits`, `communityposts`, `postlikes`,
 *     `postsaves`, `wearhistories`, `laundrystatuses`.
 *   - It NEVER touches `users` or `clothingitems`. Those are Task 1's
 *     deterministic fixture and re-seeding them would invalidate every number
 *     Task 1 recorded against them. This script READS them to find real item
 *     ids to snapshot, so a post's items resolve the way a real post's do.
 *   - It never opens any database but `wardrobe_perf`. Not `wardrobe`, not
 *     `wardrobe_test` (which `apps/api/jest.setup.js` pins the suites to), not
 *     `wardrobe_gate7` (which the dev API on :3000 is serving).
 *
 * DETERMINISTIC, like `seed-perf-db.js`: fixed-seed PRNG, fixed base timestamp,
 * ids derived from a SHA-1 of a counter. Re-running produces byte-identical
 * documents, so a number taken today is comparable with one taken after a
 * re-seed.
 *
 * WHY 2,000 POSTS. Claim 13 says the feed "degrades slightly when scrolling
 * through 500+ posts without pagination reset". 500 is the threshold the claim
 * names, so the fixture has to reach well past it for the claim to be testable
 * in both directions -- a 500-post fixture can only ever show the boundary, not
 * what happens beyond it. 2,000 posts is 84 pages at the client's default page
 * size of 24, which is four times the depth the claim is about.
 *
 * WHY EACH POST SNAPSHOTS 3 ITEMS. `hydratePosts` issues one `ClothingItem`
 * query and one signing round trip PER POST (`signSnapshotItems`), so the item
 * count per post is a direct multiplier on the per-page work. Three is the
 * ordinary outfit -- top, bottom, shoes -- and is what the Stage 8 measurement
 * of "24 Mongo round trips for a 20-post page" assumed.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getMongoClient } = require('./lib/mongo');

const DEFAULT_URI = 'mongodb://localhost:27017/wardrobe_perf';
const BASE_TIME = Date.parse('2026-02-01T00:00:00.000Z');

/** mulberry32, the same generator `seed-perf-db.js` uses. */
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fixedObjectId(prefix, n) {
  return crypto.createHash('sha1').update(`${prefix}:${n}`).digest('hex').slice(0, 24);
}

const CAPTION_WORDS = [
  'linen', 'monday', 'rainy', 'layered', 'denim', 'wool', 'commute', 'office',
  'weekend', 'brunch', 'autumn', 'crisp', 'navy', 'olive', 'charcoal', 'knit',
  'boots', 'trainers', 'scarf', 'overshirt', 'tailored', 'relaxed', 'evening',
  'market', 'gallery', 'walk', 'coffee', 'library', 'travel', 'airport',
];

async function seed(options = {}) {
  const {
    uri = DEFAULT_URI,
    posts: postCount = 2000,
    itemsPerPost = 3,
    log = console.log,
  } = options;

  const { ObjectId } = require(require.resolve('mongodb', {
    paths: [
      path.dirname(
        require.resolve('mongoose/package.json', {
          paths: [path.join(__dirname, '..', '..', 'apps', 'api')],
        }),
      ),
    ],
  }));

  const client = await getMongoClient(uri);
  const db = client.db();

  if (db.databaseName !== 'wardrobe_perf') {
    await client.close();
    throw new Error(`refusing to seed database '${db.databaseName}'; this script only writes wardrobe_perf`);
  }

  try {
    // Read the users and their items rather than recomputing the ids: the item
    // ids have to be REAL, because `signSnapshotItems` resolves them and a post
    // whose snapshot resolves to nothing renders as an empty card and costs a
    // fraction of the work a real one does.
    const users = await db.collection('users').find({}).sort({ _id: 1 }).toArray();
    if (users.length === 0) throw new Error('wardrobe_perf has no users -- run seed-perf-db.js first');

    /**
     * THE VIEWER IS TASK 1's 120-ITEM USER, not `users[0]`.
     *
     * `seed-perf-db.js` derives every user id from a SHA-1 of a counter, so
     * `_id` order is NOT insertion order: sorting by `_id` and taking the first
     * row picked "Perf User 8", a 2,000-item filler account. Every number taken
     * with that token would have been a number about a wardrobe four times
     * larger than the one Task 1 built for the "100+ items" claim, and nothing
     * in the result would have said so. The viewer is therefore read from Task
     * 1's own manifest.
     */
    const wardrobeManifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'verification', 'stage-9', 'raw', 'perf-db-manifest.json'), 'utf8'),
    );
    const viewerIndex = users.findIndex((u) => String(u._id) === wardrobeManifest.largeWardrobeUserId);
    if (viewerIndex === -1) {
      throw new Error(`the manifest's largeWardrobeUserId ${wardrobeManifest.largeWardrobeUserId} is not in wardrobe_perf -- re-run seed-perf-db.js`);
    }

    const itemsByUser = new Map();
    for (const u of users) {
      const ids = await db
        .collection('clothingitems')
        .find({ userId: u._id }, { projection: { _id: 1 } })
        .sort({ _id: 1 })
        .limit(200)
        .toArray();
      itemsByUser.set(String(u._id), ids.map((d) => d._id));
    }
    const usable = users.filter((u) => (itemsByUser.get(String(u._id)) || []).length >= itemsPerPost);
    if (usable.length === 0) throw new Error('no user has enough clothing items to snapshot');

    for (const name of ['outfits', 'communityposts', 'postlikes', 'postsaves', 'wearhistories', 'laundrystatuses']) {
      await db.collection(name).drop().catch(() => {});
    }

    const rng = makeRng(20260826);
    const outfits = [];
    const postDocs = [];

    for (let i = 0; i < postCount; i += 1) {
      const author = usable[i % usable.length];
      const pool = itemsByUser.get(String(author._id));
      const itemIds = [];
      for (let k = 0; k < itemsPerPost; k += 1) {
        itemIds.push(pool[(i * itemsPerPost + k) % pool.length]);
      }
      const outfitId = new ObjectId(fixedObjectId('perf-outfit', i));
      // One post per minute, oldest first, so `createdAt` is strictly
      // increasing with no ties and keyset paging has a well-defined order.
      const createdAt = new Date(BASE_TIME + i * 60_000);

      outfits.push({
        _id: outfitId,
        userId: author._id,
        name: `Perf outfit ${i}`,
        itemIds,
        createdAt,
        updatedAt: createdAt,
        __v: 0,
      });

      const words = [];
      for (let w = 0; w < 6; w += 1) words.push(CAPTION_WORDS[Math.floor(rng() * CAPTION_WORDS.length)]);
      // Every 500th post carries a marker word that appears in exactly one
      // caption in the whole fixture. Stage 8 measured that `?q=` costs
      // O(feed size) rather than O(result size), and a term with exactly one
      // hit is what makes that visible: the scan cost cannot hide behind a
      // large result set.
      if (i % 500 === 0) words.push(`needle${i}`);

      postDocs.push({
        _id: new ObjectId(fixedObjectId('perf-post', i)),
        userId: author._id,
        outfitId,
        itemIds,
        caption: `${words.join(' ')} #${i}`,
        likeCount: i % 7,
        createdAt,
        updatedAt: createdAt,
        __v: 0,
      });
    }

    const insertBatched = async (name, docs) => {
      for (let i = 0; i < docs.length; i += 1000) {
        await db.collection(name).insertMany(docs.slice(i, i + 1000));
      }
    };

    await insertBatched('outfits', outfits);
    await insertBatched('communityposts', postDocs);

    // Likes and saves. The VIEWER (users[0]) likes and saves every 5th post,
    // which is what gives `hydratePosts`'s viewer-scoped lookups rows to find
    // rather than an empty result on every page. Other users' likes exist too,
    // so `postlikes` has volume and the viewer-scoped query has to discriminate
    // rather than trivially matching everything.
    const viewer = users[viewerIndex];
    const likes = [];
    const saves = [];
    for (let i = 0; i < postCount; i += 1) {
      const post = postDocs[i];
      if (i % 5 === 0) {
        likes.push({
          _id: new ObjectId(fixedObjectId('perf-like-viewer', i)),
          postId: post._id,
          userId: viewer._id,
          createdAt: post.createdAt,
          updatedAt: post.createdAt,
          __v: 0,
        });
        saves.push({
          _id: new ObjectId(fixedObjectId('perf-save-viewer', i)),
          postId: post._id,
          userId: viewer._id,
          createdAt: post.createdAt,
          updatedAt: post.createdAt,
          __v: 0,
        });
      }
      for (let k = 0; k < post.likeCount; k += 1) {
        const liker = users[(k + 1) % users.length];
        if (String(liker._id) === String(viewer._id)) continue;
        likes.push({
          _id: new ObjectId(fixedObjectId(`perf-like-${k}`, i)),
          postId: post._id,
          userId: liker._id,
          createdAt: post.createdAt,
          updatedAt: post.createdAt,
          __v: 0,
        });
      }
    }
    await insertBatched('postlikes', likes);
    await insertBatched('postsaves', saves);

    // Wear history for the viewer -- the Profile tab reads it, so it is in the
    // concurrent-load mix and must not be an empty list.
    const wears = [];
    for (let i = 0; i < 2000; i += 1) {
      const outfit = outfits[i % outfits.length];
      wears.push({
        _id: new ObjectId(fixedObjectId('perf-wear', i)),
        userId: viewer._id,
        outfitId: outfit._id,
        itemIds: outfit.itemIds,
        wornAt: new Date(BASE_TIME + i * 3_600_000),
        createdAt: new Date(BASE_TIME + i * 3_600_000),
        updatedAt: new Date(BASE_TIME + i * 3_600_000),
        __v: 0,
      });
    }
    await insertBatched('wearhistories', wears);

    // Laundry transitions, so the `{itemId: 1, changedAt: -1}` index has rows
    // to be explained against. Claim 7 names ItemID and this is the only
    // collection in the schema whose LEADING index key is an item id.
    const viewerItems = itemsByUser.get(String(viewer._id));
    const laundry = [];
    for (let i = 0; i < 2000; i += 1) {
      laundry.push({
        _id: new ObjectId(fixedObjectId('perf-laundry', i)),
        itemId: viewerItems[i % viewerItems.length],
        userId: viewer._id,
        status: i % 2 === 0 ? 'in_laundry' : 'available',
        changedAt: new Date(BASE_TIME + i * 600_000),
        createdAt: new Date(BASE_TIME + i * 600_000),
        updatedAt: new Date(BASE_TIME + i * 600_000),
        __v: 0,
      });
    }
    await insertBatched('laundrystatuses', laundry);

    // The indexes the models declare, created explicitly rather than left to
    // whether the API happened to connect and build them. `syncIndexes()`
    // reconciles OPTIONS as well as keys and is what the live-index
    // verification in `verify-indexes.js` uses; this is the raw-driver
    // equivalent so the fixture is queryable before any API starts.
    await db.collection('outfits').createIndex({ userId: 1, createdAt: -1, _id: -1 });
    await db.collection('outfits').createIndex({ itemIds: 1 });
    await db.collection('communityposts').createIndex({ createdAt: -1, _id: -1 });
    await db.collection('communityposts').createIndex({ userId: 1 });
    await db.collection('postlikes').createIndex({ postId: 1, userId: 1 }, { unique: true });
    await db.collection('postsaves').createIndex({ postId: 1, userId: 1 }, { unique: true });
    await db.collection('postsaves').createIndex({ userId: 1, createdAt: -1, _id: -1 });
    await db.collection('wearhistories').createIndex({ userId: 1, wornAt: -1, _id: -1 });
    await db.collection('wearhistories').createIndex({ outfitId: 1 });
    await db.collection('laundrystatuses').createIndex({ itemId: 1, changedAt: -1 });

    const counts = {};
    for (const n of ['users', 'clothingitems', 'outfits', 'communityposts', 'postlikes', 'postsaves', 'wearhistories', 'laundrystatuses']) {
      counts[n] = await db.collection(n).countDocuments();
    }

    const manifest = {
      at: new Date().toISOString(),
      uri,
      database: db.databaseName,
      seed: 20260826,
      baseTime: new Date(BASE_TIME).toISOString(),
      posts: postCount,
      itemsPerPost,
      postAuthors: usable.length,
      viewerUserId: String(viewer._id),
      viewerName: viewer.name,
      viewerItemCount: await db.collection('clothingitems').countDocuments({ userId: viewer._id }),
      viewerLikes: postDocs.filter((_, i) => i % 5 === 0).length,
      viewerSaves: postDocs.filter((_, i) => i % 5 === 0).length,
      needleCaptions: postDocs.filter((_, i) => i % 500 === 0).map((p, k) => `needle${k * 500}`),
      counts,
      indexes: Object.fromEntries(
        await Promise.all(
          Object.keys(counts).map(async (n) => [n, (await db.collection(n).listIndexes().toArray()).map((i) => i.name)]),
        ),
      ),
    };

    const outDir = path.join(__dirname, '..', '..', 'docs', 'verification', 'stage-9', 'raw');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'perf-community-manifest.json'), JSON.stringify(manifest, null, 2));

    log(`seeded ${postCount} posts / ${outfits.length} outfits / ${likes.length} likes / ${saves.length} saves into ${db.databaseName}`);
    log(`counts: ${JSON.stringify(counts)}`);
    return manifest;
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  seed().then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}

module.exports = { seed, DEFAULT_URI, BASE_TIME, fixedObjectId };
