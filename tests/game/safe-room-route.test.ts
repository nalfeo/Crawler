/**
 * Pure unit + property tests for the safe-room route constraint reducer
 * (`safe-room-route.ts`). This module never touches ECS/Phaser/FloorMap —
 * everything here is exercised with hand-rolled deps (a tiny 1D "room + door
 * + corridor" fake world: tiles x<=5 are the origin safe room, x>=6 is
 * unclaimed exterior) so every test is fast, deterministic, and requires no
 * test-world bootstrap.
 *
 * Coverage mirrors the adversarial plan review ledger
 * (docs/knowledge/review-ledgers/2026-07-13-safe-room-route-constraints.review-ledger.json):
 * stable non-coordinate commitment identity, permutation-deterministic tie-
 * break, path-prefix/door-edge completion (never raw `playerInSafeRoom`
 * flicker), uniform behavior across every `AIState` (no intent-specific
 * branches), navEpoch-based cache invalidation (no per-poll A*), blocked-door
 * handling (ab-initio and mid-egress), moving-target commitment stability,
 * re-entry reseed, and "no teleport/through-wall" (movement targets always
 * come from the computed path, never fabricated).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  deriveCommitmentKey,
  pickCanonicalCommitment,
  createInitialSafeRoomRouteState,
  updateSafeRoomRouteState,
  toSafeRoomRouteDebugSnapshot,
  abortSafeRoomRoute,
  SAFE_ROOM_ROUTE_ARRIVE_FT,
  type SemanticCommitmentCandidate,
  type SafeRoomRouteDeps,
} from '../../src/game/ai/safe-room-route.js';
import { AIState } from '../../src/game/ai/types.js';
import { WAYPOINT_ARRIVE_FT } from '../../src/game/ai/bt-ai-tuning.js';
import type { TilePoint } from '../../src/core/map/pathfinding.js';

// --- Tiny fake world -------------------------------------------------------
// Tiles x in [0,5] => room 0 (the origin safe room). x >= 6 => unclaimed
// exterior (-1), matching RoomGraph.getRoomAt's real convention for
// door/unclaimed tiles (door/wall tiles are never part of any room's
// interior mask).
const ORIGIN_ROOM = 0;
const EXTERIOR_ROOM = -1;

function getRoomAt(tileX: number, _tileY: number): number {
  return tileX <= 5 ? ORIGIN_ROOM : EXTERIOR_ROOM;
}

function isSafeRoomId(roomId: number): boolean {
  return roomId === ORIGIN_ROOM;
}

/** World<->tile conversion at a given tile size (ft). Real gameplay maps use
 * 4ft tiles (see `tests/helpers/map-fixtures.ts` defaults); most tests below
 * use that same scale so `SAFE_ROOM_ROUTE_ARRIVE_FT` (1ft, mirrored from the
 * module under test) behaves exactly as it does in the real game — meaning
 * the monotonic segment-advance loop steps exactly one waypoint per poll
 * under normal incremental movement. One dedicated test intentionally uses a
 * 1ft tile size to exercise the loop's multi-waypoint-per-poll cascade path
 * (see "advances through multiple already-reached waypoints" below).
 */
function makeCoords(tileSizeFt: number): Pick<SafeRoomRouteDeps, 'worldToTile' | 'tileToWorld'> {
  return {
    worldToTile: (x: number, y: number): TilePoint => ({
      x: Math.round(x / tileSizeFt),
      y: Math.round(y / tileSizeFt),
    }),
    tileToWorld: (tx: number, ty: number): { x: number; y: number } => ({
      x: tx * tileSizeFt,
      y: ty * tileSizeFt,
    }),
  };
}

const REALISTIC_TILE_FT = 4;
const { worldToTile, tileToWorld } = makeCoords(REALISTIC_TILE_FT);

/** Straight-line path generator standing in for door-aware A* — inclusive of
 * both endpoints, matching `findTilePath`'s real contract (start- and goal-
 * inclusive). Only moves along x (every fixture test below uses y=0) so path
 * arrays are trivial to hand-verify. */
function straightLinePath(start: TilePoint, goal: TilePoint): TilePoint[] {
  if (start.y !== goal.y) return [];
  const path: TilePoint[] = [];
  const step = goal.x >= start.x ? 1 : -1;
  for (let x = start.x; x !== goal.x + step; x += step) {
    path.push({ x, y: start.y });
  }
  return path;
}

