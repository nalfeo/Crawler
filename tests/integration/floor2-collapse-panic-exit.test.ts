/**
 * Floor-2 collapse-panic exit integration.
 *
 * Regression cover for the Floor-2 progression bug behind the report-only
 * release sweep legs: 115 of the 149 timeouts in the release baseline had
 * already killed every family boss — so the exit staircase was spawned and
 * unlocked — and still never descended.
 *
 * Root cause: the AI's collapse-panic profile was built exclusively from
 * `world.floorScenario.objective`, which Floor 2 sets to `null`. Floor 2 does
 * collapse (`floor2ObjectiveTick` ends the run at the manifest timer duration),
 * but the AI could not see it, so the pre-exit loot sweep — which sits ABOVE
 * Progress in Track A and only surrenders on panic/beeline — swept until the
 * floor collapsed.
 *
 * This drives the real `BehaviorTreeAI` on a Floor-2 world with the staircase
 * unlocked and one nearby reachable gold pile, and asserts the decision flips
 * from the loot sweep to the exit stairs once the collapse deadline closes in.
 */
import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { createInputState } from '../../src/shared/input.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { spawnPlayer } from '../../src/core/spawners/combatants.js';
import { spawnGold } from '../../src/core/spawners/pickups.js';
import { CaveSystemGenerator } from '../../src/core/map/generators/cave-system.js';
import { BiomeType, type MapConfig } from '../../src/shared/map-types.js';
import { SeededRandom } from '../../src/shared/random.js';
import { getFloorManifest } from '../../src/shared/floor-registry.js';
import { pickRoomAnchorCell } from '../../src/core/floor2-settlement-anchor.js';
import {
  FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID,
  FLOOR2_SETTLEMENT_FOUND_GOAL_ID,
} from '../../src/game/floor2Scenario.js';
import { setGoalFlag } from '../../src/core/door-lock.js';
import { selectFloor2Roster } from '../../src/core/faction-relations.js';
import { loadFamilies } from '../../src/shared/data/families.js';
import { loadResources } from '../../src/shared/data/resources.js';
import type { FloorMap } from '../../src/core/map/FloorMap.js';

const SEED = 97531;
const FLOOR2_DURATION_MS = getFloorManifest('floor2')!.timer!.durationMs;

function smallCaveConfig(seed: number): MapConfig {
  return {
    widthTiles: 80,
    heightTiles: 60,
    tileSizeFt: 4,
    biome: BiomeType.CAVE_SYSTEM,
    seed,
    roomWidthRange: [5, 12],
    roomHeightRange: [5, 12],
    maxRooms: 20,
    floorDensity: 0.45,
  };
}

/** Deterministic walkable anchors: the interior anchor cell of each room, in
 * descending room size, so the player and the staircase land in different rooms. */
function pickAnchors(floorMap: FloorMap): { x: number; y: number }[] {
  return [...floorMap.rooms]
    .sort(
      (a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height || a.id - b.id,
    )
    .map((room) => pickRoomAnchorCell(room))
    .filter((cell): cell is { x: number; y: number } => cell !== null)
    .map((cell) => floorMap.tileToWorld(cell.x, cell.y));
}

function buildFloor2World() {
  const generator = new CaveSystemGenerator({ presentCount: 3 });
  const floorMap = generator.generate(smallCaveConfig(SEED), new SeededRandom(SEED));
  const world = createTestWorld({ seed: SEED, floor: 2 });
  world.floorId = 'floor2';
  world.floorMap = floorMap;
  world.floorScenario = null;
  world.state = 'playing';

  const anchors = pickAnchors(floorMap);
  expect(anchors.length).toBeGreaterThanOrEqual(2);
  const playerPos = anchors[0]!;
  const stairsPos = anchors[1]!;
  const goldPos = { x: playerPos.x + 4, y: playerPos.y };

  const roster = selectFloor2Roster(new SeededRandom(SEED), loadFamilies(), loadResources(), {
    presentCountFourProbability: 0,
  });
  world.floorExtendedState = {
    familyState: {
      presentFamilies: [...roster.presentFamilies],
      contestedResource: roster.contestedResource,
      betrayerFlag: false,
      // Post-victory state: every boss is dead, so the staircase popped.
      staircaseSpawned: true,
      staircaseUnlocked: true,
      staircaseDiscovered: false,
      staircasePos: { x: stairsPos.x, y: stairsPos.y },
    },
  };
  // The Floor-2 Progress branch is gated behind the settlement/broker intro;
  // both are long done by the time the last den falls.
  setGoalFlag(world, FLOOR2_SETTLEMENT_FOUND_GOAL_ID, true);
  setGoalFlag(world, FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID, true);

  const playerEid = spawnPlayer(world, playerPos.x, playerPos.y);
  world.stores.health.current[playerEid] = 100;
  world.stores.health.max[playerEid] = 100;
  // One reachable gold pile near the player: the bounded pre-exit sweep's target.
  spawnGold(world, goldPos.x, goldPos.y, 10);

  return { world, stairsPos };
}

describe('Floor 2 collapse panic — exit before the floor collapses', () => {
  it('sweeps loot early in the run but abandons it for the exit stairs under collapse pressure', () => {
    const { world, stairsPos } = buildFloor2World();
    const ai = new BehaviorTreeAI({ seed: SEED });
    const input = createInputState();

    // Early in the run there is plenty of time: the pre-exit sweep owns the
    // decision, which is the behavior we deliberately keep (descending destroys
    // every uncollected pickup).
    world.elapsedMs = 60_000;
    ai.poll(input, world);
    expect(ai.getDecision().reason).toContain('Loot sweep');

    // Deep into the collapse window the sweep must surrender and the AI must
    // travel to the exit. Before this fix the panic profile was permanently
    // neutral on Floor 2, so the sweep never released the decision and the run
    // timed out with the exit unlocked and unused.
    world.elapsedMs = FLOOR2_DURATION_MS - 30_000;
    ai.poll(input, world);
    const decision = ai.getDecision();
    expect(decision.reason).not.toContain('Loot sweep');
    expect(decision.reason).toContain('Floor 2 exit stairs');
    expect(decision.targetX).toBeCloseTo(stairsPos.x, 5);
    expect(decision.targetY).toBeCloseTo(stairsPos.y, 5);
  });
});
