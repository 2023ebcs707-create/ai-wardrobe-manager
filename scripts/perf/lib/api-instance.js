'use strict';

/**
 * Starts an ISOLATED API server for the harness to measure.
 *
 * WHY NOT MEASURE THE DEV SERVER ON PORT 3000. Two reasons, both of which
 * would corrupt the result:
 *
 *   1. The dev API serves the `wardrobe_gate7` database -- the gate fixture,
 *      with two seeded users. Seeding it with a hundred thousand measurement
 *      rows to get a query distribution would destroy the gate evidence, and
 *      measuring against two users' worth of data would answer a different
 *      question from the one the claims ask.
 *   2. A negative control has to be installable and removable, and the only
 *      honest way to install one is to restart the process with it. Restarting
 *      someone else's dev server is not the harness's to do.
 *
 * So the harness starts its own: its own port, its own database, its own
 * process, torn down afterwards and recorded in the crash-safe ledger in case
 * it is not.
 *
 * The command line is the project's own `pnpm dev:api` command with ONE extra
 * `--require` in front of it. Baseline and control runs are the same command;
 * they differ only in the PERF_CONTROL_* environment. Nothing on disk changes
 * between them.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { timedRequest, waitFor } = require('./http');
const safety = require('./safety');

const ROOT = path.join(__dirname, '..', '..', '..');
const API_DIR = path.join(ROOT, 'apps', 'api');
const PRELOAD = path.join(__dirname, '..', 'control-preload.js');

/**
 * Read `.env` ourselves rather than passing `--env-file-if-exists`.
 *
 * `pnpm dev:api` uses `--env-file-if-exists=../../.env`, and that file pins
 * PORT=3000 and MONGO_URL=.../wardrobe. Whether a Node env-file wins over an
 * inherited environment variable is a detail this harness must not depend on:
 * if it wins, the "isolated" instance quietly binds the dev port and serves the
 * dev database. Parsing the file and then overriding explicitly makes the
 * precedence ours and visible.
 */
function readDotEnv() {
  const file = path.join(ROOT, '.env');
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return env;
}

async function startApiUnderTest(options = {}) {
  const {
    port = 3100,
    mongoUrl = 'mongodb://localhost:27017/wardrobe_perf',
    controls = {},
    label = 'baseline',
    logDir = path.join(ROOT, 'docs', 'verification', 'stage-9', 'raw'),
    // `preload: false` starts the server with NO harness code in the process at
    // all -- the exact command `pnpm dev:api` runs. It exists so the harness can
    // measure its own interference: if a number differs between a stock process
    // and one carrying an inert preload, the instrument is changing the thing it
    // measures and its results are worth nothing.
    preload = true,
  } = options;

  fs.mkdirSync(logDir, { recursive: true });
  // Slugified: a label is human prose ("inert preload loaded") and went
  // straight into a filename, producing log files with spaces and backticks in
  // their names that a shell glob then mangles.
  const slug = label.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
  const logPath = path.join(logDir, `api-under-test-${slug}-${Date.now()}.log`);
  const logFd = fs.openSync(logPath, 'a');

  const env = {
    ...readDotEnv(),
    ...process.env,
    PORT: String(port),
    MONGO_URL: mongoUrl,
    PERF_PARENT_PID: String(process.pid),
    PERF_CONTROL_DELAY_MS: String(controls.delayMs ?? 0),
    PERF_CONTROL_INFLATE_BYTES: String(controls.inflateBytes ?? 0),
    PERF_CONTROL_CPU_BURN_MS: String(controls.cpuBurnMs ?? 0),
    PERF_CONTROL_PATH_PREFIX: controls.pathPrefix ?? '',
  };
  // process.env wins over .env above for everything the caller did not set,
  // but PORT/MONGO_URL are set here unconditionally and last.

  const args = preload
    ? ['--require', PRELOAD, '--require', 'ts-node/register', 'src/server.ts']
    : ['--require', 'ts-node/register', 'src/server.ts'];
  const child = spawn(process.execPath, args, { cwd: API_DIR, env, stdio: ['ignore', logFd, logFd] });

  const ledgerId = safety.guardProcess({ pid: child.pid, port, tag: `api-under-test:${label}` });

  const baseUrl = `http://localhost:${port}`;
  try {
    await waitFor(`${baseUrl}/health`, { timeoutMs: 90000 });
  } catch (err) {
    child.kill('SIGKILL');
    await safety.undo(ledgerId);
    throw new Error(`API under test failed to come up on ${port}: ${err.message}\nsee ${logPath}`);
  }

  return {
    pid: child.pid,
    port,
    baseUrl,
    logPath,
    label,
    controls,
    mongoUrl,
    /** What the server itself reports about the controls installed in it. */
    preload,
    async controlState() {
      if (!preload) return { controls: null, applied: null, note: 'started without the harness preload' };
      const res = await timedRequest(`${baseUrl}/__perf/control`);
      return JSON.parse(res.body);
    },
    async stop() {
      await new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      });
      fs.closeSync(logFd);
      await safety.undo(ledgerId);
    },
  };
}

module.exports = { startApiUnderTest, readDotEnv, ROOT, API_DIR, PRELOAD };
