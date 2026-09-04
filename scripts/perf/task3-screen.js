'use strict';

/**
 * STAGE 9 TASK 3 — the on-device screen instrument for claims 1 and 11.
 *
 * ## Why this does not just call `measure-device.js`'s `measureSettle`
 *
 * MEASURED, not assumed. Android's `screenrecord` is a VARIABLE-frame-rate
 * recorder: it emits a frame only when the surface actually changes. A ten
 * second recording of a completely still screen on this handset produced a
 * 60,832-byte file with a single frame and no duration at all (`ffprobe` reports
 * `duration=N/A`). A five second recording of a screen that moved for four
 * seconds produced a file whose LAST frame is the last change.
 *
 * That breaks `measureSettle`'s validity check, which asks whether at least
 * `quietMs` of recording followed the last change. On a VFR recorder there is
 * never any recorded tail after the last change, so EVERY sample comes back
 * `truncated: true` and every sample would be discarded. The first pilot run of
 * this task discarded 2 of 2 samples for exactly that reason.
 *
 * The corrected check uses WALL time instead of file time. The recorder is
 * spawned with `--time-limit N`, and the host times the spawn and the exit. If
 * the last changing frame sits at PTS `t` and the recorder went on running for
 * at least `quietMarginS` seconds of wall clock after `t` without emitting
 * anything, the screen was still — that is a STRONGER settle proof than a quiet
 * tail of recorded frames, because silence from a VFR recorder is positive
 * evidence of stillness rather than merely uninformative frames.
 *
 * ## The two intervals, kept apart
 *
 *   launchTotalTimeMs  `am start -W`'s own TotalTime: the Android framework's
 *                      measurement of intent to first frame drawn. Cold launch
 *                      only.
 *   unsettledMs        first changing frame to last changing frame. This is the
 *                      interval the screen is still painting — the spinner
 *                      turning, thumbnails filling in.
 *
 * `unsettledMs` EXCLUDES input latency by construction: the recorder does not
 * know when the finger landed. It must never be quoted as "time from tap". For a
 * tap-driven scenario that gap is one input frame and is negligible against a
 * 1.5-4 s claim; for a cold launch it is not, which is why `am start -W` is read
 * as well.
 *
 * ## One transition per recording
 *
 * A recording that contains two transitions measures the gap between them, not
 * either one. The first pilot put a 3.5 s scripted pause between two taps inside
 * one recording and measured 4,056 ms — which is the pause, not the grid. Every
 * scenario here therefore sets its precondition OUTSIDE the recording window.
 *
 * Usage:
 *   node scripts/perf/task3-screen.js --scenario cold|filter|scroll \
 *        --samples 8 --label x --out <json> [--seconds 20] [--threshold 0.5]
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync, spawn } = require('node:child_process');
const adb = require('./lib/adb');
const { summarise } = require('./lib/stats');

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i === -1 ? d : argv[i + 1];
};

const SCENARIO = arg('--scenario', 'filter');
const SAMPLES = Number(arg('--samples', '8'));
const SECONDS = Number(arg('--seconds', SCENARIO === 'cold' ? 25 : 14));
const LABEL = arg('--label', SCENARIO);
const OUT = arg('--out', null);
const THRESHOLD = Number(arg('--threshold', '0.5'));
const QUIET_MARGIN_S = Number(arg('--quiet-margin', '2.0'));
const PREROLL_MS = Number(arg('--preroll', '2000'));
/**
 * An ffmpeg `crop=w:h:x:y` restricting the change analysis to part of the frame.
 *
 * WHY THIS EXISTS, and it is a real finding rather than a convenience. A cold
 * launch measured 11.9 s unsettled with a perfectly still screen from 4.5 s
 * onward — because at about 13.5 s EXPO GO'S OWN "Tools" dev-menu bubble fades
 * out of the top-right corner. Frames extracted at t=8.0 s and t=13.0 s show it
 * present and then gone; it is a development-client affordance and no part of
 * this app. Analysing `crop=1440:2570:0:550` — everything below the navigation
 * header, which is the whole wardrobe screen: title, category chips, grid and
 * tab bar — excludes it. BOTH numbers are reported. Cropping is a judgement
 * call about what belongs to the app, so it is stated, never silently applied.
 */
