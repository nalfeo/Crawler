import { addComponent, addEntity, hasComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Invincible, Npc, Position, Sprite } from '../../src/core/components.js';
import { applyDamage, DEFAULT_DAMAGE_OPTIONS } from '../../src/core/apply-damage.js';
import { spawnNpc, spawnPlayer, spawnEnemy } from '../../src/core/helpers.js';
import { npcSystem } from '../../src/core/systems/npcSystem.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { NPC_INTERACT_RANGE_FT } from '../../src/shared/npc-types.js';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { TilePresets, DEFAULT_MAP_CONFIG, TerrainType } from '../../src/shared/map-types.js';

/** Open 20x15 floor so a single WALL tile is the only thing that can block LOS. */
function createWalledFloorMap(): FloorMap {
  const config = { ...DEFAULT_MAP_CONFIG, widthTiles: 20, heightTiles: 15 };
  const tileMap = new TileMap(20, 15);
  tileMap.fill(TilePresets.FLOOR);
  const terrain = new Uint8Array(20 * 15);
  terrain.fill(TerrainType.STONE_FLOOR);
  const roomGraph = new RoomGraph();
  roomGraph.add({ x: 2, y: 2, width: 8, height: 6 });
  return new FloorMap(config, tileMap, roomGraph, terrain, { x: 5, y: 5 });
}

describe('spawnNpc', () => {
  it('creates an entity with Npc, Invincible, Position, and Sprite components', () => {
    const world = createTestWorld();
    const eid = spawnNpc(world, 100, 200, 'tutorial-goon');

    expect(eid).toBeGreaterThanOrEqual(0);
    expect(hasComponent(world.ecs, eid, Npc)).toBe(true);
    expect(hasComponent(world.ecs, eid, Invincible)).toBe(true);
    expect(hasComponent(world.ecs, eid, Position)).toBe(true);
    expect(hasComponent(world.ecs, eid, Sprite)).toBe(true);
  });

  it('stores position correctly', () => {
    const world = createTestWorld();
    const eid = spawnNpc(world, 50, 75, 'tutorial-goon');

    expect(world.stores.position.x[eid]).toBe(50);
    expect(world.stores.position.y[eid]).toBe(75);
  });

  it('registers an NpcInstance in world.npcs with correct defId and initial quest state', () => {
    const world = createTestWorld();
    const eid = spawnNpc(world, 0, 0, 'tutorial-goon');

    const instance = world.npcs.get(eid);
    expect(instance).toBeDefined();
    expect(instance?.defId).toBe('tutorial-goon');
    expect(instance?.dialogueIndex).toBe(0);
    expect(instance?.nearbyPlayer).toBe(false);
    expect(instance?.quests).toHaveLength(1);
    expect(instance?.quests[0]?.questId).toBe('floor1-tutorial');
    expect(instance?.quests[0]?.status).toBe('available');
  });

  it('returns -1 for an unknown defId', () => {
    const world = createTestWorld();
    const eid = spawnNpc(world, 0, 0, 'nonexistent-npc');
    expect(eid).toBe(-1);
    expect(world.npcs.size).toBe(0);
  });
});

describe('Invincible component — applyDamage guard', () => {
  it('applyDamage deals no damage to an Invincible entity', () => {
    const world = createTestWorld();
    const eid = spawnNpc(world, 0, 0, 'tutorial-goon');

    // Manually set health store values to confirm they are not reduced
    world.stores.health.current[eid] = 50;
    world.stores.health.max[eid] = 50;

    const dealt = applyDamage(world, eid, 30, 0, 0, DEFAULT_DAMAGE_OPTIONS);
    expect(dealt).toBe(0);
    expect(world.stores.health.current[eid]).toBe(50);
  });

  it('applyDamage deals damage normally to non-Invincible entities', () => {
    const world = createTestWorld();
    const eid = spawnEnemy(world, 0, 0, 50);

    const dealt = applyDamage(world, eid, 20, 0, 0, DEFAULT_DAMAGE_OPTIONS);
    expect(dealt).toBe(20);
    expect(world.stores.health.current[eid]).toBe(30);
  });

  it('emits no combat event for an Invincible entity', () => {
    const world = createTestWorld();
    const eid = spawnNpc(world, 0, 0, 'tutorial-goon');
    world.stores.health.current[eid] = 50;

    applyDamage(world, eid, 10, 0, 0, DEFAULT_DAMAGE_OPTIONS);
    expect(world.combatEvents).toHaveLength(0);
  });
});

