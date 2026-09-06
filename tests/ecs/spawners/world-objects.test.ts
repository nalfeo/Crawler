import { hasComponent, query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  Harvestable,
  Invincible,
  Npc,
  Owner,
  Position,
  Prop,
  PropLight,
  Size,
  Sprite,
  Team,
  Trap,
} from '../../../src/core/components.js';
import { SHAPE_BOX } from '../../../src/core/physics-defs.js';
import { getNpcDef } from '../../../src/shared/npc-types.js';
import {
  spawnHarvestableNode,
  spawnNpc,
  spawnProp,
  addSetPieceProp,
  spawnTrap,
} from '../../../src/core/spawners/world-objects.js';
import { FloorMap } from '../../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../../src/core/map/RoomGraph.js';
import { TileMap } from '../../../src/core/map/TileMap.js';
import { HARVESTABLE_DEFS } from '../../../src/shared/harvestableDefs.js';
import { BiomeType, RoomRole, TilePresets } from '../../../src/shared/map-types.js';
import { createTestWorld } from '../../helpers/world-factory.js';

describe('spawnTrap', () => {
  it('stores trap geometry with an arm delay, owner, and team', () => {
    const world = createTestWorld();
    const eid = spawnTrap(world, 5, 6, 40, 2, 5, 750, 9, 1);

    expect(hasComponent(world.ecs, eid, Trap)).toBe(true);
    expect(hasComponent(world.ecs, eid, Owner)).toBe(true);
    expect(hasComponent(world.ecs, eid, Team)).toBe(true);
    expect(world.stores.trap.triggerRadius[eid]).toBe(2);
    expect(world.stores.trap.explosionRadius[eid]).toBe(5);
    expect(world.stores.trap.explosionDamage[eid]).toBe(40);
    expect(world.stores.trap.armAtMs[eid]).toBe(world.elapsedMs + 750);
    expect(world.stores.owner.eid[eid]).toBe(9);
    expect(world.stores.team.id[eid]).toBe(1);
    expect(world.stores.sprite.width[eid]).toBe(1.5);
  });
});

describe('spawnNpc', () => {
  it('creates a non-hostile, invincible NPC and registers an instance', () => {
    const world = createTestWorld();
    const eid = spawnNpc(world, 50, 75, 'tutorial-goon');

    expect(eid).toBeGreaterThanOrEqual(0);
    expect(hasComponent(world.ecs, eid, Npc)).toBe(true);
    expect(hasComponent(world.ecs, eid, Invincible)).toBe(true);
    expect(hasComponent(world.ecs, eid, Position)).toBe(true);
    expect(hasComponent(world.ecs, eid, Sprite)).toBe(true);
    expect(world.stores.position.x[eid]).toBe(50);
    expect(world.npcs.get(eid)?.defId).toBe('tutorial-goon');
  });

  it('returns -1 for an unknown defId', () => {
    const world = createTestWorld();
    expect(spawnNpc(world, 0, 0, 'does-not-exist')).toBe(-1);
  });

  it('returns -1 for an unknown defId even when options are malformed', () => {
    const world = createTestWorld();
    expect(spawnNpc(world, 0, 0, 'does-not-exist', { widthFt: 4 })).toBe(-1);
  });

  it('attaches a per-axis BOX Size matching def.widthFt/heightFt (Slice-1 legacy parity)', () => {
    // NPC defs are non-square (e.g. 2.5×3.5). The legacy pre-Size collision
    // path read `sprite.width/2 × sprite.height/2` — a per-axis box. A
    // CIRCLE `r = max(w,h)/2` would silently widen the horizontal footprint
    // by ~40%. This test locks in the BOX shape so a future refactor cannot
    // regress it without noise.
    const world = createTestWorld();
    const eid = spawnNpc(world, 0, 0, 'tutorial-goon');
    const def = getNpcDef('tutorial-goon');
    expect(def).toBeDefined();
    expect(hasComponent(world.ecs, eid, Size)).toBe(true);
    expect(world.stores.size.shape[eid]).toBe(SHAPE_BOX);
    expect(world.stores.size.radius[eid]).toBe(0);
    expect(world.stores.size.halfWidth[eid]).toBeCloseTo((def?.widthFt ?? 0) * 0.5);
    expect(world.stores.size.halfHeight[eid]).toBeCloseTo((def?.heightFt ?? 0) * 0.5);
  });

  it('throws when only one NPC size override axis is supplied', () => {
    const world = createTestWorld();
    expect(() => spawnNpc(world, 0, 0, 'tutorial-goon', { widthFt: 4 })).toThrow(
      /widthFt and heightFt/,
    );
  });

  it('applies paired size + visual overrides onto sprite, size, and npc instance metadata', () => {
    const world = createTestWorld();
    const eid = spawnNpc(world, 10, 20, 'tutorial-goon', {
      widthFt: 4,
      heightFt: 5,
      spriteOverride: { source: 'catalog', spriteId: 'sprite:npc.guide' },
      flipX: true,
      flipY: true,
      rotationDeg: 45,
      z: 6,
    });

    expect(world.stores.sprite.width[eid]).toBeCloseTo(4);
    expect(world.stores.sprite.height[eid]).toBeCloseTo(5);
    expect(world.stores.size.halfWidth[eid]).toBeCloseTo(2);
    expect(world.stores.size.halfHeight[eid]).toBeCloseTo(2.5);
    expect(world.npcs.get(eid)).toMatchObject({
      spriteOverride: { source: 'catalog', spriteId: 'sprite:npc.guide' },
      flipX: true,
      flipY: true,
      rotationDeg: 45,
      z: 6,
    });
  });
});

