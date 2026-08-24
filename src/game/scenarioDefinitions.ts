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
import {
  confirmFloor3StairDescend,
  FLOOR3_STAIRS_DISCOVERED_GOAL_ID,
  FLOOR3_TIMEOUT_GOAL_ID,
  FLOOR3_VICTORY_GOAL_ID,
  floor3WildDirectorSystem,
  initializeFloor3Scenario,
} from './floor3Scenario.js';
import {
  FLOOR4_STALL_BACKSTOP_GOAL_ID,
  arenaDirectorSystem,
  confirmFloor4StairDescend,
  initializeFloor4Scenario,
  isFloor4ArenaVictory,
} from './floor4Scenario.js';
import { emergentEventSystem } from './systems/emergentEventSystem.js';
import { companionAISystem } from './systems/companionAISystem.js';
import { familyFeudSystem } from './systems/familyFeudSystem.js';
import type { PlayerCarryoverSnapshot } from './playerCarryover.js';
import type { Floor1SpellBrokerOffer } from '../shared/floor-types.js';
import type { ErasedScenarioAiTaskConfig } from './ai/scenario-ai-tasks.js';
import { FLOOR1_AI_TASK_CONFIG } from './scenarios/floor1AiTasks.js';

export interface ScenarioInitializationOptions {
  readonly playerCarryover?: PlayerCarryoverSnapshot;
}

function getFloor3CompletionCopy(variant: ScenarioCompletionVariant): ScenarioCompletionCopy {
  if (variant === 'failed_timeout') {
    return {
      title: 'Game Over',
      subtitle: 'Floor 3 failed',
      body: 'The Companion League timer expired.\nRally your party and reach the objective faster.',
    };
  }
  return {
    title: 'Victory!',
    subtitle: 'Floor 3 complete!',
    body: 'The Final Four are down — you are the Companion League champion!\nMore floors coming soon...',
  };
}

/**
 * Floor 4 completion copy.
 *
 * `failed_timeout` here is NOT "the player ran out of time" — Floor 4 shows no
 * countdown (FR5.6). It is the raw stall backstop (FR8.4), which only fires on
 * an abandoned or non-terminating broadcast, so the copy names that instead of
 * blaming the player for being slow.
 */
function getFloor4CompletionCopy(variant: ScenarioCompletionVariant): ScenarioCompletionCopy {
  if (variant === 'failed_timeout') {
    return {
      title: 'Broadcast Abandoned',
      subtitle: 'Floor 4 went dark',
      body: 'The Main Event ran past its broadcast window with no result.\nThe Director cut the feed and called the run.',
    };
  }
  return {
    title: 'Floor 4 In Progress',
    subtitle: 'Venue slice',
    body: 'The Main Event venue is wired, but the acts, waves and Headliners have not been staged yet.',
  };
}

