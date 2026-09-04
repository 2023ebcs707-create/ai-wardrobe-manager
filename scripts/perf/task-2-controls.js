'use strict';

/**
 * TASK 2's OWN NEGATIVE CONTROLS -- run in this session, wired to the exact
 * instruments and the exact endpoints Task 2's numbers come from.
 *
 * WHY NOT JUST CITE TASK 1's TABLE. Task 1 proved that `measure-api.js`
 * responds to an injected delay ON `GET /items?limit=24`, that
 * `measure-cpu.js` responds to an injected CPU burn under a 40/s open loop of
 * that same endpoint, and that `measure-db.js` responds to an unindexed clone
 * of `clothingitems`. None of those is what Task 2 measures. Task 2's claims
 * are about the COMMUNITY FEED (`GET /community/posts`, a different handler
 * with a different query, a per-post fan-out and a signing round trip per
 * garment), about the CLOSED-LOOP LOAD GENERATOR (`lib/load.js`, an instrument
 * Task 1 never controlled at all -- its CPU control used the open-loop shape),
 * and about `communityposts` (a different collection with a different index).
 *
 * A control that responded yesterday against a different endpoint is not
 * evidence that today's harness is wired to the thing it names. So every class
 * below is re-run here, against Task 2's own targets:
 *
 *   api-latency (feed)     GET /community/posts, +250 ms injected
 *   transfer (feed)        GET /community/posts, +50000 bytes injected
 *   load-latency (50 VUs)  the CLOSED-LOOP generator at the Task 2 mix,
 *                          +100 ms injected -- the Claim 6 instrument
 *   server-cpu (mix)       open loop at the Task 2 mix, +15 ms CPU per request
 *   db-query (posts)       feed page query on `communityposts` vs a `$out`
 *                          clone with no index but `_id`
 *   db-plan (posts)        documents examined for the same pair
 *
 * EVERY CONTROL PROVES IT WAS INSTALLED before the metric is read -- API
 * controls against the server's own `/__perf/control` counters, the database
 * control against the winning query plan. "The control did not move the
 * number" and "the control was never active" are different findings and the
 * second masquerades as the first.
 *
 *   node scripts/perf/task-2-controls.js
 */

const fs = require('node:fs');
const path = require('node:path');

const safety = require('./lib/safety');
const { captureRig } = require('./lib/rig');
const { startApiUnderTest } = require('./lib/api-instance');
const { mintToken } = require('./lib/token');
const { measureEndpoint } = require('./measure-api');
const { measureQuery, cloneWithoutIndexes } = require('./measure-db');
const { sampleProcessCpu } = require('./measure-cpu');
const { runLoad } = require('./lib/load');
const { summarise, controlVerdict, round } = require('./lib/stats');
const { getMongoClient } = require('./lib/mongo');
const { PRIMARY_MIX, DEFINITION } = require('./task-2-mix');

const OUT_DIR = path.join(__dirname, '..', '..', 'docs', 'verification', 'stage-9', 'task-2');
const RAW_DIR = path.join(__dirname, '..', '..', 'docs', 'verification', 'stage-9', 'raw');
const MONGO_URI = 'mongodb://localhost:27017/wardrobe_perf';
const PORT = 3101; // NOT 3100: Task 1's scripts use that, and NOT 3000 (dev API).

const community = JSON.parse(fs.readFileSync(path.join(RAW_DIR, 'perf-community-manifest.json'), 'utf8'));
const TOKEN = mintToken(community.viewerUserId);
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const FEED_PATH = '/community/posts';

const log = (...a) => console.log(...a);

const DELAY_MS = 250;
const LOAD_DELAY_MS = 100;
const INFLATE_BYTES = 50000;
const CPU_BURN_MS = 15;
const CPU_RATE = 40;
const CPU_SECONDS = 12;
const CONTROL_VUS = 50;
const LOAD_SECONDS = 15;

