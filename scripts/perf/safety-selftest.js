'use strict';

/**
 * Proves the crash-safe ledger actually survives `kill -9`.
 *
 * The Stage 9 constraint is blunt: "`kill -9` cannot run a `finally` -- write
 * each file's pristine copy to disk BEFORE patching and recover leftovers on
 * startup. An interrupted harness in Stage 8 left two mutations on disk and
 * `pnpm typecheck` passed with both applied, one of them a live bug."
 *
 * A claim that a harness is crash-safe is worth nothing unless the crash has
 * been performed. This does it: a child process registers a file, corrupts it,
 * and then SIGKILLs ITSELF -- no exit handler, no `finally`, no chance to tidy
 * up. The parent then confirms the file is corrupt on disk, runs the ordinary
 * startup recovery, and confirms the file is byte-identical to the original
 * again and the ledger is empty.
 *
 *   node scripts/perf/safety-selftest.js
 */

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const safety = require('./lib/safety');

const SCRATCH_DIR = path.join(__dirname, '.selftest');
const SCRATCH = path.join(SCRATCH_DIR, 'pristine-victim.txt');
const PRISTINE = 'this is the pristine content the harness must restore\n';

const CHILD = `
const safety = require(${JSON.stringify(path.join(__dirname, 'lib', 'safety.js'))});
const fs = require('node:fs');
// 1. register the undo BEFORE mutating -- this is the ordering the whole
//    mechanism depends on
safety.guardFile(${JSON.stringify(SCRATCH)});
// 2. mutate
fs.writeFileSync(${JSON.stringify(SCRATCH)}, 'CORRUPTED BY THE SELF-TEST\\n');
// 3. die in a way that runs nothing: no finally, no exit hook, no atexit
process.kill(process.pid, 'SIGKILL');
`;

function main() {
  fs.mkdirSync(SCRATCH_DIR, { recursive: true });
  fs.writeFileSync(SCRATCH, PRISTINE);
  const before = crypto.createHash('sha256').update(fs.readFileSync(SCRATCH)).digest('hex');

  const child = spawnSync(process.execPath, ['-e', CHILD], { encoding: 'utf8' });
  const killed = child.signal === 'SIGKILL';

  const afterKill = fs.readFileSync(SCRATCH, 'utf8');
  const leftovers = safety.listLeftovers();

  const checks = [];
  checks.push(['child died by SIGKILL (no cleanup could run)', killed, `signal=${child.signal}`]);
  checks.push(['file was left corrupted on disk', afterKill !== PRISTINE, JSON.stringify(afterKill)]);
  checks.push(['ledger recorded the mutation', leftovers.some((r) => r.kind === 'file' && r.path === SCRATCH), `${leftovers.length} record(s)`]);

  return safety.recoverLeftovers().then(() => {
    const restored = fs.readFileSync(SCRATCH, 'utf8');
    const after = crypto.createHash('sha256').update(fs.readFileSync(SCRATCH)).digest('hex');
    checks.push(['recovery restored the file byte for byte', after === before, `${before.slice(0, 12)} vs ${after.slice(0, 12)}`]);
    checks.push(['ledger is empty afterwards', safety.listLeftovers().length === 0, `${safety.listLeftovers().length} record(s)`]);

    let ok = true;
    for (const [name, pass, detail] of checks) {
      console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
      if (!pass) ok = false;
    }
    fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
    console.log(ok ? '\ncrash-safe ledger: PROVEN under SIGKILL' : '\ncrash-safe ledger: FAILED');
    process.exit(ok ? 0 : 1);
  });
}

// Guarded like every other entry point here: `require`-ing this file must not
// stage a crash and a recovery as a side effect of being loaded.
if (require.main === module) {
  main();
}
