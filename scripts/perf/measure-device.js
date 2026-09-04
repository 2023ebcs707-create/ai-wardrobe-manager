'use strict';

/**
 * DEVICE-SIDE METRIC CLASSES: device-memory, device-frames, device-settle.
 *
 * Everything here reads the handset through `adb` and the platform's own
 * dumps. Nothing here requires a line of code in the app: Ruling 1 says
 * instrumentation must not leak into product source, and the three numbers the
 * Stage 9 claims need on the device -- resident memory, frame timing, and how
 * long a screen takes to settle -- are all obtainable from outside the process.
 *
 *   device-memory  `dumpsys meminfo <pkg|pid>`   -> PSS / RSS / swap, per row
 *   device-frames  `dumpsys gfxinfo <pkg>`       -> janky %, frame percentiles
 *   device-settle  `screenrecord` + ffmpeg       -> time from first visible
 *                                                   response to visually
 *                                                   settled
 *
 * WHAT "SETTLE TIME" MEANS HERE, stated because the definition is the
 * measurement. The recorder gives frames with timestamps and no knowledge of
 * when the tap happened, so this measures from the FIRST FRAME THAT CHANGES
 * after the action to the LAST FRAME THAT CHANGES. It therefore EXCLUDES input
 * latency -- the gap between the finger landing and the first pixel moving --
 * and it must not be quoted as "time from tap". It is the right number for
 * "the dashboard loads within 1.5-2.5 seconds", which is about how long the
 * screen is unsettled, and it is the wrong number for a touch-responsiveness
 * claim.
 */

const { execFile, execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const adb = require('./lib/adb');
const { summarise, formatSummary } = require('./lib/stats');

// --- device-memory ----------------------------------------------------------

/**
 * Parse `dumpsys meminfo`.
 *
 * Two output shapes have to be handled and they are not the same:
 *   - an APP process has an "App Summary" block and a
 *     `TOTAL PSS: n  TOTAL RSS: n  TOTAL SWAP PSS: n` line;
 *   - a plain native process (a shell, for instance) has no App Summary and
 *     its line reads `TOTAL PSS: n  TOTAL RSS: n  TOTAL SWAP (KB): n`.
 * The negative control for this class runs against the second shape, so a
 * parser that only understood the first would report `null` for the control
 * and the control would silently prove nothing.
 */
function parseMeminfo(text) {
  const out = { totalPssKb: null, totalRssKb: null, totalSwapKb: null, summary: {}, pid: null, raw: text };
  const pidMatch = text.match(/MEMINFO in pid (\d+)/);
  if (pidMatch) out.pid = Number(pidMatch[1]);
  const totals = text.match(/TOTAL PSS:\s*(\d+)\s+TOTAL RSS:\s*(\d+)\s+TOTAL SWAP(?: PSS)?(?: \(KB\))?:\s*(\d+)/);
  if (totals) {
    out.totalPssKb = Number(totals[1]);
    out.totalRssKb = Number(totals[2]);
    out.totalSwapKb = Number(totals[3]);
  }
  const summaryBlock = text.match(/App Summary([\s\S]*?)TOTAL PSS:/);
  if (summaryBlock) {
    for (const line of summaryBlock[1].split('\n')) {
      const m = line.match(/^\s*([A-Za-z ]+):\s+(\d+)(?:\s+(\d+))?/);
      if (m) {
        const key = m[1].trim().toLowerCase().replace(/\s+/g, '_');
        out.summary[key] = { pssKb: Number(m[2]), rssKb: m[3] ? Number(m[3]) : null };
      }
    }
  }
  return out;
}

function meminfo(target, packageOrPid) {
  const text = adb.shell(target, `dumpsys meminfo ${packageOrPid}`);
  if (/No process found/.test(text)) throw new Error(`no process on device for ${packageOrPid}`);
  return parseMeminfo(text);
}

/** Sample the same process repeatedly. Nothing is discarded here: the first
 *  reading of a memory total is as valid as the tenth, and a warm-up would
 *  hide exactly the growth a leak claim is about. */
async function sampleMemory({ target, packageOrPid, samples = 10, intervalMs = 1000, label }) {
  const readings = [];
  for (let i = 0; i < samples; i += 1) {
    readings.push({ at: Date.now(), ...meminfo(target, packageOrPid) });
    if (i < samples - 1) await new Promise((r) => setTimeout(r, intervalMs));
  }
  return {
    label: label || `meminfo ${packageOrPid}`,
    packageOrPid,
    samples: readings.length,
    warmupDiscarded: 0,
    totalPssKb: summarise(readings.map((r) => r.totalPssKb), { unit: 'KB' }),
    totalRssKb: summarise(readings.map((r) => r.totalRssKb), { unit: 'KB' }),
    firstSummary: readings[0].summary,
    lastSummary: readings[readings.length - 1].summary,
    readings: readings.map((r) => ({ at: r.at, totalPssKb: r.totalPssKb, totalRssKb: r.totalRssKb })),
  };
}

// --- device-frames ----------------------------------------------------------

/**
 * `graphicsInfoFor` is the dump's own `** Graphics info for pid N [pkg] **`
 * line, carried into the record so a frame number SAYS which process produced
 * it. Its absence is how Stage 9's `device-frames` control measured
 * `com.android.systemui` for four tasks behind a filename that read as the app:
 * the package was a constant at the top of the caller, and nothing in the
 * artefact repeated it back. A number that does not name its subject cannot be
 * audited, only believed.
 */
function parseGfxinfo(text) {
  const num = (re) => {
    const m = text.match(re);
    return m ? Number(m[1]) : null;
  };
  return {
    graphicsInfoFor: (text.match(/\*\* Graphics info for pid (\d+ \[[^\]]+\]) \*\*/) || [])[1] || null,
    totalFrames: num(/Total frames rendered: (\d+)/),
    jankyFrames: num(/Janky frames: (\d+)/),
    jankyPercent: num(/Janky frames: \d+ \(([\d.]+)%\)/),
    p50Ms: num(/^50th percentile: (\d+)ms/m),
    p90Ms: num(/^90th percentile: (\d+)ms/m),
    p95Ms: num(/^95th percentile: (\d+)ms/m),
    p99Ms: num(/^99th percentile: (\d+)ms/m),
    missedVsync: num(/Number Missed Vsync: (\d+)/),
    slowUiThread: num(/Number Slow UI thread: (\d+)/),
    deadlineMissed: num(/Number Frame deadline missed: (\d+)/),
    raw: text,
  };
}

