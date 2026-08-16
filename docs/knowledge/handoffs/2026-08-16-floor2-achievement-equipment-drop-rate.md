# Session Handoff: Floor 2 achievement equipment drop rate halved with a Floor 2 materials fallback

## Date

2026-08-16

## Persona

Game Designer

## Systems touched

quests

## Apples

3🍎 estimated, 3🍎 actual

## What Was Done

Floor 2 achievement boxes previously granted generated equipment on 100% of
unlocks, which flooded the player with gear. Now every Floor 2 achievement still
points at Floor 2's own `floor2-generated-equipment` table, but `common` and
`uncommon` boxes only contain equipment on a deterministic 50% roll
(`rollFloor2AchievementEquipmentDrop`, seeded from the generated-equipment run
key). `rare` boxes and the `floor2-field-kit` starter kit remain guaranteed.

A missed roll pays out Floor 2's own materials instead — gold 75/150/300 (3×
Floor 1's 25/50/100) plus a Common+Uncommon Floor 2 crafting-material pool
(`FLOOR2_CRAFTING_MATERIALS`) — so a lower-tier achievement is never a dud.
`floor1-lootbox-reward-resolver.ts` was renamed to
`lootbox-materials-reward-resolver.ts` and generalized with a `table` parameter;
Floor 1's RNG stream key is byte-identical so existing Floor 1 bundles replay
unchanged.

Observed in the real pipeline via `tests/integration/floor2-reward-bundle-claim.integration.test.ts`,
which drives the real `achievementSystem` tick — before: every Floor 2 unlock
produced a `generatedEquipmentRewardBundles` entry; after: lower-tier unlocks
split between an equipment bundle and a Floor 2 materials bundle (gold 75,
Floor 2 materials), claimed and carried over correctly.

## Key Decisions Made

- "Half of what it was" was implemented as a per-tier drop chance
  (`common`/`uncommon` = 0.5, `rare` = 1.0) rather than halving the number of
  equipment-granting achievements, because the human explicitly asked that lower
  tiers keep a chance.
- The persisted `LootBoxRewardBundleV1` schema was NOT changed. Which materials
  table a bundle must satisfy is derived from the achievement's reward via
  `materialsTableForReward()`, so old snapshots stay valid.
- "Which payout did this achievement get?" is encoded by which map holds the
  bundle (`generatedEquipmentRewardBundles` vs `lootBoxRewardBundles`). Exactly
  one, enforced by a new fail-closed carryover exclusivity guard.
- Both resolve paths run before the unlock mutation and fail closed, so a
  missing run key or disabled Floor 2 access never produces a half-unlocked
  achievement.

## What's Next / Blockers

No blockers. If playtesting shows the halved rate is still too generous, the
knob is `FLOOR2_EQUIPMENT_DROP_CHANCE_BY_TIER` in `src/shared/achievements.ts` —
a single-constant change with the drop-rate test in
`tests/unit/floor2-reward-bundle-resolver.test.ts` as the gate. A seed sweep
measuring gear-per-run on Floor 2 would make the next tuning pass evidence-backed
rather than intuition-backed.

## Retrospective

### Lessons Learned

- The generated-equipment registry validates that a carryover snapshot's run key
  matches the destination world's run key, so a test that searches across run
  keys for a specific roll outcome must thread the winning run key into the
  destination world.
- `verify:fast` cannot run in this shallow clone (no merge base for
  changed-file scanning); the individual gates (`lint`, `format:check`, `tsc`,
  `test:unit`, `test:integration`) were run directly instead and CI covers the
  rest.

### Mistakes Made

- The first pass answered "fewer equipment drops" by moving 24 Floor 2
  achievements onto Floor 1's `floor1-materials` table. That was rejected: it
  removed the chance entirely for lower tiers and reused another floor's
  content. Early signal that was missed — the ask said "drop rate", i.e. a
  probability, not a reassignment of which achievements grant gear. When a
  tuning request names a _rate_, change the rate.
- Drop-roll tests were initially parked in the materials-resolver test file even
  though the function lives in `floor2-reward-bundle-resolver.ts`; code review
  caught the mismatch and they were moved.

### Opportunities for Future Improvement

- There is no headless metric for "generated equipment granted per Floor 2 run",
  so gear-flood regressions are invisible to CI. A `RunStats` counter plus a
  sweep-backed threshold would turn this class of tuning into a deterministic
  gate.
