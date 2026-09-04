'use strict';

/**
 * STAGE 9 TASK 3 — Claim 8, "approximately 80-120 MB of RAM during typical usage".
 *
 * ## The row choice is the whole measurement, so no row is chosen
 *
 * `dumpsys meminfo host.exp.exponent` on this handset reads anywhere from about
 * 30 MB to about 700 MB depending on which line is quoted. Picking one is how a
 * performance claim gets "verified" without being measured. This script
 * therefore records EVERY row of every sample — the per-mapping table, the App
 * Summary, TOTAL PSS / TOTAL RSS / TOTAL SWAP PSS, and the native Bitmap
 * allocation counters — and reports each as its own distribution. The report
 * then states which are app-attributable and which are not, and says plainly
 * that the two cannot be separated on this rig.
 *
 * ## A PARSE FAILURE THAT WAS SILENT FOR 75 SAMPLES
 *
 * The first version anchored the per-mapping table on /Heap\s+Free/. On this
 * handset the column headings are split across two lines ("... Heap Heap Heap"
 * then "... Size Alloc Free"), so "Heap" is never immediately followed by
 * "Free" and the anchor never matched. Every one of the 75 samples in the first
 * capture recorded `rows: {}`, all six row-level distributions came back n=0,
 * and NOTHING SAID SO — the summary printer skipped any distribution with
 * n === 0, so the failure looked like silence. The claim "records every row of
 * every sample" was true of the intent and false of the artefact.
 *
 * Two changes: the anchor is now the second heading line and the dashed rule
 * beneath it, and a sample whose row table did not parse THROWS rather than
 * being recorded. An instrument that cannot measure must say so, not return an
 * empty object.
 *
 * ## Why they cannot be separated
 *
 * This app ships through EXPO GO. The measurable process, `host.exp.exponent`,
 * contains Expo Go's entire runtime — its own Java and native heaps, its APK and
 * dex mappings, its React Native and Hermes copies — as well as the JavaScript
 * of this app. There is no standalone build of this project to measure, so
 * nothing here can report "the app's RAM" as the document's sentence implies.
 *
 * The closest honest attribution available is a DIFFERENCE, and this script
 * takes it: the same freshly started process at Expo Go's own home screen with
 * no experience loaded, against the same process with this app loaded. That
 * difference is what loading this app adds to the process. It is an
 * over-estimate of nothing and an under-estimate of nothing; it is simply the
 * delta, and it is labelled as such.
 *
 * ## Nothing is discarded
 *
 * `measure-device.js` states the rule and it is kept here: the first reading of
 * a memory total is as valid as the tenth, and discarding early samples would
 * hide exactly the growth a leak claim is about.
 *
 *   node scripts/perf/task3-memory.js --mode baseline|app|session \
 *        --samples 12 --interval 2000 --out <json>
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const adb = require('./lib/adb');
const { summarise } = require('./lib/stats');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };

const MODE = arg('--mode', 'app');
const SAMPLES = Number(arg('--samples', '12'));
const INTERVAL = Number(arg('--interval', '2000'));
const OUT = arg('--out', null);
const LABEL = arg('--label', MODE);

/**
 * STAGE 10 TASK 1 CHANGE — the process under measurement is now a parameter.
 *
 * Claim 8 was recorded CANNOT BE MEASURED AS STATED for exactly one reason:
 * the only process that existed to measure was `host.exp.exponent`, Expo Go,
 * which reads 168.8 MiB with no experience loaded at all. Stage 10 Task 1
 * builds a standalone APK, so the app has its own process and this instrument
 * has to be able to point at it.
 *
 * DEFAULTS UNCHANGED: with no new flags this script does exactly what it did in
 * Stage 9, so every Stage 9 artefact stays reproducible from the command
 * recorded with it. `parseFull` below is NOT touched — `task4-parser-equivalence.js`
 * lifts its source text out of this file and asserts it byte-for-byte against
 * `lib/meminfo.js`, and that proof is the one thing standing between this
 * harness and Task 3's silent `rows: {}` bug.
 */
