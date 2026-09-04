'use strict';

/**
 * The concurrent-load generator, and the DEFINITION of "a simulated
 * concurrent user" that Ruling 5 requires be fixed before anything is counted.
 *
 * A VIRTUAL USER here is: one client, holding its own connection, issuing one
 * request at a time from a stated mix, waiting for each response before
 * issuing the next, with a stated think time between requests (default 0).
 * Fifty of them is therefore a CLOSED-LOOP load of fifty outstanding requests
 * at most -- not fifty idle sockets, and not fifty requests per second. Those
 * are different measurements that share the headline "50 simultaneous users",
 * which is exactly the confusion Ruling 5 exists to prevent, so every result
 * this module produces carries `virtualUserDefinition` with it.
 *
 * TWO LOAD SHAPES, because they answer different questions:
 *
 *   CLOSED LOOP (`concurrency`) -- N virtual users, each waiting for its own
 *   response before issuing the next request. This is what "50 simultaneous
 *   users" means and it is the right shape for a stability claim. It is the
 *   WRONG shape for a CPU-utilisation claim: a closed loop pushes until
 *   something saturates, and a single-threaded Node server under a closed loop
 *   on a fast host simply pins one core at 100% whatever the handler does.
 *   Measured here first, before it was replaced for that purpose.
 *
 *   OPEN LOOP (`ratePerSecond`) -- requests issued on a fixed schedule
 *   regardless of how fast they come back, which is how real traffic arrives.
 *   The server is left with headroom, so CPU per request is visible in the
 *   utilisation number instead of being hidden behind saturation.
 *
 * THE MIX IS DETERMINISTIC, not random. Each virtual user walks a weighted
 * request list in order from its own offset, so a run of 50 users issues a
 * known number of each request type rather than a sampled approximation. Two
 * runs with the same parameters issue the same work, which is what makes a
 * before/after control comparable.
 */

const { timedRequest } = require('./http');
const { summarise } = require('./stats');

/**
 * Describe a connection failure in a way a results table can act on.
 *
 * `String(err)` for Node's happy-eyeballs connect failure is the bare word
 * "AggregateError" -- the actual `ECONNREFUSED` / `ETIMEDOUT` /
 * `EADDRNOTAVAIL` codes live in `err.errors[]`. Task 2's high-concurrency
 * steps produced 316 of those at 400 virtual users, and "the server refused
 * the connection" and "the client ran out of ephemeral ports" are opposite
 * findings that were indistinguishable in the recorded string. The codes are
 * therefore unwrapped here, because a stability claim decided by an
 * unattributed error is not decided at all.
 */
function describeError(err) {
  const parts = [];
  if (err && err.code) parts.push(err.code);
  if (err && Array.isArray(err.errors)) {
    const codes = [...new Set(err.errors.map((e) => (e && e.code) || (e && e.syscall) || String(e && e.message)))];
    parts.push(...codes);
  }
  const base = String((err && err.message) || err);
  return parts.length ? `${base || err.constructor.name}(${parts.join(',')})` : base;
}

const VIRTUAL_USER_DEFINITION =
  'one client, one outstanding request at a time, requests drawn in order from a ' +
  'weighted mix, own TCP connection per request (keep-alive off), stated think time ' +
  'between requests';

function expandMix(mix) {
  const expanded = [];
  for (const entry of mix) {
    for (let i = 0; i < (entry.weight ?? 1); i += 1) expanded.push(entry);
  }
  if (expanded.length === 0) throw new Error('load mix is empty');
  return expanded;
}

