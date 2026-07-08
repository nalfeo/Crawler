/**
 * AIPathingMode.NAVMESH follower (A/B axis 1) — deterministic recast waypoint
 * routing + the partial-path grid-A* fallback guard.
 *
 * This locks the invariants Slice 4 (danger/reward seams on the navmesh path)
 * builds on top of. The report-only `ai:navmesh-sweep` exercises these behaviors
 * but nothing in `npm run verify` gated them until now; the sibling
 * RISK_REWARD_FUSED axis already has this coverage (see fused-pathing.test.ts).
 *
 * Contracts under test:
 *   - DORMANCY / BYTE-IDENTITY (the ship-safety property): with the NAVMESH code
 *     present in the module, a default (LEGACY) AI never touches any navmesh state
 *     — the partial-path counter stays 0 and the recast waypoint buffer stays
 *     empty — because the poll dispatch is a hard mode gate (bt-ai-provider.ts
 *     L2617: `if pathingMode === NAVMESH … else moveToward`). Combined with a
 *     run-to-run byte-identity check of the LEGACY InputState stream, this is the
 *     structural guarantee that "navmesh present ⇒ LEGACY unchanged".
 *   - FUNCTIONAL NAVMESH POLL: in NAVMESH mode a fresh Floor-1 AI routes through
 *     the real poll path (`moveTowardViaNavmesh`), computing a recast route
 *     (`navWaypoints` populates) and producing motion. LEGACY never populates
 *     `navWaypoints`, so this is non-inert and distinguishable from LEGACY.
 *   - PARTIAL-PATH GUARD: when recast returns a success path that does NOT reach
 *     the goal (a severed-connector stub — recast connectivity ⊊ the 4-connected
 *     grid at thin/door connectors under the pinned config), the follower must
 *     NOT consume the stub and re-query every poll (the original freeze-forever
 *     Gate-3 timeout). It increments `navPartialPathFallbacks` and falls back to
 *     grid-A* `moveToward`, still producing motion. We drive this by mocking ONLY
 *     `queryWorldPath` at the navmesh module boundary to inject a non-reaching
 *     stub — the recast severing itself is already covered by the golden
 *     cross-platform determinism test; here we lock the FOLLOWER's handling of a
 *     non-reaching return, which is exactly the guard's job.
 *   - NAVMESH_FUSED (Slice 4a): the SAME recast route with the tuned
 *     RISK_REWARD_FUSED danger/reward fan applied at FOLLOW level. Three locks:
 *     (a) FUNCTIONAL — a NAVMESH_FUSED poll runs BOTH layers (navWaypoints
 *     populate AND getFusedDebug() records the 13-candidate fan); (b) PURE-NAVMESH
 *     PRESERVATION — plain NAVMESH never runs the fused fan even with capture
 *     forced on, so NAVMESH_FUSED did not bleed the fused layer into the frozen
 *     pure-NAVMESH baseline (golden 75917f12 / the sweep no-regression bar);
 *     (c) the partial-path guard is SHARED — a severed recast stub falls back to
 *     grid-A* in fused mode too (still motion, never frozen).
 *
 * Deterministic only: seed 42 + createTestWorld, no Math.random / Date.now.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BehaviorTreeAI } from '../../../src/game/ai/bt-ai-provider.js';
import { spawnPlayer } from '../../../src/core/spawners/combatants.js';
import {
  initializeFloor1Scenario,
  selectFloor1StarterWeapon,
} from '../../../src/game/floorScenario.js';
import { createInputState } from '../../../src/shared/input.js';
import { createTestWorld } from '../../helpers/world-factory.js';
import { AIPathingMode } from '../../../src/game/ai/types.js';
import { initNavmesh, queryWorldPath } from '../../../src/game/ai/navmesh/index.js';
import type { FusedHeadingDebug } from '../../../src/game/ai/index.js';

const NAVMESH_INDEX = '../../../src/game/ai/navmesh/index.js';

// Mock ONLY queryWorldPath; everything else (initNavmesh, buildFloorNavmesh,
// isNavmeshReady, destroyNavmesh) stays real so the follower builds a genuine
// Floor-1 navmesh. The spy calls through to the real implementation by default,
// so the functional test below still exercises real recast routing; the guard
// test opts in to a non-reaching stub via mockImplementation.
vi.mock('../../../src/game/ai/navmesh/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/game/ai/navmesh/index.js')>();
  return { ...actual, queryWorldPath: vi.fn(actual.queryWorldPath) };
});

type TestWorld = ReturnType<typeof createTestWorld>;

function freshFloor1World(seed: number): TestWorld {
  const world = createTestWorld({ seed });
  const player = spawnPlayer(world, 0, 0);
  initializeFloor1Scenario(world, player);
  selectFloor1StarterWeapon(world, 0);
  return world;
}

/** Poll budget large enough for the opening travel goal to drive the follower. */
const POLL_BUDGET = 16;