const CROP = arg('--crop', null);
const KEEP_VIDEO = arg('--keep-video', null);

const PKG = 'host.exp.exponent';
const EXP_URL = 'exp://127.0.0.1:8081';

// Coordinates are for the SM-S948B at 1440x3120 in this app's layout, read off a
// screenshot. Stated because they are a judgement call, not a measurement. A
// first draft of these missed both chips: every tap landed on empty space and
// the run produced "no frames changed" samples that would have read as "the grid
// loads instantly" if they had been believed. Each was then verified by tapping
// it and screenshotting the result before any sample was taken.
const TAP = {
  chipAll: [136, 767],
  chipTshirt: [373, 767],
  tabHome: [144, 2960],
  tabAdd: [720, 2960],
  chooseFromLibrary: [1059, 1010],
  pickerRow1Col1: [234, 1406],
  pickerRow1Col2: [717, 1406],
  pickerRow1Col3: [1200, 1406],
  pickerDone: [1200, 2854],
  addCategoryTshirt: [171, 1342],
  save: [717, 2860],
};

// Which picker thumbnail the `upload` scenario selects. The three sources for
// Claims 2/9/14 were pushed to /sdcard/Pictures in one batch, so they occupy the
// first three cells of the newest-first grid. Verified by screenshotting the
// picker before any sample was taken, not assumed from the push order.
const PICK = arg('--pick', '1');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function frameChangeSeries(videoPath, crop) {
  const vf = (crop ? `crop=${crop},` : '') +
    'tblend=all_mode=difference,signalstats,metadata=print:file=-';
  return new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'info', '-i', videoPath, '-vf', vf, '-an', '-f', 'null', '-'],
      { maxBuffer: 256 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`ffmpeg failed: ${err.message}\n${String(stderr).slice(0, 400)}`));
        const series = [];
        let pending = null;
        for (const line of stdout.split('\n')) {
          const frame = line.match(/pts_time:([\d.]+)/);
          if (frame) { pending = Number(frame[1]); continue; }
          const yavg = line.match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
          if (yavg && pending !== null) { series.push({ t: pending, change: Number(yavg[1]) }); pending = null; }
        }
        resolve(series);
      },
    );
  });
}

/**
 * Record the screen while `action` runs and measure how long it stayed unsettled.
 *
 * @returns settled=false when the last change is within `quietMarginS` of the
 *          recorder's own stop. Such a sample is DISCARDED, never reported: the
 *          screen may still have been moving when the recorder stopped, and a
 *          cut-short recording always produces a flatteringly small number.
 */
async function recordAndMeasure(t, { seconds, action, label }) {
  const devicePath = `/sdcard/t3-${Date.now()}.mp4`;
  const localPath = path.join(os.tmpdir(), path.basename(devicePath));
  const spawnedAt = Date.now();
  const rec = spawn(adb.adbPath(), ['-s', t.id, 'shell', 'screenrecord', '--bit-rate', '8M',
    '--time-limit', String(seconds), devicePath]);
  await sleep(PREROLL_MS);
  const actionAt = Date.now();
  const actionResult = await action();
  const actionDoneAt = Date.now();
  await new Promise((resolve) => rec.once('exit', resolve));
  const exitedAt = Date.now();

  adb.raw(['-s', t.id, 'pull', devicePath, localPath], { stdio: 'pipe' });
  adb.shellSafe(t, `rm -f ${devicePath}`);
  const series = await frameChangeSeries(localPath, null);
  const croppedSeries = CROP ? await frameChangeSeries(localPath, CROP) : null;
  if (KEEP_VIDEO) fs.copyFileSync(localPath, path.join(KEEP_VIDEO, `${label}.mp4`));
  fs.rmSync(localPath, { force: true });

  // The recorder captures for `seconds` of its own clock. The wall interval from
  // spawn to exit is larger (adb round trips, encoder flush, the file pull is
  // after), so `seconds` is the conservative figure to compare a PTS against.
  const recordedSpanS = seconds;
  const reduce = (ser) => {
    const changing = ser.filter((s) => s.change > THRESHOLD);
    const firstChangeT = changing.length ? changing[0].t : null;
    const lastChangeT = changing.length ? changing[changing.length - 1].t : null;
    const quietAfterS = lastChangeT === null ? null : recordedSpanS - lastChangeT;
    return {
      frames: ser.length,
      changingFrames: changing.length,
      firstChangeT,
      lastChangeT,
      quietAfterS,
      durationMs: firstChangeT === null ? null : (lastChangeT - firstChangeT) * 1000,
      settled: quietAfterS !== null && quietAfterS >= QUIET_MARGIN_S,
    };
  };
  const full = reduce(series);
  const cropped = croppedSeries ? reduce(croppedSeries) : null;
  return {
    label,
    spawnedAt,
    actionAt,
    actionDoneAt,
    exitedAt,
    recorderWallMs: exitedAt - spawnedAt,
    actionOffsetMs: actionAt - spawnedAt,
    ...full,
    cropped,
    actionResult,
    series,
    croppedSeries,
  };
}

