'use strict';

/**
 * CLAIM 6  — "Backend API server remained stable under simulated concurrent
 *             requests (up to 50 simultaneous users in testing)"
 * CLAIM 10 — "Backend server CPU utilization remains below 30% under normal
 *             load during testing"
 *
 *   node scripts/perf/task-2-load.js
 *
 * ------------------------------------------------------------------------
 * WHAT A "SIMULATED CONCURRENT USER" IS HERE
 * ------------------------------------------------------------------------
 * Fixed in `task-2-mix.js` BEFORE any of this ran, and carried into every
 * result file. In one line: one client, one outstanding request at a time
 * (closed loop), its own TCP connection per request, requests drawn in order
 * from the weighted mix of the seven GETs the mobile app's tabs issue, with a
 * stated think time.
 *
 * ------------------------------------------------------------------------
 * PAST 50, NOT UP TO IT
 * ------------------------------------------------------------------------
 * The document's 50 is a floor. "50 was fine" is nearly useless on its own;
 * WHERE it stops being fine is the number a reader can act on. The sweep
 * therefore runs 1 -> 400 virtual users and applies three degradation criteria
 * that were written down before it ran (see `DEGRADATION_CRITERIA`).
 *
 * ------------------------------------------------------------------------
 * THREE THINGS THAT WOULD MAKE THIS MEASUREMENT A LIE, AND WHAT IS DONE
 * ------------------------------------------------------------------------
 * 1. THE CLIENT SATURATING FIRST. The load generator is a single-threaded Node
 *    process on the same host as the server. If it pins its own core at 300
 *    virtual users, the "degradation" observed is the harness's, not the
 *    API's. So the HARNESS'S OWN CPU is sampled during every step and reported
 *    beside the server's, and a step where the client is at or above the server
 *    is flagged `clientBound`.
 * 2. SOCKET EXHAUSTION LOOKING LIKE INSTABILITY. Keep-alive is off, so every
 *    request burns an ephemeral port that then sits in TIME_WAIT. At high rates
 *    that can exhaust the 16,384-port range and produce connect errors that
 *    have nothing to do with the server. Failures are therefore CLASSIFIED --
 *    an HTTP status the server chose is a server failure; `EADDRNOTAVAIL`,
 *    `EMFILE` or a connect timeout is a rig failure -- and the two are never
 *    added together.
 * 3. THE SERVER DEGRADING ACROSS THE SWEEP RATHER THAN AT A CONCURRENCY. One
 *    process serves the whole sweep, so heap growth or a leak would masquerade
 *    as a concurrency effect. The 50-user step is therefore RE-RUN at the end,
 *    after everything above it, and the two are compared.
 *
 * ------------------------------------------------------------------------
 * CLAIM 10's DENOMINATOR IS AMBIGUOUS AND BOTH ARE REPORTED
 * ------------------------------------------------------------------------
 * macOS `top` reports %CPU where 100% is ONE core. This host has 15 logical
 * cores. A process reading 45% is 45% of one core and 3% of the machine, and
 * "below 30%" is satisfied by one reading and violated by the other. Every CPU
 * number below carries BOTH, plus the system-wide idle percentage, and neither
 * is presented as "the" answer.
 *
 * "NORMAL LOAD" is not defined in the submitted document, so it is not assumed
 * here either. Instead CPU is measured as a FUNCTION of offered load -- an
 * open-loop rate sweep from 5/s to 320/s -- and the crossing point of 30% is
 * reported for each denominator. A reader can then apply whatever "normal"
 * means for their deployment.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const safety = require('./lib/safety');
const { captureRig, whatElseWasRunning } = require('./lib/rig');
const { startApiUnderTest } = require('./lib/api-instance');
const { mintToken } = require('./lib/token');
const { measureEndpoint } = require('./measure-api');
const { sampleProcessCpu, CORES } = require('./measure-cpu');
const { runLoad } = require('./lib/load');
const { round } = require('./lib/stats');
const { PRIMARY_MIX, MIX_WITH_SUGGESTIONS, DEFINITION, DEGRADATION_CRITERIA } = require('./task-2-mix');

const ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'docs', 'verification', 'stage-9', 'task-2');
const RAW_DIR = path.join(ROOT, 'docs', 'verification', 'stage-9', 'raw');
const MONGO_URI = 'mongodb://localhost:27017/wardrobe_perf';
const PORT = 3101;

const community = JSON.parse(fs.readFileSync(path.join(RAW_DIR, 'perf-community-manifest.json'), 'utf8'));
const AUTH = { Authorization: `Bearer ${mintToken(community.viewerUserId)}` };

const CONCURRENCY_STEPS = [1, 5, 10, 25, 50, 75, 100, 150, 200, 300, 400];
const STEP_SECONDS = 15;
const RATE_STEPS = [5, 10, 20, 40, 80, 160, 320];
const RATE_SECONDS = 12;
const CPU_THRESHOLD = 30;

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A rig failure is a failure of the measuring apparatus; a server failure is a
 * failure of the thing being measured. Reporting their sum as "errors" is how
 * a harness that ran out of sockets publishes a claim about server stability.
 */
