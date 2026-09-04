'use strict';

/**
 * STAGE 9 TASK 3 — Claim 12, the AI service's cold start.
 *
 * "The Python-based AI service has a cold-start latency of 3-5 seconds when
 * invoked after a period of inactivity."
 *
 * THAT SENTENCE NAMES THREE DIFFERENT QUANTITIES and they do not have the same
 * value, so each is measured and labelled rather than one being picked:
 *
 *   A. containerStartToHealthMs   `podman start` to the first 200 on /health.
 *      This is the Python interpreter, the FastAPI import graph and torch being
 *      imported. It is paid BEFORE uvicorn binds its socket, so no HTTP caller
 *      can ever observe it as request latency — a request sent during it is
 *      refused, not queued.
 *   B. firstTagAfterStartMs       the first POST /tag on a process whose model
 *      has never been loaded. `services/ai/app/main.py` deliberately does not
 *      preload; `classifier._classifier_bundle` is populated on first use. THIS
 *      is the only interval a caller actually waits through, and it is the
 *      honest reading of "cold-start latency ... when invoked".
 *   C. idleThenInvokeMs           a request after a long quiet period on a
 *      process that is already warm. The document's "after a period of
 *      inactivity" implies this is slow. Nothing in this deployment discards the
 *      model after inactivity, so the prediction is that it is not — and a
 *      prediction is not a result, so it is measured.
 *
 * `POST /suggest` is measured alongside every one of them because Claim 3 is
 * about the RULE ENGINE, which `app/suggest.py` implements with no model at all.
 * If /suggest were ever slow on a cold process, the two claims would interact.
 *
 * Modes:
 *   --mode resident   measure B and the warm tail on the container as it stands
 *                     (requires model_loaded:false; refuses otherwise, because a
 *                     "cold" call against a loaded model is just a warm call)
 *   --mode restart    stop and start the container N times, measuring A and B
 *                     each time — the only way to get a DISTRIBUTION for a
 *                     quantity that can be observed once per process life
 *   --mode idle       measure C: report how long the service has been quiet,
 *                     then invoke
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };

const MODE = arg('--mode', 'resident');
const ROUNDS = Number(arg('--rounds', '4'));
const OUT = arg('--out', null);
const AI = 'http://localhost:8000';
const CONTAINER = 'ai-wardrobe-manager-ai-1';
const IMAGE = arg('--image', 'services/ai/tests/fixtures/jacket-0.jpg');
const SUGGEST_BODY = arg('--suggest-body');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

function curlTimed(args) {
  const t0 = process.hrtime.bigint();
  let out; let ok = true;
  try { out = sh('/usr/bin/curl', ['-s', '-m', '60', '-o', '/dev/null', '-w', '%{http_code}', ...args]); }
  catch (e) { ok = false; out = String(e.status); }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, status: Number(out), ok: ok && Number(out) === 200 };
}

const tag = () => curlTimed(['-X', 'POST', '-F', `image=@${IMAGE}`, `${AI}/tag`]);
const suggest = () => curlTimed(['-X', 'POST', '-H', 'Content-Type: application/json', '--data', `@${SUGGEST_BODY}`, `${AI}/suggest`]);
const health = () => { try { return JSON.parse(sh('/usr/bin/curl', ['-s', '-m', '5', `${AI}/health`])); } catch { return null; } };

async function waitForHealth(deadlineMs = 120000) {
  const t0 = process.hrtime.bigint();
  for (;;) {
    const r = curlTimed([`${AI}/health`]);
    if (r.ok) return Number(process.hrtime.bigint() - t0) / 1e6;
    if (Number(process.hrtime.bigint() - t0) / 1e6 > deadlineMs) throw new Error('AI never became healthy');
    await sleep(25);
  }
}

(async () => {
  const record = { mode: MODE, at: new Date().toISOString(), container: CONTAINER, image: IMAGE, rounds: [] };
  record.hostLoad = sh('/usr/bin/uptime').trim();

  if (MODE === 'resident') {
    const h = health();
    if (!h || h.model_loaded !== false) {
      throw new Error(`refusing: /health says model_loaded=${h && h.model_loaded}. A "cold" call against a loaded model is a warm call.`);
    }
    record.containerStartedAt = sh('/opt/podman/bin/podman', ['inspect', CONTAINER, '--format', '{{.State.StartedAt}}']).trim();
    record.healthBefore = h;
    record.suggestBeforeModelLoad = suggest();
    const cold = tag();
    record.firstTagAfterStart = cold;
    record.healthAfterFirstTag = health();
    record.suggestAfterModelLoad = suggest();
    const warm = [];
    for (let i = 0; i < 10; i += 1) warm.push(tag());
    record.warmTag = warm;
  }

  if (MODE === 'restart') {
    for (let i = 0; i < ROUNDS; i += 1) {
      sh('/opt/podman/bin/podman', ['stop', '-t', '10', CONTAINER]);
      await sleep(1500);
      const t0 = Date.now();
      sh('/opt/podman/bin/podman', ['start', CONTAINER]);
      const startCmdMs = Date.now() - t0;
      const healthMs = await waitForHealth();
      const h = health();
      const s = suggest();
      const cold = tag();
      const h2 = health();
      const warm = [];
      for (let k = 0; k < 5; k += 1) warm.push(tag());
      record.rounds.push({
        round: i + 1,
        podmanStartCommandMs: startCmdMs,
        containerStartToHealth200Ms: startCmdMs + healthMs,
        modelLoadedAtHealth: h && h.model_loaded,
        suggestOnColdProcessMs: s.ms,
        firstTagAfterStartMs: cold.ms,
        firstTagStatus: cold.status,
        modelLoadedAfterTag: h2 && h2.model_loaded,
        warmTagMs: warm.map((w) => w.ms),
      });
      process.stderr.write(`  round ${i + 1}: start->health200 ${(startCmdMs + healthMs).toFixed(0)} ms | first /tag ${cold.ms.toFixed(0)} ms | /suggest on cold process ${s.ms.toFixed(0)} ms | warm /tag ${warm.map((w) => w.ms.toFixed(0)).join(',')} ms\n`);
      await sleep(2000);
    }
  }

  if (MODE === 'idle') {
    record.idleSinceNote = arg('--idle-note', '');
    record.containerStartedAt = sh('/opt/podman/bin/podman', ['inspect', CONTAINER, '--format', '{{.State.StartedAt}}']).trim();
    record.healthBefore = health();
    record.firstSuggestAfterIdle = suggest();
    record.firstTagAfterIdle = tag();
    const warm = [];
    for (let i = 0; i < 10; i += 1) warm.push({ tag: tag(), suggest: suggest() });
    record.warmAfterIdle = warm;
  }

  if (OUT) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(record, null, 2)); }
  console.log(JSON.stringify(record, null, 2).slice(0, 4000));
})();
