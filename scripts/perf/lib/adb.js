'use strict';

/**
 * adb access for the harness.
 *
 * Device selection copies `scripts/device-setup.sh`: one handset can register
 * more than one transport (wireless debugging registers both an IP transport
 * and an mDNS one), so `adb devices` is parsed TAB-delimited -- a wireless
 * transport name can contain a space, and a whitespace split mangles it into a
 * nonexistent device id -- and duplicates are collapsed by `ro.serialno`.
 */

const { execFileSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const ADB = process.env.ADB || path.join(os.homedir(), 'Library/Android/sdk/platform-tools/adb');

function adbPath() {
  if (!fs.existsSync(ADB)) throw new Error(`adb not found at ${ADB} (set $ADB)`);
  return ADB;
}

function raw(args, opts = {}) {
  return execFileSync(adbPath(), args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

function devices() {
  // `adb devices` (TAB-delimited), NOT `adb devices -l` (space-padded columns).
  // A wireless-debugging transport id contains a space --
  // `adb-RZGL20MPZTK-qlU2iC (2)._adb-tls-connect._tcp` -- so the long form
  // cannot be split on whitespace without inventing a device id that does not
  // exist. Measured here: the first draft of this file used `-l` and found no
  // devices at all with the handset plainly connected.
  const out = raw(['devices']);
  const seen = new Map();
  for (const line of out.split('\n').slice(1)) {
    if (!line.trim()) continue;
    const [id, rest] = line.split('\t');
    if (!rest || !rest.startsWith('device')) continue;
    let serial;
    try {
      serial = raw(['-s', id, 'shell', 'getprop', 'ro.serialno']).trim();
    } catch {
      serial = id;
    }
    if (!seen.has(serial)) seen.set(serial, { id: id.trim(), serial });
  }
  return [...seen.values()];
}

function device() {
  const list = devices();
  if (list.length === 0) throw new Error('no authorised Android device');
  return list[0];
}

function shell(target, command, opts = {}) {
  return raw(['-s', target.id, 'shell', command], opts);
}

/**
 * Run a device command whose failure does not matter -- cleanup, mostly.
 *
 * `pkill -f <pattern>` is the reason this exists. `pkill -f perf-alloc.sh`
 * matches the very shell adb spawned to run it, kills itself, and comes back to
 * the host as exit status 143; the first version of the device-memory control
 * died on its own cleanup line with the measurement already in hand. Cleanup
 * must not be able to lose a result.
 */
function shellSafe(target, command) {
  try {
    return { ok: true, output: shell(target, command) };
  } catch (err) {
    return { ok: false, output: String(err.message).split('\n')[0] };
  }
}

function prop(target, name) {
  return shell(target, `getprop ${name}`).trim();
}

/** The current `adb reverse` table, as { devicePort: hostPort }. */
function reverseTable(target) {
  const out = raw(['-s', target.id, 'reverse', '--list']);
  const table = {};
  for (const line of out.split('\n')) {
    const m = line.match(/tcp:(\d+)\s+tcp:(\d+)/);
    if (m) table[m[1]] = m[2];
  }
  return table;
}

function setReverse(target, devicePort, hostPort) {
  raw(['-s', target.id, 'reverse', `tcp:${devicePort}`, `tcp:${hostPort}`]);
}

/**
 * The transport id, read from the space-padded `-l` listing by locating the
 * line that begins with this device's id rather than by column position.
 */
function transportIdFor(target) {
  for (const line of raw(['devices', '-l']).split('\n')) {
    if (line.startsWith(target.id)) {
      const m = line.match(/transport_id:(\d+)/);
      if (m) return m[1];
    }
  }
  return null;
}

/** Everything the rig description has to state about the handset. */
function rig(target) {
  return {
    transportId: transportIdFor(target),
    adbDeviceId: target.id,
    serial: target.serial,
    model: prop(target, 'ro.product.model'),
    androidRelease: prop(target, 'ro.build.version.release'),
    sdk: prop(target, 'ro.build.version.sdk'),
    build: prop(target, 'ro.build.display.id'),
    abi: prop(target, 'ro.product.cpu.abi'),
    reverse: reverseTable(target),
  };
}

module.exports = { adbPath, raw, devices, device, shell, shellSafe, prop, reverseTable, setReverse, rig };