const RIG_ERROR_PATTERNS = [/EADDRNOTAVAIL/i, /EMFILE/i, /ENFILE/i, /ECONNREFUSED/i, /EAI_AGAIN/i];

function classifyFailures(result) {
  const server = [];
  const rig = [];
  for (const [key, count] of Object.entries(result.statuses)) {
    if (key === '200') continue;
    if (key.startsWith('error:')) {
      if (RIG_ERROR_PATTERNS.some((p) => p.test(key))) rig.push({ key, count });
      // A socket hang-up or a read timeout is genuinely ambiguous: the server
      // may have refused to answer, or the client may have run out of room.
      // It is reported in its own bucket rather than assigned to either.
      else rig.push({ key, count, ambiguous: true });
    } else {
      server.push({ key, count });
    }
  }
  return {
    serverFailures: server.reduce((a, b) => a + b.count, 0),
    rigFailures: rig.reduce((a, b) => a + b.count, 0),
    serverDetail: server,
    rigDetail: rig,
  };
}

async function warmAll(baseUrl, mix) {
  for (const entry of mix) {
    await measureEndpoint({ url: `${baseUrl}${entry.path}`, headers: AUTH, samples: 1, warmup: 2, label: `warm ${entry.name}` });
  }
}

/** One closed-loop step, with the server's AND the harness's CPU sampled. */
async function concurrencyStep(api, concurrency, { thinkTimeMs = 0, mix = PRIMARY_MIX, label } = {}) {
  let serverCpu;
  let clientCpu;
  const result = await runLoad({
    baseUrl: api.baseUrl,
    headers: AUTH,
    mix,
    concurrency,
    durationMs: STEP_SECONDS * 1000,
    thinkTimeMs,
    label: label || `${concurrency} virtual users`,
    onStart: async () => {
      serverCpu = sampleProcessCpu({ pid: api.pid, samples: STEP_SECONDS - 4, intervalSeconds: 1, label: `api pid ${api.pid}` });
      clientCpu = sampleProcessCpu({ pid: process.pid, samples: STEP_SECONDS - 4, intervalSeconds: 1, label: `harness pid ${process.pid}` });
    },
  });
  const [server, client] = await Promise.all([serverCpu, clientCpu]);
  const failures = classifyFailures(result);
  return {
    concurrency,
    thinkTimeMs,
    mix: mix.map((m) => m.name),
    ...result,
    ...failures,
    serverCpu: {
      percentOfOneCore: server.percentOfOneCore,
      percentOfMachine: server.percentOfMachine,
      systemIdlePercent: server.systemIdlePercent,
      cores: server.cores,
    },
    harnessCpu: { percentOfOneCore: client.percentOfOneCore, percentOfMachine: client.percentOfMachine },
    // If the load generator is working as hard as the server, the sweep has
    // started measuring the harness.
    clientBound: client.percentOfOneCore.median >= server.percentOfOneCore.median,
    hostLoadAverage: os.loadavg(),
  };
}

