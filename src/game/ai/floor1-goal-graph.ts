/**
 * Floor 1 goal-graph adapter.
 *
 * Historically this module *contained* all Floor-1-specific task construction,
 * ordering, prerequisites, unlock effects, and work-cost policy. That policy now
 * lives entirely in the scenario-owned config (`src/game/scenarios/floor1AiTasks.ts`),
 * interpreted by the generic, Floor-1-agnostic engine in `scenario-ai-tasks.ts`.
 *
 * This file is a thin adapter that binds the Floor 1 config to that engine and
 * preserves the historical public API (`buildFloor1GoalGraph`,
 * `applyFloor1WorkCosts`, `makeStraightLineTravelOracle`, `PLAYER_START_LOCATION`,
 * and the `Floor1GoalMeta`/`Floor1GoalGraph` types) so existing importers and
 * tests are unaffected. There is no Floor-1 ordering logic here anymore — change
 * the config to change the route.
 *
 * Pure: takes a snapshot, returns data. No world/ECS imports.
 */

import {
  IN_PLACE_LOCATION,
  type LocationId,
  type TravelOracle,
} from './objective-route-planner.js';
import {
  applyScenarioWorkCosts,
  buildScenarioGoalGraph,
  type ScenarioGoalGraph,
  type ScenarioGoalMeta,
} from './scenario-ai-tasks.js';
import { FLOOR1_AI_TASK_CONFIG, PLAYER_START_LOCATION } from '../scenarios/floor1AiTasks.js';
import type { Floor1RunPlannerSnapshot, RunPlannerParams, RunPlannerPoint } from './run-planner.js';

export { PLAYER_START_LOCATION };

/** Presentation metadata for a Floor 1 goal (shape unchanged; now generic). */
export type Floor1GoalMeta = ScenarioGoalMeta;

/** The Floor 1 goal graph (shape unchanged; produced by the generic engine). */
export type Floor1GoalGraph = ScenarioGoalGraph;

const EPSILON = 1e-6;

/**
 * Build the Floor 1 goal graph for the current snapshot. Delegates entirely to
 * the generic interpreter + the scenario-owned Floor 1 task config; only goals
 * that are not yet complete are included.
 */
export function buildFloor1GoalGraph(snapshot: Floor1RunPlannerSnapshot): Floor1GoalGraph {
  return buildScenarioGoalGraph(FLOOR1_AI_TASK_CONFIG, snapshot);
}

/**
 * Fill in each goal's `workCost` from {@link RunPlannerParams}. Kept as a
 * separate pass so the graph shape itself only depends on the snapshot, while
 * durations are an explicit, easily-testable second step. Delegates to the
 * generic engine using the scenario-owned per-task cost functions.
 */
export function applyFloor1WorkCosts(
  graph: Floor1GoalGraph,
  snapshot: Floor1RunPlannerSnapshot,
  params: RunPlannerParams,
): Floor1GoalGraph {
  return applyScenarioWorkCosts(FLOOR1_AI_TASK_CONFIG, graph, snapshot, params);
}

/** Straight-line ("perfect geometric knowledge, no doors") travel oracle used
 * by the pure ETA/slack estimator. NOT used for the runtime navigation
 * decision — see `floor1-travel-oracle.ts` for the strict, door-aware A*
 * oracle real movement decisions must use. Always finite for any two known
 * locations (there is no notion of "unreachable" without a real floor map),
 * which is exactly why this mode must never be used where strict
 * unreachability matters. */
export function makeStraightLineTravelOracle(
  locations: ReadonlyMap<LocationId, RunPlannerPoint>,
  moveSpeedFtPerMs: number,
): TravelOracle {
  const speed = Math.max(moveSpeedFtPerMs, EPSILON);
  return {
    travelCost(from, to) {
      if (to === IN_PLACE_LOCATION) return 0;
      const a = locations.get(to);
      const b = locations.get(from);
      if (!a || !b) return Infinity;
      const distanceFt = Math.hypot(a.x - b.x, a.y - b.y);
      return Math.round(distanceFt / speed);
    },
  };
}
