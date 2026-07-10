import { addComponent, addEntity, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { doorSystem } from '../../src/core/systems/doorSystem.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { DoorState } from '../../src/core/components.js';
import { setDoorLockConfig, setGoalFlag } from '../../src/core/door-lock.js';
import { makeMapWithSafeRoomDoor, makeMapWithDoor } from '../helpers/map-fixtures.js';
import { createTestWorld } from '../helpers/world-factory.js';

/**
 * Regression: the shared safe-room / boss-stair door permanent-seal bug.
 *
 * On Floor 1 the map generator can place the boss-stair room adjacent to the
 * safe room so they share ONE connector door entity. That door has two
 * independent authorities acting on it the same frame:
 *
 *   1. the boss-gate UNLOCK (edge-triggered — needs `wasLocked` to fire), and
 *   2. the safe-room FORCE-CLOSE (level-triggered — seals the tile every frame
 *      the player rests inside the safe room away from the doorway).
 *
 * Pre-fix, the force-close reconcile CLOBBERED the door's open latch to 0 the
 * same frame the unlock edge set it to 1. Because the unlock edge only re-fires
 * on a locked→unlocked transition, the latch could never be re-set: the door
 * became a permanent unlocked-but-closed WALL, the floor boss never spawned,
 * and the run timed out (seeds 64 / 80).
 *
 * The structural fix decouples the two authorities: the open LATCH
 * (`logicalOpen`) is written only by lock/unlock, while the physical tile is
 * driven by a per-frame DERIVED `effectiveOpen = logicalOpen && !isLocked &&
 * !isForcedClosed`. A transient safe-room seal closes the TILE only; the latch
 * survives, so the door reopens the moment the seal lifts.
 *
 * The primary assertions below use the STABLE tile-passability API so they fail
 * on the pre-fix source and pass after the fix regardless of the field rename.
 */
describe('shared safe-room / boss-stair door', () => {
  const DOOR_TILE = { x: 3, y: 3 } as const;
  const TILE_FT = 32;
  const centreFt = (tile: number) => tile * TILE_FT + TILE_FT / 2;

  it('reopens after an unlock that lands while the safe-room seal is active', () => {
    const world = createTestWorld({ seed: 42 });
    world.floorMap = makeMapWithSafeRoomDoor();
    // Player rests at tile (2,2): inside the SAFE room, manhattan 2 from the
    // door at (3,3) — far enough that the safe-room force-close targets it.
    const player = spawnPlayer(world, centreFt(2), centreFt(2));

    // The shared door is BOTH the safe-room connector AND the locked boss gate.
    const door = addEntity(world.ecs);
    addComponent(
      world.ecs,
      door,
      set(DoorState, { tileX: DOOR_TILE.x, tileY: DOOR_TILE.y, logicalOpen: 0, isLocked: 1 }),
    );
    setDoorLockConfig(world, door, {
      unlock: { operator: 'all', conditions: [{ type: 'goal', goalId: 'boss.gate' }] },
    });

    // Locked + sealed: the tile is closed while the player rests inside.
    doorSystem(world);
    expect(world.stores.doorState.isLocked[door]).toBe(1);
    expect(world.floorMap!.tileMap.isPassable(DOOR_TILE.x, DOOR_TILE.y)).toBe(false);

    // The unlock condition is met WHILE the player is still resting away from
    // the door, so the unlock edge and the safe-room force-close collide on the
    // same frame — this is the exact race that sealed the door pre-fix.
    setGoalFlag(world, 'boss.gate', true);
    doorSystem(world);
    expect(world.stores.doorState.isLocked[door]).toBe(0); // unlocked…
    // …but the tile stays closed THIS frame because the player is still inside.
    expect(world.floorMap!.tileMap.isPassable(DOOR_TILE.x, DOOR_TILE.y)).toBe(false);
    // The decoupling in action: the unlock edge SET the open latch this frame…
    expect(world.stores.doorState.logicalOpen[door]).toBe(1);
    // …yet effectiveOpen (and the tile) stays 0 because the safe-room seal holds.
    expect(world.stores.doorState.effectiveOpen[door]).toBe(0);

    // The seal persists across frames while the player keeps resting.
    doorSystem(world);
    doorSystem(world);

    // The player walks to the doorway to cross into the boss room (seal lifts).
    world.stores.position.x[player] = centreFt(DOOR_TILE.x);
    world.stores.position.y[player] = centreFt(2); // tile (3,2), manhattan 1 from the door
    doorSystem(world);

    // FIX: the preserved latch lets the door reopen once the seal lifts.
    // Pre-fix this is FALSE (the clobbered latch left a permanent wall).
    expect(world.stores.doorState.isLocked[door]).toBe(0);
    expect(world.floorMap!.tileMap.isPassable(DOOR_TILE.x, DOOR_TILE.y)).toBe(true);
    // The latch was preserved through the entire seal; effectiveOpen now recomputes true.
    expect(world.stores.doorState.logicalOpen[door]).toBe(1);
    expect(world.stores.doorState.effectiveOpen[door]).toBe(1);
  });

  it('control: a non-shared boss door unlocks and stays open when far from the player', () => {
    const world = createTestWorld({ seed: 42 });
    // makeMapWithDoor has NO safe room, so the force-close never runs — this is
    // the byte-identical baseline the shared-door fix must not regress.
    world.floorMap = makeMapWithDoor();
    spawnPlayer(world, 0, 0);

    const door = addEntity(world.ecs);
    addComponent(
      world.ecs,
      door,
      set(DoorState, { tileX: 5, tileY: 5, logicalOpen: 0, isLocked: 1 }),
    );
    setDoorLockConfig(world, door, {
      unlock: { operator: 'all', conditions: [{ type: 'goal', goalId: 'boss.gate' }] },
    });

    doorSystem(world);
    expect(world.floorMap!.tileMap.isPassable(5, 5)).toBe(false);

    setGoalFlag(world, 'boss.gate', true);
    doorSystem(world);
    expect(world.stores.doorState.isLocked[door]).toBe(0);
    expect(world.floorMap!.tileMap.isPassable(5, 5)).toBe(true);

    // Player never approaches: an unlocked, unsealed boss door stays open.
    doorSystem(world);
    doorSystem(world);
    expect(world.floorMap!.tileMap.isPassable(5, 5)).toBe(true);
  });
});
