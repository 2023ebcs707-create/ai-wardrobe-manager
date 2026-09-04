'use strict';

/**
 * STAGE 9 TASK 3 — the device-traffic instrument.
 *
 * WHAT IT IS. A logging TCP proxy that sits in the `adb reverse` path, so that
 * every byte the HANDSET's app actually asks for is recorded with a timestamp:
 * the `GET /items` page, and every image the grid pulls from MinIO. Nothing in
 * `apps/`, `packages/` or `services/` is touched or aware of it — Ruling 1 is
 * satisfied structurally, exactly as `control-preload.js` satisfies it for the
 * server: the app under test is byte-for-byte the stock one, and removing the
 * instrument is one `adb reverse` remap.
 *
 * WHY IT IS NEEDED. Claim 1 ("dashboard loads within 1.5-2.5 s") and claim 11
 * ("100+ items ... ~4 seconds ... due to image rendering") are both claims about
 * what the DEVICE does. A host-side `curl` measures what the host can fetch; it
 * does not tell you how many requests the grid issues, in what order, or how
 * many bytes crossed to the phone. Only something in the device's own path can.
 *
 * WHAT IT MEASURES, PRECISELY. For each proxied connection: open time, close
 * time, bytes each way. For each HTTP message seen on that connection: the
 * request line with the timestamp of the byte that carried it, and the response
 * status line + Content-Length with the timestamp of the first byte of that
 * response. Connections are pooled by OkHttp, so this is per MESSAGE, not per
 * connection.
 *
 * WHAT IT DOES NOT MEASURE. The `adb` hop itself. The proxy runs on the host, so
 * a timestamp here is when the byte reached (or left) the HOST, not the handset.
 * The device-side `curl` numbers in the same report bound that gap: they measure
 * from inside the handset and come out ~8 ms above the host-side figure.
 *
 * NEGATIVE CONTROL. `--delay-ms N` holds each upstream connection open for N ms
 * before forwarding the first client byte. If a device-observed number does not
 * move when the network under it is deliberately slowed, that number is not
 * measuring the network path and must not be reported as if it were.
 *
 *   node scripts/perf/task3-proxy.js --out <ndjson> [--delay-ms N]
 *
 * Ports are fixed and deliberately NOT the service ports: 13000 -> 3000 (API),
 * 19000 -> 9000 (MinIO). The caller remaps `adb reverse` and restores it; the
 * proxy never touches adb itself, so a crashed proxy cannot leave the handset
 * pointing at a dead socket without the caller's ledger knowing.
 */

const net = require('node:net');
const fs = require('node:fs');

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
};

const OUT = arg('--out', '/dev/stdout');
const DELAY_MS = Number(arg('--delay-ms', '0'));

// 8081 is Metro. It is proxied for ONE reason: an Expo Go cold launch fetches a
// development JS bundle from it, and that fetch is a property of the dev rig,
// not of the product. Measuring it separately is the only way to say how much of
// a cold-launch number belongs to the claim and how much belongs to Metro.
const MAP = [
  { listen: 13000, upstream: 3000, tag: 'api' },
  { listen: 19000, upstream: 9000, tag: 'minio' },
  { listen: 18081, upstream: 8081, tag: 'metro' },
];

const out = fs.createWriteStream(OUT, { flags: 'a' });
const write = (rec) => out.write(JSON.stringify({ t: Date.now(), ...rec }) + '\n');

let connSeq = 0;

/**
 * Scan a chunk for HTTP message starts.
 *
 * Deliberately a scanner and not a parser. A full HTTP/1.1 parser would have to
 * track chunked encoding, pipelining and 100-continue to stay correct, and a
 * subtly wrong parser that silently drops messages would under-count the grid's
 * requests — the exact number claim 11 turns on. A scanner that reports every
 * request line and every status line it sees can only ever over-report on a
 * pathological body, and the bodies here are JPEG and JSON. `carry` holds the
 * last 200 bytes so a line split across two TCP segments is still seen once.
 */
