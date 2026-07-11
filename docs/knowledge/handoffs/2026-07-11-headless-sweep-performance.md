# Session Handoff: Headless and weapon-sweep performance

## Date

2026-07-11

## Persona

Producer → Systems Engineer / DevOps Engineer

## Systems touched

ai-combat-balance, ai-behavior-tree, mapgen, ci-policy

## Apples

4🍎 exact

## What Was Done

- Profiled the canonical Floor 1 headless runner and identified redundant FOV
  shadowcasting, full-map AI discovery copying, and sequential per-weapon sweep work.
- Cached FOV when the floor identity, player sub-tile, sub-factor, and transparency
  revision are unchanged.
- Made `FloorMap`'s persistent tile discovery the AI's source of truth.
- Split every weapon into four deterministic seed shards and added strict fan-in that
  recreates the original per-weapon artifact contract.
- Added focused unit, ECS, behavior-tree, aggregation, and workflow smoke coverage.
- Observed in the real headless runner: before median 14,359 ms; after median
  10,312 ms across the same warmed three-seed panel, a 28.2% reduction with
  byte-equivalent gameplay outcomes after excluding timestamps and wall time.
- `VERIFY_FULL=1 npm run verify` passed typecheck, lint, format, guards, unit,
  integration, sprite, and all 92 headless tests before stopping at the expected
  documentation/review prerequisites.

## Key Decisions Made

- Cache only complete deterministic FOV inputs; do not approximate visibility.
- Increment transparency revision only when the transparent bit actually changes,
  avoiding invalidation from idempotent door updates.
- Reuse tile-level discovery already maintained by `FloorMap` rather than maintaining
  a second AI bitmap.
- Parallelize broad runs with GitHub matrix shards rather than relying only on the
  limited cores within one hosted runner.
- Fail fan-in closed on missing, duplicate, unexpected, malformed, or out-of-order
  seed records.
- Preserve the existing final artifact names and JSON schema for downstream users.

## What's Next / Blockers

- The individual-run target is empirically complete: 28.2% faster versus the required
  25%.
- The full 300-run target is not yet empirically measured. GitHub rejected workflow
  dispatch with HTTP 403, and no historical weapon-sweep workflow run was available.
  Four-way sharding plus the measured per-run gain projects beyond the 50% target, but
  a permitted canonical Actions run remains the required proof.
- Retry `.github/workflows/weapon-sweep.yml` when workflow-dispatch permission is
  available; compare total workflow execution time against an unsharded baseline.

## Retrospective

### Lessons Learned

- V8 profiling quickly separated simulation hot paths from orchestration overhead:
  FOV and discovery were large enough to meet the individual target without risky
  pathfinding changes.
- A monotonic topology revision is a cheap and deterministic cache-invalidating input
  when mutation helpers already centralize runtime changes.
- Broad-run wall time needs both levels of optimization: less work per simulation and
  more independent jobs in the cloud.

### Mistakes Made

- Intake continued after the user had already approved the bounded target. The early
  signal was the repeated instruction to start; execution should have begun
  immediately.
- The first implementation inserted new methods inside existing method/constructor
  bodies, causing syntax errors. Running `verify:fast` immediately contained the
  mistake, but reading the exact insertion context first would have prevented it.
- The availability of workflow-dispatch permission was not checked before depending
  on a canonical GitHub benchmark for the final sweep metric.

### Opportunities for Future Improvement

- Add a low-cost workflow permission/capability probe before planning benchmark runs.
- Persist benchmark baselines as workflow artifacts so performance changes can compare
  against a stable runner-class baseline without rerunning old code.
- Profile LOS and flow-field costs next only if future runs regress after the present
  FOV/discovery savings.
