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

## Surface: steady-state frame time (headless, deterministic workload)

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

## The neutrality proof (mandatory, both directions)

```bash
# BEFORE any edit, on the clean tree:
npm run perf:fingerprint -- --write files/perf-baseline.json

# AFTER the optimization:
npm run perf:fingerprint -- --check files/perf-baseline.json
```

Full gate sample only (seeds 1–8 × sword/bow/baseball-bat) for the PR gate — the
tool prints whether the sample it ran is the full gate sample, and warns loudly
when it is not.

On drift, the tool prints the exact run label and `RunStats` field paths that
diverged, e.g.:

```
Gameplay DRIFT in 1 run(s):
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
- **Gameplay neutrality:** `perf:fingerprint --check` clean on the full gate
  sample (24 runs); hash `422e8836…`
- **Suite:** `npm test` green
```