// ---------------------------------------------------------------------------
// api-latency + transfer, ON THE FEED
// ---------------------------------------------------------------------------

async function feedApiControls() {
  const records = [];

  log('\n== api-latency + transfer (GET /community/posts): baseline ==');
  const baseline = await startApiUnderTest({ port: PORT, mongoUrl: MONGO_URI, label: 't2-feed-baseline' });
  let baseMeasure;
  try {
    baseMeasure = await measureEndpoint({
      url: `${baseline.baseUrl}${FEED_PATH}`,
      headers: AUTH,
      samples: 25,
      warmup: 3,
      label: `GET ${FEED_PATH} (baseline)`,
    });
  } finally {
    await baseline.stop();
  }
  if (!baseMeasure.ok) throw new Error(`baseline feed measurement failed: ${baseMeasure.error}`);

  log(`== api-latency (feed): control -- ${DELAY_MS} ms injected ==`);
  const slowed = await startApiUnderTest({
    port: PORT, mongoUrl: MONGO_URI, label: 't2-feed-delay', controls: { delayMs: DELAY_MS },
  });
  let slowMeasure;
  let slowState;
  try {
    const before = await slowed.controlState();
    if (before.controls.delayMs !== DELAY_MS) throw new Error('delay control not installed in the server');
    slowMeasure = await measureEndpoint({
      url: `${slowed.baseUrl}${FEED_PATH}`, headers: AUTH, samples: 25, warmup: 3,
      label: `GET ${FEED_PATH} (+${DELAY_MS}ms injected)`,
    });
    slowState = await slowed.controlState();
  } finally {
    await slowed.stop();
  }

  records.push({
    metricClass: 'api-latency (feed)',
    instrument: 'scripts/perf/measure-api.js -- hrtime around request-write -> last response byte',
    metric: 'GET /community/posts latency, ms (min/med/p95/max)',
    control: `PERF_CONTROL_DELAY_MS=${DELAY_MS} -- the server sleeps ${DELAY_MS} ms before the Express app sees the request`,
    controlInstalled: slowState.controls.delayMs === DELAY_MS,
    controlApplications: slowState.applied.delay,
    controlApplicationsExpected: 28,
    before: baseMeasure.latencyMs,
    after: slowMeasure.latencyMs,
    verdict: controlVerdict(baseMeasure.latencyMs, slowMeasure.latencyMs, { minRatio: 1.5, direction: 'up' }),
    detail: { baseline: baseMeasure, controlled: slowMeasure, slowState },
  });

  log(`== transfer (feed): control -- ${INFLATE_BYTES} bytes injected ==`);
  const inflated = await startApiUnderTest({
    port: PORT, mongoUrl: MONGO_URI, label: 't2-feed-inflate', controls: { inflateBytes: INFLATE_BYTES },
  });
  let inflateMeasure;
  let inflateState;
  try {
    const before = await inflated.controlState();
    if (before.controls.inflateBytes !== INFLATE_BYTES) throw new Error('inflate control not installed in the server');
    inflateMeasure = await measureEndpoint({
      url: `${inflated.baseUrl}${FEED_PATH}`, headers: AUTH, samples: 25, warmup: 3,
      label: `GET ${FEED_PATH} (+${INFLATE_BYTES} bytes injected)`,
    });
    inflateState = await inflated.controlState();
  } finally {
    await inflated.stop();
  }

  records.push({
    metricClass: 'transfer (feed)',
    instrument: 'scripts/perf/measure-api.js -- socket.bytesRead, headers included',
    metric: 'GET /community/posts response bytes on the wire (min/med/p95/max)',
    control: `PERF_CONTROL_INFLATE_BYTES=${INFLATE_BYTES} -- ${INFLATE_BYTES} bytes of padding added to the JSON body`,
    controlInstalled: inflateState.controls.inflateBytes === INFLATE_BYTES,
    controlApplications: inflateState.applied.inflate,
    controlApplicationsExpected: 28,
    before: baseMeasure.responseWireBytes,
    after: inflateMeasure.responseWireBytes,
    verdict: controlVerdict(baseMeasure.responseWireBytes, inflateMeasure.responseWireBytes, { minRatio: 1.5, direction: 'up' }),
    detail: { baseline: baseMeasure, controlled: inflateMeasure },
  });

  return records;
}

