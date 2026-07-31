# ADR 0076: Fizzwick CLOCKWORK KILL-SAW — lane geometry and active-phase contract

## Status

Accepted

## Date

2026-07-25

## Estimated Complexity

🍎 x 4 — cross-layer: `src/core` runtime/types, `src/game/ai`, `src/engine` VFX, and tests

## Context

Fizzwick's CLOCKWORK KILL-SAW ability fires a circular saw blade along a
committed lane, holds at the endpoint, then returns along the same path. This
requires:

1. A new **committed lane geometry** kind (origin→endpoint with width) on top of
   the existing circle geometry.
2. A new **active phase** in the runtime — `outbound | hold | return` — after
   the existing `telegraph` resolves, so the runtime keeps driving the saw
   projectile through its full travel cycle before arming the cooldown.
3. Public **cue phases** (`outbound | hold | return`) visible to the engine
   renderer and AI avoidance code.

Decisions that affect 2+ systems (`src/core/mob-abilities/types.ts`,
`src/game/ai/bt-ai-provider.ts`, `src/engine/MobAbilityVfx.ts`) require an ADR
per `AGENTS.md`.

## Decision

### DEC-001 — `MobAbilityLaneGeometry` committed at telegraph start

`MobAbilityLaneGeometry` is committed once, at telegraph start (`beginTelegraph`
in `runtime.ts`), using the helper `createCommittedLaneGeometry`. The lane
stores `originX/Y`, `endpointX/Y`, `widthFt`, and `lengthFt`. After commitment
the geometry is never mutated — all three consumers (runtime, AI, renderer) read
the same immutable struct.

### DEC-002 — `MobAbilityActiveState` drives the post-resolve lifecycle

`MobAbilityInstanceState.activeState` holds an optional
`MobAbilityReturningLaneActiveState` while the saw is in flight. The internal
phase machine (`MobAbilityPhase`) is extended with `'active'`; the runtime stays
in `'active'` until the return pass reaches the committed origin, then transitions
to `'cooldown'`.

The `activeState` fields are:
- `phase: 'outbound' | 'hold' | 'return'` — sub-phase within `'active'`
- `projectileX/Y` — current saw position (updated each tick by the runtime)
- `holdRemainingMs` — countdown in the hold sub-phase
- `hitKeys: Set<string>` — deduplication tokens (`${eid}:${pass}`) preventing
  double-damage within a single pass

### DEC-003 — Public cue phases surfaced to renderer and AI

`MobAbilityCue.phase` is typed as `'telegraph' | 'outbound' | 'hold' | 'return'`.
`cue.projectileX` / `cue.projectileY` carry the current saw position so the
renderer can draw the moving saw graphic without any additional state.

### DEC-004 — Ordering: runtime moves saw before collision, cooldown transitions after

The active-phase tick (`tickActive` in `runtime.ts`) runs inside `mobAbilitySystem`,
which is a `preSystem` scheduled before `movementSystem`. Within `tickActive` the
runtime advances the saw position and checks player collision in that order. The
collision uses the player's current position (from the previous frame), which
is one tick behind the rendered frame; this is consistent with how all
pre-movement ability checks behave in this codebase and is acceptable for the
ability's intended difficulty balance.

### DEC-005 — `MobAbilityBurstEvent` discriminated union for pending bursts

The pending-burst queue uses a discriminated union with two kinds:
- `{ kind: 'resolution'; abilityId: string; geometry }` — fired when a cast
  resolves (circle or spawn-circles), dispatched by `abilityId` in the renderer
- `{ kind: 'recatch'; x: number; y: number }` — fired when the saw is caught
  at the return origin, triggering a spark/ring at the recatch position

`pushMobAbilityBurst` enqueues a resolution event; `pushMobAbilityRecatch`
enqueues a recatch event. Both share the bounded `MOB_ABILITY_BURST_CAP` queue.

### DEC-006 — AI avoidance reads committed lane geometry

`bt-ai-provider.ts` reads `cue.geometry` when `cue.phase` is any non-cooldown
phase and the geometry kind is `'lane'`. Avoidance is applied orthogonal to the
lane axis when the player's projected position falls within the collision strip.

## Consequences

### Positive

- The saw lifecycle is fully driven by the core runtime; the engine renderer is
  a pure consumer of `cues` and `pendingBursts` with no added state.
- Committed lane geometry is the single source of truth: the runtime, AI, and
  renderer all read the same `MobAbilityLaneGeometry` struct.
- The active-phase extension does not change the existing telegraph/cooldown
  semantics for any other ability (Verdigris, Big Wei, Squick).

### Negative

- `MobAbilityPhase` is now a three-value union; callers that exhaustively switch
  must add an `'active'` arm.
- `MobAbilityCuePhase` is now a four-value union; renderer code that expected
  only `'telegraph'` or `'resolved'` must handle the lane phases.
- The returning-lane damage check runs before `movementSystem` (DEC-004), so it
  uses the player's prior-frame position. This is consistent with other
  pre-movement effects but means a fast player who dodges in the last frame still
  takes the hit.

### Risks

- **Future ability types with active phases** must add their own `activeState`
  variant (the union is narrow today). The type is designed as a union
  (`MobAbilityActiveState = MobAbilityReturningLaneActiveState`) to allow safe
  extension without touching existing handlers.
- **EID recycling during active phase**: if a caster is killed and respawned
  (EID reused) while the saw is in `'active'`, `isCasterValid` detects the
  stale registration token and aborts the active tick cleanly via
  `clearMobAbility`.

## Alternatives Considered

### Spawn a real projectile entity for the returning lane

- **Rejected (for now)**: spawning a real entity would run through `movementSystem`
  and the normal collision pass, eliminating the one-frame position lag (DEC-004).
  However, it requires lifecycle plumbing (entity ownership, generation tokens,
  cleanup on caster death) that is out of scope for the initial ship of this
  ability. ADR 0076 deliberately records this as a future option; the single-tick
  position difference is within the ability's intended difficulty tolerance.

### Encode the hold/return phases as separate full ability casts

- **Rejected**: splits a single gameplay action across multiple ability slots and
  makes cooldown anchoring fragile (cooldown would start at telegraph, not after
  the saw returns).

### Put the active-phase tick in a separate ECS system

- **Rejected**: the ability runtime already controls state for all registered
  casters; a separate system would need to replicate caster-lookup and liveness
  checks. Keeping it inside `mobAbilitySystem` keeps the state machine co-located
  with the runtime that owns it.