function makeScanner(onRequest, onResponse) {
  let carry = '';
  const KEEP = 4096;
  return (chunk, at) => {
    const text = carry + chunk.toString('latin1');
    // How far into `text` has already been REPORTED. Everything before this is
    // dropped from the carry so it cannot be reported a second time.
    //
    // MEASURED BUG, not a precaution. The first version kept the last 4 KB of
    // every chunk and re-scanned it whole. Requests are a few hundred bytes, so
    // the carry still held the previous request lines and re-reported them on
    // every subsequent chunk: one ten-sample run reported 13, 28, 44, 54, 63,
    // 66, 71, 72, 72, 72 MinIO requests for ten IDENTICAL grid loads of eight
    // images. The byte totals were right throughout (they come from `down`
    // events, which are per-chunk and cannot double-count) — which is exactly
    // why the wire-byte figure is the one this task reports.
    let maxEnd = 0;
    const reqRe = /(?:^|\r\n)([A-Z]{3,7}) (\S+) HTTP\/1\.[01]\r\n/g;
    let m;
    while ((m = reqRe.exec(text)) !== null) {
      onRequest(m[1], m[2], at);
      maxEnd = Math.max(maxEnd, m.index + m[0].length);
    }
    // Bounded forward search from each status line rather than one regex over the
    // whole chunk. A `[\s\S]*?\r\n\r\n` tail runs into the BODY on a JPEG
    // response and silently loses the header block, which is why the pilot run
    // saw 33 requests and only 11 responses. Headers are looked for in at most
    // the next 4 KB, which is far more than either server sends.
    const statusRe = /(?:^|\r\n)HTTP\/1\.[01] (\d{3})[^\r\n]*\r\n/g;
    while ((m = statusRe.exec(text)) !== null) {
      const headStart = m.index + m[0].length;
      const window = text.slice(headStart, headStart + 4096);
      const end = window.indexOf('\r\n\r\n');
      if (end === -1) continue; // header block not complete in this chunk; carry picks it up
      const head = window.slice(0, end);
      const lenM = head.match(/(?:^|\r?\n)Content-Length: (\d+)/i);
      const ctM = head.match(/(?:^|\r?\n)Content-Type: ([^\r\n]+)/i);
      onResponse(Number(m[1]), lenM ? Number(lenM[1]) : null, ctM ? ctM[1] : null, at);
      maxEnd = Math.max(maxEnd, headStart + end + 4);
    }
    // Drop everything already reported; keep at most KEEP bytes of the tail so a
    // message split across two TCP segments is still seen exactly once.
    carry = text.slice(maxEnd);
    if (carry.length > KEEP) carry = carry.slice(-KEEP);
  };
}

for (const { listen, upstream, tag } of MAP) {
  net
    .createServer((client) => {
      const id = ++connSeq;
      const openedAt = Date.now();
      let toClient = 0;
      let toUpstream = 0;
      let firstResponseAt = null;

      const server = net.connect(upstream, '127.0.0.1');
      const scanUp = makeScanner(
        (method, path, at) => write({ ev: 'req', tag, conn: id, method, path: path.slice(0, 300), at }),
        () => {},
      );
      const scanDown = makeScanner(
        () => {},
        (status, length, contentType, at) => {
          if (firstResponseAt === null) firstResponseAt = at;
          write({ ev: 'res', tag, conn: id, status, length, contentType, at });
        },
      );

      client.on('data', (b) => {
        toUpstream += b.length;
        scanUp(b, Date.now());
        // The delay is PER UPSTREAM CHUNK, so every HTTP request pays it.
        //
        // MEASURED, and the first version was wrong. Delaying only the first
        // chunk of a connection delays only the first request on it: OkHttp
        // pools connections, so a grid load's nine requests share two or three
        // sockets and seven of them paid nothing. That control moved the median
        // from 457 ms to 474 ms — 1.04x, indistinguishable from noise — while
        // moving p95 to 8.6 s, which is the signature of a control that fires
        // sometimes. A control that fires sometimes is not a control.
        // Ordering is preserved because every chunk waits the same interval.
        if (DELAY_MS > 0) setTimeout(() => { if (!server.destroyed) server.write(b); }, DELAY_MS);
        else server.write(b);
      });
      server.on('data', (b) => {
        toClient += b.length;
        // A per-chunk downstream byte event. Summing these over a measurement
        // window gives the EXACT wire bytes the handset received in that window,
        // headers and all — independent of whether the HTTP scanner above framed
        // every message. Connections are pooled and outlive a window, so a
        // per-connection total cannot answer "how many bytes did this grid load
        // cost" and this can.
        write({ ev: 'down', tag, conn: id, n: b.length });
        scanDown(b, Date.now());
        client.write(b);
      });

      const close = () => {
        if (client.destroyed && server.destroyed) return;
        write({
          ev: 'conn',
          tag,
          conn: id,
          openedAt,
          closedAt: Date.now(),
          durationMs: Date.now() - openedAt,
          firstResponseAt,
          toClient,
          toUpstream,
        });
        client.destroy();
        server.destroy();
      };
      client.on('end', close);
      client.on('error', close);
      server.on('end', close);
      server.on('error', close);
    })
    .listen(listen, '127.0.0.1', () => {
      write({ ev: 'listen', tag, listen, upstream, delayMs: DELAY_MS });
      process.stderr.write(`proxy ${tag}: 127.0.0.1:${listen} -> 127.0.0.1:${upstream} delay=${DELAY_MS}ms\n`);
    });
}

process.on('SIGTERM', () => {
  write({ ev: 'stop' });
  out.end(() => process.exit(0));
});
