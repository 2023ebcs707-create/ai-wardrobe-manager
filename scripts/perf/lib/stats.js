'use strict';

/**
 * Distribution statistics for the Stage 9 measurement harness.
 *
 * Stage 9's global constraints require "the distribution, not just the middle":
 * a median that meets a claim while p95 misses it by 3x is a claim that does
 * not hold, and reporting only the median hides that. Every measurement in
 * this harness therefore reports min / median / p95 / max with the sample size
 * and how many warm-up samples were discarded to produce it.
 *
 * PERCENTILE METHOD (stated because it changes the number on small samples):
 * nearest-rank on the ascending sorted sample -- p95 of n samples is element
 * ceil(0.95 * n), 1-indexed. For n = 20 that is the 19th value, i.e. the
 * second-worst. No interpolation. Nearest-rank was chosen over linear
 * interpolation because it always returns a value that was actually observed,
 * which matters when the number is going to be compared against a claim: an
 * interpolated p95 of 2.1 s can be reported for a run in which no sample was
 * anywhere near 2.1 s.
 */

function sortedCopy(values) {
  return [...values].sort((a, b) => a - b);
}

/** Nearest-rank percentile. `p` is a fraction in [0, 1]. */
function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = sortedCopy(values);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1];
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * @param {number[]} values      the retained samples (warm-up already removed)
 * @param {object}   opts
 * @param {number}   opts.warmupDiscarded how many samples were dropped before these
 * @param {string}   opts.unit
 */
function summarise(values, opts = {}) {
  const { warmupDiscarded = 0, unit = 'ms' } = opts;
  const sorted = sortedCopy(values);
  return {
    n: values.length,
    warmupDiscarded,
    unit,
    min: sorted.length ? sorted[0] : null,
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: sorted.length ? sorted[sorted.length - 1] : null,
    mean: mean(values),
    samples: sorted,
  };
}

function round(x, dp = 2) {
  if (x === null || x === undefined || Number.isNaN(x)) return null;
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

/** One-line human form, e.g. "min 3.10 / med 4.02 / p95 6.71 / max 9.88 ms (n=20, 3 warm-up discarded)" */
function formatSummary(s, dp = 2) {
  return (
    `min ${round(s.min, dp)} / med ${round(s.median, dp)} / p95 ${round(s.p95, dp)} / ` +
    `max ${round(s.max, dp)} ${s.unit} (n=${s.n}, ${s.warmupDiscarded} warm-up discarded)`
  );
}

/** Compact form without the sample-size tail, for table cells. */
function formatCell(s, dp = 2) {
  return `${round(s.min, dp)} / ${round(s.median, dp)} / ${round(s.p95, dp)} / ${round(s.max, dp)}`;
}

/**
 * The verdict a negative control produces.
 *
 * `moved` is the only thing that decides whether the metric is trusted. The
 * threshold is a RATIO on the median, defaulted to 1.5x, and the direction is
 * explicit: a control that inflates a payload must make the number bigger, and
 * a control that made it smaller is a failed control, not a passed one.
 */
function controlVerdict(baseline, controlled, opts = {}) {
  const { minRatio = 1.5, direction = 'up', key = 'median' } = opts;
  const before = baseline[key];
  const after = controlled[key];
  if (before === null || after === null || before === 0) {
    return { moved: false, ratio: null, reason: 'no baseline to compare against' };
  }
  const ratio = after / before;
  const moved = direction === 'up' ? ratio >= minRatio : ratio <= 1 / minRatio;
  return { moved, ratio, before, after, direction, minRatio, key };
}

module.exports = { percentile, mean, summarise, formatSummary, formatCell, controlVerdict, round };