function getFloor4RunOutcome(world: GameWorld): ScenarioRunOutcome | null {
  if (world.goalFlags.get(FLOOR4_STALL_BACKSTOP_GOAL_ID) === true) {
    return 'failed_timeout';
  }
  return isFloor4ArenaVictory(world) ? 'cleared_floor' : null;
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
  /**
   * Scenario-owned AI task overlay driving the headless/BT run planner. When
   * present, ALL Floor-specific task construction, ordering, prerequisite,
   * unlock-effect, and runtime-eligibility policy lives here as validated
   * config rather than in `src/game/ai/`. Optional so labs/harnesses and
   * floors without an authored AI route stay valid without one.
   */
  readonly aiTaskConfig?: ErasedScenarioAiTaskConfig;
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

function getFloor3RunOutcome(world: GameWorld): ScenarioRunOutcome | null {
  if (world.goalFlags.get(FLOOR3_STAIRS_DISCOVERED_GOAL_ID) === true) {
    return 'cleared_floor';
  }
  return world.goalFlags.get(FLOOR3_TIMEOUT_GOAL_ID) === true ? 'failed_timeout' : null;
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

/** Floor 3's stair marker, reusing the live `floor3Studios` position (no copy). */
function getFloor3StairMarkerState(world: GameWorld): ScenarioStairMarkerState | null {
  const studiosState = world.floorExtendedState?.floor3Studios;
  if (!studiosState?.staircasePos) {
    return null;
  }
  return {
    positionFt: studiosState.staircasePos,
    radiusFt: FLOOR2_STAIR_MARKER_RADIUS_FT,
    visible: studiosState.staircaseSpawned === true && studiosState.staircaseDiscovered !== true,
    // Same rule as Floor 1/2: `confirmFloor3StairDescend` rejects unless
    // `staircaseUnlocked` is set, so the prompt must be withheld until then.
    locked: studiosState.staircaseUnlocked !== true,
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
 * Floor 2's completion-screen copy. Floor 2 now declares
 * `nextFloorId: 'floor3'`, so the variant it actually reaches is
 * `transition_to_next_floor` — clearing Floor 2 hands the player to the
 * Companion League wilds instead of ending the run. `failed_timeout` is
 * unreachable for Floor 2 today (no wired timeout path at this layer), and the
 * two terminal variants are only reachable when Floor 2 is booted WITHOUT a
 * floor-transition callback (labs/harnesses); both keep copy consistent with
 * Floor 2's own identity.
 */
function getFloor2CompletionCopy(variant: ScenarioCompletionVariant): ScenarioCompletionCopy {
  switch (variant) {
    case 'failed_timeout':
      return {
        title: 'Game Over',
        subtitle: 'Floor 2 failed',
        body: 'The floor collapsed before the exit was secured.\nTry again and rally the families faster.',
      };
    case 'transition_to_next_floor':
      return {
        title: 'Floor 2 Complete!',
        subtitle: 'Heading to Floor 3...',
        body: 'The Companion League wilds are waiting below!',
      };
    case 'terminal_victory':
    case 'terminal_complete':
      return {
        title: 'Floor 2 Complete!',
        subtitle: 'Floor 2 complete!',
        body: 'You secured the tunnel network.\nMore floors coming soon...',
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
  title: 'Proceed to the next floor?',
  subtitle: 'You are at the exit.',
  body: 'Floor 2 is cleared. Are you ready to descend to Floor 3?',
  confirmLabel: 'Yes, descend now',
  confirmDescription: 'Start Floor 3.',
};

const FLOOR_3_STAIR_CONFIRMATION: ScenarioStairConfirmationCopy = {
  title: 'Victory! Ready to exit?',
  subtitle: 'You are at the extraction point.',
  body: 'The Final Four are defeated. Are you ready to exit the Companion League?',
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

const FLOOR_3_DIRECTOR: ScenarioDirectorContract<GameWorld> = {
  intro: 'Floor 3 opens: the Companion League wilds are live across seven biome territories.',
  victory: 'The Final Four are down. The Companion League crowns its champion.',
  timeout: 'The Companion League timer expired. The Director calls the run.',
  milestones: [],
  isVictoryReached: (world: GameWorld) => world.goalFlags.get(FLOOR3_VICTORY_GOAL_ID) === true,
  isTimeoutReached: (world: GameWorld) => world.goalFlags.get(FLOOR3_TIMEOUT_GOAL_ID) === true,
};

const FLOOR_4_DIRECTOR: ScenarioDirectorContract<GameWorld> = {
  intro: 'Floor 4 opens: the house lights come up on an empty Main Event stage.',
  victory: 'Floor 4 is not winnable yet; this slice only builds the venue.',
  timeout: 'The Main Event never started. The Director cuts the feed.',
  milestones: [],
  isVictoryReached: () => false,
  isTimeoutReached: (world: GameWorld) =>
    world.goalFlags.get(FLOOR4_STALL_BACKSTOP_GOAL_ID) === true,
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
      aiTaskConfig: FLOOR1_AI_TASK_CONFIG,
    },
  ],
  [
    'floor2',
    {
      floorId: 'floor2',
      configureWorld: initializeFloor2Scenario,
      onStairDescend: confirmFloor2StairDescend,
      nextFloorId: 'floor3',
      npcs: FLOOR_2_NPCS,
      beforeWeaponSystems: [floor2VictorySystem, emergentEventSystem],
      beforeEnemyAISystems: [companionAISystem, familyFeudSystem],
      director: FLOOR_2_DIRECTOR,
      getRunOutcome: getFloor2RunOutcome,
      // Clearing Floor 2 now descends into Floor 3 rather than ending the run,
      // so a Floor 2 clear is a transition, not a terminal run victory. The
      // flag still matters for hosts that boot Floor 2 without a transition
      // callback (labs), where the run genuinely ends there.
      isTerminalRunVictory: false,
      getCompletionCopy: getFloor2CompletionCopy,
      getStairMarkerState: getFloor2StairMarkerState,
      stairConfirmation: FLOOR_2_STAIR_CONFIRMATION,
    },
  ],
  [
    'floor3',
    {
      floorId: 'floor3',
      configureWorld: initializeFloor3Scenario,
      onStairDescend: confirmFloor3StairDescend,
      beforeEnemyAISystems: [companionAISystem],
      afterSpawnerSystems: [floor3WildDirectorSystem],
      director: FLOOR_3_DIRECTOR,
      getRunOutcome: getFloor3RunOutcome,
      isTerminalRunVictory: true,
      getCompletionCopy: getFloor3CompletionCopy,
      getStairMarkerState: getFloor3StairMarkerState,
      stairConfirmation: FLOOR_3_STAIR_CONFIRMATION,
    },
  ],
  [
    'floor4',
    {
      floorId: 'floor4',
      configureWorld: initializeFloor4Scenario,
      // No `nextFloorId`: Floor 4 is currently the last authored floor, and its
      // stairs are barred until the slice-5 intermission exists anyway.
      onStairDescend: confirmFloor4StairDescend,
      afterSpawnerSystems: [arenaDirectorSystem],
      director: FLOOR_4_DIRECTOR,
      getRunOutcome: getFloor4RunOutcome,
      isTerminalRunVictory: false,
      getCompletionCopy: getFloor4CompletionCopy,
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

/**
 * True when `floorId` can actually be booted: it has both a registered floor
 * manifest and a scenario definition.
 *
 * This is deliberately weaker than `isFloorImplemented` (manifest
 * `implemented.mvp`), which additionally means "has an attainable victory".
 * A floor can be fully playable — generated, spawning, timed — while its
 * terminal objective is still unbuilt (Floor 3 today). Callers that chain
 * floors for PLAY use this; callers that decide what counts as a WIN must keep
 * using `isFloorImplemented`.
 */
export function isFloorPlayable(floorId: string): boolean {
  return SCENARIOS.has(floorId) && getFloorManifest(floorId) !== undefined;
}
