# ADR 0027: Explode corpses into sprite shards when hit during death-linger

## Status

Accepted

## Date

2026-06-27

## Estimated Complexity

🍎 x 3 — spans `src/shared` (event contract), `src/core` (deterministic
trigger), and `src/engine` (new VFX: pure math module + Phaser renderer +
bridge wiring), plus a lab demo, unit/ECS tests, and this ADR. No new ECS
system and no new component.

## Context

Per ADR 0017, a slain enemy keeps its `Enemy` / `Position` / `Velocity`
components and gains a `DeathTimer` for a short "linger" window; the corpse
sprite fades and desaturates (`corpse-decay`) until `deathTimerSystem` reaps it.
ADR 0017 also made corpses **inert as attackers** (no AI, no contact damage).

The design ask: a corpse struck by any player attack during that linger window
should **explode for drama** — the corpse sprite dynamically cut into pieces
that spray outward — rather than silently soaking the blow.

Two cross-cutting facts shape the design:

1. **Single damage choke point.** Every offensive hit (projectile, melee, AoE,
   beam) funnels through `applyDamage(world, target, …)` in `src/core`. A trigger
   there covers all weapons with one guard. (ADR 0017's corpse guard lives in the
   _contact_ path `applyPlayerEnemyHit`, a different concern — that stops corpses
   from _dealing_ damage; this ADR governs corpses _receiving_ it.)
2. **Bridge pattern.** `src/core` must stay deterministic and Phaser-free, while
   the actual sprite-cutting is non-deterministic rendering that belongs in
   `src/engine`. So the trigger and the visual must be split across layers and
   communicate through the existing data-only `CombatEvent` queue.

## Decision

Split the feature across the three layers along the existing seams:

- **Contract (`src/shared/combat-events.ts`).** Add a `'corpseExplode'`
  `CombatEvent` type and an optional `spriteTextureId` field (so the renderer can
  resolve which corpse texture to cut when the on-screen visual is gone). The
  queue is data-only and already drained once per frame by `CombatVfx`; other VFX
  consumers (`GoreVfx`, `EffectsVfx`) switch on `event.type` and ignore unknown
  types, so the new event is purely additive.

- **Trigger (`src/core/apply-damage.ts`, deterministic).** After the `amount<=0`
  and `Invincible` guards, if the target is an `Enemy` **and** has a `DeathTimer`
  (the ADR 0017 corpse marker) with `remainingMs > 0`, emit a `corpseExplode`
  event (carrying position, hit `amount`, blow direction from source→target, the
  corpse's `BloodColor`, and `spriteTextureId`), set `remainingMs = 0`, and
  return `0`. The corpse is **not** removed inside `applyDamage` (downstream
  callers still use the eid, e.g. `meleeSwingSystem` adds `Knockback`); zeroing
  the timer lets `deathTimerSystem` — which runs last in the pipeline — reap it
  cleanly the same frame. The `remainingMs > 0` guard makes repeat hits in one
  frame idempotent (one event, no double-detonation).

- **VFX (`src/engine`, non-deterministic).**
  - `corpse-shatter.ts` — a pure, Phaser-free module: it tiles a texture frame
    into a `cols × rows` grid of shard specs (integer crop rects that cover the
    frame exactly), and provides the launch kinematics and fade/scale curves.
    Randomness is injected (`rng: () => number`); it never touches game state, so
    it does not use `SeededRandom`. This is where the unit tests live.
  - `CorpseShatterVfx.ts` — a thin Phaser renderer. Each shard is the full corpse
    sprite added as an image, `setCrop`-ped to one grid cell with its origin
    pinned to the cell centre so it tumbles in place, then sprayed outward with
    gravity, spin and a fade. A few blood-coloured specks ride along.
  - `PhaserBridge.ts` — owns the VFX. At `sync()` start it reads `corpseExplode`
    events and resolves the corpse texture from the **still-present** corpse
    visual (it is destroyed later that frame by the cleanup loop), falling back to
    `resolveTexture` via `spriteTextureId`. It replays the bursts after advancing
    the VFX clock, and destroys the VFX on teardown.

The `gore-lab` sandbox already runs the full damage pipeline through the bridge
with an auto-firing weapon, so it demonstrates the feature with no structural
change; its HUD now counts corpse explosions.

## Consequences

### Positive

- Every weapon type detonates corpses with one core guard at the damage choke
  point — no per-weapon code.
- Determinism is preserved: `src/core` only emits a data event and zeroes a
  timer; all randomness and Phaser work stays in `src/engine`.
- The cut is faithful — shards are cut from the corpse's actual on-screen texture
  (Kenney sprite or procedural fallback), so they match the body that burst.
- Idempotent and self-cleaning: the corpse is reaped the same frame by the
  existing `deathTimerSystem`, with no overlap between the fading corpse and the
  shards (`computeCorpseDecay` returns alpha 0 at `remainingMs = 0`).

### Negative

- The "corpse is inert except for its death animation" rule from ADR 0017 now has
  an explicit exception (receiving offensive damage triggers a one-shot VFX +
  expiry), expressed in a third place alongside `healthSystem` and the contact
  guard.
- The bridge depends on a subtle ordering invariant: the corpse's `EntityVisual`
  must still be in the `visuals` map at `sync()` start (true because the cleanup
  loop runs later in the same `sync`). Documented in code comments.

### Risks

- The killing blow itself does **not** explode the enemy — it turns a living
  enemy into a corpse (normal death VFX); a _subsequent_ hit during linger
  detonates it. This matches "corpses explode when hit," but a very short
  `deathLingerMs` plus slow fire rate could leave little time to land that
  follow-up. Mitigated: the linger window is configurable and the lab makes the
  timing visible.

## Alternatives Considered

- **Explode inside the engine only (no core event).** Rejected: the engine would
  have to re-derive "this hit landed on a corpse" from rendering state, and the
  trigger belongs with the authoritative damage logic. The event keeps core
  deterministic and the renderer dumb.
- **Remove the corpse entity inside `applyDamage`.** Rejected: downstream systems
  in the same frame still reference the eid (e.g. `meleeSwingSystem` adds
  `Knockback`); mutating a removed bitecs entity risks recycled-ID bleed. Zeroing
  the `DeathTimer` defers removal to the system that owns it.
- **A dedicated particle texture instead of cutting the sprite.** Rejected: the
  ask is specifically to "dynamically cut up the corpse sprite," and reusing the
  real texture is both more faithful and avoids new art assets.
- **Detonate on the killing blow too.** Rejected for v1: it muddies the death
  feel (death pop + gore already fire there) and removes the deliberate "shoot
  the body" beat. Can be revisited as a tuning toggle.
