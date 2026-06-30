# ADR 0034: Spawner Spawn Telegraph Feedback

## Status

Accepted

## Date

2026-06-30

## Estimated Complexity

🍎 x 2 — extends an existing gameplay-to-render pipeline across shared, game, engine, and tests without adding a new system or lab.

## Context

The generic spawner mob-type already handled passive spawning, defensive enrage,
and on-death finale waves, but those moments had weak player-facing feedback.
Children appeared suddenly, and the spawner itself gave no dedicated telegraph
that it had just emitted a wave. That made spawner pressure harder to read than
other combat beats that already have explicit juice through the VFX pipeline.

We already had two reusable pieces that fit this need:

1. The shared `vfxEvents` -> `EffectsVfx` bridge for data-only gameplay-to-render
   cosmetic signals.
2. The `SpawnAnim` pop/wiggle entrance animation used for baby slimes.

The missing decision was how to apply those tools to spawner waves without
breaking determinism, layer rules, or creating misleading feedback when a spawn
tick produces zero children.

## Decision

Add a dedicated spawner spawn telegraph that combines a world-space pulse on the
structure with an entrance animation on the emitted children.

1. Extend the shared VFX contract with a new `spawnerPulse` event kind and give
   it its own `WORLD_VFX_DEPTH` bucket. Gameplay only requests the event kind;
   the renderer still owns visual layering.
2. Teach `EffectsVfx` a `spawnerPulse` preset: a short ring + spark burst that
   renders in world space at the spawner position.
3. Update `spawnerSystem` so:
   - every child spawned by a successful interval pulse gets `SpawnAnim`,
   - every child spawned by an on-death finale also gets `SpawnAnim`,
   - the spawner emits `spawnerPulse` only when at least one child was actually
     created.
4. Keep the signal deterministic and truthful:
   - no extra gameplay RNG is introduced,
   - no pulse is emitted on capped/no-op spawn ticks,
   - rendering remains purely engine-side.
5. Validate the behavior with gameplay tests plus the existing `spawner-lab`
   runtime flow rather than adding a new lab.

## Consequences

### Positive

- Spawner waves become readable at the source, not only once children are already
  moving toward the player.
- The telegraph reuses existing architecture (`vfxEvents`, `EffectsVfx`,
  `SpawnAnim`) instead of inventing a one-off rendering path.
- Finale spawns and regular pulses now share the same feedback language, so the
  feature is consistent across spawner states.
- The cue is truthful: players only see it when a real spawn happened.

### Negative

- Another effect kind increases the preset surface area inside `EffectsVfx`.
- Spawner children now always pay the small cosmetic cost of a `SpawnAnim`
  component and countdown even when many spawns happen close together.

### Risks

- If future tuning makes spawner pulses extremely dense, the extra world-space
  burst could become visually noisy and need intensity tuning.
- A future refactor could accidentally emit `spawnerPulse` on capped ticks; this
  is mitigated by explicit negative-case coverage in `tests/game/spawner-system.test.ts`.

## Alternatives Considered

- Reuse `deathPop` or another existing effect kind. Rejected because spawning is
  a distinct beat from damage/death and needs its own readable visual language.
- Animate only the children and skip the spawner pulse. Rejected because it makes
  the source of the threat harder to read in crowded scenes.
- Emit the pulse unconditionally whenever the timer elapses. Rejected because it
  would lie to the player when the concurrent cap blocks new children.
