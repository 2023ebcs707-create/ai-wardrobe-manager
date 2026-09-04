'use strict';

/**
 * METRIC CLASS: api-latency and transfer.
 *
 * One procedure produces both, because they come off the same socket: the time
 * from writing the request to reading the last response byte, and the number of
 * octets that crossed the socket in each direction.
 *
 * WARM-UP POLICY. The first `warmup` samples (default 3) are ISSUED and then
 * DISCARDED, and the count is reported beside every number. They are discarded
 * because the first requests against a freshly started server pay costs that no
 * user pays on a running one and that are not what any claim is about:
 *
 *   - ts-node compiles each route module the first time it is reached;
 *   - Mongoose opens its connection pool and builds any missing index;
 *   - the MinIO client fetches the bucket region once and caches it, so the
 *     first signed URL costs a network round trip and later ones cost an HMAC.
 *
 * They are ISSUED rather than skipped so that the discarded cost is actually
 * paid before the retained samples begin. Discarding is stated rather than
 * hidden: the retained figures describe a warm server, and a cold-start number
 * is a different measurement (Claim 12) that this harness takes separately.
 *
 * A run in which any sample returned an unexpected status is NOT summarised.
 * A distribution over failing requests is a measurement of the error path with
 * the successful path's name on it.
 */

const { timedRequest } = require('./lib/http');
const { summarise, formatSummary } = require('./lib/stats');

async function measureEndpoint(options) {
  const {
    url,
    method = 'GET',
    headers = {},
    body = null,
    samples = 25,
    warmup = 3,
    expectStatus = 200,
    label = url,
    pauseMs = 0,
  } = options;

  const observations = [];
  for (let i = 0; i < warmup + samples; i += 1) {
    const res = await timedRequest(url, { method, headers, body });
    observations.push({
      index: i,
      warmup: i < warmup,
      status: res.status,
      ms: res.ms,
      ttfbMs: res.ttfbMs,
      wireBytesRead: res.wireBytesRead,
      wireBytesWritten: res.wireBytesWritten,
      bodyBytes: res.bodyBytes,
      contentLength: res.contentLength,
    });
    if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
  }

  const retained = observations.filter((o) => !o.warmup);
  const wrongStatus = observations.filter((o) => o.status !== expectStatus);

  const result = {
    label,
    url,
    method,
    samples: retained.length,
    warmupDiscarded: warmup,
    expectStatus,
    statuses: observations.reduce((acc, o) => {
      acc[o.status] = (acc[o.status] || 0) + 1;
      return acc;
    }, {}),
    ok: wrongStatus.length === 0,
    observations,
  };

  if (!result.ok) {
    result.error = `${wrongStatus.length}/${observations.length} responses were not ${expectStatus}; not summarised`;
    return result;
  }

  result.latencyMs = summarise(retained.map((o) => o.ms), { warmupDiscarded: warmup, unit: 'ms' });
  result.ttfbMs = summarise(retained.map((o) => o.ttfbMs), { warmupDiscarded: warmup, unit: 'ms' });
  result.responseWireBytes = summarise(retained.map((o) => o.wireBytesRead), { warmupDiscarded: warmup, unit: 'bytes' });
  result.requestWireBytes = summarise(retained.map((o) => o.wireBytesWritten), { warmupDiscarded: warmup, unit: 'bytes' });
  return result;
}

function describe(result) {
  if (!result.ok) return `${result.label}: FAILED -- ${result.error}`;
  return (
    `${result.label}\n` +
    `  latency  ${formatSummary(result.latencyMs)}\n` +
    `  ttfb     ${formatSummary(result.ttfbMs)}\n` +
    `  response ${formatSummary(result.responseWireBytes, 0)}\n` +
    `  request  ${formatSummary(result.requestWireBytes, 0)}`
  );
}

if (require.main === module) {
  const args = require('node:process').argv.slice(2);
  const get = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : args[i + 1];
  };
  const url = get('url');
  if (!url) {
    console.error('usage: node scripts/perf/measure-api.js --url <url> [--token <jwt>] [--samples 25] [--warmup 3]');
    process.exit(2);
  }
  const token = get('token');
  measureEndpoint({
    url,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    samples: Number(get('samples', 25)),
    warmup: Number(get('warmup', 3)),
  }).then((r) => {
    console.log(describe(r));
    process.exit(r.ok ? 0 : 1);
  });
}

module.exports = { measureEndpoint, describe };
