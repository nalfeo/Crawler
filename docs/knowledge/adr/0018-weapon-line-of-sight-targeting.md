# ADR 0018: Line-of-Sight Gate for Weapon Auto-Targeting

## Status

Accepted

**Date:** 2026-06-25
**Deciders:** Systems Engineer

## Estimated Complexity

🍎🍎🍎 — touches 2 layers (`src/core` map primitives + `src/game` weaponSystem); no new ECS system, so no new lab required.

## Context

Auto-fire weapons select a target via `getNearestEnemyTarget` in
`src/game/weaponSystem.ts`. The ranged/magic/thrown/beam path called it with
`ignoreFov = inCombat`, where `inCombat` is `true` whenever **any** enemy sits
within `COMBAT_RADIUS_PX = 1200`px. Passing `ignoreFov = true` skipped the FOV
visibility check entirely, so the nearest enemy was targeted even when a wall sat
between it and the player. In practice the bow fired arrows straight into walls
at enemies in the next room.

The FOV-bypass was not accidental: the player FOV radius is 25 tiles = 800px,
which is **smaller** than the 1200px combat radius. A strict `isVisible`-only
gate would refuse to fire back at an enemy attacking from just past the FOV edge
in the same open room. The original author disabled the wall check entirely to
work around that, trading correctness (no wall-shots) for responsiveness
(retaliate at range).

We need a targeting gate that both (a) never fires through walls and (b) still
allows firing at a clearly-visible enemy slightly beyond the FOV radius.

## Decision

Introduce a deterministic tile line-of-sight primitive and gate targeting on
**FOV-visible OR clear line of sight**, instead of a binary FOV bypass.

1. **`TileMap.lineOfSight(x0,y0,x1,y1)`** (`src/core/map/TileMap.ts`) — Bresenham
   walk over tiles; returns `false` if any tile _strictly between_ the endpoints
   is opaque (`!isTransparent`). Endpoint tiles never block (shooter/target
   stand on them); out-of-bounds tiles count as opaque, mirroring
   `isTransparent`. Pure integer math: no allocation, no RNG, no `Date.now()`.
2. **`FloorMap.hasLineOfSight(px0,py0,px1,py1)`** (`src/core/map/FloorMap.ts`) —
   pixel→tile convenience that delegates to `TileMap.lineOfSight`.
3. **`getNearestEnemyTarget`** — when a `floorMap` exists and FOV is not
   explicitly ignored, an enemy is eligible only if its tile `isVisible`
   **or** `hasLineOfSight(player → enemy)` is clear.
4. **`weaponSystem`** ranged call site passes `false` (not `inCombat`), so the
   sight gate always applies to ranged/magic/thrown/beam.

### Key Semantics

- **`isVisible` fast-path is intentional.** The rot-js recursive-shadowcasting
  FOV is more permissive at wall corners than a single center-line ray. If the
  enemy tile is already FOV-visible, fire without re-running the ray so
  legitimate shots aren't suppressed by a ray that grazes a corner.
- **Opacity, not passability, defines a blocker.** Open doors and windows
  (transparent) pass; closed doors and walls block — consistent with the FOV
  shadowcaster's `createLightPassesCallback`.
- **Melee is unchanged** (`ignoreFov = true`). Melee has its own `inCombat` gate
  and a tiny gate range (sword ≈ 60px < 2 tiles); a wall between the player and
  a sub-2-tile enemy is not the reported failure mode.

## Consequences

### Positive

- Ranged weapons never fire through walls into adjacent rooms.
- Retaliation against enemies just past the FOV radius in the same open area is
  preserved (clear straight line ⇒ eligible).
- `lineOfSight` is a reusable, allocation-free primitive now available to enemy
  AI sight checks and ranged-enemy LOS gating.
- Determinism preserved: integer Bresenham, no RNG/time.

### Negative

- Adds one Bresenham walk per candidate enemy per fire evaluation when the
  `isVisible` fast-path misses. Bounded by tile distance (≤ gate range / tile
  size, typically < 20 steps) and only on the non-visible branch.
- Two layers now share the LOS contract (core primitive + game targeting),
  necessitating this ADR.

### Risks

- A concave wall corner could let the FOV mark a tile visible while the strict
  center ray is blocked; the `isVisible` fast-path deliberately fires in that
  case (matches what the player sees). If FOV tuning later diverges from intent,
  the fast-path may need revisiting.
- `enemyAISystem` ranged shooters are **not** gated by this change; enemy/player
  LOS symmetry is left as a follow-up.

## Alternatives Considered

1. **Keep the full FOV bypass during combat.** Rejected — this is the bug.
2. **Strict `isVisible`-only gate (no LOS, no bypass).** Rejected — refuses to
   fire at clearly-visible enemies just past the 800px FOV radius inside the
   1200px combat radius, degrading responsiveness.
3. **Raise the FOV radius to ≥ combat radius.** Rejected — couples fog-of-war
   reveal distance to weapon targeting and enlarges the rendered visible set for
   an unrelated reason.
4. **Floating-point DDA / supercover ray.** Rejected — integer Bresenham is
   deterministic, allocation-free, and sufficient at tile granularity.
5. **Per-pixel raycast against entity colliders.** Rejected — far more expensive
   and unnecessary; tile opacity already defines walls for FOV.

## References

- Related systems: `weaponSystem`, `fovSystem`, `FloorMap`, `TileMap`.
- Test files: `tests/ecs/tilemap.test.ts`, `tests/ecs/floor-map.test.ts`,
  `tests/game/weapon-system-coverage.test.ts`.
- Handoff: `docs/knowledge/handoffs/archive/2026-06-25-weapon-fov-firing.md`.
