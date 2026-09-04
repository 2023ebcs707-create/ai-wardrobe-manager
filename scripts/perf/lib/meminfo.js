'use strict';

/**
 * `dumpsys meminfo` parsing for the Stage 9 harness.
 *
 * ## Why this file exists and where the code came from
 *
 * `task3-memory.js` carries a `parseFull` that was fixed in Task 3's fix round
 * after it silently returned `rows: {}` for 75 consecutive samples: this
 * handset splits the per-mapping table's column headings across TWO lines
 * ("... Heap Heap Heap" then "... Size Alloc Free"), so the original
 * /Heap\s+Free/ anchor never matched and every row-level distribution came back
 * n=0 with nothing saying so.
 *
 * Task 4 trends `TOTAL Private Dirty` across a 30-minute session, so it needs
 * exactly that parser. `task3-memory.js` is a completed task's artefact and is
 * an IIFE that runs on require, so it cannot be imported. The function below is
 * a VERBATIM COPY of the fixed `parseFull`, and `task4-parser-equivalence.js`
 * proves the copy is faithful: it lifts the `parseFull` source text out of
 * `task3-memory.js`, evaluates it, and asserts both produce byte-identical JSON
 * on real device output. A copied parser whose fidelity is asserted rather than
 * checked is how the original bug survived 75 samples.
 *
 * ## What a leak metric has to survive on this handset: ZRAM
 *
 * This device swaps aggressively. A live dump taken before Task 4's session
 * read `TOTAL Private Dirty 99,984 KB` with `TOTAL SWAP PSS 248,288 KB` on a
 * process Task 3 had measured at `TOTAL Private Dirty 393,416 KB`. Nothing was
 * freed — 248 MiB of dirty pages had been compressed into ZRAM while the app
 * sat idle, and `Private Dirty` no longer counts them.
 *
 * That matters more to a SLOPE than to a level. Driving an idle app back into
 * continuous use pages those compressed dirty pages back in, which makes
 * `Private Dirty` climb steeply for reasons that are not a leak; letting it go
 * quiet does the reverse. So this module also exposes the swap-inclusive
 * figure, `TOTAL Private Dirty + TOTAL SWAP PSS`, which counts a dirty page
 * once whether it is resident or compressed. Both are reported. Neither is
 * chosen after the fact.
 */

/** Parse every row of `dumpsys meminfo`, not a chosen one. */
function parseFull(text) {
  const out = { pid: null, rows: {}, summary: {}, totals: {}, objects: {}, nativeAllocations: {} };
  const pidM = text.match(/MEMINFO in pid (\d+)/);
  if (pidM) out.pid = Number(pidM[1]);
  // The per-mapping table's column headings are split across TWO lines on this
  // handset ("... Heap Heap Heap" / "... Size Alloc Free"), so an earlier
  // /Heap\s+Free/ anchor never matched and every `rows` object came back empty
  // for all 75 samples of the first capture. Anchor on the second heading line
  // and the dashed rule beneath it instead. See the report's §6.1.
  const tableM = text.match(/Alloc\s+Free\r?\n[ \t-]*\r?\n([\s\S]*?)\r?\n[ \t]*\r?\n/);
  if (tableM) {
    for (const line of tableM[1].split('\n')) {
      const m = line.match(/^\s*([A-Za-z.][A-Za-z. ]*[A-Za-z])\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/);
      if (m) out.rows[m[1].trim()] = { pssKb: Number(m[2]), privateDirtyKb: Number(m[3]), privateCleanKb: Number(m[4]), swapPssKb: Number(m[5]), rssKb: Number(m[6]) };
    }
  }
  const sumM = text.match(/App Summary[\s\S]*?------\s*\n([\s\S]*?)\n\s*\n/);
  if (sumM) {
    for (const line of sumM[1].split('\n')) {
      const m = line.match(/^\s*([A-Za-z ]+):\s+(\d+)(?:\s+(\d+))?/);
      if (m) out.summary[m[1].trim().toLowerCase().replace(/\s+/g, '_')] = { pssKb: Number(m[2]), rssKb: m[3] ? Number(m[3]) : null };
    }
  }
  const t = text.match(/TOTAL PSS:\s*(\d+)\s+TOTAL RSS:\s*(\d+)\s+TOTAL SWAP(?: PSS)?(?: \(KB\))?:\s*(\d+)/);
  if (t) out.totals = { totalPssKb: Number(t[1]), totalRssKb: Number(t[2]), totalSwapPssKb: Number(t[3]) };
  for (const [k, re] of [['views', /Views:\s*(\d+)/], ['activities', /Activities:\s*(\d+)/], ['appContexts', /AppContexts:\s*(\d+)/]]) {
    const m = text.match(re); if (m) out.objects[k] = Number(m[1]);
  }
  const bm = text.match(/Bitmap \(malloced\):\s*(\d+)\s+(\d+)/);
  const bn = text.match(/Bitmap \(nonmalloced\):\s*(\d+)\s+(\d+)/);
  if (bm) out.nativeAllocations.bitmapMalloced = { count: Number(bm[1]), totalKb: Number(bm[2]) };
  if (bn) out.nativeAllocations.bitmapNonMalloced = { count: Number(bn[1]), totalKb: Number(bn[2]) };
  return out;
}