// ---------------------------------------------------------------------------
// load-latency: the CLAIM 6 INSTRUMENT
// ---------------------------------------------------------------------------

/**
 * Task 1 never controlled the closed-loop generator. Its CPU control used the
 * open-loop shape, deliberately, because a closed loop saturates one core
 * whatever the handler does -- but that leaves `lib/load.js`'s LATENCY output,
 * which is the entire evidence for Claim 6, with no control at all.
 *
 * THREE CONTROLS AGAINST ONE BASELINE, and the first one FAILS. That is not a
 * failure that has been tidied away; it is recorded because it says something
 * a reader needs in order to interpret Claim 6's numbers.
 *
 * A closed loop obeys Little's Law: with N users each holding one outstanding
 * request, N = throughput x latency, so latency is pinned to N / throughput.
 * A control therefore moves the latency of a closed loop EXACTLY as far as it
 * moves throughput, and no further.
 *
 * `PERF_CONTROL_DELAY_MS` is a `setTimeout` before the handler runs. It costs
 * the server no CPU: while one request sleeps the event loop serves others. At
 * 100 ms it removed only 26% of throughput (186/s -> 137/s), so latency could
 * only rise by 1/0.74 = 1.35x -- below the 1.5x bar, however real the defect
 * was. The instrument was not blind; the DOSE was arithmetically incapable of
 * clearing the threshold under this load shape.
 *
 * So two further controls are run against the same baseline:
 *   - the same defect at 500 ms, five times the dose;
 *   - a CPU burn, which is a defect a closed loop CANNOT absorb, because it
 *     consumes the single thread the server serves everybody with rather than
 *     yielding it.
 */
