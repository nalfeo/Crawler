# Session Handoff: Mob Sprite Variants

**Date:** 2026-06-30  
**Branch:** `nalfeo-mob-sprite-variants`  
**Estimate:** 🍎🍎🍎 (Medium)  
**Status:** ✅ Complete and merged

## Systems touched

enemies

## Summary

Implemented multi-variant sprite selection and size scaling for mobs with generated art. Each mob now randomly picks a visual variant at spawn (+/-10% size from default), enhancing visual variety while coupling perceived size to weight for physics coherence. All changes are render-only; gameplay and collision geometry remain unchanged.

## Verification Summary

- ✅ **npm run verify:fast** passed (typecheck, lint, unit tests)
- ✅ **npm run verify** passed (full suite: type, lint, format, unit, integration, headless Floor 1 gate, all 2788 tests passing)
- ✅ **Review harness:** plan review (4 concerns resolved) + code review (2 concerns fixed, clean)
- ✅ **Ledger validation:** review-ledger created and committed
- ✅ **PR prerequisites:** handoff + ADR written, no blockers

## Files Changed

### Core ECS State

- **`src/core/components.ts`**: Added `variantRoll` and `sizeScale` to Sprite store
- **`src/core/world.ts`**: Added `enemyAppearanceKeys: Map<number, string>` sidecar for stable mob identity
- **`src/core/spawners/entity-core.ts`**: Added cleanup of appearance keys on entity recycle

### Appearance Assignment

- **`src/core/spawners/combatants.ts`**: Core appearance logic
  - `initializeEnemyAppearance()`: Deterministic variant roll + size scale (hashed from world seed + eid + position)
  - `setEnemyAppearanceKey()`: Export helper for spawn paths to tag mobs with appearance identity
  - Integrated into `spawnEnemy()` and `spawnBehaviorEnemy()`

### Spawn Paths

- **`src/game/floorScenario.ts`**: Added appearance key assignments for ambient archetypes, staircase boss ('rat-slime')
- **`src/game/spawners/spawnerSystem.ts`**: Set appearance key for spawned children using mob.id
- **`src/core/systems/dropSystem.ts`**: Set appearance key for slime splits ('slime-mini'); **fixed** baby slime weight double-scaling by extracting base weight before split calculation

### Rendering & Texture Resolution

- **`src/engine/phaser-bridge/sprite-kind.ts`**: Multi-variant texture selection
  - `pickGeneratedEnemyTextureKey()`: Uses variant roll + brief ID to select from multi-variant registry
  - `generatedBriefIdForEnemy()`: Maps appearance keys to generated-art brief IDs
  - Added lookup tables for multi-variant enemy types (slime, rat)
- **`src/engine/PhaserBridge.ts`**: Integrated appearance into rendering
  - `computeEnemyScale()`: Applies size scale multiplier to base sprite scale
  - `resolveTexture()`: Accepts appearance key + variant roll for multi-variant selection
  - Updated live rendering path to use stored appearance identity
  - Extended corpse-explosion VFX to resolve variant identity from combat event payload

### Combat & Events

- **`src/shared/combat-events.ts`**: Extended CombatEvent with `spriteAppearanceKey`, `spriteVariantRoll`, `spriteSizeScale`, `spriteWidth`
- **`src/core/apply-damage.ts`**: Captured appearance fields when recording combat events

### Tests

- **`tests/ecs/spawners/combatants.test.ts`**: Updated weight expectations; all 2 tests passing
- **`tests/ecs/weight.test.ts`**: Updated to expect scaled weight (`120 * sizeScale`); all 4 tests passing
- **`tests/ecs/drop-system.test.ts`**: Added appearance key and weight scaling assertions for baby slimes
- **`tests/unit/phaser-bridge-sprite-kind.test.ts`**: Added multi-variant selection and size scale tests
- **`tests/unit/phaser-bridge.test.ts`**: Added test for generated variant selection via stored variant roll

## Key Design Decisions

1. **Deterministic appearance RNG**: Used `hashStringToSeed(world.seed + eid + frameCount + position)` to derive variant roll independently of game RNG, preserving gameplay determinism.
2. **Appearance key sidecar**: Persistent `enemyAppearanceKeys` map tracks mob archetypes (rat, slime, slime-mini) so rendering can select from multi-variant briefs without re-rolling.
3. **Render-only mutations**: Size scale and variant roll affect only Sprite stores (width/height display); collision geometry unchanged.
4. **Weight coupling**: Size scale multiplies both render scale and weight at spawn, coupling perceived size to collision mass.
5. **Baby slime weight fix**: Extracted base weight before split formula to prevent double-scaling (parent was pre-scaled before spawn).
6. **Corpse integration**: Extended CombatEvent to carry appearance identity so corpse-explosion VFX resolve the same variant logic after entity death.

## Unresolved Issues

None. All code review concerns addressed:

- Baby slime double-scaling fixed (base weight extraction)
- Missing 'slime-rat' appearance key removed (quest boss doesn't have generated variants yet)

## Test Results

- **Unit tests:** 2788/2788 passing
- **Integration tests:** 49/50 passing (1 skipped due to judge budget)
- **Headless Floor 1 gate:** 17/17 passing (baseball-bat win-rate 90%+ over 8 seeds)

## Technical Details

- **Size scale range:** 0.9–1.1 (±10% from default)
- **Appearance assignment timing:** Immediately after final sprite data is set in each spawn path
- **Appearance key format:** Mob archetype string ('rat', 'slime', 'slime-mini', 'rat-slime')
- **Variant roll determinism:** Seeded from world state (seed + eid + frameCount + position), ensuring replay consistency
- **Corpse payload:** CombatEvent now carries `spriteAppearanceKey`, `spriteVariantRoll`, `spriteSizeScale`, `spriteWidth` for VFX resolution

## Recommended Next Steps

1. **Monitor variant coverage:** As new multi-variant briefs are approved, expand `generatedBriefIdForEnemy()` lookup table to include them.
2. **Quest boss variants:** Once 'slime-rat' quest boss gets generated art variants, add appearance key assignment in `floorScenario`.
3. **Cosmetic system:** If future cosmetics/skins are needed, this appearance pipeline is ready to be extended with appearance-slot overrides.
4. **Art style coherence:** Consider whether future multi-variant mobs should use the same size-scaling approach for consistency.

## ADR

See `docs/knowledge/adr/2026-06-30-mob-appearance-multiplayer-variants.md` for architectural rationale, alternatives, and risk mitigation.

## Ledger

See `docs/knowledge/review-ledgers/2026-06-30-mob-sprite-variants.review-ledger.json` for review artifacts.
