# ADR: Mob Appearance Multiplayer Variants

**Date:** 2026-06-30  
**Status:** Accepted  
**Scope:** src/core (ECS state), src/engine (PhaserBridge texture resolution), src/game (spawn paths)

## Status

Accepted (2026-06-30).

## Context

Mobs with multi-variant generated art (slime, rat) were only using a single variant each. Players saw the same visual every spawn, reducing visual variety. Size variation (+/-10% per mob) was requested to enhance perceived differentiation and tie to weight for physics coherence.

## Decision

Implement spawn-time appearance assignment as a deterministic system that:

1. **Decouples appearance from gameplay.** Store variant roll and size scale in the `Sprite` component (render-only mutations) without affecting collision geometry or gameplay state.
2. **Persists appearance identity.** Use a world sidecar `enemyAppearanceKeys: Map<number, string>` to tag each mob with its archetype (e.g. `'rat'`, `'slime'`, `'slime-mini'`) so rendering can select from all variants without re-rolling.
3. **Uses deterministic RNG for appearance.** Derive a seed from `world.seed + eid + frameCount + position` to generate the variant roll and size scale independently of gameplay RNG, avoiding consumption of the critical game sequence.
4. **Assigns appearance at spawn sites.** Call `initializeEnemyAppearance()` in each spawn path (`spawnEnemy`, `spawnBehaviorEnemy`, `spawnerSystem` for children, `floorScenario` for bosses, `dropSystem` for splits) immediately after setting final sprite data.
5. **Threads appearance through corpse events.** Extend `CombatEvent` with `spriteAppearanceKey`, `spriteVariantRoll`, `spriteSizeScale`, `spriteWidth` so corpse-explosion VFX can use the same multi-variant logic after entity death.
6. **Couples weight to size scale.** Multiply stored weight by sizeScale at spawn time, coupling perceived size to collision mass without changing collision geometry.

## Consequences

### Positive

- **Visual variety:** Each spawn-time roll produces 0–N distinct visual variants, eliminating repetitive silhouettes.
- **Deterministic reproducibility:** Appearance is keyed to entity ID + position, so the same mob in the same world state always appears identically across replay.
- **No gameplay regression:** Collision geometry and all physics remain unchanged; only render-layer data mutates.
- **Clean separation of concerns:** Appearance is orthogonal to AI, movement, and combat logic; any future skin/cosmetic system can reuse the same pipeline.
- **Backward compatible:** Registry lookups gracefully fall back to single-variant or Kenney art when multi-variant briefs are unavailable.

### Negative

- **Added memory footprint:** `enemyAppearanceKeys` sidecar adds one string key per live entity.
- **Increased spawn latency:** Two additional randomness computations per spawn (variant roll + size scale), though negligible (~microseconds).
- **Corpse event payload size:** CombatEvent now carries appearance identity, increasing serialization volume for logs/telemetry (mitigated by use in VFX only).

### Risks

- **Weight scaling edge case:** Parent slime weight is pre-scaled before split calculation; must read base weight first to avoid double-scaling baby weight. (Mitigated by extracting base weight before split formula.)
- **Missing appearance keys:** Quest bosses don't have generated-art variants yet; must not assign appearance keys that lack registry entries. (Mitigated by conditional assignment based on archetype support.)
- **Variant selection determinism:** If variant roll is not deterministically derived from world state, replay will fail. (Mitigated by seeding from world.seed + eid + frameCount + position.)

## Alternatives Considered

1. **Consume game RNG for appearance:** Simpler (no extra hash computation), but interferes with gameplay determinism across difficulty resets and seed plays.
2. **Assign appearance lazily at render time:** Avoids memory overhead, but can't thread through corpse events and complicates corpse-explosion VFX.
3. **Hardcode variant selection by mob type:** Reduces code complexity, but eliminates randomness and requires manual maintenance per variant count.

## Implementation Notes

- **Appearance assignment:** `initializeEnemyAppearance()` in `src/core/spawners/combatants.ts` computes appearance at spawn time using deterministic hashing.
- **Texture resolution:** `pickGeneratedEnemyTextureKey()` in `src/engine/phaser-bridge/sprite-kind.ts` uses stored variant roll and appearance key to select from multi-variant registry.
- **Corpse fallback:** `CombatEvent` captures appearance identity; `PhaserBridge.ts` corpse-explosion path uses same variant logic as live rendering.
- **Weight coupling:** Baby slimes extract base weight before split calculation to avoid double-scaling.

## References

- Implementation: `src/core/spawners/combatants.ts` (appearance init), `src/engine/phaser-bridge/sprite-kind.ts` (multi-variant selection), `src/engine/PhaserBridge.ts` (corpse integration)
- Tests: `tests/ecs/spawners/combatants.test.ts`, `tests/ecs/drop-system.test.ts`, `tests/unit/phaser-bridge.test.ts`, `tests/unit/phaser-bridge-sprite-kind.test.ts`
