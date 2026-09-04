'use strict';

/**
 * THE NEGATIVE-CONTROL MATRIX -- run, not described.
 *
 *   node scripts/perf/negative-controls.js [--skip-device] [--only <class>]
 *
 * For every metric class this harness can produce a number in, it measures the
 * number twice: once against the stock system, and once against a system with a
 * DELIBERATE DEFECT injected into exactly the thing the number is supposed to
 * be sensitive to. If the number does not move, the metric is void -- not
 * "probably fine", not "close enough": void, and this file says so in its
 * output rather than leaving a reader to notice.
 *
 * The rule was adopted in Stage 7 after a review proved a 100% mutation score
 * stayed 100% with the entire mechanism under test deleted, and it has caught
 * three fabricated results since. It caught one in this task too: the first
 * settle-time definition reported 107 ms for a workload that moved the screen
 * for 1.4 seconds, and only the control revealed it.
 *
 * EVERY CONTROL VERIFIES THAT IT WAS INSTALLED before it reads the metric.
 * "The control did not move the number" and "the control was never active" look
 * identical in a results table, and the second one is how a negative control
 * gets faked. The API controls are confirmed against the server's own
 * `/__perf/control` counters; the database control is confirmed by reading the
 * query plan; the device controls are confirmed by reading back the device's
 * own state.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const safety = require('./lib/safety');
const { captureRig } = require('./lib/rig');
const { startApiUnderTest } = require('./lib/api-instance');
const { mintToken } = require('./lib/token');
const { measureEndpoint } = require('./measure-api');
const { measureQuery, cloneWithoutIndexes } = require('./measure-db');
const { sampleProcessCpu } = require('./measure-cpu');
const { runLoad } = require('./lib/load');
const { summarise, controlVerdict, round, formatCell } = require('./lib/stats');
const device = require('./measure-device');
const adb = require('./lib/adb');
const { getMongoClient } = require('./lib/mongo');

const OUT_DIR = path.join(__dirname, '..', '..', 'docs', 'verification', 'stage-9');
const RAW_DIR = path.join(OUT_DIR, 'raw');
const MONGO_URI = 'mongodb://localhost:27017/wardrobe_perf';
const PORT = 3100;

const manifest = JSON.parse(fs.readFileSync(path.join(RAW_DIR, 'perf-db-manifest.json'), 'utf8'));
const TOKEN = mintToken(manifest.largeWardrobeUserId);
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const ITEMS_PATH = '/items?limit=24';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// ---------------------------------------------------------------------------
// api-latency and transfer
// ---------------------------------------------------------------------------

const DELAY_MS = 250;
const INFLATE_BYTES = 50000;

async function apiControls() {
  const records = [];

  log('\n== api-latency + transfer: baseline ==');
  const baseline = await startApiUnderTest({ port: PORT, mongoUrl: MONGO_URI, label: 'baseline' });
  let baseMeasure;
  let baseState;
  try {
    baseState = await baseline.controlState();
    baseMeasure = await measureEndpoint({
      url: `${baseline.baseUrl}${ITEMS_PATH}`,
      headers: AUTH,
      samples: 25,
      warmup: 3,
      label: `GET ${ITEMS_PATH} (baseline)`,
    });
  } finally {
    await baseline.stop();
  }
  if (!baseMeasure.ok) throw new Error(`baseline endpoint measurement failed: ${baseMeasure.error}`);

  log('== api-latency: control (artificially slowed endpoint) ==');
  const slowed = await startApiUnderTest({
    port: PORT,
    mongoUrl: MONGO_URI,
    label: 'delay',
    controls: { delayMs: DELAY_MS },
  });
  let slowMeasure;
  let slowState;
  try {
    const before = await slowed.controlState();
    if (before.controls.delayMs !== DELAY_MS) throw new Error('delay control not installed in the server');
    slowMeasure = await measureEndpoint({
      url: `${slowed.baseUrl}${ITEMS_PATH}`,
      headers: AUTH,
      samples: 25,
      warmup: 3,
      label: `GET ${ITEMS_PATH} (+${DELAY_MS}ms injected)`,
    });
    slowState = await slowed.controlState();
  } finally {
    await slowed.stop();
  }

  records.push({
    metricClass: 'api-latency',
    metric: 'GET /items?limit=24 latency, ms (min/med/p95/max)',
    control: `PERF_CONTROL_DELAY_MS=${DELAY_MS} -- the server sleeps ${DELAY_MS} ms before the app sees the request`,
    controlInstalled: slowState.controls.delayMs === DELAY_MS,
    controlApplications: slowState.applied.delay,
    controlApplicationsExpected: 28,
    before: baseMeasure.latencyMs,
    after: slowMeasure.latencyMs,
    verdict: controlVerdict(baseMeasure.latencyMs, slowMeasure.latencyMs, { minRatio: 1.5, direction: 'up' }),
    detail: { baseState, slowState, baseline: baseMeasure, controlled: slowMeasure },
  });

  log('== transfer: control (artificially inflated payload) ==');
  const inflated = await startApiUnderTest({
    port: PORT,
    mongoUrl: MONGO_URI,
    label: 'inflate',
    controls: { inflateBytes: INFLATE_BYTES },
  });
  let inflateMeasure;
  let inflateState;
  try {
    const before = await inflated.controlState();
    if (before.controls.inflateBytes !== INFLATE_BYTES) throw new Error('inflate control not installed in the server');
    inflateMeasure = await measureEndpoint({
      url: `${inflated.baseUrl}${ITEMS_PATH}`,
      headers: AUTH,
      samples: 25,
      warmup: 3,
      label: `GET ${ITEMS_PATH} (+${INFLATE_BYTES} bytes injected)`,
    });
    inflateState = await inflated.controlState();
  } finally {
    await inflated.stop();
  }

  records.push({
    metricClass: 'transfer',
    metric: 'GET /items?limit=24 response bytes on the wire (min/med/p95/max)',
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
// server-cpu
// ---------------------------------------------------------------------------

const CPU_BURN_MS = 15;
const CPU_RATE = 40;
const CPU_SECONDS = 12;

async function cpuRun(label, controls) {
  const api = await startApiUnderTest({ port: PORT, mongoUrl: MONGO_URI, label, controls });
  try {
    const state = await api.controlState();
    // Warm the server before the sampled window: ts-node compilation and the
    // MinIO region lookup are one-off costs and would otherwise land inside the
    // CPU sample and inflate the baseline, which would flatter the control.
    await measureEndpoint({ url: `${api.baseUrl}${ITEMS_PATH}`, headers: AUTH, samples: 3, warmup: 3, label: 'warm-up' });

    let cpu;
    const load = runLoad({
      baseUrl: api.baseUrl,
      headers: AUTH,
      ratePerSecond: CPU_RATE,
      durationMs: CPU_SECONDS * 1000,
      mix: [{ name: 'GET /items', path: ITEMS_PATH, weight: 1 }],
      label: `${CPU_RATE}/s open loop`,
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

async function cpuControls() {
  log('\n== server-cpu: baseline ==');
  const base = await cpuRun('cpu-baseline', {});
  log('== server-cpu: control (CPU burned per request) ==');
  const burn = await cpuRun('cpu-burn', { cpuBurnMs: CPU_BURN_MS });

  return [
    {
      metricClass: 'server-cpu',
      metric: `API process CPU, % of one core, under a ${CPU_RATE}/s open-loop GET /items (min/med/p95/max)`,
      control: `PERF_CONTROL_CPU_BURN_MS=${CPU_BURN_MS} -- the server spins for ${CPU_BURN_MS} ms of CPU per request`,
      controlInstalled: burn.after.controls.cpuBurnMs === CPU_BURN_MS,
      controlApplications: burn.after.applied.cpuBurn,
      controlApplicationsExpected: base.loadResult.totalRequests,
      before: base.cpuResult.percentOfOneCore,
      after: burn.cpuResult.percentOfOneCore,
      verdict: controlVerdict(base.cpuResult.percentOfOneCore, burn.cpuResult.percentOfOneCore, { minRatio: 1.5, direction: 'up' }),
      detail: { baseline: base, controlled: burn },
    },
  ];
}

// ---------------------------------------------------------------------------
// db-query
// ---------------------------------------------------------------------------

async function dbControls() {
  log('\n== db-query: indexed vs deliberately unindexed ==');
  const client = await getMongoClient(MONGO_URI);
  try {
    const { ObjectId } = require(require.resolve('mongodb', {
      paths: [path.dirname(require.resolve('mongoose/package.json', { paths: [path.join(__dirname, '..', '..', 'apps', 'api')] }))],
    }));
    const filter = { userId: new ObjectId(manifest.largeWardrobeUserId) };

    const indexed = await measureQuery({
      client,
      collection: 'clothingitems',
      filter,
      samples: 25,
      warmup: 3,
      label: 'wardrobe page, indexed collection',
    });

    const clone = await cloneWithoutIndexes({ client, source: 'clothingitems', target: 'clothingitems_noindex' });
    let unindexed;
    try {
      unindexed = await measureQuery({
        client,
        collection: clone.target,
        filter,
        samples: 25,
        warmup: 3,
        label: 'wardrobe page, NO index (control)',
      });
    } finally {
      await clone.drop();
    }

    return [
      {
        metricClass: 'db-query',
        metric: 'wardrobe page query duration, ms (min/med/p95/max)',
        control:
          'the same 46,128 documents copied with `$out` into a collection with no index but `_id`, so the identical query must fall back to a collection scan',
        controlInstalled: unindexed.plan.collectionScan && !unindexed.plan.usedIndex,
        controlApplications: unindexed.plan.totalDocsExamined,
        controlApplicationsExpected: manifest.items,
        before: indexed.durationMs,
        after: unindexed.durationMs,
        verdict: controlVerdict(indexed.durationMs, unindexed.durationMs, { minRatio: 1.5, direction: 'up' }),
        detail: { indexed, unindexed, cloneCount: clone.count, cloneIndexes: clone.indexes },
      },
      {
        metricClass: 'db-plan',
        metric: 'documents examined to return one wardrobe page',
        control: 'same unindexed clone as above',
        controlInstalled: true,
        controlApplications: unindexed.plan.totalDocsExamined,
        controlApplicationsExpected: manifest.items,
        before: summarise([indexed.plan.totalDocsExamined], { unit: 'docs' }),
        after: summarise([unindexed.plan.totalDocsExamined], { unit: 'docs' }),
        verdict: controlVerdict(
          summarise([indexed.plan.totalDocsExamined], { unit: 'docs' }),
          summarise([unindexed.plan.totalDocsExamined], { unit: 'docs' }),
          { minRatio: 1.5, direction: 'up' },
        ),
        detail: { indexedPlan: indexed.plan, unindexedPlan: unindexed.plan },
      },
    ];
  } finally {
    await client.close();
  }
}

// ---------------------------------------------------------------------------
// device-memory
// ---------------------------------------------------------------------------

const ALLOC_BYTES = 40_000_000;

async function deviceMemoryControl(target) {
  log('\n== device-memory: known allocation on the handset ==');
  // The allocator announces its OWN pid, and the previous one is killed first.
  //
  // Both details were bought with a wrong result. The first version found the
  // pid with `pgrep -f perf-alloc.sh` and took the first match -- and when this
  // control was re-run about a minute after the last one, that match was the
  // PREVIOUS run's allocator, still sleeping off its thirty-second tail with
  // its 40 MB already resident. The "before" sample therefore read 40,078 KB,
  // the "after" sample read 40,078 KB, and the harness reported the memory
  // metric VOID. The verdict was right about the evidence in front of it and
  // wrong about the instrument, which is the failure mode a control matrix has
  // to be able to survive: it is why the "before" reading is now sanity-checked
  // rather than trusted.
  const script = [
    '#!/system/bin/sh',
    'echo $$ > /data/local/tmp/perf-alloc-pid.txt',
    'sleep 6',
    'V=$(cat /data/local/tmp/perf-alloc.bin)',
    'echo ${#V} > /data/local/tmp/perf-alloc-len.txt',
    'sleep 30',
    '',
  ].join('\n');
  const local = path.join(os.tmpdir(), 'perf-alloc.sh');
  fs.writeFileSync(local, script);

  adb.shellSafe(target, 'pkill -f "perf-allo[c].sh"');
  adb.shellSafe(target, 'rm -f /data/local/tmp/perf-alloc-pid.txt /data/local/tmp/perf-alloc-len.txt');
  await sleep(1000);
  adb.shell(target, `head -c ${ALLOC_BYTES} /dev/zero | tr "\\0" "x" > /data/local/tmp/perf-alloc.bin`);
  adb.raw(['-s', target.id, 'push', local, '/data/local/tmp/perf-alloc.sh'], { stdio: 'pipe' });
  adb.shell(target, 'nohup sh /data/local/tmp/perf-alloc.sh >/dev/null 2>&1 </dev/null & echo started');
  await sleep(1500);
  const pidRead = adb.shellSafe(target, 'cat /data/local/tmp/perf-alloc-pid.txt');
  const pid = pidRead.ok ? String(pidRead.output).trim() : '';
  if (!pid) throw new Error('device allocation process did not announce a pid');

  const before = device.meminfo(target, pid);
  await sleep(9000);
  const after = device.meminfo(target, pid);
  // The "before" sample must be a PRE-allocation sample. 10 MB is four times
  // the largest pre-allocation reading observed (1.1 MB) and a quarter of the
  // allocation itself, so it cannot be tripped by noise and cannot be passed by
  // a process that has already allocated.
  const beforeIsPreAllocation = before.totalPssKb !== null && before.totalPssKb < 10000;
  // shellSafe, not shell: the allocation script writes this file only once the
  // 40 MB string is built, so a `cat` that arrives a moment early exits 1 and
  // -- through execFileSync -- threw away an otherwise complete measurement on
  // one run of this matrix. A missing confirmation file makes the control
  // UNCONFIRMED, which is a result; it must not make it an exception.
  const lenRead = adb.shellSafe(target, 'cat /data/local/tmp/perf-alloc-len.txt');
  const lenHeld = lenRead.ok ? String(lenRead.output).trim() : '';

  // Kill by pid, not by pattern: `pkill -f perf-alloc.sh` also matches the
  // shell adb spawned to run it, so it kills itself and reports failure to the
  // host with the measurement already taken. Cleanup must not lose a result.
  adb.shellSafe(target, `kill ${pid}`);
  adb.shellSafe(target, 'rm -f /data/local/tmp/perf-alloc.bin /data/local/tmp/perf-alloc.sh /data/local/tmp/perf-alloc-len.txt /data/local/tmp/perf-alloc-pid.txt');
  fs.rmSync(local, { force: true });

  return {
    metricClass: 'device-memory',
    metric: `dumpsys meminfo TOTAL PSS of one process, KB (pid ${pid})`,
    control: `the same process allocates ${ALLOC_BYTES.toLocaleString('en-GB')} bytes (a ${(ALLOC_BYTES / 1024 / 1024).toFixed(1)} MiB string) and holds it`,
    controlInstalled: lenHeld === String(ALLOC_BYTES) && beforeIsPreAllocation,
    inconclusiveReason: beforeIsPreAllocation
      ? null
      : `the "before" sample already read ${before.totalPssKb} KB, so it was not taken before the allocation`,
    controlApplications: Number(lenHeld || 0),
    controlApplicationsExpected: ALLOC_BYTES,
    before: summarise([before.totalPssKb], { unit: 'KB' }),
    after: summarise([after.totalPssKb], { unit: 'KB' }),
    verdict: controlVerdict(summarise([before.totalPssKb], { unit: 'KB' }), summarise([after.totalPssKb], { unit: 'KB' }), {
      minRatio: 1.5,
      direction: 'up',
    }),
    detail: {
      pid,
      beforeKb: { pss: before.totalPssKb, rss: before.totalRssKb, swap: before.totalSwapKb },
      afterKb: { pss: after.totalPssKb, rss: after.totalRssKb, swap: after.totalSwapKb },
      allocatedBytesHeld: lenHeld,
      pssPlusSwapDeltaKb:
        after.totalPssKb + after.totalSwapKb - (before.totalPssKb + before.totalSwapKb),
      note:
        'Run against a shell process rather than Expo Go because the handset is locked with a secure keyguard, so the app under test cannot be foregrounded and cannot be made to allocate on demand without instrumenting product code (Ruling 1 forbids that). The parser path exercised is the same one used for a package. NOTE FOR CLAIM 8: PSS counts RESIDENT pages only, and this control is NOT stable across runs. The identical 40,000,000-byte allocation, with the length file confirming all 40,000,000 bytes were held, read as +39.1 MB of PSS on two runs and as +8.9 MB on a third. The cause was not established: that run predates this record capturing TOTAL SWAP, so whether the remainder was compressed into zram or whether the sample simply landed before the string finished materialising is unknown. Both readings moved the metric decisively, so the control passes either way -- but a Claim 8 figure taken from TOTAL PSS alone can evidently vary by a factor of four for the same allocation, and Task 3 must report PSS, RSS and SWAP together and say which it is claiming.',
    },
  };
}

// ---------------------------------------------------------------------------
// device-frames
// ---------------------------------------------------------------------------

/**
 * THE PACKAGE THE JANK METRIC IS READ FROM — and the defect it used to carry.
 *
 * This was `com.android.systemui` from Task 1 until Task 5. Task 1 chose it
 * because the handset was locked behind a secure keyguard and Expo Go could not
 * be foregrounded to render anything, and the choice was recorded in the note
 * below. What was NOT recorded is that the constant then governed every later
 * run: the control kept measuring the system UI package by construction long
 * after the handset was unlocked, and Task 1's ledger attributed the resulting
 * VOID to the lock screen rather than to this line. Task 3 found the real cause
 * by reading the code and deliberately did not change it, because Task 2 was
 * running against this harness at the time and, later, because re-pointing it
 * silently would have left the committed `negative-controls.{json,md}` meaning
 * two different things behind one filename.
 *
 * It now names the app under test, and the run asserts that package is actually
 * the focused window before it reads a single frame (`assertForegrounded`), so
 * the "measuring the wrong surface by construction" failure cannot recur
 * silently — it becomes a refused control with a stated reason.
 */