/** Wraps a findPath implementation with a call counter, so tests can assert
 * "no per-poll A*" (recompute only on a commitment or navEpoch change). */
function countingFindPath(impl: SafeRoomRouteDeps['findPath']): {
  findPath: SafeRoomRouteDeps['findPath'];
  callCount: () => number;
} {
  let calls = 0;
  return {
    findPath: (start, goal) => {
      calls += 1;
      return impl(start, goal);
    },
    callCount: () => calls,
  };
}

function makeDeps(overrides: Partial<SafeRoomRouteDeps> = {}): SafeRoomRouteDeps {
  return {
    worldToTile,
    tileToWorld,
    getRoomAt,
    isSafeRoomId,
    findPath: straightLinePath,
    ...overrides,
  };
}

function candidate(over: Partial<SemanticCommitmentCandidate> = {}): SemanticCommitmentCandidate {
  return {
    state: AIState.ENGAGE,
    targetEid: 42,
    targetX: 9 * REALISTIC_TILE_FT,
    targetY: 0,
    ...over,
  };
}

// Player spawns on tile (3,0) — three tiles inside the origin room, three
// tiles from the door at tile (6,0) — expressed in world ft at the realistic
// tile scale.
function input(over: Partial<Parameters<typeof updateSafeRoomRouteState>[1]> = {}) {
  return {
    playerX: 3 * REALISTIC_TILE_FT,
    playerY: 0,
    playerInSafeRoom: true,
    navEpoch: 1,
    candidate: candidate(),
    ...over,
  };
}

const initial = createInitialSafeRoomRouteState;

// The exit-buffer-truncated path every "happy path" activation from the
// default `input()`/`candidate()` above produces: door/exterior tiles start
// at x=6 (first tile outside the origin room), truncated one tile past it
// (the "hold through mouth" buffer) to x=7.
const EXPECTED_ACTIVATION_PATH: TilePoint[] = [
  { x: 3, y: 0 },
  { x: 4, y: 0 },
  { x: 5, y: 0 },
  { x: 6, y: 0 },
  { x: 7, y: 0 },
];

describe('safe-room-route: commitment identity (deriveCommitmentKey)', () => {
  it('is entity-based and ignores position when a target entity exists', () => {
    const a = candidate({ state: AIState.ENGAGE, targetEid: 7, targetX: 10, targetY: 0 });
    const b = candidate({ state: AIState.ENGAGE, targetEid: 7, targetX: 55, targetY: 20 });
    expect(deriveCommitmentKey(a)).toBe(deriveCommitmentKey(b));
  });

  it('changes when the target entity id changes', () => {
    const a = candidate({ targetEid: 7 });
    const b = candidate({ targetEid: 8 });
    expect(deriveCommitmentKey(a)).not.toBe(deriveCommitmentKey(b));
  });

  it('changes when the semantic state changes (same entity)', () => {
    const a = candidate({ state: AIState.ENGAGE, targetEid: 7 });
    const b = candidate({ state: AIState.RETREAT, targetEid: 7 });
    expect(deriveCommitmentKey(a)).not.toBe(deriveCommitmentKey(b));
  });

  it('quantizes fallback position identity to 0.5ft buckets, absorbing jitter', () => {
    const a = candidate({ state: AIState.EXPLORE, targetEid: null, targetX: 10.24, targetY: 0.1 });
    const b = candidate({ state: AIState.EXPLORE, targetEid: null, targetX: 10.01, targetY: -0.1 });
    expect(deriveCommitmentKey(a)).toBe(deriveCommitmentKey(b));
  });

  it('changes fallback position identity once the position genuinely moves', () => {
    const a = candidate({ state: AIState.EXPLORE, targetEid: null, targetX: 10, targetY: 0 });
    const b = candidate({ state: AIState.EXPLORE, targetEid: null, targetX: 11, targetY: 0 });
    expect(deriveCommitmentKey(a)).not.toBe(deriveCommitmentKey(b));
  });
});

