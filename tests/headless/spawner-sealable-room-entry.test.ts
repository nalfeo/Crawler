/**
 * Sealable-room lab-preset entry regression.
 *
 * The `spawner-sealable-room` AI-runner preset drops the player in a small
 * starter side room separated from the spawner's arena room by a single
 * doorway. The player must be able to path THROUGH that doorway to reach the
 * arena.
 *
 * An entity-backed door that starts CLOSED can never auto-open: `doorSystem`
 * only auto-opens tile-only doors, and re-closes any unlocked `DoorState`
 * entity whose component `logicalOpen` is 0 every tick. So a closed-but-unlocked
 * entity door leaves the AI stuck at the doorway forever and the arena never
 * arms (the "door is locked / no arena room beyond" bug). The preset therefore
 * starts the door OPEN; the arena locks it behind the player on arming.
 *
 * Guards:
 *   - the doorway tile starts passable (DOOR_OPEN),
 *   - driving the real BT AI + simulation-step, the arena arms AND the door
 *     locks behind the player within a bounded frame budget.
 */
import { describe, expect, it } from 'vitest';
import { query } from 'bitecs';
import { DoorState, Position, Spawner } from '../../src/core/components.js';
import { createGameWorld, spawnPlayer } from '../../src/core/index.js';
import { runSimulationStep } from '../../src/game/ai/simulation-step.js';
import { getScenarioDefinition } from '../../src/game/scenarioDefinitions.js';
import { BehaviorTreeAI } from '../../src/game/ai/index.js';
import { getAiRunnerScenarioPreset } from '../../src/labs/ai-runner-lab/scenario-presets.js';
import { createInputState } from '../../src/shared/input.js';
import { GAME } from '../../src/shared/constants.js';
import type { GameWorld } from '../../src/core/world.js';

const PRESET_ID = 'spawner-sealable-room';

function bootPreset(seed: number): { world: GameWorld; playerEid: number; spawnerEid: number } {
  const world = createGameWorld({ seed });
  const playerEid = spawnPlayer(world, 400, 400);
  const scenario = getScenarioDefinition('floor1');
  scenario.configureWorld(world, playerEid);
  if (world.state === 'loadout' && world.floor) {
    scenario.selectLoadoutOption?.(world, 0);
  }
  const preset = getAiRunnerScenarioPreset(PRESET_ID);
  expect(preset, `preset ${PRESET_ID} must exist`).toBeTruthy();
  preset!.configureWorld!(world, playerEid);
  const spawnerEid = query(world.ecs, [Spawner, Position])[0]!;
  return { world, playerEid, spawnerEid };
}

describe('spawner-sealable-room lab preset — arena entry', () => {
  it('starts the doorway passable and the door entity open', () => {
    const { world } = bootPreset(1);
    const floorMap = world.floorMap!;
    const doorEid = query(world.ecs, [DoorState])[0];
    expect(doorEid, 'sealable-room preset must create a door entity').not.toBeUndefined();
    const dtx = world.stores.doorState.tileX[doorEid!]!;
    const dty = world.stores.doorState.tileY[doorEid!]!;
    // The doorway tile must be passable so the AI can path through it, and the
    // door entity must start OPEN so doorSystem keeps it open on approach.
    expect(floorMap.tileMap.isPassable(dtx, dty)).toBe(true);
    expect(world.stores.doorState.logicalOpen[doorEid!]).toBe(1);
    expect(world.stores.doorState.isLocked[doorEid!]).toBe(0);
  });

  // A few seeds so a lucky-path pass can't hide a regression. The starter room
  // is tiny, so entry + arming happens well within the budget on every seed.
  it.each([4206, 11, 777])(
    'AI walks through the doorway; arena arms and the door locks behind it (seed %i)',
    (seed) => {
      const { world, playerEid, spawnerEid } = bootPreset(seed);
      const floorMap = world.floorMap!;
      const doorEid = query(world.ecs, [DoorState])[0]!;

      const ai = new BehaviorTreeAI({
        seed,
        aggression: 1,
        retreatThreshold: 0.15,
      });
      const inputState = createInputState();
      // Keep the AI alive so ambient contact damage can't end the run before it
      // reaches the doorway — we're testing entry, not survival.
      world.stores.health.max[playerEid] = 100_000;

      let armedFrame = -1;
      const BUDGET = 300;
      for (let frame = 0; frame < BUDGET; frame += 1) {
        world.stores.health.current[playerEid] = 100_000;
        ai.poll(inputState, world);
        runSimulationStep(world, inputState, GAME.DELTA_MS);
        if ((world.stores.spawner.arenaState[spawnerEid] ?? 0) === 1) {
          armedFrame = frame;
          break;
        }
      }

      expect(armedFrame, 'arena must arm within the frame budget').toBeGreaterThanOrEqual(0);
      // Once armed, the arena locks the doorway behind the player.
      expect(world.stores.doorState.isLocked[doorEid]).toBe(1);
      // The player is inside the spawner's arena room (room id 0).
      const px = world.stores.position.x[playerEid]!;
      const py = world.stores.position.y[playerEid]!;
      const pt = floorMap.worldToTile(px, py);
      const sx = world.stores.position.x[spawnerEid]!;
      const sy = world.stores.position.y[spawnerEid]!;
      const st = floorMap.worldToTile(sx, sy);
      expect(floorMap.roomGraph.getRoomAt(pt.x, pt.y)).toBe(
        floorMap.roomGraph.getRoomAt(st.x, st.y),
      );
    },
  );
});
