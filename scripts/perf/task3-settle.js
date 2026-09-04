'use strict';

/**
 * STAGE 9 TASK 3 — what "settled" means, and why it is neither of the two
 * obvious definitions.
 *
 * A frame-difference series says WHEN the screen changed. Turning that into "how
 * long did the dashboard take to load" needs a rule, and the rule IS the
 * measurement, so it is written down here rather than chosen per result.
 *
 * ## Two definitions that were tried and are both wrong
 *
 * **"The first pause is the end."** Stage 9 Task 1 measured 107 ms for a
 * workload that visibly moved the screen for 1.4 s: real screen activity is
 * punctuated — a list snaps, pauses two frames, carries on.
 *
 * **"The last change is the end."** This is what `measure-device.js` settled on,
 * and it is what this task used first. On a cold launch it measured 11.9-25.2 s
 * for a wardrobe that had finished painting at 4.5 s. The change bursts of five
 * consecutive cold-launch samples, with the app's own content complete by the
 * end of the FIRST burst in every one:
 *
 *     2.06-4.49s(91f)  8.80s(1f)  13.95-14.15s(3f)  24.87-24.90s(4f)
 *     0.55-4.73s(100f)                13.62-13.83s(23f)
 *     2.07-4.46s(90f)                 14.09s(1f)
 *     1.98-4.26s(86f)  13.79-13.90s(12f)          27.14s(1f)
 *     2.07-4.26s(87f)  13.89-13.98s(9f)  15.37-15.63s(5f)  19.89-20.42s(4f)
 *
 * Isolated redraws seconds after the screen is complete — one of them Expo Go's
 * own "Tools" dev-menu bubble fading out of the corner, verified by extracting
 * frames at t=8.0 s and t=13.0 s and seeing it present and then gone. None of
 * them is the dashboard loading, and "last change anywhere in a 30 s recording"
 * counts every one.
 *
 * ## The definition used
 *
 * THE TRANSITION IS THE MAXIMAL RUN OF CHANGING FRAMES THAT BEGINS AT THE FIRST
 * CHANGE AND CONTAINS NO INTERNAL GAP LONGER THAN `gapS`. Everything after the
 * first gap longer than `gapS` is a later, separate redraw and is reported
 * separately, never folded in.
 *
 * `gapS` is a stated parameter, not a tuned one, and it is VALIDATED BY THE
 * NEGATIVE CONTROL rather than by looking plausible: with a 500 ms per-request
 * delay injected into the handset's own network path, this definition must still
 * move. It does — see the report. A definition that made the control stop
 * responding would be a definition that had optimised the number instead of
 * measuring it.
 *
 * Every result also carries `lastChangeAnywhereMs` and the full burst list, so a
 * reader can apply a different rule to the same recording without re-recording.
 */

const fs = require('node:fs');
const { summarise } = require('./lib/stats');

const DEFAULT_GAP_S = 2.0;

/** Split a change series into bursts separated by gaps longer than `gapS`. */
function bursts(series, { threshold = 0.5, gapS = DEFAULT_GAP_S } = {}) {
  const changing = series.filter((s) => s.change > threshold);
  const out = [];
  let last = null;
  for (const p of changing) {
    if (last === null || p.t - last > gapS) out.push({ startT: p.t, endT: p.t, frames: 1 });
    else { out[out.length - 1].endT = p.t; out[out.length - 1].frames += 1; }
    last = p.t;
  }
  return out;
}

function reduce(series, { threshold = 0.5, gapS = DEFAULT_GAP_S, recordedSpanS, quietMarginS = 2.0 } = {}) {
  const b = bursts(series, { threshold, gapS });
  if (b.length === 0) {
    return { transitionMs: null, settled: false, bursts: b, lastChangeAnywhereT: null, laterBursts: 0 };
  }
  const first = b[0];
  const lastAnywhere = b[b.length - 1].endT;
  // The recorder ran `recordedSpanS` of its own clock. A transition that ends
  // within `quietMarginS` of that is not proven to have finished.
  const quietAfter = recordedSpanS - first.endT;
  return {
    transitionMs: (first.endT - first.startT) * 1000,
    transitionStartT: first.startT,
    transitionEndT: first.endT,
    transitionFrames: first.frames,
    settled: quietAfter >= quietMarginS,
    quietAfterTransitionS: quietAfter,
    lastChangeAnywhereT: lastAnywhere,
    lastChangeAnywhereMs: (lastAnywhere - first.startT) * 1000,
    laterBursts: b.length - 1,
    bursts: b,
  };
}

module.exports = { bursts, reduce, DEFAULT_GAP_S };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
  const file = arg('--screen');
  const gapS = Number(arg('--gap', String(DEFAULT_GAP_S)));
  const threshold = Number(arg('--threshold', '0.5'));
  const useCropped = argv.includes('--cropped');
  const out = arg('--out', null);
  const S = JSON.parse(fs.readFileSync(file, 'utf8'));
  const span = S.method ? S.method.recordingSeconds : S.recordingSeconds;
  const rows = S.seriesBySample.map((b, i) => {
    const ser = useCropped && b.croppedSeries ? b.croppedSeries : b.series;
    return { label: b.label, ...reduce(ser, { threshold, gapS, recordedSpanS: span }), raw: S.raw[i] };
  });
  const usable = rows.filter((r) => r.settled && r.transitionMs !== null);
  const payload = {
    screen: file,
    region: useCropped ? `cropped ${S.crop}` : 'full frame',
    definition: `transition = maximal run of changing frames from the first change with no internal gap > ${gapS}s; threshold ${threshold} mean-luma difference`,
    recordingSeconds: span,
    hostLoad: S.hostLoad,
    at: S.at,
    samples: rows.length,
    discardedNotSettled: rows.length - usable.length,
    transitionMs: summarise(usable.map((r) => r.transitionMs), { unit: 'ms' }),
    lastChangeAnywhereMs: summarise(usable.map((r) => r.lastChangeAnywhereMs), { unit: 'ms' }),
    perSample: rows.map((r) => ({
      label: r.label,
      transitionMs: r.transitionMs,
      transitionStartT: r.transitionStartT,
      transitionEndT: r.transitionEndT,
      settled: r.settled,
      laterBursts: r.laterBursts,
      lastChangeAnywhereMs: r.lastChangeAnywhereMs,
      bursts: r.bursts.map((x) => `${x.startT.toFixed(2)}-${x.endT.toFixed(2)}s(${x.frames}f)`),
      amStartTotalTimeMs: r.raw.actionResult ? r.raw.actionResult.totalTimeMs : null,
    })),
  };
  if (out) fs.writeFileSync(out, JSON.stringify(payload, null, 2));
  const t = payload.transitionMs; const l = payload.lastChangeAnywhereMs;
  const f = (x) => (x === null || x === undefined ? 'n/a' : x.toFixed(0));
  console.log(`${file}  [${payload.region}]  gap=${gapS}s`);
  console.log(`  transition ms       min=${f(t.min)} med=${f(t.median)} p95=${f(t.p95)} max=${f(t.max)}  n=${t.n}`);
  console.log(`  last-change-anywhere min=${f(l.min)} med=${f(l.median)} p95=${f(l.p95)} max=${f(l.max)}  n=${l.n}`);
  for (const p of payload.perSample) console.log(`   ${p.label} transition=${f(p.transitionMs)}ms laterBursts=${p.laterBursts}  ${p.bursts.join(' ')}`);
}
