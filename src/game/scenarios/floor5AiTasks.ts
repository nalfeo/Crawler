import {
  computeSiegeCastleLayout,
  siegeCastleOptionsFromConfig,
} from '../../core/map/generators/SiegeCastleGenerator.js';
import type { LocationId } from '../ai/objective-route-planner.js';
import {
  buildScenarioGoalGraph,
  type ScenarioAiTaskConfig,
  validateScenarioAiTaskConfig,
} from '../ai/scenario-ai-tasks.js';
import type { RunPlannerPoint } from '../ai/run-planner.js';
import { buildFloor5MapConfig } from '../floor5Scenario.js';

export interface Floor5AiRouteSnapshot {
  readonly openingPushRepelled: boolean;
  readonly yardSecured: boolean;
  readonly componentsReady: boolean;
  readonly ramBuilt: boolean;
  readonly checkpointCleared: boolean;
  readonly wallBreached: boolean;
  readonly breachEntered: boolean;
  readonly courtyardCleared: boolean;
  readonly regentDefeated: boolean;
  readonly castleCaptured: boolean;
}

type Floor5Task = ScenarioAiTaskConfig<
  Floor5AiRouteSnapshot,
  Record<string, never>
>['tasks'][number];

const TASKS: readonly Floor5Task[] = [
  {
    id: 'defend-command-post',
    chainId: 'siege',
    present: (s) => !s.openingPushRepelled,
    required: true,
    unlockEffects: ['floor5.siege.openingPushRepelled'],
    meta: { label: 'Repel opening push', kind: 'work', phase: 'pre-chain' },
    detail: () => 'Hold the Command Post while the siege lane comes online',
    workCost: () => 0,
    location: () => 'commandPost',
    operation: {
      kind: 'engage',
      location: 'commandPost',
      reason: 'Defending the Command Post',
      phaseTag: 'siege',
    },
    questRef: null,
  },
  {
    id: 'secure-siege-yard',
    chainId: 'siege',
    present: (s) => !s.yardSecured,
    required: true,
    unlockEffects: ['floor5.siege.yardSecured'],
    meta: { label: 'Secure Siege Yard', kind: 'travel', phase: 'shop' },
    detail: () => 'Reach the siege yard staging ground',
    workCost: () => 0,
    location: () => 'siegeYard',
    operation: {
      kind: 'move_to',
      location: 'siegeYard',
      reason: 'Securing the Siege Yard',
      phaseTag: 'siege',
    },
    questRef: null,
  },
  {
    id: 'recover-ram-components',
    chainId: 'siege',
    present: (s) => !s.componentsReady,
    required: true,
    unlockEffects: ['floor5.siege.componentsReady'],
    meta: { label: 'Recover Ram components', kind: 'travel', phase: 'shop' },
    detail: () => 'Recover the authored Ratings Ram component set',
    workCost: () => 0,
    location: () => 'componentPocket',
    operation: {
      kind: 'move_to',
      location: 'componentPocket',
      reason: 'Recovering Ratings Ram components',
      phaseTag: 'siege',
    },
    questRef: null,
  },
  {
    id: 'clear-forward-checkpoint',
    chainId: 'siege',
    present: (s) => !s.checkpointCleared,
    required: true,
    unlockEffects: ['floor5.siege.checkpointCleared'],
    meta: { label: 'Clear checkpoint', kind: 'travel', phase: 'other' },
    detail: () => 'Clear the forward checkpoint pocket',
    workCost: () => 0,
    location: () => 'checkpointPocket',
    operation: {
      kind: 'engage',
      location: 'checkpointPocket',
      reason: 'Clearing the forward checkpoint',
      phaseTag: 'siege',
    },
    questRef: null,
  },
  {
    id: 'build-ratings-ram',
    chainId: 'siege',
    present: (s) => !s.ramBuilt,
    required: true,
    unlockEffects: ['floor5.siege.ramBuilt'],
    meta: { label: 'Build Ratings Ram', kind: 'work', phase: 'shop' },
    detail: () => 'Authorize and build the Ratings Ram',
    workCost: () => 0,
    location: () => 'siegeYard',
    operation: { kind: 'ambient' },
    questRef: null,
  },
  {
    id: 'escort-ratings-ram',
    chainId: 'siege',
    present: (s) => !s.wallBreached,
    required: true,
    unlockEffects: ['floor5.siege.wallBreached'],
    meta: { label: 'Escort Ratings Ram', kind: 'travel', phase: 'other' },
    detail: () => 'Escort the Ratings Ram along the primary lane',
    workCost: () => 0,
    location: () => 'breachSite',
    operation: {
      kind: 'move_to',
      location: 'breachSite',
      reason: 'Escorting the Ratings Ram',
      phaseTag: 'siege',
    },
    questRef: null,
  },
  {
    id: 'enter-breach',
    chainId: 'siege',
    present: (s) => !s.breachEntered,
    required: true,
    unlockEffects: ['floor5.siege.breachEntered'],
    meta: { label: 'Enter breach', kind: 'travel', phase: 'other' },
    detail: () => 'Move through the authored breach site',
    workCost: () => 0,
    location: () => 'breachSite',
    operation: {
      kind: 'move_to',
      location: 'breachSite',
      reason: 'Entering the breach',
      phaseTag: 'siege',
    },
    questRef: null,
  },
  {
    id: 'clear-courtyard',
    chainId: 'siege',
    present: (s) => !s.courtyardCleared,
    required: true,
    unlockEffects: ['floor5.siege.courtyardCleared'],
    meta: { label: 'Clear courtyard', kind: 'boss', phase: 'other' },
    detail: () => 'Clear the Crown Auditor courtyard handoff',
    workCost: () => 0,
    location: () => 'courtyard',
    operation: {
      kind: 'engage',
      location: 'courtyard',
      reason: 'Clearing the courtyard',
      phaseTag: 'siege',
    },
    questRef: null,
  },
  {
    id: 'defeat-regent',
    chainId: 'siege',
    present: (s) => !s.regentDefeated,
    required: true,
    unlockEffects: ['floor5.siege.regentDefeated'],
    meta: { label: 'Defeat Regent', kind: 'boss', phase: 'other' },
    detail: () => 'Defeat Regent Emeritus in the throne room',
    workCost: () => 0,
    location: () => 'throneRoom',
    operation: {
      kind: 'engage',
      location: 'throneRoom',
      reason: 'Confronting Regent Emeritus',
      phaseTag: 'siege',
    },
    questRef: null,
  },
  {
    id: 'capture-throne',
    chainId: 'siege',
    present: (s) => !s.castleCaptured,
    required: true,
    unlockEffects: ['floor5.siege.castleCaptured'],
    meta: { label: 'Capture throne', kind: 'travel', phase: 'other' },
    detail: () => 'Complete the distinct throne-capture transaction',
    workCost: () => 0,
    location: () => 'throneRoom',
    operation: {
      kind: 'move_to',
      location: 'throneRoom',
      reason: 'Capturing the throne',
      phaseTag: 'siege',
    },
    questRef: null,
  },
];

