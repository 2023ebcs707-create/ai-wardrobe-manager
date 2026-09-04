'use strict';

/**
 * CLAIM 7, against a RUNNING mongod: "MongoDB queries are indexed on
 * frequently accessed fields (UserID, ItemID, OutfitID), ensuring consistent
 * read performance".
 *
 *   cd apps/api && node --require ts-node/register \
 *     ../../scripts/perf/task-2-indexes.js
 *
 * (`scripts/perf/task-2-indexes.sh` runs exactly that.)
 *
 * WHY THE REAL MODELS AND NOT THE RAW DRIVER. Stage 5 and Stage 8 both
 * verified indexes by connecting Mongoose to a live mongod, reconciling the
 * declared indexes and listing what the server actually holds. This follows
 * them, and it must: the raw driver would let this script create whatever
 * index it wanted to find, which proves nothing about the shipped schema. Here
 * the index set comes from `apps/api/src/models/*.ts` -- the product's own
 * declarations -- and the server is asked what it has.
 *
 * `syncIndexes()` RECONCILES INDEX OPTIONS, not just keys. An earlier claim in
 * this project that it compares by key only was false and was corrected; it is
 * restated here so it is not reintroduced. `autoIndex` (Mongoose's default)
 * only *creates* missing indexes -- it never drops or rebuilds one whose
 * options have drifted, so an index built once with the wrong `unique` stays
 * wrong forever under `autoIndex` and is repaired by `syncIndexes()`.
 *
 * THE PART THAT IS NOT ON RECORD ANYWHERE YET: existence is not use. Stage 5
 * recorded that `Outfit.itemIds_1` EXISTS; nothing recorded whether any query
 * uses it. So every index below is checked twice --
 *
 *   (1) does the server hold it, with the options the model declared?
 *   (2) does a REAL PRODUCT QUERY choose it, and what does the plan examine?
 *
 * and an index that passes (1) and fails (2) is reported as an index that
 * exists and is never used, which is a different fact from "indexed".
 *
 * Every query below is copied from a route file, with the file and line
 * recorded beside it, so nothing here is a query invented to be fast.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const API = path.join(ROOT, 'apps', 'api');
const OUT_DIR = path.join(ROOT, 'docs', 'verification', 'stage-9', 'task-2');
const RAW_DIR = path.join(ROOT, 'docs', 'verification', 'stage-9', 'raw');
const MONGO_URI = 'mongodb://localhost:27017/wardrobe_perf';

const mongoose = require(require.resolve('mongoose', { paths: [API] }));
const { captureRig } = require('./lib/rig');
const { summarise, round } = require('./lib/stats');

const community = JSON.parse(fs.readFileSync(path.join(RAW_DIR, 'perf-community-manifest.json'), 'utf8'));
const wardrobe = JSON.parse(fs.readFileSync(path.join(RAW_DIR, 'perf-db-manifest.json'), 'utf8'));

const log = (...a) => console.log(...a);

function planSummary(explain) {
  const stats = explain.executionStats || {};
  const winning = (explain.queryPlanner && explain.queryPlanner.winningPlan) || {};
  const stages = [];
  const indexes = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.stage) stages.push(node.stage);
    if (node.indexName) indexes.push(node.indexName);
    if (node.inputStage) walk(node.inputStage);
    if (node.queryPlan) walk(node.queryPlan);
    if (Array.isArray(node.inputStages)) node.inputStages.forEach(walk);
  };
  walk(winning);
  return {
    stages,
    indexNames: [...new Set(indexes)],
    usedIndex: stages.includes('IXSCAN'),
    collectionScan: stages.includes('COLLSCAN'),
    blockingSort: stages.includes('SORT'),
    nReturned: stats.nReturned ?? null,
    totalKeysExamined: stats.totalKeysExamined ?? null,
    totalDocsExamined: stats.totalDocsExamined ?? null,
    executionTimeMillis: stats.executionTimeMillis ?? null,
  };
}

/** Time a query the way the driver sees it, and explain the same query. */
async function timeAndExplain(build, { samples = 25, warmup = 3 } = {}) {
  const durations = [];
  for (let i = 0; i < warmup + samples; i += 1) {
    const started = process.hrtime.bigint();
    await build().exec();
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (i >= warmup) durations.push(ms);
  }
  const explain = await build().explain('executionStats');
  return {
    durationMs: summarise(durations, { warmupDiscarded: warmup, unit: 'ms' }),
    plan: planSummary(explain),
  };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const rig = await captureRig({ mongoUri: MONGO_URI, apiHost: 'n/a (no API server involved -- driver-level)' });

  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  const db = mongoose.connection.db;
  const buildInfo = await db.admin().command({ buildInfo: 1 });

  const { ClothingItem } = require(path.join(API, 'src/models/ClothingItem'));
  const { Outfit } = require(path.join(API, 'src/models/Outfit'));
  const { CommunityPost } = require(path.join(API, 'src/models/CommunityPost'));
  const { PostLike } = require(path.join(API, 'src/models/PostLike'));
  const { PostSave } = require(path.join(API, 'src/models/PostSave'));
  const { WearHistory } = require(path.join(API, 'src/models/WearHistory'));
  const { LaundryStatus } = require(path.join(API, 'src/models/LaundryStatus'));
  const { User } = require(path.join(API, 'src/models/User'));

  const models = { ClothingItem, Outfit, CommunityPost, PostLike, PostSave, WearHistory, LaundryStatus, User };

  // ---------------------------------------------------------------------
  // (1) EXISTENCE, reconciled against the model declarations on a live server
  // ---------------------------------------------------------------------
  log('== reconciling declared indexes against the running server (syncIndexes) ==');
  const existence = {};
  for (const [name, model] of Object.entries(models)) {
    const before = await model.collection.indexes();
    // syncIndexes() reconciles OPTIONS as well as keys: it drops an index whose
    // options no longer match the declaration and rebuilds it. autoIndex does
    // not, which is why an index built once with the wrong options survives an
    // autoIndex boot forever.
    const dropped = await model.syncIndexes();
    const after = await model.collection.indexes();
    existence[name] = {
      collection: model.collection.collectionName,
      declaredInSchema: model.schema.indexes().map(([keys, opts]) => ({ keys, options: opts || {} })),
      indexesBeforeSync: before.map((i) => ({ name: i.name, key: i.key, unique: !!i.unique })),
      indexesAfterSync: after.map((i) => ({ name: i.name, key: i.key, unique: !!i.unique })),
      syncIndexesDropped: dropped,
      // If syncIndexes() dropped nothing and the sets are identical, the live
      // server already matched the shipped declarations exactly.
      matchedDeclarationsBeforeSync:
        dropped.length === 0 && JSON.stringify(before.map((i) => i.name).sort()) === JSON.stringify(after.map((i) => i.name).sort()),
    };
    log(`  ${name.padEnd(15)} ${after.map((i) => i.name).join(', ')}${dropped.length ? `   (syncIndexes dropped: ${dropped.join(', ')})` : ''}`);
  }

  // ---------------------------------------------------------------------
  // (2) USE: real product queries, explained
  // ---------------------------------------------------------------------
  const viewerId = community.viewerUserId;
  const wardrobeUserId = wardrobe.largeWardrobeUserId;
  // Pinned to rows that ACTUALLY EXIST rather than to whatever `findOne({})`
  // returns first. The first draft took `anItem` from `findOne({userId})` and
  // asked for `category: 'top'`; both explained cleanly against ZERO matching
  // documents -- an IXSCAN that examines 0 keys and returns 0 rows looks
  // identical in a plan summary to one that works, and it proves nothing.
  // `nReturned > 0` is asserted below for every query for the same reason.
  const aLaundryRow = await LaundryStatus.findOne({}).lean();
  const anItem = await ClothingItem.findOne({ _id: aLaundryRow.itemId }).lean();
  const anOutfit = await Outfit.findOne({ userId: viewerId }).lean();
  const wardrobeCategories = await ClothingItem.distinct('category', { userId: wardrobeUserId });
  const aCategory = wardrobeCategories.sort()[0];
  // The largest wardrobe in the fixture, for the queries whose cost is a
  // function of how much the user owns rather than of the page size.
  const bigWardrobeAgg = await ClothingItem.aggregate([
    { $group: { _id: '$userId', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
    { $limit: 1 },
  ]);
  const bigWardrobeUserId = bigWardrobeAgg[0]._id;
  const bigWardrobeItems = bigWardrobeAgg[0].n;
  const bigCategories = await ClothingItem.distinct('category', { userId: bigWardrobeUserId });
  const aBigCategory = bigCategories.sort()[0];
  const aPost = await CommunityPost.findOne({}).sort({ createdAt: -1 }).lean();
  const pageOfPosts = await CommunityPost.find({}).sort({ createdAt: -1, _id: -1 }).limit(24).lean();
  const postIds = pageOfPosts.map((p) => p._id);
  const snapshotIds = aPost.itemIds.map((id) => id.toHexString());

  /**
   * Each entry names the FIELD CLASS Claim 7 mentions, the route file and line
   * the query was copied from, and the index the schema intends to serve it.
   */
  const queries = [
    // ---- UserID ----
    {
      field: 'UserID', label: 'GET /items — wardrobe page 1',
      source: 'apps/api/src/routes/items.ts:405',
      expectIndex: 'userId_1_createdAt_-1__id_-1',
      build: () => ClothingItem.find({ userId: wardrobeUserId }).sort({ createdAt: -1, _id: -1 }).limit(25),
    },
    {
      field: 'UserID', label: 'GET /items?category= — category-filtered page 1',
      source: 'apps/api/src/routes/items.ts:405 (with ?category=)',
      expectIndex: 'userId_1_createdAt_-1__id_-1 or userId_1_category_1',
      build: () => ClothingItem.find({ userId: wardrobeUserId, category: aCategory }).sort({ createdAt: -1, _id: -1 }).limit(25),
    },
    {
      // The 120-item wardrobe hides this: 10 rows sort in microseconds. The
      // 2,000-item filler account is the same query with a set big enough for
      // the blocking SORT to be worth naming.
      field: 'UserID', label: 'GET /items?category= — category-filtered, 2,000-item wardrobe',
      source: 'apps/api/src/routes/items.ts:405 (with ?category=)',
      expectIndex: 'userId_1_category_1 + an in-memory SORT',
      build: () => ClothingItem.find({ userId: bigWardrobeUserId, category: aBigCategory }).sort({ createdAt: -1, _id: -1 }).limit(25),
    },
    {
      field: 'UserID', label: 'GET /analytics/usage — most-worn ranking',
      source: 'apps/api/src/routes/analytics.ts:83',
      expectIndex: 'userId_1_wearCount_-1_lastWornAt_-1__id_-1',
      build: () => ClothingItem.find({ userId: wardrobeUserId }).sort({ wearCount: -1, lastWornAt: -1, _id: -1 }).limit(5),
    },
    {
      field: 'UserID', label: 'GET /outfits — outfit list page 1',
      source: 'apps/api/src/routes/outfits.ts:348',
      expectIndex: 'userId_1_createdAt_-1__id_-1',
      build: () => Outfit.find({ userId: viewerId }).sort({ createdAt: -1, _id: -1 }).limit(25),
    },
    {
      field: 'UserID', label: 'GET /wear-history — page 1',
      source: 'apps/api/src/routes/wearHistory.ts:288',
      expectIndex: 'userId_1_wornAt_-1__id_-1',
      build: () => WearHistory.find({ userId: viewerId }).sort({ wornAt: -1, _id: -1 }).limit(25),
    },
    {
      field: 'UserID', label: 'GET /community/saved — saved list page 1',
      source: 'apps/api/src/routes/community.ts:806',
      expectIndex: 'userId_1_createdAt_-1__id_-1',
      build: () => PostSave.find({ userId: viewerId }).sort({ createdAt: -1, _id: -1 }).limit(25),
    },
    {
      field: 'UserID', label: 'hydratePosts — viewer’s likes for one feed page',
      source: 'apps/api/src/routes/community.ts:459',
      expectIndex: 'postId_1_userId_1',
      build: () => PostLike.find({ postId: { $in: postIds }, userId: viewerId }),
    },
    {
      field: 'UserID', label: 'hydratePosts — viewer’s saves for one feed page',
      source: 'apps/api/src/routes/community.ts:460',
      expectIndex: 'postId_1_userId_1',
      build: () => PostSave.find({ postId: { $in: postIds }, userId: viewerId }),
    },
    {
      field: 'UserID', label: 'GET /suggestions — whole wardrobe load',
      source: 'apps/api/src/routes/suggestions.ts:185',
      expectIndex: 'any userId-leading index',
      build: () => ClothingItem.find({ userId: wardrobeUserId }),
    },
    {
      field: 'UserID', label: 'DELETE /community/posts/:id — author’s own posts',
      source: 'apps/api/src/models/CommunityPost.ts:85 (the {userId:1} index)',
      expectIndex: 'userId_1',
      build: () => CommunityPost.find({ userId: aPost.userId }).limit(25),
    },

    // ---- ItemID ----
    {
      field: 'ItemID', label: 'GET /items/:id — one item by id, owner-scoped',
      source: 'apps/api/src/routes/items.ts:206',
      expectIndex: '_id_',
      build: () => ClothingItem.find({ _id: anItem._id, userId: anItem.userId }).limit(1),
    },
    {
      field: 'ItemID', label: 'feed hydration — a post’s snapshotted items',
      source: 'apps/api/src/routes/community.ts:404 (signSnapshotItems)',
      expectIndex: '_id_',
      build: () => ClothingItem.find({ _id: { $in: snapshotIds }, userId: aPost.userId }),
    },
    {
      field: 'ItemID', label: 'POST /outfits — resolve the composed items',
      source: 'apps/api/src/routes/outfits.ts:120 (resolveOwnedItems)',
      expectIndex: '_id_',
      build: () => ClothingItem.find({ _id: { $in: snapshotIds }, userId: aPost.userId }),
    },
    {
      field: 'ItemID', label: 'laundry transition log for one item',
      source: 'apps/api/src/models/LaundryStatus.ts:77 (the {itemId:1,changedAt:-1} index)',
      expectIndex: 'itemId_1_changedAt_-1',
      build: () => LaundryStatus.find({ itemId: aLaundryRow.itemId }).sort({ changedAt: -1 }).limit(25),
    },
    {
      field: 'ItemID', label: 'outfits containing a given item (Outfit.itemIds_1)',
      source: 'apps/api/src/models/Outfit.ts:40 — declared, and NOT issued by any route today',
      expectIndex: 'itemIds_1',
      neverIssuedByProductCode: true,
      build: () => Outfit.find({ itemIds: anOutfit.itemIds[0] }).limit(25),
    },

    // ---- OutfitID ----
    {
      field: 'OutfitID', label: 'GET /outfits/:id — one outfit by id, owner-scoped',
      source: 'apps/api/src/routes/outfits.ts:195',
      expectIndex: '_id_',
      build: () => Outfit.find({ _id: anOutfit._id, userId: viewerId }).limit(1),
    },
    {
      field: 'OutfitID', label: 'POST /wear-history — the outfit being logged',
      source: 'apps/api/src/routes/wearHistory.ts:61',
      expectIndex: '_id_',
      build: () => Outfit.find({ _id: anOutfit._id, userId: viewerId }).limit(1),
    },
    {
      field: 'OutfitID', label: 'GET /wear-history — resolve the page’s outfits',
      source: 'apps/api/src/routes/wearHistory.ts:337',
      expectIndex: '_id_',
      build: () => Outfit.find({ _id: { $in: [anOutfit._id] }, userId: viewerId }),
    },
    {
      field: 'OutfitID', label: 'POST /community/posts — the outfit being shared',
      source: 'apps/api/src/routes/community.ts:82 (findOwnedOutfit)',
      expectIndex: '_id_',
      build: () => Outfit.find({ _id: anOutfit._id, userId: viewerId }).limit(1),
    },
    {
      field: 'OutfitID', label: 'wear history for one outfit (WearHistory.outfitId_1)',
      source: 'apps/api/src/models/WearHistory.ts:55 — declared, and NOT issued by any route today',
      expectIndex: 'outfitId_1',
      neverIssuedByProductCode: true,
      build: () => WearHistory.find({ outfitId: anOutfit._id }).limit(25),
    },

    // ---- the feed's own sort, which Claim 7 does NOT name ----
    {
      field: '(not named by Claim 7)', label: 'GET /community/posts — feed page 1, all users',
      source: 'apps/api/src/routes/community.ts:614',
      expectIndex: 'createdAt_-1__id_-1',
      build: () => CommunityPost.find({}).sort({ createdAt: -1, _id: -1 }).limit(25),
    },
  ];

  log('\n== explaining real product queries against the live server ==');
  const use = [];
  for (const q of queries) {
    const r = await timeAndExplain(q.build, { samples: 20, warmup: 3 });
    // A plan over zero documents is not evidence that an index serves a query.
    r.returnedRows = r.plan.nReturned;
    r.meaningful = r.plan.nReturned > 0;
    use.push({ ...q, build: undefined, source: q.source, ...r });
    if (!r.meaningful) log(`  !! ${q.label}: returned 0 rows -- this plan proves nothing`);
    log(
      `  ${q.field.padEnd(22)} ${q.label.padEnd(56)} ${r.plan.stages.join('<-').padEnd(34)} ` +
        `idx=${(r.plan.indexNames.join('+') || 'NONE').padEnd(42)} keys=${String(r.plan.totalKeysExamined).padEnd(7)} ` +
        `docs=${String(r.plan.totalDocsExamined).padEnd(7)} ret=${String(r.plan.nReturned).padEnd(5)} med=${round(r.durationMs.median, 3)}ms`,
    );
  }

  const payload = {
    meta: {
      at: new Date().toISOString(),
      harness: 'scripts/perf/task-2-indexes.js',
      claim: 'Claim 7 — "MongoDB queries are indexed on frequently accessed fields (UserID, ItemID, OutfitID), ensuring consistent read performance"',
      method:
        'Mongoose connected to a RUNNING mongod; syncIndexes() reconciled the shipped model declarations (options as well as keys) against the server; then every query below was copied from a route file, timed driver-side (20 samples, 3 warm-up discarded) and explained with executionStats.',
      mongoVersion: buildInfo.version,
      database: db.databaseName,
    },
    rig,
    fixtureAnchors: {
      viewerUserId: viewerId,
      wardrobeUserId,
      categoryUsed: aCategory,
      bigWardrobeUserId: String(bigWardrobeUserId),
      bigWardrobeItems,
      bigCategoryUsed: aBigCategory,
      itemId: String(anItem._id),
      outfitId: String(anOutfit._id),
      postId: String(aPost._id),
    },
    existence,
    use,
    emptyPlans: use.filter((u) => !u.meaningful).map((u) => u.label),
  };
  fs.writeFileSync(path.join(OUT_DIR, 'claim-07-indexes.json'), JSON.stringify(payload, null, 2));
  log('\nwritten: docs/verification/stage-9/task-2/claim-07-indexes.json');

  await mongoose.disconnect();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
