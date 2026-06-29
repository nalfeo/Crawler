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
});