/** RISK_REWARD_CANDIDATE_OFFSETS_DEG fan is [0, ±15…±90] → 13 candidates. */
const EXPECTED_CANDIDATE_COUNT = 13;

let realQueryWorldPath: typeof queryWorldPath;

beforeAll(async () => {
  // NAVMESH mode throws in ensureFloorNavmesh() unless initNavmesh() was awaited.
  await initNavmesh();
  realQueryWorldPath = (
    await vi.importActual<typeof import('../../../src/game/ai/navmesh/index.js')>(NAVMESH_INDEX)
  ).queryWorldPath;
});

// Track the NAVMESH-mode AI under test so its cached recast handle is ALWAYS
// freed after each test — even if an assertion throws — otherwise the built
// WASM objects leak across the unit-test process as more navmesh tests land.
// disposeNavmesh() frees only this AI's per-floor handle, not the initNavmesh()
// runtime, so a later NAVMESH test rebuilds cleanly.
let activeNavAi: BehaviorTreeAI | undefined;
afterEach(() => {
  activeNavAi?.disposeNavmesh();
  activeNavAi = undefined;
});

describe('AIPathingMode.NAVMESH — dormancy + byte-identity guard', () => {
  it('LEGACY never touches navmesh state (counter 0, no recast waypoints)', () => {
    const world = freshFloor1World(42);
    const ai = new BehaviorTreeAI({ seed: 42, pathingMode: AIPathingMode.LEGACY });

    for (let i = 0; i < POLL_BUDGET; i++) {
      ai.poll(createInputState(), world);
    }

    // The navmesh follower is fully dead under LEGACY: no partial-path fallbacks,
    // no recast route buffered, index untouched.
    expect(ai.navPartialPathFallbacks).toBe(0);
    const debug = ai.getNavigationDebug();
    expect(debug.navWaypoints).toHaveLength(0);
    expect(debug.navPathIndex).toBe(0);
  });

  it('LEGACY poll output is byte-identical run-to-run (navmesh code cannot perturb it)', () => {
    const worldA = freshFloor1World(42);
    const worldB = freshFloor1World(42);
    const aiA = new BehaviorTreeAI({ seed: 42, pathingMode: AIPathingMode.LEGACY });
    const aiB = new BehaviorTreeAI({ seed: 42, pathingMode: AIPathingMode.LEGACY });

    for (let i = 0; i < POLL_BUDGET; i++) {
      const stateA = createInputState();
      const stateB = createInputState();
      aiA.poll(stateA, worldA);
      aiB.poll(stateB, worldB);
      // Full InputState (moveX/moveY + every action flag) must match every poll.
      // Strict deep equality (not JSON.stringify, which is lossy for NaN/-0 and
      // drops undefined) so a real InputState divergence can never slip through.
      expect(stateA).toStrictEqual(stateB);
    }
    // And the navmesh state stayed dormant on both.
    expect(aiA.navPartialPathFallbacks).toBe(0);
    expect(aiB.navPartialPathFallbacks).toBe(0);
  });
});

