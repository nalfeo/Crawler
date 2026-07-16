# Handoff: Weapon Class/Type Skill System + Accuracy

**Date:** 2026-06-22
**Persona:** Producer (Systems Engineer + Game Designer)
**Apple estimate declared:** 🍎🍎🍎🍎🍎 | **Actual:** 🍎🍎🍎🍎🍎 | **Verdict:** Accurate

## Systems touched

weapons

## What was done

Implemented the full weapon skills system as described in the problem statement, plus an accuracy system that those skills feed into.

### Skill Taxonomy

**Weapon Class Skills** (7 total — slow leveling, damage focus):
| Skill | Weapons | Per-Level Bonus |
|-------|---------|-----------------|
| `slashing` | sword | +2 damage |
| `stabbing` | knife | +2 damage |
| `smashing` | hammer, baseball-bat, bowling-ball | +2 damage |
| `ranged` | bow, crossbow, pistol | +2 damage |
| `throwing` | boomerang, throwing-knife | +2 damage |
| `forearms` | punch, kick | +1 damage |
| `arcane` | fireball, laser, landmine | +2 damage |

**Weapon Type Skills** (10 total — fast leveling, accuracy focus):
| Skill | Weapons | Per-Level Bonus |
|-------|---------|-----------------|
| `sword` | sword | +3% accuracy |
| `dagger` | knife | +3% accuracy |
| `hammer` | hammer | +3% accuracy |
| `sports-equipment` | baseball-bat, bowling-ball | +3% accuracy |
| `bow` | bow | +3% accuracy |
| `crossbow` | crossbow | +3% accuracy |
| `pistol` | pistol | +3% accuracy |
| `throwing-weapons` | boomerang, throwing-knife | +3% accuracy |
| `unarmed` | punch, kick | +3% accuracy |
| `spellcraft` | fireball, laser, landmine | +3% accuracy |

### Accuracy System

Every `WeaponDef` now has a `baseAccuracy` (0.65–1.0):

- Melee: ~0.85–0.90
- Ranged: 0.75–0.80
- Laser/beam: 0.95 (hitscan-ish)
- Traps: 1.0 (always land)
- Throwing: 0.65–0.75

`accuracy` stat (new in STAT_KEYS):

- Base: 0 (weapon's baseAccuracy is separate — stacked on top)
- Dexterity contributes `+0.01` accuracy per point
- Type skill contributes `+0.03` accuracy per level via `addStatModifier`
- Applied in `weaponSystem.dispatchAttack`: `effectiveAccuracy = min(1, def.baseAccuracy + stats.accuracy)`
- RNG roll: if `world.rng.next() >= effectiveAccuracy` → miss (no attack spawned, skill events still emit)

### Balance (floor 1 targets)

| Target                             | Threshold               | Validated by                         |
| ---------------------------------- | ----------------------- | ------------------------------------ |
| Type skill level 4 by floor 1 end  | threshold[3] = 90 fires | `weapon-skills.test.ts` balance test |
| Class skill level 2 by floor 1 end | threshold[1] = 80 fires | `weapon-skills.test.ts` balance test |

Both tests simulate 200 weapon fires and assert the target level is reached.

### New `weapon_fired` UsageMetric

Added to `src/shared/skills.ts` and the Zod schema in `registry.ts`. Fires on every weapon dispatch (class + type skill both receive it), regardless of accuracy roll outcome.

## Files Changed

| File                                 | Change                                                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `src/shared/weapon-skills.ts`        | **NEW** — taxonomy types, constants, threshold arrays                                              |
| `src/shared/skills.ts`               | Added `weapon_fired` UsageMetric                                                                   |
| `src/shared/stats.ts`                | Added `accuracy` to STAT_KEYS, STAT_BASE/MIN/INCREMENT, CORE_STAT_GAINS (dexterity)                |
| `src/core/components.ts`             | Added `accuracy` field to stats store                                                              |
| `src/shared/stat-display.ts`         | Added accuracy display entry + updated dexterity description                                       |
| `src/shared/weaponDefs.ts`           | Added `baseAccuracy`, `weaponClassSkillId`, `weaponTypeSkillId` to WeaponDef + all 15 weapons      |
| `src/game/skills/registry.ts`        | Added 17 new skill definitions (7 class + 10 type); `weapon_fired` added to Zod schema             |
| `src/game/weaponSystem.ts`           | Added `emitWeaponSkillEvents()`, `computeEffectiveAccuracy()`, accuracy roll in `dispatchAttack()` |
| `src/labs/weapon-skill-lab/index.ts` | **NEW** — lab with fire simulation, per-weapon accuracy table, skill level tracking                |
| `src/lab-main.ts`                    | Registered `weapon-skill-lab`                                                                      |
| `tests/game/weapon-skills.test.ts`   | **NEW** — 18 tests covering taxonomy, weapon fields, accuracy, skill emission, balance             |

## Known Gaps / Future Work

- **HUD/UX**: The skill levels are computed but not yet shown in any in-game UI (skill tracker, tooltip, etc). A `SkillsUI` panel needs to be wired into the main HUD.
- **Legacy projectile mode**: The legacy fire path in `weaponSystem` (non `activeWeaponDef`) does not emit weapon skill events — only the data-driven weapon path does. This is fine for now since all gameplay uses `setActiveWeapon`.
- **Accuracy visual feedback**: Misses produce no feedback (no "miss" text popup, no sound). Adding a `'miss'` CombatEvent type would enable VFX for missed attacks.
- **Enemy accuracy**: The accuracy system is player-only. Enemies fire without an accuracy roll.
- **`swordsmanship` hardcode in damageSystem**: `damageSystem.ts:128` still hardcodes a `swordsmanship` skill event on projectile hits. This can be removed or migrated to the weapon_fired approach in a follow-up, since `swordsmanship` now coexists separately with the new weapon skills.
