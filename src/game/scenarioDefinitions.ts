import type { GameWorld } from '../core/world.js';
import type { CoreSimulationSystem } from '../core/simulation-core-step.js';
import { getFloorManifest } from '../shared/floor-registry.js';
import { MERCHANTS_CHARM_DEF } from '../shared/equipmentDefs.js';
import { FLOOR2_STAIR_MARKER_RADIUS_FT } from '../shared/constants.js';
import type { NpcQuestIndicatorState, ShopkeeperStage } from '../shared/quest-types.js';
import type {
  ScenarioCompletionCopy,
  ScenarioCompletionVariant,
  ScenarioDirectorContract,
  ScenarioDirectorMilestone,
  ScenarioPresentationContract,
  ScenarioRunOutcome,
  ScenarioStairConfirmationCopy,
  ScenarioStairMarkerState,
} from '../shared/scenario-presentation.js';
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
import { companionAISystem } from './systems/companionAISystem.js';
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
  readonly director: ScenarioDirectorContract<GameWorld>;
  /**
   * Canonical terminal-outcome selector — pure with respect to `world`. This
   * is the SOLE input `selectScenarioCompletionVariant` consults to decide
   * whether/how a run has ended; no other field below re-derives it.
   */
  readonly getRunOutcome: (world: GameWorld) => ScenarioRunOutcome | null;
  /**
   * True when reaching a terminal `cleared_floor` outcome with no
   * `nextFloorId` should present as a genuine run-ending victory rather than
   * a generic "complete" screen. Static per scenario (never derived from
   * world shape at runtime) so completion-variant selection stays a pure
   * function of (`outcome`, `nextFloorId`, `isTerminalRunVictory`). Defaults
   * to `false` when omitted.
   */
  readonly isTerminalRunVictory?: boolean;
  /** Presentation copy for every completion-screen variant this scenario can reach. */
  readonly getCompletionCopy: (variant: ScenarioCompletionVariant) => ScenarioCompletionCopy;
  /**
   * Semantic stair-marker/proximity state, or `null` while there is nothing
   * to show (no stairs spawned yet, or this scenario has none). Optional —
   * labs/harnesses that omit a floor-exit stair entirely stay safe without it.
   */
  readonly getStairMarkerState?: (world: GameWorld) => ScenarioStairMarkerState | null;
  /** Presentation copy for the stair-descend confirmation prompt. Optional for the same reason as `getStairMarkerState`. */
  readonly stairConfirmation?: ScenarioStairConfirmationCopy;
}

/** Extracts the normalized presentation contract from a full scenario definition. */
export function getScenarioPresentationContract(
  scenario: ScenarioDefinition,
): ScenarioPresentationContract<GameWorld> {
  return {
    director: scenario.director,
    getRunOutcome: scenario.getRunOutcome,
    isTerminalRunVictory: scenario.isTerminalRunVictory,
    getCompletionCopy: scenario.getCompletionCopy,
    getStairMarkerState: scenario.getStairMarkerState,
    stairConfirmation: scenario.stairConfirmation,
    nextFloorId: scenario.nextFloorId,
  };
}

/**
 * Floor 1's canonical terminal outcome — the per-scenario replacement for the
 * engine's former structural `runSummary`-vs-`familyState` dual-path check.
 */
function getFloor1RunOutcome(world: GameWorld): ScenarioRunOutcome | null {
  const outcome = world.floorScenario?.runSummary?.outcome;
  return outcome === 'cleared_floor' || outcome === 'failed_timeout' ? outcome : null;
}

/**
 * Floor 2's canonical terminal outcome (Floor 2 has no wired timeout path at
 * this layer today, so only `cleared_floor` is reachable).
 */
function getFloor2RunOutcome(world: GameWorld): ScenarioRunOutcome | null {
  return world.floorExtendedState?.familyState?.staircaseDiscovered === true
    ? 'cleared_floor'
    : null;
}

