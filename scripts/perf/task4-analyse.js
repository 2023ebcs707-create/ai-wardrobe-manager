'use strict';

/**
 * STAGE 9 TASK 4 — turn a session capture into a slope with an interval, and a
 * verdict against the rule fixed in `docs/verification/stage-9/task4-preregistration.md`.
 *
 * Everything decided here was decided before the data existed: the practical
 * floor (0.5 MiB/min), the precedence of the verdicts, the primary and
 * secondary windows, and the fact that both HAC and bootstrap intervals are
 * printed so a verdict that flips between them is visible rather than picked.
 *
 *   node scripts/perf/task4-analyse.js --in <session.json> [--out <analysis.json>]
 *        [--floor-mib 0.5] [--drop-minutes 5] [--label session]
 */

const fs = require('node:fs');
const path = require('node:path');
const trend = require('./lib/trend');
const { summarise } = require('./lib/stats');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };

const IN = arg('--in', null);
const OUT = arg('--out', null);
const FLOOR_MIB = Number(arg('--floor-mib', '0.5'));
const DROP_MIN = Number(arg('--drop-minutes', '5'));
const LABEL = arg('--label', null);
// `--max-minutes` exists for ONE purpose and it is stated so it cannot be
// mistaken for cherry-picking: the capture-path control runs for fewer minutes
// than the session, and comparing its slope against the session's full-length
// slope would compare two windows with different statistical power. Truncating
// the session to the control's length makes the two comparable. The primary
// verdict is always taken from the untruncated run.
const MAX_MIN = arg('--max-minutes', null) === null ? null : Number(arg('--max-minutes'));
if (!IN) throw new Error('--in <session.json> is required');

const session = JSON.parse(fs.readFileSync(IN, 'utf8'));
const label = (LABEL || session.label) + (MAX_MIN === null ? '' : ` [truncated to ${MAX_MIN} min for comparison]`);
const S = MAX_MIN === null ? session.samples : session.samples.filter((r) => r.minutes <= MAX_MIN);
if (!S || S.length < 10) throw new Error(`only ${S ? S.length : 0} samples — refusing to fit a trend`);

const KB_FLOOR = FLOOR_MIB * 1024;

/** Every memory series, in KB, plus the object counts in their own units. */
const SERIES = [
  ['TOTAL Private Dirty', 'totalPrivateDirtyKb', 'KB', KB_FLOOR, true],
  ['TOTAL Private Dirty + Swap PSS', 'privateDirtyPlusSwapKb', 'KB', KB_FLOOR, true],
  ['TOTAL PSS', 'totalPssKb', 'KB', KB_FLOOR, true],
  ['TOTAL RSS', 'totalRssKb', 'KB', KB_FLOOR, false],
  ['TOTAL SWAP PSS', 'totalSwapPssKb', 'KB', KB_FLOOR, false],
  ['TOTAL Private Clean', 'totalPrivateCleanKb', 'KB', KB_FLOOR, false],
  ['App Summary Java Heap', 'javaHeapPssKb', 'KB', KB_FLOOR, false],
  ['App Summary Native Heap', 'nativeHeapPssKb', 'KB', KB_FLOOR, false],
  ['App Summary Graphics', 'graphicsPssKb', 'KB', KB_FLOOR, false],
  ['App Summary Code', 'codePssKb', 'KB', KB_FLOOR, false],
  // The App Summary's seven Pss rows sum EXACTLY to TOTAL PSS. The first
  // round of this task trended four of them and left the remainder to be
  // inferred by subtraction; all seven are trended now, so no part of a rise
  // has to be attributed to a row nobody measured.
  ['App Summary Stack', 'stackPssKb', 'KB', KB_FLOOR, false],
  ['App Summary Private Other', 'privateOtherPssKb', 'KB', KB_FLOOR, false],
  ['App Summary System', 'systemPssKb', 'KB', KB_FLOOR, false],
  // `Native Heap Pss` is what the allocator holds from the kernel; `Heap
  // Alloc` is what the program has asked for and not freed. Churn can grow
  // the first without retaining anything, and only the second separates a
  // genuine retention from allocator arena growth.
  ['Native Heap Alloc', 'nativeHeapAllocKb', 'KB', KB_FLOOR, false],
  ['Native Heap Size (arena)', 'nativeHeapSizeKb', 'KB', KB_FLOOR, false],
  ['Native Heap Free', 'nativeHeapFreeKb', 'KB', KB_FLOOR, false],
  ['Dalvik Heap Alloc', 'dalvikHeapAllocKb', 'KB', KB_FLOOR, false],
  ['Bitmap total (native)', 'bitmapTotalKb', 'KB', KB_FLOOR, false],
  // A leaked View is the classic React Native leak signature and it is counted
  // in the same dump, so it costs nothing to trend and would catch a leak that
  // the byte totals hid under ZRAM. Floor: 1 view/min, i.e. 30 leaked views
  // across the window the claim names.
  ['Views (object count)', 'views', 'count', 1, false],
  ['Activities (object count)', 'activities', 'count', 1, false],
  ['AppContexts (object count)', 'appContexts', 'count', 1, false],
];