const FRAME_PKG = 'host.exp.exponent';
const FRAME_PKG_BEFORE_TASK5 = 'com.android.systemui';

const MIN_VALID_FRAMES = 100;

/**
 * Confirm the package whose frames are about to be counted is the one on
 * screen. `dumpsys gfxinfo <pkg>` answers for a backgrounded or even a
 * non-rendering process without complaint, and it answers with a small number
 * — which is indistinguishable in a results table from "the control worked".
 */
function foregroundPackage(target) {
  // `grep` without `-m1`: an early-closing pipe makes dumpsys abort with
  // "Failed to write while dumping service window: Broken pipe", which loses
  // the very line being looked for on some runs.
  const focus = adb.shellSafe(target, 'dumpsys window | grep mCurrentFocus');
  const text = focus.ok ? String(focus.output) : '';
  const m = text.match(/mCurrentFocus=Window\{\S+\s+\S+\s+([A-Za-z0-9_.]+)\//);
  return m ? m[1] : null;
}

/**
 * Wake the screen and CONFIRM it woke, rather than assuming.
 *
 * Measured: under the twelve-process CPU load this control applies, a single
 * `input keyevent KEYCODE_WAKEUP` followed by a 1.5 s wait left the handset
 * still `Dozing` -- every `input` invocation starts a JVM, and a starved one
 * takes longer than the wait. The run then recorded ZERO frames with the
 * screen off and would have been compared against 571 frames with it on. That
 * is not a control, it is two different experiments, so the wake is now
 * verified and re-attempted.
 */
async function wakeAndConfirm(target, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let state = '';
  while (Date.now() < deadline) {
    adb.shellSafe(target, 'input keyevent KEYCODE_WAKEUP');
    await sleep(1500);
    state = (adb.shell(target, 'dumpsys power').match(/mWakefulness=\w+/) || [''])[0];
    if (state === 'mWakefulness=Awake') return state;
  }
  return state;
}

async function frameRun(target, label, attempts = 3) {
  let frames = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const wake = await wakeAndConfirm(target);
    const foreground = foregroundPackage(target);
    device.resetFrames(target, FRAME_PKG);
    device.scriptedSwipes(target, { repeats: 3, pauseMs: 1000 });
    frames = device.readFrames(target, FRAME_PKG);
    // A jank percentage over nine frames is not a measurement. If the workload
    // did not actually render, the sample is refused rather than reported --
    // 22% of nine frames and 1.7% of five hundred are not comparable numbers,
    // and quoting them side by side would manufacture a control that "worked".
    frames.valid = frames.totalFrames >= MIN_VALID_FRAMES;
    frames.wakefulness = wake;
    frames.attempt = attempt;
    // Recorded per sample, not once per run: the surface the swipes land on can
    // change under the harness (a lock, a dialog, a backgrounded app), and a
    // frame count is only interpretable next to the package that was on screen.
    frames.foregroundPackage = foreground;
    frames.foregroundIsTarget = foreground === FRAME_PKG;
    log(
      `   ${label}${attempt > 1 ? ` (attempt ${attempt})` : ''}: ${frames.totalFrames} frames, ` +
        `${frames.jankyPercent}% janky, p95 ${frames.p95Ms}ms, ${wake}, ` +
        `gfxinfo for ${frames.graphicsInfoFor || 'UNKNOWN'}, foreground ${foreground || 'UNKNOWN'}` +
        `${frames.foregroundIsTarget ? '' : '  <-- TARGET NOT FOREGROUNDED'}` +
        `${frames.valid ? '' : '  <-- TOO FEW FRAMES, sample refused'}`,
    );
    if (frames.valid) return frames;
    await sleep(2000);
  }
  return frames;
}

async function deviceFrameControl(target) {
  log('\n== device-frames: scripted swipes with and without device CPU load ==');
  const before = await frameRun(target, 'load off');
  const load = device.startDeviceCpuLoad(target, 12);
  await sleep(3000);
  const workers = load.count();
  const loadAvg = adb.shell(target, 'uptime').trim();
  const during = await frameRun(target, 'load on');
  load.stop();
  await sleep(2000);
  const after = await frameRun(target, 'load off again');

  const b = summarise([before.jankyPercent], { unit: '%' });
  const d = summarise([during.jankyPercent], { unit: '%' });
  // The comparison is `before` against `during`. `after` is a reversibility
  // check -- useful, but a refused `after` says nothing about whether the
  // control moved the metric, and gating on it once turned a valid VOID
  // verdict into a spurious INCONCLUSIVE.
  const comparisonValid = before.valid && during.valid;
  const runs = [before, during, after];
  const attributedToTarget = runs.every((r) => r && r.graphicsInfoFor && r.graphicsInfoFor.includes(FRAME_PKG));
  const foregroundedThroughout = runs.every((r) => r && r.foregroundIsTarget);

  // The control is refused unless BOTH halves hold: the counter answered for
  // the target package, and the target package was the surface on screen. A
  // frame count that satisfies neither is what this class published for four
  // tasks, and it looked exactly like a measurement.
  const attributionOk = attributedToTarget && foregroundedThroughout;
  let inconclusiveReason = null;
  if (!attributionOk) {
    inconclusiveReason = !attributedToTarget
      ? `dumpsys gfxinfo did not answer for ${FRAME_PKG}`
      : `${FRAME_PKG} was not the foregrounded window for every sample (saw ${[...new Set(runs.map((r) => (r && r.foregroundPackage) || 'UNKNOWN'))].join(', ')})`;
  } else if (!comparisonValid) {
    inconclusiveReason = `the before or during run rendered fewer than ${MIN_VALID_FRAMES} frames, so there is no sample to compare`;
  }

  return {
    metricClass: 'device-frames',
    metric: `dumpsys gfxinfo janky-frame % for ${FRAME_PKG} over an identical scripted swipe workload`,
    control: '12 spinning shell processes on the handset during the identical workload',
    controlInstalled: workers >= 10 && comparisonValid && attributionOk,
    inconclusiveReason,
    controlApplications: workers,
    controlApplicationsExpected: 12,
    framePackage: FRAME_PKG,
    framePackageBeforeTask5: FRAME_PKG_BEFORE_TASK5,
    attribution: {
      graphicsInfoFor: { loadOff: before.graphicsInfoFor, loadOn: during.graphicsInfoFor, loadOffAgain: after.graphicsInfoFor },
      foregroundPackage: { loadOff: before.foregroundPackage, loadOn: during.foregroundPackage, loadOffAgain: after.foregroundPackage },
      countedFrames: { loadOff: before.totalFrames, loadOn: during.totalFrames, loadOffAgain: after.totalFrames },
      answeredForTarget: attributedToTarget,
      targetForegroundedThroughout: foregroundedThroughout,
    },
    samplesValid: { loadOff: before.valid, loadOn: during.valid, loadOffAgain: after.valid },
    before: b,
    after: d,
    verdict: controlVerdict(b, d, { minRatio: 1.5, direction: 'up' }),
    detail: {
      loadOff: before,
      loadOn: during,
      loadOffAgain: after,
      deviceLoadAverageDuringControl: loadAvg,
      // Derived from THIS run's data, like the device-settle note beside it.
      // The string it replaced was a hardcoded assertion that the handset was
      // locked and the app could not be foregrounded, emitted unconditionally
      // on every later run -- including runs on an unlocked handset with the
      // app in front. Nothing here may assert a device state this function did
      // not observe; the handset's state at capture is in rig.device of this
      // same file.
      note: [
        `Frames are counted for ${FRAME_PKG}. Until Stage 9 Task 5 this constant was ${FRAME_PKG_BEFORE_TASK5}, so every run of this class before that date measured the system UI package BY CONSTRUCTION and no earlier verdict in this row is about the app.`,
        `dumpsys answered for: ${runs.map((r, i) => `${['load off', 'load on', 'load off again'][i]} ${r && r.graphicsInfoFor ? r.graphicsInfoFor : 'UNKNOWN'}`).join('; ')}.`,
        `Foregrounded window at each sample: ${runs.map((r, i) => `${['load off', 'load on', 'load off again'][i]} ${(r && r.foregroundPackage) || 'UNKNOWN'}`).join('; ')}.`,
        `Frames rendered by the identical scripted workload: ${runs.map((r, i) => `${['load off', 'load on', 'load off again'][i]} ${r ? r.totalFrames : 'n/a'}`).join('; ')}, against a ${MIN_VALID_FRAMES}-frame floor below which a sample is refused rather than compared.`,
        `Two facts about this control on this handset, both measured in Stage 9: (a) twelve spinning shell processes reach only about 12% of ONE core each, because Android confines adb-shell children to the background cpu cgroup, so six of eight cores stay free for the UI; (b) under that same load the INPUT path starves -- every \`input\` invocation spawns a JVM -- so a wake or a swipe can fail to take effect, which is why the wake is verified and retried before each sample.`,
        `Task 3 measured a third fact this control cannot escape: the same injected load raises the big cores from a pinned 883 to 2,669-3,648 MHz (runs.during cpuKhzBefore 3,648,000 kHz and cpuKhzAfter 2,668,800 kHz on cpu6/cpu7 in that artefact), so the CPU defect makes rendering FASTER on this handset. See scripts/perf/task3-frames-control.js and docs/verification/stage-9/raw/task3-frames-control.json, which run this class against the app on a wardrobe large enough to scroll.`,
      ].join(' '),
    },
  };
}

// ---------------------------------------------------------------------------
// device-settle (the analyser half, against synthetic ground truth)
// ---------------------------------------------------------------------------

const { execFileSync } = require('node:child_process');

function synthesiseVideo(changeSeconds, outPath) {
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=black:s=320x640:r=30:d=1',
    '-f', 'lavfi', '-i', `testsrc2=s=320x640:r=30:d=${changeSeconds}`,
    '-f', 'lavfi', '-i', 'color=white:s=320x640:r=30:d=2',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0',
    '-pix_fmt', 'yuv420p', outPath,
  ]);
}

