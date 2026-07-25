/**
 * Floor 2 Environmental Content — unit tests for the three content buckets
 * added by the industrial-cave harvestables/lighting/props PR.
 *
 * Coverage:
 *  1. Harvestables — all three Floor 2 ore/gem defs are present at the
 *     expected indices (6–8), yield existing items, and spawnFloor2Harvestable
 *     nodes actually places entities on a real Floor 2 boot.
 *  2. Props — cave biome defs are registered, carry correct categories, and
 *     placePropsForFloor produces placements with biomeTag 'cave'.
 *  3. Ambient lighting — light-emitting defs (wall-lantern-cave,
 *     glowing-crystal-shard, gem-cluster) have valid lightEmission fields.
 *  4. No Floor 1 regression — Floor 1 harvestable def indices 0–5 are stable.
 */

import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Harvestable, Position, Prop } from '../../src/core/components.js';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import { spawnPlayer } from '../../src/core/spawners/combatants.js';
import {
  DECORATION_DEFS,
  DECORATION_INDEX_TO_ID,
  getDecorationDef,
} from '../../src/shared/decorationDefs.js';
import {
  FLOOR2_HARVESTABLE_START_INDEX,
  FLOOR2_HARVESTABLE_END_INDEX,
  HARVESTABLE_DEFS,
  getHarvestableDef,
  getHarvestableDefByIndex,
} from '../../src/shared/harvestableDefs.js';
import { BiomeType, RoomRole, TerrainType, TilePresets } from '../../src/shared/map-types.js';
import { SeededRandom } from '../../src/shared/random.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { initializeFloor2Scenario } from '../../src/game/floor2Scenario.js';
import { initializeFloor1Scenario } from '../../src/game/floorScenario.js';
import { placePropsForFloor } from '../../src/game/systems/propPlacer.js';

// ─── Harvestable defs ────────────────────────────────────────────────────────

describe('Floor 2 harvestable defs', () => {
  it('registers iron-vein at index 6', () => {
    const def = getHarvestableDefByIndex(6);
    expect(def).toBeDefined();
    expect(def!.id).toBe('iron-vein');
    expect(def!.itemId).toBe('iron-ore');
  });

  it('registers copper-seam at index 7', () => {
    const def = getHarvestableDefByIndex(7);
    expect(def).toBeDefined();
    expect(def!.id).toBe('copper-seam');
    expect(def!.itemId).toBe('copper-ore');
  });

  it('registers gem-cluster at index 8', () => {
    const def = getHarvestableDefByIndex(8);
    expect(def).toBeDefined();
    expect(def!.id).toBe('gem-cluster');
    expect(def!.itemId).toBe('void-crystal');
  });

  it('gem-cluster has a lightEmission field (glow)', () => {
    const def = getHarvestableDefByIndex(8)!;
    expect(def.lightEmission).toBeDefined();
    expect(def.lightEmission!.radiusFt).toBeGreaterThan(0);
    expect(def.lightEmission!.intensity).toBeGreaterThan(0);
    expect(def.lightEmission!.intensity).toBeLessThanOrEqual(1);
  });

  it('HARVESTABLE_DEFS has exactly 9 entries (6 Floor-1 + 3 Floor-2)', () => {
    expect(HARVESTABLE_DEFS.length).toBe(9);
  });

  it('getHarvestableDef can look up floor-2 nodes by id', () => {
    expect(getHarvestableDef('iron-vein')?.id).toBe('iron-vein');
    expect(getHarvestableDef('copper-seam')?.id).toBe('copper-seam');
    expect(getHarvestableDef('gem-cluster')?.id).toBe('gem-cluster');
  });
});

// ─── Floor 1 regression guard ────────────────────────────────────────────────

