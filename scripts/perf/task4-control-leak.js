'use strict';

/**
 * STAGE 9 TASK 4 — the capture-path negative control.
 *
 * ## Why a synthetic series is not enough
 *
 * A leak detector that cannot detect a leak is worth nothing, and a flat curve
 * from an instrument that has never been shown a rising one is not evidence.
 * The cheap version of this control feeds a synthetic ramp through the fitting
 * code and confirms it is classified as rising — but that validates the
 * ANALYSER and says nothing about the CAPTURE PATH: the adb shell, the
 * `dumpsys meminfo` row parser, the sampling cadence, and whether the row being
 * trended actually moves when the app's own process allocates. Task 1 learned
 * this distinction the hard way: its `device-settle` control passed as an
 * analyser and failed end to end, and both were reported separately.
 *
 * So this control puts a REAL, GROWING, RETAINED allocation inside
 * `host.exp.exponent` — the very process being sampled — and drives the whole
 * pipeline over it. The injected rate is known, so the result is a CALIBRATION
 * (does the fitted slope recover the injected one?) and not merely a pass.
 *
 * ## Ruling 1: instrumentation must not leak into product code
 *
 * The allocation has to live in the app, because that is the only way to make
 * the app's own process allocate. It is therefore:
 *
 *   - registered in the crash-safe undo ledger BEFORE the file is touched, so a
 *     SIGKILL mid-run leaves a record the next run restores from;
 *   - marked `PERF_CONTROL`, which is one of the tokens the stage's leak grep
 *     searches for, so the patch cannot survive unnoticed;
 *   - removed by this script on completion, with the restore VERIFIED by
 *     comparing the file back against its pristine copy;
 *   - followed by a re-run of the leak grep, which must come back empty.
 *
 * ## The clocks
 *
 * Task 3 found that 24 spinning shells took this handset's big cores from 883
 * MHz to 2,669-3,398 MHz, so an injected CPU defect made rendering faster.
 * Frequency scaling here can invert a defect. This control injects MEMORY, not
 * CPU, precisely to stay out of that trap — but the clocks are recorded at
 * every sample of both the session and the control anyway, and compared, so
 * that "the control ran under different conditions" is a checked statement.
 *
 *   node scripts/perf/task4-control-leak.js --minutes 14 --mib-per-min 2 \
 *        --out docs/verification/stage-9/raw/task4-control-leak.json
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const adb = require('./lib/adb');
const safety = require('./lib/safety');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };

const MINUTES = Number(arg('--minutes', '14'));
const MIB_PER_MIN = Number(arg('--mib-per-min', '2'));
const OUT = arg('--out', null);
const UNLOCK = arg('--unlock-script', null);
const SHOTS = arg('--shots-dir', null);

const ROOT = path.join(__dirname, '..', '..');
const TARGET = path.join(ROOT, 'apps', 'mobile', 'app', '_layout.tsx');
const PKG = 'host.exp.exponent';
const EXP_URL = 'exp://127.0.0.1:8081';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 256 KiB every `intervalMs`, chosen so the ramp is smooth rather than a
// staircase of megabyte steps that would make the fit describe the steps.
const CHUNK_BYTES = 256 * 1024;
const INTERVAL_MS = Math.round((CHUNK_BYTES / (MIB_PER_MIN * 1024 * 1024)) * 60000);

const PATCH = `
// PERF_CONTROL — Stage 9 Task 4 capture-path negative control. NOT PRODUCT CODE.
// A deliberate, growing, retained allocation of ${CHUNK_BYTES} bytes every
// ${INTERVAL_MS} ms (${MIB_PER_MIN} MiB/min), used to prove the memory-trend
// instrument would have detected a leak before a flat curve from it is
// believed. Inserted and removed by scripts/perf/task4-control-leak.js, which
// registers the file in the harness undo ledger before touching it and
// verifies the restore afterwards.
const __perfControlRetained: Uint8Array[] = [];
const __perfControlGlobal = globalThis as unknown as { __perfControlStarted?: boolean };
if (!__perfControlGlobal.__perfControlStarted) {
  __perfControlGlobal.__perfControlStarted = true;
  setInterval(() => {
    const block = new Uint8Array(${CHUNK_BYTES});
    // Touch every page: an untouched allocation may never be faulted in and
    // would not appear in Private Dirty, which would make a working control
    // look like a broken one.
    block.fill(1);
    __perfControlRetained.push(block);
  }, ${INTERVAL_MS});
}
`;

function leakGrep() {
  const r = spawnSync('/usr/bin/grep', ['-rn', 'scripts/perf\\|control-preload\\|PERF_CONTROL', 'apps', 'packages', 'services'], {
    cwd: ROOT, encoding: 'utf8',
  });
  return r.stdout.trim();
}

(async () => {
  await safety.recoverLeftovers();
  const T = adb.device();

  const before = leakGrep();
  if (before) {
    throw new Error(`the instrumentation leak grep is not empty BEFORE this control runs:\n${before}`);
  }

  const pristine = fs.readFileSync(TARGET, 'utf8');
  const guardId = safety.guardFile(TARGET);
  console.log(`  ledger record ${guardId} written before the patch`);

  let result = { patched: false };
  try {
    // Insert after the last import so the module-scope allocation runs on load.
    const lines = pristine.split('\n');
    let lastImport = 0;
    for (let i = 0; i < lines.length; i += 1) if (/^import /.test(lines[i])) lastImport = i;
    const patched = [...lines.slice(0, lastImport + 1), PATCH, ...lines.slice(lastImport + 1)].join('\n');
    fs.writeFileSync(TARGET, patched);
    result.patched = true;
    console.log(`  patched ${path.relative(ROOT, TARGET)}: +${CHUNK_BYTES} bytes retained every ${INTERVAL_MS} ms = ${MIB_PER_MIN} MiB/min`);

    const grepDuring = leakGrep();
    if (!grepDuring.includes('PERF_CONTROL')) {
      throw new Error('the patch is not visible to the leak grep — it would be able to survive unnoticed');
    }
    console.log(`  leak grep DURING the control (expected non-empty): ${grepDuring.split('\n').length} line(s)`);

    // Force-stop and relaunch rather than trusting fast refresh: a cold launch
    // re-bundles from disk, so the bundle under measurement is provably the
    // patched one.
    adb.shell(T, `am force-stop ${PKG}`);
    await sleep(4000);
    adb.shellSafe(T, 'input keyevent KEYCODE_WAKEUP');
    adb.shell(T, `am start -a android.intent.action.VIEW -d "${EXP_URL}" ${PKG}`);
    console.log('  relaunched on the patched bundle, settling 45 s (Metro must re-bundle)');
    await sleep(45000);

    const args = [
      path.join(__dirname, 'task4-session.js'),
      '--minutes', String(MINUTES),
      '--label', 'control-leak',
      '--settle-ms', '0',
    ];
    if (OUT) args.push('--out', OUT);
    if (SHOTS) args.push('--shots-dir', SHOTS, '--shot-every-ms', '300000');
    if (UNLOCK) args.push('--unlock-script', UNLOCK);
    console.log(`  running the SAME session driver over the patched app for ${MINUTES} min\n`);
    const run = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
    result.sessionExit = run.status;
    if (run.status !== 0) throw new Error(`the control session exited ${run.status}`);
  } finally {
    console.log('\n  restoring...');
    const ok = await safety.undo(guardId, { log: (m) => console.log(m) });
    const after = fs.readFileSync(TARGET, 'utf8');
    result.restored = ok && after === pristine;
    console.log(`  ${path.relative(ROOT, TARGET)} byte-identical to its pristine copy: ${after === pristine}`);
    const grepAfter = leakGrep();
    result.leakGrepAfter = grepAfter;
    console.log(`  leak grep AFTER restore (must be empty): ${grepAfter === '' ? 'EMPTY' : `\n${grepAfter}`}`);

    // Put the device back on the pristine bundle so nothing downstream measures
    // a patched app.
    adb.shell(T, `am force-stop ${PKG}`);
    await sleep(3000);
    adb.shellSafe(T, 'input keyevent KEYCODE_WAKEUP');
    adb.shell(T, `am start -a android.intent.action.VIEW -d "${EXP_URL}" ${PKG}`);
    console.log('  relaunched on the pristine bundle');
  }

  console.log(`\ncontrol config: ${JSON.stringify({ mibPerMin: MIB_PER_MIN, chunkBytes: CHUNK_BYTES, intervalMs: INTERVAL_MS, minutes: MINUTES })}`);
  console.log(`restore verified: ${result.restored}, leak grep after: ${result.leakGrepAfter === '' ? 'empty' : 'NOT EMPTY'}`);
  if (OUT) {
    const meta = OUT.replace(/\.json$/, '') + '.control-meta.json';
    fs.writeFileSync(meta, JSON.stringify({ ...result, mibPerMin: MIB_PER_MIN, chunkBytes: CHUNK_BYTES, intervalMs: INTERVAL_MS, minutes: MINUTES, target: path.relative(ROOT, TARGET) }, null, 2));
    console.log(`meta: ${meta}`);
  }
})();
