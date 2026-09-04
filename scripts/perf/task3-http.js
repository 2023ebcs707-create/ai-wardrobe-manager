'use strict';

/**
 * STAGE 9 TASK 3 — timed HTTP from the HANDSET, and from the host for comparison.
 *
 * The handset has `/system/bin/curl`. Running it over `adb shell` means curl's
 * own `-w` timings are taken INSIDE the phone, so the adb-shell spawn cost sits
 * outside the measured interval — the number is a real device-side one, not a
 * host-side one relabelled.
 *
 * RULING 2 APPLIES TO EVERY NUMBER THIS PRODUCES. The handset reaches the API
 * through `adb reverse tcp:3000` to a server on the same desk. It is loopback
 * over an adb-forwarded socket: not mobile data, not Wi-Fi to a hosted API. A
 * figure from here is a LOWER BOUND on what a real deployment would show.
 *
 * Warm-up is issued and discarded, not skipped, so its cost is really paid: the
 * default 3 covers `ts-node` compiling a route module on first reach, Mongoose
 * opening its pool, and the MinIO client's one-off bucket-region round trip.
 *
 *   node scripts/perf/task3-http.js --url <url> --token-file <f> --n 25 \
 *        [--where device|host|both] [--warmup 3] [--label x] [--out f]
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const adb = require('./lib/adb');
const { summarise } = require('./lib/stats');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };

const URL = arg('--url');
const N = Number(arg('--n', '25'));
const WARMUP = Number(arg('--warmup', '3'));
const WHERE = arg('--where', 'both');
const LABEL = arg('--label', 'http');
const OUT = arg('--out', null);
const TOKEN = arg('--token-file') ? fs.readFileSync(arg('--token-file'), 'utf8').trim() : null;
const METHOD = arg('--method', 'GET');

const FMT = 'http=%{http_code} dns=%{time_namelookup} conn=%{time_connect} ttfb=%{time_starttransfer} total=%{time_total} size=%{size_download}\\n';

function parse(line) {
  const g = (k) => { const m = line.match(new RegExp(`${k}=([\\d.]+)`)); return m ? Number(m[1]) : null; };
  return { status: g('http'), connectS: g('conn'), ttfbS: g('ttfb'), totalS: g('total'), bytes: g('size') };
}

function onDevice(t) {
  const auth = TOKEN ? `-H 'Authorization: Bearer ${TOKEN}' ` : '';
  const cmd = `curl -s -m 30 -X ${METHOD} -o /dev/null -w '${FMT}' ${auth}'${URL}'`;
  return parse(adb.shell(t, cmd).trim());
}

function onHost() {
  const args = ['-s', '-m', '30', '-X', METHOD, '-o', '/dev/null', '-w', FMT.replace('\\n', '\n')];
  if (TOKEN) args.push('-H', `Authorization: Bearer ${TOKEN}`);
  args.push(URL);
  return parse(execFileSync('/usr/bin/curl', args, { encoding: 'utf8' }).trim());
}

function run(fn, label) {
  const all = [];
  for (let i = 0; i < WARMUP + N; i += 1) all.push({ warmup: i < WARMUP, ...fn() });
  const kept = all.slice(WARMUP);
  const bad = kept.filter((r) => r.status !== 200);
  return {
    label,
    n: kept.length,
    warmupDiscarded: WARMUP,
    // A distribution over failing requests is a measurement of the error path
    // wearing the success path's name. It is reported, never summarised away.
    nonOkResponses: bad.length,
    statuses: kept.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {}),
    totalMs: summarise(kept.map((r) => r.totalS * 1000), { unit: 'ms', warmupDiscarded: WARMUP }),
    ttfbMs: summarise(kept.map((r) => r.ttfbS * 1000), { unit: 'ms', warmupDiscarded: WARMUP }),
    connectMs: summarise(kept.map((r) => r.connectS * 1000), { unit: 'ms', warmupDiscarded: WARMUP }),
    bytes: summarise(kept.map((r) => r.bytes), { unit: 'bytes', warmupDiscarded: WARMUP }),
    samples: all,
  };
}

const results = {};
if (WHERE === 'device' || WHERE === 'both') results.device = run(((t) => () => onDevice(t))(adb.device()), 'handset (adb shell curl, loopback via adb reverse)');
if (WHERE === 'host' || WHERE === 'both') results.host = run(onHost, 'host (127.0.0.1, same machine as the API)');

const payload = {
  label: LABEL,
  url: URL,
  method: METHOD,
  at: new Date().toISOString(),
  hostLoad: execFileSync('/usr/bin/uptime', { encoding: 'utf8' }).trim(),
  connectionPath: 'RULING 2: the handset reaches the API through `adb reverse` to a server on the same desk. Every network number here is a LOOPBACK number, not mobile data and not Wi-Fi to a hosted API.',
  results,
};
if (OUT) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(payload, null, 2)); }

for (const k of Object.keys(results)) {
  const r = results[k];
  const f = (s) => `${s.min.toFixed(1)} / ${s.median.toFixed(1)} / ${s.p95.toFixed(1)} / ${s.max.toFixed(1)}`;
  console.log(`${LABEL} [${k}] ${r.label}`);
  console.log(`   total ms  min/med/p95/max: ${f(r.totalMs)}   n=${r.n} (${r.warmupDiscarded} warm-up discarded)`);
  console.log(`   ttfb  ms  min/med/p95/max: ${f(r.ttfbMs)}`);
  console.log(`   bytes     min/med/p95/max: ${r.bytes.min} / ${r.bytes.median} / ${r.bytes.p95} / ${r.bytes.max}   statuses ${JSON.stringify(r.statuses)}`);
}
