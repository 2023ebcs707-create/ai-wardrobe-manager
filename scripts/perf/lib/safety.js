'use strict';

/**
 * The crash-safe undo ledger for the Stage 9 harness.
 *
 * WHY THIS EXISTS. `kill -9` cannot run a `finally`, an `process.on('exit')`
 * handler, or an `afterAll`. An interrupted harness in Stage 8 left two source
 * mutations on disk and `pnpm typecheck` passed with both applied, one of them
 * a live bug. So this harness never relies on unwinding: every mutation it is
 * about to make is described in a file on disk, with the pristine copy beside
 * it, BEFORE the mutation happens, and every entry point calls
 * `recoverLeftovers()` before it does anything else.
 *
 * The ordering is the whole point:
 *
 *    1. write the undo record (and any pristine copy) and fsync it
 *    2. THEN mutate
 *    3. on clean completion, undo, then delete the record
 *
 * A SIGKILL between 1 and 3 leaves a record behind, and the next run restores
 * from it and says so loudly. A SIGKILL before 1 leaves nothing mutated.
 *
 * Kinds of mutation this harness can make, all of them recorded here:
 *
 *   file       a file was copied aside and then overwritten
 *   adbReverse an `adb reverse` mapping was repointed at a different host port
 *   mongoCollection a scratch collection was created and must be dropped
 *   process    a child API server was spawned and must be killed
 *
 * NOTE none of this harness's negative controls patch product source: the API
 * controls are injected with `node --require`, which mutates nothing on disk.
 * The `file` kind exists anyway because a later task may need it, and because
 * an undo mechanism that has never been exercised is not an undo mechanism --
 * `safety-selftest.js` SIGKILLs a process mid-patch and proves recovery works.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const LEDGER_DIR = path.join(__dirname, '..', '.leftovers');

function ensureDir() {
  fs.mkdirSync(LEDGER_DIR, { recursive: true });
}

/** Write a file and fsync both it and its directory, so a SIGKILL cannot lose it. */
function durableWrite(filePath, data) {
  ensureDir();
  const fd = fs.openSync(filePath, 'w');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const dirFd = fs.openSync(path.dirname(filePath), 'r');
  try {
    fs.fsyncSync(dirFd);
  } catch {
    // Directory fsync is not supported on every filesystem; the file fsync
    // above is the load-bearing one.
  } finally {
    fs.closeSync(dirFd);
  }
}

function newId(kind) {
  return `${Date.now()}-${kind}-${crypto.randomBytes(4).toString('hex')}`;
}

function recordPath(id) {
  return path.join(LEDGER_DIR, `${id}.json`);
}

function writeRecord(record) {
  durableWrite(recordPath(record.id), JSON.stringify(record, null, 2));
  return record.id;
}

function release(id) {
  try {
    const record = JSON.parse(fs.readFileSync(recordPath(id), 'utf8'));
    if (record.kind === 'file' && record.backup) {
      fs.rmSync(record.backup, { force: true });
    }
  } catch {
    /* record already gone */
  }
  fs.rmSync(recordPath(id), { force: true });
}

// --- registration: ALWAYS called before the mutation ------------------------

/** Copy `filePath` aside and register the restore. Returns the record id. */
function guardFile(filePath) {
  ensureDir();
  const abs = path.resolve(filePath);
  const id = newId('file');
  const backup = path.join(LEDGER_DIR, `${id}.pristine`);
  const contents = fs.readFileSync(abs);
  durableWrite(backup, contents);
  return writeRecord({
    id,
    kind: 'file',
    at: new Date().toISOString(),
    pid: process.pid,
    path: abs,
    backup,
    sha256: crypto.createHash('sha256').update(contents).digest('hex'),
  });
}

function guardAdbReverse({ adb, serial, devicePort, originalHostPort }) {
  return writeRecord({
    id: newId('adbReverse'),
    kind: 'adbReverse',
    at: new Date().toISOString(),
    pid: process.pid,
    adb,
    serial,
    devicePort,
    originalHostPort,
  });
}

