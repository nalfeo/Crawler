import type { GameWorld } from '../core/world.js';
import { getFloorManifest } from '../shared/floor-registry.js';
import { initializeFloor1Scenario, selectFloor1StarterWeapon } from './floorScenario.js';
import { initializeFloor2Scenario } from './floor2Scenario.js';
import type { PlayerCarryoverSnapshot } from './playerCarryover.js';

export interface ScenarioInitializationOptions {
  readonly playerCarryover?: PlayerCarryoverSnapshot;
}

export interface ScenarioDefinition {
  readonly floorId: string;
  readonly configureWorld: (
    world: GameWorld,
    playerEid: number,
    options?: ScenarioInitializationOptions,
  ) => void;
  readonly selectLoadoutOption?: (world: GameWorld, optionIndex: number) => void;
  readonly director: {
    readonly intro: string;
    readonly victory: string;
    readonly timeout?: string;
  };
}

const FLOOR_1_DIRECTOR = {
  intro: 'Floor 1 opens. {playerName} enters the dungeon and the cameras are rolling.',
  victory: 'Floor 1 cleared. Queueing the transfer to the next floor.',
  timeout: 'Time expired before the stairs. Floor 1 run ends here.',
} as const;

const FLOOR_2_DIRECTOR = {
  intro: 'Floor 2 opens: families feud over the Mother Lode. Pick allies or wipe the board.',
  victory: 'Floor 2 secured. The tunnel network is yours — roll stairs for the next segment.',
  timeout: 'The floor collapsed before a side won. The Director calls the run.',
} as const;

const SCENARIOS: ReadonlyMap<string, ScenarioDefinition> = new Map([
  [
    'floor1',
    {
      floorId: 'floor1',
      configureWorld: initializeFloor1Scenario,
      selectLoadoutOption: selectFloor1StarterWeapon,
      director: FLOOR_1_DIRECTOR,
    },
  ],
  [
    'floor2',
    {
      floorId: 'floor2',
      configureWorld: initializeFloor2Scenario,
      director: FLOOR_2_DIRECTOR,
    },
  ],
]);

export function getScenarioDefinition(floorId: string): ScenarioDefinition {
  const scenario = SCENARIOS.get(floorId);
  if (scenario) {
    return scenario;
  }
  const manifest = getFloorManifest(floorId);
  if (manifest) {
    throw new Error(
      `No scenario definition registered for floor manifest: ${floorId}. Add it to SCENARIOS in src/game/scenarioDefinitions.ts`,
    );
  }
  throw new Error(`No scenario definition found for floor: ${floorId}`);
}
