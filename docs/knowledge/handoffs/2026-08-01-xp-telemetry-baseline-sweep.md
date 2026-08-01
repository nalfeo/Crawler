# Session Handoff: XP collection telemetry baseline sweep (issue #2585)

## Date

2026-08-01

## Persona

DevOps Engineer (investigation-only measurement scaffolding, no product PR)

## Systems touched

ai-combat-balance, inventory, ci-policy

## Apples

2🍎 estimated, 2🍎 actual (exact — telemetry-only port across ~12 files plus workflow/CI wiring, no gameplay/tuning change; tooling-only ceremony capped at 3🍎)

## What Was Done

Investigation-only baseline measurement for issue #2585 (Floor 1 AI XP collection
efficiency), requested via cross-session message from session "AI XP collection
efficiency" (`d838214a-9fa6-4c4a-b27e-565d8b4fe4a1`).

Branch `nalfeo-xp-telemetry-baseline-sweep` starts from main and selectively
ports ONLY the additive XP telemetry + fresh-process measurement/workflow seams
from stale branch `nalfeo-improve-ai-xp-collection`. Explicitly excluded:
`src/game/ai/bt-ai-provider.ts`, `src/game/ai/bt-ai-tuning.ts`, and any AI
behavior change — main's AI decision logic is untouched.

Because the source branch predates a 2026-07-13 skill/ability milestone-grant
feature on main (a raw diff/merge would have deleted `milestoneGrantLog` /
`SkillRunMetrics`), every hunk was manually re-applied against main's current
file state and verified line-by-line as additive-only, rather than
cherry-picked or merged.

Ported surface:

- `src/core/xp-collection-telemetry.ts` (new) — per-floor spawned/collected XP
  epoch tracking + efficiency summary.
- `src/core/spawners/pickups.ts`, `src/core/systems/itemPickupSystem.ts` —
  record spawn/collect events at existing mutation sites.
- `src/game/ai/types.ts`, `headless-runner.ts` — optional
  `RunStats.xpCollection` via new `recordXpCollection` config flag +
  `collectOptionalRunTelemetry()` helper (mirrors the existing
  `weaponTelemetry` optional-telemetry pattern; `skills`/`SkillRunMetrics`
  untouched).
- `headless-runner-cli-lib.ts` / `-cli.ts` — `--xp-collection` CLI flag.
- `scripts/agent/perf/isolated-sweep-run-worker.ts` (new) — fresh Node
  process per validation seed for genuinely isolated measurement.
- `scripts/agent/perf/sweep-eval.ts` — `--fresh-process`/`--record-xp` flags,
  `runOneInFreshProcess()` spawn path, optional `xpSpawned`/`xpCollected`/
  `xpRemaining`/`xpEfficiency` RunRow fields.
- `scripts/agent/perf/aggregate-shards.ts` — optional xp\* RunRow fields.
- `.github/workflows/ai-sweep.yml` — new `xp_collection` workflow_dispatch
  input, wired only into the validate job's `XP_FLAGS` bash array.
- New/extended tests: `tests/unit/xp-collection-telemetry.test.ts`,
  `tests/unit/ai-sweep-workflow.test.ts`, `tests/unit/ai/headless-runner-cli-lib.test.ts`.

Verified via `npm run typecheck` (clean), targeted `eslint` (clean), 958
targeted `vitest` tests (passing), a direct smoke test of the isolated worker,
and a full end-to-end smoke test of `sweep-eval.ts --stage validate
--fresh-process --record-xp` confirming xp\* fields populate correctly without
touching `skills` metrics.