function guardMongoCollection({ uri, dbName, collection }) {
  return writeRecord({
    id: newId('mongoCollection'),
    kind: 'mongoCollection',
    at: new Date().toISOString(),
    pid: process.pid,
    uri,
    dbName,
    collection,
  });
}

function guardProcess({ pid, port, tag }) {
  return writeRecord({
    id: newId('process'),
    kind: 'process',
    at: new Date().toISOString(),
    ownerPid: process.pid,
    pid,
    port,
    tag,
  });
}

// --- recovery ---------------------------------------------------------------

function undoFile(record, log) {
  if (!fs.existsSync(record.backup)) {
    log(`  ! pristine copy missing for ${record.path} -- CANNOT RESTORE`);
    return false;
  }
  const pristine = fs.readFileSync(record.backup);
  const current = fs.existsSync(record.path) ? fs.readFileSync(record.path) : Buffer.alloc(0);
  const differed = !current.equals(pristine);
  fs.writeFileSync(record.path, pristine);
  const after = fs.readFileSync(record.path);
  const ok = after.equals(pristine);
  log(`  restored ${record.path}${differed ? ' (it had been modified)' : ' (already pristine)'} -> ${ok ? 'verified' : 'VERIFY FAILED'}`);
  return ok;
}

function undoAdbReverse(record, log) {
  try {
    const args = [];
    if (record.serial) args.push('-s', record.serial);
    args.push('reverse', `tcp:${record.devicePort}`, `tcp:${record.originalHostPort}`);
    execFileSync(record.adb, args, { stdio: 'pipe' });
    log(`  restored adb reverse tcp:${record.devicePort} -> tcp:${record.originalHostPort}`);
    return true;
  } catch (err) {
    log(`  ! failed to restore adb reverse tcp:${record.devicePort}: ${err.message}`);
    return false;
  }
}

async function undoMongoCollection(record, log) {
  const { getMongoClient } = require('./mongo');
  const client = await getMongoClient(record.uri);
  try {
    await client.db(record.dbName).collection(record.collection).drop();
    log(`  dropped scratch collection ${record.dbName}.${record.collection}`);
  } catch (err) {
    if (String(err.message).includes('ns not found')) {
      log(`  scratch collection ${record.dbName}.${record.collection} already gone`);
    } else {
      log(`  ! failed to drop ${record.dbName}.${record.collection}: ${err.message}`);
      return false;
    }
  } finally {
    await client.close();
  }
  return true;
}

function undoProcess(record, log) {
  try {
    process.kill(record.pid, 0);
  } catch {
    log(`  spawned process ${record.pid} (${record.tag}) already gone`);
    return true;
  }
  try {
    process.kill(record.pid, 'SIGKILL');
    log(`  killed leftover spawned process ${record.pid} (${record.tag}, port ${record.port})`);
    return true;
  } catch (err) {
    log(`  ! failed to kill ${record.pid}: ${err.message}`);
    return false;
  }
}

/**
 * Is the process that registered this record still running?
 *
 * MEASURED, not assumed, and it is here because it was a real bug. Stage 9
 * Task 4's capture-path control patches a file, relaunches the app on the
 * patched bundle, and then spawns `task4-session.js` as a child to drive the
 * session. The child does what every entry point is required to do -- calls
 * `recoverLeftovers()` first -- found its own still-running PARENT's record,
 * and dutifully restored the file, silently un-patching the control two
 * seconds after the control started. It printed "recovery complete: 1 undone"
 * and the run looked healthy.
 *
 * The semantics were always meant to be "recover mutations from an INTERRUPTED
 * run". A record whose owner is still alive is not a leftover; it is a
 * mutation in progress, and undoing it is the bug. So a live owner is skipped,
 * loudly.
 *
 * `process.kill(pid, 0)` throws ESRCH when no such process exists and EPERM
 * when it exists but belongs to another user -- EPERM still means ALIVE.
 *
 * The residual risk is pid reuse: if the owner died and the OS handed its pid
 * to something else, that record is skipped and its mutation is left on disk
 * until a run whose pid check comes out dead. That is a narrow window against a
 * failure mode that was actually observed, and the skip is printed either way
 * so it can never be silent.
 */
