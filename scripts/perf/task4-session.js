'use strict';

/**
 * STAGE 9 TASK 4 — Claim 5, Android half: an extended session of CONTINUOUS
 * USE, with memory sampled throughout and every crash or ANR recorded.
 *
 * > "tested over extended sessions (30+ minutes of continuous use) without
 * >  crashes or memory leaks on both Android and iOS"
 *
 * ## "Continuous use" is the load-bearing phrase, so it is defined here
 *
 * An app left on one screen for thirty minutes would make this claim trivially
 * true and measure nothing. This script drives a fixed, written-down loop of 29
 * actions across every screen the app has — the wardrobe grid and its category
 * filters, an item detail screen, the community feed with its images and its
 * caption search, the favourites gallery and its saved-posts tab, the profile
 * screen, and the add/compose/suggestions screen which puts a request through
 * the Python AI service. One action every `--action-ms`, without pause, for
 * `--minutes`. The loop is the SAME every cycle so that a rise cannot be an
 * artefact of doing more work later in the session than earlier.
 *
 * What the loop deliberately does NOT do: write. No item is saved, renamed,
 * deleted or marked as laundry; no outfit is saved; no post is liked, saved or
 * deleted. `wardrobe_gate7` is at a verified snapshot and this task leaves it
 * there. The two write affordances on the routes it visits — "Mark as in
 * laundry" on the item detail screen and the trash icon on the feed's own post
 * — are avoided by construction, and the item detail screen is left by tapping
 * its own "Back" link rather than by KEYCODE_BACK, because a KEYCODE_BACK that
 * arrives when the detail screen is NOT open pops the tab root and drops the
 * app to the launcher, which would silently turn the rest of the session into a
 * measurement of the home screen.
 *
 * ## Burn-in
 *
 * The user asked that `screen_off_timeout` and `stay_on_while_plugged_in` not
 * be touched, to protect their own handset's OLED panel. This is exactly the
 * situation that constraint exists for: thirty-plus minutes of lit screen. The
 * loop never parks a static bright image — the longest any one screen is shown
 * is four seconds, the screens alternate between light and dark content, and
 * scroll actions move the content within a screen. Neither setting is changed
 * by this script and both are asserted unchanged at the end.
 *
 * ## What is sampled, and why more than one row
 *
 * `TOTAL Private Dirty` is the row Task 3 identified as the strongest
 * app-attributable reading, and it is the row this task trends. `TOTAL PSS` is
 * reported beside it. But this handset runs ZRAM and swaps hard: a dump taken
 * before this session read `Private Dirty 99,984 KB / SWAP PSS 248,288 KB` on
 * the same process Task 3 measured at `Private Dirty 393,416 KB`. Nothing had
 * been freed; 242 MiB of dirty pages had been compressed. Since driving an idle
 * app back into use pages those back in, `Private Dirty` alone can rise steeply
 * for a reason that is not a leak. So `Private Dirty + Swap PSS` is recorded
 * too, and every series is reported. None is picked after the fact.
 *
 * Usage:
 *   node scripts/perf/task4-session.js --minutes 32 --label session \
 *        --out docs/verification/stage-9/task4-session.json [--cold-launch]
 *   node scripts/perf/task4-session.js --dry-run   # one cycle, screenshot each step
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const adb = require('./lib/adb');
const meminfo = require('./lib/meminfo');
const safety = require('./lib/safety');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
const flag = (n) => argv.includes(n);

const MINUTES = Number(arg('--minutes', '32'));
const ACTION_MS = Number(arg('--action-ms', '4000'));
const ACTIONS_PER_SAMPLE = Number(arg('--actions-per-sample', '3'));
const LABEL = arg('--label', 'session');
const OUT = arg('--out', null);
const SHOTS_DIR = arg('--shots-dir', null);
const SHOT_EVERY_MS = Number(arg('--shot-every-ms', '300000'));
const COLD_LAUNCH = flag('--cold-launch');
const SETTLE_MS = Number(arg('--settle-ms', '30000'));
const DRY_RUN = flag('--dry-run');
const UNLOCK = arg('--unlock-script', null);
/**
 * `--idle` runs the same sampler with the interaction loop switched OFF.
 *
 * It exists to test the load-bearing half of the claim from the other side. If
 * a session that is merely LEFT OPEN grows at the same rate as one under
 * continuous use, then the growth is driven by time — Expo Go's own dev-client
 * machinery, a timer, a poll — and the interaction pattern is not what produced
 * it. If it is flat while a driven session climbs, the growth needs use.
 *
 * The only thing it sends is `KEYCODE_WAKEUP`, at most once a minute, which is
 * exactly what the rig's existing keep-awake loop sends: it holds the display
 * on without contributing a frame or a touch, so the screen-timeout settings
 * stay untouched and the run stays genuinely idle. It is deliberately kept
 * under the 5-minute `screen_off_timeout` per wake so the app is never
 * backgrounded mid-run, which would silently change what is being measured.
 */
