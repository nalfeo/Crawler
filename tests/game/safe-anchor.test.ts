import { describe, expect, it } from 'vitest';
import { RoomRole } from '../../src/shared/map-types.js';
import { resolveNearestSafeAnchor } from '../../src/core/safe-anchor.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { makeMapWithSafeRoom } from '../helpers/map-fixtures.js';

/**
 * `resolveNearestSafeAnchor` generalizes the Floor 2 settlement anchor to "the
 * nearest place the player could legitimately open the equipment panel".
 *
 * It exists because the AI's equip/claim actions are safe-context gated exactly
 * as a human's panels are (no `force` bypass), so without a routing goal on
 * Floor 1 — which has no settlement — the AI would carry chest loot unequipped
 * for an entire run and the win-rate would drop for a navigational reason
 * rather than a balance one.
 */
describe('resolveNearestSafeAnchor', () => {
  it('returns null when the floor has no map', () => {
    const world = createTestWorld({ seed: 3 });
    world.floorMap = null;
    expect(resolveNearestSafeAnchor(world, 0, 0)).toBeNull();
  });

  it('returns null when the floor has no safe room at all', () => {
    const world = createTestWorld({ seed: 3 });
    const map = makeMapWithSafeRoom();
    map.roomGraph.updateRoom(0, { role: RoomRole.NORMAL });
    world.floorMap = map;
    expect(resolveNearestSafeAnchor(world, 0, 0)).toBeNull();
  });

  it('anchors on the SAFE room when one exists', () => {
    const world = createTestWorld({ seed: 3 });
    const map = makeMapWithSafeRoom();
    world.floorMap = map;

    const anchor = resolveNearestSafeAnchor(world, 0, 0);
    expect(anchor).not.toBeNull();
    // Room bounds are tiles (1,1)–(4,4), so the anchor lands on its center tile.
    expect(anchor).toEqual(map.tileToWorld(2, 2));
  });

  it('picks the nearest of several safe rooms', () => {
    const world = createTestWorld({ seed: 3 });
    const map = makeMapWithSafeRoom();
    map.roomGraph.add({ x: 14, y: 14, width: 4, height: 4 }, [], [], RoomRole.SAFE);
    world.floorMap = map;

    const near = map.tileToWorld(15, 15);
    const anchor = resolveNearestSafeAnchor(world, near.x, near.y);
    expect(anchor).toEqual(map.tileToWorld(15, 15));

    const far = map.tileToWorld(2, 2);
    expect(resolveNearestSafeAnchor(world, far.x, far.y)).toEqual(map.tileToWorld(2, 2));
  });

  it('anchors on a cleared boss arena, which is safe without carrying the SAFE role', () => {
    // Issue #3275 item 5: retreating to equip should use the arena the player
    // just cleared next door, not walk back across the floor to the authored
    // safe room. The cleared room keeps its BOSS_STAIR role on purpose.
    const world = createTestWorld({ seed: 3 });
    const map = makeMapWithSafeRoom();
    const bossRoomId = map.roomGraph.add(
      { x: 14, y: 14, width: 4, height: 4 },
      [],
      [],
      RoomRole.BOSS_STAIR,
    );
    world.floorMap = map;

    const near = map.tileToWorld(15, 15);
    expect(resolveNearestSafeAnchor(world, near.x, near.y)).toEqual(map.tileToWorld(2, 2));

    world.clearedSafeRoomIds.add(bossRoomId);
    world.clearedSafeRoomMap = map;
    expect(resolveNearestSafeAnchor(world, near.x, near.y)).toEqual(map.tileToWorld(15, 15));
  });

  it('ignores cleared room ids recorded against a different floor', () => {
    const world = createTestWorld({ seed: 3 });
    const map = makeMapWithSafeRoom();
    const bossRoomId = map.roomGraph.add(
      { x: 14, y: 14, width: 4, height: 4 },
      [],
      [],
      RoomRole.BOSS_STAIR,
    );
    world.floorMap = map;
    world.clearedSafeRoomIds.add(bossRoomId);
    world.clearedSafeRoomMap = null;

    const near = map.tileToWorld(15, 15);
    expect(resolveNearestSafeAnchor(world, near.x, near.y)).toEqual(map.tileToWorld(2, 2));
  });

  it('is deterministic for equidistant safe rooms', () => {
    const world = createTestWorld({ seed: 3 });
    const map = makeMapWithSafeRoom();
    map.roomGraph.add({ x: 14, y: 1, width: 4, height: 4 }, [], [], RoomRole.SAFE);
    world.floorMap = map;

    // Midway between the two rooms on X, level with both on Y.
    const mid = map.tileToWorld(8, 2);
    const first = resolveNearestSafeAnchor(world, mid.x, mid.y);
    const second = resolveNearestSafeAnchor(world, mid.x, mid.y);
    expect(first).toEqual(second);
  });
});