function resetFrames(target, pkg) {
  adb.shell(target, `dumpsys gfxinfo ${pkg} reset`);
}

function readFrames(target, pkg) {
  return parseGfxinfo(adb.shell(target, `dumpsys gfxinfo ${pkg}`));
}

/**
 * The scripted scroll workload. Identical between a baseline run and a control
 * run down to the pixel coordinates and the swipe duration -- a scroll done by
 * hand is not a measurement, it is an anecdote.
 */
function scriptedSwipes(target, { x = 720, fromY = 2200, toY = 200, durationMs = 400, repeats = 3, pauseMs = 1000 } = {}) {
  const issued = [];
  for (let i = 0; i < repeats; i += 1) {
    adb.shell(target, `input swipe ${x} ${toY} ${x} ${fromY} ${durationMs}`);
    execFileSync('/bin/sleep', [String(pauseMs / 1000)]);
    adb.shell(target, `input swipe ${x} ${fromY} ${x} ${toY} ${durationMs}`);
    execFileSync('/bin/sleep', [String(pauseMs / 1000)]);
    issued.push(`swipe pair ${i + 1}`);
  }
  return { swipes: repeats * 2, x, fromY, toY, durationMs, pauseMs };
}

/**
 * Device-side CPU load, the intended negative control for the frame class.
 *
 * MEASURED, AND IT DOES NOT WORK ON THIS HANDSET -- see the Stage 9 Task 1
 * report. Twelve and then twenty-four spinning shell processes reached only
 * ~12% of one core EACH (Android confines `adb shell` children to the
 * background cpu cgroup), leaving six of eight cores free, and SystemUI's jank
 * did not move: 1.91% -> 1.73% -> 1.72% across load-off / load-on / load-off
 * with an identical scripted swipe workload. The function is kept because it
 * is the control a later task should re-run once the app can be foregrounded,
 * and because the negative result is part of the record.
 *
 * IT WAS RE-RUN, TWICE, AND IT STILL DOES NOT WORK — for a reason Task 1 could
 * only infer. Task 3 measured the mechanism directly: the same spinning shells
 * take the big cores from 883 to 2,669-3,398 MHz, so the injected CPU defect
 * makes rendering FASTER on this handset. A defect that improves the metric is
 * not a control. Task 5 fixed `FRAME_PKG` (it was pointed at SystemUI) and
 * re-ran the class against the app: the counter is now correctly attributed and
 * the class is still INCONCLUSIVE. The standing consequence, which every jank
 * figure in Stage 9 carries: a LOW jank number on this handset is evidence of
 * what was measured, and is NOT evidence that a high one would have been caught.
 */
function startDeviceCpuLoad(target, workers = 12) {
  adb.shell(
    target,
    `for i in $(seq 1 ${workers}); do nohup sh -c "while :; do :; done" >/dev/null 2>&1 </dev/null & done; echo started`,
  );
  return {
    workers,
    stop() {
      // `whil[e] :` matches the workers' command line but NOT this pkill's own,
      // because this shell's cmdline contains the literal brackets. Without the
      // trick, pkill kills the shell adb spawned to run it, adb reports exit
      // 143, and the harness treats a successful cleanup as a failed control --
      // which is exactly what happened on the first run of this matrix.
      return adb.shellSafe(target, 'pkill -f "whil[e] :"');
    },
    count() {
      const r = adb.shellSafe(target, 'ps -A -o ARGS | grep "whil[e] :" | wc -l');
      return r.ok ? Number(String(r.output).trim()) : 0;
    },
  };
}