async function loadLatencyControl() {
  async function run(label, controls) {
    const api = await startApiUnderTest({ port: PORT, mongoUrl: MONGO_URI, label, controls });
    try {
      const state = await api.controlState();
      // Warm the server before the measured window: ts-node compiles each route
      // module on first reach and the MinIO client fetches the bucket region
      // once, and neither cost is what a stability claim is about.
      for (const entry of PRIMARY_MIX) {
        await measureEndpoint({ url: `${api.baseUrl}${entry.path}`, headers: AUTH, samples: 1, warmup: 2, label: `warm ${entry.name}` });
      }
      const result = await runLoad({
        baseUrl: api.baseUrl,
        headers: AUTH,
        mix: PRIMARY_MIX,
        concurrency: CONTROL_VUS,
        durationMs: LOAD_SECONDS * 1000,
        thinkTimeMs: 0,
        label: `${CONTROL_VUS} virtual users (${label})`,
      });
      const after = await api.controlState();
      return { result, state, after };
    } finally {
      await api.stop();
    }
  }

  log(`\n== load-latency (${CONTROL_VUS} virtual users, Task 2 mix): baseline ==`);
  const base = await run('t2-load-baseline', {});

  const variants = [
    {
      key: `delay ${LOAD_DELAY_MS}ms`,
      label: 't2-load-delay-100',
      controls: { delayMs: LOAD_DELAY_MS },
      control: `PERF_CONTROL_DELAY_MS=${LOAD_DELAY_MS} -- the server sleeps ${LOAD_DELAY_MS} ms before the app sees each request. Costs the server no CPU, so a closed loop can absorb most of it.`,
      installed: (s) => s.controls.delayMs === LOAD_DELAY_MS,
      applied: (s) => s.applied.delay,
    },
    {
      key: 'delay 500ms',
      label: 't2-load-delay-500',
      controls: { delayMs: 500 },
      control: 'PERF_CONTROL_DELAY_MS=500 -- the same defect at five times the dose',
      installed: (s) => s.controls.delayMs === 500,
      applied: (s) => s.applied.delay,
    },
    {
      key: 'cpu burn 5ms',
      label: 't2-load-cpuburn-5',
      controls: { cpuBurnMs: 5 },
      control: 'PERF_CONTROL_CPU_BURN_MS=5 -- the server spins for 5 ms of CPU per request. A closed loop cannot absorb this: it consumes the single thread the server serves everybody with rather than yielding it.',
      installed: (s) => s.controls.cpuBurnMs === 5,
      applied: (s) => s.applied.cpuBurn,
    },
  ];

  const records = [];
  for (const v of variants) {
    log(`== load-latency: control -- ${v.key} ==`);
    const slow = await run(v.label, v.controls);
    records.push({
      metricClass: `load-latency (${CONTROL_VUS} VUs, ${v.key})`,
      instrument: 'scripts/perf/lib/load.js -- closed-loop generator, the Claim 6 instrument',
      metric: `mix latency under ${CONTROL_VUS} closed-loop virtual users, ms (min/med/p95/max)`,
      control: v.control,
      controlInstalled: v.installed(slow.after),
      controlApplications: v.applied(slow.after),
      controlApplicationsExpected: slow.result.totalRequests,
      before: base.result.latencyMs,
      after: slow.result.latencyMs,
      verdict: controlVerdict(base.result.latencyMs, slow.result.latencyMs, { minRatio: 1.5, direction: 'up' }),
      detail: {
        virtualUserDefinition: DEFINITION,
        baselineThroughput: base.result.requestsPerSecond,
        controlledThroughput: slow.result.requestsPerSecond,
        throughputRatio: slow.result.requestsPerSecond / base.result.requestsPerSecond,
        // Little's Law bound: in a closed loop, latency can only rise by the
        // reciprocal of the throughput drop. Printed beside every row so a
        // reader can see whether a VOID verdict is a blind instrument or a
        // dose that could never have cleared the bar.
        littlesLawPredictedLatencyRatio: base.result.requestsPerSecond / slow.result.requestsPerSecond,
        baselineFailures: base.result.failures,
        controlledFailures: slow.result.failures,
        baseline: base.result,
        controlled: slow.result,
      },
    });
  }
  return records;
}

// ---------------------------------------------------------------------------
// server-cpu, under the TASK 2 MIX
// ---------------------------------------------------------------------------

async function cpuRun(label, controls) {
  const api = await startApiUnderTest({ port: PORT, mongoUrl: MONGO_URI, label, controls });
  try {
    const state = await api.controlState();
    for (const entry of PRIMARY_MIX) {
      await measureEndpoint({ url: `${api.baseUrl}${entry.path}`, headers: AUTH, samples: 1, warmup: 2, label: `warm ${entry.name}` });
    }
    let cpu;
    const load = runLoad({
      baseUrl: api.baseUrl,
      headers: AUTH,
      ratePerSecond: CPU_RATE,
      durationMs: CPU_SECONDS * 1000,
      mix: PRIMARY_MIX,
      label: `${CPU_RATE}/s open loop (${label})`,
      onStart: async () => {
        cpu = sampleProcessCpu({ pid: api.pid, samples: CPU_SECONDS - 3, intervalSeconds: 1, label: `api pid ${api.pid} (${label})` });
      },
    });
    const [loadResult, cpuResult] = await Promise.all([load, cpu]);
    const after = await api.controlState();
    return { loadResult, cpuResult, state, after };
  } finally {
    await api.stop();
  }
}