async function runLoad(options) {
  const {
    baseUrl,
    mix,
    concurrency = 50,
    durationMs = 20000,
    thinkTimeMs = 0,
    headers = {},
    label = `${concurrency} virtual users`,
    onStart = null,
    ratePerSecond = null,
    maxOutstanding = 500,
    keepAlive = false,
  } = options;

  const expanded = expandMix(mix);
  const observations = [];
  const startedAt = Date.now();
  const deadline = startedAt + durationMs;
  let stopped = false;

  async function virtualUser(userIndex) {
    let step = userIndex; // each user starts at its own offset in the mix
    while (!stopped && Date.now() < deadline) {
      const entry = expanded[step % expanded.length];
      step += 1;
      const url = `${baseUrl}${entry.path}`;
      const t = Date.now();
      try {
        const res = await timedRequest(url, {
          method: entry.method || 'GET',
          headers: { ...headers, ...(entry.headers || {}) },
          body: entry.body || null,
          timeoutMs: 30000,
          keepAlive,
        });
        observations.push({
          user: userIndex,
          name: entry.name,
          at: t - startedAt,
          ms: res.ms,
          status: res.status,
          expected: entry.expectStatus ?? 200,
          wireBytesRead: res.wireBytesRead,
        });
      } catch (err) {
        observations.push({
          user: userIndex,
          name: entry.name,
          at: t - startedAt,
          ms: null,
          status: null,
          expected: entry.expectStatus ?? 200,
          error: describeError(err),
        });
      }
      if (thinkTimeMs) await new Promise((r) => setTimeout(r, thinkTimeMs));
    }
  }

  /**
   * Open-loop driver: one request every 1000/rate ms on a fixed schedule,
   * whatever the server is doing. `maxOutstanding` is a safety valve, and if it
   * ever trips the run is reported as `rateLimited` rather than quietly
   * degrading into a closed loop with a different name.
   */
  async function fixedRateDriver() {
    const intervalMs = 1000 / ratePerSecond;
    let step = 0;
    let outstanding = 0;
    let skipped = 0;
    const inflight = [];
    while (Date.now() < deadline) {
      const scheduledAt = startedAt + step * intervalMs;
      const wait = scheduledAt - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const entry = expanded[step % expanded.length];
      step += 1;
      if (outstanding >= maxOutstanding) {
        skipped += 1;
        continue;
      }
      outstanding += 1;
      const t = Date.now();
      const p = timedRequest(`${baseUrl}${entry.path}`, {
        method: entry.method || 'GET',
        headers: { ...headers, ...(entry.headers || {}) },
        body: entry.body || null,
        timeoutMs: 30000,
        keepAlive,
      })
        .then((res) => {
          observations.push({ user: -1, name: entry.name, at: t - startedAt, ms: res.ms, status: res.status, expected: entry.expectStatus ?? 200, wireBytesRead: res.wireBytesRead });
        })
        .catch((err) => {
          observations.push({ user: -1, name: entry.name, at: t - startedAt, ms: null, status: null, expected: entry.expectStatus ?? 200, error: describeError(err) });
        })
        .finally(() => {
          outstanding -= 1;
        });
      inflight.push(p);
    }
    await Promise.all(inflight);
    return { skipped, issued: step };
  }

  let openLoop = null;
  if (ratePerSecond) {
    if (onStart) await onStart();
    openLoop = await fixedRateDriver();
  } else {
    const users = [];
    for (let i = 0; i < concurrency; i += 1) users.push(virtualUser(i));
    if (onStart) await onStart();
    await Promise.all(users);
  }
  stopped = true;

  const elapsedMs = Date.now() - startedAt;
  const okObservations = observations.filter((o) => o.status === o.expected);
  const failures = observations.filter((o) => o.status !== o.expected);

  const byName = {};
  for (const entry of mix) {
    const forEntry = okObservations.filter((o) => o.name === entry.name).map((o) => o.ms);
    byName[entry.name] = {
      count: observations.filter((o) => o.name === entry.name).length,
      ok: forEntry.length,
      latencyMs: forEntry.length ? summarise(forEntry, { unit: 'ms' }) : null,
    };
  }

  return {
    label,
    shape: ratePerSecond ? 'open loop (fixed rate)' : 'closed loop (virtual users)',
    keepAlive,
    ratePerSecond,
    rateLimited: openLoop ? openLoop.skipped > 0 : false,
    skippedByBackpressure: openLoop ? openLoop.skipped : 0,
    virtualUserDefinition: ratePerSecond
      ? `requests issued on a fixed ${ratePerSecond}/s schedule, own TCP connection per request (keep-alive off), no waiting for the previous response`
      : VIRTUAL_USER_DEFINITION,
    concurrency: ratePerSecond ? null : concurrency,
    thinkTimeMs,
    requestedDurationMs: durationMs,
    elapsedMs,
    mix: mix.map((m) => ({ name: m.name, method: m.method || 'GET', path: m.path, weight: m.weight ?? 1 })),
    totalRequests: observations.length,
    okRequests: okObservations.length,
    failures: failures.length,
    failureSample: failures.slice(0, 5),
    requestsPerSecond: observations.length / (elapsedMs / 1000),
    statuses: observations.reduce((acc, o) => {
      const key = o.error ? `error:${o.error.slice(0, 40)}` : String(o.status);
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    latencyMs: okObservations.length ? summarise(okObservations.map((o) => o.ms), { unit: 'ms' }) : null,
    byName,
  };
}

module.exports = { runLoad, VIRTUAL_USER_DEFINITION, describeError };
