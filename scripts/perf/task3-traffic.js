'use strict';

/**
 * STAGE 9 TASK 3 — window the proxy's NDJSON against the screen samples.
 *
 * The proxy (`task3-proxy.js`) records the handset's own traffic with host
 * timestamps; the screen instrument (`task3-screen.js`) records each sample's
 * `actionAt` and `exitedAt` with the same clock. Intersecting them answers, per
 * sample: how many requests the grid issued, to which service, and how many
 * bytes actually crossed to the phone.
 *
 * BYTES ARE SUMMED FROM `down` EVENTS, not from Content-Length. Content-Length
 * is what the server SAID; the `down` events are what the socket carried, so the
 * figure includes response headers and is immune to a mis-framed message. This
 * matters because "178 KiB per grid page" is a wire number and must be one.
 *
 *   node scripts/perf/task3-traffic.js --ndjson <f> --screen <f> [--out <f>]
 *   node scripts/perf/task3-traffic.js --ndjson <f> --from <ms> --to <ms>
 */

const fs = require('node:fs');
const path = require('node:path');
const { summarise } = require('./lib/stats');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };

const events = fs.readFileSync(arg('--ndjson'), 'utf8').trim().split('\n')
  .filter(Boolean).map((l) => JSON.parse(l));

function window(from, to) {
  const inRange = events.filter((e) => e.t >= from && e.t <= to);
  const req = inRange.filter((e) => e.ev === 'req');
  const res = inRange.filter((e) => e.ev === 'res');
  const down = inRange.filter((e) => e.ev === 'down');
  const byTag = {};
  for (const tag of ['api', 'minio', 'metro']) {
    const r = req.filter((e) => e.tag === tag);
    byTag[tag] = {
      requests: r.length,
      responseBytesOnWire: down.filter((e) => e.tag === tag).reduce((a, e) => a + e.n, 0),
      contentLengthTotal: res.filter((e) => e.tag === tag).reduce((a, e) => a + (e.length || 0), 0),
      statuses: res.filter((e) => e.tag === tag).reduce((a, e) => { a[e.status] = (a[e.status] || 0) + 1; return a; }, {}),
      paths: r.map((e) => decodeURIComponent(e.path).split('?')[0]),
    };
  }
  const firstReq = req.length ? Math.min(...req.map((e) => e.t)) : null;
  const lastDown = down.length ? Math.max(...down.map((e) => e.t)) : null;
  return {
    from, to,
    totalRequests: req.length,
    totalBytesOnWire: down.reduce((a, e) => a + e.n, 0),
    networkSpanMs: firstReq !== null && lastDown !== null ? lastDown - firstReq : null,
    byTag,
  };
}

const screenFile = arg('--screen', null);
let payload;
if (screenFile) {
  const screen = JSON.parse(fs.readFileSync(screenFile, 'utf8'));
  const perSample = screen.raw.map((s) => ({
    label: s.label,
    settled: s.settled,
    unsettledMs: s.durationMs,
    ...window(s.actionAt, s.exitedAt),
  }));
  const usable = perSample.filter((s) => s.settled);
  payload = {
    screen: path.basename(screenFile),
    ndjson: path.basename(arg('--ndjson')),
    perSample,
    summary: {
      samplesUsed: usable.length,
      apiRequests: summarise(usable.map((s) => s.byTag.api.requests), { unit: 'requests' }),
      minioRequests: summarise(usable.map((s) => s.byTag.minio.requests), { unit: 'requests' }),
      totalBytesOnWire: summarise(usable.map((s) => s.totalBytesOnWire), { unit: 'bytes' }),
      apiBytesOnWire: summarise(usable.map((s) => s.byTag.api.responseBytesOnWire), { unit: 'bytes' }),
      minioBytesOnWire: summarise(usable.map((s) => s.byTag.minio.responseBytesOnWire), { unit: 'bytes' }),
      metroBytesOnWire: summarise(usable.map((s) => s.byTag.metro.responseBytesOnWire), { unit: 'bytes' }),
      networkSpanMs: summarise(usable.map((s) => s.networkSpanMs).filter((x) => x !== null), { unit: 'ms' }),
    },
  };
} else {
  payload = window(Number(arg('--from')), Number(arg('--to')));
}

const out = arg('--out', null);
if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(payload, null, 2)); }
const kib = (b) => (b === null || b === undefined ? 'n/a' : (b / 1024).toFixed(1) + ' KiB');
if (payload.summary) {
  const s = payload.summary;
  console.log(`samples used: ${s.samplesUsed}`);
  console.log(`  API requests per load  min/med/p95/max: ${s.apiRequests.min}/${s.apiRequests.median}/${s.apiRequests.p95}/${s.apiRequests.max}`);
  console.log(`  MinIO requests per load min/med/p95/max: ${s.minioRequests.min}/${s.minioRequests.median}/${s.minioRequests.p95}/${s.minioRequests.max}`);
  console.log(`  API bytes on wire      min/med/p95/max: ${kib(s.apiBytesOnWire.min)}/${kib(s.apiBytesOnWire.median)}/${kib(s.apiBytesOnWire.p95)}/${kib(s.apiBytesOnWire.max)}`);
  console.log(`  MinIO bytes on wire    min/med/p95/max: ${kib(s.minioBytesOnWire.min)}/${kib(s.minioBytesOnWire.median)}/${kib(s.minioBytesOnWire.p95)}/${kib(s.minioBytesOnWire.max)}`);
  console.log(`  Metro bytes on wire    min/med/p95/max: ${kib(s.metroBytesOnWire.min)}/${kib(s.metroBytesOnWire.median)}/${kib(s.metroBytesOnWire.p95)}/${kib(s.metroBytesOnWire.max)}`);
  console.log(`  TOTAL bytes on wire    min/med/p95/max: ${kib(s.totalBytesOnWire.min)}/${kib(s.totalBytesOnWire.median)}/${kib(s.totalBytesOnWire.p95)}/${kib(s.totalBytesOnWire.max)}`);
  console.log(`  network span (first request to last byte) min/med/p95/max ms: ${s.networkSpanMs.min}/${s.networkSpanMs.median}/${s.networkSpanMs.p95}/${s.networkSpanMs.max}`);
  for (const p of payload.perSample) {
    console.log(`   ${p.label} settled=${p.settled} unsettled=${p.unsettledMs === null ? 'n/a' : p.unsettledMs.toFixed(0)}ms api=${p.byTag.api.requests}req/${kib(p.byTag.api.responseBytesOnWire)} minio=${p.byTag.minio.requests}req/${kib(p.byTag.minio.responseBytesOnWire)} metro=${p.byTag.metro.requests}req/${kib(p.byTag.metro.responseBytesOnWire)} span=${p.networkSpanMs}ms`);
  }
} else {
  console.log(JSON.stringify(payload, null, 2));
}
