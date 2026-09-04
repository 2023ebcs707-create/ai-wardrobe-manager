'use strict';

/**
 * Seeds the harness's OWN database, `wardrobe_perf`.
 *
 * It never touches `wardrobe` (development), `wardrobe_gate7` (the Stage 7
 * gate fixture the dev API on port 3000 is serving) or `wardrobe_test` (which
 * `apps/api/jest.setup.js` pins the suites to). The database name is a
 * parameter with a default, and the default is the only one this harness ever
 * writes to.
 *
 * SHAPE OF THE FIXTURE, and why each part exists:
 *
 *   user[0]  120 items -- Claim 11 says "loading a wardrobe with 100+ items
 *                         causes a noticeable delay (~4 s)". 120 is the
 *                         smallest wardrobe that satisfies "100+" with margin.
 *   user[1]    8 items -- a typical wardrobe, the control for "is the 120-item
 *                         number actually about size?"
 *   users[2..] bulk    -- filler so the COLLECTION is large. The index
 *                         negative control compares an indexed lookup against
 *                         a collection scan, and on a 128-document collection
 *                         those are the same speed: MongoDB scans 128
 *                         documents faster than it can be measured. The filler
 *                         is what makes the control able to fail.
 *
 * Data is deterministic: a fixed-seed PRNG, fixed base timestamp. Re-running
 * the seed produces byte-identical documents, so a measurement taken today can
 * be compared with one taken after a re-seed.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getMongoClient } = require('./lib/mongo');
const { ITEM_CATEGORIES, SEASONS } = require('./lib/fixtures');

const DEFAULT_URI = 'mongodb://localhost:27017/wardrobe_perf';

/** mulberry32 -- small, fast, and reproducible across Node versions. */
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

/**
 * A deterministic 24-hex ObjectId built from a counter, so every run produces
 * the same ids. A random ObjectId would change the `_id` tiebreaker in the
 * wardrobe sort between runs, which is a (small) input to the query plan.
 */
function fixedObjectId(prefix, n) {
  const hex = crypto
    .createHash('sha1')
    .update(`${prefix}:${n}`)
    .digest('hex')
    .slice(0, 24);
  return hex;
}

const BASE_TIME = Date.parse('2026-01-01T00:00:00.000Z');

function buildItems(ObjectId, userId, count, rng, keyPrefix) {
  const docs = [];
  for (let i = 0; i < count; i += 1) {
    const category = ITEM_CATEGORIES[Math.floor(rng() * ITEM_CATEGORIES.length)];
    const seasonCount = 1 + Math.floor(rng() * 2);
    const seasons = [];
    while (seasons.length < seasonCount) {
      const s = SEASONS[Math.floor(rng() * SEASONS.length)];
      if (!seasons.includes(s)) seasons.push(s);
    }
    // One item per minute, oldest first, so createdAt is strictly increasing
    // and cursor pagination has a well-defined order with no ties.
    const createdAt = new Date(BASE_TIME + i * 60_000);
    docs.push({
      _id: new ObjectId(fixedObjectId(`${keyPrefix}-item`, i)),
      userId,
      imageKey: `perf/${keyPrefix}/${i}.jpg`,
      thumbnailKey: `perf/${keyPrefix}/${i}-thumb.jpg`,
      category,
      colors: [
        { hex: '#1a1a1a', name: 'black', share: Math.round(rng() * 100) / 100 },
        { hex: '#c0c0c0', name: 'silver', share: Math.round(rng() * 100) / 100 },
      ],
      seasons,
      laundryStatus: rng() < 0.1 ? 'in_laundry' : 'available',
      wearCount: Math.floor(rng() * 40),
      lastWornAt: new Date(BASE_TIME + Math.floor(rng() * 200) * 3_600_000),
      source: rng() < 0.5 ? 'ai' : 'manual',
      aiConfidence: Math.round(rng() * 100) / 100,
      aiCategory: category,
      createdAt,
      updatedAt: createdAt,
      __v: 0,
    });
  }
  return docs;
}

