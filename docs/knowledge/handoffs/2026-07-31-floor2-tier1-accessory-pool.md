# Session Handoff: Restore Tier1 Floor 2 accessory eligibility

## Date

2026-07-31

## Persona

Game Designer

## Systems touched

quests, inventory, weapons

## Apples

2🍎 estimated, 2🍎 actual (exact)

## What Was Done

Fixed the Floor 2 achievement reward path so tier1 rewards are no longer hard-locked to
weapon-only outcomes. PR was also a CI recovery that merged with main's #2415 refactor
(lootBox architecture with an 88-item `FLOOR2_REWARD_POOL_STABLE_IDS`), then applied the
modest-accessory eligibility change on top.

- **Merged main's #2415 architecture**: `lootBox` reward type, `FLOOR2_REWARD_POOL_STABLE_IDS`
  (88 items: Wave A weapons + Wave B weapons/non-weapons + Classic Fantasy Basic Leather set),
  `_rarityEligibleBaseIds` / `_computeFloor2RewardPoolTierEligibility` / `_validateFloor2RewardPoolTierEligibility`.
- **Applied modest-accessory eligibility on top of main's architecture**:
  - Added `COMMON_REWARD_SINGLE_STAT_CAPS` constant and `statBonusesExceedCommonLimit()`
    private helper to `generated-equipment-generator.ts`.
  - Exported `generatedEquipmentBaseExceedsCommonStatLimit()` and
    `generatedEquipmentInstanceExceedsCommonStatLimit()` from the same file.
  - Updated `_rarityEligibleBaseIds()` in `floor2-reward-bundle-resolver.ts` to use
    `generatedEquipmentBaseExceedsCommonStatLimit` instead of the blanket
    `generatedEquipmentBaseHasNonArmorStatBonus` exclusion.
  - Updated `_assertGeneratedRewardInstanceLegal()` to use
    `generatedEquipmentInstanceExceedsCommonStatLimit` for defense-in-depth.
  - Common-eligible non-weapon count grows from 10 → 28 (4 excluded: shadow-boots,
    merchant-sandals, blood-vial, lucky-feather due to over-budget or multi-bonus).
- **Fixed missing exports** in `src/shared/generated-assets.ts`:
  `DEFAULT_GENERATED_ANCHOR`, `DEFAULT_GENERATED_FRAME_SIZE_PX`, `resolveOpaqueBox`
  (main's `generated-assets.test-seams.ts` imports them; merge had taken my branch's
  version that stripped the `export` keywords).
- Updated resolver tests: composition counts (66→84 common-eligible), post-generation
  contract test, consistency test.

## Key Decisions Made

- **Use one shared reward pool constant instead of editing 36 JSON entries.**
  This keeps the diff surgical while removing the repeated placeholder weapon list from the
  runtime catalog.
- **Relax the Common contract by magnitude, not by category.**
  The old rule accidentally banned every accessory because accessories exist to carry
  non-armor bonuses. The new rule still preserves "tier1 is modest" by allowing only a
  single capped non-armor bonus.
- **Keep the change local to shipped Floor 2 content.**
  `createAchievementCatalog()` stays generic for tests and synthetic catalogs; only the
  shipped `FLOOR2_ACHIEVEMENT_CATALOG` gets the shared Floor 2 reward pool override.

## Files Changed

- `src/shared/generated-assets.ts` (restored missing `export` keywords for test-seams compat)
- `src/game/generated-equipment-generator.ts` (added stat-cap logic and exported functions)
- `src/game/floor2-reward-bundle-resolver.ts` (switched Common filter to stat-cap functions)
- `tests/unit/floor2-reward-bundle-resolver.test.ts` (updated 3 test cases for new counts)
- `src/shared/data/floor2-reward-pool.ts` (taken wholesale from main's #2415 — 88-item pool)
- `src/shared/achievements.ts` (taken from main's #2415 — lootBox architecture)
- `docs/knowledge/review-ledgers/2026-07-31-floor2-tier1-accessory-pool.review-ledger.json`

## Verification

- `npm run format:check` → clean (fixed formatting in `floor2-reward-bundle-resolver.test.ts`)
- `npm run typecheck` → clean
- `npx vitest run tests/unit/floor2-reward-bundle-resolver.test.ts` → 42 tests pass
- `npx vitest run tests/unit/achievements.test.ts tests/game/achievement-system.test.ts tests/game/settlement-maintenance-planner.test.ts tests/unit/achievement-reward-presentation.test.ts` → 84 tests pass
- `npm run verify:fast` → all 2076 unit tests pass, all format/lint/type checks clean
- `parallel_validation` → CodeQL 0 alerts, code review no findings

## Unresolved Issues / Blockers

None. The PR is ready to merge.
