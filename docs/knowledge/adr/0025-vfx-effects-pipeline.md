# ADR 0025: Generic VFX Effects Pipeline

## Status

Accepted

## Date

2026-06-26

## Estimated Complexity

🍎 x 5 — new data-only event queue spanning core/game/engine, a new engine
renderer, a preview lab, an ADR, and emit sites across pickup + level systems.

## Context

The game had targeted VFX (`CombatVfx` floating damage numbers, `GoreVfx` blood
splatter, the boss-spawn flash/shake/ring in `MainGameScene`) but most moment-to-
moment feedback had zero "juice": item/gold/gem pickups, level-ups, weapon hits,
crits, enemy deaths, and player-hurt all happened silently. The art style guide
(`docs/knowledge/game-design/art-style-guide.md`) explicitly prioritises juice and
Vampire-Survivors-style on-screen density over detailed sprites, so this is a gap.

Each existing effect was bespoke and hand-wired into one call site. There was no
reusable way for an arbitrary core/game system to request a cosmetic effect at a
world position without violating the layer rules (`src/core` and `src/game` must
not import Phaser or `src/engine`).

We needed a pattern that:

- lets pure ECS systems request effects without any rendering dependency,
- is deterministic-safe (cosmetic only — never touches simulation/RNG),
- works under headless/AI runs where there is no renderer,
- is CI-safe and unit-testable in mocked scenes,
- mirrors an already-proven pattern in the codebase rather than inventing one.

## Decision

Introduce a generic, data-only **VFX effect-request queue** and a single engine
consumer, modelled on the existing `combatEvents` → `CombatVfx`/`GoreVfx` flow.

1. **Data contract — `src/shared/vfx-events.ts`** (no Phaser imports):
   - `VfxEvent { kind, x, y, color?, intensity? }` with a `VfxEffectKind` union
     (`pickupSparkle`, `levelUpBurst`, `hitSpark`, `critBurst`, `deathPop`,
     `playerHurt`).
   - `PICKUP_SPARKLE_COLORS` (gem cyan / gold / item white).
   - `pushVfxEvent(events, event)` enforcing `VFX_EVENT_CAP` (512, drops oldest)
     so headless runs with no renderer cannot grow the queue unbounded.

2. **Queue — `world.vfxEvents: VfxEvent[]`** on `GameWorld` (`src/core/world.ts`).
   Lives in `src/shared`, so core (`itemPickupSystem`) and game (`levelSystem`)
   can push to it without breaking layer rules.

3. **Renderer — `src/engine/EffectsVfx.ts`** is the sole consumer. It has two
   inputs but one preset library:
   - **`world.vfxEvents`** — drained each frame (sole consumer). Carries
     non-combat requests that have no combat event to ride on (pickups,
     level-ups).
   - **`world.combatEvents`** — read but **not** drained (CombatVfx owns the
     drain). Used to synthesise combat juice (hit sparks, crit bursts, death
     pops, player-hurt flash) directly from existing events, with no extra core
     plumbing. This requires `EffectsVfx.update` to run **after `GoreVfx` and
     before `CombatVfx`** in `PhaserBridge.sync`, exactly like `GoreVfx`.

   Effects are self-animating Phaser tweens that destroy their own GameObjects on
   completion (the same pattern as `MainGameScene.triggerBossSpawnFx`), so there
   is no per-frame particle integration loop to maintain. The renderer is
   capability-guarded: in mocked/headless scenes lacking `scene.add.circle` /
   `rectangle` / `tweens.add` it spawns nothing but still drains `vfxEvents`.

4. **Depths — `src/shared/render-depths.ts`** gains `WORLD_VFX_DEPTH` entries for
   the new effects, all below `UI_DEPTH_CUTOFF`; every spawned object is ignored
   by the `ui` camera so it renders in world space.

5. **Preview lab — `src/labs/juice-lab/`** with per-effect trigger buttons and an
   auto-fire density stress test, registered in `src/lab-main.ts`.

## Consequences

### Positive

- Any core/game system can now request a cosmetic effect with a single
  `pushVfxEvent` call and no rendering dependency — layer rules stay intact.
- Combat juice is derived from existing `combatEvents`, so hits/crits/deaths/
  player-hurt required **zero** new core plumbing.
- Self-animating tweens auto-clean, so there is no lifetime bookkeeping beyond an
  `active` set used only for `destroy()`.
- CI-safe and unit-testable: emit sites are asserted in plain ECS tests; the
  renderer degrades to a no-op (still draining the queue) under mocked scenes.
- One preset library serves both input sources, so adding an effect is local.

### Negative

- `EffectsVfx` is order-coupled to `GoreVfx`/`CombatVfx` in the bridge (must run
  between them). This is documented in code and mirrors the existing GoreVfx
  constraint, but it is an implicit ordering invariant.
- Labs that exercise combat juice without a `CombatVfx` must drain
  `world.combatEvents` themselves, or events re-fire every frame (juice-lab does
  this explicitly).

### Risks

- A future second non-draining `combatEvents` reader added in the wrong order
  could double- or zero-render combat juice. Mitigated by the ordering comment in
  `EffectsVfx` and `PhaserBridge`.
- The render-only RNG inside `EffectsVfx` must never be used for simulation. It is
  a local LCG seeded independently of `SeededRandom` to make this impossible by
  construction.

## Alternatives Considered

- **Phaser `ParticleEmitter` (GPU particles) now.** Rejected for Phase 1: heavier
  to mock in unit tests, and the tween/GameObject approach already matches the
  proven `triggerBossSpawnFx` pattern and is CI-safe. **Recommended for a future
  high-density ambient pass** (dust, embers, screen-fill density) where many
  thousands of short-lived particles make per-object tweens impractical.
- **Push every effect (including combat) onto `vfxEvents`.** Rejected: combat
  already emits rich `combatEvents`; re-emitting would duplicate data and add core
  churn. Reading `combatEvents` non-destructively reuses existing signal.
- **Emit effects directly from systems into the scene.** Rejected: violates layer
  rules (core/game cannot import Phaser) and is untestable headless.
- **A per-frame particle integrator in core.** Rejected: would put cosmetic state
  in the deterministic simulation and risk RNG/Date coupling.