describe('safe-room-route: canonical commitment tie-break (pickCanonicalCommitment)', () => {
  it('returns null for an empty candidate list', () => {
    expect(pickCanonicalCommitment([])).toBeNull();
  });

  it('prefers RETREAT over EXPLORE regardless of array order', () => {
    const retreat = candidate({ state: AIState.RETREAT, targetEid: 1 });
    const explore = candidate({ state: AIState.EXPLORE, targetEid: 2 });
    expect(pickCanonicalCommitment([explore, retreat])).toBe(retreat);
    expect(pickCanonicalCommitment([retreat, explore])).toBe(retreat);
  });

  const candidateArb: fc.Arbitrary<SemanticCommitmentCandidate> = fc.record({
    state: fc.constantFrom(
      AIState.EXPLORE,
      AIState.ENGAGE,
      AIState.RETREAT,
      AIState.COLLECT,
      AIState.INTERACT,
    ),
    targetEid: fc.option(fc.integer({ min: 0, max: 20 }), { nil: null }),
    targetX: fc.integer({ min: -20, max: 20 }),
    targetY: fc.integer({ min: -20, max: 20 }),
  });

  it('is permutation-invariant: the winning commitment key never depends on input order', () => {
    fc.assert(
      fc.property(
        fc
          .array(candidateArb, { minLength: 1, maxLength: 6 })
          .chain((arr) =>
            fc.tuple(
              fc.constant(arr),
              fc.shuffledSubarray(arr, { minLength: arr.length, maxLength: arr.length }),
            ),
          ),
        ([original, shuffled]) => {
          const a = pickCanonicalCommitment(original);
          const b = pickCanonicalCommitment(shuffled);
          expect(a).not.toBeNull();
          expect(b).not.toBeNull();
          expect(deriveCommitmentKey(a!)).toBe(deriveCommitmentKey(b!));
        },
      ),
    );
  });
});

describe('safe-room-route: initial state', () => {
  it('starts idle with zeroed counters and no path', () => {
    const state = initial();
    expect(state.phase).toBe('idle');
    expect(state.originRoomId).toBeNull();
    expect(state.commitmentKey).toBeNull();
    expect(state.path).toEqual([]);
    expect(state.segmentIndex).toBe(0);
    expect(state.lastReseedCause).toBeNull();
    expect(state.totalActivations).toBe(0);
    expect(state.totalCompletions).toBe(0);
    expect(state.totalBlocked).toBe(0);
    expect(state.totalReseeds).toBe(0);
  });
});

describe('safe-room-route: arrival radius stays in sync with moveToward', () => {
  it('SAFE_ROOM_ROUTE_ARRIVE_FT equals WAYPOINT_ARRIVE_FT', () => {
    // Route-segment completion must agree with moveToward's own waypoint-
    // arrival semantics (see the module doc on SAFE_ROOM_ROUTE_ARRIVE_FT).
    // This module intentionally does not import WAYPOINT_ARRIVE_FT to avoid
    // coupling to bt-ai-tuning.ts, so this test is the only thing that
    // catches the two literals drifting apart if either is ever retuned.
    expect(SAFE_ROOM_ROUTE_ARRIVE_FT).toBe(WAYPOINT_ARRIVE_FT);
  });
});

describe('safe-room-route: abortSafeRoomRoute (external interrupt release)', () => {
  it('releases to idle while preserving lifetime diagnostic counters', () => {
    const active = {
      ...initial(),
      phase: 'active' as const,
      originRoomId: 3,
      navEpoch: 1,
      commitmentKey: 'engage:eid:7',
      path: [{ x: 1, y: 1 }],
      segmentIndex: 0,
      lastReseedCause: 'activation' as const,
      totalActivations: 4,
      totalCompletions: 2,
      totalBlocked: 1,
      totalReseeds: 3,
    };
    const aborted = abortSafeRoomRoute(active);
    expect(aborted.phase).toBe('idle');
    expect(aborted.originRoomId).toBeNull();
    expect(aborted.navEpoch).toBeNull();
    expect(aborted.commitmentKey).toBeNull();
    expect(aborted.path).toEqual([]);
    expect(aborted.segmentIndex).toBe(0);
    // Lifetime counters are diagnostics-only and must survive an external
    // abort (e.g. a hostile-encounter invalidation) — only
    // createInitialSafeRoomRouteState() (true cold start) zeroes these.
    expect(aborted.totalActivations).toBe(4);
    expect(aborted.totalCompletions).toBe(2);
    expect(aborted.totalBlocked).toBe(1);
    expect(aborted.totalReseeds).toBe(3);
  });
});

