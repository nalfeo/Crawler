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

`ai:headless` pre-bundles the CLI with esbuild before running (~85ms), which
removes ~2.7s of per-process `tsx` transpile startup. That startup is fixed
overhead, so leaving it in dilutes every wall-time comparison — a real 10% sim
win reads as ~7% when a quarter of the run is loader. Use
`npm run ai:headless:tsx` only to rule the bundler out when diagnosing a
loader-specific problem.

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
publish the observed span**, not one run's median. A single invocation's median
is itself a sample.

**Say "observed", not "range" — a 3-invocation span is not a bound.** The
across-invocation spread is itself under-sampled at n=3, and a tight-looking
interval invites readers to treat it as a bound it never earned. Measured on
this rig: a bench published at `1.171–1.180x` and `1.343–1.458x` off three
invocations had an independent fourth land **outside both, in opposite
directions** (`1.296x` and `1.303x`). List the observed medians per invocation,
label them observed, and expect ±0.1x. If one interval comes out implausibly
tight next to the others, that is a sampling artifact, not precision.

**Report a weak panel as weak instead of averaging it into the headline.** When
one panel scores materially worse on rounds-won or worst-round than its
siblings, name it as marginal and rest the verdict on the strong panels — ideally
the one carrying the most production calls. Folding a ⚠️ panel into a single
confident number is how a mixed result gets published as a clean one.

**Size each timed round to tens of milliseconds.** Sub-millisecond rounds are
unusable no matter how many of them you run: timer granularity and scheduler
jitter dominate, and pairing cannot rescue you because the noise is not shared
between the two halves of a round. An LOS bench with ~1500-3000 calls per round
swung paired ratios **0.64x-1.37x on byte-identical code**; raising it to
30k-60k calls (~10-25ms per round) collapsed that to a stable ~1.0x. If your
per-call cost is sub-microsecond, raise the call count until each round clears
~10ms — do not compensate by adding rounds.

**Run the equivalence oracle AFTER the timed rounds, never before.** A recording
or tracing wrapper is usually a subclass or a swapped-in callback, so exercising
it teaches V8's inline caches that the call sites are polymorphic — and it does
that _only_ for the variants the oracle touched. Every timed round afterwards is
then measuring a handicap you introduced. This applies to any pre-flight
correctness check, including a drift guard that proves your inlined baseline
copy still matches the real function; put all of them at the end.

**Build both variants from the real runtime object, not a fresh clone.** Objects
assembled at load time often carry installed callbacks, populated caches, or
non-null fields that the hot path branches on, and a bare clone silently
short-circuits them. In this repo `attachBarriersToFloorMap` installs two lookup
closures on the live `FloorMap`, and `isPassableAt` early-outs when they are
null — so timing the real map against a clean clone gives one side two live
closure calls per probe and the other a null check. That single asymmetry
flipped a result by ~1.6x in **both** directions across two revisions of the
same bench. `null -> function` is also a hidden-class transition. These fields
are frequently private with setters and no getters, so probe the object rather
than assuming.

**Do not assume an ablation is a bound without checking what it removed.** "Detach
subsystem X and compare" measures the cost of _consulting_ X, which is only a
lower bound on removing it if X was actually doing work. Print the subsystem's
size and both variants' result counts: if the counts are identical, the variants
did identical work and any early-exit argument you were about to make does not
apply. A barrier-overlay diagnostic here was reported as a floor on that
reasoning, then found to be running against a registry holding **0 entries** for
the whole fixture.

Do not benchmark while review agents or other sessions are running — an
observed baseline worst round went 208us -> 1138us purely from a busy machine.

`scripts/agent/perf/bench-fov.ts` and `scripts/agent/perf/bench-pathfinding.ts`
are the reference implementations of this whole pattern: inlined verbatim
baseline, ablation variants, rotating lead, rotated warmup, lockstep
byte-exact equivalence oracle, and paired per-round ratio reporting.
`scripts/agent/perf/bench-line-of-sight.ts` additionally shows the ordering and
round-sizing rules above, an ordered probe-trace oracle for a caller-supplied
callback, and what a **null** result looks like next to a real one measured on
the same rig — a candidate at 0.897x-1.111x with 1-11/15 rounds won, beside a
subsystem ablation at 1.438x-2.275x with 15/15. Read it before reporting a
marginal win.

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

**A green fingerprint on a fixture that never executes your branch is
trivially green.** It proves the diff did not perturb the replayed sim in some
_other_ way — real, but small. It says nothing about the branch itself. If your
fast path only fires in a state Floor 1 never enters (an empty registry, a
disabled feature, a mode the gate sample does not exercise), report the 24/24 as
covering collateral perturbation only, and name the test that is actually
gating correctness. Taking a tautological pass as coverage of the one hazard it
structurally cannot reach is the `spawnerSystem` shape in AGENTS.md r9.

## Proving your correctness test can fail (mutation)

A perf change that skips work needs a test proving the skipped work was
genuinely unnecessary — and that test is worthless unless you have watched it go
red. Break the fast path deliberately and confirm the failure. Minimum two
mutations for a caching/short-circuit change:

- force the fast path to always take the skip branch → must fail
- remove the invalidation (cache the verdict, never re-read) → must fail

**Print the mutation's diff or installed-site count before you trust a green
suite.** A mutation that silently failed to apply and a test that genuinely
cannot fail produce **identical** output — a green run — and the green reads as
_"the test is decorative, go weaken it"_, which is the most dangerous possible
inversion. `git diff --stat` showing `0 files changed`, or a printed count of
patched sites, distinguishes them in one line.

The concrete trap on Windows: a PowerShell `String.Replace` using `` `r`n ``
against an LF file (Prettier and git normalize to LF) matches nothing and
no-ops silently. Use `` `n ``, and verify the edit landed before believing the
result.

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
