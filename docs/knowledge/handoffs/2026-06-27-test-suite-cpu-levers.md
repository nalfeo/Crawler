# Session Handoff: Test-suite CPU levers — parallelization + pool/isolation investigation

## Date

2026-06-27

## Persona(s) adopted

**DevOps Engineer** — pure inner-loop/CI throughput investigation; touches only
`scripts/agent/*` candidates + vitest config analysis. No game-layer code.

## Routing verdict

✅ Right persona — entirely build/test throughput work.

## Apples

Estimated: 🍎 x 3 <!-- investigate the deferred CPU items + decide ship/no-ship -->
Actual: 🍎 x 3 <!-- five experiments, root-cause analysis, three levers characterized, evidence-based no-ship decision -->
Verdict: 🎯 Exact

Hello kitties: 3/5 = 0.60 🎀

## Context

Follow-up to PR #397 ("speed up local dev loop"), which deferred two CPU-heavy
items in its "What's Next": (#1) parallelize verify.sh's 3 sequential vitest
projects, and (#5) Phaser/import overhead. This session ran the experiments those
items called for. **Outcome: no clean, safe, high-value win exists without a
large project — documented negative result.**

## What Was Investigated (5 experiments)

All runs on this 12-core Windows box, `export CI=1`, vitest 4.1.8. Timings are
load-variant (shared box) — correctness (all-green) is the primary signal.

### Lever 1 — Parallelize verify.sh's 3 projects (unit/integration/headless)

Load-matched, all-green except where noted:

| Run                                             | unit     | integration  | headless     | WALL     |
| ----------------------------------------------- | -------- | ------------ | ------------ | -------- |
| Sequential (baseline)                           | 16s      | 103s         | 93s          | **212s** |
| Blanket 3-way parallel                          | —        | —            | **FAIL**     | 221s     |
| Safe variant (unit∥integration; headless alone) | (hidden) | 93s (phase1) | 77s (phase2) | **170s** |

- **Blanket 3-way is UNSAFE.** `tests/headless/floor1-completion.test.ts` has a
  wall-clock perf-regression guard (`wallTimeMs < HEADLESS_WALL_TIME_BUDGET_MS =
30_000`). Nominal ~6.7s on a quiet box; under 3-way CPU contention a sim was
  starved to **48.5s → reliable FAIL**. The file documents the budget as
  deliberately loose and "subject to noisy-neighbour jitter… do not tighten."
  Co-scheduling heavy work _is_ a noisy neighbour. **headless must run alone.**
- integration has **no** wall-clock guards (its "budget" assertions are
  `JudgeBudget` USD cost + a health-poll retry loop), so it is logic-safe to
  parallelize. unit likewise.
- Because headless (93s) and integration (103s) are both tall poles that cannot
  overlap each other, the structural floor is `integration + headless ≈ 196s`
  vs 212s sequential = **~7–8% repeatable** (unit just hides under integration).
  The observed 170s got an extra boost from run-to-run noise (headless 93→77).
- **Verdict: not worth shipping.** ~7–8% on the _less-frequent_ `verify` gate
  (`verify:fast` is the inner loop, already optimized in #397), in exchange for
  concurrent-launch complexity, interleaved logs, and a new flake surface on a
  pre-commit correctness gate. A narrow opt-in `unit∥integration` (headless
  always alone) is possible but marginal.

### Lever 2 — vitest pool type + isolation (unit project, 202 files)

| Config                        | Exit   | Duration                 |
| ----------------------------- | ------ | ------------------------ |
| forks + isolate (**current**) | ✓      | 17.83s                   |
| threads + isolate             | ✓      | 30.61s                   |
| **threads + no-isolate**      | ✓/✗    | **10.79s** (~40% faster) |
| forks + no-isolate            | ✗ FAIL | 22.40s                   |

- `threads + isolate` is **slower** (30.6s) — reject.
- `threads + no-isolate` is ~40% faster (10.8s) **but FLAKY**: of three runs, two
  passed and one failed (`session-server-env.test.ts`); the single-worker
  no-isolate run **crashed outright**. Cause = cross-file state leaks that the
  default per-file isolation hides.
- This **empirically confirms PR #397's "isolate:false REJECTED" decision** and
  extends the polluter inventory. Known module-level mutable singletons:
  `src/shared/quest-types.ts`, `src/shared/set-piece-types.ts`,
  `src/engine/controls-config.ts` (from #397), plus a **warn-once flag in
  `src/shared/session-server-env.ts`** found this session (the
  `getSpriteSidecarBaseUrl` "warn at most once" guard persists across files under
  no-isolate, so `expect(warn).toHaveBeenCalled()` flakes on suite order).
- **Verdict: no-isolate stays rejected.** The ~40% is real but locked behind a
  large, ongoing isolation-hardening effort that fights the codebase's
  module-singleton design; any new test can reintroduce flake.

### Root cause (why the unit suite costs what it does)

vitest phase breakdown (summed across workers), forks+isolate:
`import 51.6s` (dominant) · `tests 44.6s` · `transform 23.7s` · `setup 5.7s`.
Under no-isolate, import halves (51.6→26.2s) and tests nearly halve. So the
dominant cost is **re-executing the logic module graph in a fresh context per
file × 202 files** under mandatory isolation. The heavy modules are pure logic
(`src/game/ai/bt-ai-provider.ts` 171KB, `floorScenario.ts` 87KB,
`enemyAISystem.ts` 57KB, `core/map/generators/DungeonGenerator.ts` 60KB), not
rendering.

### Lever 3 — Phaser/import stub (ruled out cheaply)

- Phaser is imported only by `src/engine/*` and `src/labs/*` (+ `main.ts`,
  `bootstrap/floor-game-config.ts`) — the rendering layer. Only **2 of 202** unit
  test files import phaser.
- `src/game/*` and `src/core/*` have **zero** imports from `engine/` or `phaser`
  (clean logic/render separation). So unit logic tests never transitively load
  Phaser; a test-only Phaser stub would help nothing meaningful. The unit import
  cost is the **logic graph itself**, not Phaser. (PR #397's "~97s Phaser
  overhead" was a _full-suite_ figure — headless/e2e, which do render.)

### Lever 4 — tests/setup.ts (ruled out)

Trivial: installs lightweight canvas/raf/audio global mocks, no heavy per-file
work. Not a sink.

## Final Verdict

**No clean, safe, high-value CPU win is available in the test suite without a
large project.** The two big levers each require deep, risky work that PR #397
correctly deferred:

1. **Isolation-hardening** to unlock `--no-isolate` (~40% on the 202-file unit
   suite, which runs in `verify:fast` + CI): fix every module-level mutable
   singleton (≥4 known) and keep the suite leak-free going forward. High value,
   high ongoing-maintenance risk; fights the design.
2. **Lazy-init / shrink heavy logic modules** to cut the 51.6s import cost while
   keeping isolation: deep refactor of the largest logic modules, uncertain
   payoff per module, production-init-order risk.

   **Quantified upside (why this is the weakest lever).** The unit `import`
   phase is 51.6s _summed across workers_ ≈ **~7s wall-equivalent** — and that
   ~7s is the _absolute_ ceiling for any import-side optimisation (it's exactly
   the band `no-isolate` reclaimed, 17.8s→10.8s). Lazy-init cannot reach that
   ceiling: unlike `no-isolate` (which loads each module once _per worker_
   instead of once _per file_), lazy-init **keeps per-file isolation**, so every
   heavy module still loads **202×**. It only defers _eager top-level work_ and
   only helps files that import a module but never exercise its heavy path
   (files that do exercise it merely move cost `import`→`tests`, net zero). Since
   these logic modules are mostly function/class _definitions_ (cheap to load),
   the deferrable slice is small: realistic saving **~1–3s wall (~5–15%)** on the
   unit suite, well under the 7s ceiling. Its larger real benefit is **production
   boot time**, not tests.

Recommendation: **do not ship** blanket parallelization or no-isolate. If a win
is wanted, scope (1) as its own spike/ADR with a leak-lint guard (e.g., an ESLint
rule banning module-scope mutable `let` in `src/shared/**`) so no-isolate can be
adopted _and stay_ safe.

## Branch State

- Investigation only — **no repo code changed**. Experiment harnesses + logs live
  in the session folder, not the repo.
- PR #397's branch (`nalfeo-speed-up-local-dev`) is merged; any future shippable
  change needs a fresh branch off updated `origin/main`.

## Test Results

- Sequential baseline (unit/integration/headless): all green, 212s.
- Safe-variant parallel (unit∥integration; headless alone): all green, 170s.
- Blanket 3-way: headless wall-guard FAIL (48.5s vs 30s).
- Pool matrix: forks+isolate ✓17.8s; threads+isolate ✓30.6s; threads+no-isolate
  ~10.8s but flaky (1/3 fail); forks+no-isolate ✗.

## Key Decisions Made

- **Blanket test-project parallelization rejected** — headless wall-clock perf
  guard reliably breaks under CPU contention; safe variant only ~7–8% on the
  less-frequent gate.
- **`--no-isolate` re-confirmed rejected** — ~40% but flaky; module-singleton
  leaks are a design-level constraint (extends #397's decision with hard data +
  a new polluter, `session-server-env.ts`).
- **Phaser stub ruled out for unit** — clean logic/render separation means it
  helps nothing; import cost is the logic graph.
