import { describe, expect, it } from 'vitest';
import { roomHopDistances, type HopNode } from '../../src/game/room-hops.js';

function graph(edges: Record<number, number[]>): Map<number, HopNode> {
  const g = new Map<number, HopNode>();
  for (const [id, neighbors] of Object.entries(edges)) g.set(Number(id), { neighbors });
  return g;
}

describe('roomHopDistances', () => {
  it('measures hop distance along a chain', () => {
    const g = graph({ 0: [1], 1: [0, 2], 2: [1, 3], 3: [2] });
    expect([...roomHopDistances(g, 0)]).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
  });

  it('excludes a gated room and rooms only reachable through it', () => {
    // 0-1-2, and 3 only reachable via 2; exclude 2 → 3 unreachable.
    const g = graph({ 0: [1], 1: [0, 2], 2: [1, 3], 3: [2] });
    const hops = roomHopDistances(g, 0, 2);
    expect(hops.get(1)).toBe(1);
    expect(hops.has(2)).toBe(false);
    expect(hops.has(3)).toBe(false);
  });

  it('returns empty for unknown/undefined start', () => {
    const g = graph({ 0: [1], 1: [0] });
    expect(roomHopDistances(g, undefined).size).toBe(0);
    expect(roomHopDistances(g, 99).size).toBe(0);
  });

  it('picks the shortest of multiple paths', () => {
    const g = graph({ 0: [1, 2], 1: [0, 3], 2: [0, 3], 3: [1, 2] });
    expect(roomHopDistances(g, 0).get(3)).toBe(2);
  });

  it('tolerates dangling neighbor references (neighbor id not in graph)', () => {
    // Room 1 lists room 99 as a neighbor, but 99 is not in the graph.
    // The BFS should not throw and should report rooms 0 and 1 reachable.
    const g = graph({ 0: [1], 1: [0, 99] });
    const hops = roomHopDistances(g, 0);
    expect(hops.get(0)).toBe(0);
    expect(hops.get(1)).toBe(1);
    // 99 is added to hops by the BFS but has no out-edges (roomGraph.get returns
    // undefined → the !room guard fires and we continue without further enqueueing)
    expect(hops.get(99)).toBe(2);
  });
});