function window(samples, fromMinutes) {
  const s = samples.filter((r) => r.minutes >= fromMinutes);
  return { xs: s.map((r) => r.minutes), rows: s };
}

function runSeries(rows, xs, key, floor) {
  const ys = rows.map((r) => r[key]);
  if (ys.some((v) => v === null || v === undefined || !Number.isFinite(v))) return null;
  if (new Set(ys).size === 1) {
    return { constant: true, value: ys[0], n: ys.length };
  }
  return trend.analyse(xs, ys, { floor });
}

const windows = [
  { name: `full session (0 – ${S[S.length - 1].minutes.toFixed(1)} min)`, from: 0, primary: true },
  { name: `after ${DROP_MIN} min (${DROP_MIN} – ${S[S.length - 1].minutes.toFixed(1)} min)`, from: DROP_MIN, primary: false },
];

const results = {};
for (const w of windows) {
  const { xs, rows } = window(S, w.from);
  results[w.name] = { from: w.from, primary: w.primary, n: rows.length, series: {} };
  for (const [name, key, unit, floor] of SERIES) {
    const r = runSeries(rows, xs, key, floor);
    results[w.name].series[name] = r === null ? { unavailable: true } : { unit, floor, ...r };
  }
}

// --- sensitivity: what slope WOULD this instrument have called? -------------
const primary = window(S, 0);
const sweepRatesMib = [0, 0.05, 0.1, 0.25, 0.5, 1, 2, 5];
const primaryYs = primary.rows.map((r) => r.totalPrivateDirtyKb);
const sweep = trend.sensitivitySweep(primary.xs, primaryYs, sweepRatesMib.map((m) => m * 1024), { floor: KB_FLOOR });

/**
 * The same sweep on the series with its own fitted trend REMOVED.
 *
 * The sweep above adds a ramp on top of whatever slope the session already has,
 * so if the session is itself rising, every injected rate is "detected" and the
 * sweep says nothing about sensitivity. Detrending leaves this rig's real
 * residual structure — its GC steps, its swap moves, its sampling jitter —
 * around a genuinely flat line, which is the series the question "what is the
 * smallest slope this instrument would have called?" is actually about.
 */
const detrendFit = trend.ols(primary.xs, primaryYs);
const flattened = primaryYs.map((y, i) => y - (detrendFit.intercept + detrendFit.slope * primary.xs[i]) + detrendFit.intercept);
const sweepFlat = trend.sensitivitySweep(primary.xs, flattened, sweepRatesMib.map((m) => m * 1024), { floor: KB_FLOOR });

/**
 * OLS of y on [1, t, t^2] by Gaussian elimination on the 3x3 normal equations,
 * with a classical t on the quadratic term. Used only to ask whether the rise
 * decelerates: a slope alone cannot distinguish a straight line from a curve
 * that is flattening, and "no plateau" is the load-bearing claim.
 */
