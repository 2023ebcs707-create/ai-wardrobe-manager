'use strict';

/**
 * A FOCUSED RE-RUN OF THE HIGH-CONCURRENCY STEPS, to answer one question the
 * main sweep could not: WHAT are the connection failures at 200+ virtual
 * users?
 *
 * The first sweep recorded them as the bare string "AggregateError", which is
 * what `String(err)` gives for Node's happy-eyeballs connect failure. That
 * string is compatible with two opposite conclusions -- the SERVER refusing
 * connections (a real stability limit) or the CLIENT running out of ephemeral
 * ports with keep-alive off (an artefact of the measuring apparatus). Claim 6's
 * degradation point depends on which, so `lib/load.js` now unwraps
 * `err.errors[].code` and these steps are re-run to read them.
 *
 * Also recorded: the host's TIME_WAIT socket count before and after each step,
 * because port exhaustion is a fact about that number and not an inference.
 *
 *   node scripts/perf/task-2-highload.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const safety = require('./lib/safety');
const { captureRig, whatElseWasRunning } = require('./lib/rig');
const { startApiUnderTest } = require('./lib/api-instance');
const { mintToken } = require('./lib/token');
const { measureEndpoint } = require('./measure-api');
const { sampleProcessCpu } = require('./measure-cpu');
const { runLoad } = require('./lib/load');
const { round } = require('./lib/stats');
const { PRIMARY_MIX, DEFINITION } = require('./task-2-mix');

const ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'docs', 'verification', 'stage-9', 'task-2');
const RAW_DIR = path.join(ROOT, 'docs', 'verification', 'stage-9', 'raw');
const MONGO_URI = 'mongodb://localhost:27017/wardrobe_perf';
const PORT = 3101;
const STEPS = [150, 200, 300, 400, 600];
const KEEPALIVE_STEPS = [200, 400, 600];
const STEP_SECONDS = 15;

const community = JSON.parse(fs.readFileSync(path.join(RAW_DIR, 'perf-community-manifest.json'), 'utf8'));
const AUTH = { Authorization: `Bearer ${mintToken(community.viewerUserId)}` };
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** How many sockets the host is holding in TIME_WAIT right now. */
function timeWaitCount() {
  try {
    const out = execFileSync('/bin/sh', ['-c', "netstat -an -p tcp | grep -c TIME_WAIT"], { encoding: 'utf8' });
    return Number(out.trim());
  } catch {
    return null;
  }
}

