'use strict';

/**
 * CLAIM 4  — "Community feed loads with paginated requests, rendering the
 *             first batch of posts within 2 seconds"
 * CLAIM 13 — "Community feed performance degrades slightly when scrolling
 *             through 500+ posts without pagination reset"
 *
 *   node scripts/perf/task-2-feed.js
 *
 * ------------------------------------------------------------------------
 * WHAT "THE FIRST BATCH" IS, MEASURED RATHER THAN ASSUMED
 * ------------------------------------------------------------------------
 * `apps/mobile/src/community/api.ts` sends NO `?limit=` -- its own comment
 * says adding one is not a free optimisation, because at `limit=100` a single
 * feed request issues up to 100 concurrent item lookups, which is the driver's
 * default pool size. So the first batch is the server's default page:
 * `parseLimit`'s `DEFAULT_LIMIT = 24`. Every number below is for
 * `GET /community/posts` with no query string, which is the exact request the
 * app issues. (Stage 8 measured a 20-post page; 24 is what the client
 * actually asks for, and the difference is stated rather than smoothed over.)
 *
 * WHAT THIS NUMBER IS NOT. It is the API's contribution only: request written
 * to last response byte, over loopback, on the same machine. The claim says
 * "rendering", and rendering happens on the handset -- that half belongs to
 * Task 4 and is not claimed here. Ruling 2 applies: this is a LOWER BOUND on
 * what any real deployment would show.
 *
 * ------------------------------------------------------------------------
 * CLAIM 13 IS AMBIGUOUS, SO BOTH READINGS ARE MEASURED
 * ------------------------------------------------------------------------
 * "degrades when scrolling through 500+ posts without pagination reset" can
 * mean two different things and they have different answers:
 *
 *   READING A (DEPTH): the cost of fetching page N grows as N grows -- i.e.
 *   the 21st page (posts 480-504) is slower than the 1st. This is what
 *   "without pagination reset" most directly describes: the client keeps
 *   paging forward instead of starting over. Measured by walking the real
 *   cursor chain through the whole 2,000-post feed, 5 passes.
 *
 *   READING B (CORPUS): a feed CONTAINING 500+ posts is slower to open than a
 *   smaller one -- the first page costs more because there is more behind it.
 *   Measured by re-seeding the fixture at 100 / 500 / 1000 / 2000 / 5000 posts
 *   and timing page 1 at each size.
 *
 * Ruling 6 governs the verdict: the claim is stated as an OBSERVATION, so if
 * neither reading degrades, the document is wrong and this file says so. No
 * delay is added to make it true and no row is dropped.
 *
 * ------------------------------------------------------------------------
 * EXTENDING STAGE 8 RATHER THAN REPEATING IT
 * ------------------------------------------------------------------------
 * Stage 8 established: a 20-post page is 24 Mongo round trips; per-post item
 * queries examine keys proportional to the SNAPSHOT not the collection; `?q=`
 * costs O(feed size) not O(result size); page 2 is `SUBPLAN <- LIMIT <- FETCH
 * <- SORT_MERGE <- IXSCAN <- IXSCAN`, which is NOT a blocking sort. None of
 * that is re-derived here. What is added: the depth curve to page 84, the
 * corpus curve, and the `?q=` cost at a second corpus size so the linearity
 * Stage 8 inferred from one point has two.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const safety = require('./lib/safety');
const { captureRig, whatElseWasRunning } = require('./lib/rig');
const { startApiUnderTest } = require('./lib/api-instance');
const { mintToken } = require('./lib/token');
const { measureEndpoint } = require('./measure-api');
const { timedRequest } = require('./lib/http');
const { getMongoClient } = require('./lib/mongo');
const { summarise, round, formatSummary } = require('./lib/stats');
const { seed: seedCommunity } = require('./seed-community-perf');

const ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'docs', 'verification', 'stage-9', 'task-2');
const RAW_DIR = path.join(ROOT, 'docs', 'verification', 'stage-9', 'raw');
const MONGO_URI = 'mongodb://localhost:27017/wardrobe_perf';
const PORT = 3101;
const FEED = '/community/posts';

const community = JSON.parse(fs.readFileSync(path.join(RAW_DIR, 'perf-community-manifest.json'), 'utf8'));
const TOKEN = mintToken(community.viewerUserId);
const AUTH = { Authorization: `Bearer ${TOKEN}` };

const COLD_SAMPLES = 12;
const WARM_SAMPLES = 50;
const DEPTH_PASSES = 5;
const CORPUS_SIZES = [100, 500, 1000, 2000, 5000];

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function planWalk(explain) {
  const stats = explain.executionStats || {};
  const winning = (explain.queryPlanner && explain.queryPlanner.winningPlan) || {};
  const stages = [];
  const idx = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.stage) stages.push(n.stage);
    if (n.indexName) idx.push(n.indexName);
    if (n.inputStage) walk(n.inputStage);
    if (n.queryPlan) walk(n.queryPlan);
    if (Array.isArray(n.inputStages)) n.inputStages.forEach(walk);
  };
  walk(winning);
  return {
    stages,
    indexNames: [...new Set(idx)],
    blockingSort: stages.includes('SORT'),
    nReturned: stats.nReturned ?? null,
    totalKeysExamined: stats.totalKeysExamined ?? null,
    totalDocsExamined: stats.totalDocsExamined ?? null,
    executionTimeMillis: stats.executionTimeMillis ?? null,
  };
}

/**
 * CLAIM 4, COLD.
 *
 * "Cold" here means the FIRST feed request a freshly started server process
 * ever serves. That is the honest cold path for this API: the Express app and
 * every route module are compiled at import time (so `waitFor('/health')`
 * has already paid that), but Mongoose has not opened its pool for this query
 * shape, WiredTiger has not paged this working set in for this connection, and
 * the MinIO client has not yet fetched and cached the bucket region -- so the
 * first signed URL costs a real round trip into the container VM while every
 * later one costs an HMAC.
 *
 * n process restarts, one measured request each. There is no other way to get
 * n cold samples.
 */
