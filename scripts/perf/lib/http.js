'use strict';

/**
 * A wire-accurate, timed HTTP client for the harness.
 *
 * TWO NUMBERS COME OUT OF ONE REQUEST, and they are different metric classes:
 *
 *   latency  -- wall time from the moment the request is written to the moment
 *               the last response byte has been read. Measured with
 *               `process.hrtime.bigint()`, so it is monotonic and immune to
 *               clock adjustment. TTFB (first response byte) is recorded
 *               separately, because a slow body and a slow handler are
 *               different faults.
 *
 *   transfer -- `socket.bytesRead` / `socket.bytesWritten`, i.e. the actual
 *               octets that crossed the socket, headers included. NOT
 *               `content-length`, which is what the server SAYS it will send,
 *               and not the length of the parsed body, which omits headers and
 *               any transfer-encoding overhead.
 *
 * WHY KEEP-ALIVE IS OFF (`agent: false`). One socket per request is what makes
 * `socket.bytesRead` attributable to a single exchange; on a pooled socket it
 * is a running total across every request that socket has served, and the
 * transfer number would be silently cumulative. The cost is one TCP handshake
 * per sample against loopback, which is included in the reported latency and
 * is stated in the README rather than subtracted.
 */

const http = require('node:http');
const { URL } = require('node:url');

/**
 * A SHARED KEEP-ALIVE AGENT, opt-in and off by default.
 *
 * Keep-alive is off for every measurement in this harness, for the reason
 * documented above: on a pooled socket `bytesRead` is a running total across
 * every exchange that socket has served, so the transfer number would be
 * silently cumulative.
 *
 * It is available as an option for exactly one purpose. Task 2's concurrency
 * sweep produced connect ETIMEDOUTs above 150 virtual users, and this host's
 * `kern.ipc.somaxconn` is 128 -- so the suspected cause was the ACCEPT QUEUE
 * overflowing under one-connection-per-request churn, not any limit on the
 * server's ability to serve concurrent requests. Re-running the same load with
 * connection reuse is the experiment that tells those apart, and an experiment
 * you cannot run is a hypothesis.
 *
 * When it is on, `wireBytesRead`/`wireBytesWritten` are returned as NULL rather
 * than as the socket's cumulative total, so a transfer number can never be
 * taken from a keep-alive run by accident.
 */
const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 1024, maxFreeSockets: 1024 });

/**
 * @returns {Promise<{status:number, ms:number, ttfbMs:number, wireBytesRead:number,
 *                    wireBytesWritten:number, bodyBytes:number, contentLength:number|null,
 *                    body:string, headers:object}>}
 */
function timedRequest(urlString, options = {}) {
  const { method = 'GET', headers = {}, body = null, timeoutMs = 30000, keepAlive = false } = options;
  const url = new URL(urlString);

  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    let firstByteAt = null;

    const req = http.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers: keepAlive ? { ...headers } : { Connection: 'close', ...headers },
        agent: keepAlive ? keepAliveAgent : false,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => {
          if (firstByteAt === null) firstByteAt = process.hrtime.bigint();
          chunks.push(chunk);
        });
        res.on('end', () => {
          const ended = process.hrtime.bigint();
          const buf = Buffer.concat(chunks);
          const socket = res.socket || req.socket;
          resolve({
            status: res.statusCode,
            ms: Number(ended - started) / 1e6,
            ttfbMs: firstByteAt === null ? null : Number(firstByteAt - started) / 1e6,
            // bytesRead/bytesWritten are read at 'end', when the whole exchange
            // has crossed the socket. With agent:false this socket served this
            // request and nothing else.
            // NULL under keep-alive on purpose: the socket's counters are
            // cumulative across every request it has served, and a cumulative
            // number reported as a per-request one is worse than no number.
            wireBytesRead: keepAlive ? null : socket ? socket.bytesRead : null,
            wireBytesWritten: keepAlive ? null : socket ? socket.bytesWritten : null,
            bodyBytes: buf.length,
            contentLength: res.headers['content-length'] ? Number(res.headers['content-length']) : null,
            body: buf.toString('utf8'),
            headers: res.headers,
          });
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

/** Poll a URL until it answers with the expected status, or give up. */
async function waitFor(urlString, { timeoutMs = 60000, intervalMs = 250, expect = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await timedRequest(urlString, { timeoutMs: 5000 });
      if (res.status === expect) return res;
      lastError = new Error(`status ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor(${urlString}) gave up after ${timeoutMs}ms: ${lastError && lastError.message}`);
}

module.exports = { timedRequest, waitFor, keepAliveAgent };