async function cpuControl() {
  log('\n== server-cpu (Task 2 mix, open loop): baseline ==');
  const base = await cpuRun('t2-cpu-baseline', {});
  log(`== server-cpu: control -- ${CPU_BURN_MS} ms of CPU burned per request ==`);
  const burn = await cpuRun('t2-cpu-burn', { cpuBurnMs: CPU_BURN_MS });

  return [{
    metricClass: 'server-cpu (mix)',
    instrument: "scripts/perf/measure-cpu.js -- macOS `top -l N -s 1 -pid`, first sample discarded",
    metric: `API process CPU, % of ONE CORE, under a ${CPU_RATE}/s open loop of the Task 2 mix (min/med/p95/max)`,
    control: `PERF_CONTROL_CPU_BURN_MS=${CPU_BURN_MS} -- the server spins for ${CPU_BURN_MS} ms of CPU per request`,
    controlInstalled: burn.after.controls.cpuBurnMs === CPU_BURN_MS,
    controlApplications: burn.after.applied.cpuBurn,
    controlApplicationsExpected: base.loadResult.totalRequests,
    before: base.cpuResult.percentOfOneCore,
    after: burn.cpuResult.percentOfOneCore,
    verdict: controlVerdict(base.cpuResult.percentOfOneCore, burn.cpuResult.percentOfOneCore, { minRatio: 1.5, direction: 'up' }),
    detail: {
      cores: base.cpuResult.cores,
      baselinePercentOfMachine: base.cpuResult.percentOfMachine,
      controlledPercentOfMachine: burn.cpuResult.percentOfMachine,
      baselineRequests: base.loadResult.totalRequests,
      controlledRequests: burn.loadResult.totalRequests,
      baselineFailures: base.loadResult.failures,
      controlledFailures: burn.loadResult.failures,
      baseline: base.cpuResult,
      controlled: burn.cpuResult,
    },
  }];
}

// ---------------------------------------------------------------------------
// db-query + db-plan, on `communityposts`
// ---------------------------------------------------------------------------

