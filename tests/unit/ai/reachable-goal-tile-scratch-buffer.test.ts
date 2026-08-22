/**
 * Regression coverage for the scratch-buffer reuse in
 * {@link BehaviorTreeAI}'s reachable-goal-tile BFS.
 *
 * `computeReachableGoalTile` and `resolveNpcInteractionAnchor` used to
 * allocate two fresh full-floor `Int32Array`s (`dist`/`queue`) on every
 * single call. They now reuse instance-level scratch buffers instead
 * (mirroring the pre-existing `computeExploreReachabilityDepth` pattern),
 * to remove that per-call allocation churn from the hottest AI-navigation
 * path (see the 2026-08 perf-optimizer handoff).
 *
 * This is only gameplay-neutral if the shared buffer never escapes the
 * call that fills it — every return path hands back a plain `{x, y}`
 * value, never a reference into `dist`/`queue` — and if the `-1` reset at
 * the top of every call is preserved (dropping it would leave stale BFS
 * depths from a *different* start tile in the buffer). The tests below use
 * a small hand-built map (via `makeOpenFloorMap`, split by an impassable
 * wall column) so the "correct" answer is known ahead of time, and prove:
 *
 *   1. the buffer really is reused (same object identity across calls
 *      with different start tiles) — the actual perf claim;
 *   2. a call that overwrites the shared buffer does not retroactively
 *      corrupt a result already returned by an earlier call, and every
 *      call still produces the *correct* answer, not just a mutually
 *      consistent one (a broken invalidation can make every call agree
 *      on a wrong answer) — the correctness claim; and
 *   3. two independent `BehaviorTreeAI` instances (each with their own
 *      unshared buffers) agree with each other and with the oracle.
 */

import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../../src/game/ai/bt-ai-provider.js';
import type { TilePoint } from '../../../src/core/map/pathfinding.js';
import type { FloorMap } from '../../../src/core/map/FloorMap.js';
import { makeOpenFloorMap } from '../../helpers/map-fixtures.js';
import { TilePresets } from '../../../src/shared/map-types.js';

/** Typed view onto the private BFS internals so the test can drive them directly. */
type ReachableGoalInternals = {
  computeReachableGoalTile(
    floorMap: FloorMap,
    startTile: TilePoint,
    goalTile: TilePoint,
    maxRadius?: number,
  ): TilePoint;
  goalReachabilityDepth: Int32Array | null;
};

/** Typed view onto the sibling NPC-anchor BFS internals (same scratch pattern). */
type NpcAnchorInternals = {
  resolveNpcInteractionAnchor(
    world: { floorMap: FloorMap },
    playerX: number,
    playerY: number,
    npcX: number,
    npcY: number,
    npcEid: number,
  ): { x: number; y: number };
  npcAnchorReachabilityDepth: Int32Array | null;
};

function newAi(seed: number): ReachableGoalInternals {
  return new BehaviorTreeAI({ seed }) as unknown as ReachableGoalInternals;
}

function newNpcAnchorAi(seed: number): NpcAnchorInternals {
  return new BehaviorTreeAI({ seed }) as unknown as NpcAnchorInternals;
}

// `makeOpenFloorMap` is a 24x16 all-passable-floor map with an optional full
// wall column at `wallColumnX`. A wall at x=12 splits it into a west side
// (x < 12) and an east side (x > 12), each fully open internally.
const WALL_X = 12;
const START_WEST: TilePoint = { x: 2, y: 5 };
const START_WEST_2: TilePoint = { x: 4, y: 8 };
// Directly reachable from either west start: same open region, straight line.
const GOAL_WEST_OPEN: TilePoint = { x: 9, y: 5 };
// Impassable (inside the wall column) and unreachable from the west side
// within a small search radius — the ring search must fall back to the
// nearest *passable* west-side tile, never to the wall tile itself.
const GOAL_ON_WALL: TilePoint = { x: WALL_X, y: 5 };