/** Floor 1's stair marker, reusing the live `objective` position (no copy). */
function getFloor1StairMarkerState(world: GameWorld): ScenarioStairMarkerState | null {
  const objective = world.floorScenario?.objective;
  if (!objective) {
    return null;
  }
  return {
    positionFt: objective.staircasePos,
    radiusFt: objective.markerRadiusFt,
    visible: objective.staircaseSpawned && !objective.staircaseDiscovered,
    // `locked` must mean exactly "descent is barred", because the presentation
    // layer withholds the descend prompt while it is set and
    // `confirmFloor1StairDescend` rejects whenever `staircaseUnlocked` is
    // false. Deriving it from that same flag keeps prompt and confirmation
    // from ever disagreeing.
    locked: !objective.staircaseUnlocked,
    label: '▼ STAIRS',
  };
}

/** Floor 2's stair marker, reusing the live `familyState` position (no copy). */
function getFloor2StairMarkerState(world: GameWorld): ScenarioStairMarkerState | null {
  const familyState = world.floorExtendedState?.familyState;
  if (!familyState?.staircasePos) {
    return null;
  }
  return {
    positionFt: familyState.staircasePos,
    radiusFt: FLOOR2_STAIR_MARKER_RADIUS_FT,
    visible: familyState.staircaseSpawned === true && familyState.staircaseDiscovered !== true,
    // Same rule as Floor 1: `confirmFloor2StairDescend` rejects unless
    // `staircaseUnlocked` is set, so the prompt must be withheld until then.
    locked: familyState.staircaseUnlocked !== true,
    label: '▼ EXIT',
  };
}

/**
 * Exact copy of the four completion-screen variants Floor 1 can present,
 * matching `MainGameScene.showFloorCompletionScreenIfNeeded` verbatim for the
 * two variants Floor 1 actually reaches (`failed_timeout`,
 * `transition_to_next_floor` — Floor 1 always has a `nextFloorId`). The other
 * two variants are unreachable for Floor 1 today (it never ends without a
 * next floor); they fall back to the engine's existing generic "complete"
 * copy so the mapping stays total without inventing new observable behavior.
 */
function getFloor1CompletionCopy(variant: ScenarioCompletionVariant): ScenarioCompletionCopy {
  switch (variant) {
    case 'failed_timeout':
      return {
        title: 'Game Over',
        subtitle: 'Floor 1 failed',
        body: 'You ran out of time before reaching the stairs.\nTry again and move faster through objectives.',
      };
    case 'transition_to_next_floor':
      return {
        title: 'Floor 1 Complete!',
        subtitle: 'Heading to Floor 2...',
        body: 'Prepare yourself for the next challenge!',
      };
    case 'terminal_victory':
    case 'terminal_complete':
      return {
        title: 'Floor 1 Complete!',
        subtitle: 'Floor 1 complete!',
        body: 'Thanks for completing the first floor!\nMore game coming soon...',
      };
  }
}

/**
 * Exact copy of the completion-screen variant Floor 2 actually reaches
 * (`terminal_victory` — Floor 2 has no `nextFloorId` and is the authored
 * final floor), matching `MainGameScene.showFloorCompletionScreenIfNeeded`
 * verbatim. `failed_timeout` is unreachable for Floor 2 today (no wired
 * timeout path at this layer); it is given sensible copy consistent with
 * Floor 2's own identity rather than reusing Floor 1's wording, since nothing
 * observable depends on it yet.
 */
function getFloor2CompletionCopy(variant: ScenarioCompletionVariant): ScenarioCompletionCopy {
  switch (variant) {
    case 'failed_timeout':
      return {
        title: 'Game Over',
        subtitle: 'Floor 2 failed',
        body: 'The floor collapsed before the exit was secured.\nTry again and rally the families faster.',
      };
    case 'terminal_victory':
    case 'transition_to_next_floor':
    case 'terminal_complete':
      return {
        title: 'Victory!',
        subtitle: 'Floor 2 complete!',
        body: 'Congratulations — you escaped the dungeon!\nMore floors coming soon...',
      };
  }
}

const FLOOR_1_STAIR_CONFIRMATION: ScenarioStairConfirmationCopy = {
  title: 'Proceed to the next floor?',
  subtitle: 'You are at the stairs.',
  body: 'The boss is defeated. Are you ready to descend to the next floor?',
  confirmLabel: 'Yes, descend now',
  confirmDescription: 'Start Floor 2.',
};

