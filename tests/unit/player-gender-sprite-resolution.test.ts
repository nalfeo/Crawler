/**
 * HARD SUCCESS GATE #2 for the gender-matched player walk-cycle sheets:
 * a deterministic test asserting that each of the three `world.playerGender`
 * values (`'female' | 'male' | 'other'`) resolves to its OWN, DISTINCT,
 * shipped 4-frame animated texture — not a shared fallback, and not silently
 * `null` (the exact failure mode that shipped the Kenney knight regression,
 * see `tests/unit/entity-sprite-mapping-art-wiring.test.ts`).
 *
 * This exercises the real production wiring end-to-end:
 *   - `entity-sprite-mappings.json`'s player `generated.variantsByAppearanceKey`
 *     (the actual shipped data, not a synthetic fixture).
 *   - `createPhaserBridge(scene).sync(world)` → the `appearanceKey` computation
 *     for `entityType === 'player'` (reads `world.playerGender`) →
 *     `resolveGeneratedTexture`'s variant lookup.
 */
import { addComponent, addEntity } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Player, Position, Sprite } from '../../src/core/components.js';
import { set } from '../../src/core/world.js';
import { createPhaserBridge } from '../../src/engine/PhaserBridge.js';
import ENTITY_SPRITE_MAPPINGS from '../../src/shared/data/entity-sprite-mappings.json';
import type { EntitySpriteMappings } from '../../src/shared/data/entity-sprite-mappings.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { createSceneStub } from '../fixtures/phaser-bridge-harness.js';

const MAPPINGS = ENTITY_SPRITE_MAPPINGS as EntitySpriteMappings;

const PLAYER_GENDERS = ['female', 'male', 'other'] as const;

function resolvedTextureKeyForGender(gender: (typeof PLAYER_GENDERS)[number]): string {
  const { scene, images } = createSceneStub({ kenneyLoaded: true });
  const bridge = createPhaserBridge(scene);
  const world = createTestWorld();
  world.playerGender = gender;
  const eid = addEntity(world.ecs);

  addComponent(world.ecs, eid, set(Position, { x: 0, y: 0 }));
  addComponent(world.ecs, eid, Player);
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 0, height: 0 }));

  bridge.sync(world);

  expect(images).toHaveLength(1);
  const textureKey = images[0]?.textureKey;
  expect(textureKey).toBeDefined();
  return textureKey as string;
}

describe('player gender sprite resolution (hard success gate #2)', () => {
  it('resolves every world.playerGender value to its own distinct shipped texture key', () => {
    const resolved = new Map(
      PLAYER_GENDERS.map((gender) => [gender, resolvedTextureKeyForGender(gender)]),
    );

    for (const gender of PLAYER_GENDERS) {
      // Must match the mapping's own configured variant — proves resolution
      // actually consulted `variantsByAppearanceKey`, not a coincidental
      // fallback to the top-level default.
      const expectedKey =
        MAPPINGS.renderKinds.player?.generated?.variantsByAppearanceKey?.[gender]?.pinnedTextureKey;
      expect(expectedKey, `no variantsByAppearanceKey["${gender}"] configured`).toBeDefined();
      expect(resolved.get(gender)).toBe(expectedKey);
    }

    // The core hard gate: three genders, three DISTINCT texture keys.
    const distinctKeys = new Set(resolved.values());
    expect(distinctKeys.size).toBe(PLAYER_GENDERS.length);
  });

  it('defaults to the female sheet when playerGender is unset (matches world.ts default)', () => {
    const { scene, images } = createSceneStub({ kenneyLoaded: true });
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const eid = addEntity(world.ecs);

    addComponent(world.ecs, eid, set(Position, { x: 0, y: 0 }));
    addComponent(world.ecs, eid, Player);
    addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 0, height: 0 }));

    expect(world.playerGender).toBe('female');
    bridge.sync(world);

    expect(images[0]?.textureKey).toBe(
      MAPPINGS.renderKinds.player?.generated?.variantsByAppearanceKey?.female?.pinnedTextureKey,
    );
  });
});