describe('safe-room-route: idle pass-through (no constraint applied)', () => {
  it('stays idle and never calls findPath when the player is not in a safe room', () => {
    const { findPath, callCount } = countingFindPath(straightLinePath);
    const result = updateSafeRoomRouteState(
      initial(),
      input({ playerInSafeRoom: false }),
      makeDeps({ findPath }),
    );
    expect(result.state.phase).toBe('idle');
    expect(result.moveTarget).toBeNull();
    expect(result.blocked).toBe(false);
    expect(callCount()).toBe(0);
  });

  it('stays idle when there is no room-graph data for the player tile', () => {
    const { findPath, callCount } = countingFindPath(straightLinePath);
    const result = updateSafeRoomRouteState(
      initial(),
      input(),
      makeDeps({ getRoomAt: () => -1, findPath }),
    );
    expect(result.state.phase).toBe('idle');
    expect(callCount()).toBe(0);
  });

  it('stays idle when the origin room is not SAFE-flagged', () => {
    const { findPath, callCount } = countingFindPath(straightLinePath);
    const result = updateSafeRoomRouteState(
      initial(),
      input(),
      makeDeps({ isSafeRoomId: () => false, findPath }),
    );
    expect(result.state.phase).toBe('idle');
    expect(callCount()).toBe(0);
  });

  it('bypasses the route (same-safe-space) when the semantic target is inside the origin room', () => {
    const { findPath, callCount } = countingFindPath(straightLinePath);
    const result = updateSafeRoomRouteState(
      initial(),
      input({ candidate: candidate({ targetX: 4 * REALISTIC_TILE_FT, targetY: 0 }) }), // tile x=4, still <=5
      makeDeps({ findPath }),
    );
    expect(result.state.phase).toBe('idle');
    expect(result.moveTarget).toBeNull();
    expect(callCount()).toBe(0);
  });
});

describe('safe-room-route: activation + door-edge exit path', () => {
  it('activates and truncates the exit path to one tile past the doorway (hold through mouth)', () => {
    const { findPath, callCount } = countingFindPath(straightLinePath);
    const result = updateSafeRoomRouteState(initial(), input(), makeDeps({ findPath }));

    expect(result.state.phase).toBe('active');
    expect(result.state.originRoomId).toBe(ORIGIN_ROOM);
    expect(result.state.totalActivations).toBe(1);
    expect(result.state.lastReseedCause).toBe('activation');
    // Full straight-line path would be 7 tiles (x=3..9); truncated to the
    // door tile (x=6) plus one exit-buffer tile (x=7) => 5 tiles.
    expect(result.state.path).toEqual(EXPECTED_ACTIVATION_PATH);
    expect(result.state.path[result.state.path.length - 1]).toEqual({ x: 7, y: 0 });
    expect(result.state.segmentIndex).toBe(1);
    expect(result.moveTarget).toEqual({ x: 7 * REALISTIC_TILE_FT, y: 0 });
    expect(result.blocked).toBe(false);
    expect(callCount()).toBe(1);
  });

  it('handles an adjacent (single-tile) crossing when the player starts right at the doorway', () => {
    const { findPath } = countingFindPath(straightLinePath);
    const result = updateSafeRoomRouteState(
      initial(),
      input({
        playerX: 5 * REALISTIC_TILE_FT,
        playerY: 0,
        candidate: candidate({ targetEid: 1, targetX: 7 * REALISTIC_TILE_FT, targetY: 0 }),
      }),
      makeDeps({ findPath }),
    );
    expect(result.state.phase).toBe('active');
    // Full path (tiles 5..7) is only 3 tiles; the exit-buffer truncation
    // keeps all of it since the door (x=6) plus one buffer tile (x=7) is the
    // whole path already.
    expect(result.state.path).toEqual([
      { x: 5, y: 0 },
      { x: 6, y: 0 },
      { x: 7, y: 0 },
    ]);
    expect(result.state.segmentIndex).toBe(1);
    expect(result.moveTarget).toEqual({ x: 7 * REALISTIC_TILE_FT, y: 0 });
  });

  it('truncates the exit path to a short prefix regardless of how far the real (possibly moving) target is', () => {
    const { findPath } = countingFindPath(straightLinePath);
    const deps = makeDeps({ findPath });
    const near = updateSafeRoomRouteState(
      initial(),
      input({ candidate: candidate({ targetX: 9 * REALISTIC_TILE_FT }) }),
      deps,
    );
    const far = updateSafeRoomRouteState(
      initial(),
      input({ candidate: candidate({ targetX: 40 * REALISTIC_TILE_FT }) }),
      deps,
    );
    expect(near.state.path).toEqual(far.state.path);
    expect(far.state.path.length).toBeLessThan(40 - 3 + 1);
  });

  it('applies uniformly across every semantic AIState with no intent-specific branching', () => {
    const { findPath } = countingFindPath(straightLinePath);
    const deps = makeDeps({ findPath });
    const states = [
      AIState.EXPLORE,
      AIState.ENGAGE,
      AIState.RETREAT,
      AIState.COLLECT,
      AIState.INTERACT,
    ] as const;
    for (const state of states) {
      const result = updateSafeRoomRouteState(
        initial(),
        input({ candidate: candidate({ state, targetEid: 500 + state }) }),
        deps,
      );
      expect(result.state.phase).toBe('active');
      expect(result.state.path).toEqual(EXPECTED_ACTIVATION_PATH);
      expect(result.moveTarget).toEqual({ x: 7 * REALISTIC_TILE_FT, y: 0 });
    }
  });
});

