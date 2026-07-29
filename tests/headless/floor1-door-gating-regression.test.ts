import { describe, expect, it } from 'vitest';
import { createGameWorld } from '../../src/core/world.js';
import { spawnPlayer } from '../../src/core/index.js';
import { generatedEquipmentRunKeyFromSeed } from '../../src/shared/generated-equipment-types.js';
import { initializeFloor1Scenario } from '../../src/game/floorScenario.js';

/**
 * Regression guard for the prefab welcome-room door REWRITE (parent-session
 * pushback: "safe-room sealing / boss-door gating reading `room.doors` is the
 * highest-risk downstream consumer of the door rewrite — cover it with a
 * regression test, not manual reasoning").
 *
 * The welcome room is Floor 1's SAFE room, and carving it authoritatively
 * rewrites `RoomData.doors`. Several gating consumers iterate a room's `doors`
 * to create locked `DoorState` entities pinned to each door TILE:
 *   - the boss-stair room (unlocks after all three gating quests complete),
 *   - the slime-rat boss room (unlocks when the quest is accepted).
 * If the door rewrite (or the seed-21 lock-aware connector repair, which tunnels
 * through wall rock near the carved room) ever moved, dropped, or orphaned a
 * gated door — or landed the carved welcome-room doors on non-DOOR tiles — a lock
 * would sit on a tile the tile-map does not treat as a door, silently breaking
 * gating while every reachability assertion still passes.
 *
 * This runs the REAL production init path (createGameWorld → spawnPlayer →
 * initializeFloor1Scenario), not a lab, over a fixed deterministic panel. Seed 21
 * is the pinned connector-repair seed; seed 8 is the boss lock-in seed. No
 * cherry-picking (rule #12) — a failure here is a real gating bug.
 *
 * The safe room's own door-tile integrity (every door is a real DOOR tile on the
 * perimeter ring) is asserted by check #0b of the reachability gate
 * (`checkFloor1SetPieceReachability`); the runtime forced-close seal itself is
 * unit-covered by `tests/ecs/door-system-safe-room.test.ts`. This test closes the
 * remaining gap: the gated rooms' locks stay consistent on real carved floors.
 */
const SEED_PANEL = [1, 8, 21, 42, 100, 2024] as const;

function initFloor1(seed: number) {
  const world = createGameWorld({
    seed,
    generatedEquipmentRunKey: generatedEquipmentRunKeyFromSeed(seed),
  });
  const playerEid = spawnPlayer(world, 0, 0);
  initializeFloor1Scenario(world, playerEid);
  return world;
}

describe('Floor 1 door gating survives the prefab welcome-room door rewrite', () => {
  for (const seed of SEED_PANEL) {
    it(`seed ${seed}: boss + slime-rat locks land on real door tiles and gate intact`, () => {
      const world = initFloor1(seed);
      const floorMap = world.floorMap;
      const scenario = world.floorScenario;
      expect(floorMap, `seed ${seed}: floor map missing after init`).toBeTruthy();
      expect(scenario, `seed ${seed}: floor scenario missing after init`).toBeTruthy();
      if (!floorMap || !scenario) return;

      const staircaseEids = scenario.bossRoomDoorEids.get('staircase') ?? [];
      const slimeRatEids = scenario.bossRoomDoorEids.get('slime-rat') ?? [];

      // 1. Both gated rooms produced at least one locked door entity — the door
      //    rewrite did not leave a gated room door-less (which would ungate it).
      expect(
        staircaseEids.length,
        `seed ${seed}: boss-stair room has no gate doors`,
      ).toBeGreaterThanOrEqual(1);
      expect(
        slimeRatEids.length,
        `seed ${seed}: slime-rat room has no gate doors`,
      ).toBeGreaterThanOrEqual(1);

      // 2. The staircase gate created exactly one lock per boss-stair-room door.
      //    A mismatch means the rewrite/repair added or dropped a door the gate
      //    relies on (the boss-stair room is NOT carved, so this must be stable).
      const bossStairDoors = floorMap.bossStairRoom?.doors ?? [];
      expect(
        bossStairDoors.length,
        `seed ${seed}: boss-stair room has no doors`,
      ).toBeGreaterThanOrEqual(1);
      expect(
        staircaseEids.length,
        `seed ${seed}: staircase lock count ${staircaseEids.length} != boss-stair door count ${bossStairDoors.length}`,
      ).toBe(bossStairDoors.length);

      // 3. Every gated door entity is LOCKED at floor start AND pinned to a real
      //    DOOR tile. This is the orphan guard: a lock on a non-door tile means
      //    the door rewrite desynced the gating from the tile-map.
      for (const eid of [...staircaseEids, ...slimeRatEids]) {
        const tx = world.stores.doorState.tileX[eid] ?? -1;
        const ty = world.stores.doorState.tileY[eid] ?? -1;
        expect(
          world.stores.doorState.isLocked[eid],
          `seed ${seed}: gate door (${tx},${ty}) not locked at floor start`,
        ).toBe(1);
        expect(
          floorMap.tileMap.isDoor(tx, ty),
          `seed ${seed}: gate lock at (${tx},${ty}) is not on a DOOR tile (rewrite orphaned it)`,
        ).toBe(true);
      }
    });
  }
});