/**
 * The three `Heap Size / Heap Alloc / Heap Free` columns, which `parseFull`
 * drops.
 *
 * WHY THIS IS A SEPARATE FUNCTION AND NOT A WIDER REGEX IN `parseFull`:
 * `task4-parser-equivalence.js` asserts that `parseFull` above is BYTE-FOR-BYTE
 * the function Task 3 fixed, by lifting its source out of `task3-memory.js` and
 * comparing the JSON both produce on live device output. Widening `parseFull`'s
 * row regex would add keys to `rows` and break that proof — which is the one
 * thing standing between this harness and Task 3's silent `rows: {}` bug. So
 * the extra columns are parsed here, beside it, and the equivalence proof is
 * left intact.
 *
 * WHY THE COLUMNS MATTER: `Native Heap Pss` counts pages the allocator holds
 * from the kernel. `Heap Alloc` counts bytes the program has actually asked for
 * and not yet freed. A process that churns allocations can grow its arena
 * (`Heap Size`, and therefore Pss) without retaining anything, and the two are
 * only distinguishable if `Heap Alloc` is trended too. Task 4's first round
 * trended Pss alone and could not exclude allocator arena growth.
 */
function parseHeapCounters(text) {
  const out = {};
  for (const [key, label] of [['native', 'Native Heap'], ['dalvik', 'Dalvik Heap']]) {
    const re = new RegExp(`^\\s*${label}\\s+(-?\\d+)\\s+(-?\\d+)\\s+(-?\\d+)\\s+(-?\\d+)\\s+(-?\\d+)\\s+(-?\\d+)\\s+(-?\\d+)\\s+(-?\\d+)\\s*$`, 'm');
    const m = text.match(re);
    if (m) out[key] = { heapSizeKb: Number(m[6]), heapAllocKb: Number(m[7]), heapFreeKb: Number(m[8]) };
  }
  // `Unknown:` in the App Summary prints only an Rss figure -- its Pss column is
  // blank. `parseFull`'s summary regex therefore reads that Rss number into
  // `summary.unknown.pssKb`, which it is NOT. Captured correctly here, and
  // `series()` below never reads `summary.unknown`.
  const u = text.match(/^\s*Unknown:\s+(\d+)\s*$/m);
  if (u) out.unknownRssKb = Number(u[1]);
  return out;
}

/**
 * Parse, and REFUSE to return a sample whose row table did not parse.
 *
 * Task 3's silent `rows: {}` is the reason. An instrument that cannot measure
 * has to say so; it must not hand back an empty object that a downstream
 * summariser will quietly print as n=0.
 */
