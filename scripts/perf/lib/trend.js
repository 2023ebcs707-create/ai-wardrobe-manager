'use strict';

/**
 * Trend fitting for Stage 9 Task 4 — the slope of a memory series, with its
 * uncertainty.
 *
 * ## Why not just subtract the endpoints
 *
 * The claim under test is "no memory leaks over 30+ minutes of continuous
 * use". The endpoints of a 30-minute memory series can hide a real rise under
 * one lucky last sample, or manufacture one out of one unlucky first sample.
 * On this handset a single garbage collection or a ZRAM swap-in moves
 * `TOTAL Private Dirty` by tens of MiB between adjacent samples, so first-vs-
 * last is close to a coin toss. A slope fitted across every sample, with a
 * confidence interval, is the only form of the answer that can be wrong in a
 * stated way.
 *
 * ## Why the classical OLS standard error is not enough
 *
 * Memory samples 12 seconds apart are heavily autocorrelated: the process does
 * not forget between samples. Classical OLS standard errors assume independent
 * residuals and are therefore far too small on a series like this — they would
 * declare a confident slope out of ordinary drift. Three uncertainties are
 * reported instead, and the HAC one is the one the verdict uses:
 *
 *   seOls    classical, reported only so the gap is visible
 *   seHac    Newey-West with a Bartlett kernel, lag L stated
 *   bootCi   moving-block residual bootstrap, block length stated
 *
 * ## Why Theil-Sen as well
 *
 * OLS minimises squared error, so a single 60 MiB step — a GC, a swap-in, an
 * image cache flush — can tilt the whole fit. Theil-Sen (the median of all
 * pairwise slopes) is unaffected by up to ~29% of such points. If OLS and
 * Theil-Sen disagree, the series has structure a straight line does not
 * describe, and that disagreement is itself a finding rather than something to
 * average away.
 *
 * ## The decision rule, fixed BEFORE the data was seen
 *
 * `classify()` takes a practical floor in the series' own units per minute. A
 * verdict of "flat" requires the confidence interval to EXCLUDE a leak of that
 * size — not merely to fail to prove one. A session too short or too noisy to
 * exclude a meaningful leak returns INCONCLUSIVE, which is the honest answer
 * and is never rounded to "flat".
 */

// --- t distribution ---------------------------------------------------------

function logGamma(x) {
  const c = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j += 1) ser += c[j] / (y += 1);
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** Continued-fraction evaluation of the incomplete beta function. */
function betacf(a, b, x) {
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-14) break;
  }
  return h;
}

