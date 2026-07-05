/**
 * AI Runner Lab
 *
 * Watch the AI play the game in real-time. Useful for:
 * - Debugging AI behavior
 * - Tuning AI parameters
 * - Showcasing the AI player
 * - Comparing AI vs human performance
 */
import GUI from 'lil-gui';
import Phaser from 'phaser';
import { createFloorGameConfig } from '../../bootstrap/floor-game-config.js';
import { query } from 'bitecs';
import { createFloorMainSceneOptions } from '../../bootstrap/floor-main-scene-options.js';
import { AIState, BehaviorTreeAI } from '../../game/ai/index.js';
import { AIPathingMode, type AIPathingModeValue } from '../../game/ai/types.js';
import {
  autoFloor1ProgressionSystem,
  computeAutoStatAllocation,
} from '../../game/ai/auto-progression.js';
import { getAvailableFloorIds } from '../../shared/floor-registry.js';
import type { SerializedBTNode } from '../../game/ai/behavior-tree.js';
import {
  acceptQuest,
  questSystem,
  setTrackedQuest,
  startFloor1BossEncounter,
} from '../../game/index.js';
import {
  Player,
  Enemy,
  Position,
  Health,
  XpGem,
  Gold,
  DroppedItem,
  Harvestable,
} from '../../core/index.js';
import type { GameWorld } from '../../core/world.js';
import { setGoalFlag } from '../../core/door-lock.js';
import { flowFieldStep, FLOW_UNREACHABLE } from '../../core/map/flow-field.js';
import { createInputCapture } from '../../engine/InputCapture.js';
import {
  DEFAULT_LIGHTING_CONFIG,
  type LightingConfig,
  type LightingPresetId,
} from '../../engine/lighting/light-field.js';
import {
  DEFAULT_FOV_SUB_FACTOR,
  MAX_FOV_SUB_FACTOR,
  subFactorToCellPx,
  type FovConfig,
  type FovPresetId,
} from '../../engine/fov/fov-config.js';
import { peekGroundFlowField } from '../../game/enemyAISystem.js';
import {
  FLOOR1_BOSS_BATTLE_QUEST_ID,
  FLOOR1_BOSS_UNLOCK_QUEST_ID,
  FLOOR1_SHOP_QUEST_ID,
  FLOOR1_TUTORIAL_QUEST_ID,
  getQuestDef,
  objectiveTarget,
} from '../../shared/quest-types.js';
import { WORLD_VFX_DEPTH } from '../../shared/render-depths.js';
import { ftToPx, pxToFt } from '../../shared/units.js';
import { loadLabState, saveLabState } from '../lab-persistence.js';
import { registerLab, type LabCategory } from '../registry.js';
import { createSessionRecorderControls } from '../session-recorder-controls.js';
import { buildSmoothedOverlayPath, OVERLAY_LINE_OF_SIGHT_SAMPLE_PX } from './path-overlay.js';

const LAB_ID = 'ai-runner-lab';
const INITIAL_SEED = 42;
const SPEED_OPTIONS = [1, 4, 16] as const;
const INVENTORY_PREVIEW_TICKS = 4;
type ControlsWithGui = HTMLElement & { __labGui?: GUI };

interface AiRunnerLabState {
  showFlowField: boolean;
  lighting: LightingConfig;
  fov: FovConfig;
  aiConfig: {
    pathingMode: AIPathingModeValue;
    visualRiskRewardFields: boolean;
    threatPreviewFrames: number;
    autoPauseOnDamage: boolean;
  };
}

/**
 * Live telemetry snapshot exposed on `window.__aiRunnerDebug()` for headless
 * test harnesses (e.g. Playwright). Mirrors the headless event-log `sample`
 * schema so a browser run can be aligned frame-for-frame against a headless run
 * of the same seed. Debug-only; lab scope, never shipped to the game build.
 */
export interface AiRunnerDebugSnapshot {
  frame: number | null;
  polls: number;
  paused: boolean;
  /** True when a human has taken over input from the AI runner. */
  manualControl: boolean;
  speed: number;
  scenePaused: boolean | null;
  worldState: string | null;
  gameMs: number | null;
  px: number | null;
  py: number | null;
  health: number | null;
  level: number;
  gold: number;
  spellsUnlocked: boolean;
  state: string;
  reason: string;
  targetEid: number | null;
  targetX: number | null;
  targetY: number | null;
  targetDist: number | null;
  stuckFrames: number;
  pathLen: number;
  pathIndex: number;
  moveX: number;
  moveY: number;
  nextWpX: number | null;
  nextWpY: number | null;
  pathGoalKey: string | null;
  npcMem: { discovered: string[]; talked: string[]; needed: number };
  conversationNpcEid: number | null;
  modalOpen: boolean;
  runOutcome: string | null;
  quests: Record<string, { status: string; done: number; total: number }>;
}

declare global {
  interface Window {
    __aiRunnerDebug?: () => AiRunnerDebugSnapshot;
  }
}

/**
 * Pick a fresh run seed from a non-simulation entropy source. Uses
 * `crypto.getRandomValues` (NOT `Math.random`/`Date.now`) so the lab harness
 * stays clear of the sim-determinism rules while still giving a varied seed.
 */
function randomRunSeed(): number {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return (buf[0] ?? 0) % 1_000_000;
}

interface RunnerSceneInternals {
  world?: GameWorld;
  playerEid?: number;
  modalPicker?: { isOpen(): boolean; close(): void };
  conversationNpcEid?: number | null;
  queuedInteraction?: boolean;
  requestInventoryToggle(): void;
  requestEquipAction(): void;
  isInventoryOpen(): boolean;
  setSimulationSpeed(speed: number): void;
  setSimulationPaused(paused: boolean): void;
  isSimulationPaused(): boolean;
  advanceSimulationFrames(frames?: number): void;
  setDebugFlag?(flag: string, enabled: boolean): void;
}

type JumpTarget =
  | 'spawn-room'
  | 'welcome-office'
  | 'slime-rat-room'
  | 'quest-item-room'
  | 'staircase-room'
  | 'spell-quest-giver'
  | 'shopkeeper'
  | 'boss-encounter';

const JUMP_TARGET_LABELS: Record<JumpTarget, string> = {
  'spawn-room': 'Spawn room',
  'welcome-office': 'Welcome office',
  'slime-rat-room': 'Slime Rat room',
  'quest-item-room': 'Quest item room',
  'staircase-room': 'Staircase/boss room',
  'spell-quest-giver': 'Spell quest giver NPC',
  shopkeeper: 'Shopkeeper NPC',
  'boss-encounter': 'Boss encounter (force)',
};

const QUEST_DEBUG_TARGETS = {
  'Tutorial: floor1-tutorial': FLOOR1_TUTORIAL_QUEST_ID,
  'Boss unlock: floor1-boss-unlock': FLOOR1_BOSS_UNLOCK_QUEST_ID,
  'Boss battle: floor1-boss-battle': FLOOR1_BOSS_BATTLE_QUEST_ID,
  'Shopkeeper errand: floor1-shopkeeper-errand': FLOOR1_SHOP_QUEST_ID,
} as const;

