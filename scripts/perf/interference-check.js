'use strict';

/**
 * Does the harness change the thing it measures?
 *
 * Every negative control in this harness is installed by loading
 * `control-preload.js` with `node --require` in front of the API's own entry
 * point. That preload wraps `http.createServer`'s handler even when no control
 * is switched on, and it answers `GET /__perf/control`. If that wrapper cost
 * anything measurable, then the "baseline" half of every control would be a
 * measurement of the harness rather than of the server, and the whole matrix
 * would be comparing two instrumented systems.
 *
 * So: the same endpoint, measured the same way, against a process carrying the
 * inert preload and against a process running the EXACT command `pnpm dev:api`
 * runs, with nothing of this harness inside it.
 *
 *   node scripts/perf/interference-check.js
 */

const fs = require('node:fs');
const path = require('node:path');
const safety = require('./lib/safety');
const { startApiUnderTest } = require('./lib/api-instance');
const { mintToken } = require('./lib/token');
const { measureEndpoint } = require('./measure-api');
const { formatSummary, round } = require('./lib/stats');

const OUT_DIR = path.join(__dirname, '..', '..', 'docs', 'verification', 'stage-9');
const RAW_DIR = path.join(OUT_DIR, 'raw');
const MONGO_URI = 'mongodb://localhost:27017/wardrobe_perf';
const PORT = 3100;

async function measureWith(preload, label, headers) {
  const api = await startApiUnderTest({ port: PORT, mongoUrl: MONGO_URI, label, preload });
  try {
    return await measureEndpoint({
      url: `${api.baseUrl}/items?limit=24`,
      headers,
      samples: 25,
      warmup: 3,
      label,
    });
  } finally {
    await api.stop();
  }
}

async function main() {
  await safety.recoverLeftovers();
  const manifest = JSON.parse(fs.readFileSync(path.join(RAW_DIR, 'perf-db-manifest.json'), 'utf8'));
  const headers = { Authorization: `Bearer ${mintToken(manifest.largeWardrobeUserId)}` };

  const stock = await measureWith(false, 'no-preload (stock `pnpm dev:api` command)', headers);
  const instrumented = await measureWith(true, 'inert preload loaded', headers);

  const ratio = instrumented.latencyMs.median / stock.latencyMs.median;
  const result = {
    at: new Date().toISOString(),
    stock: stock.latencyMs,
    instrumented: instrumented.latencyMs,
    medianRatio: round(ratio, 3),
    stockBytes: stock.responseWireBytes,
    instrumentedBytes: instrumented.responseWireBytes,
    bytesIdentical: stock.responseWireBytes.median === instrumented.responseWireBytes.median,
  };
  fs.writeFileSync(path.join(RAW_DIR, 'interference-check.json'), JSON.stringify({ result, stock, instrumented }, null, 2));

  console.log(`\nstock process        ${formatSummary(stock.latencyMs)}`);
  console.log(`with inert preload   ${formatSummary(instrumented.latencyMs)}`);
  console.log(`median ratio         ${result.medianRatio}x`);
  console.log(`response bytes identical: ${result.bytesIdentical} (${stock.responseWireBytes.median} vs ${instrumented.responseWireBytes.median})`);
  console.log(`\nwritten: docs/verification/stage-9/raw/interference-check.json`);
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
