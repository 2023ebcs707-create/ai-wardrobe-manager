'use strict';

/**
 * THE DELIBERATE-DEFECT INJECTOR -- the other half of every negative control.
 * NOT application code. Nothing in `apps/`, `packages/` or `services/`
 * references this file, and `pnpm dev:api` never loads it.
 *
 * Ruling 1 of Stage 9: measurement code is not product code and must not leak
 * into it. So the controls are injected the way `docs/verification/stage-3/
 * tag-timer.js` injected its timers -- with `node --require`, in front of the
 * server's own entry point:
 *
 *   PERF_CONTROL_DELAY_MS=250 node \
 *     --require scripts/perf/control-preload.js \
 *     --require ts-node/register apps/api/src/server.ts
 *
 * Removing the `--require` restores stock behaviour exactly, because no file
 * on disk was changed to install it. That is the property the ruling asks for,
 * and it is stronger than "removable in one edit": there is nothing to remove.
 *
 * WHAT IT CAN BREAK, one control per metric class:
 *
 *   PERF_CONTROL_DELAY_MS=<n>        sleep n ms before the app sees the request
 *                                    -> must move the API-LATENCY number
 *   PERF_CONTROL_INFLATE_BYTES=<n>   pad every JSON response by n bytes
 *                                    -> must move the TRANSFER number
 *   PERF_CONTROL_CPU_BURN_MS=<n>     spin the CPU for n ms per request
 *                                    -> must move the SERVER-CPU number
 *   PERF_CONTROL_PATH_PREFIX=<s>     restrict the above to one path prefix
 *
 * All default to OFF. With none set this file installs the reporting endpoint
 * and nothing else, so a baseline run and a control run differ only in
 * environment -- same code, same process arguments, same everything else.
 *
 * HOW A HARNESS KNOWS THE CONTROL ACTUALLY RAN. `GET /__perf/control` returns
 * the active settings and a counter of how many requests each control has
 * been applied to. "The control did not move the metric" and "the control was
 * never installed" are different findings, and the second one masquerades as
 * the first: a harness that cannot tell them apart is exactly how a negative
 * control gets faked. Every control run in this harness asserts the counter
 * moved before it reads the metric.
 */

const http = require('node:http');

const num = (name) => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number, got ${raw}`);
  return parsed;
};

const CONTROLS = {
  delayMs: num('PERF_CONTROL_DELAY_MS'),
  inflateBytes: num('PERF_CONTROL_INFLATE_BYTES'),
  cpuBurnMs: num('PERF_CONTROL_CPU_BURN_MS'),
  pathPrefix: process.env.PERF_CONTROL_PATH_PREFIX || '',
};

const applied = { delay: 0, inflate: 0, cpuBurn: 0, requests: 0 };

const anyControl = CONTROLS.delayMs > 0 || CONTROLS.inflateBytes > 0 || CONTROLS.cpuBurnMs > 0;

function inScope(url) {
  if (!CONTROLS.pathPrefix) return true;
  return String(url).startsWith(CONTROLS.pathPrefix);
}

function burnCpu(ms) {
  const until = process.hrtime.bigint() + BigInt(Math.round(ms * 1e6));
  // A deliberately un-optimisable spin: the accumulator is read afterwards so
  // the loop body cannot be eliminated.
  let acc = 0;
  while (process.hrtime.bigint() < until) {
    for (let i = 0; i < 5000; i += 1) acc += Math.sqrt(i);
  }
  return acc;
}

/**
 * Buffer the response, then re-emit it larger.
 *
 * JSON bodies get an extra property rather than trailing junk, so the response
 * a client receives is still parseable -- an inflated payload that also breaks
 * the client would confound "the transfer number moved" with "the request
 * failed", and a failed request is not a bigger payload.
 */
function inflateResponse(res, bytes) {
  const chunks = [];
  const realWrite = res.write;
  const realEnd = res.end;

  res.write = function patchedWrite(chunk, encoding, cb) {
    if (chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8'));
    }
    if (typeof encoding === 'function') encoding();
    else if (typeof cb === 'function') cb();
    return true;
  };

  res.end = function patchedEnd(chunk, encoding, cb) {
    if (chunk && typeof chunk !== 'function') {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8'));
    }
    let body = Buffer.concat(chunks);
    const contentType = String(res.getHeader('content-type') || '');
    const padding = 'x'.repeat(bytes);
    if (contentType.includes('application/json')) {
      try {
        const parsed = JSON.parse(body.toString('utf8'));
        if (Array.isArray(parsed)) parsed.push(padding);
        else if (parsed && typeof parsed === 'object') parsed.__perfControlPadding = padding;
        body = Buffer.from(JSON.stringify(parsed), 'utf8');
      } catch {
        body = Buffer.concat([body, Buffer.from(padding, 'utf8')]);
      }
    } else {
      body = Buffer.concat([body, Buffer.from(padding, 'utf8')]);
    }
    res.write = realWrite;
    res.end = realEnd;
    if (!res.headersSent) res.setHeader('Content-Length', String(body.length));
    applied.inflate += 1;
    return realEnd.call(res, body, typeof encoding === 'function' ? undefined : encoding, cb);
  };
}

const realCreateServer = http.createServer;

http.createServer = function patchedCreateServer(...args) {
  const handlerIndex = args.findIndex((a) => typeof a === 'function');
  if (handlerIndex === -1) return realCreateServer.apply(http, args);
  const appHandler = args[handlerIndex];

  args[handlerIndex] = function controlledHandler(req, res) {
    applied.requests += 1;

    // The reporting endpoint is answered here, before the application sees the
    // request, so it exists whether or not any control is active and cannot be
    // confused with a real route.
    if (req.url === '/__perf/control') {
      const body = JSON.stringify({ controls: CONTROLS, applied, pid: process.pid });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }

    if (!anyControl || !inScope(req.url)) return appHandler(req, res);

    if (CONTROLS.inflateBytes > 0) inflateResponse(res, CONTROLS.inflateBytes);

    if (CONTROLS.cpuBurnMs > 0) {
      burnCpu(CONTROLS.cpuBurnMs);
      applied.cpuBurn += 1;
    }

    if (CONTROLS.delayMs > 0) {
      setTimeout(() => {
        applied.delay += 1;
        appHandler(req, res);
      }, CONTROLS.delayMs);
      return;
    }

    return appHandler(req, res);
  };

  return realCreateServer.apply(http, args);
};

// --- orphan watchdog --------------------------------------------------------
//
// The harness registers this child in its crash-safe ledger the instant it is
// spawned, and the next run kills anything the ledger still lists. This is the
// second line of defence for the same problem: if the harness is SIGKILLed,
// the API server it started is NOT in the signal's blast radius and would keep
// holding its port until someone noticed. Polling the parent pid costs one
// syscall every two seconds and closes that window without waiting for the
// next run.
if (process.env.PERF_PARENT_PID) {
  const parentPid = Number(process.env.PERF_PARENT_PID);
  const watchdog = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      console.error(`[perf-control] parent ${parentPid} is gone -- exiting`);
      process.exit(0);
    }
  }, 2000);
  watchdog.unref();
}

console.log(
  `[perf-control] active=${anyControl} ` +
    `delayMs=${CONTROLS.delayMs} inflateBytes=${CONTROLS.inflateBytes} ` +
    `cpuBurnMs=${CONTROLS.cpuBurnMs} pathPrefix=${CONTROLS.pathPrefix || '(all)'}`,
);