const IDLE = flag('--idle');

/**
 * STAGE 10 TASK 1 CHANGE — the process under measurement is now a parameter.
 *
 * Stage 9 could only ever measure `host.exp.exponent`, because this project had
 * no standalone Android build; that single fact is why claim 8 was recorded
 * CANNOT BE MEASURED AS STATED and why claim 5's leak half was INCONCLUSIVE.
 * Stage 10 Task 1 builds a real APK, so the app finally has its own process and
 * the same driver has to be able to point at it.
 *
 * The DEFAULTS ARE UNCHANGED. Run this script with no new flags and it does
 * exactly what it did in Stage 9 — same package, same `exp://` launch intent —
 * so every Stage 9 artefact remains reproducible by the command recorded with
 * it. `--pkg` swaps the process; `--launch-activity` gives a standalone build
 * its own launch intent (there is no `exp://` URL to deep-link into an APK).
 */
const PKG = arg('--pkg', 'host.exp.exponent');
const EXP_URL = arg('--launch-url', PKG === 'host.exp.exponent' ? 'exp://127.0.0.1:8081' : '');
const LAUNCH_ACTIVITY = arg('--launch-activity', '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Bring the app under measurement to the foreground.
 *
 * Expo Go is deep-linked with `exp://`, which is how Stage 9 did it and is
 * preserved byte for byte. A standalone build is started through its own
 * launcher activity instead. Both paths go through the same `am start`, so a
 * cold launch and a mid-session re-foreground are the same command in both
 * cases and neither run gets a quieter recovery than the other.
 */
function launchCommand() {
  if (LAUNCH_ACTIVITY) return `am start -n ${LAUNCH_ACTIVITY}`;
  if (EXP_URL) return `am start -a android.intent.action.VIEW -d "${EXP_URL}" ${PKG}`;
  return `monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`;
}

/**
 * Coordinates for the SM-S948B at 1440x3120 in this app's layout, read off
 * screenshots and each one verified by tapping it and screenshotting the
 * result before any sample was taken. Task 3 recorded the same discipline for
 * the same reason: a first draft of its chip coordinates missed both chips, and
 * every tap landing on empty space would have read as "the grid loads
 * instantly" rather than as a broken instrument.
 */
/**
 * STAGE 10 TASK 1 CHANGE — the bottom tab bar's y is a parameter now.
 *
 * The content-area coordinates below (chips at y=766, first tile at 1076, the
 * detail back link, the add/favourites row at y=630) are IDENTICAL between Expo
 * Go and the standalone APK, verified on the running app: the app draws the
 * same layout in both. The one row that moves is the bottom tab bar, because it
 * anchors to the bottom safe-area inset — Expo Go reserves its own chrome there
 * and the standalone build runs edge-to-edge, so the tab bar sits ~80 px lower
 * in the APK. `--tab-y` overrides only that row; it DEFAULTS TO 2960, the Stage
 * 9 value, so every Stage 9 command reproduces unchanged. Calibrated on the APK
 * to 3040 (a Profile-tab tap at 3040 landed on the tab; 2960 would have hit the
 * content above it). One screenshot per cycle step proved every other tap.
 */
const TAB_Y = Number(arg('--tab-y', '2960'));
const TAP = {
  tabHome: [144, TAB_Y],
  tabSearch: [432, TAB_Y],
  tabAdd: [720, TAB_Y],
  tabFavorites: [1008, TAB_Y],
  tabProfile: [1296, TAB_Y],
  chipAll: [139, 766],
  chipTshirt: [363, 766],
  chipShirt: [610, 766],
  chipTrousers: [894, 766],
  firstTile: [267, 1076],
  detailBack: [126, 240],
  searchField: [719, 797],
  favOutfits: [203, 630],
  favSavedPosts: [596, 630],
  addItem: [231, 630],
  addCreateOutfit: [658, 630],
  addSuggestions: [1129, 630],
};

let T = null;
const tap = (p) => adb.shell(T, `input tap ${p[0]} ${p[1]}`);
const swipe = (x1, y1, x2, y2, ms = 300) => adb.shell(T, `input swipe ${x1} ${y1} ${x2} ${y2} ${ms}`);
const key = (k) => adb.shell(T, `input keyevent ${k}`);

function keyboardShown() {
  try {
    return /mInputShown=true/.test(adb.shell(T, 'dumpsys input_method | grep mInputShown'));
  } catch {
    return false;
  }
}

/**
 * KEYCODE_BACK is only ever sent to close the soft keyboard, and only after
 * confirming the keyboard is actually up. A BACK that arrives with no keyboard
 * showing pops the navigation stack instead, and on the tab root that drops the
 * app to the launcher.
 */
function dismissKeyboard() {
  let sent = 0;
  for (let i = 0; i < 2 && keyboardShown(); i += 1) {
    key('KEYCODE_BACK');
    sent += 1;
  }
  return sent;
}

/**
 * The interaction loop, in full. Each entry is [name, screen, action].
 * `screen` is recorded per action so the report can state how the session's
 * time was actually divided, rather than describing an intention.
 */
const CYCLE = [
  ['home.scrollDown', 'wardrobe grid', () => swipe(720, 2200, 720, 1100)],
  ['home.scrollUp', 'wardrobe grid', () => swipe(720, 1100, 720, 2200)],
  ['home.filter.tshirt', 'wardrobe grid', () => tap(TAP.chipTshirt)],
  ['home.filter.trousers', 'wardrobe grid', () => tap(TAP.chipTrousers)],
  ['home.filter.shirt', 'wardrobe grid', () => tap(TAP.chipShirt)],
  ['home.filter.all', 'wardrobe grid', () => tap(TAP.chipAll)],
  ['home.openItem', 'item detail', () => tap(TAP.firstTile)],
  ['detail.scrollDown', 'item detail', () => swipe(720, 2200, 720, 1200)],
  ['detail.scrollUp', 'item detail', () => swipe(720, 1200, 720, 2200)],
  ['detail.back', 'wardrobe grid', () => tap(TAP.detailBack)],
  ['tab.search', 'community feed', () => tap(TAP.tabSearch)],
  ['feed.scrollDown', 'community feed', () => swipe(720, 2200, 720, 1000)],
  ['feed.scrollDown2', 'community feed', () => swipe(720, 2200, 720, 1000)],
  ['feed.scrollUp', 'community feed', () => swipe(720, 1000, 720, 2200)],
  ['feed.scrollUp2', 'community feed', () => swipe(720, 1000, 720, 2200)],
  ['feed.searchFocus', 'community feed (search)', () => tap(TAP.searchField)],
  ['feed.searchType', 'community feed (search)', () => adb.shell(T, 'input text we')],
  ['feed.searchClear', 'community feed (search)', () => {
    tap(TAP.searchField);
    // Eight deletes for a two-character query: if a tap ever misses and the
    // field keeps its text, the next cycle would append to it and the feed
    // would drift into a filter this loop never chose. Over-deleting an empty
    // field is a no-op; under-deleting compounds.
    for (let i = 0; i < 8; i += 1) key('KEYCODE_DEL');
  }],
  ['feed.dismissKeyboard', 'community feed', () => dismissKeyboard()],
  ['tab.favorites', 'favourites', () => tap(TAP.tabFavorites)],
  ['fav.savedPosts', 'favourites (saved posts)', () => tap(TAP.favSavedPosts)],
  ['fav.outfits', 'favourites (outfits)', () => tap(TAP.favOutfits)],
  ['tab.profile', 'profile', () => tap(TAP.tabProfile)],
  ['profile.scrollDown', 'profile', () => swipe(720, 2400, 720, 1400)],
  ['profile.scrollUp', 'profile', () => swipe(720, 1400, 720, 2400)],
  ['tab.add', 'add item', () => tap(TAP.tabAdd)],
  ['add.suggestions', 'suggestions (AI service)', () => tap(TAP.addSuggestions)],
  ['add.createOutfit', 'outfit composer', () => tap(TAP.addCreateOutfit)],
  ['add.addItem', 'add item', () => tap(TAP.addItem)],
  ['tab.home', 'wardrobe grid', () => tap(TAP.tabHome)],
];

// --- observation ------------------------------------------------------------

function cpuFreqs() {
  // Task 3 found that injected CPU load raised this handset's big cores from
  // 883 MHz to 2,669-3,398 MHz, which made an injected defect look like an
  // improvement. Frequency is therefore recorded at every sample, so that any
  // trend can be checked against the clocks rather than assumed independent of
  // them.
  const out = adb.shellSafe(T, 'for c in 0 4 7; do cat /sys/devices/system/cpu/cpu$c/cpufreq/scaling_cur_freq 2>/dev/null || echo -1; done');
  if (!out.ok) return null;
  const v = out.output.trim().split(/\s+/).map(Number);
  return { cpu0: v[0], cpu4: v[1], cpu7: v[2] };
}

function focusWindow() {
  const out = adb.shellSafe(T, 'dumpsys window | grep mCurrentFocus');
  if (!out.ok) return null;
  const m = out.output.match(/mCurrentFocus=Window\{\S+ \S+ (\S+)\}/);
  return m ? m[1] : out.output.trim();
}

function pidOf() {
  const out = adb.shellSafe(T, `pidof ${PKG}`);
  if (!out.ok) return null;
  const p = Number(out.output.trim().split(/\s+/)[0]);
  return Number.isFinite(p) ? p : null;
}

/** A compact index of the system dropbox: one line per entry, timestamp + tag. */
function dropboxIndex() {
  const out = adb.shellSafe(T, 'dumpsys dropbox');
  if (!out.ok) return [];
  return out.output
    .split('\n')
    .map((l) => l.match(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) (\S+) \(/))
    .filter(Boolean)
    .map((m) => `${m[1]} ${m[2]}`);
}

function anrDir() {
  const out = adb.shellSafe(T, 'ls -1 /data/anr/ 2>&1');
  return out.ok ? out.output.trim().split('\n').filter((l) => l && !/Permission denied/.test(l)) : [`UNREADABLE: ${out.output}`];
}

function tombstones() {
  const out = adb.shellSafe(T, 'ls -1 /data/tombstones/ 2>&1');
  return out.ok ? out.output.trim().split('\n').filter((l) => l && !/Permission denied|No such file/.test(l)) : [`UNREADABLE: ${out.output}`];
}

function screenSettings() {
  return {
    screenOffTimeout: adb.shell(T, 'settings get system screen_off_timeout').trim(),
    stayOnWhilePluggedIn: adb.shell(T, 'settings get global stay_on_while_plugged_in').trim(),
  };
}

// --- main -------------------------------------------------------------------

(async () => {
  await safety.recoverLeftovers();
  T = adb.device();
  const rig = adb.rig(T);

  const settingsBefore = screenSettings();
  if (settingsBefore.screenOffTimeout !== '300000' || settingsBefore.stayOnWhilePluggedIn !== '0') {
    throw new Error(`screen settings are not the values this task must preserve: ${JSON.stringify(settingsBefore)}`);
  }

  if (DRY_RUN) {
    const dir = SHOTS_DIR || '/tmp';
    fs.mkdirSync(dir, { recursive: true });
    console.log('DRY RUN — one cycle, a screenshot after every action.');
    for (let i = 0; i < CYCLE.length; i += 1) {
      const [name, screen, fn] = CYCLE[i];
      fn();
      await sleep(2500);
      const shot = path.join(dir, `dry-${String(i).padStart(2, '0')}-${name.replace(/\./g, '_')}.png`);
      fs.writeFileSync(shot, adb.raw(['-s', T.id, 'exec-out', 'screencap', '-p'], { encoding: 'buffer' }));
      console.log(`  ${String(i).padStart(2)} ${name.padEnd(22)} ${screen.padEnd(26)} focus=${focusWindow()}`);
    }
    console.log(`\nshots in ${dir}`);
    return;
  }

  // --- crash/ANR baseline, before a single action -------------------------
  const before = {
    at: new Date().toISOString(),
    dropbox: dropboxIndex(),
    anrFiles: anrDir(),
    tombstones: tombstones(),
    settings: settingsBefore,
  };

  // A fresh logcat, so every line in the capture belongs to this session. All
  // three buffers: `main` carries ReactNativeJS, `crash` carries the Java
  // fatals, `system` carries ActivityManager's "ANR in" and the low-memory
  // killer.
  adb.shellSafe(T, 'logcat -b main,crash,system -c');
  const logPath = OUT ? OUT.replace(/\.json$/, '') + '.logcat.txt' : path.join('/tmp', `task4-${Date.now()}.logcat.txt`);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, 'w');
  const logcat = spawn(adb.adbPath(), ['-s', T.id, 'logcat', '-b', 'main,crash,system', '-v', 'threadtime'], {
    stdio: ['ignore', logFd, 'ignore'],
  });

  if (COLD_LAUNCH) {
    adb.shell(T, `am force-stop ${PKG}`);
    await sleep(4000);
    adb.shellSafe(T, 'input keyevent KEYCODE_WAKEUP');
    adb.shell(T, launchCommand());
    process.stderr.write(`  cold launch, settling ${SETTLE_MS} ms before the first action\n`);
    await sleep(SETTLE_MS);
  }

  const startPid = pidOf();
  const t0 = Date.now();
  const endAt = t0 + MINUTES * 60 * 1000;
  const samples = [];
  const actions = [];
  const events = [];
  let lastShot = 0;
  let shotN = 0;
  let step = 0;

  const takeSample = (afterAction) => {
    const at = Date.now();
    const raw = adb.shell(T, `dumpsys meminfo ${PKG}`);
    const parsed = meminfo.parseStrict(raw, `sample ${samples.length + 1}`);
    const s = meminfo.series(parsed);
    const focus = focusWindow();
    const rec = {
      i: samples.length,
      at,
      minutes: (at - t0) / 60000,
      pid: parsed.pid,
      afterAction,
      focus,
      cpuFreqKHz: cpuFreqs(),
      ...s,
    };
    samples.push(rec);
    if (parsed.pid !== startPid) {
      events.push({ at, kind: 'PID_CHANGED', from: startPid, to: parsed.pid, note: 'the app process died and was restarted during the session' });
    }
    if (!focus || !focus.includes(PKG)) {
      events.push({ at, kind: 'FOCUS_LEFT_APP', focus });
      // Recover: wake, unlock if the device locked, re-foreground. Every
      // recovery is recorded — a session that silently repaired itself would
      // be a session whose interaction pattern is not what this report says.
      adb.shellSafe(T, 'input keyevent KEYCODE_WAKEUP');
      if (UNLOCK && fs.existsSync(UNLOCK)) {
        try {
          execFileSync('/bin/sh', [UNLOCK], { stdio: 'ignore' });
          events.push({ at: Date.now(), kind: 'UNLOCK_SCRIPT_RUN' });
        } catch (err) {
          events.push({ at: Date.now(), kind: 'UNLOCK_SCRIPT_FAILED', error: String(err.message).split('\n')[0] });
        }
      }
      adb.shellSafe(T, launchCommand());
      events.push({ at: Date.now(), kind: 'REFOREGROUNDED' });
    }
    return rec;
  };

  process.stderr.write(`  ${LABEL}: ${MINUTES} min, ${IDLE ? 'IDLE (no interaction; a wake keyevent at most once a minute)' : `one action every ${ACTION_MS} ms`}, a memory sample every ${ACTIONS_PER_SAMPLE} ${IDLE ? 'ticks' : 'actions'}\n`);

  let lastWake = 0;
  while (Date.now() < endAt) {
    const [cycleName, cycleScreen, fn] = CYCLE[step % CYCLE.length];
    const name = IDLE ? 'idle' : cycleName;
    const screen = IDLE ? 'idle (no interaction)' : cycleScreen;
    const at = Date.now();
    let err = null;
    if (IDLE) {
      // The ONLY device command an idle run issues, and only once a minute:
      // a wake keyevent, which holds the display on without a touch or a frame.
      if (at - lastWake >= 60000) {
        adb.shellSafe(T, 'input keyevent KEYCODE_WAKEUP');
        lastWake = at;
      }
    } else {
      try {
        fn();
      } catch (e) {
        err = String(e.message).split('\n')[0];
        events.push({ at, kind: 'ACTION_FAILED', action: name, error: err });
      }
    }
    actions.push({ i: step, at, minutes: (at - t0) / 60000, name, screen, error: err });
    step += 1;

    if (step % ACTIONS_PER_SAMPLE === 0) {
      await sleep(Math.max(0, ACTION_MS - 900));
      const rec = takeSample(name);
      if (samples.length % 10 === 1 || samples.length <= 3) {
        process.stderr.write(
          `  ${LABEL} sample ${String(samples.length).padStart(3)} t=${rec.minutes.toFixed(1)}m pid=${rec.pid} ` +
          `privDirty=${(rec.totalPrivateDirtyKb / 1024).toFixed(1)} +swap=${(rec.privateDirtyPlusSwapKb / 1024).toFixed(1)} ` +
          `PSS=${(rec.totalPssKb / 1024).toFixed(1)} MiB views=${rec.views} cpu7=${rec.cpuFreqKHz && rec.cpuFreqKHz.cpu7}\n`
        );
      }
    } else {
      await sleep(ACTION_MS);
    }

    if (SHOTS_DIR && Date.now() - lastShot >= SHOT_EVERY_MS) {
      lastShot = Date.now();
      fs.mkdirSync(SHOTS_DIR, { recursive: true });
      const p = path.join(SHOTS_DIR, `${LABEL}-t${String(Math.round((Date.now() - t0) / 60000)).padStart(2, '0')}m-${shotN}.png`);
      try {
        fs.writeFileSync(p, adb.raw(['-s', T.id, 'exec-out', 'screencap', '-p'], { encoding: 'buffer' }));
        shotN += 1;
      } catch (e) {
        events.push({ at: Date.now(), kind: 'SCREENSHOT_FAILED', error: String(e.message).split('\n')[0] });
      }
    }
  }

  const t1 = Date.now();
  logcat.kill('SIGTERM');
  await sleep(500);
  fs.closeSync(logFd);

  const after = {
    at: new Date().toISOString(),
    dropbox: dropboxIndex(),
    anrFiles: anrDir(),
    tombstones: tombstones(),
    settings: screenSettings(),
  };
  const endPid = pidOf();

  const payload = {
    label: LABEL,
    claim: 'Claim 5 (Android half): "tested over extended sessions (30+ minutes of continuous use) without crashes or memory leaks"',
    at: new Date(t0).toISOString(),
    durationMinutes: (t1 - t0) / 60000,
    rig,
    hostLoad: execFileSync('/usr/bin/uptime', { encoding: 'utf8' }).trim(),
    network: 'loopback: the device reaches the API and Metro through `adb reverse`, so nothing here measures a real link (Stage 9 Ruling 2)',
    process: PKG,
    expoGoIncluded: PKG === 'host.exp.exponent'
      ? 'The measured process contains the ENTIRE Expo Go runtime as well as this app; there is no standalone build of this project, so the two cannot be separated on this rig.'
      : `The measured process is ${PKG}, a STANDALONE build of this project. It carries React Native and Hermes, as any React Native app must, but it does NOT carry Expo Go's host runtime, home screen, updates database or second copy of the RN runtime. This is the app's own process.`,
    launchCommand: launchCommand(),
    config: { minutes: MINUTES, actionMs: ACTION_MS, actionsPerSample: ACTIONS_PER_SAMPLE, coldLaunch: COLD_LAUNCH, settleMs: SETTLE_MS, idle: IDLE },
    cycle: IDLE ? [{ name: 'idle', screen: 'idle (no interaction)' }] : CYCLE.map(([name, screen]) => ({ name, screen })),
    startPid,
    endPid,
    pidStable: startPid === endPid,
    actions,
    samples,
    events,
    crashWatch: { before, after, logcat: logPath },
  };
  if (OUT) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
  }

  const mib = (kb) => (kb / 1024).toFixed(1);
  console.log(`\n${LABEL}: ${payload.durationMinutes.toFixed(1)} min, ${actions.length} actions, ${samples.length} memory samples`);
  console.log(`  pid ${startPid} -> ${endPid}  ${startPid === endPid ? '(unchanged: the process did not die)' : '*** PROCESS DIED AND RESTARTED ***'}`);
  console.log(`  TOTAL Private Dirty first/last: ${mib(samples[0].totalPrivateDirtyKb)} -> ${mib(samples[samples.length - 1].totalPrivateDirtyKb)} MiB`);
  console.log(`  +Swap PSS      first/last: ${mib(samples[0].privateDirtyPlusSwapKb)} -> ${mib(samples[samples.length - 1].privateDirtyPlusSwapKb)} MiB`);
  console.log(`  TOTAL PSS      first/last: ${mib(samples[0].totalPssKb)} -> ${mib(samples[samples.length - 1].totalPssKb)} MiB`);
  console.log(`  events: ${events.length ? JSON.stringify(events) : 'none'}`);
  console.log(`  new dropbox entries: ${after.dropbox.filter((d) => !before.dropbox.includes(d)).length}`);
  console.log(`  new /data/anr files: ${after.anrFiles.filter((d) => !before.anrFiles.includes(d)).length}`);
  console.log(`  logcat: ${logPath}`);
  console.log(`  screen settings before/after: ${JSON.stringify(before.settings)} / ${JSON.stringify(after.settings)}`);
  if (OUT) console.log(`  out: ${OUT}`);
})();