describe('spawnProp', () => {
  it('creates a prop without a light when the def has no lightEmission', () => {
    const world = createTestWorld();
    const eid = spawnProp(world, 1, 1, 'stone-pillar');

    expect(eid).toBeGreaterThanOrEqual(0);
    expect(hasComponent(world.ecs, eid, Prop)).toBe(true);
    expect(hasComponent(world.ecs, eid, PropLight)).toBe(false);
    expect(world.stores.prop.isDestructible[eid]).toBe(1);
    expect(world.stores.prop.isDestroyed[eid]).toBe(0);
    expect(world.stores.sprite.width[eid]).toBe(1.5);
  });

  it('adds a PropLight when the def emits light', () => {
    const world = createTestWorld();
    const eid = spawnProp(world, 0, 0, 'wall-sconce');

    expect(hasComponent(world.ecs, eid, PropLight)).toBe(true);
    expect(world.stores.propLight.radiusPx[eid]).toBeGreaterThan(0);
    expect(world.stores.propLight.intensity[eid]).toBeCloseTo(0.7);
  });

  it('adds a PropLight for torch props', () => {
    const world = createTestWorld();
    const eid = spawnProp(world, 0, 0, 'torch');

    expect(hasComponent(world.ecs, eid, PropLight)).toBe(true);
    expect(world.stores.propLight.intensity[eid]).toBeCloseTo(0.7);
  });

  it('returns -1 for an unknown defId', () => {
    const world = createTestWorld();
    expect(spawnProp(world, 0, 0, 'no-such-prop')).toBe(-1);
  });
});

describe('addSetPieceProp', () => {
  const RENDER = {
    widthFt: 16,
    heightFt: 8,
    depth: -19,
    sprite: { source: 'custom', requestId: 'welcome-room-rug', label: 'rug', prompt: 'a rug' },
  } as const;

  it('appends a render-only instance (x, y, render) to world.setPieceProps', () => {
    const world = createTestWorld();
    addSetPieceProp(world, 12, 34, RENDER);

    expect(world.setPieceProps).toHaveLength(1);
    expect(world.setPieceProps[0]).toEqual({ x: 12, y: 34, render: RENDER });
    expect(world.setPieceProps[0]?.render).toBe(RENDER);
  });

  it('creates NO ECS entity, so cosmetic dressing never consumes an entity id or perturbs the sim', () => {
    const world = createTestWorld();
    const propsBefore = query(world.ecs, [Prop]).length;
    const positionsBefore = query(world.ecs, [Position]).length;

    addSetPieceProp(world, 1, 2, RENDER);

    // No entity is created — the instance lives only on the render sidecar list,
    // so ambient mobs/drops keep their ids and the global RNG draw order is
    // unperturbed by cosmetic dressing.
    expect(query(world.ecs, [Prop]).length).toBe(propsBefore);
    expect(query(world.ecs, [Position]).length).toBe(positionsBefore);
  });

  it('preserves draw order across appended layers', () => {
    const world = createTestWorld();
    const rug = { ...RENDER, label: 'rug' } as const;
    const banner = { ...RENDER, depth: 5, label: 'banner' } as const;

    addSetPieceProp(world, 1, 1, rug);
    addSetPieceProp(world, 2, 2, banner);

    expect(world.setPieceProps.map((p) => p.render.label)).toEqual(['rug', 'banner']);
  });
});

