# `scripts/perf/` — the Stage 9 measurement harness

**This is not application code.** Nothing under `apps/`, `packages/` or `services/` references
anything in this directory, and no product process loads any of it. Verify that at any time:

```
grep -rn "scripts/perf\|control-preload\|PERF_CONTROL" apps packages services | grep -v node_modules
```

That command returns nothing. It is the whole of Ruling 1's requirement, met the strong way:
there is no instrumentation in shipped source *to remove*, because the harness never put any
there. Where a measurement needs the server to behave differently — the negative controls do —
it is injected with `node --require` in front of the server's own entry point, exactly as
`docs/verification/stage-3/tag-timer.js` did for the Stage 3 cold-start numbers. Drop the
`--require` and the process is byte-for-byte the stock one.

---

## The rig

Every number this harness produces is a number **on this rig**. "1.8 s" is not a measurement.

| | |
|---|---|
| **Host** | Apple M5 Pro, 15 logical cores, 24 GB RAM, macOS 26.3.1 (Darwin 25.3.0), Node v26.7.0 |
| **API under test** | started by the harness itself on **port 3100**, from `apps/api/src/server.ts` under `ts-node`, same command as `pnpm dev:api` plus one `--require` |
| **API host** | `http://localhost:3100` — the *same machine* as the harness |
| **Database** | `mongodb://localhost:27017/**wardrobe_perf**` — the harness's own database, seeded by `seed-perf-db.js` with 46,128 items across 25 users. MongoDB 8.2.12 in Docker (`ai-wardrobe-manager-mongo-1`) |
| **Object storage** | MinIO in Docker (`ai-wardrobe-manager-minio-1`), port 9000, bucket `wardrobe-items` |
| **AI service** | FastAPI in Docker (`ai-wardrobe-manager-ai-1`), port 8000 |
| **Container runtime** | the containers are **not** native processes: they run in a Linux VM (`krunkit`, Podman Desktop) and are reached over a forwarded port. "Loopback" to Mongo and MinIO therefore crosses a VM boundary, which is part of every database and signing number here |
| **Handset** | Samsung **SM-S948B**, serial `RZGL20MPZTK`, **Android 16** (SDK 36), build `BP4A.251205.006.S948BXXS4AZG5`, arm64-v8a, 8 cores |
| **Handset connection** | **wireless debugging**, transport id 1 |
| **Connection path** | **LOOPBACK — see below** |
| **What else was running** | the project's own dev API on port 3000 (database `wardrobe_gate7`), Metro on 8081, the container VM, and the host's ordinary desktop session — WindowServer, Discord, Microsoft Edge and two `claude` processes were the top CPU consumers during the recorded run, and host load average was 4.6 / 5.8 / 5.7. **This is a working desktop, not a quiet lab.** Each result file records `rig.environment.topProcessesByCpu` for its own run so a reader can judge. |

### Ruling 2: every network number here is a loopback number

The handset reaches the API through `adb reverse tcp:3000` — an adb-forwarded socket over
wireless debugging to a server **on the same desk**. It is not mobile data, it is not Wi-Fi to a
hosted API, and it is not a "stable network connection" in the sense a reader of the submitted
document would assume. The harness writes that sentence into `rig.connectionPath` of every
artefact it produces so it travels with the number.

The host-side measurements are loopback too: harness, API, MongoDB and MinIO are all
`127.0.0.1` on one machine. A number taken here is a **lower bound** on what any real
deployment would show, never an estimate of one.

### What the harness deliberately does *not* touch

- **the dev API on port 3000** and its `wardrobe_gate7` database (the Stage 7 gate fixture)
  — left running, never written to;
- `wardrobe` (development) and `wardrobe_test` (which `apps/api/jest.setup.js` pins the
  suites to);
- the handset's screen timeout (300000 ms) and `stay_on_while_plugged_in` (0), which the
  user has asked stay as they are to avoid OLED burn-in. The harness wakes the screen with
  `KEYCODE_WAKEUP` for device runs and lets it doze again on its own.

---

## Measurement policy

**Distributions, never a single number.** Every result reports `min / median / p95 / max`
with the sample size and the number of discarded warm-up samples. A median that meets a claim
while p95 misses it by 3× is a claim that does not hold, and a lone median hides that.

**Percentiles are nearest-rank**, on the ascending sorted sample: p95 of *n* samples is element
`ceil(0.95n)`, 1-indexed — for n = 25, the 24th value. No interpolation, so every reported
percentile is a value that was actually observed.

**Warm-up is discarded, stated, and paid.** Default 3 samples for HTTP and database
measurements. They are *issued* and then dropped, not skipped, so their cost is really paid
before the retained window opens. What is being discarded, and why:

| instrument | discarded | because |
|---|---|---|
| `measure-api.js` | first 3 requests | `ts-node` compiles each route module on first reach; Mongoose opens its pool; the MinIO client fetches the bucket region once and caches it, so the first signed URL costs a round trip and the rest cost an HMAC |
| `measure-db.js` | first 3 executions | the driver handshake, the planner's first evaluation of the query shape (cached afterwards), and WiredTiger paging the working set in |
| `measure-cpu.js` | first `top` sample | `top`'s first sample is an average since process launch, not an interval — including it biases every short run toward whatever the process was doing beforehand |
| `measure-device.js` (memory) | **nothing** | the first reading of a memory total is as valid as the tenth, and discarding early samples would hide exactly the growth a leak claim is about |

Retained numbers therefore describe a **warm** server and a **warm** cache. A cold-start number
is a different measurement and is taken separately.

**A run with any unexpected status code is not summarised.** A distribution over failing
requests is a measurement of the error path wearing the success path's name.

---

## Metric classes, their instruments, and their controls

| class | instrument | negative control |
|---|---|---|
| `api-latency` | `measure-api.js` — hrtime around request-write → last response byte | `PERF_CONTROL_DELAY_MS` — the server sleeps before the app sees the request |
| `transfer` | `measure-api.js` — `socket.bytesRead` / `bytesWritten`, headers included | `PERF_CONTROL_INFLATE_BYTES` — padding added to the JSON body |
| `server-cpu` | `measure-cpu.js` — `top -l N -s 1 -pid`, under an **open-loop** fixed-rate load | `PERF_CONTROL_CPU_BURN_MS` — the handler spins for *n* ms per request |
| `db-query` | `measure-db.js` — driver-side timing plus the winning plan | the same documents `$out`-copied into a collection with no index but `_id` |
| `device-memory` | `measure-device.js` — `dumpsys meminfo` TOTAL PSS / RSS | a process on the handset allocates a known 40,000,000 bytes and holds it |
| `device-frames` | `measure-device.js` — `dumpsys gfxinfo` janky % and frame percentiles, read for `FRAME_PKG` in `negative-controls.js` | spinning shell processes on the handset during an identical scripted swipe |
| `device-settle` | `measure-device.js` — `screenrecord` + ffmpeg frame-difference series | analyser: a synthetic recording with a known 1 s vs 3 s unsettled section. End to end: treble the on-device workload |

Run them all:

```
node scripts/perf/seed-perf-db.js          # one-off: builds wardrobe_perf
node scripts/perf/negative-controls.js     # runs every control, writes the table
```

Results land in `docs/verification/stage-9/negative-controls.{json,md}`, raw server logs in
`docs/verification/stage-9/raw/`. **The verdicts, including the ones that failed, are in the
committed table** — see `docs/verification/stage-9/negative-controls.md` and the Task 1 report.

### `device-frames` was pointed at the wrong package for four tasks — fixed in Task 5

`FRAME_PKG` in `negative-controls.js` was `com.android.systemui` from Task 1 until Task 5. Task 1
chose it because the handset was locked behind a secure keyguard and Expo Go could not be
foregrounded, and Task 1's ledger then attributed the class's VOID verdict to the lock. **It was
the constant.** Once the handset was unlocked the control still measured the system UI package by
construction, and nothing in the artefact said so, because the record never repeated the package
back. Task 3 found the cause by reading the code and deliberately left it alone (Task 2 was
running against this harness, and re-pointing it silently would have left the committed
`negative-controls.{json,md}` meaning two different things behind one filename).

Task 5 changed it to `host.exp.exponent` **and re-ran the class in the same sitting**. Two guards
were added with it, so this failure cannot recur silently: every sample records
`dumpsys gfxinfo`'s own `Graphics info for pid N [pkg]` line and the foregrounded window, and the
control is refused with a stated reason unless both name the target. The unconditional note that
asserted a locked handset is now derived from the run's own data.

The pre-change artefact is preserved at `docs/verification/stage-9/negative-controls.before-task5.json`
and the re-run log at `docs/verification/stage-9/raw/task5-frames-control-rerun.log`.

**The class is still INCONCLUSIVE**, now for a measured and correctly attributed reason: on the
restored 8-item wardrobe the scripted vertical swipe renders **3 frames**, against a 100-frame
floor below which a sample is refused rather than compared. `task3-frames-control.js` is the
instrument that answers this class against the app on a wardrobe large enough to scroll.

### Why the CPU control uses an open-loop load

A closed loop — *N* virtual users each waiting for their own response — pushes until something
saturates. A single-threaded Node server on a 15-core host saturates at 100% of one core
whatever the handler does, so a closed loop makes the CPU number *insensitive to the very thing
the control changes*. The load generator therefore has two shapes, and the CPU measurement uses
the fixed-rate one so the server keeps headroom. The closed-loop shape stays, because
"50 simultaneous users" (Claim 6) is a closed-loop question.

### Ruling 5: what "a simulated concurrent user" means here

One client, holding its own connection, issuing one request at a time from a stated weighted
mix, waiting for each response before the next, with a stated think time. Fifty of them is a
closed loop with at most fifty outstanding requests — **not** fifty idle sockets and **not**
fifty requests per second. Every load result carries that definition in
`virtualUserDefinition`, so a headline can never travel without it.