describe('npcSystem', () => {
  it('marks nearbyPlayer true when player is within interact range', () => {
    const world = createTestWorld();
    const npcEid = spawnNpc(world, 200, 200, 'tutorial-goon');
    spawnPlayer(world, 200, 200 + NPC_INTERACT_RANGE_FT - 1);

    npcSystem(world);

    expect(world.npcs.get(npcEid)?.nearbyPlayer).toBe(true);
  });

  it('marks nearbyPlayer false when player is beyond interact range', () => {
    const world = createTestWorld();
    const npcEid = spawnNpc(world, 200, 200, 'tutorial-goon');
    spawnPlayer(world, 200, 200 + NPC_INTERACT_RANGE_FT + 10);

    npcSystem(world);

    expect(world.npcs.get(npcEid)?.nearbyPlayer).toBe(false);
  });

  it('does not mark nearbyPlayer when a wall sits between the player and the NPC', () => {
    const world = createTestWorld();
    world.floorMap = createWalledFloorMap();
    // Tile (4,5) and tile (7,5) are 12 ft apart centre-to-centre... but the
    // interact range is 10 ft, so put them 8 ft apart across the wall at (6,5).
    const npcEid = spawnNpc(world, 5 * 4 + 2, 5 * 4 + 2, 'tutorial-goon');
    spawnPlayer(world, 7 * 4 + 2, 5 * 4 + 2);
    world.floorMap.tileMap.setFlags(6, 5, TilePresets.WALL);

    npcSystem(world);

    // 8 ft apart, well inside NPC_INTERACT_RANGE_FT, but blocked.
    expect(NPC_INTERACT_RANGE_FT).toBeGreaterThan(8);
    expect(world.npcs.get(npcEid)?.nearbyPlayer).toBe(false);
  });

  it('marks nearbyPlayer once the blocking wall is gone', () => {
    const world = createTestWorld();
    world.floorMap = createWalledFloorMap();
    const npcEid = spawnNpc(world, 5 * 4 + 2, 5 * 4 + 2, 'tutorial-goon');
    spawnPlayer(world, 7 * 4 + 2, 5 * 4 + 2);

    npcSystem(world);

    expect(world.npcs.get(npcEid)?.nearbyPlayer).toBe(true);
  });

  it('marks nearbyPlayer false when no player exists', () => {
    const world = createTestWorld();
    const npcEid = spawnNpc(world, 200, 200, 'tutorial-goon');

    // Force nearbyPlayer to true to confirm it gets cleared
    const instance = world.npcs.get(npcEid)!;
    instance.nearbyPlayer = true;

    npcSystem(world);

    expect(instance.nearbyPlayer).toBe(false);
  });

  it('handles multiple NPCs independently', () => {
    const world = createTestWorld();
    const npc1 = spawnNpc(world, 100, 100, 'tutorial-goon');
    const npc2 = spawnNpc(world, 400, 400, 'tutorial-goon');
    spawnPlayer(world, 100, 100); // close to npc1, far from npc2

    npcSystem(world);

    expect(world.npcs.get(npc1)?.nearbyPlayer).toBe(true);
    expect(world.npcs.get(npc2)?.nearbyPlayer).toBe(false);
  });

  it('does not error when an NPC has no instance in world.npcs', () => {
    const world = createTestWorld();
    // Manually add Npc + Position without going through spawnNpc
    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, Npc);
    addComponent(world.ecs, eid, Position);
    spawnPlayer(world, 0, 0);

    // Should not throw
    expect(() => npcSystem(world)).not.toThrow();
  });
});
