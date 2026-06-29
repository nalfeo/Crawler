/**
 * Pure room-graph breadth-first hop distances. The Floor 1 scenario inlines this
 * BFS twice (spawn→rooms excluding the locked boss-stair room, and welcome→rooms)
 * to constrain objective/shop placement. Extracted as a deterministic, testable
 * helper so placement rules can be reasoned about without spawning a world.
 */

/** Minimal room shape: an id plus its connected neighbor ids. */
export interface HopNode {
  readonly neighbors: readonly number[];
}

/** Minimal graph accessor: fetch a node (with its neighbors) by id. */
export interface HopGraph {
  get(id: number): HopNode | undefined;
}

/**
 * Breadth-first hop distance from `startId` to every reachable room. Optionally
 * treat `excludeId` as a wall (never enqueued), modelling rooms gated behind a
 * locked door. Returns a map of roomId → hop count (start = 0). Unreachable or
 * unknown start rooms yield an empty map.
 */
export function roomHopDistances(
  roomGraph: HopGraph,
  startId: number | undefined,
  excludeId?: number,
): Map<number, number> {
  const hops = new Map<number, number>();
  if (startId === undefined || roomGraph.get(startId) === undefined) return hops;
  const queue: number[] = [startId];
  let head = 0;
  hops.set(startId, 0);
  while (head < queue.length) {
    const currId = queue[head++]!;
    const currHop = hops.get(currId)!;
    const room = roomGraph.get(currId);
    if (!room) continue;
    for (const neighborId of room.neighbors) {
      if (hops.has(neighborId) || neighborId === excludeId) continue;
      hops.set(neighborId, currHop + 1);
      queue.push(neighborId);
    }
  }
  return hops;
}
