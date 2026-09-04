'use strict';

/**
 * METRIC CLASS: server-cpu.
 *
 * Samples one process's CPU with macOS `top` in logging mode
 * (`top -l N -s 1 -pid <pid> -stats pid,cpu`), which reports the CPU used
 * DURING each interval.
 *
 * WHY NOT `ps -o %cpu`. `ps` reports an average over the process's whole
 * lifetime, so a server that has been idle for two minutes and is now pinned
 * still reads a few percent. Under a twenty-second load test that is not a
 * measurement of anything -- and it is the reading a harness gets by default,
 * which is how a CPU number that never moves gets published.
 *
 * WARM-UP POLICY. `top`'s FIRST sample is also a since-launch average for the
 * same reason; only the second and later samples cover a real interval. The
 * first sample is therefore always discarded, and that is not a tuning choice
 * -- with it included, every short measurement is biased toward whatever the
 * process was doing before the measurement began.
 *
 * UNITS, stated because the claim is a percentage and percentages of what
 * differ. macOS `top` reports %CPU where 100% is ONE core fully used. This
 * host has 15 logical cores, so a process at 300% is using three cores, which
 * is 20% of the machine. Both numbers are reported: `percentOfOneCore` (what
 * top printed) and `percentOfMachine` (divided by the core count). Claim 10
 * says "backend server CPU utilization remains below 30%" without saying
 * which, and the harness must not silently pick the flattering one.
 */

const { execFile } = require('node:child_process');
const os = require('node:os');
const { summarise, formatSummary } = require('./lib/stats');

const CORES = os.cpus().length;

function runTop(pid, samples, intervalSeconds) {
  return new Promise((resolve, reject) => {
    execFile(
      'top',
      ['-l', String(samples), '-s', String(intervalSeconds), '-pid', String(pid), '-stats', 'pid,cpu'],
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

function parseTop(stdout, pid) {
  const processSamples = [];
  const systemSamples = [];
  for (const line of stdout.split('\n')) {
    const sys = line.match(/^CPU usage:\s*([\d.]+)% user,\s*([\d.]+)% sys,\s*([\d.]+)% idle/);
    if (sys) {
      systemSamples.push({ user: Number(sys[1]), sys: Number(sys[2]), idle: Number(sys[3]) });
      continue;
    }
    const m = line.trim().match(new RegExp(`^${pid}\\s+([\\d.]+)`));
    if (m) processSamples.push(Number(m[1]));
  }
  return { processSamples, systemSamples };
}

/**
 * @param {number} pid              the process to watch
 * @param {number} samples          how many intervals to record AFTER the discarded first
 * @param {number} intervalSeconds  seconds per interval
 */
async function sampleProcessCpu({ pid, samples = 10, intervalSeconds = 1, label = `pid ${pid}` }) {
  const stdout = await runTop(pid, samples + 1, intervalSeconds);
  const { processSamples, systemSamples } = parseTop(stdout, pid);
  if (processSamples.length < 2) {
    throw new Error(`top produced ${processSamples.length} samples for pid ${pid} -- is it still alive?`);
  }
  const retained = processSamples.slice(1);
  const retainedSystem = systemSamples.slice(1);
  return {
    label,
    pid,
    cores: CORES,
    intervalSeconds,
    percentOfOneCore: summarise(retained, { warmupDiscarded: 1, unit: '% of one core' }),
    percentOfMachine: summarise(retained.map((v) => v / CORES), { warmupDiscarded: 1, unit: '% of machine' }),
    systemIdlePercent: retainedSystem.length
      ? summarise(retainedSystem.map((s) => s.idle), { warmupDiscarded: 1, unit: '% idle' })
      : null,
    rawSamples: processSamples,
  };
}

function describe(result) {
  return (
    `${result.label} (${result.cores} cores, ${result.intervalSeconds}s intervals)\n` +
    `  process CPU, % of one core  ${formatSummary(result.percentOfOneCore, 1)}\n` +
    `  process CPU, % of machine   ${formatSummary(result.percentOfMachine, 2)}\n` +
    `  system idle during run      ${result.systemIdlePercent ? formatSummary(result.systemIdlePercent, 1) : 'n/a'}`
  );
}

module.exports = { sampleProcessCpu, describe, CORES };
