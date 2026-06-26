# ADR 0025: Baby slime spawn animation (size + pop-out) and swing-immunity

## Status

Accepted

## Date

2026-06-26

## Estimated Complexity

🍎 x 4 — touches 3 layers (`src/core`, `src/engine`, `src/game`) plus `src/shared`
and `src/labs`; adds a new component, a new deterministic system with its lab, a
render branch, and a second (combat) mechanic, after a mid-task pivot.

## Context

When a slime dies it can split into two "baby" (mini) slimes via
`dropSystem.maybeSplitSlime`. Three problems were reported:

1. **Babies rendered at full size.** `PhaserBridge`'s default enemy render case
   sets a fixed per-type scale (`KENNEY_SCALE.enemy_slime`) and never reads the
   entity's logical `Sprite.width`. Minis already received a smaller
   `Sprite.width` (round(24 × 0.65) = 16) but it had no visual effect.
2. **Babies popped in instantly** with no spawn feedback.
3. **Babies were immediately killed by the same swing that killed their parent.**
   `meleeSwingSystem` keeps a per-swing hit set so a swing damages each target at
   most once across its multi-frame life. Because `dropSystem` runs _after_
   `meleeSwingSystem` in the pipeline, the parent dies mid-swing, babies spawn at
   the parent's position, and on the next frame the _same_ still-active swing
   finds the fresh babies (absent from its hit set) and cuts them down in one
   motion.

The fix spans `src/core` (ECS component + systems), `src/engine` (render +
pipeline) and `src/game` (headless simulation pipeline), which triggers the ADR
requirement.

## Decision

**Size (engine only).** In `PhaserBridge`, for enemies whose archetype is
`slime-mini`, scale the sprite by `Sprite.width / SLIME_FULL_SPRITE_WIDTH (24)`.
Scoped to minis so full slimes, rats, and the slime-textured bosses are
untouched.

**Spawn animation (cosmetic, deterministic).** Add a `SpawnAnim` component
(`remainingMs`, `totalMs`) and a new `spawnAnimSystem` that counts the timer
down by the fixed `GAME.DELTA_MS` each frame and removes `SpawnAnim` on expiry —
no RNG, no wall-clock, mirroring `deathTimerSystem`. `maybeSplitSlime` adds
`SpawnAnim` to each baby. Pure animation math lives in `src/shared/spawn-anim.ts`
(`spawnAnimProgress`, `easeOutBack`, `computeSpawnPopScale`) and is consumed by
both the engine render (pop-out ease-out-back + decaying-sine wiggle) and a new
`spawnanim-lab` sandbox (lab-gated, required by CI). `spawnAnimSystem` is added
to both the engine pipeline (`MainGameScene`) and the headless/game pipeline
(`simulation-step`), after `dropSystem`.

**Survive the killing swing (combat, deterministic).** The intent is "a baby
survives the _specific_ swing that killed its parent, but dies if you swing
again" — explicitly **not** a time-based invulnerability window. Add an exported
`markImmuneToActiveMeleeSwings(world, eid)` in `meleeSwingSystem` that registers
a target into **every currently-active swing's hit set**. `maybeSplitSlime`
calls it for each baby at spawn, so the killing swing skips them; the next attack
is a brand-new `MeleeSwing` entity with an empty hit set that can hit them. This
is pure set membership — no RNG, no wall-clock.

## Consequences

### Positive

- All three reported issues are fixed: babies render smaller, play a pop-out +
  wiggle, and survive their parent's killing swing (dying to the next swing).
- The combat mechanic touches no damage RNG and no game-time behavior, so the
  CI-blocking deterministic Floor-1 headless gate (12 seed×weapon combos,
  game-time assertions) is unaffected. Bow spawns no `MeleeSwing`, so the helper
  is a no-op for it and babies already survive the arrow at baseline.
- The animation is decoupled from combat: `spawnAnimSystem` is purely cosmetic,
  so render timing can never change gameplay outcomes or gate determinism.
- New `SpawnAnim` component and `spawnAnimSystem` are reusable for any future
  "emerge into the world" spawn (summons, hatching, etc.).

### Negative

- The "survive the killing swing" rule lives implicitly in the interaction
  between `dropSystem` (spawn-time registration) and `meleeSwingSystem` (hit-set
  semantics) rather than in one central place.
- `PhaserBridge` now has a `slime-mini`-specific render branch, a small special
  case in the otherwise type-driven scale path.

### Risks

- Pipeline-order dependency: `markImmuneToActiveMeleeSwings` must be called from
  `dropSystem`, which must run after `meleeSwingSystem`, for the immunity to take
  effect. Mitigated by the drop-system integration test that asserts babies
  survive the killing swing and die to a fresh one.
- A future ranged/AoE weapon that uses a persistent multi-frame hit set like
  melee would need the same spawn-time registration. Documented here and covered
  by the `markImmuneToActiveMeleeSwings` unit test.

## Alternatives Considered

- **Time-based invulnerability (`Invincible` tag during the ~280ms spawn anim).**
  Implemented first, then rejected: it perturbed the deterministic headless gate
  (notably `seed 7 · bow`) because it changed when entities could take damage in
  game-time, and it did not match the user's actual intent ("swing again to kill
  them"). All associated core-damage churn was reverted to baseline.
- **Reorder the pipeline so `dropSystem` runs before `meleeSwingSystem`.**
  Rejected: it would change when splits become visible to other systems within a
  frame and risk broad determinism/gate fallout for a localized bug.
- **Engine-driven scaling via a generic `Sprite.width` read for all enemies.**
  Rejected for this change: every non-mini enemy currently relies on the fixed
  per-type scale, so a blanket switch risks visual regressions across slimes,
  rats, and bosses. Scoped the `Sprite.width` scaling to `slime-mini` only.