describe('Floor 1 harvestable def index stability', () => {
  const FLOOR1_EXPECTED = [
    { index: 0, id: 'crimson-mushroom', itemId: 'crimson-mushroom' },
    { index: 1, id: 'azure-mushroom', itemId: 'azure-mushroom' },
    { index: 2, id: 'sunpetal-flower', itemId: 'sunpetal-flower' },
    { index: 3, id: 'moonbloom-flower', itemId: 'moonbloom-flower' },
    { index: 4, id: 'frost-lichen', itemId: 'frost-lichen' },
    { index: 5, id: 'shadow-lichen', itemId: 'shadow-lichen' },
  ] as const;

  for (const { index, id, itemId } of FLOOR1_EXPECTED) {
    it(`index ${index} is still '${id}'`, () => {
      const def = getHarvestableDefByIndex(index);
      expect(def?.id).toBe(id);
      expect(def?.itemId).toBe(itemId);
    });
  }

  it('FLOOR2_HARVESTABLE_START_INDEX is 6 (first Floor-2 def)', () => {
    expect(FLOOR2_HARVESTABLE_START_INDEX).toBe(6);
    // Confirm that index 5 (last floor-1 def) and index 6 (first floor-2 def)
    // are on the correct side of the boundary.
    expect(getHarvestableDefByIndex(5)?.id).toBe('shadow-lichen');
    expect(getHarvestableDefByIndex(6)?.id).toBe('iron-vein');
  });

  it('FLOOR2_HARVESTABLE_END_INDEX is 9 (exclusive upper bound for Floor-2 defs)', () => {
    expect(FLOOR2_HARVESTABLE_END_INDEX).toBe(9);
    // Confirm the last Floor-2 def is index 8 (gem-cluster).
    expect(getHarvestableDefByIndex(8)?.id).toBe('gem-cluster');
    // Confirm nothing exists at the end index itself (no Floor-3 defs yet).
    expect(getHarvestableDefByIndex(9)).toBeUndefined();
  });

  it('Floor 1 scenario does not spawn Floor-2 harvestable nodes', () => {
    const world = createTestWorld({ seed: 42, floor: 1 });
    const playerEid = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, playerEid);

    const nodes = query(world.ecs, [Harvestable, Position]);
    const floor2Nodes = nodes.filter(
      (eid) => (world.stores.harvestable.defIndex[eid] ?? -1) >= FLOOR2_HARVESTABLE_START_INDEX,
    );
    expect(floor2Nodes).toHaveLength(0);
  });

  it('Floor 2 scenario does not spawn hypothetical Floor-3 harvestable nodes', () => {
    // Even if a Floor-3 def were appended after index 8, the Floor-2 spawner
    // is bounded by FLOOR2_HARVESTABLE_END_INDEX and must never include it.
    // Verify the current registry slice is exactly [6, 9).
    const floor2DefIds = HARVESTABLE_DEFS.slice(
      FLOOR2_HARVESTABLE_START_INDEX,
      FLOOR2_HARVESTABLE_END_INDEX,
    ).map((d) => d.id);
    expect(floor2DefIds).toEqual(['iron-vein', 'copper-seam', 'gem-cluster']);
  });
});

// ─── Cave decoration defs ─────────────────────────────────────────────────────

describe('Cave decoration defs', () => {
  const CAVE_DEFS = [
    'mining-cart',
    'support-beam',
    'cave-rubble',
    'pipe-section',
    'wall-lantern-cave',
    'glowing-crystal-shard',
  ] as const;

  it('all cave defs are registered in DECORATION_DEFS', () => {
    for (const id of CAVE_DEFS) {
      expect(DECORATION_DEFS.has(id)).toBe(true);
    }
  });

  it('all cave defs carry biomeTag "cave"', () => {
    for (const id of CAVE_DEFS) {
      expect(getDecorationDef(id)?.biomeTag).toBe('cave');
    }
  });

  it('mining-cart is category structural with room-only placement', () => {
    const def = getDecorationDef('mining-cart')!;
    expect(def.category).toBe('structural');
    expect(def.placementZone).toBe('room-only');
  });

  it('cave-rubble is category rubbish', () => {
    expect(getDecorationDef('cave-rubble')?.category).toBe('rubbish');
  });

  it('wall-lantern-cave is category light-source with lightEmission', () => {
    const def = getDecorationDef('wall-lantern-cave')!;
    expect(def.category).toBe('light-source');
    expect(def.lightEmission).toBeDefined();
    expect(def.lightEmission!.radiusFt).toBeGreaterThan(0);
    expect(def.lightEmission!.intensity).toBeGreaterThan(0);
    expect(def.lightEmission!.colorHex).toBeGreaterThan(0);
  });

  it('glowing-crystal-shard is category light-source with lightEmission', () => {
    const def = getDecorationDef('glowing-crystal-shard')!;
    expect(def.category).toBe('light-source');
    expect(def.lightEmission).toBeDefined();
    expect(def.lightEmission!.radiusFt).toBeGreaterThan(0);
    expect(def.lightEmission!.intensity).toBeGreaterThan(0);
    expect(def.lightEmission!.colorHex).toBeGreaterThan(0);
  });

  it('all cave defs have a positive weight', () => {
    for (const id of CAVE_DEFS) {
      const def = getDecorationDef(id)!;
      expect(def.weight ?? 100).toBeGreaterThan(0);
    }
  });
});