function coldStart(t) {
  const out = adb.shell(t, `am start -W -a android.intent.action.VIEW -d "${EXP_URL}" ${PKG}`);
  const num = (re) => { const m = out.match(re); return m ? Number(m[1]) : null; };
  return { totalTimeMs: num(/TotalTime: (\d+)/), waitTimeMs: num(/WaitTime: (\d+)/), raw: out.trim() };
}

/** Everything a scenario needs done BEFORE the recorder is spawned. */
async function precondition(t) {
  if (SCENARIO === 'cold') {
    adb.shell(t, `am force-stop ${PKG}`);
    await sleep(4000);
    adb.shellSafe(t, 'input keyevent KEYCODE_WAKEUP');
    await sleep(800);
  } else if (SCENARIO === 'filter') {
    // Leave the grid filtered to one category, so the measured transition is the
    // single "All" tap that repopulates it.
    adb.shell(t, `input tap ${TAP.chipTshirt[0]} ${TAP.chipTshirt[1]}`);
    await sleep(4000);
  } else if (SCENARIO === 'upload') {
    // Everything up to and including choosing the photo and the category is
    // precondition. The MEASURED action is the Save tap alone, because Claim 2
    // is about the upload, not about how long a person spends in a photo picker.
    adb.shell(t, `input tap ${TAP.tabAdd[0]} ${TAP.tabAdd[1]}`);
    await sleep(2500);
    adb.shell(t, `input tap ${TAP.chooseFromLibrary[0]} ${TAP.chooseFromLibrary[1]}`);
    await sleep(5000);
    const cell = PICK === '1' ? TAP.pickerRow1Col1 : PICK === '2' ? TAP.pickerRow1Col2 : TAP.pickerRow1Col3;
    adb.shell(t, `input tap ${cell[0]} ${cell[1]}`);
    await sleep(2500);
    adb.shell(t, `input tap ${TAP.pickerDone[0]} ${TAP.pickerDone[1]}`);
    await sleep(7000);
    adb.shell(t, `input tap ${TAP.addCategoryTshirt[0]} ${TAP.addCategoryTshirt[1]}`);
    await sleep(1500);
  } else if (SCENARIO === 'scroll') {
    adb.shell(t, `input tap ${TAP.chipAll[0]} ${TAP.chipAll[1]}`);
    await sleep(3000);
    for (let k = 0; k < 14; k += 1) { adb.shell(t, 'input swipe 720 700 720 2600 200'); }
    await sleep(3000);
  }
}

async function action(t) {
  if (SCENARIO === 'cold') return coldStart(t);
  if (SCENARIO === 'filter') { adb.shell(t, `input tap ${TAP.chipAll[0]} ${TAP.chipAll[1]}`); return null; }
  if (SCENARIO === 'upload') { adb.shell(t, `input tap ${TAP.save[0]} ${TAP.save[1]}`); return null; }
  if (SCENARIO === 'scroll') {
    for (let k = 0; k < 10; k += 1) {
      adb.shell(t, 'input swipe 720 2600 720 700 200');
      await sleep(450);
    }
    return null;
  }
  return null;
}