describe('safe-room-route: steady-state segment advance (no reseed / no per-poll A*)', () => {
  it('advances exactly one segment per poll under realistic (4ft) tile spacing', () => {
    const { findPath, callCount } = countingFindPath(straightLinePath);
    const deps = makeDeps({ findPath });
    let result = updateSafeRoomRouteState(initial(), input(), deps);
    expect(result.state.segmentIndex).toBe(1); // waypoint tile x=4

    result = updateSafeRoomRouteState(
      result.state,
      input({ playerX: 4 * REALISTIC_TILE_FT }),
      deps,
    );
    expect(result.state.segmentIndex).toBe(2); // advanced to tile x=5
    expect(result.moveTarget).toEqual({ x: 7 * REALISTIC_TILE_FT, y: 0 });
    expect(callCount()).toBe(1); // steady-state advance never re-invokes findPath
  });

  it('does not reseed the route while the semantic target keeps moving, as long as the entity id is stable', () => {
    const { findPath, callCount } = countingFindPath(straightLinePath);
    const deps = makeDeps({ findPath });
    let result = updateSafeRoomRouteState(initial(), input(), deps);
    expect(result.state.phase).toBe('active');
    expect(callCount()).toBe(1);

    // Simulate several polls: the hunted enemy (eid 42) keeps moving, but the
    // route must not recompute because the commitment key (state+eid) is
    // unchanged. Player stays put — no movement system runs in this pure
    // test, mirroring the idiom used by provider-level tests.
    for (const [tx, ty] of [
      [38, 2],
      [50, -6],
      [28, 9],
    ] as const) {
      result = updateSafeRoomRouteState(
        result.state,
        input({ candidate: candidate({ targetX: tx, targetY: ty }) }),
        deps,
      );
      expect(result.state.phase).toBe('active');
    }
    expect(callCount()).toBe(1); // never recomputed
    expect(result.state.path).toEqual(EXPECTED_ACTIVATION_PATH);
  });

  it('advances through multiple already-reached waypoints in a single poll (fine-grained fixture)', () => {
    // Deliberately tile-size=1 so tile spacing equals SAFE_ROOM_ROUTE_ARRIVE_FT
    // (1ft), letting a single exact-aligned jump cascade the monotonic
    // segment index through several waypoints at once — exercising the
    // `while` loop's documented "fast player crossing multiple short
    // segments in one poll" behavior deterministically.
    const fine = makeCoords(1);
    const { findPath } = countingFindPath(straightLinePath);
    const deps: SafeRoomRouteDeps = {
      ...fine,
      getRoomAt,
      isSafeRoomId,
      findPath,
    };
    const fineInput = (over: Partial<ReturnType<typeof input>> = {}) => ({
      playerX: 3,
      playerY: 0,
      playerInSafeRoom: true,
      navEpoch: 1,
      candidate: candidate({ targetX: 9, targetY: 0 }),
      ...over,
    });

    let result = updateSafeRoomRouteState(initial(), fineInput(), deps);
    expect(result.state.phase).toBe('active');
    expect(result.state.segmentIndex).toBe(1); // waypoint tile x=4

    result = updateSafeRoomRouteState(result.state, fineInput({ playerX: 5 }), deps);
    expect(result.state.segmentIndex).toBe(4); // cascaded past tiles 4, 5, 6 in one poll
    expect(result.moveTarget).toEqual({ x: 7, y: 0 });
  });
});

