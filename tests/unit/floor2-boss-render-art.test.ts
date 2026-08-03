import { describe, expect, it } from 'vitest';
import { hasComponent } from 'bitecs';
import { SeededRandom } from '../../src/shared/random.js';
import { BiomeType } from '../../src/shared/map-types.js';
import type { MapConfig } from '../../src/shared/map-types.js';
import { CaveSystemGenerator } from '../../src/core/map/generators/cave-system.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { FamilyMembership } from '../../src/core/index.js';
import { initializeFloor2Bosses } from '../../src/game/floor2Scenario.js';
import { loadFamilies } from '../../src/shared/data/families.js';
import { loadResources } from '../../src/shared/data/resources.js';
import { selectFloor2Roster } from '../../src/core/faction-relations.js';
import { createPhaserBridge } from '../../src/engine/PhaserBridge.js';
import { generatedBriefIdForEnemy } from '../../src/engine/phaser-bridge/sprite-kind.js';
import { buildGeneratedSpriteRegistry } from '../../src/shared/generated-assets.js';
import { createSceneStub, type MockImage } from '../fixtures/phaser-bridge-harness.js';

/**
 * Guard B — bridge-level REAL-pipeline render proof for Floor-2 family bosses.
 *
 * This is the "observe before done" gate required by project rules #10/#15: a
 * green resolver unit test can NOT prove the real render path emits generated
 * art (cf. the inert `spawnerSystem`, ADR 0034→0036). So this test drives the
 * **real production spawn helper** `initializeFloor2Bosses` (the same one the
 * Floor-2 scenario/headless runner invoke) and then runs the spawned world
 * through the **real `PhaserBridge.sync`** — the actual engine surface that
 * decides which texture each enemy renders. NOT a lab.
 *
 * It asserts every spawned boss renders **its own** generated brief art (keyed
 * by the appearance key `spawnFamilyBoss` sets) at the LARGE boss scale of 1.0
 * — the exact wiring this PR adds.
 *
 * Deterministic before/after (documented in the handoff): with the four source
 * edits stashed, bosses spawn at `spriteTexture: 1` with no appearance key →
 * `enemy_rat` → rat fallback art at scale 0.4, so the expected boss keys are
 * absent and this test FAILS. With the edits, it passes.
 */

function smallCaveConfig(seed: number): MapConfig {
  return {
    widthTiles: 80,
    heightTiles: 60,
    tileSizeFt: 4,
    biome: BiomeType.CAVE_SYSTEM,
    seed,
    roomWidthRange: [5, 12],
    roomHeightRange: [5, 12],
    maxRooms: 20,
    floorDensity: 0.45,
  };
}

interface SpawnedBoss {
  eid: number;
  appearanceKey: string | undefined;
  briefId: string | undefined;
}

/** Boot the real Floor-2 boss spawn path and return the spawned bosses. */
function bootFloor2Bosses(seed: number, presentCount: number) {
  const gen = new CaveSystemGenerator({ presentCount });
  const floorMap = gen.generate(smallCaveConfig(seed), new SeededRandom(seed));

  const world = createTestWorld({ seed, floor: 2 });
  const families = loadFamilies();
  const resources = loadResources();
  const roster = selectFloor2Roster(new SeededRandom(seed), families, resources);
  world.floorExtendedState = {
    familyState: {
      presentFamilies: [...roster.presentFamilies],
      contestedResource: roster.contestedResource,
      betrayerFlag: false,
    },
  };

  initializeFloor2Bosses(world, floorMap, world.floorExtendedState.familyState!);

  const bossField = world.stores.familyMembership.isBoss;
  const bosses: SpawnedBoss[] = [];
  for (let eid = 0; eid < bossField.length; eid++) {
    if (bossField[eid] === 1 && hasComponent(world.ecs, eid, FamilyMembership)) {
      const appearanceKey = world.enemyAppearanceKeys.get(eid);
      const briefId =
        appearanceKey === undefined
          ? undefined
          : generatedBriefIdForEnemy('enemy_family_boss', appearanceKey);
      bosses.push({ eid, appearanceKey, briefId });
    }
  }
  return { world, bosses, presentCount: roster.presentFamilies.length };
}

/**
 * Build a registry containing exactly one `-var-0` variant per boss brief, so
 * the bridge's registry-first resolution picks each boss's OWN art (not the
 * shared pinned goblin fallback).
 */