// ─── Cave prop placement ──────────────────────────────────────────────────────

/** Build a minimal cave-system floor map with CAVE_FLOOR tiles for the placer. */
function buildCaveFixtureFloorMap(): FloorMap {
  const width = 20;
  const height = 20;
  const tileMap = new TileMap(width, height);
  const terrain = new Uint8Array(width * height);
  tileMap.fill(TilePresets.WALL);
  terrain.fill(TerrainType.CAVE_WALL);

  // Carve a large STONE_FLOOR normal room (tiles 1–8 x 1–8)
  for (let ty = 1; ty <= 8; ty++) {
    for (let tx = 1; tx <= 8; tx++) {
      terrain[ty * width + tx] = TerrainType.STONE_FLOOR;
      tileMap.setFlags(tx, ty, TilePresets.FLOOR);
    }
  }
  // Carve a cave-floor patch (tiles 10–14 x 1–8)
  for (let ty = 1; ty <= 8; ty++) {
    for (let tx = 10; tx <= 14; tx++) {
      terrain[ty * width + tx] = TerrainType.CAVE_FLOOR;
      tileMap.setFlags(tx, ty, TilePresets.FLOOR);
    }
  }
  // Carve a corridor (tiles 1–14 x 10)
  for (let tx = 1; tx <= 14; tx++) {
    terrain[10 * width + tx] = TerrainType.CORRIDOR;
    tileMap.setFlags(tx, 10, TilePresets.FLOOR);
  }

  const rooms = new RoomGraph();
  rooms.add({ x: 1, y: 1, width: 8, height: 8 }, [], [], RoomRole.NORMAL);

  return new FloorMap(
    {
      widthTiles: width,
      heightTiles: height,
      tileSizeFt: 4,
      biome: BiomeType.CAVE_SYSTEM,
      seed: 99,
      roomWidthRange: [8, 8],
      roomHeightRange: [8, 8],
      maxRooms: 1,
      floorDensity: 0.5,
    },
    tileMap,
    rooms,
    terrain,
    { x: 4, y: 4 },
  );
}

describe('placePropsForFloor with cave biome', () => {
  it('places at least one cave prop with high density', () => {
    const world = createTestWorld({ seed: 42 });
    const floorMap = buildCaveFixtureFloorMap();
    const placed = placePropsForFloor(
      world,
      floorMap,
      { biomeTag: 'cave', densityMultiplier: 2000 },
      new SeededRandom(42),
    );
    expect(placed.length).toBeGreaterThan(0);
  });

  it('places at least one light-source cave prop', () => {
    const world = createTestWorld({ seed: 42 });
    const floorMap = buildCaveFixtureFloorMap();
    placePropsForFloor(
      world,
      floorMap,
      {
        biomeTag: 'cave',
        densityMultiplier: 2000,
        allowedCategories: ['light-source'],
      },
      new SeededRandom(42),
    );
    expect(query(world.ecs, [Prop, Position]).length).toBeGreaterThan(0);
  });

  it('is deterministic across two identical runs', () => {
    const worldA = createTestWorld({ seed: 77 });
    const worldB = createTestWorld({ seed: 77 });
    const floorMap = buildCaveFixtureFloorMap();

    const rngA = new SeededRandom(77);
    const rngB = new SeededRandom(77);
    placePropsForFloor(worldA, floorMap, { biomeTag: 'cave', densityMultiplier: 500 }, rngA);
    placePropsForFloor(worldB, floorMap, { biomeTag: 'cave', densityMultiplier: 500 }, rngB);

    const countA = query(worldA.ecs, [Prop, Position]).length;
    const countB = query(worldB.ecs, [Prop, Position]).length;
    expect(countA).toBe(countB);
  });

  it('only places cave biome props and no dungeon props', () => {
    const world = createTestWorld({ seed: 42 });
    const floorMap = buildCaveFixtureFloorMap();
    placePropsForFloor(
      world,
      floorMap,
      { biomeTag: 'cave', densityMultiplier: 2000 },
      new SeededRandom(42),
    );
    // Verify every placed prop belongs to a cave-biome def. Reading defIdIndex
    // from the prop store and resolving via DECORATION_INDEX_TO_ID catches any
    // regression where non-cave defs slip through the biomeTag filter.
    const placedProps = Array.from(query(world.ecs, [Prop, Position]));
    expect(placedProps.length).toBeGreaterThan(0);
    for (const eid of placedProps) {
      const defIdx = world.stores.prop.defIdIndex[eid] ?? 0;
      const defId = DECORATION_INDEX_TO_ID[defIdx];
      const def = defId != null ? getDecorationDef(defId) : undefined;
      expect(def?.biomeTag).toBe('cave');
    }
  });
});