describe('safe-room-route: completion (path-prefix/door-edge, not playerInSafeRoom flicker)', () => {
  it('completes and returns to idle once the player has walked the full exit path', () => {
    const { findPath, callCount } = countingFindPath(straightLinePath);
    const deps = makeDeps({ findPath });
    let result = updateSafeRoomRouteState(initial(), input(), deps);
    expect(result.state.phase).toBe('active');

    // Tiles 4,5,6,7 in world ft at the realistic (4ft) tile scale — walks the
    // player through every remaining waypoint one at a time.
    for (const x of [4, 5, 6, 7].map((tile) => tile * REALISTIC_TILE_FT)) {
      result = updateSafeRoomRouteState(result.state, input({ playerX: x }), deps);
    }
    expect(result.state.phase).toBe('idle');
    expect(result.state.totalCompletions).toBe(1);
    expect(result.moveTarget).toBeNull();
    expect(result.blocked).toBe(false);
    expect(callCount()).toBe(1); // completion never re-invokes findPath
  });

  it('reseeds a fresh activation on re-entry after a completed route', () => {
    const { findPath, callCount } = countingFindPath(straightLinePath);
    const deps = makeDeps({ findPath });
    let result = updateSafeRoomRouteState(initial(), input(), deps);
    expect(result.state.totalActivations).toBe(1);

    for (const x of [4, 5, 6, 7].map((tile) => tile * REALISTIC_TILE_FT)) {
      result = updateSafeRoomRouteState(result.state, input({ playerX: x }), deps);
    }
    expect(result.state.phase).toBe('idle');
    expect(result.state.totalCompletions).toBe(1);
    expect(callCount()).toBe(1);

    // Re-enter later with a brand-new semantic target.
    result = updateSafeRoomRouteState(
      result.state,
      input({
        playerX: 3 * REALISTIC_TILE_FT,
        playerY: 0,
        candidate: candidate({ targetEid: 7, targetX: 10 * REALISTIC_TILE_FT, targetY: 0 }),
      }),
      deps,
    );
    expect(result.state.phase).toBe('active');
    expect(result.state.totalActivations).toBe(2);
    expect(callCount()).toBe(2);
  });
});

