'use strict';

/**
 * Proof that `lib/meminfo.js`'s `parseFull` is the SAME parser Task 3 fixed.
 *
 * Task 4 needs Task 3's fixed `dumpsys meminfo` parser. `task3-memory.js` is a
 * completed task's artefact and an IIFE that would launch the app and start
 * sampling on require, so it cannot be imported; the function was copied into
 * `lib/meminfo.js` instead. A copy is a claim, and this file is what turns it
 * into a check: it lifts the `parseFull` SOURCE TEXT out of `task3-memory.js`,
 * evaluates that text in isolation, and asserts both parsers produce identical
 * JSON on live device output.
 *
 * Run against real captures, never a fixture invented here — the original bug
 * was invisible precisely because it only appeared on this handset's two-line
 * column headings.
 *
 *   node scripts/perf/task4-parser-equivalence.js <dumpsys-capture.txt> [...]
 */

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const mine = require('./lib/meminfo');

const T3 = path.join(__dirname, 'task3-memory.js');

function liftParseFullFromTask3() {
  const src = fs.readFileSync(T3, 'utf8');
  const start = src.indexOf('function parseFull(text) {');
  if (start === -1) throw new Error('could not find parseFull in task3-memory.js');
  const end = src.indexOf('\n}\n', start);
  if (end === -1) throw new Error('could not find the end of parseFull in task3-memory.js');
  const body = src.slice(start, end + 3);
  // eslint-disable-next-line no-new-func
  return new Function(`${body}; return parseFull;`)();
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node scripts/perf/task4-parser-equivalence.js <dumpsys-capture.txt> [...]');
  process.exit(2);
}

const task3ParseFull = liftParseFullFromTask3();
let checked = 0;
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  const a = task3ParseFull(text);
  const b = mine.parseFull(text);
  assert.deepStrictEqual(b, a, `parsers disagree on ${f}`);
  assert.ok(Object.keys(a.rows).length > 0, `${f}: task3 parser produced NO ROWS — this capture cannot prove anything`);
  assert.ok(a.rows.TOTAL, `${f}: no TOTAL row`);
  console.log(
    `  ${path.basename(f)}: identical — ${Object.keys(a.rows).length} rows, ` +
      `TOTAL privateDirty=${a.rows.TOTAL.privateDirtyKb} KB, TOTAL PSS=${a.totals.totalPssKb} KB`
  );
  checked += 1;
}
console.log(`\nPARSER EQUIVALENCE: PASS — ${checked} live capture(s), lib/meminfo.js === task3-memory.js parseFull`);