function quadratic(xs, ys) {
  const n = xs.length;
  if (n < 8) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const z = xs.map((x) => x - mx); // centre, or the normal equations are ill-conditioned
  const X = z.map((t) => [1, t, t * t]);
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const b = [0, 0, 0];
  for (let i = 0; i < n; i += 1) {
    for (let r = 0; r < 3; r += 1) {
      b[r] += X[i][r] * ys[i];
      for (let c = 0; c < 3; c += 1) A[r][c] += X[i][r] * X[i][c];
    }
  }
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 3; c += 1) {
    let p = c;
    for (let r = c + 1; r < 3; r += 1) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < 3; r += 1) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k < 4; k += 1) M[r][k] -= f * M[c][k];
    }
  }
  const beta = [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
  const resid = ys.map((y, i) => y - (beta[0] + beta[1] * z[i] + beta[2] * z[i] * z[i]));
  const s2 = resid.reduce((a, r) => a + r * r, 0) / (n - 3);
  // (X'X)^-1 [2][2] by cofactor, which is all the t on the quadratic term needs.
  const det =
    A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) -
    A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) +
    A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
  if (Math.abs(det) < 1e-12) return null;
  const inv22 = (A[0][0] * A[1][1] - A[0][1] * A[1][0]) / det;
  const se2 = Math.sqrt(s2 * inv22);
  return { beta2: beta[2], t2: beta[2] / se2 };
}

// --- printing ---------------------------------------------------------------
const mib = (kb) => kb / 1024;
const f2 = (x) => (x === null || x === undefined ? 'n/a' : x.toFixed(2));
const f3 = (x) => (x === null || x === undefined ? 'n/a' : x.toFixed(3));
const f1 = (x) => (x === null || x === undefined ? 'n/a' : x.toFixed(1));

const spanMinutes = S[S.length - 1].minutes - S[0].minutes;
console.log(`\n=== ${label} — sampled span ${spanMinutes.toFixed(1)} min (driver ran ${session.durationMinutes.toFixed(1)} min), ${S.length} samples, one every ${((S[S.length - 1].at - S[0].at) / (S.length - 1) / 1000).toFixed(1)} s ===`);
console.log(`process ${session.process}, pid ${session.startPid} -> ${session.endPid} (${session.pidStable ? 'unchanged' : 'CHANGED'})`);
console.log(`practical floor: ${FLOOR_MIB} MiB/min (${KB_FLOOR} KB/min) — fixed before the data, see task4-preregistration.md`);

for (const w of windows) {
  const R = results[w.name];
  console.log(`\n--- ${w.name}${w.primary ? '  [PRIMARY]' : ''} — n=${R.n} ---`);
  console.log(
    'series'.padEnd(32) +
      'median MiB'.padStart(11) +
      'OLS MiB/min'.padStart(13) +
      'HAC 95% CI'.padStart(22) +
      'boot 95% CI'.padStart(22) +
      'TheilSen'.padStart(10) +
      '  R2     verdict'
  );
  for (const [name, key, unit] of SERIES) {
    const r = R.series[name];
    if (r.unavailable) { console.log(`${name.padEnd(32)}  (not present in this capture)`); continue; }
    if (r.constant) { console.log(`${name.padEnd(32)}  constant at ${r.value} ${unit} for all ${r.n} samples`); continue; }
    const conv = unit === 'KB' ? mib : (x) => x;
    const med = summarise(window(S, w.from).rows.map((x) => x[key]), { unit }).median;
    const hac = r.fit.ciHac ? `[${f2(conv(r.fit.ciHac[0]))}, ${f2(conv(r.fit.ciHac[1]))}]` : 'HAC var < 0';
    const bs = `[${f2(conv(r.bootstrap.ci[0]))}, ${f2(conv(r.bootstrap.ci[1]))}]`;
    console.log(
      name.padEnd(32) +
        f2(conv(med)).padStart(11) +
        f3(conv(r.fit.slope)).padStart(13) +
        hac.padStart(22) +
        bs.padStart(22) +
        f3(conv(r.theilSen.slope)).padStart(10) +
        `  ${f2(r.fit.r2)}  ${r.verdictHac.verdict}${r.verdictBootstrap.verdict !== r.verdictHac.verdict ? ` (bootstrap: ${r.verdictBootstrap.verdict})` : ''}`
    );
  }
}