async function main() {
  await safety.recoverLeftovers();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const rigBefore = await captureRig({ mongoUri: MONGO_URI, apiHost: `http://localhost:${PORT}` });

  const api = await startApiUnderTest({ port: PORT, mongoUrl: MONGO_URI, label: 't2-highload' });
  const rows = [];
  try {
    for (const entry of PRIMARY_MIX) {
      await measureEndpoint({ url: `${api.baseUrl}${entry.path}`, headers: AUTH, samples: 1, warmup: 2, label: `warm ${entry.name}` });
    }
    for (const c of STEPS) {
      const twBefore = timeWaitCount();
      let serverCpu;
      const result = await runLoad({
        baseUrl: api.baseUrl, headers: AUTH, mix: PRIMARY_MIX, concurrency: c,
        durationMs: STEP_SECONDS * 1000, thinkTimeMs: 0, label: `${c} virtual users`,
        onStart: async () => {
          serverCpu = sampleProcessCpu({ pid: api.pid, samples: STEP_SECONDS - 4, intervalSeconds: 1, label: `api pid ${api.pid}` });
        },
      });
      const cpu = await serverCpu;
      const twAfter = timeWaitCount();
      const row = {
        concurrency: c,
        requestsPerSecond: result.requestsPerSecond,
        totalRequests: result.totalRequests,
        okRequests: result.okRequests,
        statuses: result.statuses,
        latencyMs: result.latencyMs,
        serverCpuPercentOfOneCore: cpu.percentOfOneCore,
        serverCpuPercentOfMachine: cpu.percentOfMachine,
        timeWaitBefore: twBefore,
        timeWaitAfter: twAfter,
        hostLoadAverage: os.loadavg(),
        environment: whatElseWasRunning(),
      };
      rows.push(row);
      const errKeys = Object.entries(result.statuses).filter(([k]) => k !== '200');
      log(
        `  ${String(c).padStart(4)} VU  rps ${String(round(result.requestsPerSecond, 1)).padStart(6)}  ` +
          `lat ${round(result.latencyMs.median, 1)}/${round(result.latencyMs.p95, 1)}/${round(result.latencyMs.max, 1)} ms  ` +
          `TIME_WAIT ${twBefore} -> ${twAfter}  ` +
          `non-200: ${errKeys.length ? errKeys.map(([k, v]) => `${k} x${v}`).join(', ') : 'none'}`,
      );
      await sleep(5000);
    }
  } finally {
    await api.stop();
  }

  // -------------------------------------------------------------------
  // THE DECIDING EXPERIMENT: the same load with CONNECTION REUSE.
  //
  // If the ETIMEDOUTs above are the accept queue overflowing under
  // one-connection-per-request churn (this host's kern.ipc.somaxconn is 128),
  // they must largely disappear when the same number of virtual users reuse
  // their connections -- because the server then accepts N sockets once instead
  // of ~200 per second forever. If they do NOT disappear, the limit is the
  // server's ability to serve concurrent requests and the first result stands
  // as a server finding.
  // -------------------------------------------------------------------
  log('\n== the same steps with KEEP-ALIVE ON (transfer bytes are not read from these runs) ==');
  const keepAliveRows = [];
  const api2 = await startApiUnderTest({ port: PORT, mongoUrl: MONGO_URI, label: 't2-highload-keepalive' });
  try {
    for (const entry of PRIMARY_MIX) {
      await measureEndpoint({ url: `${api2.baseUrl}${entry.path}`, headers: AUTH, samples: 1, warmup: 2, label: `warm ${entry.name}` });
    }
    for (const c of KEEPALIVE_STEPS) {
      const twBefore = timeWaitCount();
      let serverCpu;
      const result = await runLoad({
        baseUrl: api2.baseUrl, headers: AUTH, mix: PRIMARY_MIX, concurrency: c,
        durationMs: STEP_SECONDS * 1000, thinkTimeMs: 0, keepAlive: true,
        label: `${c} virtual users, keep-alive on`,
        onStart: async () => {
          serverCpu = sampleProcessCpu({ pid: api2.pid, samples: STEP_SECONDS - 4, intervalSeconds: 1, label: `api pid ${api2.pid}` });
        },
      });
      const cpu = await serverCpu;
      const twAfter = timeWaitCount();
      const row = {
        concurrency: c, keepAlive: true,
        requestsPerSecond: result.requestsPerSecond,
        totalRequests: result.totalRequests, okRequests: result.okRequests,
        statuses: result.statuses, latencyMs: result.latencyMs,
        serverCpuPercentOfOneCore: cpu.percentOfOneCore,
        serverCpuPercentOfMachine: cpu.percentOfMachine,
        timeWaitBefore: twBefore, timeWaitAfter: twAfter,
        hostLoadAverage: os.loadavg(), environment: whatElseWasRunning(),
      };
      keepAliveRows.push(row);
      const errKeys = Object.entries(result.statuses).filter(([k]) => k !== '200');
      log(
        `  ${String(c).padStart(4)} VU (keep-alive)  rps ${String(round(result.requestsPerSecond, 1)).padStart(6)}  ` +
          `lat ${round(result.latencyMs.median, 1)}/${round(result.latencyMs.p95, 1)}/${round(result.latencyMs.max, 1)} ms  ` +
          `TIME_WAIT ${twBefore} -> ${twAfter}  ` +
          `non-200: ${errKeys.length ? errKeys.map(([k, v]) => `${k} x${v}`).join(', ') : 'none'}`,
      );
      await sleep(5000);
    }
  } finally {
    await api2.stop();
  }

  const payload = {
    meta: {
      at: new Date().toISOString(),
      harness: 'scripts/perf/task-2-highload.js',
      purpose: 'classify the connection failures the main sweep recorded as bare "AggregateError" at 200+ virtual users',
      virtualUserDefinition: DEFINITION,
      keepAlive: false,
      ephemeralPortRange: '49152-65535 (16,384 ports); with keep-alive off every request burns one and it sits in TIME_WAIT afterwards',
    },
    rigBefore,
    rows,
    keepAliveRows,
    somaxconn: (() => { try { return execFileSync('/usr/sbin/sysctl', ['-n', 'kern.ipc.somaxconn'], { encoding: 'utf8' }).trim(); } catch { return null; } })(),
    nodeListenBacklogDefault: 511,
    rigAfter: await captureRig({ mongoUri: MONGO_URI, apiHost: `http://localhost:${PORT}` }),
  };
  fs.writeFileSync(path.join(OUT_DIR, 'claim-06-highload-errors.json'), JSON.stringify(payload, null, 2));
  log(`\nledger after run: ${safety.listLeftovers().length} leftover(s)`);
  log('written: docs/verification/stage-9/task-2/claim-06-highload-errors.json');
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
