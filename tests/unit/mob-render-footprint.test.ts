/**
 * Guard — REAL-pipeline proof that mobs draw at their authored world footprint.
 *
 * Mobs used to be scaled by a raw pixel multiplier (`generated.scale`) tuned
 * for the sprite pipeline's original 64×64 enemy canvas. When that default grew
 * to 256×256 (512×512 for boss `sizeVariant: large`), nothing re-derived the
 * multiplier, so mobs drawn from the newer art rendered many times oversized —
 * a Floor 2 family boss at `scale: 1.0` with 482×454 opaque pixels drew
 * 482 / 8 ≈ **60 ft tall** next to a ~5 ft player.
 *
 * Per repo rule #9, a resolver unit test cannot prove this: the fix has to be
 * observed in the real render path. So this test drives the **real
 * `PhaserBridge.sync`** over a world built with the **real enemy spawner**, and
 * feeds it the **real shipped manifest shards** (`public/assets/generated/entries`)
 * for both a Floor 1 rat (64×64 art) and a Floor 2 family boss (540×512 art),
 * with the stub scene reporting each texture's true native canvas size.
 *
 * Before/after with this PR's `PhaserBridge` edits reverted:
 *   rat  0.4 × 41px  / 8 =  2.05 ft tall   → 2.05 ft (preserved)
 *   boss 1.0 × 454px / 8 = 56.75 ft tall   → 7.0 ft (authored)
 *   boss/rat height ratio 27.7×            → 3.4×
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createTestWorld } from '../helpers/world-factory.js';
import { spawnEnemy, setEnemyAppearanceKey } from '../../src/core/spawners/combatants.js';
import { createPhaserBridge } from '../../src/engine/PhaserBridge.js';
import { buildGeneratedSpriteRegistry } from '../../src/shared/generated-assets.js';
import { PIXELS_PER_FOOT } from '../../src/shared/units.js';
import ENTITY_SPRITE_MAPPINGS from '../../src/shared/data/entity-sprite-mappings.json';
import type { EntitySpriteMappings } from '../../src/shared/data/entity-sprite-mappings.js';
import { createSceneStub, type MockImage } from '../fixtures/phaser-bridge-harness.js';

const MAPPINGS = ENTITY_SPRITE_MAPPINGS as EntitySpriteMappings;

/** `Sprite.textureId` for the plain rat variant (render kind `enemy_rat`). */
const TEX_RAT = 1;
/** `Sprite.textureId` for a Floor 2 family boss (render kind `enemy_family_boss`). */
const TEX_FAMILY_BOSS = 5;

interface Shard {
  readonly briefId: string;
  readonly spriteName: string;
  readonly opaqueBounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly canvasWidth: number;
    readonly canvasHeight: number;
  };
}

function loadShard(spriteName: string): Shard {
  const file = path.resolve(
    import.meta.dirname,
    `../../public/assets/generated/entries/${spriteName}.json`,
  );
  return JSON.parse(readFileSync(file, 'utf8')) as Shard;
}

/** Small Floor 1 rat art (original 64×64 canvas). */
const RAT = loadShard('rat-v1-var-9');
/** Oversized Floor 2 boss art (512-class canvas) — the "HUGE mob" case. */
const BOSS = loadShard('goblin-boss-var-0');

function registryFor(shards: readonly Shard[]): ReturnType<typeof buildGeneratedSpriteRegistry> {
  const entries: Record<string, unknown> = {};
  for (const shard of shards) {
    entries[shard.spriteName] = {
      briefId: shard.briefId,
      spriteName: shard.spriteName,
      assetPath: `generated/${shard.spriteName}.png`,
      approvedAt: '2026-08-02T00:00:00.000Z',
      sourceRun: 'test',
      variantIndex: 0,
      anchor: null,
      sensorScore: '8/8',
      judgeScore: '2',
      opaqueBounds: shard.opaqueBounds,
    };
  }
  return buildGeneratedSpriteRegistry({ version: 1, entries } as Parameters<
    typeof buildGeneratedSpriteRegistry
  >[0]);
}

/** Drawn height (FEET) of the visible art for a rendered image. */
function drawnHeightFt(img: MockImage, shard: Shard): number {
  return (Math.abs(img.scaleY) * shard.opaqueBounds.height) / PIXELS_PER_FOOT;
}