describe('spawnHarvestableNode', () => {
  it('creates a static harvestable node mirroring its def duration', () => {
    const world = createTestWorld();
    const eid = spawnHarvestableNode(world, 8, 9, 0);

    expect(hasComponent(world.ecs, eid, Harvestable)).toBe(true);
    expect(world.stores.harvestable.defIndex[eid]).toBe(0);
    expect(world.stores.harvestable.durationMs[eid]).toBe(HARVESTABLE_DEFS[0]!.durationMs);
    expect(world.stores.harvestable.progressMs[eid]).toBe(0);
    expect(world.stores.harvestable.harvesterEid[eid]).toBe(0);
    expect(world.stores.sprite.width[eid]).toBe(1);
  });

  it('seeds a deterministic cosmetic variantRoll so multi-variant art is reachable', () => {
    const world = createTestWorld();
    const a = spawnHarvestableNode(world, 8, 9, 0);
    const b = spawnHarvestableNode(world, 3, 4, 0);
    const rollA = world.stores.sprite.variantRoll[a] ?? -1;
    const rollB = world.stores.sprite.variantRoll[b] ?? -1;

    // In range [0, 1) — a real roll, not the Float32Array 0 default that would
    // permanently pin every node to art variant index 0.
    expect(rollA).toBeGreaterThanOrEqual(0);
    expect(rollA).toBeLessThan(1);
    // Distinct entities/positions → distinct rolls (the roll is actually seeded).
    expect(rollA).not.toBe(rollB);

    // Deterministic: a fresh world with the same fixed seed reproduces the roll
    // (the seed is a local hash of world.seed+eid+context, never the shared RNG).
    const world2 = createTestWorld();
    const a2 = spawnHarvestableNode(world2, 8, 9, 0);
    expect(world2.stores.sprite.variantRoll[a2]).toBe(rollA);
  });

  it('throws on an unknown defIndex', () => {
    const world = createTestWorld();
    expect(() => spawnHarvestableNode(world, 0, 0, 9999)).toThrow(/unknown defIndex/);
  });

  it('rejects SPAWN/SAFE/SETTLEMENT regions when spawn-room safety is enabled and still spawns in ordinary rooms', () => {
    const world = createTestWorld({ floor: 2 });
    const tileMap = new TileMap(20, 8);
    tileMap.fill(TilePresets.FLOOR);
    const roomGraph = new RoomGraph();
    roomGraph.add({ x: 1, y: 1, width: 3, height: 3 }, [], [], RoomRole.SPAWN);
    roomGraph.add({ x: 5, y: 1, width: 3, height: 3 }, [], [], RoomRole.SAFE);
    roomGraph.add({ x: 9, y: 1, width: 3, height: 3 }, [], [], RoomRole.SETTLEMENT);
    roomGraph.add({ x: 13, y: 1, width: 3, height: 3 }, [], [], RoomRole.NORMAL);
    world.floorMap = new FloorMap(
      {
        widthTiles: 20,
        heightTiles: 8,
        tileSizeFt: 4,
        biome: BiomeType.DUNGEON,
        seed: 42,
        roomWidthRange: [3, 3],
        roomHeightRange: [3, 3],
        maxRooms: 4,
        floorDensity: 0.5,
      },
      tileMap,
      roomGraph,
      new Uint8Array(20 * 8),
      { x: 2, y: 2 },
    );

    const spawnPos = world.floorMap.tileToWorld(2, 2);
    const safePos = world.floorMap.tileToWorld(6, 2);
    const settlementPos = world.floorMap.tileToWorld(10, 2);
    const normalPos = world.floorMap.tileToWorld(14, 2);
    expect(spawnHarvestableNode(world, spawnPos.x, spawnPos.y, 0)).toBe(-1);
    expect(spawnHarvestableNode(world, safePos.x, safePos.y, 0)).toBe(-1);
    expect(spawnHarvestableNode(world, settlementPos.x, settlementPos.y, 0)).toBe(-1);
    expect(query(world.ecs, [Harvestable])).toHaveLength(0);

    const normalEid = spawnHarvestableNode(world, normalPos.x, normalPos.y, 0);
    expect(normalEid).toBeGreaterThanOrEqual(0);
    expect(query(world.ecs, [Harvestable])).toHaveLength(1);
  });

  it('allows SPAWN-room placement when the active floor does not treat spawn as safe space', () => {
    const world = createTestWorld({ floor: 1 });
    const tileMap = new TileMap(8, 8);
    tileMap.fill(TilePresets.FLOOR);
    const roomGraph = new RoomGraph();
    roomGraph.add({ x: 1, y: 1, width: 3, height: 3 }, [], [], RoomRole.SPAWN);
    world.floorMap = new FloorMap(
      {
        widthTiles: 8,
        heightTiles: 8,
        tileSizeFt: 4,
        biome: BiomeType.DUNGEON,
        seed: 7,
        roomWidthRange: [3, 3],
        roomHeightRange: [3, 3],
        maxRooms: 1,
        floorDensity: 0.5,
      },
      tileMap,
      roomGraph,
      new Uint8Array(8 * 8),
      { x: 2, y: 2 },
    );
    const spawnPos = world.floorMap.tileToWorld(2, 2);

    const eid = spawnHarvestableNode(world, spawnPos.x, spawnPos.y, 0);
    expect(eid).toBeGreaterThanOrEqual(0);
    expect(query(world.ecs, [Harvestable])).toHaveLength(1);
  });
});
