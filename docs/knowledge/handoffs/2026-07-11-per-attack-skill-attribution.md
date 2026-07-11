# Handoff: Per-attack weapon skill XP attribution

**Date:** 2026-07-11  
**PR:** #292 fix  
**Session slug:** per-attack-skill-attribution  
**Apple estimate:** 2🍎

## Summary

Fixed a weapon-skill XP misattribution bug where firing a slow projectile with weapon A, switching to weapon B, and letting the projectile land would credit weapon B's skills instead of weapon A's.

## Root cause

`world.attackerWeaponSkills` was a `Map<playerEid, {classSkillId, typeSkillId}>` keyed by the attacker (player) EID. Every `dispatchAttack` call overwrote the single map entry for that player, so any in-flight projectile from a prior weapon would pick up the most-recently-dispatched weapon's skills on hit.

## Fix

Replaced the per-attacker map with a per-attack-entity sidecar `world.attackSkillSources: Map<attackEid, {attackerEid, classSkillId, typeSkillId}>` keyed by the spawned attack entity EID. Each in-flight attack entity now carries its own skill attribution, immune to subsequent weapon dispatches.

## Files changed

- `src/core/world.ts` — `attackerWeaponSkills` → `attackSkillSources`
- `src/core/weapon-skill-bridge.ts` — look up by attack EID; new `clearAttackSkillSource()` export
- `src/game/weaponSystem.ts` — all 6 fire functions return spawned EID; `dispatchAttackInner` registers per-attack source
- `src/core/systems/damageSystem.ts` — pass attack EID to `emitWeaponHitSkillEvents`; `destroyEntity` clears source
- `src/core/systems/areaDamageSystem.ts` — pass area attack EID
- `src/core/systems/beamSystem.ts` — pass beam entity EID
- `src/core/systems/meleeSwingSystem.ts` — pass melee swing EID
- `src/core/systems/lifetimeSystem.ts` — clear source on entity expiry
- `src/core/systems/aoeOnImpactSystem.ts` — snapshot + propagate skill source to explosion entity
- `src/core/systems/trapSystem.ts` — capture + propagate skill source to explosion entity
- `tests/game/weapon-skills.test.ts` — updated to use `attackSkillSources` by attack EID
- `tests/ecs/damage-system-branches.test.ts` — updated + new weapon-switch regression test
- `tests/ecs/beam-system-branches.test.ts` — updated to use beam EID
- `tests/ecs/area-damage-system-branches.test.ts` — updated to use area attack EID

## Systems touched

weapon-system, skill-system, damage-pipeline

## Key design notes

- The sidecar map never grows unboundedly: each entry is cleared when the attack entity expires (lifetimeSystem) or is destroyed (destroyEntity in damageSystem).
- AoE-on-impact explosions and trap explosions spawn fresh area-attack entities; both `aoeOnImpactSystem` and `trapSystem` snapshot the source before their input entity is destroyed and propagate it to the new explosion entity.
- The miss path in `dispatchAttackInner` spawns cosmetic 0-damage entities but returns before skill registration — miss entities intentionally carry no skill source.
- `fireThrownAttack` had three sub-paths; refactored from early-return to single-return style so all paths return the spawned EID.

## Verification

- All 3479 unit tests pass
- Typecheck clean
- Lint clean
- `verify:fast` passes
- `parallel_validation` (CodeQL + code review): no findings