async function coldFeed() {
  const samples = [];
  for (let i = 0; i < COLD_SAMPLES; i += 1) {
    const startedAt = process.hrtime.bigint();
    const api = await startApiUnderTest({ port: PORT, mongoUrl: MONGO_URI, label: `t2-feed-cold-${i}` });
    const readyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    try {
      const res = await timedRequest(`${api.baseUrl}${FEED}`, { headers: AUTH });
      if (res.status !== 200) throw new Error(`cold sample ${i} returned ${res.status}`);
      const body = JSON.parse(res.body);
      samples.push({
        index: i,
        processStartToHealthyMs: readyMs,
        firstFeedRequestMs: res.ms,
        ttfbMs: res.ttfbMs,
        wireBytes: res.wireBytesRead,
        posts: body.posts.length,
      });
      log(`  cold ${String(i + 1).padStart(2)}/${COLD_SAMPLES}  start->healthy ${round(readyMs, 0)} ms   first feed request ${round(res.ms, 1)} ms   ${body.posts.length} posts   ${res.wireBytesRead} B`);
    } finally {
      await api.stop();
    }
    await sleep(500);
  }
  return {
    samples,
    firstFeedRequestMs: summarise(samples.map((s) => s.firstFeedRequestMs), { warmupDiscarded: 0, unit: 'ms' }),
    processStartToHealthyMs: summarise(samples.map((s) => s.processStartToHealthyMs), { warmupDiscarded: 0, unit: 'ms' }),
    // The whole cold path a user would feel if the process were started for
    // them: spawn to healthy, plus the first feed request.
    processStartToFirstFeedMs: summarise(
      samples.map((s) => s.processStartToHealthyMs + s.firstFeedRequestMs),
      { warmupDiscarded: 0, unit: 'ms' },
    ),
  };
}