// --- device-settle ----------------------------------------------------------

/**
 * Per-frame change series from a video, via ffmpeg.
 *
 * `tblend=all_mode=difference` produces the absolute difference between each
 * frame and the one before it; `signalstats` then reports that difference
 * frame's mean luma as `lavfi.signalstats.YAVG`. A still screen gives ~0, a
 * screen that is drawing gives a positive number, and the series is what
 * "settled" is defined against. Scene-change detection was not used: it
 * reports a boolean per cut, and a screen that is progressively filling in
 * thumbnails never cuts.
 */
function frameChangeSeries(videoPath) {
  return new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'info', '-i', videoPath, '-vf',
       'tblend=all_mode=difference,signalstats,metadata=print:file=-', '-an', '-f', 'null', '-'],
      { maxBuffer: 256 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`ffmpeg failed: ${err.message}\n${stderr}`));
        const series = [];
        let pending = null;
        for (const line of stdout.split('\n')) {
          const frame = line.match(/pts_time:([\d.]+)/);
          if (frame) {
            pending = Number(frame[1]);
            continue;
          }
          const yavg = line.match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
          if (yavg && pending !== null) {
            series.push({ t: pending, change: Number(yavg[1]) });
            pending = null;
          }
        }
        resolve(series);
      },
    );
  });
}

/**
 * Reduce a change series to "when did the screen stop changing".
 *
 * FIRST DEFINITION, AND WHY IT WAS WRONG. The first version called the screen
 * settled at the FIRST frame above threshold that was followed by five quiet
 * frames. Run against a real recording it reported 107 ms for a workload that
 * visibly moved the screen for 1.4 seconds: real screen activity is punctuated
 * -- a list snaps, pauses for two frames, then carries on -- and "the first
 * pause" is not "the end". That is precisely the failure a negative control
 * exists to catch, and it was caught by one: the measured number did not track
 * an injected change in the workload's duration.
 *
 * THE DEFINITION USED. `settledT` is the LAST frame above threshold, and the
 * result is only valid if the recording ran for at least `quietMs` after it.
 * When it did not, the screen may still have been changing when the recorder
 * stopped, so the sample is marked `truncated` and must be discarded rather
 * than reported -- a truncated recording produces a flatteringly small number.
 *
 * @param {number} threshold mean-luma difference above which a frame counts as
 *                           "still changing". Stated, not tuned: it is reported
 *                           with every result and the whole series is kept, so a
 *                           different threshold can be applied to the same
 *                           recording afterwards without re-recording.
 * @param {number} quietMs   how much stillness must follow for the recording to
 *                           be trusted to have captured the end.
 */
function settleFromSeries(series, { threshold = 0.5, quietMs = 500 } = {}) {
  const changing = series.filter((s) => s.change > threshold);
  const base = { threshold, quietMs, frames: series.length, changingFrames: changing.length };
  if (changing.length === 0) {
    return { ...base, firstChangeT: null, settledT: null, durationMs: null, truncated: false };
  }
  const firstChangeT = changing[0].t;
  const settledT = changing[changing.length - 1].t;
  const lastT = series.length ? series[series.length - 1].t : settledT;
  const quietTailMs = (lastT - settledT) * 1000;
  return {
    ...base,
    firstChangeT,
    settledT,
    durationMs: (settledT - firstChangeT) * 1000,
    quietTailMs,
    truncated: quietTailMs < quietMs,
  };
}

/**
 * Record the screen while `action` runs, pull the file, and measure how long
 * the screen took to settle.
 */
async function measureSettle({ target, action, seconds = 12, bitRate = '8M', workDir = os.tmpdir(), label = 'settle', threshold = 0.5 }) {
  const devicePath = `/sdcard/perf-settle-${Date.now()}.mp4`;
  const localPath = path.join(workDir, path.basename(devicePath));
  const rec = spawn(adb.adbPath(), ['-s', target.id, 'shell', 'screenrecord', '--bit-rate', bitRate, '--time-limit', String(seconds), devicePath]);
  await new Promise((r) => setTimeout(r, 1500)); // let the recorder start
  await action();
  await new Promise((resolve) => rec.once('exit', resolve));
  adb.raw(['-s', target.id, 'pull', devicePath, localPath], { stdio: 'pipe' });
  adb.shell(target, `rm -f ${devicePath}`);
  const series = await frameChangeSeries(localPath);
  return { label, video: localPath, ...settleFromSeries(series, { threshold }), series };
}

module.exports = {
  parseMeminfo,
  meminfo,
  sampleMemory,
  parseGfxinfo,
  resetFrames,
  readFrames,
  scriptedSwipes,
  startDeviceCpuLoad,
  frameChangeSeries,
  settleFromSeries,
  measureSettle,
  formatSummary,
};