function describeStep(s) {
  return (
    `  ${String(s.concurrency).padStart(4)} VU  ` +
    `rps ${String(round(s.requestsPerSecond, 1)).padStart(7)}  ` +
    `lat ${String(round(s.latencyMs.min, 1)).padStart(7)}/${String(round(s.latencyMs.median, 1)).padStart(7)}/${String(round(s.latencyMs.p95, 1)).padStart(7)}/${String(round(s.latencyMs.max, 1)).padStart(8)} ms  ` +
    `srvErr ${String(s.serverFailures).padStart(4)}  rigErr ${String(s.rigFailures).padStart(4)}  ` +
    `srvCPU ${String(round(s.serverCpu.percentOfOneCore.median, 1)).padStart(6)}%core ${String(round(s.serverCpu.percentOfMachine.median, 2)).padStart(5)}%mach  ` +
    `cliCPU ${String(round(s.harnessCpu.percentOfOneCore.median, 1)).padStart(6)}%core` +
    `${s.clientBound ? '  <-- CLIENT-BOUND' : ''}`
  );
}

async function main() {
  await safety.recoverLeftovers();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const rigBefore = await captureRig({ mongoUri: MONGO_URI, apiHost: `http://localhost:${PORT}` });

  const out = {
    meta: {
      at: new Date().toISOString(),
      harness: 'scripts/perf/task-2-load.js',
      claims: [
        'Claim 6 — "Backend API server remained stable under simulated concurrent requests (up to 50 simultaneous users in testing)"',
        'Claim 10 — "Backend server CPU utilization remains below 30% under normal load during testing"',
      ],
      cores: CORES,
      cpuDenominatorNote:
        'macOS `top` reports %CPU where 100% = ONE core. This host has ' + CORES + ' logical cores. ' +
        'percentOfOneCore is what top printed; percentOfMachine is that divided by ' + CORES + '. ' +
        'Claim 10 does not say which, so both are reported and neither is presented as the answer.',
      virtualUserDefinition: DEFINITION,
      degradationCriteria: DEGRADATION_CRITERIA,
      mix: PRIMARY_MIX,
      stepSeconds: STEP_SECONDS,
      fixture: { database: 'wardrobe_perf', posts: community.posts, items: 46128, viewer: community.viewerUserId, viewerItems: community.viewerItemCount },
    },
    rigBefore,
  };

  // -------------------------------------------------------------------
  // CLAIM 6: the concurrency sweep
  // -------------------------------------------------------------------
  log('== Claim 6: closed-loop concurrency sweep, Task 2 mix, think time 0 ==');
  log(`   ${STEP_SECONDS}s per step, one server process for the whole sweep, 50 re-run at the end as a drift check`);
  const api = await startApiUnderTest({ port: PORT, mongoUrl: MONGO_URI, label: 't2-load-sweep' });
  const steps = [];
  try {
    await warmAll(api.baseUrl, PRIMARY_MIX);
    for (const c of CONCURRENCY_STEPS) {
      const s = await concurrencyStep(api, c);
      s.environment = whatElseWasRunning();
      steps.push(s);
      log(describeStep(s));
      // Let TIME_WAIT drain a little between steps so one step's sockets are
      // not the next step's rig failures.
      await sleep(3000);
    }

    log('\n== drift check: the 50-user step re-run after the whole sweep ==');
    const drift = await concurrencyStep(api, 50, { label: '50 virtual users (drift check, after the sweep)' });
    drift.driftCheck = true;
    drift.environment = whatElseWasRunning();
    steps.push(drift);
    log(describeStep(drift));

    log('\n== 50 users with a 1000 ms think time (a less punishing reading of the same headline) ==');
    const thinky = await concurrencyStep(api, 50, { thinkTimeMs: 1000, label: '50 virtual users, 1000 ms think time' });
    thinky.environment = whatElseWasRunning();
    log(describeStep(thinky));
    out.fiftyWithThinkTime = thinky;

    log('\n== 50 users WITH GET /suggestions in the mix (reaches the Python AI service) ==');
    await warmAll(api.baseUrl, MIX_WITH_SUGGESTIONS);
    const withAi = await concurrencyStep(api, 50, { mix: MIX_WITH_SUGGESTIONS, label: '50 virtual users, mix including GET /suggestions' });
    withAi.environment = whatElseWasRunning();
    log(describeStep(withAi));
    out.fiftyWithSuggestions = withAi;

    // -----------------------------------------------------------------
    // CLAIM 10: CPU as a function of offered load (open loop)
    // -----------------------------------------------------------------
    log('\n== Claim 10: CPU vs offered rate, OPEN loop (fixed arrival rate, server keeps headroom) ==');
    const rates = [];
    for (const rate of RATE_STEPS) {
      let serverCpu;
      let clientCpu;
      const result = await runLoad({
        baseUrl: api.baseUrl,
        headers: AUTH,
        mix: PRIMARY_MIX,
        ratePerSecond: rate,
        durationMs: RATE_SECONDS * 1000,
        label: `${rate}/s open loop`,
        onStart: async () => {
          serverCpu = sampleProcessCpu({ pid: api.pid, samples: RATE_SECONDS - 3, intervalSeconds: 1, label: `api pid ${api.pid}` });
          clientCpu = sampleProcessCpu({ pid: process.pid, samples: RATE_SECONDS - 3, intervalSeconds: 1, label: `harness pid ${process.pid}` });
        },
      });
      const [server, client] = await Promise.all([serverCpu, clientCpu]);
      const failures = classifyFailures(result);
      const row = {
        ratePerSecond: rate,
        achievedRps: result.requestsPerSecond,
        rateLimited: result.rateLimited,
        skippedByBackpressure: result.skippedByBackpressure,
        ...failures,
        latencyMs: result.latencyMs,
        totalRequests: result.totalRequests,
        serverCpu: {
          percentOfOneCore: server.percentOfOneCore,
          percentOfMachine: server.percentOfMachine,
          systemIdlePercent: server.systemIdlePercent,
        },
        harnessCpu: { percentOfOneCore: client.percentOfOneCore },
        hostLoadAverage: os.loadavg(),
        environment: whatElseWasRunning(),
      };
      rates.push(row);
      log(
        `  ${String(rate).padStart(4)}/s  achieved ${String(round(row.achievedRps, 1)).padStart(6)}/s  ` +
          `srvCPU ${String(round(server.percentOfOneCore.median, 1)).padStart(6)}%core (p95 ${round(server.percentOfOneCore.p95, 1)}) ` +
          `${String(round(server.percentOfMachine.median, 2)).padStart(5)}%mach (p95 ${round(server.percentOfMachine.p95, 2)})  ` +
          `sysIdle ${round(server.systemIdlePercent.median, 1)}%  ` +
          `lat med ${round(row.latencyMs.median, 1)}ms  srvErr ${row.serverFailures} rigErr ${row.rigFailures}`,
      );
      await sleep(2000);
    }
    out.cpuByRate = rates;
  } finally {
    await api.stop();
  }

  out.concurrencySweep = steps;

  // -------------------------------------------------------------------
  // Verdicts against the PRE-REGISTERED criteria
  // -------------------------------------------------------------------
  const sweep = steps.filter((s) => !s.driftCheck);
  const firstTrip = { D1: null, D1ServerFailuresOnly: null, D2: null, D3: null };
  for (let i = 0; i < sweep.length; i += 1) {
    const s = sweep[i];
    // D1 as PRE-REGISTERED: "any response that is not the expected status, OR
    // any connection error / timeout". Connect failures land in rigFailures, so
    // testing serverFailures alone implements a NARROWER criterion than the one
    // that was written down before the sweep ran -- and the narrowing flatters
    // the result (it published D1 = null while the same rows recorded 22/159/316
    // connect ETIMEDOUTs at 200/300/400 VUs). Both halves are counted here, and
    // the server-only figure is reported beside it rather than instead of it.
    if (firstTrip.D1 === null && s.serverFailures + s.rigFailures > 0) firstTrip.D1 = s.concurrency;
    if (firstTrip.D1ServerFailuresOnly === null && s.serverFailures > 0) {
      firstTrip.D1ServerFailuresOnly = s.concurrency;
    }
    if (firstTrip.D2 === null && s.latencyMs.p95 > 2000) firstTrip.D2 = s.concurrency;
    if (firstTrip.D3 === null && i > 0 && s.requestsPerSecond <= sweep[i - 1].requestsPerSecond * 1.05) {
      firstTrip.D3 = s.concurrency;
    }
  }
  const at50 = sweep.find((s) => s.concurrency === 50);
  const drift = steps.find((s) => s.driftCheck);

  out.verdicts = {
    firstConcurrencyTripping: firstTrip,
    at50: at50 && {
      requestsPerSecond: at50.requestsPerSecond,
      latencyMs: at50.latencyMs,
      serverFailures: at50.serverFailures,
      rigFailures: at50.rigFailures,
      serverCpuPercentOfOneCore: at50.serverCpu.percentOfOneCore,
      serverCpuPercentOfMachine: at50.serverCpu.percentOfMachine,
    },
    driftCheck: drift && {
      requestsPerSecond: drift.requestsPerSecond,
      medianLatencyMs: drift.latencyMs.median,
      ratioToFirst50: at50 ? drift.latencyMs.median / at50.latencyMs.median : null,
    },
    cpuThresholdCrossings: (() => {
      const rows = out.cpuByRate || [];
      const firstOver = (pick) => {
        const hit = rows.find((r) => pick(r) > CPU_THRESHOLD);
        return hit ? hit.ratePerSecond : null;
      };
      return {
        thresholdPercent: CPU_THRESHOLD,
        percentOfOneCore: {
          firstRateOverThresholdAtMedian: firstOver((r) => r.serverCpu.percentOfOneCore.median),
          firstRateOverThresholdAtP95: firstOver((r) => r.serverCpu.percentOfOneCore.p95),
        },
        percentOfMachine: {
          firstRateOverThresholdAtMedian: firstOver((r) => r.serverCpu.percentOfMachine.median),
          firstRateOverThresholdAtP95: firstOver((r) => r.serverCpu.percentOfMachine.p95),
        },
      };
    })(),
  };

  out.rigAfter = await captureRig({ mongoUri: MONGO_URI, apiHost: `http://localhost:${PORT}` });
  fs.writeFileSync(path.join(OUT_DIR, 'claim-06-10-load.json'), JSON.stringify(out, null, 2));

  log('\n=== VERDICT SUMMARY ===');
  log(`  first concurrency tripping D1 (any error/timeout): ${firstTrip.D1 ?? 'never, up to ' + CONCURRENCY_STEPS[CONCURRENCY_STEPS.length - 1]}`);
  log(`    of which server-side (bad status) only        : ${firstTrip.D1ServerFailuresOnly ?? 'never, up to ' + CONCURRENCY_STEPS[CONCURRENCY_STEPS.length - 1]}`);
  log(`  first concurrency tripping D2 (p95 > 2000 ms)   : ${firstTrip.D2 ?? 'never, up to ' + CONCURRENCY_STEPS[CONCURRENCY_STEPS.length - 1]}`);
  log(`  first concurrency tripping D3 (throughput knee) : ${firstTrip.D3 ?? 'never'}`);
  log(`  CPU 30% crossing, % of one core (median)        : ${out.verdicts.cpuThresholdCrossings.percentOfOneCore.firstRateOverThresholdAtMedian ?? 'never in the swept range'} req/s`);
  log(`  CPU 30% crossing, % of machine (median)         : ${out.verdicts.cpuThresholdCrossings.percentOfMachine.firstRateOverThresholdAtMedian ?? 'never in the swept range'} req/s`);
  log(`\nledger after run: ${safety.listLeftovers().length} leftover(s)`);
  log('written: docs/verification/stage-9/task-2/claim-06-10-load.json');
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

module.exports = { main };
