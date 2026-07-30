import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/spawners/combatants.js';
import { SeededRandom } from '../../src/shared/random.js';
import { BiomeType, RoomRole } from '../../src/shared/map-types.js';
import type { MapConfig } from '../../src/shared/map-types.js';
import { CaveSystemGenerator } from '../../src/core/map/generators/cave-system.js';
import { initializeFloor2Scenario } from '../../src/game/floor2Scenario.js';
import { safeRoomSystem, isInSafeContext } from '../../src/core/safe-space.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { generateEquipmentInstance } from '../../src/game/generated-equipment-generator.js';
import { addGeneratedEquipmentReference } from '../../src/shared/inventory.js';
import { getEquipmentState } from '../../src/core/systems/equipmentSystem.js';
import { runSettlementMaintenancePlanner } from '../../src/game/ai/settlement-maintenance-planner.js';

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

/**
 * Regression coverage for a concern raised (and confirmed false, but worth
 * permanently guarding) in code review of the settlement-maintenance planner:
 * that a real Floor 2 settlement room — generated with `RoomRole.SETTLEMENT`,
 * not `RoomRole.SAFE` — would never satisfy `isInSafeContext`, silently
 * disabling the planner's equip/purchase capability in live play.
 *
 * `initializeFloor2Scenario` -> `initializeFloor2Settlement` ->
 * `prepareSettlementMapAndPlacement` retags the settlement room(s) to
 * `RoomRole.SAFE` as part of real Floor 2 boot (see `floor2Settlement.ts`),
 * which happens well before the player can ever physically reach the room.
 * This test exercises the REAL scenario-boot path (not the unit-test
 * fixture's hardcoded `world.playerInSafeRoom = true` shortcut) to prove the
 * planner's equipment loop is actually reachable in live/headless play.
 */
describe('settlement-maintenance-planner: real Floor 2 safe-context integration', () => {
  it('retags the settlement room SAFE during real scenario boot, so standing in it satisfies isInSafeContext', () => {
    const seed = 4444;
    const gen = new CaveSystemGenerator({ presentCount: 3 });
    const floorMap = gen.generate(smallCaveConfig(seed), new SeededRandom(seed));
    const world = createTestWorld({ seed, floor: 2 });
    world.floorMap = floorMap;
    const playerEid = spawnPlayer(world, 400, 400);

    initializeFloor2Scenario(world, playerEid);
    // initializeFloor2Scenario generates its OWN floor map internally and
    // overwrites world.floorMap — always re-read it rather than reusing the
    // pre-call `floorMap` reference above.
    const realFloorMap = world.floorMap!;

    const settlement = world.floorExtendedState?.settlement;
    expect(settlement).toBeDefined();
    const settlementRoomId = settlement!.settlementRoomIds[0]!;
    const room = realFloorMap.roomGraph.get(settlementRoomId)!;
    expect(room.role).toBe(RoomRole.SAFE);

    const interior = room.interiorCells?.[0] ?? { x: room.bounds.x + 1, y: room.bounds.y + 1 };
    const worldPos = realFloorMap.tileToWorld(interior.x, interior.y);
    world.stores.position.x[playerEid] = worldPos.x;
    world.stores.position.y[playerEid] = worldPos.y;
    world.state = 'playing';

    safeRoomSystem(world);
    expect(world.playerInSafeRoom).toBe(true);
    expect(isInSafeContext(world)).toBe(true);
  });

  it('actually equips a bag candidate through the real pipeline (real map, real safeRoomSystem, real settlement boot)', () => {
    const seed = 4444;
    const gen = new CaveSystemGenerator({ presentCount: 3 });
    const floorMap = gen.generate(smallCaveConfig(seed), new SeededRandom(seed));
    const world = createTestWorld({ seed, floor: 2 });
    world.floorMap = floorMap;
    const playerEid = spawnPlayer(world, 400, 400);
    world.playerLevel.level = 5;

    initializeFloor2Scenario(world, playerEid);
    const realFloorMap = world.floorMap!;
    const settlement = world.floorExtendedState?.settlement;
    expect(settlement).toBeDefined();
    const settlementRoomId = settlement!.settlementRoomIds[0]!;
    const room = realFloorMap.roomGraph.get(settlementRoomId)!;
    const interior = room.interiorCells?.[0] ?? { x: room.bounds.x + 1, y: room.bounds.y + 1 };
    const worldPos = realFloorMap.tileToWorld(interior.x, interior.y);
    world.stores.position.x[playerEid] = worldPos.x;
    world.stores.position.y[playerEid] = worldPos.y;
    world.state = 'playing';

    // `initializeFloor2Scenario` sets registry/catalog/rewards/economy flags
    // but NOT `floor2EquipmentAiMaintenance` (the AI purchasing/equipping flag,
    // gated on its own dependency closure including UX/world). Enable it here
    // so this integration test can exercise the equipment loop directly.
    world.floor2EquipmentFlags.floor2EquipmentAiMaintenance = true;

    const instance = generateEquipmentInstance(world, {
      baseId: 'iron-breastplate',
      itemLevel: world.playerLevel.level,
      rarity: 'common',
      enhancementLevel: 0,
    });
    const bag = world.inventories.get(playerEid);
    if (!bag) throw new Error('Test requires a player bag');
    addGeneratedEquipmentReference(bag, instance.instanceId);

    // Real per-frame ordering: safeRoomSystem runs before the planner, exactly
    // as headless-runner.ts sequences it (safeRoomSystem happens inside
    // runSimulationStep, which precedes the runSettlementMaintenancePlanner
    // call in the frame loop).
    safeRoomSystem(world);
    const result = runSettlementMaintenancePlanner(world);

    expect(result.ran).toBe(true);
    const equipDecision = result.decisions.find((d) => d.kind === 'equip-instance');
    expect(equipDecision).toBeDefined();
    const equipped = getEquipmentState(world, playerEid)?.equipped;
    expect(Object.values(equipped ?? {})).toContain(instance.instanceId);
  });
});