describe('BehaviorTreeAI.computeReachableGoalTile — scratch-buffer reuse', () => {
  it('reuses the same backing array across calls with different start tiles (the perf claim)', () => {
    const floorMap = makeOpenFloorMap(WALL_X);
    const ai = newAi(7);

    ai.computeReachableGoalTile(floorMap, START_WEST, GOAL_WEST_OPEN);
    const bufAfterFirstCall = ai.goalReachabilityDepth;
    expect(bufAfterFirstCall).not.toBeNull();

    ai.computeReachableGoalTile(floorMap, START_WEST_2, GOAL_WEST_OPEN);
    const bufAfterSecondCall = ai.goalReachabilityDepth;

    // Same floor -> same tile count -> the buffer must be the *same object*,
    // not a fresh allocation. If this ever fails, the allocation-churn fix
    // has regressed (a new array is being allocated again on every call).
    expect(bufAfterSecondCall).toBe(bufAfterFirstCall);
  });

  it('returns the correct directly-reachable goal unchanged (BFS actually expanded)', () => {
    const floorMap = makeOpenFloorMap(WALL_X);
    const ai = newAi(7);

    // GOAL_WEST_OPEN sits on an open straight line from START_WEST, so a
    // correct BFS finds it directly reachable (depth >= 1) and the
    // `pathLengthTo(goal) > 1` early-return returns it unchanged. If the `-1`
    // sentinel reset were dropped, a reused (non-fresh) buffer would read
    // every cell as "already visited" and BFS would never expand past the
    // start tile, silently breaking this exact branch.
    const result = ai.computeReachableGoalTile(floorMap, START_WEST, GOAL_WEST_OPEN);
    expect(result).toEqual(GOAL_WEST_OPEN);
  });

  it('resolves an unreachable/impassable goal to a real nearby passable tile, never the wall tile itself', () => {
    const floorMap = makeOpenFloorMap(WALL_X);
    const ai = newAi(7);

    const result = ai.computeReachableGoalTile(floorMap, START_WEST, GOAL_ON_WALL);

    // The wall tile itself is impassable, so a correct resolve must never
    // return it verbatim (that only happens via the `bestGoal ?? goalTile`
    // fallback, i.e. when the ring search found nothing reachable at all —
    // which would indicate the BFS silently failed to expand).
    expect(result).not.toEqual(GOAL_ON_WALL);
    // The map is only split at x=12; every ring candidate the search can
    // pick must therefore stay strictly west of the wall.
    expect(result.x).toBeLessThan(WALL_X);
  });

  it("does not let a later call corrupt an earlier call's already-returned result", () => {
    const floorMap = makeOpenFloorMap(WALL_X);
    const ai = newAi(7);

    const resultA = ai.computeReachableGoalTile(floorMap, START_WEST, GOAL_WEST_OPEN);
    expect(resultA).toEqual(GOAL_WEST_OPEN);
    // Snapshot the plain values before the shared buffer gets overwritten.
    const resultASnapshot: TilePoint = { x: resultA.x, y: resultA.y };

    // This call reuses (and overwrites) the same instance-level scratch
    // buffer that produced `resultA`, from a different start tile — a
    // different BFS flood with different depths written into the buffer.
    const resultB = ai.computeReachableGoalTile(floorMap, START_WEST_2, GOAL_ON_WALL);
    expect(resultB.x).toBeLessThan(WALL_X);

    // `resultA` must be unaffected: it was returned as a plain object, never
    // a view/reference into the scratch buffer.
    expect(resultA).toEqual(resultASnapshot);

    // And recomputing the exact same query afresh must reproduce the correct
    // answer — the shared buffer having just been used for an unrelated
    // flood (from a different start, against a different/unreachable goal)
    // must not leave stale state that changes this independent computation.
    const resultAAgain = ai.computeReachableGoalTile(floorMap, START_WEST, GOAL_WEST_OPEN);
    expect(resultAAgain).toEqual(GOAL_WEST_OPEN);
  });

  it('matches a freshly-constructed AI instance with its own unshared buffers (no cross-instance aliasing)', () => {
    const floorMap = makeOpenFloorMap(WALL_X);

    const sharedAi = newAi(11);
    // Warm the shared instance's buffer with unrelated traffic first.
    sharedAi.computeReachableGoalTile(floorMap, START_WEST_2, GOAL_ON_WALL);

    const isolatedAi = newAi(11);

    const sharedResult = sharedAi.computeReachableGoalTile(floorMap, START_WEST, GOAL_WEST_OPEN);
    const isolatedResult = isolatedAi.computeReachableGoalTile(
      floorMap,
      START_WEST,
      GOAL_WEST_OPEN,
    );

    expect(sharedResult).toEqual(isolatedResult);
    // And both must actually be correct, not just mutually consistent.
    expect(sharedResult).toEqual(GOAL_WEST_OPEN);
  });
});

