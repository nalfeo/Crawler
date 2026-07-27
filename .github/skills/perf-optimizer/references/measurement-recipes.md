# Measurement recipes

You may not claim a win you did not measure. Every recipe below produces a
number you can put in a PR body.

## Ground rules

1. **Same machine, same session, back-to-back.** Wall-clock numbers are not
   comparable across machines (CI runners are 2–3x a dev box) or across days.
2. **Repeat and report the spread.** A single sample is not a measurement. Run
   at least 3 and report median plus range.
3. **Report the share, not just the delta.** "Saved 4ms" is meaningless without
   "of a 31ms frame".
4. **Never assert on wall time in a test.** This repo asserts correctness on
   deterministic _game_ time precisely because wall time flakes. Your
   measurements are evidence for a PR body, not new CI gates.

---

## FIRST: attribute the cost (do this before any recipe below)

Every recipe below measures whether a change helped. **None of them tells you
what to change.** That is a separate step, and skipping it is how the first run
of this agent optimized a 2.9% target while a 21% one sat untouched.

```bash
npm run perf:profile
```

~35s. Runs the headless sim under V8's sampling profiler across seeds 1-3 x
sword, merges the profiles, and ranks functions by **self** and **total** time.

| flag                  | effect                                        |
| --------------------- | --------------------------------------------- |
| `--seeds 1-8`         | widen the panel (comma/range syntax)          |
| `--weapons sword,bow` | widen weapon coverage                         |
| `--sort total`        | rank by subsystem cost instead of hot leaves  |
| `--top 40`            | show more rows                                |
| `--json [path]`       | write the summary to stdout, or to a file     |
| `--max-frames <n>`    | truncate runs (**inflates startup overhead**) |
| `--ceiling <s>:<x>`   | Amdahl ceiling for share `s` at speedup `x`   |

Then, before optimizing:

```bash
npm run perf:profile -- --ceiling 2.9:3     # => 1.93
```

If the ceiling is inside noise, pick a different target. See SKILL.md step 3 for
the full gate, including the two exceptions and the anti-bundling rule.

**This covers simulation CPU only** — no renderer, asset decode, DOM, or browser
GC exists in the headless runner. For render/load surfaces, attribute with a
Chrome DevTools performance trace against `npm run dev` instead (the load recipe
below), then come back here to verify the win.

---

The headless runner replays a full deterministic Floor-1 run, so it is the most
repeatable proxy for simulation cost.

```bash
npm run ai:headless
```

For a wider, more stable sample of simulation cost:

```bash
npm run ai:winrate-sweep -- --seeds 1-8 --weapons sword --skip-events --workers 1
```

`--workers 1` matters: parallel workers contend and make wall time noisy. The
sweep prints total wall time at the end. Run before and after, 3x each.

**What it proves:** total simulation CPU cost for an identical workload. Because
the runs are deterministic and the fingerprint pins them, a wall-time drop with
an unchanged fingerprint is a pure win.

**What it does not cover:** rendering, asset loading, GC in the browser.

## Surface: per-system cost

```bash
npm run bench
```

Runs `tests/bench/core-systems.bench.ts` (Vitest bench). Add a bench case for
the system you are targeting so the win is attributable to that system rather
than to overall noise.

`npm run health:check` includes a `bench-regression` step — check it after your
change so you learn whether you moved a tracked number.

### When to microbench a single function

Reach for a function-level microbench when the target is a small share of the
surface's wall time. If a function is <5% of frame time, even a large per-call
win lands **inside noise** end-to-end — the end-to-end delta will not be a
defensible number, and reporting it as one gets the whole change rejected.
In that case the per-call number is your headline and the end-to-end number is
explicitly reported as "inside noise", not as the win.

**Microbenches on this codebase must be same-process and interleaved.** Run
`before` and `after` alternately in one process for N paired rounds. Separate
process runs are not comparable here: observed per-call medians for the same
code vary by ~2.7× run-to-run, which is wider than most wins you will find.

**The authoritative pass criterion is the paired one below**, not raw
distribution overlap. Raw `before`/`after` distributions can overlap while every
individual round still shows a win — that is a real result, and the older
"worst `after` must beat the best `before`" phrasing wrongly rejects it. Use
raw non-overlap only as a quick sanity signal, never as the gate.

**Warm up with SEVERAL rotated sweeps before the first timed round.** One
warmup sweep is not enough: V8 is still tiering up during the early timed
rounds, and whichever variant runs first absorbs that cost. This is not
theoretical — an earlier version of `bench-pathfinding.ts` with a single warmup
sweep reported medians of **4.71x, 8.13x, and 8.42x for byte-identical code**
across three invocations. Rotate the warmup the same way the timed rounds
rotate (`variants[(w + i) % variants.length]`) so tiering pressure lands
symmetrically on every variant.

**Report paired per-round ratios, not a ratio of aggregate medians.** Compute
`before/after` _within_ each round, then take the median of those ratios.
Pairing controls **shared round-level drift** — thermal state, background load,
tiering — because those affect the variants measured close together in the same
round. It does **not** make the measurement immune to noise: a transient GC or
scheduler stall can land on a single variant and skew one round on its own.
That is exactly why the pass criterion is a distribution of paired ratios, not
one round.

