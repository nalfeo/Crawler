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
  SAFE_ROOM_ROUTE_NO_PROGRESS_FRAMES,
  SAFE_ROOM_ROUTE_PROGRESS_EPSILON_FT,
  SAFE_ROOM_ROUTE_SUPPRESS_FRAMES,
  SAFE_ROOM_ROUTE_ATTEMPT_DORMANT_FRAMES,
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

  it('clears any live no-progress suppression window (multi-model review regression)', () => {
    // A suppression window left over from an EARLIER, unrelated stall must
    // not survive an external abort — an abort (e.g. hostile-encounter
    // invalidation) already discards the entire semantic decision, so a
    // stale cooldown blocking reactivation of a coincidentally-reused
    // commitment key would be an unintended, hard-to-diagnose behavior leak.
    const suppressed = {
      ...initial(),
      suppressedCommitmentKey: 'engage:eid:7',
      suppressFramesRemaining: 90,
    };
    const aborted = abortSafeRoomRoute(suppressed);
    expect(aborted.suppressedCommitmentKey).toBeNull();
    expect(aborted.suppressFramesRemaining).toBe(0);
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

describe('safe-room-route: no-progress watchdog', () => {
  // The first steady-state poll after activation always "improves" (any
  // finite distance beats the Infinity baseline, resetting noProgressFrames
  // to 0), so release requires NO_PROGRESS_FRAMES + 1 further stalled polls
  // after that baseline-setting one: NO_PROGRESS_FRAMES + 2 total polls
  // after the activation poll itself. Verified by direct trace against the
  // real reducer (not hand-derived) to avoid re-introducing an off-by-one.
  // Shared here so every test below drives to release with the exact right
  // count instead of duplicating (and risking re-drifting) this arithmetic.
  const POLLS_AFTER_ACTIVATION_TO_RELEASE = SAFE_ROOM_ROUTE_NO_PROGRESS_FRAMES + 2;

  function driveToNoProgressRelease(
    deps: SafeRoomRouteDeps,
  ): ReturnType<typeof updateSafeRoomRouteState> {
    let result = updateSafeRoomRouteState(initial(), input(), deps);
    for (let i = 0; i < POLLS_AFTER_ACTIVATION_TO_RELEASE; i += 1) {
      result = updateSafeRoomRouteState(result.state, input(), deps);
    }
    return result;
  }

  // Regression coverage for the canonical 600-run cloud gate finding
  // (2026-07-13): an 'active' route that never measurably closes on its
  // endpoint (e.g. because sustained combat holds the player in place near
  // the doorway) must eventually release control back to the semantic
  // target instead of overriding movement toward an unreachable-in-practice
  // goal forever.
  it('releases to idle after sustained zero progress toward the endpoint', () => {
    const { findPath } = countingFindPath(straightLinePath);
    const deps = makeDeps({ findPath });
    const result = driveToNoProgressRelease(deps);

    expect(result.state.phase).toBe('idle');
    expect(result.state.lastReseedCause).toBe('no-progress');
    expect(result.blocked).toBe(false);
    expect(result.moveTarget).toBeNull();
    // A no-progress release is a genuine "gave up on this commitment" event
    // for diagnostics, distinct from a normal activation/completion.
    expect(result.state.totalReseeds).toBeGreaterThan(0);
  });

  it('releases at exactly the computed poll count, not one poll before', () => {
    const { findPath } = countingFindPath(straightLinePath);
    const deps = makeDeps({ findPath });
    let result = updateSafeRoomRouteState(initial(), input(), deps);
    expect(result.state.phase).toBe('active');

    // One poll short of the release point: still active.
    for (let i = 0; i < POLLS_AFTER_ACTIVATION_TO_RELEASE - 1; i += 1) {
      result = updateSafeRoomRouteState(result.state, input(), deps);
    }
    expect(result.state.phase).toBe('active');
    // The exact release poll.
    result = updateSafeRoomRouteState(result.state, input(), deps);
    expect(result.state.phase).toBe('idle');
    expect(result.state.lastReseedCause).toBe('no-progress');
  });

  it('does not release while the player keeps making steady progress right at the epsilon/threshold boundary', () => {
    const { findPath } = countingFindPath(straightLinePath);
    const deps = makeDeps({ findPath });
    let result = updateSafeRoomRouteState(initial(), input(), deps);
    expect(result.state.phase).toBe('active');

    // Advance by exactly enough to clear the progress epsilon one poll
    // BEFORE the no-progress threshold would fire — the tightest genuine
    // "steady progress" case the watchdog must tolerate. A looser step size
    // would pass vacuously without ever approaching the real boundary.
    const stepFt = SAFE_ROOM_ROUTE_PROGRESS_EPSILON_FT / SAFE_ROOM_ROUTE_NO_PROGRESS_FRAMES;
    let playerX = 3 * REALISTIC_TILE_FT;
    for (let i = 0; i < SAFE_ROOM_ROUTE_NO_PROGRESS_FRAMES * 3; i += 1) {
      playerX += stepFt;
      result = updateSafeRoomRouteState(result.state, input({ playerX }), deps);
      expect(result.state.phase).not.toBe('idle');
    }
    expect(result.state.lastReseedCause).not.toBe('no-progress');
    expect(result.state.phase).toBe('active');
  });

  it('resets the no-progress baseline on a fresh (re)activation', () => {
    const { findPath } = countingFindPath(straightLinePath);
    const deps = makeDeps({ findPath });
    const activated = updateSafeRoomRouteState(initial(), input(), deps);
    expect(activated.state.noProgressFrames).toBe(0);
    expect(activated.state.bestEndpointDistanceFt).toBeGreaterThan(0);
  });

  it('suppresses immediate reactivation of the SAME commitment after a no-progress release (no thrash)', () => {
    // Regression coverage for a multi-model review finding: without
    // suppression, an unchanged stuck input reactivates the identical route
    // one poll after release and thrashes active/idle forever, recomputing
    // A* every cycle.
    const { findPath, callCount } = countingFindPath(straightLinePath);
    const deps = makeDeps({ findPath });
    let result = driveToNoProgressRelease(deps);
    expect(result.state.phase).toBe('idle');
    const callsAtRelease = callCount();

    // Many more polls with the IDENTICAL stuck input: must stay idle
    // (suppressed), and must NOT recompute A* again while suppressed.
    for (let i = 0; i < SAFE_ROOM_ROUTE_SUPPRESS_FRAMES - 1; i += 1) {
      result = updateSafeRoomRouteState(result.state, input(), deps);
      expect(result.state.phase).toBe('idle');
    }
    expect(callCount()).toBe(callsAtRelease);
    expect(result.state.suppressFramesRemaining).toBeGreaterThan(0);
  });

  it('does not suppress a genuinely different commitment after a no-progress release', () => {
    const { findPath } = countingFindPath(straightLinePath);
    const deps = makeDeps({ findPath });
    const result = driveToNoProgressRelease(deps);
    expect(result.state.phase).toBe('idle');

    // A different semantic target (different eid) is a different commitment
    // key — must activate immediately despite the still-live suppression
    // window for the OLD commitment.
    const reactivated = updateSafeRoomRouteState(
      result.state,
      input({ candidate: candidate({ targetEid: 999 }) }),
      deps,
    );
    expect(reactivated.state.phase).toBe('active');
  });

  it('reactivates the same commitment once the suppression window expires', () => {
    const { findPath } = countingFindPath(straightLinePath);
    const deps = makeDeps({ findPath });
    let result = driveToNoProgressRelease(deps);
    expect(result.state.phase).toBe('idle');

    // Fully expend the suppression countdown — still idle at the very last
    // suppressed poll (the countdown reaching zero and the actual
    // reactivation attempt happen on separate polls; see the idle-branch
    // logic in updateSafeRoomRouteState).
    for (let i = 0; i < SAFE_ROOM_ROUTE_SUPPRESS_FRAMES; i += 1) {
      result = updateSafeRoomRouteState(result.state, input(), deps);
    }
    expect(result.state.phase).toBe('idle');
    expect(result.state.suppressFramesRemaining).toBe(0);

    // One more poll: suppression has expired, so the same (still stuck, but
    // now eligible again) commitment reactivates rather than staying idle
    // forever.
    result = updateSafeRoomRouteState(result.state, input(), deps);
    expect(result.state.phase).toBe('active');
  });
});

describe('safe-room-route: exit-frontier-scoped egress attempt (churn stability)', () => {
  // Regression coverage for the second canonical 600-run cloud gate finding
  // (2026-07-13): heavy combat can make Track A's winner toggle rapidly
  // among external states (e.g. ENGAGE) and IN-ROOM states (e.g. RETREAT
  // fleeing to safety) every ~10-20 polls. Each toggle into an in-room
  // target correctly fires the same-room bypass immediately (Retreat must
  // never be delayed), but a naive per-activation no-progress watchdog gets
  // reset to a fresh Infinity/0 baseline every time ENGAGE resumes — so no
  // single burst ever accumulates enough stalled polls to trip the
  // watchdog, even after 100+ seconds of the player never actually leaving
  // the room. This is a GENERIC state-machine property test, not tied to
  // any specific seed/weapon/production scenario.
  it('accumulates no-progress across a same-room-bypass interlude instead of resetting (no thrash-proof escape)', () => {
    const { findPath } = countingFindPath(straightLinePath);
    const deps = makeDeps({ findPath });

    // Activate a normal external (ENGAGE) egress attempt; player never moves
    // (simulates being held in place near the doorway).
    let result = updateSafeRoomRouteState(initial(), input(), deps);
    expect(result.state.phase).toBe('active');

    // Burn most of the no-progress budget on the initial ENGAGE burst.
    const burstPolls = SAFE_ROOM_ROUTE_NO_PROGRESS_FRAMES - 5;
    for (let i = 0; i < burstPolls; i += 1) {
      result = updateSafeRoomRouteState(result.state, input(), deps);
    }
    expect(result.state.phase).toBe('active');
    const noProgressBeforeInterlude = result.state.noProgressFrames;
    expect(noProgressBeforeInterlude).toBeGreaterThan(0);

    // Interrupt with a handful of RETREAT-to-safety polls (same-room target —
    // a point well inside the origin room). The same-room bypass must fire
    // immediately every poll (movement responsiveness unaffected) but must
    // NOT reset the accumulated no-progress count back to 0.
    const retreatToSafety = candidate({
      state: AIState.RETREAT,
      targetEid: null,
      targetX: 1 * REALISTIC_TILE_FT,
      targetY: 0,
    });
    for (let i = 0; i < 5; i += 1) {
      result = updateSafeRoomRouteState(result.state, input({ candidate: retreatToSafety }), deps);
      expect(result.state.phase).toBe('idle'); // bypassed immediately every poll
      expect(result.moveTarget).toBeNull(); // raw Retreat target drives movement, unobstructed
    }
    // The interlude must not have reset the stall memory.
    expect(result.state.noProgressFrames).toBeGreaterThanOrEqual(noProgressBeforeInterlude);

    // ENGAGE resumes (same door). Because the interlude preserved the
    // accumulated stall count instead of resetting it, only a FEW more
    // polls (not another full 45-poll budget) should be needed to trip the
    // watchdog — proving the fix, since a per-activation-reset design would
    // require the FULL budget again from scratch here.
    let released = false;
    for (let i = 0; i < 10; i += 1) {
      result = updateSafeRoomRouteState(result.state, input(), deps);
      if (result.state.phase === 'idle' && result.state.lastReseedCause === 'no-progress') {
        released = true;
        break;
      }
    }
    expect(released).toBe(true);
  });

  it('does not penalize a genuinely different door with another doorstall (multi-door room)', () => {
    // A tiny two-door fake world: tiles x in [0,5] are the origin safe room;
    // x=6,y=0 is door A (leads to exterior tile x=7,y=0); x=0,y=6 is door B
    // (leads to exterior tile x=0,y=7) — a different exit entirely, reached
    // by going through y instead of x. Distinct topology from the shared
    // 1D-corridor fixture used elsewhere in this file, so this test is
    // self-contained.
    const DOOR_A_ORIGIN_ROOM = 0;
    const EXT = -1;
    const getRoomAtTwoDoor = (tx: number, ty: number): number => {
      if (tx >= 0 && tx <= 5 && ty === 0) return DOOR_A_ORIGIN_ROOM;
      if (tx === 0 && ty >= 0 && ty <= 5) return DOOR_A_ORIGIN_ROOM;
      return EXT;
    };
    const findPathTwoDoor = (start: TilePoint, goal: TilePoint): TilePoint[] => {
      // Straight line along whichever axis the goal differs on — enough to
      // exercise two independent doors deterministically.
      const path: TilePoint[] = [];
      if (goal.y === 0) {
        const step = goal.x >= start.x ? 1 : -1;
        for (let x = start.x; x !== goal.x + step; x += step) path.push({ x, y: 0 });
      } else if (goal.x === 0) {
        const step = goal.y >= start.y ? 1 : -1;
        for (let y = start.y; y !== goal.y + step; y += step) path.push({ x: 0, y });
      }
      return path;
    };
    const deps: SafeRoomRouteDeps = {
      worldToTile,
      tileToWorld,
      getRoomAt: getRoomAtTwoDoor,
      isSafeRoomId: (id) => id === DOOR_A_ORIGIN_ROOM,
      findPath: findPathTwoDoor,
    };

    // Stall out an attempt through door A (exit at x=6,y=0 → exterior x=7).
    const doorACandidate = candidate({ targetX: 9 * REALISTIC_TILE_FT, targetY: 0 });
    let result = updateSafeRoomRouteState(
      initial(),
      input({ playerX: 3 * REALISTIC_TILE_FT, playerY: 0, candidate: doorACandidate }),
      deps,
    );
    expect(result.state.phase).toBe('active');
    for (let i = 0; i < SAFE_ROOM_ROUTE_NO_PROGRESS_FRAMES + 2; i += 1) {
      result = updateSafeRoomRouteState(
        result.state,
        input({ playerX: 3 * REALISTIC_TILE_FT, playerY: 0, candidate: doorACandidate }),
        deps,
      );
    }
    expect(result.state.phase).toBe('idle');
    expect(result.state.lastReseedCause).toBe('no-progress');

    // A genuinely different target through door B (exit at x=0,y=6) must
    // activate immediately and with a FRESH, unpenalized budget — door A's
    // stall must never leak into door B's attempt.
    const doorBCandidate = candidate({
      targetEid: 999,
      targetX: 0,
      targetY: 9 * REALISTIC_TILE_FT,
    });
    const doorBResult = updateSafeRoomRouteState(
      result.state,
      input({ playerX: 0, playerY: 3 * REALISTIC_TILE_FT, candidate: doorBCandidate }),
      deps,
    );
    expect(doorBResult.state.phase).toBe('active');
    expect(doorBResult.state.noProgressFrames).toBe(0);
  });

  it('retires a stale attempt after a sustained (not merely blipped) same-room dwell', () => {
    const { findPath } = countingFindPath(straightLinePath);
    const deps = makeDeps({ findPath });
    let result = updateSafeRoomRouteState(initial(), input(), deps);
    expect(result.state.phase).toBe('active');
    expect(toSafeRoomRouteDebugSnapshot(result.state).attemptActive).toBe(true);

    // Genuinely settle: sustained same-room dwell for far longer than any
    // realistic single combat interruption — must eventually retire the
    // attempt rather than let stall memory linger indefinitely.
    const insideCandidate = candidate({
      state: AIState.COLLECT,
      targetEid: null,
      targetX: 1 * REALISTIC_TILE_FT,
      targetY: 0,
    });
    for (let i = 0; i < SAFE_ROOM_ROUTE_ATTEMPT_DORMANT_FRAMES + 2; i += 1) {
      result = updateSafeRoomRouteState(result.state, input({ candidate: insideCandidate }), deps);
    }
    expect(toSafeRoomRouteDebugSnapshot(result.state).attemptActive).toBe(false);
    expect(result.state.bestEndpointDistanceFt).toBe(Number.POSITIVE_INFINITY);
  });

  it('retires a stale attempt when the player has physically left its tracked room before a same-room candidate reappears', () => {
    // Regression coverage for a multi-model review finding (2026-07-13): if
    // the player has ALREADY genuinely left the room an attempt was
    // tracking, and a LATER candidate happens to resolve back inside that
    // same room (a stray Retreat/Collect target), the attempt must NOT be
    // preserved as if this were a normal in-room interlude — otherwise it
    // could carry an artificially tiny `bestEndpointDistanceFt` from the
    // moment the player was last at the door (which can never again
    // register as "improved"), causing spurious immediate no-progress
    // releases on a later, unrelated attempt through the same door.
    const { findPath } = countingFindPath(straightLinePath);
    const deps = makeDeps({ findPath });
    let result = updateSafeRoomRouteState(initial(), input(), deps);
    expect(result.state.phase).toBe('active');
    expect(toSafeRoomRouteDebugSnapshot(result.state).attemptActive).toBe(true);

    const strayInsideCandidate = candidate({
      state: AIState.RETREAT,
      targetEid: null,
      targetX: 1 * REALISTIC_TILE_FT,
      targetY: 0,
    });
    const farOutsideX = 20 * REALISTIC_TILE_FT; // well past the door, definitely exterior
    result = updateSafeRoomRouteState(
      result.state,
      input({ playerX: farOutsideX, candidate: strayInsideCandidate }),
      deps,
    );
    expect(toSafeRoomRouteDebugSnapshot(result.state).attemptActive).toBe(false);
    expect(result.state.bestEndpointDistanceFt).toBe(Number.POSITIVE_INFINITY);
    expect(result.state.noProgressFrames).toBe(0);

    // A subsequent genuine re-entry + external target through the SAME door
    // must get a completely FRESH, unpenalized attempt — not one poisoned
    // by the stale reading above.
    result = updateSafeRoomRouteState(result.state, input(), deps);
    expect(result.state.phase).toBe('active');
    expect(result.state.noProgressFrames).toBe(0);
    expect(result.state.bestEndpointDistanceFt).toBeGreaterThan(0);
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
    // structuredClone (not a JSON round-trip) so Infinity survives the
    // snapshot comparison — bestEndpointDistanceFt starts at
    // Number.POSITIVE_INFINITY, which JSON.stringify would lossily collapse
    // to null and mask a real mutation.
    const beforeSnapshot = structuredClone(before);
    const testInput = input();
    const inputSnapshot = structuredClone(testInput);

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
      noProgressFrames: 0,
      attemptActive: true,
      suppressFramesRemaining: 0,
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