function createAiRunnerLab(canvas: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error(
      'Expected __labGui to be a GUI instance on controls. Ensure the lab runner initialized lil-gui before createAiRunnerLab runs.',
    );
  }
  const persisted = loadLabState<AiRunnerLabState>(LAB_ID);
  const lightingSettings: LightingConfig = {
    ...DEFAULT_LIGHTING_CONFIG,
    ...(persisted?.lighting ?? {}),
  };
  const lightingPerf = {
    computeMsAvg: 0,
    stepPx: lightingSettings.stepPx,
    updateEveryNFrames: lightingSettings.updateEveryNFrames,
  };
  const fovSettings: FovConfig = {
    subFactor: DEFAULT_FOV_SUB_FACTOR,
    cellPx: subFactorToCellPx(DEFAULT_FOV_SUB_FACTOR),
    discoveredLight: DEFAULT_LIGHTING_CONFIG.discoveredLight,
    ...(persisted?.fov ?? {}),
  };
  const fovPerf = {
    computeMsAvg: 0,
    lastComputeMs: 0,
    subFactor: fovSettings.subFactor,
    cellPx: fovSettings.cellPx,
  };
  const panelRoot = document.createElement('div');
  controls.append(panelRoot);
  let currentSeed = INITIAL_SEED;

  // AI configuration state
  const aiConfig = {
    pathingMode: (persisted?.aiConfig?.pathingMode ?? AIPathingMode.LEGACY) as AIPathingModeValue,
    visualRiskRewardFields: persisted?.aiConfig?.visualRiskRewardFields ?? false,
    threatPreviewFrames: persisted?.aiConfig?.threatPreviewFrames ?? 0,
    autoPauseOnDamage: persisted?.aiConfig?.autoPauseOnDamage ?? false,
  };

  let ai = new BehaviorTreeAI({
    seed: currentSeed,
    aggression: 1,
    retreatThreshold: 0.15,
    debug: true,
    pathingMode: aiConfig.pathingMode,
  });
  let selectedSpeed = 1;
  let isPaused = true;
  let manualControl = false;
  let hardwareInput: ReturnType<typeof createInputCapture> | null = null;
  let pollCount = 0;
  let lastObservedPlayerHealth: number | null = null;
  let pendingGearPreviewTicks = 0;
  let pendingGearEquipPreview = false;
  const lastMove = { x: 0, y: 0, action: false };
  let pathGraphics: Phaser.GameObjects.Graphics | null = null;
  let flowFieldGraphics: Phaser.GameObjects.Graphics | null = null;
  let riskRewardFieldsGraphics: Phaser.GameObjects.Graphics | null = null;
  let showFlowField = persisted?.showFlowField ?? false;
  let lastStepReason = '';
  const floorDebug = {
    showAllRooms: false,
    jumpTarget: 'spawn-room' as JumpTarget,
    questId: FLOOR1_TUTORIAL_QUEST_ID,
    questAction: 'accept' as 'accept' | 'complete',
  };
  let currentFloor = 'floor1';

  const persistLabState = (): void => {
    saveLabState(LAB_ID, {
      showFlowField,
      lighting: { ...lightingSettings },
      fov: { ...fovSettings },
      aiConfig: { ...aiConfig },
    });
  };

  const aiInputProvider = {
    poll(state: {
      moveX: number;
      moveY: number;
      action: boolean;
      pointerX: number;
      pointerY: number;
    }): void {
      pollCount += 1;
      const scene = game.scene.getScene('MainGameScene') as unknown as RunnerSceneInternals | null;
      if (scene?.world) {
        const world = scene.world as GameWorld;
        const playerEid = scene.playerEid;
        const playerHealth =
          typeof playerEid === 'number' && playerEid >= 0
            ? (world.stores.health.current[playerEid] ?? null)
            : null;
        if (
          aiConfig.autoPauseOnDamage &&
          !manualControl &&
          !isPaused &&
          playerHealth !== null &&
          lastObservedPlayerHealth !== null &&
          playerHealth < lastObservedPlayerHealth
        ) {
          isPaused = true;
          lastStepReason = 'damage taken';
          syncSceneSimulationState();
          renderControls();
        }
        lastObservedPlayerHealth = playerHealth;
        if (manualControl) {
          // Human has taken over: read real keyboard/mouse/touch instead of the
          // AI brain. The AI is intentionally NOT polled so its navigation state
          // freezes where the human took over rather than fighting the player.
          const hw = ensureHardwareInput();
          if (hw) {
            hw.poll(state);
          } else {
            state.moveX = 0;
            state.moveY = 0;
            state.action = false;
          }
        } else {
          ai.poll(state, world);
        }
        lastMove.x = state.moveX;
        lastMove.y = state.moveY;
        lastMove.action = state.action;
      } else {
        lastObservedPlayerHealth = null;
        state.moveX = 0;
        state.moveY = 0;
        state.action = false;
        state.pointerX = 0;
        state.pointerY = 0;
      }
    },
    destroy(): void {
      // Nothing to clean up.
    },
  };
  // Headless-parity AI driver. The headless runner claims the boss-reward heal
  // spell and confirms shop/stair flows every step; the in-scene boss-reward and
  // shop flows are modal-gated, and an input-override AI cannot operate a modal.
  // Without this the browser AI stalls forever on the boss-reward modal. Run the
  // same auto-driver as a post-system so the browser AI matches the headless
  // runner's progression. NPC talk is left to the scene's own E-press handling.
  //
  // Stat-point allocation is NOT auto-spent here: unlike the headless runner, the
  // in-browser scene renders the real level-up modal, so the AI drives that UX via
  // `autoLevelUpAllocator` below (using the same allocation heuristic). Spending
  // points here would zero `unspentPoints` before the modal could open.
  const aiAutoDriverSystem = (world: GameWorld): void => {
    if (manualControl) {
      // Human is driving — don't let the AI auto-progression claim rewards,
      // confirm shops, or descend stairs on the player's behalf.
      return;
    }
    const playerEid = query(world.ecs, [Player])[0];
    if (playerEid === undefined) {
      return;
    }
    autoFloor1ProgressionSystem(world, playerEid);
  };
  const baseSceneOptions = createFloorMainSceneOptions(currentFloor);
  const recorderControls = createSessionRecorderControls({
    title: 'AI Session Recorder',
    initialController: 'AI',
  });
  const sceneOptions = {
    ...baseSceneOptions,
    inputCaptureOverride: aiInputProvider,
    worldSeed: currentSeed,
    postSystems: [...baseSceneOptions.postSystems, aiAutoDriverSystem],
    autoLevelUpAllocator: computeAutoStatAllocation,
    sessionRecorderFactory: recorderControls.factory,
  };

  const config = createFloorGameConfig(canvas, sceneOptions, currentFloor);

  const game = new Phaser.Game(config);

  const getScene = (): RunnerSceneInternals | null =>
    game.scene.getScene('MainGameScene') as unknown as RunnerSceneInternals | null;

  const getPhaserScene = (): Phaser.Scene | null =>
    game.scene.getScene('MainGameScene') as Phaser.Scene | null;

  const findPlayerEid = (): number | undefined => {
    const scene = getScene();
    if (!scene?.world) {
      return undefined;
    }
    if (typeof scene.playerEid === 'number' && scene.playerEid >= 0) {
      return scene.playerEid;
    }
    return query(scene.world.ecs, [Player])[0];
  };

  const movePlayerTo = (x: number, y: number): boolean => {
    const scene = getScene();
    const playerEid = findPlayerEid();
    const world = scene?.world;
    if (!scene || !world || playerEid === undefined) {
      return false;
    }
    world.stores.position.x[playerEid] = x;
    world.stores.position.y[playerEid] = y;
    world.stores.velocity.x[playerEid] = 0;
    world.stores.velocity.y[playerEid] = 0;
    return true;
  };

  const resolveJumpPosition = (
    world: GameWorld,
    target: Exclude<JumpTarget, 'boss-encounter'>,
  ): { x: number; y: number } | null => {
    const objective = world.floorScenario?.objective;
    if (!objective) {
      return null;
    }
    switch (target) {
      case 'spawn-room': {
        const spawnTile = world.floorMap?.playerSpawn;
        if (spawnTile && world.floorMap) {
          return world.floorMap.tileToWorld(spawnTile.x, spawnTile.y);
        }
        return null;
      }
      case 'welcome-office':
        return objective.welcomeOfficePos;
      case 'slime-rat-room':
        return objective.slimeRatRoomPos;
      case 'quest-item-room':
        return objective.questItemPos;
      case 'staircase-room':
        return objective.staircasePos;
      case 'spell-quest-giver':
        return getNpcOrFallbackPosition(
          world,
          world.floorScenario?.spellQuestGiverNpcEid,
          objective.spellQuestGiverPos,
        );
      case 'shopkeeper':
        return getNpcOrFallbackPosition(
          world,
          world.floorScenario?.shopkeeperNpcEid,
          objective.shopRoomPos,
        );
      default: {
        const unreachableTarget: never = target;
        void unreachableTarget;
        return null;
      }
    }
  };

  const getNpcOrFallbackPosition = (
    world: GameWorld,
    npcEid: number | null | undefined,
    fallbackPos: { x: number; y: number },
  ): { x: number; y: number } => {
    if (npcEid === null || npcEid === undefined) {
      return fallbackPos;
    }
    return {
      x: world.stores.position.x[npcEid] ?? fallbackPos.x,
      y: world.stores.position.y[npcEid] ?? fallbackPos.y,
    };
  };

  const jumpToTarget = (target: JumpTarget): void => {
    const scene = getScene();
    const world = scene?.world;
    const playerEid = findPlayerEid();
    if (!scene || !world || playerEid === undefined) {
      return;
    }
    if (target === 'boss-encounter') {
      startFloor1BossEncounter(world, playerEid);
      return;
    }
    const pos = resolveJumpPosition(world, target);
    if (!pos) {
      return;
    }
    movePlayerTo(pos.x, pos.y);
  };

  const applyQuestDebug = (): void => {
    const world = getScene()?.world;
    if (!world) {
      return;
    }
    const acceptedQuest = acceptQuest(world, floorDebug.questId);
    if (!acceptedQuest) {
      console.warn(`Quest debug failed: unable to accept quest ${floorDebug.questId}`);
      return;
    }
    setTrackedQuest(world, floorDebug.questId);
    if (floorDebug.questAction !== 'complete') {
      return;
    }
    const def = getQuestDef(floorDebug.questId);
    if (!def) {
      return;
    }
    for (const objective of def.objectives) {
      acceptedQuest.progress[objective.id] = objectiveTarget(objective);
      acceptedQuest.done[objective.id] = true;
      if (objective.kind === 'goal' && objective.goalId) {
        setGoalFlag(world, objective.goalId, true);
      }
    }
    if (def.onCompleteGoalFlag) {
      setGoalFlag(world, def.onCompleteGoalFlag, true);
    }
    questSystem(world);
  };

  const tryGetLightingDebugApi = () => window.__floor1Debug?.lighting ?? null;

  const syncLightingTelemetry = (): void => {
    const lighting = tryGetLightingDebugApi();
    if (!lighting) {
      return;
    }
    const config = lighting.getConfig();
    Object.assign(lightingSettings, config);
    const perf = lighting.getPerf();
    lightingPerf.computeMsAvg = perf.computeMsAvg;
    lightingPerf.stepPx = perf.stepPx;
    lightingPerf.updateEveryNFrames = perf.updateEveryNFrames;
  };

  const applyLightingSettings = (): void => {
    const lighting = tryGetLightingDebugApi();
    if (!lighting) {
      return;
    }
    lighting.setConfig({ ...lightingSettings });
    syncLightingTelemetry();
  };

  const useLightingPreset = (preset: LightingPresetId): void => {
    const lighting = tryGetLightingDebugApi();
    if (!lighting) {
      return;
    }
    lighting.usePreset(preset);
    syncLightingTelemetry();
    persistLabState();
  };

  const lightingFolder = gui.addFolder('Lighting');
  for (const [preset, label] of [
    ['tile', 'Preset: tile'],
    ['halfTile', 'Preset: half tile'],
    ['quarterTile', 'Preset: quarter tile'],
    ['pixel', 'Preset: 1px'],
  ] as const satisfies ReadonlyArray<readonly [LightingPresetId, string]>) {
    lightingFolder.add({ activate: () => useLightingPreset(preset) }, 'activate').name(label);
  }
  lightingFolder
    .add(lightingSettings, 'stepPx', 1, 64, 1)
    .name('Step (px)')
    .listen()
    .onChange(() => {
      persistLabState();
      applyLightingSettings();
    });
  lightingFolder
    .add(lightingSettings, 'ambient', 0, 0.5, 0.01)
    .name('Ambient')
    .onChange(() => {
      persistLabState();
      applyLightingSettings();
    });
  lightingFolder
    .add(lightingSettings, 'sourceRadiusPx', 40, 480, 5)
    .name('Radius')
    .onChange(() => {
      persistLabState();
      applyLightingSettings();
    });
  lightingFolder
    .add(lightingSettings, 'sourceIntensity', 0, 2, 0.05)
    .name('Intensity')
    .onChange(() => {
      persistLabState();
      applyLightingSettings();
    });
  lightingFolder
    .add(lightingSettings, 'falloffExponent', 0.3, 4, 0.1)
    .name('Falloff')
    .onChange(() => {
      persistLabState();
      applyLightingSettings();
    });
  lightingFolder
    .add(lightingSettings, 'softness')
    .name('Blur / Softness')
    .onChange(() => {
      persistLabState();
      applyLightingSettings();
    });
  lightingFolder
    .add(lightingSettings, 'updateEveryNFrames', 1, 8, 1)
    .name('Update Every N')
    .onChange(() => {
      persistLabState();
      applyLightingSettings();
    });
  lightingFolder
    .add(lightingSettings, 'autoAdjustQuality')
    .name('Auto quality')
    .onChange(() => {
      persistLabState();
      applyLightingSettings();
    });
  lightingFolder
    .add(lightingSettings, 'targetComputeMs', 0.25, 10, 0.25)
    .name('Target ms')
    .onChange(() => {
      persistLabState();
      applyLightingSettings();
    });
  const lightingPerfFolder = lightingFolder.addFolder('Perf');
  lightingPerfFolder.add(lightingPerf, 'computeMsAvg').name('Compute ms').listen();
  lightingPerfFolder.add(lightingPerf, 'stepPx').name('Live step').listen();
  lightingPerfFolder.add(lightingPerf, 'updateEveryNFrames').name('Live cadence').listen();
  lightingFolder.close();

  const tryGetFovDebugApi = () => window.__floor1Debug?.fov ?? null;

  const syncFovTelemetry = (): void => {
    const fov = tryGetFovDebugApi();
    if (!fov) {
      return;
    }
    const config = fov.getConfig();
    Object.assign(fovSettings, config);
    const perf = fov.getPerf();
    fovPerf.computeMsAvg = perf.computeMsAvg;
    fovPerf.lastComputeMs = perf.lastComputeMs;
    fovPerf.subFactor = perf.subFactor;
    fovPerf.cellPx = perf.cellPx;
  };

  const applyFovSettings = (): void => {
    const fov = tryGetFovDebugApi();
    if (!fov) {
      return;
    }
    // setConfig prioritizes `subFactor` over `cellPx`, so sending the whole
    // object applies the canonical factor and routes `discoveredLight` to the
    // lighting config (its owner). The echoed result re-syncs the derived cellPx.
    fov.setConfig({ ...fovSettings });
    syncFovTelemetry();
  };

  const useFovPreset = (preset: FovPresetId): void => {
    const fov = tryGetFovDebugApi();
    if (!fov) {
      return;
    }
    fov.usePreset(preset);
    syncFovTelemetry();
    persistLabState();
  };

  const fovFolder = gui.addFolder('FOV');
  for (const [preset, label] of [
    ['tile', 'Preset: 32px (f1)'],
    ['halfTile', 'Preset: 16px (f2, default)'],
    ['quarterTile', 'Preset: 8px (f4)'],
    ['fine', 'Preset: 4px (f8)'],
  ] as const satisfies ReadonlyArray<readonly [FovPresetId, string]>) {
    fovFolder.add({ activate: () => useFovPreset(preset) }, 'activate').name(label);
  }
  fovFolder
    .add(fovSettings, 'subFactor', 1, MAX_FOV_SUB_FACTOR, 1)
    .name('Sub-factor')
    .listen()
    .onChange(() => {
      persistLabState();
      applyFovSettings();
    });
  fovFolder
    .add(fovSettings, 'discoveredLight', 0, 0.2, 0.005)
    .name('Discovered dim')
    .listen()
    .onChange(() => {
      persistLabState();
      applyFovSettings();
    });
  const fovPerfFolder = fovFolder.addFolder('Perf');
  fovPerfFolder.add(fovPerf, 'computeMsAvg').name('Compute ms').listen();
  fovPerfFolder.add(fovPerf, 'cellPx').name('Live cell px').listen();
  fovPerfFolder.add(fovPerf, 'subFactor').name('Live factor').listen();
  fovFolder.close();

  /**
   * AI pathing and visualization configuration.
   */
  const updateAIPathingMode = (): void => {
    // Recreate the AI with the new pathing mode
    ai = new BehaviorTreeAI({
      seed: currentSeed,
      aggression: 1,
      retreatThreshold: 0.15,
      debug: true,
      pathingMode: aiConfig.pathingMode,
    });
  };

  const aiFolder = gui.addFolder('AI Configuration');
  aiFolder
    .add(aiConfig, 'pathingMode', [AIPathingMode.LEGACY, AIPathingMode.RISK_REWARD_FUSED])
    .name('Pathing mode')
    .onChange(() => {
      updateAIPathingMode();
      persistLabState();
    });
  aiFolder
    .add(aiConfig, 'visualRiskRewardFields')
    .name('Show risk/reward fields')
    .onChange(() => {
      persistLabState();
    });
  aiFolder
    .add({ showFlowField }, 'showFlowField')
    .name('Show enemy flow field')
    .onChange((value: boolean) => {
      showFlowField = value;
      persistLabState();
      if (showFlowField) {
        drawFlowFieldOverlay();
      } else {
        flowFieldGraphics?.clear();
      }
    });
  aiFolder
    .add(aiConfig, 'threatPreviewFrames', 0, 60, 1)
    .name('Threat preview (frames ahead)')
    .onChange(() => {
      persistLabState();
    });
  aiFolder
    .add(aiConfig, 'autoPauseOnDamage')
    .name('Auto pause on damage')
    .onChange(() => {
      persistLabState();
    });
  aiFolder.close();

  /**
   * Lazily build a real hardware input capture (keyboard/mouse/touch) bound to
   * the live scene. Used only while {@link manualControl} is active so the human
   * drives the player through the same `inputCaptureOverride` channel the AI uses.
   */
  const ensureHardwareInput = (): ReturnType<typeof createInputCapture> | null => {
    if (hardwareInput) {
      return hardwareInput;
    }
    const phaserScene = getPhaserScene();
    if (!phaserScene) {
      return null;
    }
    hardwareInput = createInputCapture(phaserScene, {
      getFollowOrigin: () => {
        const scene = getScene();
        const eid = scene?.playerEid;
        if (!scene?.world || typeof eid !== 'number' || eid < 0) {
          return undefined;
        }
        return {
          // Camera world-space is pixels; scale the player's feet position.
          x: ftToPx(scene.world.stores.position.x[eid] ?? 0),
          y: ftToPx(scene.world.stores.position.y[eid] ?? 0),
        };
      },
    });
    return hardwareInput;
  };

  const disposeHardwareInput = (): void => {
    hardwareInput?.destroy();
    hardwareInput = null;
  };

  /**
   * Toggle between AI-driven and human-driven play. Taking manual control hands
   * the player to the keyboard/mouse, resumes the sim at 1x so it's playable, and
   * records a clearly-labeled handover in the session recorder. Returning control
   * re-arms the AI brain from wherever the human left the player.
   */
  const setManualControl = (next: boolean): void => {
    if (next === manualControl) {
      return;
    }
    manualControl = next;
    if (manualControl) {
      isPaused = false;
      selectedSpeed = 1;
      lastStepReason = '';
      syncSceneSimulationState();
      const frame = getScene()?.world?.frameCount ?? 0;
      recorderControls.onControlChange('MANUAL', `frame ${frame}`);
    } else {
      disposeHardwareInput();
      const frame = getScene()?.world?.frameCount ?? 0;
      recorderControls.onControlChange('AI', `frame ${frame}`);
    }
    // Drop any stale AI path overlay so it doesn't trail behind the human.
    pathGraphics?.clear();
    renderControls();
  };

  const syncSceneSimulationState = (): void => {
    const scene = getScene();
    if (!scene) {
      return;
    }
    scene.setSimulationSpeed(selectedSpeed);
    scene.setSimulationPaused(isPaused);
  };

  /**
   * Restart the run with a new seed: reseeds the world RNG (via scene options)
   * and rebuilds the AI brain so its internal RNG matches. The scene is fully
   * restarted so the floor regenerates deterministically from the new seed.
   * Always lands paused so the new opening state can be inspected.
   */
  const reseed = (nextSeed: number): void => {
    currentSeed = nextSeed;
    sceneOptions.worldSeed = currentSeed;
    ai = new BehaviorTreeAI({
      seed: currentSeed,
      aggression: 1,
      retreatThreshold: 0.15,
      debug: true,
      pathingMode: aiConfig.pathingMode,
    });
    pollCount = 0;
    lastObservedPlayerHealth = null;
    lastStepReason = '';
    isPaused = true;
    // A fresh floor always starts under AI control. Tear down the human input
    // capture bound to the old scene instance before it restarts.
    manualControl = false;
    disposeHardwareInput();
    pendingGearPreviewTicks = 0;
    pendingGearEquipPreview = false;
    pathGraphics?.destroy();
    pathGraphics = null;
    flowFieldGraphics?.destroy();
    flowFieldGraphics = null;
    riskRewardFieldsGraphics?.destroy();
    riskRewardFieldsGraphics = null;

    const phaserScene = getPhaserScene();
    if (phaserScene) {
      // Re-sync sim speed/pause once the restarted scene finishes create().
      phaserScene.events.once(Phaser.Scenes.Events.CREATE, () => {
        syncSceneSimulationState();
        getScene()?.setDebugFlag?.('showAllRooms', floorDebug.showAllRooms);
        applyLightingSettings();
        applyFovSettings();
      });
      phaserScene.scene.restart();
    }
  };

  /**
   * Switch to a different floor: rebuild scene options from the new floor's
   * manifest and restart the scene so the new floor generates deterministically.
   */
  const changeFloor = (floorId: string): void => {
    currentFloor = floorId;
    const newBase = createFloorMainSceneOptions(floorId);
    Object.assign(sceneOptions, newBase, {
      postSystems: [...newBase.postSystems, aiAutoDriverSystem],
    });
    reseed(currentSeed);
    renderControls();
  };

  const autoAdvanceSceneUi = (): void => {
    if (manualControl) {
      // Human is driving — let them operate modals, NPCs, shops and stairs
      // themselves instead of the AI auto-confirming everything.
      return;
    }
    const scene = getScene();
    const world = scene?.world;
    const playerEid = scene?.playerEid;
    if (!scene || !world || typeof playerEid !== 'number' || playerEid < 0) {
      return;
    }

    const modalPicker = scene.modalPicker;
    const objective = world.floorScenario?.objective;

    if (world.state === 'loadout') {
      sceneOptions.selectLoadoutOption?.(world, 0);
      modalPicker?.close();
      return;
    }

    // An open NPC conversation freezes the simulation until the dialogue is
    // advanced/closed. Keep tapping interact so the AI drives the conversation
    // to completion instead of stalling on the open dialogue box. Quests are
    // accepted on conversation open (meet*), so re-tapping never re-targets the
    // NPC — it only walks the dialogue forward until it closes.
    if (scene.conversationNpcEid !== null) {
      scene.queuedInteraction = true;
      return;
    }

    for (const [, instance] of world.npcs.entries()) {
      if (!instance.nearbyPlayer || instance.defId !== 'shopkeeper') {
        continue;
      }
      sceneOptions.shopkeeper?.returnPrize(world, playerEid);
      break;
    }

    if (modalPicker?.isOpen()) {
      if (
        world.goalFlags.get('floor1-boss-battle-complete') === true &&
        world.featureUnlocks.spells !== true
      ) {
        sceneOptions.selectSpellFromBossBattle?.(world, playerEid, 'fireball');
        modalPicker.close();
        return;
      }
      if (
        objective?.staircaseUnlocked &&
        !objective.staircaseDiscovered &&
        Math.hypot(
          (world.stores.position.x[playerEid] ?? 0) - objective.staircasePos.x,
          (world.stores.position.y[playerEid] ?? 0) - objective.staircasePos.y,
        ) <= objective.markerRadiusFt
      ) {
        sceneOptions.onStairDescend?.(world, playerEid);
        modalPicker.close();
        return;
      }
      if (sceneOptions.shopkeeper && sceneOptions.shopkeeper.getStage(world) === 'ready-to-buy') {
        if (world.playerGold >= sceneOptions.shopkeeper.equipmentCost) {
          if (sceneOptions.shopkeeper.purchase(world, playerEid)) {
            pendingGearPreviewTicks = INVENTORY_PREVIEW_TICKS;
            pendingGearEquipPreview = true;
          }
        }
        modalPicker.close();
        return;
      }
    }

    if (pendingGearEquipPreview && sceneOptions.shopkeeper?.getStage(world) === 'awaiting-equip') {
      if (!scene.isInventoryOpen()) {
        scene.requestInventoryToggle();
        return;
      }
      if (pendingGearPreviewTicks > 0) {
        pendingGearPreviewTicks -= 1;
        return;
      }
      scene.requestEquipAction();
      pendingGearEquipPreview = false;
      pendingGearPreviewTicks = 0;
      return;
    }
    pendingGearEquipPreview = false;
    pendingGearPreviewTicks = 0;

    const decision = ai.getDecision();
    const shouldInteractNpc =
      decision.state === AIState.INTERACT &&
      typeof decision.targetEid === 'number' &&
      decision.targetEid >= 0 &&
      (world.npcs.get(decision.targetEid)?.nearbyPlayer ?? false);
    const nearStairs =
      objective?.staircaseUnlocked === true &&
      objective.staircaseSpawned === true &&
      !objective.staircaseDiscovered &&
      Math.hypot(
        (world.stores.position.x[playerEid] ?? 0) - objective.staircasePos.x,
        (world.stores.position.y[playerEid] ?? 0) - objective.staircasePos.y,
      ) <= objective.markerRadiusFt;
    if (shouldInteractNpc || nearStairs) {
      scene.queuedInteraction = true;
    }
  };

  const stepOneFrame = (reason: string): void => {
    const scene = getScene();
    if (!scene) {
      return;
    }
    isPaused = true;
    lastStepReason = reason;
    scene.setSimulationPaused(true);
    scene.advanceSimulationFrames(1);
    renderControls();
  };

  const ensurePathGraphics = (): Phaser.GameObjects.Graphics | null => {
    const scene = getPhaserScene();
    if (!scene) {
      return null;
    }
    if (!pathGraphics || !pathGraphics.scene) {
      pathGraphics = scene.add.graphics();
      // World-space debug overlay: depth must stay below UI_DEPTH_CUTOFF (see render-depths.ts).
      pathGraphics.setDepth(WORLD_VFX_DEPTH.debugPath);
      (scene.cameras.getCamera('ui') as Phaser.Cameras.Scene2D.Camera | null)?.ignore(pathGraphics);
    }
    return pathGraphics;
  };

  const drawPathOverlay = (): void => {
    const graphics = ensurePathGraphics();
    const scene = getScene();
    const world = scene?.world;
    if (!graphics || !scene || !world || !world.floorMap) {
      return;
    }

    if (manualControl) {
      // The AI's path is frozen/stale while the human drives — hide it.
      graphics.clear();
      return;
    }

    const decision = ai.getDecision();
    const nav = ai.getNavigationDebug();
    const playerEid = scene.playerEid;

    graphics.clear();

    if (typeof playerEid !== 'number' || playerEid < 0) {
      return;
    }
    const playerX = world.stores.position.x[playerEid] ?? 0;
    const playerY = world.stores.position.y[playerEid] ?? 0;

    const worldPoints = nav.pathWaypoints.map((tile) =>
      world.floorMap!.tileToWorld(tile.x, tile.y),
    );

    // The AI plans on a 4-connected grid (cardinal hops) but string-pulls at
    // runtime, steering straight at the farthest waypoint it can see. Draw that
    // smoothed/diagonal path so the overlay matches on-screen movement instead of
    // the raw zigzag. Waypoints before pathIndex are already behind the player.
    const upcomingPoints = worldPoints.slice(nav.pathIndex);
    const smoothedPath = buildSmoothedOverlayPath(
      { x: playerX, y: playerY },
      upcomingPoints,
      (x, y) => world.floorMap!.isPassableAt(x, y),
      pxToFt(OVERLAY_LINE_OF_SIGHT_SAMPLE_PX),
      (x, y) => world.floorMap!.worldToTile(x, y),
    );

    if (smoothedPath.length > 1) {
      graphics.lineStyle(2, 0x4fc3f7, 0.95);
      graphics.beginPath();
      const [firstPoint, ...restPoints] = smoothedPath;
      // Overlay points are feet; scale to the camera's pixel world-space.
      graphics.moveTo(ftToPx(firstPoint!.x), ftToPx(firstPoint!.y));
      for (const point of restPoints) {
        graphics.lineTo(ftToPx(point.x), ftToPx(point.y));
      }
      graphics.strokePath();
    }

    if (upcomingPoints.length > 0) {
      graphics.lineStyle(1, 0x80deea, 0.55);
      graphics.beginPath();
      graphics.moveTo(ftToPx(playerX), ftToPx(playerY));
      for (const point of upcomingPoints) {
        graphics.lineTo(ftToPx(point.x), ftToPx(point.y));
      }
      graphics.strokePath();
      graphics.fillStyle(0x80deea, 0.65);
      for (const point of upcomingPoints) {
        graphics.fillCircle(ftToPx(point.x), ftToPx(point.y), 3.5);
      }
    }

    const activeWaypoint =
      worldPoints[Math.min(nav.pathIndex, Math.max(0, worldPoints.length - 1))];
    if (activeWaypoint) {
      graphics.fillStyle(0xffeb3b, 0.9);
      graphics.fillCircle(ftToPx(activeWaypoint.x), ftToPx(activeWaypoint.y), 5);
    }

    if (decision.targetX !== null && decision.targetY !== null) {
      graphics.lineStyle(2, 0xff7043, 0.9);
      graphics.strokeCircle(ftToPx(decision.targetX), ftToPx(decision.targetY), 10);
    }
  };

  const ensureFlowFieldGraphics = (): Phaser.GameObjects.Graphics | null => {
    const scene = getPhaserScene();
    if (!scene) {
      return null;
    }
    if (!flowFieldGraphics || !flowFieldGraphics.scene) {
      flowFieldGraphics = scene.add.graphics();
      // World-space debug overlay: depth must stay below UI_DEPTH_CUTOFF (see render-depths.ts)
      // and below the path overlay so the cyan route reads on top of the heatmap.
      flowFieldGraphics.setDepth(WORLD_VFX_DEPTH.debugFlowField);
      (scene.cameras.getCamera('ui') as Phaser.Cameras.Scene2D.Camera | null)?.ignore(
        flowFieldGraphics,
      );
    }
    return flowFieldGraphics;
  };

  /**
   * Render the shared ground flow field that dense chasers steer down. Each
   * reachable tile is shaded by its shortest-path distance to the player (hot =
   * close, cool = far) and ticked toward its downhill neighbour, so the swarm's
   * routing is visible at a glance. Off by default — purely a debug aid.
   */
  const drawFlowFieldOverlay = (): void => {
    if (!showFlowField) {
      flowFieldGraphics?.clear();
      return;
    }
    const graphics = ensureFlowFieldGraphics();
    const scene = getScene();
    const world = scene?.world;
    if (!graphics || !scene || !world || !world.floorMap) {
      return;
    }
    graphics.clear();

    const field = peekGroundFlowField(world);
    if (!field) {
      return;
    }

    const floorMap = world.floorMap;
    const tileSize = floorMap.config.tileSizeFt;
    // Overlay draws into the camera's pixel world-space; scale feet sizes up.
    const tileSizePx = ftToPx(tileSize);
    const { width, height, distance } = field;

    let maxDistance = 1;
    for (let i = 0; i < distance.length; i++) {
      const d = distance[i]!;
      if (d > maxDistance) {
        maxDistance = d;
      }
    }

    // Heatmap fills, accumulating direction arrows for a single batched stroke.
    const arrowSegments: number[] = [];
    for (let ty = 0; ty < height; ty++) {
      for (let tx = 0; tx < width; tx++) {
        const d = distance[ty * width + tx]!;
        if (d === FLOW_UNREACHABLE) {
          continue;
        }
        const center = floorMap.tileToWorld(tx, ty);
        const cx = ftToPx(center.x);
        const cy = ftToPx(center.y);
        graphics.fillStyle(flowHeatColor(d / maxDistance), 0.32);
        graphics.fillRect(cx - tileSizePx / 2, cy - tileSizePx / 2, tileSizePx, tileSizePx);

        const step = flowFieldStep(field, tx, ty);
        if (step) {
          pushFlowArrow(arrowSegments, cx, cy, step.x, step.y, tileSizePx);
        }
      }
    }

    graphics.lineStyle(1, 0x0b1220, 0.7);
    graphics.beginPath();
    for (let i = 0; i < arrowSegments.length; i += 4) {
      graphics.moveTo(arrowSegments[i]!, arrowSegments[i + 1]!);
      graphics.lineTo(arrowSegments[i + 2]!, arrowSegments[i + 3]!);
    }
    graphics.strokePath();

    // Goal tile (the player tile the whole field flows toward).
    const goal = floorMap.tileToWorld(field.goalX, field.goalY);
    graphics.lineStyle(2, 0x9cff57, 0.95);
    graphics.strokeCircle(ftToPx(goal.x), ftToPx(goal.y), tileSizePx * 0.4);
  };

  const ensureRiskRewardFieldsGraphics = (): Phaser.GameObjects.Graphics | null => {
    const scene = getPhaserScene();
    if (!scene) {
      return null;
    }
    if (!riskRewardFieldsGraphics || !riskRewardFieldsGraphics.scene) {
      riskRewardFieldsGraphics = scene.add.graphics();
      // World-space debug overlay: depth should be similar to flowFieldGraphics
      riskRewardFieldsGraphics.setDepth(WORLD_VFX_DEPTH.debugFlowField + 1);
      (scene.cameras.getCamera('ui') as Phaser.Cameras.Scene2D.Camera | null)?.ignore(
        riskRewardFieldsGraphics,
      );
    }
    return riskRewardFieldsGraphics;
  };

  /**
   * Render the risk/reward fields around the player when in fused pathing mode.
   * - Red:   danger from *live* enemies only (mirrors scorer's health > 0 filter)
   * - Green: reward from nearby pickups (XP gems, gold, dropped items)
   * - Cells with no risk AND no reward are skipped entirely (transparent)
   */
  const drawRiskRewardFieldsOverlay = (): void => {
    if (
      !aiConfig.visualRiskRewardFields ||
      aiConfig.pathingMode !== AIPathingMode.RISK_REWARD_FUSED
    ) {
      riskRewardFieldsGraphics?.clear();
      return;
    }
    const graphics = ensureRiskRewardFieldsGraphics();
    const scene = getScene();
    const world = scene?.world;
    if (!graphics || !scene || !world || !world.floorMap) {
      return;
    }
    graphics.clear();

    const playerEid = scene.playerEid;
    if (typeof playerEid !== 'number' || playerEid < 0) {
      return;
    }
    const playerX = world.stores.position.x[playerEid] ?? 0;
    const playerY = world.stores.position.y[playerEid] ?? 0;

    const sampleRadius = 30; // feet
    const gridSpacing = 2; // feet
    const DANGER_RADIUS = 15; // ft — mirrors updated RISK_REWARD_DANGER_RADIUS_FT in scorer
    const REWARD_RADIUS = 10; // ft — pickup pull radius
    const FOG_DANGER = 0.35; // mirrors RISK_REWARD_FOG_DANGER
    const DRAW_THRESHOLD = 0.05; // skip cells with no meaningful field value

    // Live enemies — mirrors scorer: project by velocity * (lookahead + preview frames)
    // Enemies always move toward the player (flow-map driven), so projected position
    // is always closer — use it directly, not min(current, projected).
    const VELOCITY_LOOKAHEAD = 10;
    const WALL_PROXIMITY_FT = 2.0;
    const WALL_AMPLIFICATION = 1.8;
    const totalLookahead = VELOCITY_LOOKAHEAD + aiConfig.threatPreviewFrames;
    const threatPoints: { x: number; y: number }[] = [];
    for (const eid of query(world.ecs, [Enemy, Position, Health])) {
      if ((world.stores.health.current[eid] ?? 0) <= 0) continue;
      const ex = world.stores.position.x[eid] ?? 0;
      const ey = world.stores.position.y[eid] ?? 0;
      if (Math.hypot(ex - playerX, ey - playerY) < sampleRadius + DANGER_RADIUS) {
        const vx = world.stores.velocity.x[eid] ?? 0;
        const vy = world.stores.velocity.y[eid] ?? 0;
        threatPoints.push({ x: ex + vx * totalLookahead, y: ey + vy * totalLookahead });
      }
    }

    // Reward sources: XP gems, gold, dropped items
    const rewardPoints: { x: number; y: number }[] = [];
    for (const eid of query(world.ecs, [XpGem, Position])) {
      const rx = world.stores.position.x[eid] ?? 0;
      const ry = world.stores.position.y[eid] ?? 0;
      if (Math.hypot(rx - playerX, ry - playerY) < sampleRadius + REWARD_RADIUS) {
        rewardPoints.push({ x: rx, y: ry });
      }
    }
    for (const eid of query(world.ecs, [Gold, Position])) {
      const rx = world.stores.position.x[eid] ?? 0;
      const ry = world.stores.position.y[eid] ?? 0;
      if (Math.hypot(rx - playerX, ry - playerY) < sampleRadius + REWARD_RADIUS) {
        rewardPoints.push({ x: rx, y: ry });
      }
    }
    for (const eid of query(world.ecs, [DroppedItem, Position])) {
      const rx = world.stores.position.x[eid] ?? 0;
      const ry = world.stores.position.y[eid] ?? 0;
      if (Math.hypot(rx - playerX, ry - playerY) < sampleRadius + REWARD_RADIUS) {
        rewardPoints.push({ x: rx, y: ry });
      }
    }
    for (const eid of query(world.ecs, [Harvestable, Position])) {
      const rx = world.stores.position.x[eid] ?? 0;
      const ry = world.stores.position.y[eid] ?? 0;
      if (Math.hypot(rx - playerX, ry - playerY) < sampleRadius + REWARD_RADIUS) {
        rewardPoints.push({ x: rx, y: ry });
      }
    }

    // Sample grid and draw only cells that carry meaningful field signal
    const cellSizePx = ftToPx(gridSpacing);
    for (let x = playerX - sampleRadius; x <= playerX + sampleRadius; x += gridSpacing) {
      for (let y = playerY - sampleRadius; y <= playerY + sampleRadius; y += gridSpacing) {
        let danger = 0;
        if (!world.floorMap!.isPassableAt(x, y)) {
          // Wall cells have no independent danger — skip. The amplifier is
          // applied to *adjacent* passable cells below.
        } else {
          // Enemy danger using projected positions.
          for (const t of threatPoints) {
            const dist = Math.hypot(x - t.x, y - t.y);
            if (dist < DANGER_RADIUS) {
              const norm = 1 - dist / DANGER_RADIUS;
              danger += norm * norm;
            }
          }
          // Wall proximity amplification — same 4-cardinal check as scorer.
          const hasNearWall =
            !world.floorMap!.isPassableAt(x + WALL_PROXIMITY_FT, y) ||
            !world.floorMap!.isPassableAt(x - WALL_PROXIMITY_FT, y) ||
            !world.floorMap!.isPassableAt(x, y + WALL_PROXIMITY_FT) ||
            !world.floorMap!.isPassableAt(x, y - WALL_PROXIMITY_FT);
          if (hasNearWall && danger > 0) danger *= WALL_AMPLIFICATION;
          // Fog-of-war baseline danger
          if (!world.floorMap!.isVisibleAt(x, y)) {
            danger += FOG_DANGER;
          }
        }

        let reward = 0;
        for (const r of rewardPoints) {
          const dist = Math.hypot(x - r.x, y - r.y);
          if (dist < REWARD_RADIUS) {
            const norm = 1 - dist / REWARD_RADIUS;
            reward += norm * norm;
          }
        }

        // Skip empty cells — don't color what has no field value
        const dc = Math.min(danger, 2);
        const rc = Math.min(reward, 2);
        if (dc < DRAW_THRESHOLD && rc < DRAW_THRESHOLD) continue;

        const cx = ftToPx(x);
        const cy = ftToPx(y);
        // Red = danger, green = reward, yellow = both
        const rv = Math.round(255 * Math.min(1, dc / 1.5 + (rc / 2) * 0.3));
        const gv = Math.round(220 * Math.min(1, rc / 1.5 + (dc / 2) * 0.05));
        const bv = Math.round(40 * Math.max(0, rc / 2 - dc / 2));
        const color = (rv << 16) | (gv << 8) | bv;
        const alpha = Math.min(0.78, dc * 0.55 + rc * 0.35);
        graphics.fillStyle(color, alpha);
        graphics.fillRect(cx - cellSizePx / 2, cy - cellSizePx / 2, cellSizePx, cellSizePx);
      }
    }

    // Draw player position marker
    graphics.fillStyle(0xffffff, 0.8);
    graphics.fillCircle(ftToPx(playerX), ftToPx(playerY), 6);
  };

  const renderDecisionTree = (
    treeContainer: HTMLElement,
    tree: SerializedBTNode,
    decision: { state: number; reason: string; targetX: number | null; targetY: number | null },
  ): void => {
    treeContainer.innerHTML = '';
    const root = document.createElement('div');
    root.style.cssText = 'padding: 8px; background: #151530; border-radius: 4px; margin-top: 10px;';
    treeContainer.appendChild(root);

    const stateName = getStateName(decision.state);
    const summary = document.createElement('div');
    summary.style.cssText = 'margin-bottom: 8px; font-size: 11px;';
    summary.innerHTML = `<div><strong>Decision tree</strong></div>
      <div>State: ${stateName}</div>
      <div>Reason: ${decision.reason}</div>`;
    root.appendChild(summary);

    const nodeList = document.createElement('div');
    nodeList.style.cssText =
      'font-family: monospace; font-size: 11px; max-height: 220px; overflow-y: auto;';
    root.appendChild(nodeList);

    const getNodeColor = (type: string): string => {
      switch (type) {
        case 'Sequence':
          return '#4caf50';
        case 'Selector':
          return '#ff9800';
        case 'Condition':
          return '#2196f3';
        case 'Action':
          return '#f44336';
        default:
          return '#9e9e9e';
      }
    };

    const renderNode = (node: SerializedBTNode, depth: number): void => {
      const line = document.createElement('div');
      line.style.cssText = `margin-left:${depth * 14}px; color:#ddd;`;
      line.innerHTML = `<span style="color:${getNodeColor(node.type)}">[${node.type}]</span> ${node.name}`;
      nodeList.appendChild(line);
      for (const child of node.children) {
        renderNode(child, depth + 1);
      }
    };

    renderNode(tree, 0);
  };

  const renderControls = (): void => {
    const jumpOptions = Object.entries(JUMP_TARGET_LABELS)
      .map(([value, label]) => `<option value="${value}">${label}</option>`)
      .join('');
    const questOptions = Object.entries(QUEST_DEBUG_TARGETS)
      .map(([label, value]) => `<option value="${value}">${label}</option>`)
      .join('');
    const floorOptions = getAvailableFloorIds()
      .map((id) => `<option value="${id}"${id === currentFloor ? ' selected' : ''}>${id}</option>`)
      .join('');
    panelRoot.innerHTML = `
      <div style="font-family: monospace; padding: 12px;">
        <h3 style="margin: 0 0 12px 0;">AI Runner Lab</h3>
        <div id="ai-info" style="font-size: 12px; line-height: 1.6;">
          <div style="display:flex; gap:6px; align-items:center; margin-bottom:6px; flex-wrap:wrap;">
            <label for="ai-seed-input"><strong>Seed:</strong></label>
            <input id="ai-seed-input" type="number" value="${currentSeed}" style="width:96px; padding:4px; background:#151530; color:#ddd; border:1px solid #333; border-radius:3px;" />
            <button id="ai-seed-apply" type="button" style="padding:4px 8px; cursor:pointer;">Apply</button>
            <button id="ai-seed-random" type="button" style="padding:4px 8px; cursor:pointer;">🎲 Randomize</button>
          </div>
          <div style="display:flex; gap:6px; align-items:center; margin-bottom:6px; flex-wrap:wrap;">
            <label for="ai-floor-select"><strong>Floor:</strong></label>
            <select id="ai-floor-select" style="padding:4px; background:#151530; color:#ddd; border:1px solid #333; border-radius:3px;">${floorOptions}</select>
            <button id="ai-floor-apply" type="button" style="padding:4px 8px; cursor:pointer;">Apply + Restart</button>
          </div>
          <div id="ai-runner-status">Paused</div>
          <div id="ai-runner-debug">frame: 0</div>
          <div style="display:flex; gap:8px; margin:12px 0; flex-wrap:wrap;">
            <button id="ai-toggle-run" type="button" style="padding:6px 10px; cursor:pointer;">Resume</button>
            <button id="ai-step-frame" type="button" style="padding:6px 10px; cursor:pointer;">Advance 1 frame (Space)</button>
            <button id="ai-speed-1" type="button" style="padding:6px 10px; cursor:pointer;">1x</button>
            <button id="ai-speed-4" type="button" style="padding:6px 10px; cursor:pointer;">4x</button>
            <button id="ai-speed-16" type="button" style="padding:6px 10px; cursor:pointer;">16x</button>
          </div>
          <div style="display:flex; gap:8px; margin:0 0 12px 0; flex-wrap:wrap; align-items:center;">
            <button id="ai-manual-toggle" type="button" style="padding:6px 10px; cursor:pointer; font-weight:bold;">🎮 Take manual control</button>
            <span id="ai-control-mode" style="font-size:12px;"></span>
          </div>
          <div id="ai-decision" style="margin-top: 8px; padding: 8px; background: #2a2a4e; border-radius: 4px;">
            <div><strong>State:</strong> <span id="ai-state">-</span></div>
            <div><strong>Reason:</strong> <span id="ai-reason">-</span></div>
            <div><strong>Target:</strong> <span id="ai-target">-</span></div>
            <div><strong>Path:</strong> <span id="ai-path">-</span></div>
          </div>
          <div id="ai-tree"></div>
          <div style="margin-top:12px; padding:8px; background:#111827; border-radius:4px;">
            <div style="font-weight:bold; margin-bottom:8px;">Floor 1 Debug</div>
            <div style="display:flex; gap:8px; margin:0 0 8px 0; flex-wrap:wrap; align-items:center;">
              <label for="ai-jump-target"><strong>Jump target:</strong></label>
              <select id="ai-jump-target" style="padding:4px; background:#151530; color:#ddd; border:1px solid #333; border-radius:3px;">${jumpOptions}</select>
              <button id="ai-jump-now" type="button" style="padding:4px 8px; cursor:pointer;">Jump now</button>
            </div>
            <div style="display:flex; gap:8px; margin:0 0 8px 0; flex-wrap:wrap; align-items:center;">
              <label for="ai-show-all-rooms" style="display:flex; gap:6px; align-items:center; cursor:pointer;">
                <input id="ai-show-all-rooms" type="checkbox" style="cursor:pointer;" />
                <span>Show all rooms (dim)</span>
              </label>
            </div>
            <div style="display:flex; gap:8px; margin:0; flex-wrap:wrap; align-items:center;">
              <label for="ai-quest-target"><strong>Quest target:</strong></label>
              <select id="ai-quest-target" style="padding:4px; background:#151530; color:#ddd; border:1px solid #333; border-radius:3px;">${questOptions}</select>
              <select id="ai-quest-action" style="padding:4px; background:#151530; color:#ddd; border:1px solid #333; border-radius:3px;">
                <option value="accept">Accept / enable quest</option>
                <option value="complete">Complete quest now</option>
              </select>
              <button id="ai-quest-apply" type="button" style="padding:4px 8px; cursor:pointer;">Apply quest debug</button>
            </div>
          </div>
          <div id="ai-recorder-host"></div>
          <div style="margin-top: 12px; padding: 8px; background: #1a1a3e; border-radius: 4px; font-size: 11px;">
            <div><strong>Tips:</strong></div>
            <div>• Starts paused so you can inspect the opening state</div>
            <div>• Lab auto-clears starter/shop/spell/stair UI for the AI</div>
            <div>• Use speed controls to accelerate the simulation</div>
            <div>• Take manual control to play it yourself (WASD/arrows move, Space attacks, E interacts)</div>
            <div>• The recorder tags every event AI vs MANUAL so handovers are clear in the log</div>
            <div>• Cyan line shows the AI's smoothed diagonal path, orange circle shows current target</div>
            <div>• AI Configuration now holds the flow-field heatmap, future-threat scrubber, and auto-pause-on-damage toggles</div>
            <div>• Floor 1 Debug adds teleport, map reveal, and quest advancement helpers</div>
            <div>• Use the lil-gui Lighting folder to tune darkness quality, cadence, and falloff live</div>
            <div>• Use the lil-gui FOV folder to change fog granularity (32/16/8/4px) + discovered-terrain dimming live</div>
          </div>
        </div>
      </div>
    `;

    const statusElem = document.getElementById('ai-runner-status');
    if (statusElem) {
      const scene = getScene();
      const scenePaused = scene?.isSimulationPaused?.();
      const controlSuffix = manualControl ? ' — 🎮 MANUAL' : ' — 🤖 AI';
      statusElem.textContent = isPaused
        ? `Paused @ ${selectedSpeed}x${controlSuffix}`
        : `Running @ ${selectedSpeed}x${scenePaused ? ' (scene paused)' : ''}${controlSuffix}`;
    }
    const controlModeElem = document.getElementById('ai-control-mode');
    if (controlModeElem) {
      controlModeElem.textContent = manualControl ? 'You are driving — AI paused' : 'AI is driving';
      controlModeElem.style.color = manualControl ? '#fbbf24' : '#93c5fd';
    }
    const debugElem = document.getElementById('ai-runner-debug');
    if (debugElem) {
      const stepSuffix = lastStepReason ? ` | step: ${lastStepReason}` : '';
      const frame = getScene()?.world?.frameCount ?? 0;
      debugElem.textContent = `frame: ${frame}${stepSuffix}`;
    }

    const toggleButton = document.getElementById('ai-toggle-run') as HTMLButtonElement | null;
    if (toggleButton) {
      toggleButton.textContent = isPaused ? 'Resume' : 'Pause';
      toggleButton.onclick = () => {
        isPaused = !isPaused;
        syncSceneSimulationState();
        if (!isPaused) {
          lastStepReason = '';
        }
        renderControls();
      };
    }

    const stepButton = document.getElementById('ai-step-frame') as HTMLButtonElement | null;
    if (stepButton) {
      // Single-stepping is an AI-debugging affordance; while a human is driving,
      // Space is the attack button so frame-stepping is disabled.
      stepButton.disabled = manualControl;
      stepButton.onclick = () => {
        stepOneFrame('button');
      };
    }

    const manualButton = document.getElementById('ai-manual-toggle') as HTMLButtonElement | null;
    if (manualButton) {
      manualButton.textContent = manualControl ? '🤖 Return to AI' : '🎮 Take manual control';
      manualButton.onclick = () => {
        setManualControl(!manualControl);
      };
    }

    const jumpTarget = document.getElementById('ai-jump-target') as HTMLSelectElement | null;
    if (jumpTarget) {
      jumpTarget.value = floorDebug.jumpTarget;
      jumpTarget.onchange = () => {
        floorDebug.jumpTarget = jumpTarget.value as JumpTarget;
      };
    }
    const jumpNow = document.getElementById('ai-jump-now') as HTMLButtonElement | null;
    if (jumpNow) {
      jumpNow.onclick = () => {
        jumpToTarget(floorDebug.jumpTarget);
      };
    }

    const showAllRoomsToggle = document.getElementById(
      'ai-show-all-rooms',
    ) as HTMLInputElement | null;
    if (showAllRoomsToggle) {
      showAllRoomsToggle.checked = floorDebug.showAllRooms;
      showAllRoomsToggle.onchange = () => {
        floorDebug.showAllRooms = showAllRoomsToggle.checked;
        getScene()?.setDebugFlag?.('showAllRooms', floorDebug.showAllRooms);
      };
    }

    const questTarget = document.getElementById('ai-quest-target') as HTMLSelectElement | null;
    if (questTarget) {
      questTarget.value = floorDebug.questId;
      questTarget.onchange = () => {
        floorDebug.questId = questTarget.value;
      };
    }
    const questAction = document.getElementById('ai-quest-action') as HTMLSelectElement | null;
    if (questAction) {
      questAction.value = floorDebug.questAction;
      questAction.onchange = () => {
        floorDebug.questAction = questAction.value as 'accept' | 'complete';
      };
    }
    const applyQuest = document.getElementById('ai-quest-apply') as HTMLButtonElement | null;
    if (applyQuest) {
      applyQuest.onclick = () => {
        applyQuestDebug();
      };
    }

    for (const speed of SPEED_OPTIONS) {
      const button = document.getElementById(`ai-speed-${speed}`) as HTMLButtonElement | null;
      if (!button) {
        continue;
      }
      button.disabled = selectedSpeed === speed;
      button.onclick = () => {
        selectedSpeed = speed;
        syncSceneSimulationState();
        renderControls();
      };
    }

    const floorSelect = document.getElementById('ai-floor-select') as HTMLSelectElement | null;
    const floorApplyButton = document.getElementById('ai-floor-apply') as HTMLButtonElement | null;
    if (floorApplyButton && floorSelect) {
      floorApplyButton.onclick = () => {
        changeFloor(floorSelect.value);
      };
    }

    const seedInput = document.getElementById('ai-seed-input') as HTMLInputElement | null;
    const applySeed = (nextSeed: number): void => {
      reseed(nextSeed);
      renderControls();
    };
    const applyButton = document.getElementById('ai-seed-apply') as HTMLButtonElement | null;
    if (applyButton) {
      applyButton.onclick = () => {
        const parsed = Number.parseInt(seedInput?.value ?? '', 10);
        applySeed(Number.isFinite(parsed) ? parsed : currentSeed);
      };
    }
    const randomButton = document.getElementById('ai-seed-random') as HTMLButtonElement | null;
    if (randomButton) {
      randomButton.onclick = () => {
        const nextSeed = randomRunSeed();
        if (seedInput) {
          seedInput.value = String(nextSeed);
        }
        applySeed(nextSeed);
      };
    }

    const recorderHost = document.getElementById('ai-recorder-host');
    if (recorderHost) {
      recorderControls.mount(recorderHost);
    }
  };

  game.events.once('ready', () => {
    syncSceneSimulationState();
    getScene()?.setDebugFlag?.('showAllRooms', floorDebug.showAllRooms);
    applyLightingSettings();
    applyFovSettings();
  });

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== 'Space' || event.repeat) {
      return;
    }
    if (manualControl) {
      // Human is driving — Space is the attack button, not frame-step.
      return;
    }
    const target = event.target as HTMLElement | null;
    const tagName = target?.tagName.toLowerCase();
    if (tagName === 'input' || tagName === 'textarea') {
      return;
    }
    event.preventDefault();
    stepOneFrame('space');
  };
  window.addEventListener('keydown', onKeyDown);

  renderControls();

  const buildDebugSnapshot = (): AiRunnerDebugSnapshot => {
    const scene = getScene();
    const world = scene?.world;
    const playerEid = scene?.playerEid;
    const decision = ai.getDecision();
    const nav = ai.getNavigationDebug();
    const npcMemory = ai.getNpcMemoryDebug();
    const hasPlayer = !!world && typeof playerEid === 'number' && playerEid >= 0;
    const px = hasPlayer ? Math.round(world.stores.position.x[playerEid] ?? 0) : null;
    const py = hasPlayer ? Math.round(world.stores.position.y[playerEid] ?? 0) : null;
    const targetDist =
      px !== null && py !== null && decision.targetX !== null && decision.targetY !== null
        ? Math.round(Math.hypot(decision.targetX - px, decision.targetY - py))
        : null;
    const quests: AiRunnerDebugSnapshot['quests'] = {};
    if (world) {
      for (const [questId, quest] of world.questLog.entries()) {
        const doneVals = Object.values(quest.done);
        quests[questId] = {
          status: quest.status,
          done: doneVals.filter(Boolean).length,
          total: doneVals.length,
        };
      }
    }
    const neededCount = Object.values(npcMemory.neededInteractionReasons).filter(
      (reason) => typeof reason === 'string' && reason.length > 0,
    ).length;
    return {
      frame: world?.frameCount ?? null,
      polls: pollCount,
      paused: isPaused,
      manualControl,
      speed: selectedSpeed,
      scenePaused: scene?.isSimulationPaused?.() ?? null,
      worldState: world?.state ?? null,
      gameMs: world?.elapsedMs ?? null,
      px,
      py,
      health: hasPlayer ? Math.round(world.stores.health.current[playerEid] ?? 0) : null,
      level: world?.playerLevel?.level ?? 0,
      gold: world?.playerGold ?? 0,
      spellsUnlocked: world?.featureUnlocks?.spells === true,
      state: getStateName(decision.state),
      reason: decision.reason,
      targetEid: decision.targetEid,
      targetX: decision.targetX === null ? null : Math.round(decision.targetX),
      targetY: decision.targetY === null ? null : Math.round(decision.targetY),
      targetDist,
      stuckFrames: nav.stuckFrames,
      pathLen: nav.pathWaypoints.length,
      pathIndex: nav.pathIndex,
      moveX: Math.round(lastMove.x * 1000) / 1000,
      moveY: Math.round(lastMove.y * 1000) / 1000,
      nextWpX: nav.pathWaypoints[nav.pathIndex]?.x ?? null,
      nextWpY: nav.pathWaypoints[nav.pathIndex]?.y ?? null,
      pathGoalKey: nav.pathGoalKey,
      npcMem: {
        discovered: npcMemory.discoveredNpcDefs,
        talked: npcMemory.talkedNpcDefs,
        needed: neededCount,
      },
      conversationNpcEid: scene?.conversationNpcEid ?? null,
      modalOpen: scene?.modalPicker?.isOpen?.() ?? false,
      runOutcome: world?.floorScenario?.runSummary?.outcome ?? null,
      quests,
    };
  };
  if (typeof window !== 'undefined') {
    window.__aiRunnerDebug = buildDebugSnapshot;
  }

  const updateInterval = setInterval(() => {
    autoAdvanceSceneUi();
    const decision = ai.getDecision();
    const stateElem = document.getElementById('ai-state');
    const reasonElem = document.getElementById('ai-reason');
    const targetElem = document.getElementById('ai-target');
    const pathElem = document.getElementById('ai-path');
    const treeElem = document.getElementById('ai-tree');

    if (stateElem) {
      const stateName = getStateName(decision.state);
      stateElem.textContent = stateName;
    }

    if (reasonElem) {
      reasonElem.textContent = decision.reason;
    }

    if (targetElem) {
      if (decision.targetX !== null && decision.targetY !== null) {
        targetElem.textContent = `(${Math.round(decision.targetX)}, ${Math.round(decision.targetY)})`;
      } else {
        targetElem.textContent = 'None';
      }
    }
    if (pathElem) {
      const nav = ai.getNavigationDebug();
      pathElem.textContent =
        nav.pathWaypoints.length > 0
          ? `${nav.pathIndex + 1}/${nav.pathWaypoints.length} waypoints`
          : 'No path';
    }
    if (treeElem) {
      renderDecisionTree(treeElem, ai.getTree().serialize(), decision);
    }
    syncLightingTelemetry();
    syncFovTelemetry();
    drawPathOverlay();
    drawFlowFieldOverlay();
    drawRiskRewardFieldsOverlay();
    const debugElem = document.getElementById('ai-runner-debug');
    if (debugElem) {
      const scene = getScene();
      const npcMemory = ai.getNpcMemoryDebug();
      const neededCount = Object.values(npcMemory.neededInteractionReasons).filter(
        (reason) => typeof reason === 'string' && reason.length > 0,
      ).length;
      const frame = scene?.world?.frameCount ?? 0;
      debugElem.textContent = `frame: ${frame} | scenePaused: ${scene?.isSimulationPaused?.() ? 'yes' : 'no'} | npcMem: discovered=${npcMemory.discoveredNpcDefs.length}, talked=${npcMemory.talkedNpcDefs.length}, needed=${neededCount}`;
    }
  }, 100);

  return () => {
    clearInterval(updateInterval);
    window.removeEventListener('keydown', onKeyDown);
    if (typeof window !== 'undefined') {
      delete window.__aiRunnerDebug;
    }
    recorderControls.destroy();
    disposeHardwareInput();
    persistLabState();
    pathGraphics?.destroy();
    pathGraphics = null;
    flowFieldGraphics?.destroy();
    flowFieldGraphics = null;
    panelRoot.remove();
    game.destroy(true);
  };
}

