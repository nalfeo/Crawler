import { describe, expect, it } from 'vitest';
import {
  findNearestNearbyNpc,
  type NearbyNpcLike,
} from '../../src/engine/scenes/main-game-scene-helpers.js';

/**
 * Build the sparse position stores (indexed by entity id) the picker reads,
 * mirroring how {@link findNearestNearbyNpc} is called from the scene with
 * `world.stores.position.x/y`.
 */
function makeStores(entries: readonly { eid: number; x: number; y: number }[]): {
  positionX: number[];
  positionY: number[];
} {
  const positionX: number[] = [];
  const positionY: number[] = [];
  for (const { eid, x, y } of entries) {
    positionX[eid] = x;
    positionY[eid] = y;
  }
  return { positionX, positionY };
}

describe('MainGameScene NPC interaction priority', () => {
  it('chooses the nearest nearby NPC when several are in range', () => {
    const npcs = new Map<number, NearbyNpcLike>([
      [11, { nearbyPlayer: true }],
      [12, { nearbyPlayer: true }],
      [13, { nearbyPlayer: false }],
    ]);
    const { positionX, positionY } = makeStores([
      { eid: 11, x: 18, y: 10 },
      { eid: 12, x: 13, y: 10 },
      { eid: 13, x: 11, y: 10 },
    ]);

    const nearNpcEid = findNearestNearbyNpc(10, 10, npcs, positionX, positionY);

    // 13 is physically closest but not flagged nearby, so it is skipped and the
    // nearest *nearby* NPC (12) wins.
    expect(nearNpcEid).toBe(12);
  });

  it('returns -1 when no NPC has the nearbyPlayer flag set', () => {
    const npcs = new Map<number, NearbyNpcLike>([
      [11, { nearbyPlayer: false }],
      [12, { nearbyPlayer: false }],
    ]);
    const { positionX, positionY } = makeStores([
      { eid: 11, x: 12, y: 10 },
      { eid: 12, x: 10, y: 11 },
    ]);

    expect(findNearestNearbyNpc(10, 10, npcs, positionX, positionY)).toBe(-1);
  });

  it('returns -1 for an empty npc map', () => {
    expect(findNearestNearbyNpc(0, 0, new Map(), [], [])).toBe(-1);
  });
});