**Pass criterion:** the median paired ratio is the win, and it is a win only if
the change wins a large majority of rounds — report **rounds won** (`9/9`) and
the **worst single round**. A stall-skewed round shows up as an outlier in that
spread rather than silently moving the headline. The worst round is your
defensible headline, never the best.

**Run the finished bench in at least two separate process invocations and
publish the range**, not one run's median. A single invocation's median is
itself a sample.

Do not benchmark while review agents or other sessions are running — an
observed baseline worst round went 208us -> 1138us purely from a busy machine.

`scripts/agent/perf/bench-fov.ts` and `scripts/agent/perf/bench-pathfinding.ts`
are the reference implementations of this whole pattern: inlined verbatim
baseline, ablation variants, rotating lead, rotated warmup, lockstep
byte-exact equivalence oracle, and paired per-round ratio reporting.

To get the `before` side, extract the pre-change file from git rather than
stashing, so both versions are importable at once:

```bash
git show <base-sha>:src/path/to/file.ts > src/path/to/tmp-file-before.ts
```

Delete the temp file and any scratch copies when done — but
**commit the bench itself**. A deleted bench means the next agent cannot
reproduce your headline number, and the win becomes unauditable (rule #4).

## Surface: boot, build, and first frame

```bash
npm run perf:baseline
```

`scripts/agent/perf/baseline.ts` measures cold and warm scenarios: build time,
`verify:fast` time, Vite ready time, and **first-frame time** via a real
Playwright browser load. `viteReadyMs` and `firstFrameMs` are the load-time
numbers you care about; the build/verify numbers are dev-loop and out of scope
for this agent.

`npm run perf:find-baseline` locates the stored baseline for comparison.

## Surface: in-browser frame time and load waterfall

Use the **`chrome-devtools` skill** against a running dev server:

```bash
npm run dev     # note the printed URL
```

Then drive a performance trace (`performance_start_trace` with `reload: true`
for load, or `reload: false` + `autoStop: false` for steady-state gameplay) and
read the insights. This is the only recipe that gives you real rendering cost,
GC pauses, long tasks, and the network waterfall.

For memory growth, take a heap snapshot at two points in a long session and
compare retained size.

**This is the recipe to use for anything visual or load-related** — the headless
runner has no renderer and no DOM, so it cannot see these costs at all.

## Surface: bundle size

```bash
npm run build
```

Compare the emitted chunk sizes before and after. Report initial-chunk size, not
just total — moving bytes out of the critical path is the win, and total may not
move at all.

```bash
npm run lint:dead-code
VERIFY_KNIP=1 npm run verify   # advisory; surfaces unreferenced exports
```

## Surface: broad sampling (>10 runs)

Per AGENTS.md r15, do **not** run broad sweeps on local/session compute. Dispatch
them to GitHub Actions (`weapon-sweep.yml` / `ai-sweep.yml`) instead.

When you discuss or report any sweep, you **must** include the app-native viewer
deep link (AGENTS.md r17):

```
project:sweep-results-viewer runId=<run-id>
```

A raw Actions URL is a secondary fallback only, never the sole path.

Note that a sweep's wall time is dominated by _losing_ seeds running to the full
frame budget, so sweep wall time is a poor perf metric unless the fingerprint
confirms the same seeds won and lost.

---

## The neutrality check (mandatory, both directions)

```bash
# BEFORE any edit, on the clean tree:
npm run perf:fingerprint -- --write files/perf-baseline.json

# AFTER the optimization:
npm run perf:fingerprint -- --check files/perf-baseline.json
```

Full gate sample only (seeds 1–8 × sword/bow/baseball-bat) for the PR gate — the
tool prints whether the sample it ran is the full gate sample, and warns loudly
when it is not. A narrowed `--check` against a full-gate baseline is reported as a
**sample mismatch**, not as gameplay drift.

**Coverage limit:** this replays only the headless sim. It says nothing about
rendering, asset loading, input, or browser behavior. For render/load work you
still owe `npm run review:visual` / an e2e probe / a first-frame measurement.

On drift, the tool prints the exact run label and `RunStats` field paths that
diverged, e.g.:

```
RunStats DRIFT in 1 run(s):
  bow:3
    combat.totalKills: 41 → 42
    finalScore: 8120 → 8190
```

That is your change altering the game. Fix the change. Do not regenerate the
baseline.

## Reporting template

```markdown
### Perf result

- **Surface:** steady-state simulation (headless Floor 1)
- **Metric:** total wall time, `npm run ai:winrate-sweep -- --seeds 1-8 --weapons sword --skip-events --workers 1`
- **Before:** 312s / 308s / 315s (median 312s)
- **After:** 271s / 269s / 274s (median 271s)
- **Win:** −41s, −13.1%
- **RunStats neutrality:** `perf:fingerprint --check` clean on the full gate
  sample (24 runs); hash `422e8836…`
- **Surface observation:** n/a (pure-ECS change) — or name the visual/load check
- **Suite:** green in CI
```
