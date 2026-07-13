# Weapon HUD + XP attribution fix

**Date:** 2026-07-12  
**Persona:** Producer → Systems/AI + HUD  
**Apples:** 🍎🍎🍎🍎 estimated → 🍎🍎🍎🍎 actual (re-scored from 2 after code review flagged 15-file, 3-layer scope)

## Systems touched

weapons, hud-ux, ai-combat-balance

## Summary

- Removed the HUD weapon-source fallback: `HudSkillTracker` now renders only from
  `getActiveWeaponDef(world)` and hides when no weapon is equipped.
- Added per-attack weapon skill attribution:
  - `world.attackWeaponSkillsByEntity` maps spawned attack entity IDs to class/type
    skill IDs.
  - `weaponSystem` writes attack-source skill IDs when spawning melee/projectile/beam/
    thrown/trap attacks.
  - Hit-time XP emission in damage/melee/beam/area systems now prefers per-attack
    attribution via `emitWeaponHitSkillEventsForSource(...)`.
  - AoE-on-impact and trap explosion AoEs inherit source attribution.
  - Entity-store cleanup now clears per-attack attribution to prevent recycled-ID bleed.
- Added regressions:
  - `tests/game/weapon-skills.test.ts`: delayed projectile hit remains attributed to
    the original fired weapon after switch + subsequent fire.
  - `tests/unit/hud-skill-tracker-weapon-source.test.ts`: HUD source is active-weapon
    only (no fallback).

## Verification

- `npm run verify:fast`
- `bash scripts/agent/lab-gate-check.sh`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-13-weapon-hud-xp-attribution.review-ledger.json`
- `npm run verify:pr-prereqs`

## Notes

- This change intentionally keeps `attackerWeaponSkills` as a fallback path for legacy
  callers, but all primary hit paths now use per-attack attribution.