async function settleAnalyserControl() {
  log('\n== device-settle: analyser against synthetic ground truth ==');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-settle-'));
  const shortPath = path.join(dir, 'settle-1s.mp4');
  const longPath = path.join(dir, 'settle-3s.mp4');
  synthesiseVideo(1, shortPath);
  synthesiseVideo(3, longPath);

  const shortResult = device.settleFromSeries(await device.frameChangeSeries(shortPath), { threshold: 0.5 });
  const longResult = device.settleFromSeries(await device.frameChangeSeries(longPath), { threshold: 0.5 });
  fs.rmSync(dir, { recursive: true, force: true });

  const b = summarise([shortResult.durationMs], { unit: 'ms' });
  const a = summarise([longResult.durationMs], { unit: 'ms' });

  return {
    metricClass: 'device-settle (analyser)',
    metric: 'measured unsettled duration, ms, from a recording with a KNOWN unsettled duration',
    control: 'the same analyser run over a synthetic recording whose changing section is 3 s instead of 1 s -- a +2000 ms injection with exact ground truth',
    controlInstalled: true,
    controlApplications: 2,
    controlApplicationsExpected: 2,
    before: b,
    after: a,
    verdict: controlVerdict(b, a, { minRatio: 1.5, direction: 'up' }),
    detail: {
      groundTruthShortMs: 1000,
      groundTruthLongMs: 3000,
      measuredShortMs: shortResult.durationMs,
      measuredLongMs: longResult.durationMs,
      note:
        'this proves the ANALYSER, not the capture path: it is run over recordings whose unsettled duration is known exactly, so a wrong answer is visible. Whether the CAPTURE path can produce a valid number on this handset is what the `device-settle (end to end)` row above tests, and the two verdicts must be read together.',
    },
  };
}


