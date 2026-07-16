# 2026-06-28 — achievement unlock rules config-driven

## Systems touched

quests

## Summary

- Moved Floor 1 achievement unlocking from hard-coded branching to declarative config rules.
- Added strict unlock-rule validation at achievement catalog load time.
- Added phase-based evaluation (`tick` vs `run_end_clear`) so run-end achievements are config-driven too.

## Code changes

- Updated `/home/runner/work/Crawler/Crawler/src/shared/achievements.ts`:
  - Added unlock-rule DSL types (`numberCompare`, `booleanIs`, `allQuestsComplete`) and phase model.
  - Extended Zod schema so every achievement must include `unlockRules` and invalid/unknown rule shapes fail fast.
  - Added `parseAchievementCatalog()` and kept existing catalog exports.
- Updated `/home/runner/work/Crawler/Crawler/src/shared/data/achievements.floor1.json`:
  - Added `unlockRules` on all 100 entries.
  - Encoded existing unlockable achievements as declarative rules.
  - Added run-end phase rules for `stairs-discovered`, `floor1-clear`, and `broke-speedrun`.
- Updated `/home/runner/work/Crawler/Crawler/src/game/systems/achievementSystem.ts`:
  - Replaced hard-coded unlock `if` statements with a generic facts + rule evaluator.
  - Added `evaluateAchievementUnlocksForPhase(world, phase)` and kept `achievementSystem()` as tick-phase entrypoint.
- Updated `/home/runner/work/Crawler/Crawler/src/game/floorScenario.ts`:
  - Replaced direct run-end unlock calls with phase evaluation (`run_end_clear`).
- Updated exports:
  - `/home/runner/work/Crawler/Crawler/src/game/systems/index.ts`
  - `/home/runner/work/Crawler/Crawler/src/game/index.ts`
- Updated `/home/runner/work/Crawler/Crawler/tests/unit/achievements.test.ts`:
  - Added validation coverage for required `unlockRules` and unknown rule-type rejection.

## Validation

- `npm run verify:fast` ✅
- `npm run verify` ✅
- `bash scripts/agent/lab-gate-check.sh` ✅
- `parallel_validation` ✅ (Code Review clean, CodeQL clean)

## Scripting language decision

- Did **not** add a general scripting language.
- Implemented a constrained declarative rule DSL for deterministic, schema-validated unlocking.

## Apple complexity

- Estimated: 🍎🍎🍎🍎
- Actual: 🍎🍎🍎🍎
- Verdict: exact