function getStateName(state: number): string {
  const names = ['EXPLORE', 'ENGAGE', 'RETREAT', 'COLLECT', 'INTERACT'];
  return names[state] ?? 'UNKNOWN';
}

/**
 * Append a small arrow (shaft + two barbs) pointing from a tile centre toward
 * its downhill flow-field neighbour. Segments are pushed as flat
 * `x0,y0,x1,y1` quads so the caller can stroke every arrow in one batched path.
 */
function pushFlowArrow(
  out: number[],
  cx: number,
  cy: number,
  dirX: number,
  dirY: number,
  tileSize: number,
): void {
  const shaft = tileSize * 0.34;
  const head = tileSize * 0.18;
  const tipX = cx + dirX * shaft;
  const tipY = cy + dirY * shaft;
  out.push(cx, cy, tipX, tipY);

  // Barbs: the reversed direction rotated ±45° off the tip.
  const bx = -dirX;
  const by = -dirY;
  const c = Math.SQRT1_2;
  out.push(tipX, tipY, tipX + (bx * c - by * c) * head, tipY + (bx * c + by * c) * head);
  out.push(tipX, tipY, tipX + (bx * c + by * c) * head, tipY + (by * c - bx * c) * head);
}

/**
 * Map a normalized flow-field distance (0 at the player, 1 at the farthest
 * reachable tile) to a hot→cool packed RGB colour: red/orange near the goal,
 * fading through green to blue/violet at the edges of the field.
 */
function flowHeatColor(t: number): number {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const hue = 12 + clamped * 240;
  return hsvToColor(hue, 0.85, 1);
}

/** Convert HSV (h in degrees, s/v in 0..1) to a packed 0xRRGGBB integer. */
function hsvToColor(h: number, s: number, v: number): number {
  const c = v * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) {
    r = c;
    g = x;
  } else if (hp < 2) {
    r = x;
    g = c;
  } else if (hp < 3) {
    g = c;
    b = x;
  } else if (hp < 4) {
    g = x;
    b = c;
  } else if (hp < 5) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  const m = v - c;
  const ri = Math.round((r + m) * 255);
  const gi = Math.round((g + m) * 255);
  const bi = Math.round((b + m) * 255);
  return (ri << 16) | (gi << 8) | bi;
}

registerLab('ai-runner', {
  category: 'Meta' as LabCategory,
  name: 'AI Runner',
  description: 'Watch the AI play the game',
  create: createAiRunnerLab,
});