console.log(`\n--- ANALYSER SENSITIVITY: a synthetic ramp added to THIS session's own ${LABEL || 'primary'} TOTAL Private Dirty series ---`);
console.log('injected MiB/min'.padStart(16) + 'fitted MiB/min'.padStart(16) + 'HAC 95% CI'.padStart(24) + '  upward trend seen?');
for (const s of sweep) {
  console.log(
    f2(mib(s.rate)).padStart(16) +
      f3(mib(s.slope)).padStart(16) +
      (s.ciHac ? `[${f2(mib(s.ciHac[0]))}, ${f2(mib(s.ciHac[1]))}]` : 'HAC var < 0').padStart(24) +
      `  ${s.detected ? 'YES' : 'no '}  (verdict ${s.verdict})`
  );
}

const firstDetected = sweep.find((s) => s.detected && s.rate > 0);
console.log(`\nsmallest swept rate this analyser called upward (on the raw series): ${firstDetected ? `${mib(firstDetected.rate)} MiB/min` : 'NONE of the swept rates'}`);

console.log(`\n--- ANALYSER SENSITIVITY on the DETRENDED series (this rig's real noise around a genuinely flat line) ---`);
console.log(`    the session's own fitted slope of ${f3(mib(detrendFit.slope))} MiB/min was removed first; residual SD ${f2(mib(detrendFit.residualSd))} MiB`);
console.log('injected MiB/min'.padStart(16) + 'fitted MiB/min'.padStart(16) + 'HAC 95% CI'.padStart(24) + '  upward trend seen?');
for (const s of sweepFlat) {
  console.log(
    f2(mib(s.rate)).padStart(16) +
      f3(mib(s.slope)).padStart(16) +
      (s.ciHac ? `[${f2(mib(s.ciHac[0]))}, ${f2(mib(s.ciHac[1]))}]` : 'HAC var < 0').padStart(24) +
      `  ${s.detected ? 'YES' : 'no '}  (verdict ${s.verdict})`
  );
}
const firstFlatDetected = sweepFlat.find((s) => s.detected && s.rate > 0);
console.log(`\nsmallest swept rate this analyser called upward (detrended): ${firstFlatDetected ? `${mib(firstFlatDetected.rate)} MiB/min` : 'NONE of the swept rates'}`);
console.log('This validates the ANALYSER. It does not validate the CAPTURE PATH — see task4-control-leak.js for that.');

// --- the shape of the curve, because a slope alone hides a step ------------
// A single number cannot distinguish a steady leak from a one-off step early on
// followed by a flat plateau, and those two have completely different meanings
// for a stability claim. Five-minute buckets make the shape visible.
const BUCKET = 5;
const buckets = [];
for (let b = 0; b * BUCKET <= S[S.length - 1].minutes; b += 1) {
  const rows = S.filter((r) => r.minutes >= b * BUCKET && r.minutes < (b + 1) * BUCKET);
  if (rows.length === 0) continue;
  buckets.push({
    from: b * BUCKET,
    to: Math.min((b + 1) * BUCKET, S[S.length - 1].minutes),
    n: rows.length,
    privDirtyMedianKb: summarise(rows.map((r) => r.totalPrivateDirtyKb)).median,
    privDirtySwapMedianKb: summarise(rows.map((r) => r.privateDirtyPlusSwapKb)).median,
    pssMedianKb: summarise(rows.map((r) => r.totalPssKb)).median,
    swapMedianKb: summarise(rows.map((r) => r.totalSwapPssKb)).median,
    graphicsMedianKb: summarise(rows.map((r) => r.graphicsPssKb)).median,
    nativeHeapMedianKb: summarise(rows.map((r) => r.nativeHeapPssKb)).median,
    javaHeapMedianKb: summarise(rows.map((r) => r.javaHeapPssKb)).median,
    bitmapMedianKb: summarise(rows.map((r) => r.bitmapTotalKb)).median,
    viewsMedian: summarise(rows.map((r) => r.views)).median,
  });
}
console.log('\n--- shape: 5-minute bucket medians (MiB unless stated) ---');
console.log('window'.padEnd(14) + 'n'.padStart(4) + 'privDirty'.padStart(11) + '+swap'.padStart(10) + 'PSS'.padStart(10) + 'swap'.padStart(9) + 'graphics'.padStart(10) + 'native'.padStart(9) + 'java'.padStart(8) + 'bitmaps'.padStart(9) + 'views'.padStart(8));
for (const b of buckets) {
  console.log(
    `${b.from}–${b.to.toFixed(1)} min`.padEnd(14) +
      String(b.n).padStart(4) +
      f1(mib(b.privDirtyMedianKb)).padStart(11) +
      f1(mib(b.privDirtySwapMedianKb)).padStart(10) +
      f1(mib(b.pssMedianKb)).padStart(10) +
      f1(mib(b.swapMedianKb)).padStart(9) +
      f1(mib(b.graphicsMedianKb)).padStart(10) +
      f1(mib(b.nativeHeapMedianKb)).padStart(9) +
      f1(mib(b.javaHeapMedianKb)).padStart(8) +
      f1(mib(b.bitmapMedianKb)).padStart(9) +
      String(b.viewsMedian).padStart(8)
  );
}

