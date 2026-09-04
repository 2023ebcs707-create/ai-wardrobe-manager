'use strict';

/**
 * Captures the rig, because "1.8 s" is not a measurement.
 *
 * Stage 9's constraints require the units, the sample size, the hardware and
 * the network for every number. This module collects the parts that are the
 * same for every measurement in a run -- the host, the handset, the connection
 * path, the services, the database, and what else was running at the time --
 * so each result file can carry them rather than a reader having to trust that
 * conditions were "normal".
 *
 * RULING 2 IS ENCODED HERE. The phone reaches the API through
 * `adb reverse tcp:3000`, so every network number is a LOOPBACK number: USB/
 * wireless-debug forwarding to a server on the same desk, not mobile data and
 * not Wi-Fi to a hosted API. `connectionPath` states that in words in every
 * artefact, because a reader who sees "on a stable network connection" will
 * otherwise assume something a hundred times slower.
 */

const os = require('node:os');
const { execFileSync } = require('node:child_process');
const adbLib = require('./adb');

function sh(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim();
  } catch (err) {
    return `<unavailable: ${String(err.message).split('\n')[0]}>`;
  }
}

function hostRig() {
  return {
    machine: sh('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string']),
    cores: os.cpus().length,
    memoryBytes: os.totalmem(),
    platform: `${os.type()} ${os.release()}`,
    macosVersion: sh('/usr/bin/sw_vers', ['-productVersion']),
    node: process.version,
    loadAverage: os.loadavg(),
    uptimeSeconds: os.uptime(),
  };
}

function serviceRig() {
  const ps = sh('/usr/local/bin/docker', ['ps', '--format', '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}']);
  const fallback = ps.startsWith('<unavailable') ? sh('/opt/homebrew/bin/docker', ['ps', '--format', '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}']) : ps;
  const containers = (fallback.startsWith('<unavailable') ? sh('docker', ['ps', '--format', '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}']) : fallback);
  return {
    containers: containers.startsWith('<unavailable')
      ? containers
      : containers.split('\n').filter(Boolean).map((l) => {
          const [name, image, status, ports] = l.split('\t');
          return { name, image, status, ports };
        }),
  };
}

/**
 * What else was running. Not decoration: a p95 that doubles because a build
 * started in another window is a measurement of the build, and the only way a
 * reader can judge that is to see the machine's state beside the number.
 */
function whatElseWasRunning({ top = 8 } = {}) {
  const out = sh('/bin/ps', ['-Ao', 'pid,pcpu,pmem,comm', '-r']);
  const lines = out.split('\n').slice(1, top + 1).map((l) => l.trim());
  return {
    loadAverage: os.loadavg(),
    topProcessesByCpu: lines,
  };
}

function deviceRig() {
  try {
    const target = adbLib.device();
    const rig = adbLib.rig(target);
    const battery = adbLib.shell(target, 'dumpsys battery');
    const level = (battery.match(/level: (\d+)/) || [])[1];
    const temp = (battery.match(/temperature: (\d+)/) || [])[1];
    const powered = /AC powered: true|USB powered: true|Wireless powered: true/.test(battery);
    // NOT `| grep -m1 ...` on the device: grep exits after the first match and
    // dumpsys then prints `Failed to write while dumping service power: Broken
    // pipe` to the harness's own output. Filter host-side instead; harness
    // output has to stay clean enough that a real warning is visible in it.
    const power = (adbLib.shell(target, 'dumpsys power').match(/mWakefulness=\w+/) || [''])[0];
    const locked = (adbLib.shell(target, 'dumpsys trust').match(/deviceLocked=\d+/) || [''])[0];
    return {
      ...rig,
      batteryPercent: level ? Number(level) : null,
      batteryTemperatureC: temp ? Number(temp) / 10 : null,
      charging: powered,
      wakefulness: power.trim(),
      keyguard: locked.trim(),
      expoGoInstalled: adbLib.shell(target, 'pm list packages host.exp.exponent').includes('host.exp.exponent'),
      expoGoPid: adbLib.shell(target, 'pidof host.exp.exponent').trim() || null,
    };
  } catch (err) {
    return { unavailable: String(err.message) };
  }
}

async function databaseRig(uri) {
  const { getMongoClient } = require('./mongo');
  try {
    const client = await getMongoClient(uri);
    try {
      const db = client.db();
      const build = await db.admin().command({ buildInfo: 1 });
      const names = (await db.listCollections().toArray()).map((c) => c.name);
      const counts = {};
      for (const n of names) counts[n] = await db.collection(n).estimatedDocumentCount();
      return { uri, database: db.databaseName, mongoVersion: build.version, collections: counts };
    } finally {
      await client.close();
    }
  } catch (err) {
    return { uri, unavailable: String(err.message) };
  }
}

async function captureRig({ mongoUri = 'mongodb://localhost:27017/wardrobe_perf', apiHost = 'http://localhost:3100' } = {}) {
  return {
    at: new Date().toISOString(),
    host: hostRig(),
    apiHost,
    apiHostNote:
      'the harness starts its OWN API process on this port; the project dev server on :3000 (database wardrobe_gate7) is left running and untouched',
    connectionPath:
      'LOOPBACK. Host and API are the same machine (127.0.0.1). The handset reaches the API through `adb reverse tcp:3000`, i.e. an adb-forwarded socket over wireless debugging to a server on the same desk -- NOT mobile data, NOT Wi-Fi to a hosted API. Ruling 2: every network number here is a loopback number and must be read as one.',
    services: serviceRig(),
    device: deviceRig(),
    database: await databaseRig(mongoUri),
    environment: whatElseWasRunning(),
  };
}

module.exports = { captureRig, hostRig, deviceRig, serviceRig, databaseRig, whatElseWasRunning };