describe('BehaviorTreeAI.resolveNpcInteractionAnchor — scratch-buffer reuse', () => {
  it('reuses the same backing array across different NPCs (the perf claim)', () => {
    const floorMap = makeOpenFloorMap(WALL_X);
    const ai = newNpcAnchorAi(7);
    const world = { floorMap };
    // Two different npcEids so the per-NPC anchor cache cannot short-circuit
    // either call before it reaches the BFS.
    const npcAX = 9 * 4 + 2; // world-space x for tile x=9 (4ft tiles, DEFAULT_MAP_CONFIG)
    const npcAY = 5 * 4 + 2;
    const npcBX = 10 * 4 + 2;
    const npcBY = 6 * 4 + 2;
    const farPlayerX = 2 * 4 + 2;
    const farPlayerY = 5 * 4 + 2;

    ai.resolveNpcInteractionAnchor(world, farPlayerX, farPlayerY, npcAX, npcAY, 1001);
    const bufAfterFirstCall = ai.npcAnchorReachabilityDepth;
    expect(bufAfterFirstCall).not.toBeNull();

    ai.resolveNpcInteractionAnchor(world, farPlayerX, farPlayerY, npcBX, npcBY, 1002);
    const bufAfterSecondCall = ai.npcAnchorReachabilityDepth;

    expect(bufAfterSecondCall).toBe(bufAfterFirstCall);
  });

  it('does not corrupt an earlier NPC anchor result when resolving a later one', () => {
    const floorMap = makeOpenFloorMap(WALL_X);
    // Carve a solitary impassable tile at NPC A's own position (distinct from
    // the WALL_X column) so the closest-reachable-tile search cannot legally
    // return NPC A's raw position -- it must resolve to a different, real,
    // passable, west-side tile. This is the correctness oracle: a stale
    // (un-reset) scratch buffer from a prior call can make the BFS report
    // "nothing reachable" and fall back to the raw (impassable!) NPC tile,
    // which the assertion below would catch.
    const npcATile = { x: 9, y: 5 };
    floorMap.tileMap.setFlags(npcATile.x, npcATile.y, TilePresets.WALL);
    const ai = newNpcAnchorAi(7);
    const world = { floorMap };
    const npcAX = npcATile.x * 4 + 2;
    const npcAY = npcATile.y * 4 + 2;
    const npcBX = 10 * 4 + 2;
    const npcBY = 6 * 4 + 2;
    const farPlayerX = 2 * 4 + 2;
    const farPlayerY = 5 * 4 + 2;

    const anchorA = ai.resolveNpcInteractionAnchor(
      world,
      farPlayerX,
      farPlayerY,
      npcAX,
      npcAY,
      2001,
    );
    // NPC A's own tile is impassable, so a correct anchor must be a
    // different, real, passable, west-side tile -- never the wall tile
    // itself and never the (unreachable) raw NPC position.
    expect(anchorA).not.toEqual({ x: npcAX, y: npcAY });
    const anchorTile = floorMap.worldToTile(anchorA.x, anchorA.y);
    expect(floorMap.tileMap.isPassable(anchorTile.x, anchorTile.y)).toBe(true);
    expect(anchorTile.x).toBeLessThan(WALL_X);
    const anchorASnapshot = { x: anchorA.x, y: anchorA.y };

    ai.resolveNpcInteractionAnchor(world, farPlayerX, farPlayerY, npcBX, npcBY, 2002);

    expect(anchorA).toEqual(anchorASnapshot);
  });
});