// --- WITHIN-PHASE FITS: the screen-composition confound, removed -----------
//
// A sample is taken every `actionsPerSample` actions of a cycle whose length is
// a whole multiple of that, so every sample lands at one of a small number of
// FIXED cycle phases and the phases repeat exactly. That already means elapsed
// time is not confounded with which screen is showing -- but "already means" is
// an argument, not a measurement. Fitting each phase SEPARATELY turns it into
// one: within a phase, every point was taken on the same screen after the same
// three actions, so a rise cannot be composition. If every phase rises, there
// is no phase in which memory is flat.
const byPhase = new Map();
for (const r of primary.rows) {
  if (!byPhase.has(r.afterAction)) byPhase.set(r.afterAction, []);
  byPhase.get(r.afterAction).push(r);
}
const phaseFits = [];
for (const [phase, rows] of byPhase) {
  if (rows.length < 6) continue; // 6 points spans >=5 cycles at this cadence; fewer cannot separate a trend from the phase pattern
  const xs = rows.map((r) => r.minutes);
  for (const [name, key] of [['native heap', 'nativeHeapPssKb'], ['TOTAL Private Dirty', 'totalPrivateDirtyKb']]) {
    const ys = rows.map((r) => r[key]);
    if (ys.some((v) => !Number.isFinite(v))) continue;
    const f = trend.ols(xs, ys);
    phaseFits.push({ phase, series: name, n: rows.length, slopeKb: f.slope, ciHac: f.ciHac, r2: f.r2 });
  }
}
console.log('\n--- WITHIN-PHASE FITS: each cycle phase fitted on its own (same screen, same three actions, every point) ---');
console.log('phase'.padEnd(22) + 'n'.padStart(4) + 'native MiB/min'.padStart(16) + 'HAC 95% CI'.padStart(22) + '  R2' + '   privDirty MiB/min'.padStart(21) + 'HAC 95% CI'.padStart(22) + '  R2');
for (const [phase, rows] of byPhase) {
  const nh = phaseFits.find((f) => f.phase === phase && f.series === 'native heap');
  const pd = phaseFits.find((f) => f.phase === phase && f.series === 'TOTAL Private Dirty');
  if (!nh) continue;
  const ci = (f) => (f && f.ciHac ? `[${f2(mib(f.ciHac[0]))}, ${f2(mib(f.ciHac[1]))}]` : 'HAC var < 0');
  console.log(
    phase.padEnd(22) + String(rows.length).padStart(4) +
      f3(mib(nh.slopeKb)).padStart(16) + ci(nh).padStart(22) + `  ${f2(nh.r2)}` +
      f3(mib(pd.slopeKb)).padStart(21) + ci(pd).padStart(22) + `  ${f2(pd.r2)}`
  );
}
const nhFits = phaseFits.filter((f) => f.series === 'native heap');
if (nhFits.length) {
  const rising = nhFits.filter((f) => f.ciHac && f.ciHac[0] > 0 && f.slopeKb >= KB_FLOOR).length;
  console.log(`\n${rising} of ${nhFits.length} phases RISE on native heap (HAC interval entirely above 0 and slope >= the ${FLOOR_MIB} MiB/min floor).`);
  console.log(`native-heap slope across phases: min ${f3(mib(Math.min(...nhFits.map((f) => f.slopeKb))))}, max ${f3(mib(Math.max(...nhFits.map((f) => f.slopeKb))))} MiB/min; R2 ${f2(Math.min(...nhFits.map((f) => f.r2)))}-${f2(Math.max(...nhFits.map((f) => f.r2)))}`);
}

