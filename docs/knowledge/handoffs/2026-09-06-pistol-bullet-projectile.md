# Session Handoff: Pistol Bullet Projectile Presentation

## Date

2026-09-06

## Persona

Gameplay Engineer

## Systems touched

world-state, engine-bridge, weapon-system, sprites

## Apples

2🍎 estimated, 2🍎 actual.

## Summary

Implemented issue #4274 by treating the existing `pistol` weapon ID as the
gun that needs a bullet presentation. Player projectiles now carry an explicit
`ProjectileVisualKind` through their ECS lifetime. Pistol shots resolve to the
`bullet` render kind; bow and crossbow shots resolve to `arrow`. Existing
enemy, AoE, returning, and generic projectile paths retain their prior
behavior.

The shared render mapping now has separate bullet and arrow entries. Arrow
continues to use the Tiny Dungeon arrow/bolt sprite when available, while both
identities have deterministic procedural fallbacks. Projectile rotation and
impact cleanup retain the selected identity until the projectile is removed.

## Classification fix

The initial cut keyed the bullet/arrow choice off an exact `def.id === 'pistol'`
check, so firearm variants that reuse the pistol identity through
`weaponTypeSkillId: 'pistol'` (`musketeer-rifle`, `cog-pistol`, and the Wave B
`firearm` profile) still rendered as arrows. `fireRangedAttack` now classifies
by `def.weaponTypeSkillId === 'pistol'` instead of the exact weapon id, so
every firearm variant gets the bullet identity while bow/crossbow (whose
`weaponTypeSkillId` is `'bow'`/`'crossbow'`) keep arrows.

## Observation

The deterministic real weapon-to-render pipeline was exercised through
`weaponSystem` with `createTestWorld()`, collision/damage handling, and the
same `resolveRenderKind` helper consumed by `PhaserBridge`. Before the change,
all plain player projectiles resolved through `proj` and its arrow mapping.
After the change, pistol resolves to `bullet` and bow/crossbow resolve to
`arrow`; bow identity remains arrow after impact while piercing keeps the
entity alive, and crossbow cleanup removes the entity on its first impact.

A unit-level `resolveRenderKind` assertion cannot prove the REAL render
bridge draws the bullet texture, so `tests/e2e/pistol-bullet-projectile-render.test.ts`
boots the real `MainGameScene` through `main-scene-probe-lab`, equips each
weapon, fires it through the real `weaponSystem` (new probe methods
`fireActiveWeaponForProjectileProbe` / `getProjectileRenderInfo`), and reads
the live display list's texture key for the spawned `Projectile` entity:

- `pistol`, `musketeer-rifle`, `cog-pistol`, and the Wave B firearm-family
  `weapon.rivet-gun` (all `weaponTypeSkillId: 'pistol'`) render with the
  `__cw_bullet` texture (`renderKind: 'bullet'`).
- `bow` and `crossbow` render with the `__cw_arrow` texture (`renderKind:
'arrow'`).

Both before (exact-ID check missed `musketeer-rifle`/`cog-pistol`, rendering
`__cw_bullet`'s arrow-mapped predecessor `proj`→arrow) and after (all three
firearm variants render `__cw_bullet`) states were confirmed by running this
e2e suite against the pre-fix and post-fix `weaponSystem.ts`.

## Validation

- `tests/game/ranged-weapons.test.ts`: pistol bullet, firearm-variant
  (`musketeer-rifle`, `cog-pistol`, Wave B `weapon.rivet-gun`) bullet
  classification via `weaponTypeSkillId`, bow arrow, crossbow arrow, and
  impact/lifecycle assertions.
- `tests/e2e/pistol-bullet-projectile-render.test.ts`: real booted-scene
  display-list evidence that pistol/firearm variants render `__cw_bullet` and
  bow/crossbow render `__cw_arrow`.
- `tests/unit/phaser-bridge-sprite-kind.test.ts`: bullet/arrow render-kind
  dispatch.
- `tests/unit/procedural-fallback-facing.test.ts`: procedural texture mocks.
- `npm run typecheck`
- `bash scripts/agent/verify-fast.sh` (focused checks pass; unrelated baseline
  regression fixtures currently fail in the repository-wide changed-test leg).