const FLOOR_2_STAIR_CONFIRMATION: ScenarioStairConfirmationCopy = {
  title: 'Victory! Ready to exit?',
  subtitle: 'You are at the exit.',
  body: 'Floor 2 is cleared. Are you ready to exit the dungeon?',
  confirmLabel: 'Yes, exit now',
  confirmDescription: 'You win!',
};

/**
 * Ordered Floor 1 Director milestones, exact copy match for
 * `FLOOR_1_COMMENTARY` in `src/engine/scenes/MainGameScene.ts` (minus
 * `intro`/`staircaseDiscovered`/`timeout`, which remain the top-level
 * `intro`/`victory`/`timeout` fields below).
 */
const FLOOR_1_MILESTONES: ReadonlyArray<ScenarioDirectorMilestone<GameWorld>> = [
  {
    id: 'floor1-quest-accepted',
    copy: 'Tutorial Goon unlocks XP drops. First milestone: hit level 2 for the audience.',
    isReached: (world: GameWorld) => world.floorScenario?.objective.questAccepted === true,
  },
  {
    id: 'floor1-quest-completed',
    copy: 'Quota complete. Boss room is live for the next segment.',
    isReached: (world: GameWorld) => world.floorScenario?.objective.questCompleted === true,
  },
  {
    id: 'floor1-boss-battle-started',
    copy: 'Boss encounter started. This is the ratings spike moment.',
    isReached: (world: GameWorld) =>
      world.floorScenario?.objective.bossBattles.get('staircase')?.started === true,
  },
  {
    id: 'floor1-boss-defeated',
    copy: 'Boss down. Stairs unlocked and the crowd wants a clean finish.',
    isReached: (world: GameWorld) =>
      world.floorScenario?.objective.bossBattles.get('staircase')?.defeated === true,
  },
];

const FLOOR_1_DIRECTOR: ScenarioDirectorContract<GameWorld> = {
  intro: 'Floor 1 opens. {playerName} enters the dungeon and the cameras are rolling.',
  victory: 'Floor 1 cleared. Queueing the transfer to the next floor.',
  timeout: 'Time expired before the stairs. Floor 1 run ends here.',
  milestones: FLOOR_1_MILESTONES,
  isVictoryReached: (world: GameWorld) =>
    world.floorScenario?.objective.staircaseDiscovered === true,
  isTimeoutReached: (world: GameWorld) => world.floorScenario?.failReason === 'stair_timeout',
};

const FLOOR_2_DIRECTOR: ScenarioDirectorContract<GameWorld> = {
  intro: 'Floor 2 opens: families feud over the Mother Lode. Pick allies or wipe the board.',
  victory: 'Floor 2 secured. The tunnel network is yours — roll stairs for the next segment.',
  timeout: 'The floor collapsed before a side won. The Director calls the run.',
  milestones: [],
  isVictoryReached: (world: GameWorld) => world.goalFlags.get('floor2-victory') === true,
  isTimeoutReached: (world: GameWorld) => world.state === 'game_over',
};

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
      beforeEnemyAISystems: [companionAISystem],
      afterSpawnerSystems: [floor1EnemyDirectorSystem],
      director: FLOOR_1_DIRECTOR,
      getRunOutcome: getFloor1RunOutcome,
      isTerminalRunVictory: false,
      getCompletionCopy: getFloor1CompletionCopy,
      getStairMarkerState: getFloor1StairMarkerState,
      stairConfirmation: FLOOR_1_STAIR_CONFIRMATION,
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
      beforeEnemyAISystems: [companionAISystem, familyFeudSystem],
      director: FLOOR_2_DIRECTOR,
      getRunOutcome: getFloor2RunOutcome,
      isTerminalRunVictory: true,
      getCompletionCopy: getFloor2CompletionCopy,
      getStairMarkerState: getFloor2StairMarkerState,
      stairConfirmation: FLOOR_2_STAIR_CONFIRMATION,
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