// --- SPLIT-HALF: a slope alone cannot see a plateau ------------------------
const dropped = window(S, DROP_MIN);
const lastMin = S[S.length - 1].minutes;
const midMin = DROP_MIN + (lastMin - DROP_MIN) / 2;
console.log(`\n--- SPLIT-HALF and CURVATURE on the ${DROP_MIN}+ min window (does the rise decelerate?) ---`);
for (const [name, key] of [['App Summary Native Heap', 'nativeHeapPssKb'], ['TOTAL Private Dirty', 'totalPrivateDirtyKb']]) {
  const halves = [
    [`${DROP_MIN.toFixed(0)}-${midMin.toFixed(1)} min`, dropped.rows.filter((r) => r.minutes < midMin)],
    [`${midMin.toFixed(1)}-${lastMin.toFixed(1)} min`, dropped.rows.filter((r) => r.minutes >= midMin)],
  ];
  const parts = halves.map(([label, rows]) => {
    const f = trend.ols(rows.map((r) => r.minutes), rows.map((r) => r[key]));
    return `${label}: ${f3(mib(f.slope))} ${f.ciHac ? `[${f2(mib(f.ciHac[0]))}, ${f2(mib(f.ciHac[1]))}]` : ''} (n=${rows.length})`;
  });
  // Quadratic term, by OLS on [1, t, t^2] via the normal equations.
  const xs = dropped.rows.map((r) => r.minutes);
  const ys = dropped.rows.map((r) => r[key]);
  const quad = quadratic(xs, ys);
  console.log(`  ${name}`);
  console.log(`    ${parts.join('   |   ')}`);
  console.log(`    quadratic term ${quad === null ? 'n/a' : `${quad.beta2.toExponential(3)} KiB/min^2, t = ${quad.t2.toFixed(2)} (|t| > 2 would be curvature)`}`);
}

// --- CPU clocks, because on this handset they can invert a defect -----------
const cpu7 = S.map((r) => r.cpuFreqKHz && r.cpuFreqKHz.cpu7).filter((v) => Number.isFinite(v) && v > 0);
if (cpu7.length) {
  const c = summarise(cpu7, { unit: 'kHz' });
  console.log(`\ncpu7 (big core) during the session: min/med/p95/max kHz ${c.min} / ${c.median} / ${c.p95} / ${c.max} (n=${c.n})`);
  const cf = trend.ols(S.filter((r) => r.cpuFreqKHz && r.cpuFreqKHz.cpu7 > 0).map((r) => r.minutes), cpu7);
  console.log(`  clock trend: ${cf.slope.toFixed(0)} kHz/min, HAC 95% CI [${cf.ciHac ? cf.ciHac.map((v) => v.toFixed(0)).join(', ') : 'n/a'}]`);
}

// --- how the session's time was actually spent -----------------------------
const byScreen = {};
for (const a of session.actions) byScreen[a.screen] = (byScreen[a.screen] || 0) + 1;
console.log('\nactions by screen (this is the "continuous use" the verdict rests on):');
for (const [k, v] of Object.entries(byScreen).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(28)} ${String(v).padStart(4)} actions  ${((100 * v) / session.actions.length).toFixed(1)}%`);
}
const failed = session.actions.filter((a) => a.error);
console.log(`  actions that threw: ${failed.length}${failed.length ? ` — ${JSON.stringify(failed.slice(0, 5))}` : ''}`);

if (OUT) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    label, source: IN, floorMib: FLOOR_MIB, dropMinutes: DROP_MIN,
    durationMinutes: session.durationMinutes, samples: S.length,
    windows: results, sensitivitySweep: sweep, sensitivitySweepDetrended: sweepFlat, detrendFit: { slope: detrendFit.slope, residualSd: detrendFit.residualSd }, actionsByScreen: byScreen, buckets,
    pidStable: session.pidStable, events: session.events,
  }, null, 2));
  console.log(`\nout: ${OUT}`);
}
