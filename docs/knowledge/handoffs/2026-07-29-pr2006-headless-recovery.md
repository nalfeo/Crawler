# Handoff: PR #2006 headless recovery

## Systems touched

mapgen, ai-runner

## Apples

Estimated: 2🍎 (Small) — actual: 2🍎. One targeted gameplay regression repair plus one review-thread revalidation.

## Summary

- Revalidated PR #2006's remaining review-thread blocker with a separate model; it is still substantively open because issue #1934 still lacks an explicit human waiver for the missed pre-coding plan timing requirement.
- Investigated GitHub Actions run `30415015072` and traced the failing `Headless Floor 1 Gate` to `tests/headless/floor1-legacy-death-regressions.test.ts`, where `throwing-knife` seed `6` regressed from `victory` to `death`.
- Restored the spawn-room harvestable guarantee in `spawnFloor1HarvestableNodes()` without increasing total harvestable count by relocating one farthest non-spawn-room harvestable into a safe spawn-room tile only when the initial random placement produced none.
- Replaced the temporary "no special rooms" regression with deterministic coverage for the actual contract: representative seeds must get a spawn-room harvestable, and it must never occupy the player spawn tile.

## Files touched

- `src/game/floorScenario.ts`
- `tests/game/floor1-harvestable-spawn-room.test.ts`
- `docs/knowledge/handoffs/2026-07-29-pr2006-headless-recovery.md`

## Verification

- GitHub Actions inspection:
  - `list_workflow_runs` on branch `copilot/fix-harvestables-spawn-issue-another-one`
  - `get_job_logs` for run `30415015072`
- Separate-model review-thread validation (`gpt-5.6-terra`): blocker still applicable
- `npx vitest run --project unit tests/game/floor1-harvestable-spawn-room.test.ts` ✅
- `npx vitest run --project headless tests/headless/floor1-legacy-death-regressions.test.ts` ✅
- `npm run verify:fast` ✅
- `npm run verify:pr-prereqs` ✅

## Unresolved issues

- PR review comment `3650089187` remains substantively open. Issue #1934 now has a retroactive CI-filed plan comment, but there is still no explicit human waiver acknowledging that the required pre-coding issue comment was missed before implementation.

## Next steps

- Push this repair so PR #2006 gets a fresh CI run on the restored spawn-room guarantee behavior.
- Run parallel validation on the repaired branch head before closing the local recovery session.
- Leave review comment `3650089187` unresolved unless the maintainer explicitly waives the timing requirement.
