# ADR: Skill level-up floater events

## Status

Accepted

## Date

2026-08-03

## Estimated Complexity

🍎🍎🍎 — new shared event contract wired through game, core world state, engine rendering, and regression coverage.

## Context

Skill level-ups already changed simulation state, but the common case had no player-visible
acknowledgement unless the new level also crossed a 5/10/15/20 milestone. The player could
only infer ordinary level gains from the HUD skill bar.

The change crosses shared, core, game, and engine because the feedback must stay layered:

- gameplay emits the level-up signal when authoritative skill state changes;
- core world state owns the queue so headless and real runtime pipelines share the same data;
- the engine renders the signal without introducing Phaser into gameplay code;
- regression coverage must observe both emission and the real rendered artifact.

## Decision

1. Add a data-only `FloaterEvent` queue on `GameWorld`, mirroring the existing
   `combatEvents` / `vfxEvents` pattern rather than coupling the feature to Phaser objects or
   overloading combat-only events.
2. Emit `+1 <Skill>` floaters from `skillSystem` at the point a level is actually granted,
   gated to the player holder so non-player skill progression stays simulation-only.
3. Reuse `CombatVfx` as the sole floating-text renderer for these notices instead of adding a
   second renderer/lifecycle. Same-frame skill floaters are renderer-staggered deterministically
   so multi-level gains remain readable.
4. Cap the queue in shared code because headless/AI pipelines do not drain renderer-owned
   cosmetic events.
5. Guard the behavior with both unit coverage (queue + renderer contract) and a deterministic
   real-scene e2e observation through `main-scene-probe-lab`.

## Consequences

### Positive

- The player gets immediate feedback for ordinary skill gains without violating layer rules.
- Headless and real runtime pipelines share one cosmetic event contract.
- The renderer owns readability concerns such as same-frame staggering, keeping gameplay emission
  simple and deterministic.

### Negative

- `GameWorld` now carries another cosmetic queue.
- The probe lab surface grows slightly to expose rendered floating text for deterministic e2e
  observation.

### Risks

- Future non-skill uses of the queue could mix unrelated notices unless styles remain clearly
  separated by `kind`.
- The queue cap drops oldest cosmetic events in undrained headless contexts; that is acceptable
  for juice, but not for any future gameplay-significant signal.

## Alternatives Considered

1. **Reuse `combatEvents` for skill gains.** Rejected because a skill level-up is not a combat
   hit/result and would overload a combat-specific contract with unrelated semantics.
2. **Render directly from `skillSystem` or another game-layer seam.** Rejected because it would
   violate the bridge pattern by pulling Phaser concerns into gameplay code.
3. **Add a dedicated second floating-text renderer.** Rejected because `CombatVfx` already owns
   floating text lifecycle, depth, and fade behavior; a second renderer would duplicate
   lifecycle logic and wiring.