async function dbControls() {
  log('\n== db-query / db-plan (communityposts): indexed vs deliberately unindexed ==');
  const client = await getMongoClient(MONGO_URI);
  try {
    // The feed's page-1 query, exactly: no filter, keyset sort, limit+1.
    const filter = {};
    const sort = { createdAt: -1, _id: -1 };

    const indexed = await measureQuery({
      client, collection: 'communityposts', filter, sort, limit: 25,
      samples: 25, warmup: 3, label: 'feed page 1, indexed collection',
    });

    const clone = await cloneWithoutIndexes({ client, source: 'communityposts', target: 'communityposts_noindex' });
    let unindexed;
    try {
      unindexed = await measureQuery({
        client, collection: clone.target, filter, sort, limit: 25,
        samples: 25, warmup: 3, label: 'feed page 1, NO index (control)',
      });
    } finally {
      await clone.drop();
    }

    /**
     * A SECOND CORPUS SIZE, because one is not enough to tell two very
     * different findings apart.
     *
     * At 2,000 documents an index seek and a collection scan are close enough
     * that the timing metric may not clear the 1.5x bar -- which is either
     * "the instrument is blind" or "the effect really is that small at this
     * size", and those have opposite consequences. Task 1 recorded the same
     * effect from the other end: on a 128-document collection an index seek
     * and a collection scan are the same speed, which is why its fixture has
     * 46,128 filler items.
     *
     * So the identical instrument is run against the 46,128-document
     * `clothingitems` collection as well. If it responds there and not at
     * 2,000, the instrument works and the 2,000-document result is a fact
     * about corpus size -- which is directly relevant to Claim 13.
     */
    const bigFilter = { userId: (await client.db().collection('clothingitems').findOne({}, { sort: { _id: 1 } })).userId };
    const bigIndexed = await measureQuery({
      client, collection: 'clothingitems', filter: bigFilter, sort: { createdAt: -1, _id: -1 }, limit: 25,
      samples: 25, warmup: 3, label: 'wardrobe page, indexed 46,128-doc collection',
    });
    const bigClone = await cloneWithoutIndexes({ client, source: 'clothingitems', target: 'clothingitems_noindex_t2' });
    let bigUnindexed;
    try {
      bigUnindexed = await measureQuery({
        client, collection: bigClone.target, filter: bigFilter, sort: { createdAt: -1, _id: -1 }, limit: 25,
        samples: 25, warmup: 3, label: 'wardrobe page, NO index, 46,128 docs (control)',
      });
    } finally {
      await bigClone.drop();
    }

    return [
      {
        metricClass: 'db-query (communityposts)',
        instrument: 'scripts/perf/measure-db.js -- driver-side hrtime around find().sort().limit().toArray()',
        metric: 'feed page-1 query duration, ms (min/med/p95/max)',
        control: `the same ${clone.count} documents copied with \`$out\` into a collection with no index but \`_id\`, so the identical query must collection-scan and sort in memory`,
        controlInstalled: unindexed.plan.collectionScan && !unindexed.plan.usedIndex,
        controlApplications: unindexed.plan.totalDocsExamined,
        controlApplicationsExpected: clone.count,
        before: indexed.durationMs,
        after: unindexed.durationMs,
        verdict: controlVerdict(indexed.durationMs, unindexed.durationMs, { minRatio: 1.5, direction: 'up' }),
        detail: { indexed, unindexed, cloneCount: clone.count, cloneIndexes: clone.indexes },
      },
      {
        metricClass: 'db-plan (communityposts)',
        instrument: 'scripts/perf/measure-db.js -- explain("executionStats").totalDocsExamined',
        metric: 'documents examined to return one feed page',
        control: 'same unindexed clone as above',
        controlInstalled: unindexed.plan.collectionScan && !unindexed.plan.usedIndex,
        controlApplications: unindexed.plan.totalDocsExamined,
        controlApplicationsExpected: clone.count,
        before: summarise([indexed.plan.totalDocsExamined], { unit: 'docs' }),
        after: summarise([unindexed.plan.totalDocsExamined], { unit: 'docs' }),
        verdict: controlVerdict(
          summarise([indexed.plan.totalDocsExamined], { unit: 'docs' }),
          summarise([unindexed.plan.totalDocsExamined], { unit: 'docs' }),
          { minRatio: 1.5, direction: 'up' },
        ),
        detail: { indexedPlan: indexed.plan, unindexedPlan: unindexed.plan },
      },
      {
        metricClass: 'db-query (clothingitems, 46,128 docs)',
        instrument: 'scripts/perf/measure-db.js -- the SAME instrument, against a corpus 23x larger',
        metric: 'wardrobe page query duration, ms (min/med/p95/max)',
        control: `the same ${bigClone.count} documents copied with \`$out\` into a collection with no index but \`_id\``,
        controlInstalled: bigUnindexed.plan.collectionScan && !bigUnindexed.plan.usedIndex,
        controlApplications: bigUnindexed.plan.totalDocsExamined,
        controlApplicationsExpected: bigClone.count,
        before: bigIndexed.durationMs,
        after: bigUnindexed.durationMs,
        verdict: controlVerdict(bigIndexed.durationMs, bigUnindexed.durationMs, { minRatio: 1.5, direction: 'up' }),
        detail: { indexed: bigIndexed, unindexed: bigUnindexed, cloneCount: bigClone.count },
      },
    ];
  } finally {
    await client.close();
  }
}

// ---------------------------------------------------------------------------

function verdictWord(r) {
  if (!r.controlInstalled) return 'INVALID (control was not installed)';
  return r.verdict.moved ? '**RESPONDS**' : '**VOID (did not move)**';
}

function cell(s, dp = 2) {
  return `${round(s.min, dp)} / ${round(s.median, dp)} / ${round(s.p95, dp)} / ${round(s.max, dp)}`;
}