function ownerAlive(record) {
  // ORDER MATTERS. A `process` record stores the OWNER in `ownerPid` and the
  // SPAWNED child in `pid`; every other kind stores the owner in `pid` and has
  // no `ownerPid`. Reading `pid` first would ask "is the leftover API server
  // still running?" -- and answer yes in exactly the case the record exists to
  // clean up, skipping the kill instead of performing it.
  const pid = record.ownerPid ?? record.pid;
  if (!pid) return false;
  // A record carrying THIS process's own pid is either (a) one this process
  // registered a moment ago -- a mutation in progress -- or (b) a dead
  // process's record whose pid the OS has since handed to us. (a) is the
  // dangerous one to get wrong, because undoing it un-does live work, so it
  // wins. (b) leaves a record for a later run to clean up, and the skip is
  // printed either way, so it cannot be silent.
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Undo every leftover mutation from an interrupted run. Call this FIRST in
 * every entry point, before touching anything.
 */
async function recoverLeftovers({ log = console.log } = {}) {
  ensureDir();
  const all = fs
    .readdirSync(LEDGER_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const files = [];
  let skippedLive = 0;
  for (const f of all) {
    let record;
    try {
      record = JSON.parse(fs.readFileSync(path.join(LEDGER_DIR, f), 'utf8'));
    } catch {
      files.push(f);
      continue;
    }
    if (ownerAlive(record)) {
      log(`  [${record.kind}] recorded ${record.at} by pid ${record.ownerPid ?? record.pid} -- OWNER IS STILL RUNNING, leaving it alone (a mutation in progress is not a leftover)`);
      skippedLive += 1;
      continue;
    }
    files.push(f);
  }
  if (files.length === 0) return { found: all.length, recovered: 0, failed: 0, skippedLive };

  log(`\n*** ${files.length} leftover mutation(s) from an interrupted run -- recovering ***`);
  let recovered = 0;
  let failed = 0;
  for (const f of files) {
    let record;
    try {
      record = JSON.parse(fs.readFileSync(path.join(LEDGER_DIR, f), 'utf8'));
    } catch (err) {
      log(`  ! unreadable ledger record ${f}: ${err.message}`);
      failed += 1;
      continue;
    }
    log(`  [${record.kind}] recorded ${record.at} by pid ${record.pid ?? record.ownerPid}`);
    let ok = false;
    if (record.kind === 'file') ok = undoFile(record, log);
    else if (record.kind === 'adbReverse') ok = undoAdbReverse(record, log);
    else if (record.kind === 'mongoCollection') ok = await undoMongoCollection(record, log);
    else if (record.kind === 'process') ok = undoProcess(record, log);
    else log(`  ! unknown record kind ${record.kind}`);
    if (ok) {
      release(record.id);
      recovered += 1;
    } else {
      failed += 1;
    }
  }
  log(`*** recovery complete: ${recovered} undone, ${failed} failed${skippedLive ? `, ${skippedLive} skipped (owner still running)` : ''} ***\n`);
  return { found: all.length, recovered, failed, skippedLive };
}

/** Undo one specific registered mutation now, then drop its record. */
async function undo(id, { log = () => {} } = {}) {
  const p = recordPath(id);
  if (!fs.existsSync(p)) return false;
  const record = JSON.parse(fs.readFileSync(p, 'utf8'));
  let ok = false;
  if (record.kind === 'file') ok = undoFile(record, log);
  else if (record.kind === 'adbReverse') ok = undoAdbReverse(record, log);
  else if (record.kind === 'mongoCollection') ok = await undoMongoCollection(record, log);
  else if (record.kind === 'process') ok = undoProcess(record, log);
  if (ok) release(record.id);
  return ok;
}

function listLeftovers() {
  ensureDir();
  return fs
    .readdirSync(LEDGER_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(LEDGER_DIR, f), 'utf8')));
}

module.exports = {
  LEDGER_DIR,
  guardFile,
  guardAdbReverse,
  guardMongoCollection,
  guardProcess,
  recoverLeftovers,
  listLeftovers,
  undo,
  release,
};
