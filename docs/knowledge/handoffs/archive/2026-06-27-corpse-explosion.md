# Handoff — Exploding Corpses on Hit (VFX)

**Date:** 2026-06-27
**Session:** corpse-explosion
**Persona:** Systems Engineer (core trigger) + Rendering/VFX (engine layer)
**Apple estimate:** 🍎🍎🍎 | **Actual:** 🍎🍎🍎🍎 | **Verdict:** 📉 under

## What Was Done

Corpses (dead enemies still in their death-linger window) now **explode when
hit** by any player attack. The corpse sprite is dynamically cut into a 3×3 grid
of cropped shards that spray outward with gravity, spin, and fade, plus a burst
of blood specks. Drama, delivered.

The feature follows the bridge pattern: a **deterministic core trigger** decides
_when_ a corpse detonates, and a **non-deterministic engine VFX layer** decides
_how_ it looks. The core never imports Phaser; the engine never invents game
state.

## How It Works

### Trigger (core, deterministic)

`applyDamage()` is the single choke point every offensive damage source routes
through (projectile / melee / AoE / beam). The corpse-detection block sits after
the `amount <= 0` and `Invincible` guards and before the player-target branch:

- If the target is an `Enemy` with a `DeathTimer` whose `remainingMs > 0` (i.e.
  a corpse mid-linger), emit a `corpseExplode` combat event carrying position,
  blood colour, knockback direction, and `spriteTextureId`, then set
  `deathTimer.remainingMs = 0` and return `0` damage.
- `deathTimerSystem` (runs last in the pipeline) reaps the entity that same
  frame. `computeCorpseDecay(0, total)` yields alpha 0, so the fading corpse and
  the shards never visibly overlap.
- **Idempotent:** the `remainingMs > 0` guard means a second hit the same frame
  is a no-op. We do **not** remove the entity inside `applyDamage` because
  downstream callers (e.g. `meleeSwingSystem` adding `Knockback`) still use the
  eid — zeroing the timer hands reaping to the system that owns it.

### VFX (engine, non-deterministic)

- `corpse-shatter.ts` — pure, Phaser-free geometry + kinematics. Tiles the frame
  into integer crops that cover it **exactly** (area sum invariant, fast-check
  verified), rolls launch velocity/spin/lifetime from a seeded RNG, integrates
  motion, computes alpha/scale curves.
- `CorpseShatterVfx.ts` — the Phaser renderer. `explode()` builds the specs,
  creates one cropped image per cell (`setCrop`, origin at cell centre, depth
  `WORLD_VFX_DEPTH.deathPop`, `'ui'` camera ignored), and sprays specks;
  `update(renderElapsedMs, deltaMs)` integrates and destroys expired shards.
  Defensive guards throughout so headless/mock scenes don't crash.
- `PhaserBridge.ts` — two-phase wiring (ordering is critical):
  - **Phase A (sync start, before the entity loop):** scan `world.combatEvents`
    for `corpseExplode` and read the texture from the **still-present** stale
    corpse visual (`visual.obj.texture.key`, frame, scale, tint). The corpse
    visual is destroyed later in the same sync by the cleanup loop, so it must
    be captured up front. Falls back to `resolveTexture` from `spriteTextureId`.
  - **Phase B (near `goreVfx.update`):** call `corpseShatterVfx.update(...)`
    first (advances the internal clock so new shards are born at the right
    time), then replay the stashed explosions — **before** `combatVfx.update`
    drains the events.

### Bug found & fixed

`CombatVfx.update()` spawned a floating damage number for **every** combat
event. `corpseExplode` fell through to the default `-{amount}` floater, painting
a misleading `-20` over a corpse that takes 0 damage (and crashing the test mock
on `scene.add.text`). Fixed with an early `continue` for `corpseExplode`.

## Files Changed