/** Walk the real cursor chain to the end of the feed, recording every page. */
async function walkFeed(baseUrl, { maxPages = 200 } = {}) {
  const pages = [];
  let cursor;
  let postsSoFar = 0;
  for (let p = 1; p <= maxPages; p += 1) {
    const url = `${baseUrl}${FEED}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await timedRequest(url, { headers: AUTH });
    if (res.status !== 200) throw new Error(`page ${p} returned ${res.status}: ${res.body.slice(0, 200)}`);
    const body = JSON.parse(res.body);
    postsSoFar += body.posts.length;
    pages.push({
      page: p,
      postsBefore: postsSoFar - body.posts.length,
      postsAfter: postsSoFar,
      ms: res.ms,
      ttfbMs: res.ttfbMs,
      wireBytes: res.wireBytesRead,
      posts: body.posts.length,
    });
    cursor = body.nextCursor;
    if (!cursor) break;
  }
  return pages;
}

function band(pages, from, to) {
  const inBand = pages.filter((p) => p.postsBefore >= from && p.postsBefore < to);
  return inBand.length ? summarise(inBand.map((p) => p.ms), { warmupDiscarded: 0, unit: 'ms' }) : null;
}

async function main() {
  await safety.recoverLeftovers();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const rigBefore = await captureRig({ mongoUri: MONGO_URI, apiHost: `http://localhost:${PORT}` });

  const out = {
    meta: {
      at: new Date().toISOString(),
      harness: 'scripts/perf/task-2-feed.js',
      claims: [
        'Claim 4 — "Community feed loads with paginated requests, rendering the first batch of posts within 2 seconds"',
        'Claim 13 — "Community feed performance degrades slightly when scrolling through 500+ posts without pagination reset"',
      ],
      firstBatchDefinition:
        'GET /community/posts with NO query string — exactly what apps/mobile/src/community/api.ts issues. The server default (parseLimit DEFAULT_LIMIT) is 24 posts, each carrying 3 snapshotted items. Stage 8 measured a 20-post page; 24 is what the client actually asks for.',
      scopeNote:
        'API-side only: request written -> last response byte, loopback, harness and API on one machine. The claim says "rendering", which happens on the handset; that half is Task 4. Ruling 2: this is a lower bound on any real deployment, not an estimate of one.',
      fixture: {
        database: 'wardrobe_perf',
        posts: community.posts,
        itemsPerPost: community.itemsPerPost,
        items: 46128,
        viewer: community.viewerUserId,
        viewerName: community.viewerName,
        viewerItems: community.viewerItemCount,
      },
    },
    rigBefore,
  };

  // -------------------------------------------------------------------
  // CLAIM 4
  // -------------------------------------------------------------------
  log(`== Claim 4: COLD first batch (${COLD_SAMPLES} fresh server processes, one measured request each) ==`);
  out.cold = await coldFeed();
  log(`  first feed request       ${formatSummary(out.cold.firstFeedRequestMs, 1)}`);
  log(`  process start -> healthy ${formatSummary(out.cold.processStartToHealthyMs, 0)}`);

  log(`\n== Claim 4: WARM first batch (n=${WARM_SAMPLES}, 3 warm-up discarded) ==`);
  const api = await startApiUnderTest({ port: PORT, mongoUrl: MONGO_URI, label: 't2-feed-warm' });
  try {
    const warm = await measureEndpoint({
      url: `${api.baseUrl}${FEED}`, headers: AUTH, samples: WARM_SAMPLES, warmup: 3, label: `GET ${FEED} (warm)`,
    });
    if (!warm.ok) throw new Error(warm.error);
    out.warm = {
      latencyMs: warm.latencyMs, ttfbMs: warm.ttfbMs,
      responseWireBytes: warm.responseWireBytes, requestWireBytes: warm.requestWireBytes,
      statuses: warm.statuses, hostLoadAverage: os.loadavg(), environment: whatElseWasRunning(),
    };
    log(`  latency  ${formatSummary(warm.latencyMs, 1)}`);
    log(`  ttfb     ${formatSummary(warm.ttfbMs, 1)}`);
    log(`  bytes    ${formatSummary(warm.responseWireBytes, 0)}`);

    // Comparators the claim does not ask for but a reader needs: the same page
    // with the client's default vs the maximum the API allows. Stage 8's
    // pool-saturation arithmetic (limit=100 -> up to 100 concurrent finds,
    // which is the driver's default maxPoolSize) is about THIS request.
    log('\n== comparator: the same page at ?limit=1, 24 (default) and 100 (the API maximum) ==');
    out.byLimit = [];
    for (const limit of [1, 24, 100]) {
      const r = await measureEndpoint({
        url: `${api.baseUrl}${FEED}?limit=${limit}`, headers: AUTH, samples: 25, warmup: 3, label: `limit=${limit}`,
      });
      if (!r.ok) throw new Error(r.error);
      out.byLimit.push({ limit, latencyMs: r.latencyMs, responseWireBytes: r.responseWireBytes });
      log(`  limit=${String(limit).padStart(3)}  ${formatSummary(r.latencyMs, 1)}   ${round(r.responseWireBytes.median, 0)} B`);
    }

    // -----------------------------------------------------------------
    // CLAIM 13, READING A: depth
    // -----------------------------------------------------------------
    log(`\n== Claim 13 reading A: walking the real cursor chain through all ${community.posts} posts, ${DEPTH_PASSES} passes ==`);
    const passes = [];
    for (let p = 0; p < DEPTH_PASSES; p += 1) {
      const pages = await walkFeed(api.baseUrl);
      passes.push(pages);
      const last = pages[pages.length - 1];
      log(`  pass ${p + 1}: ${pages.length} pages, ${last.postsAfter} posts, total ${round(pages.reduce((a, b) => a + b.ms, 0), 0)} ms`);
    }
    const allPages = passes.flat();
    out.depth = {
      passes: DEPTH_PASSES,
      pagesPerPass: passes[0].length,
      postsPerPage: 24,
      perPage: allPages,
      bands: {
        'posts 0-99': band(allPages, 0, 100),
        'posts 100-499': band(allPages, 100, 500),
        'posts 500-999': band(allPages, 500, 1000),
        'posts 1000-1499': band(allPages, 1000, 1500),
        'posts 1500-1999': band(allPages, 1500, 2000),
        'before 500 (the claim\'s threshold)': band(allPages, 0, 500),
        'at or after 500': band(allPages, 500, 1e9),
      },
      page1: summarise(allPages.filter((p) => p.page === 1).map((p) => p.ms), { unit: 'ms' }),
      lastPage: summarise(allPages.filter((p) => p.page === passes[0].length).map((p) => p.ms), { unit: 'ms' }),
      hostLoadAverage: os.loadavg(),
    };
    for (const [k, v] of Object.entries(out.depth.bands)) {
      if (v) log(`  ${k.padEnd(38)} ${formatSummary(v, 1)}`);
    }
    const before = out.depth.bands['before 500 (the claim\'s threshold)'];
    const after = out.depth.bands['at or after 500'];
    out.depth.ratioAfter500ToBefore500 = after && before ? after.median / before.median : null;
    log(`  median ratio (>=500 posts deep : <500 posts deep) = ${round(out.depth.ratioAfter500ToBefore500, 3)}x`);

    // -----------------------------------------------------------------
    // `?q=` cost, extending Stage 8's single data point
    // -----------------------------------------------------------------
    log('\n== ?q= cost: a term with ONE hit vs a common term, at this corpus size ==');
    out.search = [];
    for (const [label, term] of [['rare (1 hit in 2000)', 'needle0'], ['common', 'linen'], ['absent', 'zzzznotacaption']]) {
      const r = await measureEndpoint({
        url: `${api.baseUrl}${FEED}?q=${encodeURIComponent(term)}`, headers: AUTH, samples: 25, warmup: 3, label,
      });
      if (!r.ok) throw new Error(r.error);
      const hits = JSON.parse((await timedRequest(`${api.baseUrl}${FEED}?q=${encodeURIComponent(term)}`, { headers: AUTH })).body).posts.length;
      out.search.push({ label, term, hits, latencyMs: r.latencyMs, responseWireBytes: r.responseWireBytes });
      log(`  ${label.padEnd(22)} "${term}"  ${hits} hits on page 1   ${formatSummary(r.latencyMs, 1)}`);
    }
  } finally {
    await api.stop();
  }

  // -------------------------------------------------------------------
  // Database-level plans behind the depth curve
  // -------------------------------------------------------------------
  log('\n== database-level: the plan behind page 1, page 21 (post 500) and page 84 (post 2000) ==');
  const client = await getMongoClient(MONGO_URI);
  try {
    const coll = client.db().collection('communityposts');
    const { ObjectId } = require(require.resolve('mongodb', {
      paths: [path.dirname(require.resolve('mongoose/package.json', { paths: [path.join(ROOT, 'apps', 'api')] }))],
    }));
    const plans = [];
    for (const skipPosts of [0, 240, 480, 984, 1992]) {
      let filter = {};
      if (skipPosts > 0) {
        const anchor = (await coll.find({}).sort({ createdAt: -1, _id: -1 }).skip(skipPosts - 1).limit(1).toArray())[0];
        filter = {
          $or: [
            { createdAt: { $lt: anchor.createdAt } },
            { createdAt: anchor.createdAt, _id: { $lt: new ObjectId(anchor._id) } },
          ],
        };
      }
      const explain = await coll.find(filter).sort({ createdAt: -1, _id: -1 }).limit(25).explain('executionStats');
      const durations = [];
      for (let i = 0; i < 28; i += 1) {
        const t = process.hrtime.bigint();
        await coll.find(filter).sort({ createdAt: -1, _id: -1 }).limit(25).toArray();
        if (i >= 3) durations.push(Number(process.hrtime.bigint() - t) / 1e6);
      }
      const row = {
        postsSkipped: skipPosts,
        approxPage: Math.floor(skipPosts / 24) + 1,
        plan: planWalk(explain),
        durationMs: summarise(durations, { warmupDiscarded: 3, unit: 'ms' }),
      };
      plans.push(row);
      log(`  posts skipped ${String(skipPosts).padStart(5)} (page ~${String(row.approxPage).padStart(3)})  ${row.plan.stages.join('<-').padEnd(52)} keys=${String(row.plan.totalKeysExamined).padEnd(6)} docs=${String(row.plan.totalDocsExamined).padEnd(6)} med=${round(row.durationMs.median, 3)} ms`);
    }
    out.depthPlans = plans;

    // The `?q=` plan at this corpus size, so the O(feed size) shape Stage 8
    // inferred from one collection has a second point.
    log('\n== database-level: ?q= keys examined at this corpus size ==');
    out.searchPlans = [];
    for (const [label, term] of [['rare (1 hit)', 'needle0'], ['common', 'linen'], ['absent', 'zzzznotacaption']]) {
      const filter = { caption: { $regex: term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } };
      const explain = await coll.find(filter).sort({ createdAt: -1, _id: -1 }).limit(25).explain('executionStats');
      const p = planWalk(explain);
      out.searchPlans.push({ label, term, plan: p, corpusSize: await coll.countDocuments() });
      log(`  ${label.padEnd(14)} "${term}"  ${p.stages.join('<-').padEnd(30)} keys=${p.totalKeysExamined} docs=${p.totalDocsExamined} returned=${p.nReturned}`);
    }
  } finally {
    await client.close();
  }

  // -------------------------------------------------------------------
  // CLAIM 13, READING B: corpus size
  // -------------------------------------------------------------------
  log('\n== Claim 13 reading B: feed page 1 against corpora of 100 / 500 / 1000 / 2000 / 5000 posts ==');
  log('   (the fixture is re-seeded at each size and restored to 2000 at the end)');
  out.corpus = [];
  for (const size of CORPUS_SIZES) {
    await seedCommunity({ posts: size, log: () => {} });
    const inst = await startApiUnderTest({ port: PORT, mongoUrl: MONGO_URI, label: `t2-feed-corpus-${size}` });
    try {
      const r = await measureEndpoint({
        url: `${inst.baseUrl}${FEED}`, headers: AUTH, samples: 30, warmup: 3, label: `page 1, ${size} posts`,
      });
      if (!r.ok) throw new Error(r.error);
      // Also the deepest reachable page at this size, so the corpus curve and
      // the depth curve can be read together.
      const pages = await walkFeed(inst.baseUrl);
      const row = {
        corpusPosts: size,
        page1LatencyMs: r.latencyMs,
        page1WireBytes: r.responseWireBytes,
        pagesWalked: pages.length,
        allPagesLatencyMs: summarise(pages.map((p) => p.ms), { unit: 'ms' }),
        lastPageMs: pages[pages.length - 1].ms,
        hostLoadAverage: os.loadavg(),
      };
      out.corpus.push(row);
      log(`  ${String(size).padStart(5)} posts   page 1 ${formatSummary(r.latencyMs, 1)}   whole walk ${pages.length} pages, last page ${round(row.lastPageMs, 1)} ms`);
    } finally {
      await inst.stop();
    }
  }

  log(`\n== restoring the fixture to ${community.posts} posts ==`);
  await seedCommunity({ posts: community.posts, log: (...a) => log('  ', ...a) });

  out.rigAfter = await captureRig({ mongoUri: MONGO_URI, apiHost: `http://localhost:${PORT}` });

  // -------------------------------------------------------------------
  // Verdicts
  // -------------------------------------------------------------------
  const corpusFirst = out.corpus[0];
  const corpusAt2000 = out.corpus.find((c) => c.corpusPosts === 2000);
  const corpusLast = out.corpus[out.corpus.length - 1];
  out.verdicts = {
    claim4: {
      claimed: 'first batch within 2000 ms',
      warmMedianMs: out.warm.latencyMs.median,
      warmP95Ms: out.warm.latencyMs.p95,
      warmMaxMs: out.warm.latencyMs.max,
      coldMedianMs: out.cold.firstFeedRequestMs.median,
      coldP95Ms: out.cold.firstFeedRequestMs.p95,
      coldMaxMs: out.cold.firstFeedRequestMs.max,
      holdsAtWarmP95: out.warm.latencyMs.p95 < 2000,
      holdsAtColdMax: out.cold.firstFeedRequestMs.max < 2000,
    },
    claim13: {
      readingA_depth: {
        before500: out.depth.bands['before 500 (the claim\'s threshold)'],
        after500: out.depth.bands['at or after 500'],
        medianRatio: out.depth.ratioAfter500ToBefore500,
        degrades: out.depth.ratioAfter500ToBefore500 !== null && out.depth.ratioAfter500ToBefore500 >= 1.1,
      },
      readingB_corpus: {
        smallest: corpusFirst && { posts: corpusFirst.corpusPosts, medianMs: corpusFirst.page1LatencyMs.median },
        at2000: corpusAt2000 && { posts: 2000, medianMs: corpusAt2000.page1LatencyMs.median },
        largest: corpusLast && { posts: corpusLast.corpusPosts, medianMs: corpusLast.page1LatencyMs.median },
        medianRatioLargestToSmallest:
          corpusFirst && corpusLast ? corpusLast.page1LatencyMs.median / corpusFirst.page1LatencyMs.median : null,
      },
    },
  };

  fs.writeFileSync(path.join(OUT_DIR, 'claim-04-13-feed.json'), JSON.stringify(out, null, 2));
  log('\n=== VERDICT SUMMARY ===');
  log(`  Claim 4 warm  : median ${round(out.warm.latencyMs.median, 1)} ms, p95 ${round(out.warm.latencyMs.p95, 1)} ms, max ${round(out.warm.latencyMs.max, 1)} ms (n=${out.warm.latencyMs.n})`);
  log(`  Claim 4 cold  : median ${round(out.cold.firstFeedRequestMs.median, 1)} ms, p95 ${round(out.cold.firstFeedRequestMs.p95, 1)} ms, max ${round(out.cold.firstFeedRequestMs.max, 1)} ms (n=${out.cold.firstFeedRequestMs.n})`);
  log(`  Claim 13 A    : <500 deep median ${round(out.depth.bands['before 500 (the claim\'s threshold)'].median, 1)} ms vs >=500 deep median ${round(out.depth.bands['at or after 500'].median, 1)} ms — ratio ${round(out.depth.ratioAfter500ToBefore500, 3)}x`);
  log(`  Claim 13 B    : page 1 at ${corpusFirst.corpusPosts} posts ${round(corpusFirst.page1LatencyMs.median, 1)} ms vs at ${corpusLast.corpusPosts} posts ${round(corpusLast.page1LatencyMs.median, 1)} ms — ratio ${round(out.verdicts.claim13.readingB_corpus.medianRatioLargestToSmallest, 3)}x`);
  log(`\nledger after run: ${safety.listLeftovers().length} leftover(s)`);
  log('written: docs/verification/stage-9/task-2/claim-04-13-feed.json');
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}

module.exports = { main };
