# ADR 2026-07-18: Authoritative Blood Surfaces

## Status

Accepted

## Date

2026-07-18

## Estimated Complexity

🍎 x 4 — a cross-layer gameplay/rendering change spanning shared blood-surface
modeling, core world/system state, engine VFX consumers, runtime probe support,
and deterministic coverage in unit/ECS/integration/e2e layers.

## Context

Issue #1267 requires blood-pool contact to drive a roughly 5-second
bloody-footprint source window, deposit persistent bloody footprints/smears for
roughly 5 seconds while the player moves, match footprint color to the source
pool, and mix colors when the player touches a second differently colored pool
before the source window expires.

Before this change, persistent blood pools were effectively renderer-owned VFX
state. That shape could not satisfy the approved spec safely because:

- gameplay-side footprint timing, color mixing, and expiry would have depended
  on the renderer's local state instead of deterministic world data;
- headless/runtime tests would not have had a single authoritative source of
  truth for blood contact or footprint persistence; and
- core/gameplay logic would have needed to cross the ECS/Phaser boundary to ask
  the renderer whether the player was standing in blood.

The change touches `src/shared`, `src/core`, `src/engine`, and runtime probing
used by deterministic e2e evidence, so it needs an explicit cross-layer
architecture decision.

## Decision

Adopt a **single authoritative blood-surface model in world state**, with
engine VFX acting only as a renderer of that state.

1. **Shared blood-surface module** (`src/shared/blood-surfaces.ts`): define the
   blood-source lifetime, footprint lifetime, deterministic pool/footprint
   geometry builders, visible-contact helpers, and color-mixing helpers in a
   shared layer both core and engine may read without violating architecture
   boundaries.
2. **World state as source of truth** (`src/core/world.ts`): store authoritative
   `bloodPools`, `bloodyFootprints`, and `bloodyFootprintState` on `GameWorld`
   so gameplay logic, headless simulation, and renderers all reference the same
   deterministic data.
3. **Gameplay authorship in core**:
   - `dropSystem` creates persistent blood pools in world state at kill/contact
     sites.
   - New exported `bloodyFootprintSystem` owns contact detection, source-window
     refresh, color mixing, footprint emission, and pool/footprint expiry.
   - The system is wired into the real runtime pipeline via
     `runCoreSimulationStep()`, not just a lab.
4. **Engine as a consumer only**:
   - `GoreVfx` renders authoritative blood pools from `world.bloodPools`.
   - `PlayerTrailVfx` renders authoritative `world.bloodyFootprints` and
     suppresses dust when the player is actively bloody.
   - Neither renderer owns persistent blood gameplay state anymore.
5. **Real-runtime evidence seam**: extend `main-scene-probe-lab` so the shipped
   `MainGameScene` can be deterministically advanced, seeded with blood pools,
   and summarized for before/after evidence without inventing renderer-only test
   behavior.

## Consequences

### Positive

- Blood contact, source refresh, footprint persistence, and mixed-color output
  are deterministic and testable in both gameplay and real runtime paths.
- ECS/Phaser boundaries stay intact: gameplay never depends on renderer-local
  state, and engine code reads world state instead of driving gameplay logic.
- Real game, headless tests, and labs all observe the same authoritative blood
  model, reducing drift between isolated labs and shipped behavior.

### Negative

- `GameWorld` now carries longer-lived blood-surface state that must be pruned
  every frame by the core system.
- Both `GoreVfx` and `PlayerTrailVfx` had to be refactored away from simpler
  renderer-local bookkeeping into state synchronization code.

### Risks

- Future gameplay code could accidentally add a second blood-pool/footprint
  source outside `bloodyFootprintSystem` or `dropSystem`, reintroducing split
  authority. Mitigation: keep blood-surface builders centralized in
  `src/shared/blood-surfaces.ts` and route authored state through world arrays.
- Contact tuning depends on shared geometry/progress helpers staying aligned
  between core overlap checks and engine rendering. Mitigation: both paths reuse
  the same helper module and are covered by unit/integration/runtime tests.

## Alternatives Considered

- **Keep blood pools renderer-owned and add a gameplay callback/event path from
  engine to core.** Rejected: it would invert the architecture boundary,
  complicate headless determinism, and make gameplay correctness depend on a
  renderer implementation detail.
- **Let `bloodyFootprintSystem` own only temporary source state while leaving
  persistent footprints as renderer-only VFX.** Rejected: footprint lifetime and
  mixed-color evidence would then diverge between headless/gameplay tests and
  the real renderer, undermining the spec's deterministic persistence
  requirement.
- **Represent blood contact as a coarse radius only.** Rejected: the approved
  behavior is about visibly walking through blood pools, so contact needs to be
  evaluated against the same age-scaled visible pool geometry the player sees.