// ─── Floor 2 scenario: harvestable node spawning ─────────────────────────────

describe('initializeFloor2Scenario harvestable spawning', () => {
  it('spawns at least one Floor-2 harvestable node (iron-vein, copper-seam, or gem-cluster)', () => {
    const world = createTestWorld({ seed: 4444, floor: 2 });
    const playerEid = spawnPlayer(world, 0, 0);

    initializeFloor2Scenario(world, playerEid);

    const nodes = query(world.ecs, [Harvestable, Position]);
    expect(nodes.length).toBeGreaterThan(0);

    // At least one node should map to a Floor-2 def (index ≥ 6).
    const hasFloor2Node = nodes.some((eid) => {
      const idx = world.stores.harvestable.defIndex[eid] ?? -1;
      return idx >= 6;
    });
    expect(hasFloor2Node).toBe(true);
  });

  it('spawns all three Floor-2 harvestable def types', () => {
    const world = createTestWorld({ seed: 4444, floor: 2 });
    const playerEid = spawnPlayer(world, 0, 0);

    initializeFloor2Scenario(world, playerEid);

    const nodes = query(world.ecs, [Harvestable, Position]);
    const defIndices = new Set(nodes.map((eid) => world.stores.harvestable.defIndex[eid] ?? -1));

    // Should include all 3 floor-2 ore types (indices 6, 7, 8).
    expect(defIndices.has(6)).toBe(true); // iron-vein
    expect(defIndices.has(7)).toBe(true); // copper-seam
    expect(defIndices.has(8)).toBe(true); // gem-cluster
  });

  it('harvestable nodes are placed at distinct positions (no stacking)', () => {
    const world = createTestWorld({ seed: 4444, floor: 2 });
    const playerEid = spawnPlayer(world, 0, 0);
    initializeFloor2Scenario(world, playerEid);

    const nodes = query(world.ecs, [Harvestable, Position]);
    const positions = Array.from(nodes).map((eid) => ({
      x: world.stores.position.x[eid] ?? 0,
      y: world.stores.position.y[eid] ?? 0,
    }));

    // No two nodes of the same defIndex should be within 3 ft (spacing guard).
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const di = world.stores.harvestable.defIndex[nodes[i]!] ?? -1;
        const dj = world.stores.harvestable.defIndex[nodes[j]!] ?? -1;
        if (di !== dj) continue; // Only same-type pairs are guarded.
        const dx = (positions[i]?.x ?? 0) - (positions[j]?.x ?? 0);
        const dy = (positions[i]?.y ?? 0) - (positions[j]?.y ?? 0);
        expect(dx * dx + dy * dy).toBeGreaterThanOrEqual(9);
      }
    }
  });

  it('scenario is deterministic: same seed produces same harvestable count', () => {
    const worldA = createTestWorld({ seed: 555, floor: 2 });
    const worldB = createTestWorld({ seed: 555, floor: 2 });
    const pA = spawnPlayer(worldA, 0, 0);
    const pB = spawnPlayer(worldB, 0, 0);

    initializeFloor2Scenario(worldA, pA);
    initializeFloor2Scenario(worldB, pB);

    const countA = query(worldA.ecs, [Harvestable, Position]).length;
    const countB = query(worldB.ecs, [Harvestable, Position]).length;
    expect(countA).toBe(countB);
    expect(countA).toBeGreaterThan(0);
  });
});