describe('mob render footprint (real PhaserBridge.sync)', () => {
  it('draws Floor 1 and Floor 2 mobs at their authored height regardless of canvas size', () => {
    const world = createTestWorld({ seed: 4242 });

    const ratEid = spawnEnemy(world, 10, 10, 10);
    world.stores.sprite.textureId[ratEid] = TEX_RAT;
    setEnemyAppearanceKey(world, ratEid, 'rat');

    const bossEid = spawnEnemy(world, 30, 10, 200);
    world.stores.sprite.textureId[bossEid] = TEX_FAMILY_BOSS;
    setEnemyAppearanceKey(world, bossEid, 'goblin-boss');

    const registry = registryFor([RAT, BOSS]);
    const { scene, images } = createSceneStub({
      kenneyLoaded: true,
      // The stub reports each generated texture's TRUE native canvas size, which
      // is what the renderer must divide out to hit an authored footprint.
      textureSizes: (key) => {
        if (key === RAT.spriteName) {
          return { width: RAT.opaqueBounds.canvasWidth, height: RAT.opaqueBounds.canvasHeight };
        }
        if (key === BOSS.spriteName) {
          return { width: BOSS.opaqueBounds.canvasWidth, height: BOSS.opaqueBounds.canvasHeight };
        }
        return undefined;
      },
    });
    (scene.game as unknown) = { registry: { get: () => registry } };

    const bridge = createPhaserBridge(scene);
    bridge.sync(world, 0);
    bridge.sync(world, 500);

    const ratImg = (images as MockImage[]).find((img) => img.textureKey === RAT.spriteName);
    const bossImg = (images as MockImage[]).find((img) => img.textureKey === BOSS.spriteName);
    expect(ratImg, 'Floor 1 rat did not render its generated art').toBeDefined();
    expect(bossImg, 'Floor 2 family boss did not render its generated art').toBeDefined();

    const ratHeightFt = drawnHeightFt(ratImg!, RAT);
    const bossHeightFt = drawnHeightFt(bossImg!, BOSS);

    // Enemies carry a deterministic cosmetic sizeScale jitter in [0.9, 1.1]
    // (initializeEnemyAppearance) applied on top of the footprint scale, so the
    // authored height is asserted within that band.
    const authoredRatFt = MAPPINGS.renderKinds.enemy_rat!.generated!.heightFt!;
    const authoredBossFt = MAPPINGS.renderKinds.enemy_family_boss!.generated!.heightFt!;
    expect(ratHeightFt).toBeGreaterThanOrEqual(authoredRatFt * 0.9 - 1e-6);
    expect(ratHeightFt).toBeLessThanOrEqual(authoredRatFt * 1.1 + 1e-6);
    expect(bossHeightFt).toBeGreaterThanOrEqual(authoredBossFt * 0.9 - 1e-6);
    expect(bossHeightFt).toBeLessThanOrEqual(authoredBossFt * 1.1 + 1e-6);

    // The headline regression: a boss must not tower absurdly over a rat. Before
    // the fix this ratio was ~27×; a boss is now a boss, not a building.
    expect(bossHeightFt / ratHeightFt).toBeLessThan(4);
    // …and must still be visibly bigger than a mook.
    expect(bossHeightFt).toBeGreaterThan(ratHeightFt);
    // Nobody is taller than a two-storey room.
    expect(bossHeightFt).toBeLessThan(12);
  });

  it('keeps the legacy pixel scale when the texture size is unknown', () => {
    // Headless/stub scenes and not-yet-decoded textures report no size. Those
    // must fall back to the previous look rather than to a bogus footprint.
    const world = createTestWorld({ seed: 99 });
    const ratEid = spawnEnemy(world, 10, 10, 10);
    world.stores.sprite.textureId[ratEid] = TEX_RAT;
    setEnemyAppearanceKey(world, ratEid, 'rat');

    const registry = registryFor([RAT]);
    const { scene, images } = createSceneStub({ kenneyLoaded: true });
    (scene.game as unknown) = { registry: { get: () => registry } };

    const bridge = createPhaserBridge(scene);
    bridge.sync(world, 0);
    bridge.sync(world, 500);

    const ratImg = (images as MockImage[]).find((img) => img.textureKey === RAT.spriteName);
    expect(ratImg).toBeDefined();
    const legacyScale = MAPPINGS.renderKinds.enemy_rat!.generated!.scale;
    const sizeScale = world.stores.sprite.sizeScale[ratEid]!;
    expect(Math.abs(ratImg!.scaleY)).toBeCloseTo(legacyScale * sizeScale, 6);
  });
});
