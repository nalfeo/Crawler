import { describe, expect, it } from 'vitest';
import {
  estimateObjectiveTravelLeg,
  estimateObjectiveTravelMatrix,
  getObjectiveTravelEstimate,
  type Floor1ObjectiveNodeId,
  type ObjectiveTravelNode,
} from '../../src/game/ai/objective-travel-time.js';

const NODES: ObjectiveTravelNode<Floor1ObjectiveNodeId>[] = [
  { id: 'welcome-office', point: { x: 0, y: 0 } },
  { id: 'shopkeeper', point: { x: 3, y: 4 } },
  { id: 'stairs-exit', point: { x: 6, y: 8 } },
];

describe('objective travel time estimates', () => {
  it('falls back to straight-line travel only when no deterministic distance source is provided', () => {
    const leg = estimateObjectiveTravelLeg(NODES[0]!, NODES[1]!, { moveSpeedFtPerMs: 0.1 });

    expect(leg.source).toBe('straight-line');
    expect(leg.reachable).toBe(true);
    expect(leg.distanceFt).toBe(5);
    expect(leg.travelMs).toBe(50);
  });

  it('uses supplied deterministic path distance in the all-node matrix', () => {
    const matrix = estimateObjectiveTravelMatrix(NODES, {
      moveSpeedFtPerMs: 0.2,
      estimateDistanceFt: (from, to) => ({
        distanceFt: from.id === to.id ? 0 : 40,
        source: 'deterministic-path',
      }),
    });

    const leg = getObjectiveTravelEstimate(matrix, 'welcome-office', 'stairs-exit');
    expect(leg).not.toBeNull();
    expect(leg!.source).toBe('deterministic-path');
    expect(leg!.distanceFt).toBe(40);
    expect(leg!.travelMs).toBe(200);
  });

  it('marks supplied no-path results unreachable instead of straight-line fallback', () => {
    const leg = estimateObjectiveTravelLeg(NODES[0]!, NODES[2]!, {
      moveSpeedFtPerMs: 0.1,
      estimateDistanceFt: () => null,
    });

    expect(leg.source).toBe('unreachable');
    expect(leg.reachable).toBe(false);
    expect(leg.distanceFt).toBe(Number.POSITIVE_INFINITY);
    expect(leg.travelMs).toBe(Number.POSITIVE_INFINITY);
  });

  it('rejects duplicate node ids so stale objective definitions fail loudly', () => {
    expect(() =>
      estimateObjectiveTravelMatrix([NODES[0]!, { id: 'welcome-office', point: { x: 1, y: 1 } }], {
        moveSpeedFtPerMs: 0.1,
      }),
    ).toThrow(/Duplicate objective travel node id/);
  });
});
