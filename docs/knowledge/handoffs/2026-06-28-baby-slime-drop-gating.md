# Session Handoff: Baby slime drop gating

## Date

2026-06-28

## Persona(s) adopted

Producer (primary), with Systems Engineer-style implementation in `src/core/**` and QA Engineer-style regression coverage in `tests/**`.

## Routing verdict

✅ right persona — the bug crossed gameplay gating and ECS regression coverage, but stayed small and localized.

## Apples

Estimated: 🍎 x 3
Actual: 🍎 x 2
Verdict: 📈 Over — the fix collapsed to a one-line gameplay gate correction plus focused regression coverage.

Hello kitties: 2/5 = 0.40 🎀

## Systems touched

inventory

## What Was Done

- Removed the `slime-mini` bypass in `/home/runner/work/Crawler/Crawler/src/core/systems/dropSystem.ts` so Floor 1 baby slimes obey the same tutorial drop gate as every other enemy.
- Replaced the incorrect regression in `/home/runner/work/Crawler/Crawler/tests/ecs/drop-system.test.ts` with split-baby coverage for both locked and unlocked states.
- Extracted a shared split-baby world setup helper in the test file to keep the new regressions readable and deterministic.

## Before / After Observation

Headless reproduction command (same probe before and after fix):

`npx tsx <<'EOF' ... synthetic slime-mini kill before/after meetTutorialGoon ... EOF`

- **Before fix:** `[{"unlocked":false,"xp":2,"gold":0},{"unlocked":true,"xp":2,"gold":0}]`
- **After fix:** `[{"unlocked":false,"xp":0,"gold":0},{"unlocked":true,"xp":2,"gold":0}]`

This confirms the bugged pre-unlock XP drop was removed while post-unlock XP drops still occur.

## What's Next

- Optional follow-up: if design wants baby slimes to have a distinct reward profile from normal enemies, give `slime-mini` an explicit loot-table path rather than inheriting the default enemy union implicitly.

## Blockers

None.

## Branch State

- Branch: current worktree branch
- PR created: no
- Guard telemetry file: absent (`files/guard-telemetry.jsonl` missing)

## Test Results

- ✅ `npm test -- tests/ecs/drop-system.test.ts`
- ✅ `npm run verify:fast`
- ✅ `bash scripts/agent/lab-gate-check.sh`
- ✅ `npm run verify`
- ✅ `parallel_validation` Code Review/CodeQL pass on logic; final rerun hit session time limit after follow-up cleanup, but the flagged cleanup was test-only and was applied.

## Key Decisions Made

- Treated the existing `slime-mini` gate bypass as the root cause and removed it instead of adding another special case.
- Preserved post-unlock baby-slime XP drops and pinned that behavior with a regression test because the reported “no loot/xp” symptom could not be reproduced once the unlock was active.