function toMarkdown(rig, records, meta) {
  return `# Stage 9 · Task 2 — negative-control matrix

Generated by \`scripts/perf/task-2-controls.js\` at ${meta.at}. **Every row below was run in
Task 2's own session**, against Task 2's own endpoints, collections and instruments — not
carried over from Task 1. Numbers are min / median / p95 / max over the stated sample.

Threshold: a control counts only if it moves the **median by ≥1.5× in the stated direction**
AND the harness could first confirm the defect was actually installed.

## The table

| metric class | instrument | before (stock) | after (defect injected) | median ratio | verdict |
|---|---|---|---|---|---|
${records
  .map((r) => `| \`${r.metricClass}\` | ${r.instrument} | ${cell(r.before)} | ${cell(r.after)} | ${round(r.verdict.ratio, 2)}x | ${verdictWord(r)} |`)
  .join('\n')}

## Each control in full

${records
  .map(
    (r) =>
      `### \`${r.metricClass}\`\n\n` +
      `- **Metric:** ${r.metric}\n` +
      `- **Instrument:** ${r.instrument}\n` +
      `- **Control:** ${r.control}\n` +
      `- **Control confirmed active:** ${r.controlInstalled ? 'yes' : 'NO'} (applied ${r.controlApplications}, expected at least ${r.controlApplicationsExpected})\n` +
      `- **Before:** ${JSON.stringify({ n: r.before.n, min: round(r.before.min, 3), median: round(r.before.median, 3), p95: round(r.before.p95, 3), max: round(r.before.max, 3), unit: r.before.unit })}\n` +
      `- **After:** ${JSON.stringify({ n: r.after.n, min: round(r.after.min, 3), median: round(r.after.median, 3), p95: round(r.after.p95, 3), max: round(r.after.max, 3), unit: r.after.unit })}\n` +
      `- **Verdict:** ${verdictWord(r)}`,
  )
  .join('\n\n')}

## The simulated-concurrent-user definition these controls used

${DEFINITION}

## The rig

\`\`\`json
${JSON.stringify(rig, null, 2)}
\`\`\`
`;
}

async function main() {
  await safety.recoverLeftovers();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const rig = await captureRig({ mongoUri: MONGO_URI, apiHost: `http://localhost:${PORT}` });
  const records = [];
  const failures = [];

  async function attempt(name, fn) {
    try {
      const r = await fn();
      if (Array.isArray(r)) records.push(...r);
      else records.push(r);
    } catch (err) {
      log(`\n!! control '${name}' FAILED: ${err.message}`);
      failures.push({ control: name, error: String(err.stack || err.message) });
    }
  }

  await attempt('feed-api', feedApiControls);
  await attempt('load-latency', loadLatencyControl);
  await attempt('cpu', cpuControl);
  await attempt('db', dbControls);

  const at = new Date().toISOString();
  for (const r of records) r.runAt = at;
  const meta = { at, harness: 'scripts/perf/task-2-controls.js', task: 'Stage 9 Task 2' };

  const rigAfter = await captureRig({ mongoUri: MONGO_URI, apiHost: `http://localhost:${PORT}` });
  fs.writeFileSync(
    path.join(OUT_DIR, 'negative-controls.json'),
    JSON.stringify({ meta, rig, rigAfter, virtualUserDefinition: DEFINITION, records, failures }, null, 2),
  );
  fs.writeFileSync(path.join(OUT_DIR, 'negative-controls.md'), toMarkdown(rig, records, meta));

  if (failures.length) {
    log('\n=== CONTROLS THAT COULD NOT BE RUN ===');
    for (const f of failures) log(`  ${f.control}: ${f.error.split('\n')[0]}`);
  }
  log('\n=== VERDICTS ===');
  for (const r of records) log(`  ${verdictWord(r).replace(/\*/g, '').padEnd(30)} ${r.metricClass}   ${cell(r.before)}  ->  ${cell(r.after)}  (${round(r.verdict.ratio, 2)}x)`);
  log(`\nledger after run: ${safety.listLeftovers().length} leftover(s)`);
  log('written: docs/verification/stage-9/task-2/negative-controls.{json,md}');
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
