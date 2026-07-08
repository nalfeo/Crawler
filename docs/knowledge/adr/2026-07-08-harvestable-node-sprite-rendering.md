# ADR: Floor-1 harvestable world-node generated-sprite rendering

## Status

Accepted

## Date

2026-07-08

## Estimated Complexity

🍎 x 3 - cross-layer rendering + data hookup (engine render path, phaser-bridge
resolver, a determinism-safe core spawner seed) with a 5-sprite art batch and
deterministic unit/integration/e2e/ecs tests.

## Context

The six Floor-1 harvestable world nodes (`crimson-mushroom`, `azure-mushroom`,
`sunpetal-flower`, `moonbloom-flower`, `frost-lichen`, `shadow-lichen`) rendered
as flat procedural tinted circles on the dungeon floor. Real top-down pixel-art
sprites were desired to match the game's visual bar (the enemy/NPC render paths
already resolve generated art this way).

Two gaps blocked this:

1. No resolver mapped a harvestable def id to a generated `briefId`, and
   `PhaserBridge` had no sprite path for harvestable nodes — only the circle.
2. `spawnHarvestableNode` never seeded the `Sprite.variantRoll` field. The
   `Float32Array` default of `0` pinned every node to art variant index `0`, so
   any node type with multiple approved variants (e.g. `azure-mushroom`, reused
   from an already-approved brief) could only ever show its first variant.

The bare-item-id resolution path (`itemId === briefId`) is deliberately **not**
used here: that surface belongs to the inventory Materials icon (a separate,
out-of-scope render surface) and would collide with the existing
`azure-mushroom-v1` art.

## Decision

1. **Resolver map (engine/phaser-bridge).** Add an explicit
   `GENERATED_BRIEF_BY_HARVESTABLE` map + `generatedBriefIdForHarvestable(defId)`
   in `src/engine/phaser-bridge/sprite-kind.ts`, mirroring
   `generatedBriefIdForEnemy`. Harvestable nodes resolve to a **versioned**
   `<harvestable-id>-v1` briefId (e.g. `crimson-mushroom -> crimson-mushroom-v1`),
   not the bare item id.
2. **Deterministic variant pick.** Add
   `pickGeneratedHarvestableTextureKey(registry, defId, roll)` that maps a def id
   and a stored `[0,1)` roll to a concrete approved texture key, mirroring the
   enemy path.
3. **Render path (engine).** In the `PhaserBridge` harvestable branch, resolve
   the texture; if it exists, draw a `Phaser.GameObjects.Image` (tracked in a new
   `harvestNodeImages` map with despawn/reset cleanup mirroring
   `harvestNodeGraphics`) scaled to the node footprint; otherwise keep the
   existing procedural circle. The harvest progress ring is always drawn on top,
   regardless of which base is used.
4. **Determinism-safe cosmetic seed (core).** Seed `Sprite.variantRoll` in
   `spawnHarvestableNode` (`src/core/spawners/world-objects.ts`) from a **local**
   `new SeededRandom(hashStringToSeed('harvestable-appearance:...'))` keyed on
   world seed + entity + frame + position — mirroring `initializeEnemyAppearance`.
   It **never** draws from `world.rng`, so it cannot perturb simulation
   determinism or win-rate. `variantRoll`'s only gameplay reader
   (`emitCorpseExplosion`) is `Enemy`+`DeathTimer`-gated and unreachable by
   harvestable nodes, so this seed is render-only.
5. **Art.** Generate five node briefs/sprites; reuse the already-approved
   `azure-mushroom-v1` (two variants) rather than regenerating. All six def types
   resolve to real, non-placeholder art.
6. **Tests.** Add unit (mapping + deterministic pick), integration
   (manifest-coverage: every registered def resolves to non-placeholder art),
   e2e (real-scene render: all nodes draw sprites, zero circle fallbacks), and
   ecs spawner tests (variantRoll seeded + deterministic).

## Consequences

### Positive

- All six Floor-1 harvestable types render dedicated generated art with the
  harvest progress ring preserved.
- New harvestable node types automatically pick up art as soon as a matching
  `<id>-v1` brief lands in the manifest — no further engine change.
- Variant selection is deterministic and render-only; it cannot affect the sim.
- The circle fallback keeps any unwired/artless node type rendering safely.

### Negative

- One more render-identity branch + mapping surface to maintain when new
  harvestable appearance keys are introduced.

### Risks

- Renaming a harvestable def id without updating `GENERATED_BRIEF_BY_HARVESTABLE`
  silently falls back to the circle. Mitigated by the integration test asserting
  **every** registered def resolves to non-placeholder art.
- Node types whose `-v1` brief is absent from the manifest render via the circle
  fallback until that art lands (same graceful-degradation contract as the
  spawner-appearance precedent).

## Alternatives Considered

- **Bare item-id briefId** (rejected): resolves the inventory Materials icon —
  the wrong render surface — and collides with `azure-mushroom-v1`.
- **Draw the sprite without seeding `variantRoll`** (rejected): pins every node
  to variant index `0`, making `azure-mushroom`'s second approved variant
  unreachable.
- **Seed `variantRoll` from `world.rng`** (rejected): would consume the shared
  simulation RNG stream and perturb determinism / win-rate. A local
  hash-seeded `SeededRandom` keeps the appearance roll gameplay-neutral.
- **Regenerate `azure-mushroom` art** (rejected): the existing v1 variants were
  already approved and on-style; regeneration would waste Azure credits.