describe('safe-room-route: stable segment and topology reseeds', () => {
  it('keeps the current legal segment when the external semantic commitment changes', () => {
    const { findPath, callCount } = countingFindPath(straightLinePath);
    const deps = makeDeps({ findPath });
    let result = updateSafeRoomRouteState(initial(), input(), deps);
    expect(callCount()).toBe(1);

    result = updateSafeRoomRouteState(
      result.state,
      input({
        candidate: candidate({ targetEid: 99, targetX: 9 * REALISTIC_TILE_FT, targetY: 0 }),
      }),
      deps,
    );
    expect(result.state.phase).toBe('active');
    expect(result.state.commitmentKey).toContain('eid:99');
    expect(result.state.lastReseedCause).toBe('activation');
    expect(result.state.totalReseeds).toBe(0);
    expect(callCount()).toBe(1);
  });

  it('releases immediately when the live target enters the origin room without changing key or navEpoch', () => {
    const { findPath, callCount } = countingFindPath(straightLinePath);
    const deps = makeDeps({ findPath });
    let result = updateSafeRoomRouteState(initial(), input(), deps);
    expect(result.state.phase).toBe('active');

    result = updateSafeRoomRouteState(
      result.state,
      input({
        candidate: candidate({
          targetX: 4 * REALISTIC_TILE_FT,
          targetY: 0,
        }),
      }),
      deps,
    );

    expect(result.state.phase).toBe('idle');
    expect(result.moveTarget).toBeNull();
    expect(result.blocked).toBe(false);
    expect(callCount()).toBe(1);
  });

  it('recomputes (but can stay active) on a navEpoch change alone, when still reachable', () => {
    const { findPath, callCount } = countingFindPath(straightLinePath);
    const deps = makeDeps({ findPath });
    let result = updateSafeRoomRouteState(initial(), input({ navEpoch: 1 }), deps);
    expect(callCount()).toBe(1);

    result = updateSafeRoomRouteState(result.state, input({ navEpoch: 2 }), deps);
    expect(result.state.phase).toBe('active');
    expect(result.state.lastReseedCause).toBe('nav-epoch-change');
    expect(result.state.totalReseeds).toBe(1);
    expect(callCount()).toBe(2);
  });

  it('returns to pass-through when the player has left the origin room before a navEpoch change', () => {
    const { findPath, callCount } = countingFindPath(straightLinePath);
    const deps = makeDeps({ findPath });
    let result = updateSafeRoomRouteState(initial(), input({ navEpoch: 1 }), deps);
    expect(result.state.phase).toBe('active');

    result = updateSafeRoomRouteState(
      result.state,
      input({
        playerX: 7 * REALISTIC_TILE_FT,
        playerInSafeRoom: false,
        navEpoch: 2,
      }),
      deps,
    );

    expect(result.state.phase).toBe('idle');
    expect(result.moveTarget).toBeNull();
    expect(result.blocked).toBe(false);
    expect(callCount()).toBe(1);
  });

  it('bypasses routing when a stable entity target enters the origin room as navEpoch changes', () => {
    const { findPath, callCount } = countingFindPath(straightLinePath);
    const deps = makeDeps({ findPath });
    let result = updateSafeRoomRouteState(initial(), input({ navEpoch: 1 }), deps);
    expect(result.state.phase).toBe('active');

    result = updateSafeRoomRouteState(
      result.state,
      input({
        navEpoch: 2,
        candidate: candidate({
          targetEid: 42,
          targetX: 4 * REALISTIC_TILE_FT,
          targetY: 0,
        }),
      }),
      deps,
    );

    expect(result.state.phase).toBe('idle');
    expect(result.moveTarget).toBeNull();
    expect(result.blocked).toBe(false);
    expect(callCount()).toBe(1);
  });

  it('uses one topology reseed when commitment and navEpoch change together', () => {
    const { findPath, callCount } = countingFindPath(straightLinePath);
    const deps = makeDeps({ findPath });
    let result = updateSafeRoomRouteState(initial(), input({ navEpoch: 1 }), deps);
    expect(callCount()).toBe(1);

    result = updateSafeRoomRouteState(
      result.state,
      input({
        navEpoch: 2,
        candidate: candidate({ targetEid: 99, targetX: 9 * REALISTIC_TILE_FT, targetY: 0 }),
      }),
      deps,
    );
    expect(result.state.lastReseedCause).toBe('nav-epoch-change');
    expect(result.state.totalReseeds).toBe(1); // exactly one reseed, not two
    expect(callCount()).toBe(2); // exactly one recompute, not two
  });
});