function registryForBosses(bosses: SpawnedBoss[]): ReturnType<typeof buildGeneratedSpriteRegistry> {
  const entries: Record<string, unknown> = {};
  for (const boss of bosses) {
    if (boss.briefId === undefined) continue;
    const key = `${boss.briefId}-var-0`;
    entries[key] = {
      briefId: boss.briefId,
      spriteName: key,
      assetPath: `generated/${key}.png`,
      approvedAt: '2026-07-08T00:00:00.000Z',
      sourceRun: 'test',
      variantIndex: 0,
      anchor: null,
      sensorScore: '8/8',
      judgeScore: '2',
    };
  }
  return buildGeneratedSpriteRegistry({ version: 1, entries } as Parameters<
    typeof buildGeneratedSpriteRegistry
  >[0]);
}

describe('Floor 2 family bosses — real bridge render (generated art at LARGE scale)', () => {
  it('renders each spawned boss with its OWN generated brief art at scale 1.0', () => {
    const { world, bosses, presentCount } = bootFloor2Bosses(1234, 4);

    // Sanity: the real spawn path produced bosses, each with an appearance key
    // (proves spawnFamilyBoss's setEnemyAppearanceKey ran) resolving to a brief.
    expect(bosses.length).toBe(presentCount);
    expect(bosses.length).toBeGreaterThan(0);
    expect(bosses.every((b) => b.appearanceKey !== undefined)).toBe(true);
    expect(bosses.every((b) => b.briefId !== undefined)).toBe(true);

    const registry = registryForBosses(bosses);
    const { scene, images } = createSceneStub({ kenneyLoaded: true });
    // Inject the generated-sprite registry the bridge reads (mirrors BootScene).
    (scene.game as unknown) = { registry: { get: () => registry } };

    const bridge = createPhaserBridge(scene);
    bridge.sync(world, 0);
    bridge.sync(world, 500);

    const expectedKeys = new Set(bosses.map((b) => `${b.briefId}-var-0`));
    const renderedKeys = new Set((images as MockImage[]).map((img) => img.textureKey));

    // Each boss's OWN generated art must be on screen — a boss falling back to
    // the shared goblin pin or a rat/procedural key would make its distinct key
    // absent here.
    for (const key of expectedKeys) {
      expect(renderedKeys.has(key)).toBe(true);
    }

    // NOTE: this stub reports no native texture size, so the renderer's
    // feet-based footprint fit is unmeasurable here and the legacy
    // `generated.scale` multiplier applies — which is what keeps the base scale
    // exactly 1.0 below. The authored-footprint behavior with real canvas sizes
    // is covered by `tests/unit/mob-render-footprint.test.ts`.
    // Every boss must render at the LARGE boss base scale of 1.0. Enemies carry
    // a deterministic cosmetic sizeScale jitter in [0.9, 1.1]
    // (initializeEnemyAppearance), so the rendered scaleX = baseScale × sizeScale.
    // Asserting scaleX ≈ sizeScale[eid] proves baseScale === 1.0 EXACTLY (a
    // broken wiring to enemy_rat would render at baseScale 0.4 → scaleX in
    // [0.36, 0.44], never ≈ its own sizeScale ≥ 0.9). Deterministic and precise.
    for (const boss of bosses) {
      const key = `${boss.briefId}-var-0`;
      const img = (images as MockImage[]).find((candidate) => candidate.textureKey === key);
      expect(img, `no rendered image for boss brief ${key}`).toBeDefined();
      const sizeScale = world.stores.sprite.sizeScale[boss.eid];
      expect(sizeScale, `boss ${boss.briefId} missing sizeScale`).toBeDefined();
      expect(img!.scaleX).toBeCloseTo(sizeScale!, 6);
      expect(img!.scaleY).toBeCloseTo(sizeScale!, 6);
      // Human-readable band guard: unambiguously the LARGE boss (base 1.0),
      // never the tiny enemy_rat fallback (base 0.4 → scaleX ≤ 0.44).
      expect(img!.scaleX).toBeGreaterThan(0.5);
    }

    // None of the boss art keys collide with a Kenney/procedural placeholder.
    for (const key of expectedKeys) {
      expect(key.startsWith('__cw_')).toBe(false);
      expect(key).not.toBe('enemy.boss');
      expect(key.startsWith('rat-')).toBe(false);
    }
  });
});
