'use strict';

/**
 * METRIC CLASS: db-query.
 *
 * Times a MongoDB query from the driver's point of view -- `find(...).sort(...)
 * .limit(...).toArray()`, wall clock, monotonic -- and records the query plan
 * that produced it. Both halves matter: the plan says WHY the number is what
 * it is, and it is the plan, not the number, that Claim 7 ("MongoDB queries
 * are indexed on frequently accessed fields") is actually about.
 *
 * WARM-UP POLICY. The first `warmup` executions are issued and discarded. The
 * first execution of a query pays for the driver's connection handshake, the
 * query planner's evaluation of candidate plans (the winning plan is then
 * cached for that shape), and WiredTiger reading pages off disk into its
 * cache. All three are one-off costs of the first-ever run and none of them is
 * what "consistent read performance" is claiming. The retained samples
 * therefore describe a WARM cache: the fixture is ~22 MB against a default
 * WiredTiger cache of several GB, so after warm-up the working set is
 * resident, and these numbers must not be read as cold-disk numbers.
 *
 * THE NEGATIVE CONTROL for this class is `cloneWithoutIndexes()`: the same
 * documents in a collection with no index but `_id`. If the number does not
 * move between an IXSCAN over 46,128 documents and a COLLSCAN over the same
 * 46,128 documents, this instrument is measuring something other than the
 * query and every number it produces is void.
 */

const { getMongoClient } = require('./lib/mongo');
const { summarise, formatSummary } = require('./lib/stats');
const safety = require('./lib/safety');

function planSummary(explain) {
  const stats = explain.executionStats || {};
  const winning = (explain.queryPlanner && explain.queryPlanner.winningPlan) || {};
  const stages = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.stage) stages.push(node.stage);
    if (node.inputStage) walk(node.inputStage);
    if (node.queryPlan) walk(node.queryPlan);
    if (Array.isArray(node.inputStages)) node.inputStages.forEach(walk);
  };
  walk(winning);
  const indexName = JSON.stringify(winning).match(/"indexName":"([^"]+)"/);
  return {
    stages,
    indexName: indexName ? indexName[1] : null,
    usedIndex: stages.includes('IXSCAN'),
    collectionScan: stages.includes('COLLSCAN'),
    inMemorySort: stages.includes('SORT'),
    nReturned: stats.nReturned ?? null,
    totalKeysExamined: stats.totalKeysExamined ?? null,
    totalDocsExamined: stats.totalDocsExamined ?? null,
    executionTimeMillis: stats.executionTimeMillis ?? null,
  };
}

async function measureQuery(options) {
  const {
    uri = 'mongodb://localhost:27017/wardrobe_perf',
    collection = 'clothingitems',
    filter,
    sort = { createdAt: -1, _id: -1 },
    limit = 25,
    samples = 25,
    warmup = 3,
    label = `${collection} find`,
    client: providedClient = null,
  } = options;

  const client = providedClient || (await getMongoClient(uri));
  try {
    const coll = client.db().collection(collection);
    const durations = [];
    let lastCount = null;
    for (let i = 0; i < warmup + samples; i += 1) {
      const started = process.hrtime.bigint();
      const docs = await coll.find(filter).sort(sort).limit(limit).toArray();
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      lastCount = docs.length;
      if (i >= warmup) durations.push(ms);
    }

    const explain = await coll.find(filter).sort(sort).limit(limit).explain('executionStats');

    return {
      label,
      collection,
      filter: JSON.parse(JSON.stringify(filter, (k, v) => (v && v.toHexString ? v.toHexString() : v))),
      sort,
      limit,
      returned: lastCount,
      durationMs: summarise(durations, { warmupDiscarded: warmup, unit: 'ms' }),
      plan: planSummary(explain),
      indexes: (await coll.listIndexes().toArray()).map((i) => i.name),
    };
  } finally {
    if (!providedClient) await client.close();
  }
}

/**
 * Build the deliberately-unindexed twin of a collection.
 *
 * `$out` is used rather than a manual copy because it materialises the same
 * documents with the same `_id`s and NO secondary indexes -- exactly the
 * defect the control needs, with no chance of the copy differing in content
 * from the original. The collection is registered in the crash-safe ledger
 * BEFORE it is created, so a SIGKILL mid-run leaves a record that the next run
 * drops rather than a stray collection nobody remembers making.
 */
async function cloneWithoutIndexes(options) {
  const {
    uri = 'mongodb://localhost:27017/wardrobe_perf',
    source = 'clothingitems',
    target = 'clothingitems_noindex',
    client: providedClient = null,
  } = options;

  const client = providedClient || (await getMongoClient(uri));
  const dbName = client.db().databaseName;
  const ledgerId = safety.guardMongoCollection({ uri, dbName, collection: target });
  try {
    await client.db().collection(target).drop().catch(() => {});
    await client.db().collection(source).aggregate([{ $out: target }]).toArray();
    const count = await client.db().collection(target).countDocuments();
    const indexes = await client.db().collection(target).listIndexes().toArray();
    return {
      target,
      count,
      indexes: indexes.map((i) => i.name),
      ledgerId,
      async drop() {
        await safety.undo(ledgerId, { log: () => {} });
      },
    };
  } finally {
    if (!providedClient) await client.close();
  }
}

function describe(result) {
  return (
    `${result.label}\n` +
    `  duration ${formatSummary(result.durationMs, 3)}\n` +
    `  plan     ${result.plan.stages.join(' <- ')} index=${result.plan.indexName || 'none'}\n` +
    `  examined keys=${result.plan.totalKeysExamined} docs=${result.plan.totalDocsExamined} returned=${result.plan.nReturned}`
  );
}

module.exports = { measureQuery, cloneWithoutIndexes, describe, planSummary };