describe('safe-room-route: blocked (no legal route)', () => {
  it('reports blocked with zero movement when no legal route exists (sealed room)', () => {
    const result = updateSafeRoomRouteState(initial(), input(), makeDeps({ findPath: () => [] }));
    expect(result.state.phase).toBe('blocked');
    expect(result.state.totalBlocked).toBe(1);
    expect(result.moveTarget).toBeNull();
    expect(result.blocked).toBe(true);
  });

  it('freezes while blocked and does not re-invoke findPath until something changes', () => {
    const { findPath, callCount } = countingFindPath(() => []);
    const deps = makeDeps({ findPath });
    let result = updateSafeRoomRouteState(initial(), input(), deps);
    expect(result.state.phase).toBe('blocked');
    expect(callCount()).toBe(1);

    result = updateSafeRoomRouteState(result.state, input(), deps);
    result = updateSafeRoomRouteState(result.state, input(), deps);
    expect(result.state.phase).toBe('blocked');
    expect(callCount()).toBe(1); // still just the one initial attempt
  });

  it('transitions from active to blocked when a door closes mid-egress (navEpoch change)', () => {
    let epoch = 1;
    const impl: SafeRoomRouteDeps['findPath'] = (start, goal) =>
      epoch === 1 ? straightLinePath(start, goal) : [];
    const { findPath, callCount } = countingFindPath(impl);
    const deps = makeDeps({ findPath });

    let result = updateSafeRoomRouteState(initial(), input({ navEpoch: epoch }), deps);
    expect(result.state.phase).toBe('active');
    expect(callCount()).toBe(1);

    epoch = 2; // door closes / navEpoch bump
    result = updateSafeRoomRouteState(result.state, input({ navEpoch: epoch }), deps);
    expect(result.state.phase).toBe('blocked');
    expect(result.state.lastReseedCause).toBe('nav-epoch-change');
    expect(result.state.totalReseeds).toBe(1);
    expect(result.state.totalBlocked).toBe(1);
    expect(result.blocked).toBe(true);
    expect(callCount()).toBe(2);
  });

  it('transitions from blocked to idle when the player leaves the origin room (same commitment + navEpoch, no extra A*)', () => {
    // First poll: sealed room (no legal path) → blocked.
    const { findPath, callCount } = countingFindPath(() => []);
    const deps = makeDeps({ findPath });
    const firstResult = updateSafeRoomRouteState(initial(), input(), deps);
    expect(firstResult.state.phase).toBe('blocked');
    expect(callCount()).toBe(1);

    // Second poll: commitment key and navEpoch are unchanged (same `input()`
    // defaults), but the player has moved to tile (7,0) which getRoomAt()
    // returns as EXTERIOR_ROOM — no longer the originRoomId. The blocked guard
    // must detect the origin-room leave and return idle pass-through without
    // invoking A* a second time.
    const externalPlayerX = 7 * REALISTIC_TILE_FT; // tile (7,0) → EXTERIOR_ROOM
    const secondResult = updateSafeRoomRouteState(
      firstResult.state,
      input({ playerX: externalPlayerX }),
      deps,
    );
    expect(secondResult.state.phase).toBe('idle');
    expect(secondResult.blocked).toBe(false);
    expect(secondResult.moveTarget).toBeNull();
    expect(callCount()).toBe(1); // no extra A* on origin-room-leave
  });
});

describe('safe-room-route: purity and debug snapshot', () => {
  it('never mutates the input state or candidate (referential purity)', () => {
    const deps = makeDeps();
    const before = initial();
    const beforeSnapshot = JSON.parse(JSON.stringify(before)) as unknown;
    const testInput = input();
    const inputSnapshot = JSON.parse(JSON.stringify(testInput)) as unknown;

    updateSafeRoomRouteState(before, testInput, deps);

    expect(before).toEqual(beforeSnapshot);
    expect(testInput).toEqual(inputSnapshot);
  });

  it('mirrors the durable state fields exactly (toSafeRoomRouteDebugSnapshot)', () => {
    const { findPath } = countingFindPath(straightLinePath);
    const result = updateSafeRoomRouteState(initial(), input(), makeDeps({ findPath }));
    expect(toSafeRoomRouteDebugSnapshot(result.state)).toEqual({
      phase: 'active',
      originRoomId: ORIGIN_ROOM,
      segmentIndex: 1,
      pathLength: 5,
      lastReseedCause: 'activation',
      totalActivations: 1,
      totalCompletions: 0,
      totalBlocked: 0,
      totalReseeds: 0,
    });
  });
});

describe('safe-room-route: no teleport / through-wall (property)', () => {
  it('never proposes a moveTarget off the computed path', () => {
    fc.assert(
      fc.property(fc.integer({ min: 4, max: 30 }), (pathLen) => {
        // Straight tile-space corridor [0..pathLen-1]; room boundary at
        // tile 3 (tiles 0-2 are the origin safe room).
        const boundedGetRoomAt = (tx: number): number => (tx < 3 ? ORIGIN_ROOM : EXTERIOR_ROOM);
        const deps = makeDeps({
          getRoomAt: boundedGetRoomAt,
          findPath: () => Array.from({ length: pathLen }, (_, i) => ({ x: i, y: 0 })),
        });
        const result = updateSafeRoomRouteState(
          initial(),
          input({
            playerX: 0,
            playerY: 0,
            candidate: candidate({ targetX: (pathLen - 1) * REALISTIC_TILE_FT, targetY: 0 }),
          }),
          deps,
        );
        if (result.moveTarget) {
          const asTile = worldToTile(result.moveTarget.x, result.moveTarget.y);
          const onPath = result.state.path.some(
            (tile) => tile.x === asTile.x && tile.y === asTile.y,
          );
          expect(onPath).toBe(true);
        }
      }),
    );
  });
});
