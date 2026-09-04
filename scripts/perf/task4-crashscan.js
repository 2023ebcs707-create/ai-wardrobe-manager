'use strict';

/**
 * STAGE 9 TASK 4 — the "without crashes" half of claim 5.
 *
 * A session with zero crashes is a result; a session in which nobody looked for
 * them is not. This scans the full `logcat -b main,crash,system` capture taken
 * across the session for every failure mode that could end an Expo Go session,
 * and PRINTS EVERY CATEGORY whether or not it fired — a scanner that only
 * prints hits is indistinguishable from a scanner that is broken.
 *
 * It also self-tests: `--selftest` feeds each pattern a line it must match, so
 * "no crashes found" is backed by evidence that the patterns can match
 * anything at all. A grep that matches nothing because its regex is wrong looks
 * exactly like a clean session.
 *
 *   node scripts/perf/task4-crashscan.js --log <file> [--pid N] [--json <out>]
 *   node scripts/perf/task4-crashscan.js --selftest
 */

const fs = require('node:fs');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };

const PATTERNS = [
  ['Java/Kotlin fatal', /FATAL EXCEPTION|E AndroidRuntime|AndroidRuntime: \s*Process/, 'FATAL EXCEPTION: main'],
  ['Native fatal signal', /Fatal signal \d+|SIGSEGV|SIGABRT|signal 11 \(SIGSEGV\)/, 'F libc    : Fatal signal 11 (SIGSEGV), code 1'],
  ['Tombstone written', /tombstoned|Tombstone written/, 'I tombstoned: received crash request for pid 1234'],
  ['ANR', /ANR in |Reason: Input dispatching timed out|am_anr/, 'E ActivityManager: ANR in host.exp.exponent'],
  ['Application Not Responding dialog', /Showing ANR dialog|AppNotRespondingDialog/, 'I ActivityManager: Showing ANR dialog for host.exp.exponent'],
  ['Low-memory kill', /lowmemorykiller|LowMemoryKiller|lmkd|am_kill.*(?:cached|empty|foreground)/, 'I lmkd    : Kill \'host.exp.exponent\' (1234), uid 10123'],
  ['Process death / restart', /Process host\.exp\.exponent .* has died|Scheduling restart of crashed service/, 'I ActivityManager: Process host.exp.exponent (pid 1234) has died: fg TOP'],
  ['Java OutOfMemoryError', /OutOfMemoryError|Throwing OutOfMemoryError/, 'E dalvikvm: Throwing OutOfMemoryError'],
  ['JS fatal / red box', /ReactNativeJS.*(?:Error|error:)|ExceptionsManager|RedBox|Unhandled (?:JS Exception|promise rejection)|Invariant Violation/, 'E ReactNativeJS: Error: something blew up'],
  ['Expo Go error screen', /ErrorRecovery|Uncaught Error|ExponentErrorActivity|host\.exp\.exponent.*Error screen/, 'I ExponentErrorActivity: showing error screen'],
  ['GC pressure (context, not a crash)', /Background concurrent copying GC|Clamp target GC heap|Waiting for a blocking GC/, 'I zygote  : Background concurrent copying GC freed 1000(50MB)'],
  ['Skipped frames (context, not a crash)', /Skipped \d+ frames|Choreographer.*Skipped/, 'I Choreographer: Skipped 60 frames!  The application may be doing too much work'],
];

if (argv.includes('--selftest')) {
  let bad = 0;
  for (const [name, re, sample] of PATTERNS) {
    const ok = re.test(sample);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(38)} against: ${sample.slice(0, 70)}`);
    if (!ok) bad += 1;
  }
  console.log(bad === 0 ? '\nCRASHSCAN SELFTEST: PASS — every pattern can match' : `\nCRASHSCAN SELFTEST: ${bad} PATTERN(S) MATCH NOTHING`);
  process.exit(bad === 0 ? 0 : 1);
}

const LOG = arg('--log', null);
const PID = arg('--pid', null);
const JSON_OUT = arg('--json', null);
if (!LOG) throw new Error('--log <file> is required (or --selftest)');

const text = fs.readFileSync(LOG, 'utf8');
const lines = text.split('\n');
console.log(`scanning ${LOG}: ${lines.length} lines, ${(text.length / 1048576).toFixed(1)} MiB`);

const report = {};
for (const [name, re] of PATTERNS) {
  const hits = lines.filter((l) => re.test(l));
  report[name] = { count: hits.length, samples: hits.slice(0, 6) };
  console.log(`  ${String(hits.length).padStart(5)}  ${name}`);
  for (const h of hits.slice(0, 3)) console.log(`         | ${h.trim().slice(0, 160)}`);
}

if (PID) {
  const ours = lines.filter((l) => new RegExp(`\\s${PID}\\s`).test(l));
  console.log(`\nlines mentioning pid ${PID}: ${ours.length}`);
  report.pidLines = ours.length;
}

const fatalCategories = PATTERNS.slice(0, 10).map(([n]) => n);
const fatalTotal = fatalCategories.reduce((a, n) => a + report[n].count, 0);
console.log(`\nFATAL-CLASS HITS (the first ten categories, excluding the two context ones): ${fatalTotal}`);
console.log(fatalTotal === 0
  ? 'No crash, no ANR, no native fatal, no low-memory kill, no JS red box in this capture.'
  : '*** SOMETHING FIRED — see above ***');

if (JSON_OUT) {
  fs.writeFileSync(JSON_OUT, JSON.stringify({ log: LOG, lines: lines.length, fatalTotal, report }, null, 2));
  console.log(`out: ${JSON_OUT}`);
}