**Dispatched and observed real run**: GitHub Actions `ai-sweep.yml` run
[30693138097](https://github.com/nalfeo/Crawler/actions/runs/30693138097)
(`project:sweep-results-viewer runId=30693138097`) — combo
`riskRewardFused+legacy`, `train_seeds=1`, `validate_seeds=1-100`,
`weapons=sword`, `workers=4`, `rounds=0`, `xp_collection=true`. Completed
successfully in ~9m42s for the validate job.

**100-seed baseline for main's current AI (Floor 1, riskRewardFused+legacy, sword):**

- Outcome distribution: `victory` 100/100 (100%)
- Official win rate: 100/100 (100%)
- Median XP efficiency (victories, `xpCollected/xpSpawned`): **0.688**
- Mean XP efficiency (victories): 0.692
- Final level: mean 5.42, median 5
- Game duration: mean 240.4s, median 234.5s

Interpretation: on this seed panel main's AI wins every run, and the median
run collects ~69% of spawned XP — the ~31% "leaked"/uncollected XP gem
headroom is what the XP-collection improvement work (in the sibling session)
would be trying to close, without regressing win rate.

## Key Decisions Made

- Chose manual, verified, additive re-application of hunks over
  cherry-pick/merge because the source branch is stale relative to main and a
  raw merge would silently delete current main functionality
  (skill/ability milestone grants).
- Skipped porting `xp-collection-analysis.ts` / `xp-collection-probe-worker.ts`
  / `xp-collection-sweep.ts` from the source branch after confirming via
  `git grep` that neither `ai-sweep.yml`'s validate job nor `sweep-eval.ts`
  reference them — they were dead weight for this measurement task.
- Followed the investigation/process-light policy explicitly requested by the
  user: no product PR opened, no review ledger, no apples JSON file (2🍎).
  Branch is pushed to origin for the sibling session to build on if desired,
  but is not being merged from here.

## What's Next / Blockers

No blockers. This session's scope is complete: branch pushed, sweep dispatched
and completed, baseline stats computed and reported back to the creator
session via `send_session_message`. The sibling session ("AI XP collection
efficiency") owns deciding what to do with this baseline (e.g. whether/how to
land actual `bt-ai-provider.ts`/`bt-ai-tuning.ts` behavior changes to close the
~31% XP-collection gap, validated against this same 100-seed win-rate floor).

## Retrospective

### Lessons Learned

- The `node --import tsx <script>.ts` invocation pattern is the correct way
  to run a `.ts` file directly in a genuinely fresh Node process (used both
  for manual smoke tests and inside `runOneInFreshProcess()`'s spawned child).
- `sweep-eval.ts --stage validate` requires a `--search-artifact` produced by
  `--stage search` (which embeds combo provenance) — NOT `--stage
search-baseline`, which produces a `combo: undefined` artifact that fails
  `assertSearchArtifactProvenance` in `aggregate-shards.ts`. This is
  pre-existing behavior unrelated to this port; worth remembering for future
  smoke tests of the sweep pipeline.
- `world.xpCollectionTelemetry` mirrors the existing `world.weaponTelemetry`
  optional-telemetry pattern exactly (undefined by default, lazily initialized
  only when the config flag is set) — a good template for any future optional
  RunStats-attached telemetry.

### Mistakes Made

- None of substance. The main risk (silently deleting main's skill/ability
  milestone-grant functionality via a naive merge of the stale source branch)
  was caught during the scoping/investigation phase before any code was
  written, by diffing file structure against current main first.

### Opportunities for Future Improvement

- The fresh-process isolation path (`runOneInFreshProcess()` /
  `isolated-sweep-run-worker.ts`) adds real per-seed process-spawn overhead
  (validate job took ~9m42s for 100 seeds vs. typically faster in-process
  runs). If XP-collection measurement becomes a routine gate rather than a
  one-off investigation, consider whether the isolation is actually load-bearing
  for XP telemetry accuracy or whether it was only needed for the source
  branch's original (unported) behavior-change work.
- Consider whether `xp_collection` sweep runs should default `rounds` to 0 in
  the workflow when set (since XP telemetry sweeps are typically baseline/
  measurement runs, not tuning searches) — today it's the caller's
  responsibility to pass `rounds=0` explicitly, as this session did.