/**
 * The END-TO-END settle control: record the real screen while an on-device
 * workload of a KNOWN duration runs, then treble that duration and see whether
 * the measured number trebles with it.
 */
async function settleEndToEndControl(target) {
  log('\n== device-settle: end-to-end capture with a workload of known duration ==');
  const run = async (pairs, reps) => {
    const durations = [];
    const wall = [];
    let truncated = 0;
    for (let i = 0; i < reps; i += 1) {
      adb.shell(target, 'input keyevent KEYCODE_WAKEUP');
      await sleep(1000);
      const r = await device.measureSettle({
        target,
        seconds: 14,
        workDir: RAW_DIR,
        label: `${pairs} swipe pairs`,
        action: async () => {
          const t0 = Date.now();
          adb.shell(target, `for i in $(seq 1 ${pairs}); do input swipe 720 2400 720 900 300; input swipe 720 900 720 2400 300; done`);
          wall.push(Date.now() - t0);
          await sleep(2500);
        },
      });
      durations.push(r.durationMs);
      if (r.truncated) truncated += 1;
      fs.rmSync(r.video, { force: true });
    }
    return { durations, wall, truncated };
  };

  const short = await run(2, 2);
  const long = await run(6, 2);
  const b = summarise(short.durations, { unit: 'ms' });
  const a = summarise(long.durations, { unit: 'ms' });

  return {
    metricClass: 'device-settle (end to end)',
    metric: 'measured unsettled duration, ms, of a real screen recording',
    control: 'the on-device workload is trebled -- 2 swipe pairs (~1.4 s of screen movement) becomes 6 (~4.0 s)',
    // controlInstalled, controlApplications and controlApplicationsExpected must
    // describe the SAME comparison, or the rendered line reads "yes" beside an
    // arithmetic that fails. The installed check is "every long recording's
    // on-device workload ran for more than twice the shortest short one", so the
    // reported pair is that check's own two numbers, in ms of on-device workload.
    controlInstalled: long.wall.every((w) => w > short.wall[0] * 2),
    controlApplications: Math.round(Math.min(...long.wall)),
    controlApplicationsExpected: Math.round(short.wall[0] * 2),
    controlApplicationsUnit: 'ms of on-device workload (shortest long-condition run vs 2x the shortest short-condition run)',
    before: b,
    after: a,
    verdict: controlVerdict(b, a, { minRatio: 1.5, direction: 'up' }),
    detail: {
      shortWorkloadWallMs: short.wall,
      longWorkloadWallMs: long.wall,
      truncatedSamples: `${short.truncated + long.truncated} of ${short.durations.length + long.durations.length}`,
      // Generated from THIS run's data. It was previously a hardcoded string
      // asserting a lockscreen run with every sample truncated; that text was
      // never regenerated and ended up contradicting the very data beside it.
      // Nothing here may assert a device state this function did not observe --
      // the handset's actual state is in rig.device of the same file.
      note: [
        `n=${short.durations.length} per condition, so the reported median is the lower of two samples and no percentile above it is meaningful.`,
        `${short.truncated + long.truncated} of ${short.durations.length + long.durations.length} recordings ended with the screen still changing and are flagged truncated; a truncated sample is a LOWER BOUND on the settle time, not a measurement of it.`,
        `Dose actually applied on the handset: ${short.wall.join(' / ')} ms of swiping in the short condition against ${long.wall.join(' / ')} ms in the long one.`,
        `Handset state at capture -- keyguard, wakefulness, foregrounded app -- is recorded in rig.device of this same file. Read this verdict against that, not against any assumption about it.`,
      ].join(' '),
    },
  };
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

function verdictWord(record) {
  if (!record.controlInstalled) {
    return `INCONCLUSIVE (${record.inconclusiveReason || 'control not installed'})`;
  }
  return record.verdict.moved ? 'RESPONDS' : 'VOID (did not move)';
}

function toMarkdown(rig, records, meta) {
  const rows = records.map((r) => {
    const unit = r.before.unit;
    const dp = unit === 'bytes' || unit === 'KB' || unit === 'docs' ? 0 : 2;
    return `| \`${r.metricClass}\` | ${r.metric} | ${formatCell(r.before, dp)} | ${formatCell(r.after, dp)} | ${
      r.verdict.ratio === null ? 'n/a' : `${round(r.verdict.ratio, 2)}x`
    } | **${verdictWord(r)}** | ${r.runAt || meta.at} |`;
  });

  return `# Stage 9 -- negative-control matrix

Generated by \`scripts/perf/negative-controls.js\` at ${meta.at}.
Every row was RUN. Numbers are min / median / p95 / max over the stated sample.
${meta.runs && meta.runs.length > 1 ? `\nThis table was assembled from ${meta.runs.length} invocations (${meta.runs.join(', ')}); the \`run\` column says which one produced each row.\n` : ''}

## The table

| metric class | metric (units) | before (stock) | after (defect injected) | median ratio | verdict | run |
|---|---|---|---|---|---|---|
${rows.join('\n')}

## What each control did

${records
  .map(
    (r) =>
      `### \`${r.metricClass}\`\n\n` +
      `- **Control:** ${r.control}\n` +
      // Two different facts, and collapsing them renders a REFUSED SAMPLE as
      // a control that failed to install. `device-frames` applied its full dose
      // of 12 workers and was then refused for frame count -- "NO (applied 12,
      // expected at least 12)" said the opposite of what happened.
      `- **Control dose applied:** ${r.controlApplications >= r.controlApplicationsExpected ? 'yes' : 'NO'} (applied ${r.controlApplications}, expected at least ${r.controlApplicationsExpected})\n` +
      `- **Control usable for comparison:** ${r.controlInstalled ? 'yes' : `NO -- ${r.inconclusiveReason || 'control not installed'}`}\n` +
      `- **Before:** ${JSON.stringify({ n: r.before.n, min: round(r.before.min, 3), median: round(r.before.median, 3), p95: round(r.before.p95, 3), max: round(r.before.max, 3), unit: r.before.unit })}\n` +
      `- **After:** ${JSON.stringify({ n: r.after.n, min: round(r.after.min, 3), median: round(r.after.median, 3), p95: round(r.after.p95, 3), max: round(r.after.max, 3), unit: r.after.unit })}\n` +
      `- **Verdict:** ${verdictWord(r)}${r.detail && r.detail.note ? `\n- **Note:** ${r.detail.note}` : ''}`,
  )
  .join('\n\n')}

## The rig

\`\`\`json
${JSON.stringify(rig, null, 2)}
\`\`\`
`;
}

// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const skipDevice = argv.includes('--skip-device');
  const merge = argv.includes('--merge');
  // `--only a,b` re-runs just those classes; with `--merge` the rest of the
  // committed table is kept, each row still carrying the run that produced it.
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1].split(',').map((x) => x.trim()) : null;

  // FIRST, before anything else: undo whatever an interrupted run left behind.
  await safety.recoverLeftovers();

  fs.mkdirSync(RAW_DIR, { recursive: true });
  const rig = await captureRig({ mongoUri: MONGO_URI, apiHost: `http://localhost:${PORT}` });

  const records = [];
  const failures = [];
  const want = (name) => !only || only.includes(name);

  /**
   * One control failing must not cost the other six their results. A harness
   * that loses a whole run to a cleanup error teaches everyone to re-run
   * instead of read the failure.
   */
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

  if (want('api')) await attempt('api', apiControls);
  if (want('cpu')) await attempt('cpu', cpuControls);
  if (want('db')) await attempt('db', dbControls);

  if (!skipDevice) {
    let target = null;
    try {
      target = adb.device();
    } catch (err) {
      log(`\n!! no device: device controls skipped (${err.message})`);
      failures.push({ control: 'device', error: String(err.message) });
    }
    if (target) {
      if (want('device-memory')) await attempt('device-memory', () => deviceMemoryControl(target));
      if (want('device-frames')) await attempt('device-frames', () => deviceFrameControl(target));
      if (want('device-settle')) await attempt('device-settle-e2e', () => settleEndToEndControl(target));
    }
    if (want('device-settle')) await attempt('device-settle-analyser', settleAnalyserControl);
  }

  const at = new Date().toISOString();
  for (const r of records) r.runAt = at;

  const jsonPath = path.join(OUT_DIR, 'negative-controls.json');
  let finalRecords = records;
  let meta = { at, harness: 'scripts/perf/negative-controls.js', runs: [at] };

  /**
   * `--merge` replaces only the classes this invocation actually re-ran and
   * keeps the rest of the committed table. Every record carries its own
   * `runAt`, and `meta.runs` lists every invocation that contributed, so a
   * merged artefact can never pass itself off as one sitting.
   */
  if (merge && fs.existsSync(jsonPath)) {
    const previous = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    // Rows carried over keep the timestamp of the run that produced them. A
    // carried row that inherited the MERGE's timestamp would claim to have been
    // measured in a sitting it was not part of, which is the one thing a merged
    // artefact must never do.
    for (const r of previous.records) if (!r.runAt) r.runAt = previous.meta.at;
    const replaced = new Set(records.map((r) => r.metricClass));
    finalRecords = [
      ...previous.records.map((r) => {
        const fresh = records.find((n) => n.metricClass === r.metricClass);
        return fresh || r;
      }),
      ...records.filter((r) => !previous.records.some((p) => p.metricClass === r.metricClass)),
    ];
    meta = {
      at,
      harness: 'scripts/perf/negative-controls.js',
      runs: [...(previous.meta.runs || [previous.meta.at]), at],
      mergedClasses: [...replaced],
    };
    log(`\nmerged ${replaced.size} class(es) into the existing table; other rows kept from earlier runs`);
  }

  const payload = { meta, rig, records: finalRecords, failures };
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'negative-controls.md'), toMarkdown(rig, finalRecords, meta));

  if (failures.length) {
    log('\n=== CONTROLS THAT COULD NOT BE RUN ===');
    for (const f of failures) log(`  ${f.control}: ${f.error.split('\n')[0]}`);
  }
  log('\n=== VERDICTS ===');
  for (const r of finalRecords) log(`  ${verdictWord(r).padEnd(52)} ${r.metricClass}${r.runAt === at ? '' : `  (from ${r.runAt})`}`);
  const leftovers = safety.listLeftovers();
  log(`\nledger after run: ${leftovers.length} leftover(s)`);
  log(`written: docs/verification/stage-9/negative-controls.{json,md}`);
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

module.exports = { main, toMarkdown };
