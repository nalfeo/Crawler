# Handoff: Implement Don Paco's THE BIG GOB on the typed mob-ability runtime

## Date

2026-07-25

## Session slug

don-paco-big-gob

## Systems touched

mob-ability-runtime, ai, vfx, arena-lab, boss-status

## PR

https://github.com/nalfeo/Crawler/pull/2016

## Closes

https://github.com/nalfeo/Crawler/issues/1952

## What was done

Implemented Don Paco's THE BIG GOB ability on the typed mob-ability runtime with a
five-projectile fan geometry contract shared across telegraph rendering, AI avoidance,
projectile travel, impact damage, and 4-second slowing slicks.

### Core changes (`src/core/mob-abilities/`)

- **`don-paco-the-big-gob.ts`** (new): Reads tuning from the `don-paco-the-big-gob`
  boss-ability catalog entry, builds the `projectile-fan` geometry, wires the
  `onImpact` handler (damage + slick zone spawn), and exports
  `createDonPacoBigGobDefinition()` / `DON_PACO_BIG_GOB_ABILITY_ID`.
- **`runtime.ts`**: Added `tickActiveProjectiles`, `tickActiveZones`,
  `launchMobAbilityProjectiles`, `spawnMobAbilityZone`. Fixed death-ordering defect:
  casters are validated and cleared BEFORE ticking owned projectiles/zones (ADR 0076).
- **`types.ts`**: Added `MobAbilityActiveProjectileState`, `MobAbilityActiveZoneState`,
  `MobAbilityProjectileFanPath`, `MobAbilityBurst`; extended runtime state shape.
- **`index.ts`**: Exported new public API surface.

### Engine VFX (`src/engine/MobAbilityVfx.ts`)

- Added rendering for locked projectile-fan telegraph (cone + five paths + landing circles),
  projectile travel (in-flight particles), impact bursts (abilityId-dispatched), and
  persistent slick rims/cleanup.

### AI (`src/game/ai/bt-ai-provider.ts`)

- Fixed zone-dodge vector preservation: `preserveMobAbilityDodge` now also checks active
  zone occupancy (player inside any slick zone) so travel steering does not clear the
  outward dodge vector while the player is inside a slick. Previously only telegraph cues
  were checked, allowing AI to walk through active slicks.

### Lab / arena (`src/labs/combat-arena-lab/arena-data.ts`)

- Added `f2-don-paco` preset to the canonical combat arena.

### Status / evidence

- `boss-abilities.floor2.status.json`: Corrected Don Paco entry — populated
  `implementationPullRequest` reference (was `null`), verified all state fields.
- `don-paco-arena-evidence.ts`: Headless evidence script for cadence/impact proof.

### Tests

- `tests/unit/mob-abilities/big-gob.test.ts`: Focused coverage for cast cadence,
  telegraph/path locking, five-projectile resolution, inside/outside damage, slick
  slow/expiry, announcement dedupe, repeat casts, all cleanup paths, and a new
  **final-travel-frame death regression test** (verifies caster killed one frame before
  impact does not trigger `onImpact`).
- `tests/e2e/don-paco-arena-observation.test.ts`: Canonical browser-observation coverage.
- `tests/unit/ai/mob-ability-circle-avoidance.test.ts`: Zone avoidance coverage.
- `tests/unit/mob-ability-vfx.test.ts`: VFX state coverage.

### ADR

- ADR 0076: Don Paco projectile-fan geometry and zone ownership — covers committed
  geometry authority, projectile/zone lifecycle, death-ordering contract, zone-dodge
  preservation, and shared VFX consumers.

## Production gate

The ability is blocked behind `floor2-boss-production-enable` in the default runtime
wiring. The canonical combat arena (`f2-don-paco`) is the verification surface.

## Known state

- All five review threads on PR #2016 addressed:
  - Death-ordering fix applied (runtime.ts, ADR 0076)
  - Zone-dodge vector preservation fixed (bt-ai-provider.ts)
  - Review ledger completed (both code_review and multi_model_review rounds)
  - PR reference populated in boss-abilities.floor2.status.json
  - ADR 0076 created
- verify:fast passing (115 test files, 1719 tests)
- PR is mergeable once CI passes