function tileCenter(
  bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
  tileSizeFt: number,
): RunPlannerPoint {
  return {
    x: (bounds.x + Math.floor(bounds.width / 2)) * tileSizeFt,
    y: (bounds.y + Math.floor(bounds.height / 2)) * tileSizeFt,
  };
}

export const FLOOR5_AI_TASK_CONFIG: ScenarioAiTaskConfig<
  Floor5AiRouteSnapshot,
  Record<string, never>
> = {
  scenarioId: 'floor5',
  tasks: TASKS,
  chains: [{ id: 'siege', taskIds: TASKS.map((task) => task.id), anchorChainIds: [] }],
  locationIds: [
    'commandPost',
    'siegeYard',
    'componentPocket',
    'checkpointPocket',
    'breachSite',
    'courtyard',
    'throneRoom',
  ],
  npcIds: [],
  unlockEffectVocabulary: [
    'floor5.siege.openingPushRepelled',
    'floor5.siege.yardSecured',
    'floor5.siege.componentsReady',
    'floor5.siege.ramBuilt',
    'floor5.siege.checkpointCleared',
    'floor5.siege.wallBreached',
    'floor5.siege.breachEntered',
    'floor5.siege.courtyardCleared',
    'floor5.siege.regentDefeated',
    'floor5.siege.castleCaptured',
  ],
  phaseTagVocabulary: ['siege'],
  interactionActionVocabulary: [],
  farmStrategyVocabulary: [],
  buildLocations: () => {
    const mapConfig = buildFloor5MapConfig();
    const layout = computeSiegeCastleLayout(siegeCastleOptionsFromConfig(mapConfig));
    return new Map<LocationId, RunPlannerPoint>([
      ['commandPost', tileCenter(layout.commandPost, mapConfig.tileSizeFt)],
      ['siegeYard', tileCenter(layout.siegeYard, mapConfig.tileSizeFt)],
      ['componentPocket', tileCenter(layout.componentPocket, mapConfig.tileSizeFt)],
      ['checkpointPocket', tileCenter(layout.checkpointPocket, mapConfig.tileSizeFt)],
      ['breachSite', tileCenter(layout.breachSite, mapConfig.tileSizeFt)],
      ['courtyard', tileCenter(layout.courtyard, mapConfig.tileSizeFt)],
      ['throneRoom', tileCenter(layout.throneRoom, mapConfig.tileSizeFt)],
    ]);
  },
};

validateScenarioAiTaskConfig(FLOOR5_AI_TASK_CONFIG);

export function buildFloor5AiRouteGraph(snapshot: Floor5AiRouteSnapshot) {
  return buildScenarioGoalGraph(FLOOR5_AI_TASK_CONFIG, snapshot);
}