const PKG = arg('--pkg', 'host.exp.exponent');
const EXP_URL = arg('--launch-url', PKG === 'host.exp.exponent' ? 'exp://127.0.0.1:8081' : '');
const LAUNCH_ACTIVITY = arg('--launch-activity', '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** How this run brings its app to the foreground. Expo Go: `exp://` deep link, as in Stage 9. Standalone: its own launcher activity. */
function launchCommand() {
  if (LAUNCH_ACTIVITY) return `am start -n ${LAUNCH_ACTIVITY}`;
  if (EXP_URL) return `am start -a android.intent.action.VIEW -d "${EXP_URL}" ${PKG}`;
  return `monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`;
}

// STAGE 10 TASK 1: tab-bar y is a parameter (default 2960, the Stage 9 value,
// so Stage 9 commands reproduce). The standalone APK runs edge-to-edge and its
// tab bar sits ~80 px lower than in Expo Go; content-area taps are unchanged.
const TAB_Y = Number(arg('--tab-y', '2960'));
const TAP = {
  tabHome: [144, TAB_Y], tabSearch: [432, TAB_Y], tabAdd: [720, TAB_Y],
  tabFavorites: [1008, TAB_Y], tabProfile: [1296, TAB_Y],
  chipAll: [136, 767], chipTshirt: [373, 767], chipShirt: [600, 767], chipTrousers: [860, 767],
  firstTile: [240, 1150],
};

/** Parse every row of `dumpsys meminfo`, not a chosen one. */
function parseFull(text) {
  const out = { pid: null, rows: {}, summary: {}, totals: {}, objects: {}, nativeAllocations: {} };
  const pidM = text.match(/MEMINFO in pid (\d+)/);
  if (pidM) out.pid = Number(pidM[1]);
  // The per-mapping table's column headings are split across TWO lines on this
  // handset ("... Heap Heap Heap" / "... Size Alloc Free"), so an earlier
  // /Heap\s+Free/ anchor never matched and every `rows` object came back empty
  // for all 75 samples of the first capture. Anchor on the second heading line
  // and the dashed rule beneath it instead. See the report's §6.1.
  const tableM = text.match(/Alloc\s+Free\r?\n[ \t-]*\r?\n([\s\S]*?)\r?\n[ \t]*\r?\n/);
  if (tableM) {
    for (const line of tableM[1].split('\n')) {
      const m = line.match(/^\s*([A-Za-z.][A-Za-z. ]*[A-Za-z])\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/);
      if (m) out.rows[m[1].trim()] = { pssKb: Number(m[2]), privateDirtyKb: Number(m[3]), privateCleanKb: Number(m[4]), swapPssKb: Number(m[5]), rssKb: Number(m[6]) };
    }
  }
  const sumM = text.match(/App Summary[\s\S]*?------\s*\n([\s\S]*?)\n\s*\n/);
  if (sumM) {
    for (const line of sumM[1].split('\n')) {
      const m = line.match(/^\s*([A-Za-z ]+):\s+(\d+)(?:\s+(\d+))?/);
      if (m) out.summary[m[1].trim().toLowerCase().replace(/\s+/g, '_')] = { pssKb: Number(m[2]), rssKb: m[3] ? Number(m[3]) : null };
    }
  }
  const t = text.match(/TOTAL PSS:\s*(\d+)\s+TOTAL RSS:\s*(\d+)\s+TOTAL SWAP(?: PSS)?(?: \(KB\))?:\s*(\d+)/);
  if (t) out.totals = { totalPssKb: Number(t[1]), totalRssKb: Number(t[2]), totalSwapPssKb: Number(t[3]) };
  for (const [k, re] of [['views', /Views:\s*(\d+)/], ['activities', /Activities:\s*(\d+)/], ['appContexts', /AppContexts:\s*(\d+)/]]) {
    const m = text.match(re); if (m) out.objects[k] = Number(m[1]);
  }
  const bm = text.match(/Bitmap \(malloced\):\s*(\d+)\s+(\d+)/);
  const bn = text.match(/Bitmap \(nonmalloced\):\s*(\d+)\s+(\d+)/);
  if (bm) out.nativeAllocations.bitmapMalloced = { count: Number(bm[1]), totalKb: Number(bm[2]) };
  if (bn) out.nativeAllocations.bitmapNonMalloced = { count: Number(bn[1]), totalKb: Number(bn[2]) };
  return out;
}

const read = (t) => parseFull(adb.shell(t, `dumpsys meminfo ${PKG}`));

async function scriptedUsage(t, step) {
  // A stated, repeatable "typical usage" loop: browse the grid, filter it, open
  // an item, come back, visit each tab. It is a judgement call about what
  // "typical" means and is written down rather than improvised per run.
  const seq = [
    ['scroll grid', () => adb.shell(t, 'input swipe 720 2400 720 900 250')],
    ['scroll grid back', () => adb.shell(t, 'input swipe 720 900 720 2400 250')],
    ['filter tshirt', () => adb.shell(t, `input tap ${TAP.chipTshirt[0]} ${TAP.chipTshirt[1]}`)],
    ['filter all', () => adb.shell(t, `input tap ${TAP.chipAll[0]} ${TAP.chipAll[1]}`)],
    ['open item', () => adb.shell(t, `input tap ${TAP.firstTile[0]} ${TAP.firstTile[1]}`)],
    ['back', () => adb.shell(t, 'input keyevent KEYCODE_BACK')],
    ['tab search', () => adb.shell(t, `input tap ${TAP.tabSearch[0]} ${TAP.tabSearch[1]}`)],
    ['tab favorites', () => adb.shell(t, `input tap ${TAP.tabFavorites[0]} ${TAP.tabFavorites[1]}`)],
    ['tab profile', () => adb.shell(t, `input tap ${TAP.tabProfile[0]} ${TAP.tabProfile[1]}`)],
    ['tab add', () => adb.shell(t, `input tap ${TAP.tabAdd[0]} ${TAP.tabAdd[1]}`)],
    ['tab home', () => adb.shell(t, `input tap ${TAP.tabHome[0]} ${TAP.tabHome[1]}`)],
  ];
  const s = seq[step % seq.length];
  s[1]();
  return s[0];
}

(async () => {
  const t = adb.device();
  const rig = adb.rig(t);

  if (MODE === 'baseline') {
    adb.shell(t, `am force-stop ${PKG}`);
    await sleep(4000);
    adb.shellSafe(t, 'input keyevent KEYCODE_WAKEUP');
    adb.shell(t, `am start -n ${PKG}/.experience.HomeActivity`);
    await sleep(20000); // let Expo Go's own home screen finish loading
  } else if (MODE === 'app') {
    adb.shell(t, `am force-stop ${PKG}`);
    await sleep(4000);
    adb.shellSafe(t, 'input keyevent KEYCODE_WAKEUP');
    adb.shell(t, launchCommand());
    await sleep(25000); // cold launch settles at ~4.5 s; 25 s is generous
  }

  const readings = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    let activity = null;
    if (MODE === 'session') activity = await scriptedUsage(t, i);
    if (MODE === 'session') await sleep(1500);
    const r = read(t);
    // A silent parse failure is how the first capture of this metric produced 75
    // samples with an empty `rows` object and nobody noticed: the summary
    // printer skipped every distribution with n === 0. Fail loudly instead.
    if (Object.keys(r.rows).length === 0) {
      throw new Error('task3-memory: the per-mapping table did not parse. Refusing to record a sample with no rows.');
    }
    readings.push({ at: Date.now(), activity, ...r });
    process.stderr.write(`  ${LABEL} ${i + 1}/${SAMPLES} pid=${r.pid} TOTAL PSS=${r.totals.totalPssKb} RSS=${r.totals.totalRssKb} java=${r.summary.java_heap && r.summary.java_heap.pssKb} native=${r.summary.native_heap && r.summary.native_heap.pssKb} gfx=${r.summary.graphics && r.summary.graphics.pssKb} code=${r.summary.code && r.summary.code.pssKb} bitmaps=${(r.nativeAllocations.bitmapMalloced || {}).totalKb}+${(r.nativeAllocations.bitmapNonMalloced || {}).totalKb}${activity ? ` after "${activity}"` : ''}\n`);
    if (i < SAMPLES - 1) await sleep(INTERVAL);
  }

  const series = (fn, unit = 'KB') => summarise(readings.map(fn).filter((x) => x !== null && x !== undefined), { unit });
  const payload = {
    label: LABEL, mode: MODE, at: new Date().toISOString(), rig,
    hostLoad: execFileSync('/usr/bin/uptime', { encoding: 'utf8' }).trim(),
    process: PKG,
    expoGoIncluded: PKG === 'host.exp.exponent'
      ? 'The measured process contains the ENTIRE Expo Go runtime as well as this app. There is no standalone build of this project, so the two cannot be separated on this rig. Compare mode=app against mode=baseline for the difference loading the app makes.'
      : `The measured process is ${PKG}, a STANDALONE build of this project — the app's own process. It carries React Native and Hermes, as any React Native app must, but none of Expo Go's host runtime, home screen, updates database or second copy of the RN runtime. No subtraction is needed and none is done.`,
    launchCommand: launchCommand(),
    samples: readings.length,
    warmupDiscarded: 0,
    distributions: {
      totalPssKb: series((r) => r.totals.totalPssKb),
      totalRssKb: series((r) => r.totals.totalRssKb),
      totalSwapPssKb: series((r) => r.totals.totalSwapPssKb),
      summaryJavaHeapPssKb: series((r) => r.summary.java_heap && r.summary.java_heap.pssKb),
      summaryNativeHeapPssKb: series((r) => r.summary.native_heap && r.summary.native_heap.pssKb),
      summaryCodePssKb: series((r) => r.summary.code && r.summary.code.pssKb),
      summaryStackPssKb: series((r) => r.summary.stack && r.summary.stack.pssKb),
      summaryGraphicsPssKb: series((r) => r.summary.graphics && r.summary.graphics.pssKb),
      summaryPrivateOtherPssKb: series((r) => r.summary.private_other && r.summary.private_other.pssKb),
      summarySystemPssKb: series((r) => r.summary.system && r.summary.system.pssKb),
      rowDalvikHeapPssKb: series((r) => r.rows['Dalvik Heap'] && r.rows['Dalvik Heap'].pssKb),
      rowNativeHeapPssKb: series((r) => r.rows['Native Heap'] && r.rows['Native Heap'].pssKb),
      rowApkMmapPssKb: series((r) => r.rows['.apk mmap'] && r.rows['.apk mmap'].pssKb),
      rowDexMmapPssKb: series((r) => r.rows['.dex mmap'] && r.rows['.dex mmap'].pssKb),
      rowEglMtrackPssKb: series((r) => r.rows['EGL mtrack'] && r.rows['EGL mtrack'].pssKb),
      rowGlMtrackPssKb: series((r) => r.rows['GL mtrack'] && r.rows['GL mtrack'].pssKb),
      rowTotalPrivateDirtyKb: series((r) => r.rows.TOTAL && r.rows.TOTAL.privateDirtyKb),
      rowTotalPrivateCleanKb: series((r) => r.rows.TOTAL && r.rows.TOTAL.privateCleanKb),
      rowTotalPssKb: series((r) => r.rows.TOTAL && r.rows.TOTAL.pssKb),
      bitmapTotalKb: series((r) => ((r.nativeAllocations.bitmapMalloced || {}).totalKb || 0) + ((r.nativeAllocations.bitmapNonMalloced || {}).totalKb || 0)),
      views: series((r) => r.objects.views, 'count'),
    },
    readings,
  };
  if (OUT) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(payload, null, 2)); }
  const mib = (kb) => (kb / 1024).toFixed(1);
  console.log(`\n${LABEL} (${MODE}) n=${readings.length}, pid ${readings[0].pid}`);
  for (const [k, v] of Object.entries(payload.distributions)) {
    if (v.n === 0) { console.log(`  ${k.padEnd(28)} NO SAMPLES PARSED — the instrument failed for this row`); continue; }
    console.log(`  ${k.padEnd(28)} min/med/p95/max KB: ${String(v.min).padStart(7)} ${String(v.median).padStart(7)} ${String(v.p95).padStart(7)} ${String(v.max).padStart(7)}   (median ${mib(v.median)} MiB)`);
  }
})();
