# Handoff — Weapon Skill Hit-Only XP

**Date:** 2026-06-24  
**Session:** weapon-skill-hit-only-xp  
**Persona:** Game Designer  
**Apple estimate:** 🍎🍎 | **Actual:** 🍎🍎 | **Verdict:** exact

## Systems touched

inventory, weapons

## What Was Done

Implemented the feature: **weapon skills only gain XP when they hit and do damage**.

Previously, `emitWeaponSkillEvents` was called in `dispatchAttack` _before_ the accuracy roll, meaning every attack dispatch (hit or miss) granted skill XP. This PR changes that so skills only advance when an attack actually lands and deals damage to an enemy.

## Design Decisions

**"Hit and damage" means actual damage dealt to an enemy**, not merely passing the accuracy check. The implementation:

1. `dispatchAttack` registers `world.attackerWeaponSkills.set(player, {classSkillId, typeSkillId})` **after** the accuracy check passes (so misses never register skills)
2. Each attack-resolution system (melee swing, projectile, beam, area damage) calls `emitWeaponHitSkillEvents(world, ownerEid)` after `applyDamage` returns > 0 against an Enemy entity

This means:

- Misses → no XP ✓
- Hits into empty space (swing, projectile travel misses) → no XP ✓
- Hits against invincible enemies (Invincible component) → no XP ✓
- Hits that deal actual damage → XP ✓
- AoE/pierce weapons gain XP per enemy hit (more enemies = more XP) ✓
- Beam weapons gain XP per tick per enemy hit ✓

## Files Changed

| File                                   | Change                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| `src/core/world.ts`                    | Added `attackerWeaponSkills: Map<number, {classSkillId, typeSkillId}>`            |
| `src/core/weapon-skill-bridge.ts`      | New helper `emitWeaponHitSkillEvents`                                             |
| `src/core/helpers.ts`                  | Optional `ownerEid` on `spawnProjectile` + `spawnBouncingProjectile`              |
| `src/core/systems/meleeSwingSystem.ts` | Emit skill events after damage                                                    |
| `src/core/systems/damageSystem.ts`     | Emit skill events after projectile damage                                         |
| `src/core/systems/beamSystem.ts`       | Emit skill events after beam damage                                               |
| `src/core/systems/areaDamageSystem.ts` | Emit skill events after area damage                                               |
| `src/game/weaponSystem.ts`             | Moved skill registration to post-miss-check; updated fire functions to pass owner |
| `src/shared/skills.ts`                 | Updated `weapon_fired` metric comment                                             |
| `tests/game/weapon-skills.test.ts`     | +4 tests for hit gate behavior                                                    |

## Notes for Next Agent

- `emitWeaponSkillEvents` still exists as an exported function for lab/test use (simulates a hit directly)
- Weapon-skill-lab simulates "fires" via `emitWeaponSkillEvents` — this is still valid as it simulates _hits_, but the label "fires" in the UI is now slightly misleading. A follow-up could rename it to "Simulate ×1 Hit" etc.
- Balance thresholds (`CLASS_SKILL_THRESHOLDS`, `TYPE_SKILL_THRESHOLDS`) were not changed. With hit-gating, players with low accuracy will level skills slower. This may warrant rebalancing in a future session.
- The sentinel value for "no owner" is `-1` (consistent with existing pattern throughout the codebase)