---

## Crash safety: `kill -9` cannot run a `finally`

An interrupted harness in Stage 8 left two mutations on disk, and `pnpm typecheck` passed with
both applied — one of them a live bug. So this harness never relies on unwinding:

1. the undo record (and, for a file, its pristine copy) is written and **fsynced** *before* the
   mutation;
2. the mutation happens;
3. on clean completion the mutation is undone and the record deleted.

Every entry point calls `recoverLeftovers()` before it does anything else, so a SIGKILL between
1 and 3 is repaired by the next run, loudly. Mutations tracked: patched files, `adb reverse`
remappings, scratch MongoDB collections, and spawned API processes. Spawned servers additionally
carry an orphan watchdog (`PERF_PARENT_PID`) and exit on their own if the harness disappears.

Prove it, don't trust it:

```
node scripts/perf/safety-selftest.js
```

A child registers a file, corrupts it, and SIGKILLs itself; the parent confirms the corruption
on disk, runs ordinary startup recovery, and confirms the file is byte-identical again.

---

## Files

| file | what it is |
|---|---|
| `control-preload.js` | the deliberate-defect injector, loaded with `node --require`. Off unless `PERF_CONTROL_*` is set. Serves `GET /__perf/control` so a control can be *proved* installed |
| `negative-controls.js` | runs the whole matrix and writes the table |
| `measure-api.js` | api-latency + transfer |
| `measure-db.js` | db-query timing and plans, and the unindexed-clone control |
| `measure-cpu.js` | server-cpu sampling |
| `measure-device.js` | device memory, frames, and settle time |
| `seed-perf-db.js` | builds `wardrobe_perf` deterministically |
| `safety-selftest.js` | proves the crash-safe ledger under SIGKILL |
| `interference-check.js` | measures the same endpoint against a stock server and against one carrying the inert preload, so the harness's own cost is a number rather than an assurance |
| `task4-session.js` | **Task 4** — the 30+ minute continuous-use session driver: a fixed 30-action loop across every screen, a `dumpsys meminfo` sample every ~12 s, and a crash/ANR watch (pid, `/data/anr/`, the system dropbox, and a full `logcat -b main,crash,system`). `--dry-run` screenshots every action so the coordinates are verified before a long run commits to them |
| `task4-analyse.js` | **Task 4** — fits the memory slope with its uncertainty and applies the verdict rule fixed in `docs/verification/stage-9/task4-preregistration.md`, then sweeps synthetic ramps over the session's own noise to say what slope the analyser would have called. Also fits **each cycle phase separately** (removing the screen-composition confound by measurement rather than by argument) and runs a **split-half and quadratic-curvature** test on the secondary window, because a single slope cannot see a plateau |
| `task4-control-leak.js` | **Task 4** — the capture-path negative control: patches a known growing retained allocation into the app's own process, runs the same driver over it, then restores and verifies. The patch carries a `PERF_CONTROL` marker precisely so the leak grep above can prove it is gone |
| `task4-crashscan.js` | **Task 4** — scans the session's logcat for every crash/ANR/OOM/red-box signature, printing every category whether or not it fired; `--selftest` proves each pattern can match |
| `task4-parser-equivalence.js` | **Task 4** — proves `lib/meminfo.js`'s parser is byte-for-byte the one Task 3 fixed, by lifting `parseFull`'s source out of `task3-memory.js` and comparing both on live device output |
| `lib/meminfo.js` | `dumpsys meminfo` parsing (the fixed two-line-heading version), a strict mode that refuses to record an unparsed sample, and the swap-inclusive dirty footprint. `parseHeapCounters()` sits **beside** `parseFull` rather than widening it — `parseFull` must stay byte-for-byte Task 3's for `task4-parser-equivalence.js` to keep proving it — and adds the `Heap Size / Heap Alloc / Heap Free` columns the row regex drops, so retained allocation can be told apart from allocator arena growth. `series()` records all **seven** App Summary Pss rows (they sum exactly to `TOTAL PSS`), not four |
| `lib/trend.js` | OLS with Newey–West HAC standard errors, Theil–Sen, a moving-block residual bootstrap, and the pre-registered RISING/FALLING/DRIFTING/FLAT/INCONCLUSIVE verdict |
| `lib/stats.js` | percentiles, distributions, control verdicts |
| `lib/safety.js` | the crash-safe undo ledger |
| `lib/http.js` | wire-accurate timed HTTP client (keep-alive off, on purpose) |
| `lib/load.js` | closed-loop and open-loop load generation |
| `lib/api-instance.js` | starts/stops the isolated API under test |
| `lib/adb.js`, `lib/rig.js` | handset access and rig capture |
| `lib/mongo.js`, `lib/token.js`, `lib/fixtures.js` | driver resolution, JWT minting, shared enums |
