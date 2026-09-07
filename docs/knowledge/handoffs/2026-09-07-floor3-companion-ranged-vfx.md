# Session Handoff: Floor 3 companion ranged VFX

## Date

2026-09-07

## Persona

Producer (runtime fix + deterministic regression coverage)

## Systems touched

ai-behavior-tree, enemies, vfx, weapons

## Apples

2🍎 exact

## What Was Done

- Updated `src/game/systems/companionCombatSystem.ts` so Floor 3 companions with a positive
  ranged attack profile spawn the normal `EnemyProjectile` trail instead of applying instant
  melee damage; this preserves the existing deterministic projectile lifecycle, visibility, and
  cleanup path for ranged attacks.
- The ranged projectile uses the shared projectile VFX/visual route (`ProjectileVisualKind.BULLET`)
  so the visual effect is visible while the source/target attribution remains consistent with the
  projectile collision pipeline.
- Added a deterministic regression in `tests/game/floor3-companion-combat.test.ts` that proves
  ranged Floor 3 companions emit a visible projectile without changing melee companion outcomes.

## Verification

- `npx vitest run tests/game/floor3-companion-combat.test.ts`
- `bash scripts/agent/verify-fast.sh`

## Risk

Low. The fix is scoped to Floor 3 ranged companion attacks and reuses the same projectile path as
existing enemy ranged fire; melee companions and all combat balance numbers remain unchanged.
