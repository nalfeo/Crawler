# Handoff — 2026-06-22 Weapon Skills System

## Session Summary

Implemented the weapon skills system and HUD UX as specified in the problem statement. The system covers both tiers (class + type), an accuracy mechanic, skill event emission from the weapon system, and a contextual HUD panel.

## Apples

- **Estimated:** 🍎🍎🍎🍎🍎 (Massive)
- **Actual:** 🍎🍎🍎🍎🍎 (Massive)
- **Delta:** 0 — 🎯 Exact
- **Hello kitties:** 1 🎀

The estimate was accurate. The breadth (13 new skills, WeaponDef extension, accuracy system, HUD panel, ADR, 30 test cases) is exactly massive-scale.

## What Was Shipped

### New files

- `src/shared/weapon-skills.ts` — Skill taxonomy constants (class/type IDs, accuracy tuning)
- `src/game/systems/accuracySystem.ts` — `computeAccuracy()` and `applyAccuracySpread()`
- `src/engine/HudSkillsPanel.ts` — Compact bottom-right skills panel
- `tests/game/weapon-skills.test.ts` — 30 tests covering taxonomy, weapon tags, accuracy, and progression
- `docs/knowledge/adr/0017-weapon-skill-taxonomy.md`

### Modified files

- `src/shared/weaponDefs.ts` — Added `classSkillId`, `typeSkillId`, `baseAccuracy` to `WeaponDef` + all 15 weapon defs
- `src/game/skills/types.ts` — Extended category to include `'weapon_class' | 'weapon_type'`
- `src/game/skills/registry.ts` — Added 5 class + 8 type skill definitions (13 total) + helper exports
- `src/game/systems/index.ts` — Exported `computeAccuracy`, `applyAccuracySpread`
- `src/game/weaponSystem.ts` — Imports accuracySystem; applies spread on fire; emits skill events; syncs `world.activeWeaponId`
- `src/core/world.ts` — Added `activeWeaponId: string | null` field to `GameWorld`
- `src/engine/HudUI.ts` — Integrated `HudSkillsPanel`
- `src/labs/skill-lab/index.ts` — Grouped skill tables (general / class / type)
- `tests/game/skill-registry.test.ts` — Updated category assertions to include new categories
- `tests/game/ranged-weapons.test.ts` — Updated pistol velocity test to check speed magnitude (accuracy spread changes direction)

## Design Decisions

1. **Skill events fire on weapon use, not confirmed hit.** Core damage systems can't import from game layer. "Using items" matches design intent.
2. **Accuracy is computed on demand** via `computeAccuracy()`, not stored as a `StatKey`. Avoids touching the whole stats schema.
3. **`world.activeWeaponId`** added to core world so the engine HUD layer can read the active weapon without importing from `src/game/`.
4. **Balance thresholds:** type[3]=150, class[1]=150 — both hit floor 1 target at the same usage budget; class grows 4× steeper thereafter.

## Remaining Work

- Accuracy HUD tooltip (show current accuracy % on hover)
- Skills tab in inventory/character screen (full skill list, not just active weapon)
- `forearms` class skill needs a way to grant XP when no weapon equipped (currently unarmed punch/kick trigger it via classSkillId)
- Milestone effects for weapon skills are stat-wide (not weapon-specific) — a future "weapon-conditional buff" system could scope them
- Bow/crossbow/pistol type skills exist in registry but no floor-1 weapons use them yet

## State

All systems clean — typecheck, lint, 1608 tests pass.
