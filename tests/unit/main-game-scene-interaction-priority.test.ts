import { describe, expect, it } from 'vitest';
import { findNearestNearbyNpc } from '../../src/engine/scenes/main-game-scene-helpers.js';

describe('MainGameScene NPC interaction priority', () => {
  it('chooses the nearest nearby NPC when several are in range', () => {
    const nearNpcEid = findNearestNearbyNpc(10, 10, [
      { eid: 11, x: 18, y: 10, nearbyPlayer: true },
      { eid: 12, x: 13, y: 10, nearbyPlayer: true },
      { eid: 13, x: 11, y: 10, nearbyPlayer: false },
    ]);

    expect(nearNpcEid).toBe(12);
  });
});