describe('AIPathingMode.NAVMESH — functional recast routing through the real poll path', () => {
  it('computes a recast route (navWaypoints populate) and produces motion on Floor 1', () => {
    const world = freshFloor1World(42);
    const ai = new BehaviorTreeAI({ seed: 42, pathingMode: AIPathingMode.NAVMESH });
    activeNavAi = ai; // freed in afterEach so the built recast handle never leaks

    let sawNavRoute = false;
    let sawMotion = false;
    for (let i = 0; i < POLL_BUDGET; i++) {
      const state = createInputState();
      ai.poll(state, world);
      if (ai.getNavigationDebug().navWaypoints.length > 0) sawNavRoute = true;
      if (Math.hypot(state.moveX, state.moveY) > 0) sawMotion = true;
    }

    // Real recast routing ran (LEGACY never populates navWaypoints — the
    // dormancy test above proves that), and the agent is not frozen.
    expect(sawNavRoute).toBe(true);
    expect(sawMotion).toBe(true);
    // The real Floor-1 route reaches its goal, so the partial-path guard is
    // dormant here (matches the near-dormant sweep: fires on ~1 pair, seed-8 bat).
    expect(ai.navPartialPathFallbacks).toBe(0);
  });
});

describe('AIPathingMode.NAVMESH — partial-path guard falls back to grid-A* (not frozen)', () => {
  afterEach(() => {
    // Restore call-through so a mocked stub never leaks into another test.
    vi.mocked(queryWorldPath).mockImplementation(realQueryWorldPath);
  });

  it('a non-reaching recast stub increments the counter and keeps moving', () => {
    // Stub every recast query with a 1-waypoint route sitting on the START point.
    // lastWp is therefore ~as far from the goal as the agent is → reachesGoal is
    // false → the follower must fall back to moveToward instead of consuming it.
    vi.mocked(queryWorldPath).mockImplementation((_handle, startWorldX, startWorldY) => ({
      success: true,
      waypoints: [{ x: startWorldX, y: startWorldY }],
    }));

    const world = freshFloor1World(42);
    const ai = new BehaviorTreeAI({ seed: 42, pathingMode: AIPathingMode.NAVMESH });
    activeNavAi = ai; // freed in afterEach so the built recast handle never leaks

    let sawMotion = false;
    for (let i = 0; i < POLL_BUDGET; i++) {
      const state = createInputState();
      ai.poll(state, world);
      if (Math.hypot(state.moveX, state.moveY) > 0) sawMotion = true;
    }

    // Guard fired (non-reaching stub detected) …
    expect(ai.navPartialPathFallbacks).toBeGreaterThan(0);
    // … the stub was never accepted as a route …
    expect(ai.getNavigationDebug().navWaypoints).toHaveLength(0);
    // … and the agent kept moving via grid-A* moveToward — this is the exact
    // regression the guard fixes (the naive path froze at moveX=moveY=0 forever).
    expect(sawMotion).toBe(true);
  });
});

