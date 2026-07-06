# ADR: Corpse-step burst is a real gameplay state change; exclude Spawner corpses at two layers

## Status

Accepted

## Date

2026-07-05

## Estimated Complexity

🍎 x 3 — cross-layer feature (core system + engine VFX + dual-pipeline
wiring) plus a determinism-order interference fix that touches the shared
`applyDamage` choke point; new lab required.

## Context

PR #782 adds two pieces of combat juice:

1. **Corpse-step burst** — when the player steps onto a lingering enemy
   corpse (an `Enemy` entity kept alive by a `DeathTimer`), there is a
   `CORPSE_STEP_TRIGGER_CHANCE = 0.1` chance to detonate it early via the
   existing `corpseExplode` combat event. The new `corpseStepSystem`
   (`src/core/systems/corpseStepSystem.ts`) owns this, wired into both the
   engine sim (`src/engine/sim/simulation-step.ts`) and the headless AI sim
   (`src/game/ai/simulation-step.ts`).
2. **Player movement trail** — small ADD-blended dust puffs behind the
   player (`src/engine/PlayerTrailVfx.ts`), render-only.

Two facts shaped the decision:

- **Corpse-bursting is NOT cosmetic.** A human clarified mid-session that
  detonating a corpse is a real change to game entities — the corpse is
  consumed (its `DeathTimer` is zeroed so `deathTimerSystem` reaps it that
  frame). Future necromancy content depends on corpses being a finite,
  consumable resource, so "burst = destroyed entity" must be treated as an
  authoritative gameplay state transition, not a visual flourish.
- **Spawner structures are tagged `Enemy` and linger via `DeathTimer`.**
  The `rats-nest` spawner is an `Enemy` combatant, and on death it lingers
  with a `DeathTimer`, so it _matches the corpse query_. But spawner death
  is a multi-tick handshake: `spawnerSystem` sets `deathResolved` the tick
  after `hp <= 0` (it fires a finale wave first), then `spawnerArenaSystem`
  reads `deathResolved === 1` while the arena is `LOCKED` and flips it to
  `RESOLVED` (unsealing the room). If the spawner's lingering corpse is
  reaped early — by a corpse-step burst, or by _any_ stray hit that runs
  the corpse branch — the entity is destroyed before the handshake
  completes and the arena is orphaned: doors never unseal and the player is
  trapped.

The shepherd run caught this as a real regression: the corpse-step feature
knocked `tests/headless/ai-arena-lockin-resolution.test.ts` from 100% to
88% (7/8 seeds; seed 1's 10% roll landed on the spawner corpse), below the
95% floor. The main Floor-1 win-rate gates (sword/bow/bat) stayed green, so
this was specifically an arena-resolution interference, not a balance shift.

## Decision

1. **Frame corpse-bursting as a real gameplay state change.** The
   `corpseExplode` event is still render-only on the engine side, but the
   caller's timer-zero is authoritative: it consumes the corpse. Doc
   comments on `emitCorpseExplosion` (`src/core/apply-damage.ts`) and
   `corpseExplode` (`src/shared/combat-events.ts`) say so explicitly, so a
   future necromancy system knows a burst corpse is _gone_, not merely
   hidden.

2. **Exclude `Spawner` corpses at two layers (defense in depth).**
   - **Feature boundary** — `corpseStepSystem` skips `Spawner` corpses as
     the first check in the corpse loop (`if (hasComponent(world.ecs, eid,
Spawner)) continue;`). Semantics: "a spawner structure is not a
     steppable corpse."
   - **Shared choke point** — `applyDamage` returns `0` for a `Spawner`
     target in the corpse branch _before_ emitting the explosion or zeroing
     the timer. This protects the spawner-linger invariant from **every**
     damage source (projectile / melee / AoE / beam), not just footsteps,
     closing the ~1-frame window where a stray hit could reap the corpse
     mid-handshake.

   The two guards are deliberately complementary: layer 1 avoids wasting a
   roll and states the feature's own rule at its boundary; layer 2 is the
   invariant-protecting backstop for all callers.

3. **Determinism-neutrality is preserved.** The corpse-step 10% roll uses
   `hashStringToSeed(`${world.seed}:${world.frameCount}:${corpseEid}`)`
   reduced to `[0,1)` — it NEVER calls `world.rng.next()`, so it cannot
   perturb the seeded gameplay RNG stream (rule #13). The new `applyDamage`
   Spawner guard returns before the dodge/crit rolls (which are the first
   `world.rng` calls in that path), so inserting it does not shift RNG
   order for any entity. Confirmed by the arena sweep returning to 100%
   with unchanged per-seed resolution frames for the non-affected seeds.

4. **`PlayerTrailVfx` stays out of the sim.** It uses a private Park-Miller
   LCG, lives in `src/engine`, imports only `src/core`/`src/shared`, and is
   never referenced by any simulation step — so it is headless-safe and
   cannot affect win-rate or determinism.

## Consequences

### Positive

- The arena-lockin gate is restored to 100% (8/8) **legitimately** — by
  root-causing the handshake interference, not by editing the threshold,
  excluding seed 1, or neutering the feature (rules #12/#13 honored).
- The spawner-linger invariant is now protected against all damage sources,
  not just the new footstep path — a latent bug that predates this PR
  (any AoE clipping a dying spawner could have orphaned an arena) is closed.
- Corpse-as-consumable-resource semantics are documented, unblocking future
  necromancy design.
- The feature's defining parameter (`CORPSE_STEP_TRIGGER_CHANCE = 0.1`) is
  untouched and meaningful for all non-spawner corpses.

### Negative

- Two guard sites for one invariant is mild duplication. Accepted as
  intentional defense-in-depth; each site has a distinct rationale
  (feature semantics vs. shared-invariant backstop) documented inline.
- `applyDamage` now imports `Spawner` and has one extra early return in the
  corpse branch — a small widening of that function's coupling.

### Risks

- **Over-broad exclusion if `Spawner` is ever reused for a non-structure.**
  Today every `Spawner` entity is a structure that needs the handshake
  guard, so excluding all of them is correct. If a future design tags a
  _steppable_ entity with `Spawner`, both guards would wrongly skip it;
  the fix then is a narrower predicate (e.g. gate on the arena/linger role
  rather than the raw `Spawner` tag). Flagged here so it is discoverable.
- **New corpse-consuming systems must respect the same invariant.** Any
  future system that reaps corpses (necromancy, harvesting) must also skip
  `Spawner` corpses or route through `applyDamage`, or it will reintroduce
  the orphan-arena bug. The choke-point guard covers damage-based reaping;
  non-damage reapers need their own check.

## Alternatives Considered

- **Only guard `corpseStepSystem` (single layer).** Rejected during plan
  review (gpt-5.4): it closes the footstep path but leaves the shared
  corpse branch in `applyDamage` able to reap a dying spawner from any
  other damage source in the ~1-frame handshake window. Defense in depth
  at the choke point is the durable fix.
- **Skip the corpse branch for spawners in the pipeline ordering instead
  of in `applyDamage`.** Rejected — the interference is not an ordering
  problem (the pipeline order is already correct); it is that spawner
  corpses should never be reaped early at all. A component guard states the
  invariant where it is enforced.
- **Lower `CORPSE_STEP_TRIGGER_CHANCE` or exclude the failing seed.**
  Rejected outright as weakening the feature's defining parameter and
  gaming the gate (rules #12/#13). Neither addresses the actual bug.
- **Make the spawner not linger (drop its `DeathTimer` on death).**
  Rejected — the linger is load-bearing for the finale-wave + arena-resolve
  handshake; removing it would break the spawner battle arena (ADR 0044).