function parseStrict(text, context = '') {
  const r = parseFull(text);
  if (Object.keys(r.rows).length === 0) {
    throw new Error(`meminfo: the per-mapping table did not parse${context ? ` (${context})` : ''}. Refusing to record a sample with no rows.`);
  }
  if (!r.rows.TOTAL) {
    throw new Error(`meminfo: no TOTAL row${context ? ` (${context})` : ''}. Refusing to record a sample without the row this task trends.`);
  }
  if (r.totals.totalPssKb === undefined) {
    throw new Error(`meminfo: no TOTAL PSS line${context ? ` (${context})` : ''}.`);
  }
  r.heap = parseHeapCounters(text);
  return r;
}

/**
 * The series Task 4 trends, all of them, from one parsed sample.
 *
 * `privateDirtyPlusSwapKb` is the swap-inclusive dirty footprint described in
 * this file's header. It is reported BESIDE `privateDirtyKb`, never instead of
 * it.
 */
function series(r) {
  const total = r.rows.TOTAL;
  return {
    totalPrivateDirtyKb: total.privateDirtyKb,
    totalSwapPssKb: r.totals.totalSwapPssKb,
    privateDirtyPlusSwapKb: total.privateDirtyKb + r.totals.totalSwapPssKb,
    totalPssKb: r.totals.totalPssKb,
    totalRssKb: r.totals.totalRssKb,
    totalPrivateCleanKb: total.privateCleanKb,
    javaHeapPssKb: r.summary.java_heap ? r.summary.java_heap.pssKb : null,
    nativeHeapPssKb: r.summary.native_heap ? r.summary.native_heap.pssKb : null,
    graphicsPssKb: r.summary.graphics ? r.summary.graphics.pssKb : null,
    codePssKb: r.summary.code ? r.summary.code.pssKb : null,
    dalvikHeapPssKb: r.rows['Dalvik Heap'] ? r.rows['Dalvik Heap'].pssKb : null,
    nativeHeapRowPssKb: r.rows['Native Heap'] ? r.rows['Native Heap'].pssKb : null,
    eglMtrackPssKb: r.rows['EGL mtrack'] ? r.rows['EGL mtrack'].pssKb : null,
    glMtrackPssKb: r.rows['GL mtrack'] ? r.rows['GL mtrack'].pssKb : null,
    // The App Summary's Pss rows sum EXACTLY to TOTAL PSS on this handset
    // (45136 + 199444 + 67656 + 2532 + 98068 + 26832 + 7737 = 447405). The
    // first round of Task 4 trended only four of the seven and left the
    // remainder unnamed; all seven are recorded here so no part of a rise has
    // to be attributed by subtraction.
    stackPssKb: r.summary.stack ? r.summary.stack.pssKb : null,
    privateOtherPssKb: r.summary.private_other ? r.summary.private_other.pssKb : null,
    systemPssKb: r.summary.system ? r.summary.system.pssKb : null,
    unknownRssKb: r.heap && r.heap.unknownRssKb !== undefined ? r.heap.unknownRssKb : null,
    // Retained allocation vs allocator arena growth -- see `parseHeapCounters`.
    nativeHeapSizeKb: r.heap && r.heap.native ? r.heap.native.heapSizeKb : null,
    nativeHeapAllocKb: r.heap && r.heap.native ? r.heap.native.heapAllocKb : null,
    nativeHeapFreeKb: r.heap && r.heap.native ? r.heap.native.heapFreeKb : null,
    dalvikHeapAllocKb: r.heap && r.heap.dalvik ? r.heap.dalvik.heapAllocKb : null,
    bitmapTotalKb:
      ((r.nativeAllocations.bitmapMalloced || {}).totalKb || 0) +
      ((r.nativeAllocations.bitmapNonMalloced || {}).totalKb || 0),
    views: r.objects.views === undefined ? null : r.objects.views,
    activities: r.objects.activities === undefined ? null : r.objects.activities,
    appContexts: r.objects.appContexts === undefined ? null : r.objects.appContexts,
  };
}

module.exports = { parseFull, parseStrict, parseHeapCounters, series };
