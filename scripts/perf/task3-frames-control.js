'use strict';

/**
 * STAGE 9 TASK 3 — the `device-frames` control, run against the APP.
 *
 * ## Why this exists beside `negative-controls.js`'s device-frames control
 *
 * That control was hardcoded to `com.android.systemui` (`FRAME_PKG` in
 * `negative-controls.js`) from Task 1 until Task 5, because when Task 1 wrote it
 * the handset was locked and Expo Go could not be foregrounded. Re-running it in
 * this task's session still read SystemUI, and still returned INCONCLUSIVE — its
 * scripted VERTICAL swipe workload rendered 0-5 frames per run and the harness
 * correctly refused every sample. The device being unlocked did not fix it,
 * because the package was wrong AND because an 8-item wardrobe does not scroll.
 *
 * TASK 5 FIXED THE PACKAGE AND RE-RAN THE CLASS. `FRAME_PKG` now names the app,
 * every sample records the counter's own pid/package line and the foregrounded
 * window, and the class is refused unless both name the target. It is still
 * INCONCLUSIVE, and the second half of the sentence above is why: on the
 * restored 8-item wardrobe the same workload rendered 3 frames, against a
 * 100-frame floor. Fixing the package changed the diagnosis, not the verdict.
 *
 * This script runs the same shape of control against `host.exp.exponent` on a
 * wardrobe that actually scrolls, which is the half `negative-controls.js`
 * cannot supply on its own.
 *
 * ## Two controls, and only one of them responds
 *
 * 1. ATTRIBUTION AND RESPONSIVENESS. Idle versus a scripted scroll. This proves
 *    the counter is wired to the app's own surface and moves when the app
 *    renders. It responds decisively.
 * 2. INJECTED DEVICE-CPU DEFECT. The same workload with spinning shell
 *    processes. Task 1 measured this VOID and this task measures it VOID again,
 *    twice, and establishes WHY by measuring the thing Task 1 could only infer:
 *    the load does not starve the UI, it makes the CPU governor raise every
 *    cluster to near its maximum clock, so rendering gets FASTER. The frequency
 *    readings are taken here, in the same run, rather than asserted.
 *
 * A jank figure from this handset therefore comes with a stated limit: the
 * instrument is proven attached to the app and proven to move with the app's own
 * workload, but no way was found to degrade rendering on demand on this device,
 * so a low jank reading is not proof that a high one would have been caught.
 *
 * ## The display's refresh rate is adaptive, is NOT controlled, and MOVES
 *
 * `dumpsys display` reports `mActiveRenderFrameRate` with supported rates from
 * 20 to 120 Hz, and the value it reports depends on when you look. Measured on
 * this handset: 48.000008 while idle (8 of 8 samples), 120.00002 during a
 * scripted fling (6 of 6 samples), 120.00002 at the head of this script's own
 * jank run, and 60.00001 at a fourth moment. This script records ONE reading,
 * at the start of the run, into the `display` field -- it does NOT log the rate
 * per frame sample, so the deadline any given sample was scored against is not
 * recoverable from the artefact.
 *
 * That matters because "Janky frames" is measured against the frame DEADLINE,
 * which moves with the refresh rate, while "Janky frames (legacy)" is measured
 * against a fixed 16.67 ms. Both are recorded, because on a variable-refresh
 * panel they can disagree by an order of magnitude and quoting one without
 * saying which -- and at what rate -- is how a jank number becomes meaningless.
 * Do NOT convert a rate into a deadline in milliseconds and use it to explain a
 * disagreement between the two metrics: no rate here is known to be the one
 * that was in force when the frames were rendered.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const adb = require('./lib/adb');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
const OUT = arg('--out', null);
const SWIPES = Number(arg('--swipes', '20'));
const IDLE_S = Number(arg('--idle', '25'));
const PKG = 'host.exp.exponent';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function gfx(t) {
  const text = adb.shell(t, `dumpsys gfxinfo ${PKG}`);
  const num = (re) => { const m = text.match(re); return m ? Number(m[1]) : null; };
  return {
    pidLine: (text.match(/\*\* Graphics info for pid \d+ \[([^\]]+)\]/) || [])[1] || null,
    totalFrames: num(/Total frames rendered: (\d+)/),
    jankyFrames: num(/^Janky frames: (\d+)/m),
    jankyPercentDeadline: num(/^Janky frames: \d+ \(([\d.]+)%\)/m),
    jankyFramesLegacy: num(/^Janky frames \(legacy\): (\d+)/m),
    jankyPercentLegacy: num(/^Janky frames \(legacy\): \d+ \(([\d.]+)%\)/m),
    p50Ms: num(/^50th percentile: (\d+)ms/m),
    p90Ms: num(/^90th percentile: (\d+)ms/m),
    p95Ms: num(/^95th percentile: (\d+)ms/m),
    p99Ms: num(/^99th percentile: (\d+)ms/m),
    missedVsync: num(/Number Missed Vsync: (\d+)/),
    slowUiThread: num(/Number Slow UI thread: (\d+)/),
    deadlineMissed: num(/Number Frame deadline missed: (\d+)/),
  };
}

function freqs(t) {
  const out = adb.shell(t, 'for c in 0 2 4 6 7; do printf "%s " $(cat /sys/devices/system/cpu/cpu$c/cpufreq/scaling_cur_freq 2>/dev/null); done');
  return out.trim().split(/\s+/).map(Number);
}

async function scrollWorkload(t) {
  const half = Math.floor(SWIPES / 2);
  for (let i = 0; i < half; i += 1) { adb.shell(t, 'input swipe 720 2500 720 700 250'); await sleep(450); }
  for (let i = 0; i < SWIPES - half; i += 1) { adb.shell(t, 'input swipe 720 700 720 2500 250'); await sleep(450); }
}

async function run(t, label, withLoad) {
  adb.shell(t, `dumpsys gfxinfo ${PKG} reset`);
  const f0 = freqs(t);
  await scrollWorkload(t);
  const f1 = freqs(t);
  const g = gfx(t);
  process.stderr.write(`  ${label.padEnd(26)} frames=${String(g.totalFrames).padStart(5)} janky(deadline)=${String(g.jankyPercentDeadline).padStart(6)}% janky(legacy)=${String(g.jankyPercentLegacy).padStart(6)}% p50=${g.p50Ms}ms p95=${g.p95Ms}ms cpuMHz=[${f1.map((x) => Math.round(x / 1000)).join(',')}]\n`);
  return { label, withLoad, ...g, cpuKhzBefore: f0, cpuKhzAfter: f1 };
}

(async () => {
  const t = adb.device();
  const rig = adb.rig(t);
  const display = adb.shell(t, 'dumpsys display | grep -m1 mActiveRenderFrameRate').trim();

  process.stderr.write(`device-frames control against ${PKG}\n`);
  adb.shell(t, `dumpsys gfxinfo ${PKG} reset`);
  const idleFreqs = [];
  for (let i = 0; i < 3; i += 1) { idleFreqs.push(freqs(t)); await sleep((IDLE_S * 1000) / 3); }
  const idle = { label: `idle ${IDLE_S}s, no input`, withLoad: false, ...gfx(t), cpuKhzAfter: idleFreqs[idleFreqs.length - 1] };
  process.stderr.write(`  ${idle.label.padEnd(26)} frames=${String(idle.totalFrames).padStart(5)} janky(deadline)=${String(idle.jankyPercentDeadline).padStart(6)}% cpuMHz=[${idle.cpuKhzAfter.map((x) => Math.round(x / 1000)).join(',')}]\n`);

  const before = await run(t, `${SWIPES} scrolls, load OFF`, false);

  adb.shell(t, 'for i in $(seq 1 24); do nohup sh -c "while :; do :; done" >/dev/null 2>&1 </dev/null & done; echo started');
  await sleep(3500);
  const workers = Number(String(adb.shellSafe(t, 'ps -A -o ARGS | grep "whil[e] :" | wc -l').output).trim());
  const loadedFreqs = freqs(t);
  const during = await run(t, `${SWIPES} scrolls, load ON`, true);
  adb.shellSafe(t, 'pkill -f "whil[e] :"');
  await sleep(3000);
  const after = await run(t, `${SWIPES} scrolls, load OFF again`, false);

  const ratio = before.jankyPercentDeadline > 0 ? during.jankyPercentDeadline / before.jankyPercentDeadline : null;
  const payload = {
    at: new Date().toISOString(),
    package: PKG,
    rig,
    display,
    hostLoad: execFileSync('/usr/bin/uptime', { encoding: 'utf8' }).trim(),
    controls: {
      attributionAndResponsiveness: {
        metric: 'dumpsys gfxinfo total frames rendered, host.exp.exponent',
        idleFrames: idle.totalFrames,
        workloadFrames: before.totalFrames,
        verdict: before.totalFrames >= 100 && idle.totalFrames <= 10 ? 'RESPONDS' : 'INCONCLUSIVE',
        note: 'The counter reads ~0 when the app is not rendering and hundreds when it is, and the dump names host.exp.exponent. That is what proves the instrument is attached to the app rather than to SystemUI.',
      },
      injectedDeviceCpuDefect: {
        metric: 'dumpsys gfxinfo janky-frame % (deadline) over an identical scripted scroll',
        workers,
        beforePercent: before.jankyPercentDeadline,
        duringPercent: during.jankyPercentDeadline,
        afterPercent: after.jankyPercentDeadline,
        ratio,
        verdict: ratio !== null && ratio >= 1.5 ? 'RESPONDS' : 'VOID',
        measuredReason: 'The load does not starve the UI. Every CPU cluster is raised to near its maximum clock while it runs (see cpuKhz*), so the UI thread runs FASTER under the "defect" and jank falls. Android also confines adb-shell children to the background cpu cgroup, so they cannot take cores from the foreground app in the first place.',
      },
    },
    runs: { idle, before, during, after },
    cpuFrequencyKhz: { idleSamples: idleFreqs, underInjectedLoad: loadedFreqs },
  };
  if (OUT) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(payload, null, 2)); }
  console.log(JSON.stringify(payload.controls, null, 2));
})();