describe('AIPathingMode.NAVMESH_FUSED — fused danger/reward fan on the navmesh route', () => {
  it('runs BOTH the recast route and the fused scorer through the real poll path', () => {
    const world = freshFloor1World(42);
    const ai = new BehaviorTreeAI({ seed: 42, pathingMode: AIPathingMode.NAVMESH_FUSED });
    activeNavAi = ai; // freed in afterEach so the built recast handle never leaks
    // Opt into the fused debug snapshot so we can assert the fan actually ran.
    ai.fusedDebugCapture = true;

    let sawNavRoute = false;
    let sawMotion = false;
    let debug: FusedHeadingDebug | null = null;
    for (let i = 0; i < POLL_BUDGET; i++) {
      const state = createInputState();
      ai.poll(state, world);
      if (ai.getNavigationDebug().navWaypoints.length > 0) sawNavRoute = true;
      if (Math.hypot(state.moveX, state.moveY) > 0) sawMotion = true;
      if (debug === null) debug = ai.getFusedDebug();
    }

    // The navmesh route drives the base heading (the NAVMESH arm — recast query
    // reused verbatim, so navWaypoints populate exactly like pure NAVMESH) …
    expect(sawNavRoute).toBe(true);
    // … AND the tuned fused fan deflects that heading at follow level (the FUSED
    // arm). Both layers composing is the exact Slice-4a wiring: pure recast query
    // + danger/reward as a FOLLOW-time cost. Pure NAVMESH never records this (the
    // preservation lock below proves it), so this is distinguishable from NAVMESH.
    expect(debug).not.toBeNull();
    expect(debug?.candidates).toHaveLength(EXPECTED_CANDIDATE_COUNT);
    expect(sawMotion).toBe(true);
  });
});

describe('AIPathingMode.NAVMESH — pure-locomotion preservation (fused fan stays OFF)', () => {
  it('pure NAVMESH never runs the fused scorer even with capture forced on', () => {
    const world = freshFloor1World(42);
    const ai = new BehaviorTreeAI({ seed: 42, pathingMode: AIPathingMode.NAVMESH });
    activeNavAi = ai; // freed in afterEach so the built recast handle never leaks
    // Force capture on — pure NAVMESH must STILL never run the fused scorer.
    ai.fusedDebugCapture = true;

    let sawNavRoute = false;
    for (let i = 0; i < POLL_BUDGET; i++) {
      ai.poll(createInputState(), world);
      if (ai.getNavigationDebug().navWaypoints.length > 0) sawNavRoute = true;
    }

    // Pure NAVMESH routes via recast (navWaypoints populate) but NEVER runs the
    // fused fan — this is the Slice-4a mode separation: NAVMESH_FUSED adds the
    // danger/reward follow layer, plain NAVMESH stays pure locomotion. Locks that
    // adding NAVMESH_FUSED did not bleed the fused layer into the frozen
    // pure-NAVMESH baseline (golden 75917f12 / the sweep no-regression bar).
    expect(sawNavRoute).toBe(true);
    expect(ai.getFusedDebug()).toBeNull();
  });
});

describe('AIPathingMode.NAVMESH_FUSED — partial-path guard falls back to grid-A* (not frozen)', () => {
  afterEach(() => {
    // Restore call-through so a mocked stub never leaks into another test.
    vi.mocked(queryWorldPath).mockImplementation(realQueryWorldPath);
  });

  it('a non-reaching recast stub increments the counter and keeps moving (fused arm)', () => {
    // Same severed-connector stub as the NAVMESH guard test: the partial-path
    // guard lives in moveTowardViaNavmesh, which BOTH navmesh-routed modes share,
    // so NAVMESH_FUSED must fall back to grid-A* identically (the fused fan then
    // deflects that fallback heading — still motion, never the freeze-forever bug).
    vi.mocked(queryWorldPath).mockImplementation((_handle, startWorldX, startWorldY) => ({
      success: true,
      waypoints: [{ x: startWorldX, y: startWorldY }],
    }));

    const world = freshFloor1World(42);
    const ai = new BehaviorTreeAI({ seed: 42, pathingMode: AIPathingMode.NAVMESH_FUSED });
    activeNavAi = ai; // freed in afterEach so the built recast handle never leaks

    let sawMotion = false;
    for (let i = 0; i < POLL_BUDGET; i++) {
      const state = createInputState();
      ai.poll(state, world);
      if (Math.hypot(state.moveX, state.moveY) > 0) sawMotion = true;
    }

    expect(ai.navPartialPathFallbacks).toBeGreaterThan(0);
    expect(ai.getNavigationDebug().navWaypoints).toHaveLength(0);
    expect(sawMotion).toBe(true);
  });
});