| File                                 | Change                                                      |
| ------------------------------------ | ----------------------------------------------------------- |
| `src/shared/combat-events.ts`        | + `'corpseExplode'` event type and `spriteTextureId?` field |
| `src/core/apply-damage.ts`           | + corpse-detection trigger + `emitCorpseExplosion` helper   |
| `src/engine/corpse-shatter.ts`       | **NEW** pure shatter geometry + kinematics                  |
| `src/engine/CorpseShatterVfx.ts`     | **NEW** Phaser renderer (cropped shards + specks)           |
| `src/engine/PhaserBridge.ts`         | Two-phase wiring + `enemyVariantFromTextureId` helper       |
| `src/engine/CombatVfx.ts`            | **Bug fix**: skip `corpseExplode` (no misleading floater)   |
| `src/labs/gore-lab/index.ts`         | Hint/description copy + "Corpse Explosions" HUD counter     |
| `tests/ecs/corpse-explosion.test.ts` | **NEW** 11 core-trigger tests                               |
| `tests/unit/corpse-shatter.test.ts`  | **NEW** 25 pure-math tests (deterministic + fast-check)     |
| `tests/unit/phaser-bridge.test.ts`   | Extended `MockImage`; + shard-creation test                 |
| `docs/knowledge/adr/0027-...md`      | **NEW** ADR (cross-layer core trigger + engine VFX)         |

## Validation

- `npm run verify:fast` ✓ (typecheck + lint + 718 unit tests)
- `npm run verify` ✓ (format check, unit+coverage, integration 49 pass / 1 skip,
  **headless Floor 1 gate — 68 tests, no seed regression**, vite build)
- 36 new tests (11 core + 25 math) plus the extended bridge test, all green.

## What's Next

- **Tunables:** `corpse-shatter.ts` exports several `SHATTER_*` tuning constants
  (`BASE_SPEED`, `SPEED_JITTER`, `IMPACT_BOOST`, `DRAG`, `SPIN`, `LIFETIME_MS`,
  `LIFETIME_JITTER`) that are only consumed internally. knip is non-blocking in
  `verify.sh`, so it doesn't fail CI, but a future pass could de-export the ones
  that stay internal for cleanliness.
- **Grid resolution:** the 3×3 cut is intentional (cheap, reads clearly at sprite
  scale). If we want chunkier gibs we could parameterise `SHATTER_COLS/ROWS` per
  enemy size, but that's a follow-up, not a gap.
- **Player corpses:** the trigger is enemy-only by design. If player death ever
  grows a linger window we'd revisit whether players should detonate too.

## Blockers

None. Feature is complete, validated, and ready to merge.

## Branch State

- Branch: `nalfeo-ideal-journey`
- All tests passing: yes (`npm run verify` green end to end)
- PR created: yes (see commit + auto-merge armed)

## Agent-OS Telemetry

No `files/guard-telemetry.jsonl` present this session, so there is no
guard-telemetry section to paste.

## Key Decisions Made

- **No new ECS system.** Reused the `applyDamage` choke point + existing
  `deathTimerSystem` reaper instead of adding a system, keeping the core surface
  small (documented in ADR 0027).
- **Texture read at sync start, not at drain time.** The corpse visual is
  destroyed mid-sync, so the bridge captures it in Phase A and replays the
  explosion in Phase B. This ordering is load-bearing and called out in the ADR.
- **Zero the death timer rather than despawn in `applyDamage`.** Avoids
  downstream eid-use hazards and lets the owning system reap deterministically.

## Apples

Estimated 🍎🍎🍎 (Medium), actual 🍎🍎🍎🍎 (Large) — **📉 under** (harder than
expected). It landed at the top of Medium and crossed into Large because it
required an ADR (Medium is "usually no ADR"), changed a cross-layer contract
(shared → core → engine), shipped **two** new modules (pure math + Phaser
renderer), had genuinely subtle two-phase bridge ordering, and surfaced a real
latent `CombatVfx` floater bug. It stayed out of 5-apple territory by
deliberately avoiding a new ECS system and reusing existing primitives.

Hello kitties: 4/5 = 0.80 🎀

## Systems touched

ai-pathfinding, enemies, inventory
