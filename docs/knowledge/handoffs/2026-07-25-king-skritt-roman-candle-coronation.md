# Handoff: King Skritt ROMAN-CANDLE CORONATION

**Date:** 2026-07-25
**Session slug:** king-skritt-roman-candle-coronation
**Apple estimate:** 3🍎 (actual: 3🍎)
**Issue:** #1955
**PR:** (TBD — opened after this handoff)

## Systems touched

mob-abilities, combat-arena-lab, engine-vfx

## What was done

Implemented King Skritt the Unburnt's **ROMAN-CANDLE CORONATION** boss ability on
the existing typed mob-ability runtime, following the exact pattern established by
Verdigris Glamour, Bamboo-Fed Berserk, and Undercity Mob Call.

### Core changes

**`src/core/mob-abilities/types.ts`**
- Added `MobAbilityRadialProjectilesGeometry` interface (`kind: 'radial-projectiles'`,
  `casterX`, `casterY`, `count`, `spokeLengthFt`, `offsetDeg`)
- Added it to the `MobAbilityGeometry` union
- Extended `MobAbilityRuntimeDefinition.geometry` with a `'radial-projectiles'` variant
  holding `count`, `spokeLengthFt`, `alternateOffsetDeg`

**`src/core/mob-abilities/runtime.ts`**
- Added `radial-projectiles` branch in `beginTelegraph`: gets caster position, derives
  `offsetDeg = inst.resolvedCasts % 2 === 0 ? 0 : alternateOffsetDeg`, locks committed
  geometry with `casterX/casterY` from world stores at telegraph-start frame
- Added `radial-projectiles` to `canResolve` condition (alongside `spawn-circles`),
  so the ability resolves without needing a valid player target EID

**`src/core/mob-abilities/roman-candle-coronation.ts`** (new)
- `ROMAN_CANDLE_CORONATION_ABILITY_ID = 'king-skritt-roman-candle-coronation'`
- `createRomanCandleCoronationDefinition()`: reads `projectile-count` and
  `alternate-offset` from telegraph metrics, validates cross-consistency with
  effect `designValues` (including `homing: false`)
- Resolve handler: for each of 12 spokes, computes
  `angleDeg = (i/count)*360 + offsetDeg`, launches via `spawnEnemyProjectile`
- Constants: `CROWN_FLAME_SPEED = ENEMY_PROJECTILE.SPEED` (0.375 ft/step),
  `CROWN_FLAME_DAMAGE = 20`, `SPOKE_LENGTH_FT = 28`

**`src/core/mob-abilities/index.ts`**
- Added `export * from './roman-candle-coronation.js'`

**`src/engine/MobAbilityVfx.ts`**
- Imported `ROMAN_CANDLE_CORONATION_ABILITY_ID` from core
- Added color constants: `COLOR_MOLTEN_ORANGE`, `COLOR_EMBER_GOLD`, `COLOR_CHAR_SMOKE`
- Added `drawRadialTelegraph()`: draws 12 hostile-red spokes with arrowheads, crown
  halo ring, urgency-pulsing thickness/alpha as `telegraphProgress` advances
- Added `spawnCoronationBurst()`: central crown-gold flash ring, molten-orange inner
  pulse, hostile-red shockwave, spoke-tip cinder rings at each of the 12 tips,
  ember spark burst, char smoke ring
- Updated `update()` cue loop: added `radial-projectiles` guard at top (skips the
  circle-based code path for this geometry kind)
- Updated burst handler: added `radial-projectiles` check before existing dispatch

**`src/labs/combat-arena-lab/arena-data.ts`**
- Added `F2_KING_SKRITT` constant (kobold-boss archetype)
- Added `spawnKingSkryttArena()` function following the same pattern as
  `spawnQueenMabArena`/`spawnSquickArena`/`spawnBigPandaWeiArena`
- Added `f2-king-skritt` preset with floor='floor2' and `customSpawnFn: spawnKingSkryttArena`
- Imported `createRomanCandleCoronationDefinition` from core

**`scripts/agent/data/boss-abilities.floor2.status.json`**
- Updated `king-skritt-roman-candle-coronation` entry:
  - `runtimeState: 'not-started'` → `'in-progress'`
  - `telegraphVfxState: 'planned'` → `'in-progress'`
  - `arenaLabState: 'blocked'` → `'in-progress'`
  - `arenaLabPresetId: null` → `'f2-king-skritt'`
  - `implementationIssue: null` → `1955`
- Production verified is NOT set (floor2-boss-production-enable gate remains blocked)

### Tests

**`tests/unit/mob-abilities/roman-candle-coronation.test.ts`** (new, 600 lines)
Deterministic tests covering:
- Typed definition contract (abilityId, bossArchetypeKey, timing, geometry fields)
- 8s first eligibility, first resolution at 9,300ms (frame 558)
- Two resolved casts at exact cadence (frames 558 and 1116) — hard success gate
- Cooldown anchored after resolution
- 12-spoke geometry committed at telegraph start with locked caster position
- Public cue published during telegraph with correct geometry kind/color/progress
- Cast 1 offset = 0°, cast 2 offset = 15° — exact 15° alternation
- 3-cast alternation: 0°→15°→0°
- Re-registration resets resolvedCasts (no wall-clock dependency)
- Exactly 12 enemy projectiles spawned at resolution frame (hard gate)
- All 12 launched from locked caster position
- Velocity constant across frames (non-homing)
- 12 evenly-spaced angles at canonical speed (ENEMY_PROJECTILE.SPEED)
- Second-cast angles exactly 15° more than first-cast angles
- One announcement per cast (two for two casts), no double-emit
- Cleanup on death, encounter-disable, clearMobAbility, despawn, re-registration
- Zero casts in default (unregistered) configuration
- Zero casts when enabled but encounter not activated
- Arena preset exists with correct metadata
- Arena spawn arms the runtime with the coronation ability
- Arena run records exactly 2 resolved casts — hard success gate

## Key design decisions

- **Alternation from cast ordinal, not RNG**: `inst.resolvedCasts % 2` at
  telegraph-start equals the 0-based ordinal of the upcoming cast. This is fully
  deterministic and resets cleanly on re-registration.
- **Position locked at telegraph start**: `world.stores.position.x/y[casterEid]`
  sampled once in `beginTelegraph`; the locked value is stored in `committedGeometry`
  and never updated during the telegraph window.
- **Geometry reuses existing runtime infrastructure**: `committedGeometry`,
  `committedTargetEid = null`, `committedTargetGeneration = null` follow the same
  interface as spawn-circles so the burst/cleanup paths stay generic.
- **`canResolve` extended like `spawn-circles`**: radial-projectiles doesn't need a
  player target EID, so it bypasses the target-validation check alongside spawn-circles.

## What is NOT done (per spec)

- Production Floor 2 activation: behind `floor2-boss-production-enable` gate (unchanged)
- `boss-abilities.floor2.status.json` NOT marked production-verified (blocker remains)
- No browser/runtime screenshot evidence (requires interactive dev session)
- No authored cast animation (catalog marks it as 'optional')

## Verification

- TypeScript typecheck: passes (exit 0)
- Code review (parallel_validation): no concerns found
- CodeQL: 0 alerts
- Unit tests: written and compatible with existing patterns;
  CI will execute them against installed deps

## Review ledger

`docs/knowledge/review-ledgers/2026-07-25-king-skritt-roman-candle-coronation.review-ledger.json`

## Apple metrics

See `docs/knowledge/metrics/apples/2026-07-25-king-skritt-roman-candle-coronation.json`
