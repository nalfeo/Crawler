# ADR 0007: Spatial Units Architecture (Pixels vs Feet)

## Status

Superseded by 0023

## Date

2026-06-08

> Historical intermediate decision. The current canonical spatial-unit contract
> is [ADR 0023](0023-feet-as-single-internal-spatial-unit.md); this ADR is kept
> to explain how the project moved from pixel-internal stores to feet-only
> simulation units.

**Scope:** src/core, src/game, src/shared  
**Affects:** ECS stores, game systems, design tuning

## Context

Players understand game measurements in feet (e.g., "Range: 45 ft", "Enemy size: 1 ft"). However, Phaser renders and positions sprites in pixel coordinates, and all physics/collision math operates in pixels.

We needed to bridge this gap: author game design in human-readable feet while maintaining pixel-based rendering and physics.

## Decision

**ECS stores and rendering stay in pixels. All design values are authored in feet, with conversion happening at a single boundary: the weapon system attack dispatchers.**

### Architecture

```
Design Layer (tuning.json, weaponDefs.ts)
    ↓ [authored in feet]
    ↓
Constants Layer (constants.ts)
    ↓ [wrapped with ftToPx()]
    ↓
System Constants (enemyAISystem, dropSystem, etc.)
    ↓ [wrapped with ftToPx()]
    ↓
ECS Dispatch Boundary (weaponSystem attack functions)
    ↓ [ftToPx() applied here]
    ↓
ECS Stores (in pixels)
    ↓ [pixel coordinates]
    ↓
PhaserBridge & Rendering (1:1 pixel-to-screen mapping)
```

## Alternatives Considered

1. **Convert entire codebase to feet**
   - Pros: Uniform everywhere
   - Cons: Requires changes to PhaserBridge (sprite.x/y), physics math, spatial hash grid — risky, high surface area
   - Rejected: Too many moving parts

2. **Convert only at UI display time**
   - Pros: No changes to game logic
   - Cons: Still need to track two unit systems; conversion scattered across UI code; no benefit at design time
   - Rejected: Doesn't improve designer experience

3. **Hybrid: Convert at dispatch boundary (chosen)**
   - Pros: Single conversion point; physics/rendering untouched; designers work in feet; clean separation
   - Cons: Need `ftToPx()` calls at dispatch; test assertions need wrapping
   - Accepted: Best trade-off for safety + usability

## Consequences

### Positive

- **Single conversion boundary**: All design→ECS happens in `weaponSystem.ts` attack dispatchers. Easy to audit, hard to double-convert by accident.
- **No physics changes**: PhaserBridge, collision system, spatial hash grid remain 100% pixel-based. Low risk.
- **Designer-friendly**: All tuning values (tuning.json, weaponDefs.ts) are in feet. Easier to reason about and adjust.
- **Clean constants**: `WEAPON.*`, `ENEMY_PROJECTILE.*` constants receive pixels from `ftToPx()`, so systems can use them directly without further conversion.

### Trade-offs

- **Test assertions need wrapping**: Any test that checks ECS stores must wrap expected values with `ftToPx()`.
- **Exception: pickupRange stat**: Currently stays in pixels (stats pipeline is generic; no distance-specific handling). Can apply `pxToFt()` at UI display time when needed.
- **Manual call sites**: Every system that reads design values must apply `ftToPx()`. No automatic or implicit conversion.

## Implementation Details

- `PIXELS_PER_FOOT = 8` chosen for clean numbers (5ft sword, 1ft enemy, 2ft pickup radius)
- `src/shared/units.ts` provides: `ftToPx()`, `pxToFt()`, `formatFeet()`, `PIXELS_PER_FOOT`
- Attack dispatch applies `ftToPx()` to: aoeRadius, headRadius, knockback, maxRange, beamLength, triggerRadius, explosionRadius
- System constants wrapped at definition time (constants.ts, enemyAISystem.ts, etc.)

## Related

- Handoff: no session handoff was written for this change (predates handoff convention).
- Implementation PR: #86

## Decision Record

This decision was made to balance **usability** (designers work in feet) with **safety** (minimal changes to existing physics/rendering code). If future requirements demand feet throughout the codebase, this ADR can be revisited; the conversion module (`src/shared/units.ts`) makes a full migration feasible.