(async () => {
  const t = adb.device();
  const rig = adb.rig(t);
  const samples = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    process.stderr.write(`  ${LABEL} ${i + 1}/${SAMPLES}`);
    await precondition(t);
    const s = await recordAndMeasure(t, { seconds: SECONDS, label: `${LABEL}-${i}`, action: () => action(t) });
    process.stderr.write(
      `  unsettled=${s.durationMs === null ? 'n/a' : s.durationMs.toFixed(0)}ms` +
      ` first=${s.firstChangeT === null ? 'n/a' : s.firstChangeT.toFixed(2)}s` +
      ` quietAfter=${s.quietAfterS === null ? 'n/a' : s.quietAfterS.toFixed(2)}s` +
      ` settled=${s.settled} frames=${s.frames}` +
      (s.cropped ? ` | cropped unsettled=${s.cropped.durationMs === null ? 'n/a' : s.cropped.durationMs.toFixed(0)}ms settled=${s.cropped.settled}` : '') +
      (s.actionResult ? ` amStart=${s.actionResult.totalTimeMs}ms` : '') + '\n',
    );
    samples.push(s);
    await sleep(2500);
  }

  const usable = samples.filter((s) => s.settled && s.durationMs !== null);
  const payload = {
    label: LABEL,
    scenario: SCENARIO,
    at: new Date().toISOString(),
    rig,
    hostLoad: execFileSync('/usr/bin/uptime', { encoding: 'utf8' }).trim(),
    method: {
      settleThreshold: THRESHOLD,
      quietMarginSeconds: QUIET_MARGIN_S,
      recordingSeconds: SECONDS,
      prerollMs: PREROLL_MS,
      note: 'unsettledMs = first changing video frame to last changing video frame. Excludes input latency. screenrecord is variable-frame-rate; a sample counts as settled only when the recorder ran at least quietMarginSeconds past the last change without emitting a frame.',
    },
    samples: samples.length,
    discardedNotSettled: samples.length - usable.length,
    unsettledMs: summarise(usable.map((s) => s.durationMs), { unit: 'ms' }),
    crop: CROP,
    unsettledCroppedMs: CROP
      ? summarise(samples.filter((s) => s.cropped && s.cropped.settled).map((s) => s.cropped.durationMs), { unit: 'ms' })
      : null,
    launchTotalTimeMs: samples.some((s) => s.actionResult && s.actionResult.totalTimeMs)
      ? summarise(samples.filter((s) => s.actionResult).map((s) => s.actionResult.totalTimeMs), { unit: 'ms' })
      : null,
    raw: samples.map(({ series, croppedSeries, ...rest }) => rest),
    seriesBySample: samples.map((s) => ({ label: s.label, series: s.series, croppedSeries: s.croppedSeries })),
  };
  if (OUT) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
    process.stderr.write(`written: ${OUT}\n`);
  }
  const u = payload.unsettledMs;
  const f = (x) => (x === null || x === undefined ? 'n/a' : x.toFixed(0));
  process.stdout.write(
    `${LABEL}: unsettled min=${f(u.min)} med=${f(u.median)} p95=${f(u.p95)} max=${f(u.max)} ms n=${u.n}` +
    (payload.unsettledCroppedMs ? `\n${LABEL} (cropped ${CROP}): unsettled min=${f(payload.unsettledCroppedMs.min)} med=${f(payload.unsettledCroppedMs.median)} p95=${f(payload.unsettledCroppedMs.p95)} max=${f(payload.unsettledCroppedMs.max)} ms n=${payload.unsettledCroppedMs.n}` : '') +
    (payload.launchTotalTimeMs ? `  |  am start TotalTime min=${payload.launchTotalTimeMs.min} med=${payload.launchTotalTimeMs.median} p95=${payload.launchTotalTimeMs.p95} max=${payload.launchTotalTimeMs.max} ms` : '') +
    `  |  discarded(not settled)=${payload.discardedNotSettled}\n`,
  );
})();