function betai(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** P(T <= t) for Student's t with `df` degrees of freedom. */
function tCdf(t, df) {
  const x = df / (df + t * t);
  const p = 0.5 * betai(df / 2, 0.5, x);
  return t > 0 ? 1 - p : p;
}

/** Two-sided critical value: the t with P(|T| <= t) = conf. Bisection on the CDF. */
function tCrit(conf, df) {
  if (df <= 0) return NaN;
  const target = 1 - (1 - conf) / 2;
  let lo = 0;
  let hi = 100;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// --- the fit ----------------------------------------------------------------

function mean(v) {
  return v.reduce((a, b) => a + b, 0) / v.length;
}

/**
 * Ordinary least squares of y on x, with classical and Newey-West standard
 * errors for the slope.
 *
 * @param {number[]} xs  the independent variable (minutes elapsed here)
 * @param {number[]} ys  the dependent variable (KB here)
 * @param {object}   opts
 * @param {number}   opts.hacLag  Bartlett bandwidth; default is Newey-West's
 *                                own rule floor(4*(n/100)^(2/9)), stated in the
 *                                result so it is never an invisible choice.
 * @param {number}   opts.conf    confidence level for the interval, default .95
 */
function ols(xs, ys, opts = {}) {
  const n = xs.length;
  if (n !== ys.length) throw new Error('trend.ols: x and y differ in length');
  if (n < 3) throw new Error(`trend.ols: n=${n} is too few points to fit a slope with an interval`);
  const conf = opts.conf === undefined ? 0.95 : opts.conf;
  const xbar = mean(xs);
  const ybar = mean(ys);
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - xbar;
    const dy = ys[i] - ybar;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const slope = sxy / sxx;
  const intercept = ybar - slope * xbar;
  const resid = xs.map((x, i) => ys[i] - (intercept + slope * x));
  const ssr = resid.reduce((a, r) => a + r * r, 0);
  const df = n - 2;
  const sigma2 = ssr / df;
  const seOls = Math.sqrt(sigma2 / sxx);
  const r2 = syy === 0 ? null : 1 - ssr / syy;

  const hacLag = opts.hacLag === undefined ? Math.max(1, Math.floor(4 * (n / 100) ** (2 / 9))) : opts.hacLag;
  const z = xs.map((x, i) => (x - xbar) * resid[i]);
  let omega = z.reduce((a, v) => a + v * v, 0);
  for (let l = 1; l <= hacLag; l += 1) {
    const w = 1 - l / (hacLag + 1);
    let s = 0;
    for (let i = l; i < n; i += 1) s += z[i] * z[i - l];
    omega += 2 * w * s;
  }
  // Small-sample correction n/(n-2), the same df adjustment the classical SE
  // carries. Omega can go negative for a badly chosen bandwidth; say so rather
  // than returning NaN quietly.
  const varHac = (omega * (n / df)) / (sxx * sxx);
  const seHac = varHac > 0 ? Math.sqrt(varHac) : null;

  const tc = tCrit(conf, df);
  return {
    n,
    slope,
    intercept,
    r2,
    df,
    conf,
    seOls,
    ciOls: [slope - tc * seOls, slope + tc * seOls],
    hacLag,
    seHac,
    ciHac: seHac === null ? null : [slope - tc * seHac, slope + tc * seHac],
    hacNegativeVariance: seHac === null,
    tCrit: tc,
    residuals: resid,
    residualSd: Math.sqrt(sigma2),
    sxx,
  };
}

/** Median of all pairwise slopes. Resistant to ~29% of arbitrary outliers. */
function theilSen(xs, ys) {
  const slopes = [];
  for (let i = 0; i < xs.length; i += 1) {
    for (let j = i + 1; j < xs.length; j += 1) {
      const dx = xs[j] - xs[i];
      if (dx !== 0) slopes.push((ys[j] - ys[i]) / dx);
    }
  }
  slopes.sort((a, b) => a - b);
  const m = slopes.length;
  const median = m % 2 ? slopes[(m - 1) / 2] : (slopes[m / 2 - 1] + slopes[m / 2]) / 2;
  const q = (p) => slopes[Math.min(m - 1, Math.max(0, Math.ceil(p * m) - 1))];
  return { slope: median, pairs: m, p025: q(0.025), p975: q(0.975) };
}

/** A deterministic PRNG, so a bootstrap CI is reproducible from its seed. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Moving-block residual bootstrap for the OLS slope.
 *
 * Blocks of consecutive residuals are resampled with replacement and laid back
 * over the fitted line, which preserves short-range autocorrelation that an
 * i.i.d. residual bootstrap would destroy — and destroying it is exactly how a
 * bootstrap comes back with a fake-tight interval on a memory series.
 */
function blockBootstrapSlope(xs, ys, fit, opts = {}) {
  const n = xs.length;
  const block = opts.block === undefined ? Math.max(2, Math.ceil(n ** (1 / 3))) : opts.block;
  const reps = opts.reps === undefined ? 4000 : opts.reps;
  const seed = opts.seed === undefined ? 20260826 : opts.seed;
  const rnd = mulberry32(seed);
  const resid = fit.residuals;
  const nBlocks = Math.ceil(n / block);
  const maxStart = n - block;
  const out = [];
  for (let r = 0; r < reps; r += 1) {
    const u = [];
    for (let b = 0; b < nBlocks; b += 1) {
      const start = Math.floor(rnd() * (maxStart + 1));
      for (let k = 0; k < block && u.length < n; k += 1) u.push(resid[start + k]);
    }
    const ystar = xs.map((x, i) => fit.intercept + fit.slope * x + u[i]);
    let sxy = 0;
    const xbar = mean(xs);
    const ybar = mean(ystar);
    for (let i = 0; i < n; i += 1) sxy += (xs[i] - xbar) * (ystar[i] - ybar);
    out.push(sxy / fit.sxx);
  }
  out.sort((a, b) => a - b);
  const q = (p) => out[Math.min(out.length - 1, Math.max(0, Math.ceil(p * out.length) - 1))];
  return { block, reps, seed, ci: [q(0.025), q(0.975)], median: q(0.5) };
}

/**
 * The pre-registered verdict.
 *
 * @param {object} fit    an `ols()` result, slope in units per minute
 * @param {number} floor  the practically meaningful slope, same units per minute
 * @param {[number,number]} ci  the interval the verdict uses (HAC by default)
 *
 * RISING        the interval is entirely above zero AND the slope reaches the floor
 * FALLING       the interval is entirely below zero AND the slope reaches -floor
 * FLAT          the interval lies entirely inside +/- floor: a leak of at least
 *               the floor size is EXCLUDED, which is what "no memory leak" has
 *               to mean for it to be a claim rather than a hope
 * DRIFTING      the interval excludes zero but does not reach the floor: real,
 *               below the size that was pre-declared as mattering
 * INCONCLUSIVE  the interval spans the floor: this session cannot rule a
 *               meaningful leak in or out
 */
function classify(fit, floor, ci) {
  const interval = ci || fit.ciHac || fit.ciOls;
  const [lo, hi] = interval;
  const excludesZero = lo > 0 || hi < 0;
  const excludesFloorLeak = hi < floor;
  const base = { interval, floor, excludesZero, excludesFloorLeak };
  // ORDER MATTERS and it is deliberately the unflattering one. An interval
  // like [+0.05, +0.35] with a floor of 0.5 satisfies BOTH "excludes a leak of
  // floor size" and "excludes zero". Reporting that as FLAT would be choosing
  // the friendlier of two true descriptions, so DRIFTING is tested first and
  // FLAT is reserved for an interval that also contains zero.
  if (lo > 0 && fit.slope >= floor) return { verdict: 'RISING', ...base };
  if (hi < 0 && fit.slope <= -floor) return { verdict: 'FALLING', ...base };
  if (excludesZero) return { verdict: 'DRIFTING', ...base };
  if (lo > -floor && hi < floor) return { verdict: 'FLAT', ...base };
  return { verdict: 'INCONCLUSIVE', ...base };
}

/** Everything about one series, in one object. */
function analyse(xs, ys, opts = {}) {
  const fit = ols(xs, ys, opts);
  const ts = theilSen(xs, ys);
  const boot = blockBootstrapSlope(xs, ys, fit, opts);
  const floor = opts.floor;
  return {
    fit: { ...fit, residuals: undefined },
    residuals: fit.residuals,
    theilSen: ts,
    bootstrap: boot,
    verdictHac: floor === undefined ? null : classify(fit, floor, fit.ciHac),
    verdictBootstrap: floor === undefined ? null : classify(fit, floor, boot.ci),
    firstLast: { first: ys[0], last: ys[ys.length - 1], delta: ys[ys.length - 1] - ys[0] },
    span: { xFirst: xs[0], xLast: xs[xs.length - 1] },
  };
}

/**
 * Would this instrument have seen a leak?
 *
 * Adds a synthetic linear ramp of `rate` units per minute to the observed
 * series and re-runs the identical fit. Because the ramp is laid over the REAL
 * residual structure of this rig, the answer is a statement about this
 * session's noise, not about an invented one.
 */
function sensitivitySweep(xs, ys, rates, opts = {}) {
  const x0 = xs[0];
  return rates.map((rate) => {
    const injected = ys.map((y, i) => y + rate * (xs[i] - x0));
    const a = analyse(xs, injected, opts);
    return {
      rate,
      slope: a.fit.slope,
      ciHac: a.fit.ciHac,
      verdict: a.verdictHac ? a.verdictHac.verdict : null,
      // "Detected" means the instrument SAW AN UPWARD TREND: the HAC interval
      // excludes zero on the positive side. It is deliberately not
      // `verdict === 'RISING'`, because RISING additionally requires the slope
      // to reach the practical floor, which no injected rate below the floor
      // can ever do — scoring detection that way would make the sweep answer a
      // different question than "would this have been visible".
      detected: a.fit.ciHac ? a.fit.ciHac[0] > 0 : null,
      ciBootstrap: a.bootstrap.ci,
      detectedBootstrap: a.bootstrap.ci[0] > 0,
    };
  });
}

module.exports = { ols, theilSen, blockBootstrapSlope, classify, analyse, sensitivitySweep, tCrit, tCdf, mean };
