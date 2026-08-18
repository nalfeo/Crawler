import type { GameWorld } from '../core/world.js';
import type { CoreSimulationSystem } from '../core/simulation-core-step.js';
import { getFloorManifest } from '../shared/floor-registry.js';
import { MERCHANTS_CHARM_DEF } from '../shared/equipmentDefs.js';
import type { NpcQuestIndicatorState, ShopkeeperStage } from '../shared/quest-types.js';
import {
  confirmFloor1StairDescend,
  equipPurchasedGear,
  getNpcQuestIndicatorState,
  getShopkeeperPostQuestStock,
  getShopkeeperStage,
  hasCompletedWelcomeGoonQuest,
  initializeFloor1Scenario,
  meetShopkeeper,
  meetSpellQuestGiver,
  meetTutorialGoon,
  purchaseShopkeeperEquipment,
  purchaseShopkeeperPostQuestItem,
  getSpellBrokerOffers,
  canPurchaseSpellBrokerSpell,
  purchaseSpellBrokerSpell,
  returnShopkeeperPrize,
  selectFloor1StarterWeapon,
  SHOPKEEPER_EQUIPMENT_COST,
  floor1EnemyDirectorSystem,
  floor1PlayerStatSystem,
} from './floorScenario.js';
import {
  confirmFloor2StairDescend,
  floor2VictorySystem,
  initializeFloor2Scenario,
  meetBroker,
} from './floor2Scenario.js';
import { emergentEventSystem } from './systems/emergentEventSystem.js';
import { familyFeudSystem } from './systems/familyFeudSystem.js';
import type { PlayerCarryoverSnapshot } from './playerCarryover.js';
import type { Floor1SpellBrokerOffer } from '../shared/floor-types.js';

export interface ScenarioInitializationOptions {
  readonly playerCarryover?: PlayerCarryoverSnapshot;
}

/**
 * Quest-giver callbacks a scenario exposes to the presentation layer.
 *
 * These shapes mirror the matching option blocks on
 * `MainGameSceneOptions` (engine layer); they are declared here because
 * `src/game/` must not import from `src/engine/`.
 */
export interface ScenarioNpcCallbacks {
  readonly shopkeeper?: {
    readonly getIndicatorState?: (world: GameWorld) => NpcQuestIndicatorState;
    readonly getStage: (world: GameWorld) => ShopkeeperStage;
    readonly meet: (world: GameWorld) => void;
    readonly returnPrize: (world: GameWorld, playerEid: number) => boolean;
    readonly purchase: (world: GameWorld, playerEid: number) => boolean;
    readonly getPostQuestStock?: (
      world: GameWorld,
    ) => ReadonlyArray<{ itemId: string; cost: number }>;
    readonly purchasePostQuestItem?: (
      world: GameWorld,
      playerEid: number,
      itemId: string,
    ) => boolean;
    readonly equip: (world: GameWorld, playerEid: number) => boolean;
    readonly equipmentCost: number;
    readonly equipmentName: string;
    readonly isLocked?: (world: GameWorld) => boolean;
  };
  readonly tutorialGoon?: {
    readonly getIndicatorState?: (world: GameWorld) => NpcQuestIndicatorState;
    readonly meet: (world: GameWorld) => void;
  };
  readonly spellQuestGiver?: {
    readonly getIndicatorState?: (world: GameWorld) => NpcQuestIndicatorState;
    readonly meet: (world: GameWorld) => void;
    readonly isLocked?: (world: GameWorld) => boolean;
    readonly getSpellBrokerOffers?: (world: GameWorld) => readonly Floor1SpellBrokerOffer[];
    readonly canPurchaseSpell?: (world: GameWorld, playerEid: number, spellId: string) => boolean;
    readonly purchaseSpell?: (world: GameWorld, playerEid: number, spellId: string) => boolean;
  };
  readonly broker?: {
    readonly met: (world: GameWorld) => void;
  };
}

export interface ScenarioDefinition {
  readonly floorId: string;
  readonly beforeWeaponSystems?: ReadonlyArray<CoreSimulationSystem>;
  readonly beforeEnemyAISystems?: ReadonlyArray<CoreSimulationSystem>;
  readonly afterSpawnerSystems?: ReadonlyArray<CoreSimulationSystem>;
  readonly configureWorld: (
    world: GameWorld,
    playerEid: number,
    options?: ScenarioInitializationOptions,
  ) => void;
  readonly selectLoadoutOption?: (world: GameWorld, optionIndex: number) => void;
  /** Confirms a stair descend attempt; returns false when the floor is not clear. */
  readonly onStairDescend?: (world: GameWorld, playerEid: number) => boolean | void;
  /**
   * Floor this scenario transitions into once its stairs are taken. When set,
   * the bootstrap layer builds the in-process floor-transition callback; when
   * omitted, clearing the floor ends the run.
   */
  readonly nextFloorId?: string;
  /** Quest-giver callbacks this floor exposes to the scene. */
  readonly npcs?: ScenarioNpcCallbacks;
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

const FLOOR_1_NPCS: ScenarioNpcCallbacks = {
  shopkeeper: {
    getIndicatorState: (world: GameWorld) => getNpcQuestIndicatorState(world, 'shopkeeper'),
    getStage: getShopkeeperStage,
    meet: meetShopkeeper,
    returnPrize: returnShopkeeperPrize,
    purchase: purchaseShopkeeperEquipment,
    getPostQuestStock: getShopkeeperPostQuestStock,
    purchasePostQuestItem: purchaseShopkeeperPostQuestItem,
    equip: equipPurchasedGear,
    equipmentCost: SHOPKEEPER_EQUIPMENT_COST,
    equipmentName: MERCHANTS_CHARM_DEF.name,
    isLocked: (world: GameWorld) => !hasCompletedWelcomeGoonQuest(world),
  },
  tutorialGoon: {
    meet: meetTutorialGoon,
    getIndicatorState: (world: GameWorld) => getNpcQuestIndicatorState(world, 'tutorial-goon'),
  },
  spellQuestGiver: {
    getIndicatorState: (world: GameWorld) => getNpcQuestIndicatorState(world, 'spell-quest-giver'),
    meet: meetSpellQuestGiver,
    isLocked: (world: GameWorld) => !hasCompletedWelcomeGoonQuest(world),
    getSpellBrokerOffers,
    canPurchaseSpell: canPurchaseSpellBrokerSpell,
    purchaseSpell: purchaseSpellBrokerSpell,
  },
};

const FLOOR_2_NPCS: ScenarioNpcCallbacks = {
  broker: { met: meetBroker },
};

const SCENARIOS: ReadonlyMap<string, ScenarioDefinition> = new Map([
  [
    'floor1',
    {
      floorId: 'floor1',
      configureWorld: initializeFloor1Scenario,
      selectLoadoutOption: selectFloor1StarterWeapon,
      onStairDescend: confirmFloor1StairDescend,
      nextFloorId: 'floor2',
      npcs: FLOOR_1_NPCS,
      beforeWeaponSystems: [floor1PlayerStatSystem],
      afterSpawnerSystems: [floor1EnemyDirectorSystem],
      director: FLOOR_1_DIRECTOR,
    },
  ],
  [
    'floor2',
    {
      floorId: 'floor2',
      configureWorld: initializeFloor2Scenario,
      onStairDescend: confirmFloor2StairDescend,
      npcs: FLOOR_2_NPCS,
      beforeWeaponSystems: [floor2VictorySystem, emergentEventSystem],
      beforeEnemyAISystems: [familyFeudSystem],
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