async function seed(options = {}) {
  const {
    uri = DEFAULT_URI,
    largeWardrobe = 120,
    smallWardrobe = 8,
    fillerUsers = 23,
    fillerItemsEach = 2000,
    log = console.log,
  } = options;

  const { MongoClient } = require('./lib/mongo');
  const { ObjectId } = require(require.resolve('mongodb', {
    paths: [path.dirname(require.resolve('mongoose/package.json', { paths: [path.join(__dirname, '..', '..', 'apps', 'api')] }))],
  }));

  const client = await getMongoClient(uri);
  const dbName = new URL(uri.replace('mongodb://', 'http://')).pathname.slice(1);
  const db = client.db();

  try {
    await db.collection('users').drop().catch(() => {});
    await db.collection('clothingitems').drop().catch(() => {});

    const rng = makeRng(20260825);
    const users = [];
    const totalUsers = 2 + fillerUsers;
    for (let u = 0; u < totalUsers; u += 1) {
      users.push({
        _id: new ObjectId(fixedObjectId('perf-user', u)),
        name: `Perf User ${u}`,
        email: `perf-user-${u}@example.invalid`,
        // A real bcrypt hash of "perf-harness-password" is not needed: the
        // harness mints its own JWTs with the same secret the API verifies
        // with, so no login round trip is measured as part of a wardrobe read.
        passwordHash: '$2b$10$notarealhashnotarealhashnotarealhashnotarealhashno',
        createdAt: new Date(BASE_TIME),
        updatedAt: new Date(BASE_TIME),
        __v: 0,
      });
    }
    await db.collection('users').insertMany(users);
    await db.collection('users').createIndex({ email: 1 }, { unique: true });

    let inserted = 0;
    const batches = [
      { userIdx: 0, count: largeWardrobe, prefix: 'large' },
      { userIdx: 1, count: smallWardrobe, prefix: 'small' },
    ];
    for (let f = 0; f < fillerUsers; f += 1) {
      batches.push({ userIdx: 2 + f, count: fillerItemsEach, prefix: `filler${f}` });
    }

    for (const batch of batches) {
      const docs = buildItems(ObjectId, users[batch.userIdx]._id, batch.count, rng, batch.prefix);
      for (let i = 0; i < docs.length; i += 1000) {
        await db.collection('clothingitems').insertMany(docs.slice(i, i + 1000));
      }
      inserted += docs.length;
    }

    // The three indexes ClothingItem declares, created here explicitly rather
    // than left to Mongoose's autoIndex. The measurement must not depend on
    // whether the API happened to have connected and built them yet.
    await db.collection('clothingitems').createIndex({ userId: 1, category: 1 });
    await db.collection('clothingitems').createIndex({ userId: 1, createdAt: -1, _id: -1 });
    await db.collection('clothingitems').createIndex({ userId: 1, wearCount: -1, lastWornAt: -1, _id: -1 });

    const indexes = await db.collection('clothingitems').listIndexes().toArray();
    const stats = await db.command({ collStats: 'clothingitems' });

    const manifest = {
      at: new Date().toISOString(),
      uri,
      database: db.databaseName,
      users: users.length,
      items: inserted,
      largeWardrobeUserId: String(users[0]._id),
      largeWardrobeItems: largeWardrobe,
      smallWardrobeUserId: String(users[1]._id),
      smallWardrobeItems: smallWardrobe,
      fillerUsers,
      fillerItemsEach,
      indexes: indexes.map((i) => i.name),
      sizeBytes: stats.size,
      storageSizeBytes: stats.storageSize,
      totalIndexSizeBytes: stats.totalIndexSize,
      seed: 20260825,
      baseTime: new Date(BASE_TIME).toISOString(),
    };

    const outDir = path.join(__dirname, '..', '..', 'docs', 'verification', 'stage-9', 'raw');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'perf-db-manifest.json'), JSON.stringify(manifest, null, 2));

    log(`seeded ${inserted} items across ${users.length} users into ${db.databaseName}`);
    log(`indexes: ${manifest.indexes.join(', ')}`);
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
