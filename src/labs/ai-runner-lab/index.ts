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
import { getAvailableFloorIds } from '../../shared/floor-registry.js';
import {
  AIState,
  AIDecisionMode,
  AIPathingMode,
  BehaviorTreeAI,
  RISK_REWARD_FIELD_CONSTANTS,
  type AIDecisionModeValue,
  type AIPathingModeValue,
  type FusedHeadingDebug,
} from '../../game/ai/index.js';
import { DEFAULT_CONFIG } from '../../game/ai/bt-ai-tuning.js';
import {
  autoFloor1ProgressionSystem,
  autoFloor2ProgressionSystem,
  computeAiStatAllocation,
} from '../../game/ai/auto-progression.js';
import {
  runSettlementMaintenancePlanner,
  runEagerMaintenanceTick,
} from '../../game/ai/settlement-maintenance-planner.js';
import { getWeaponPersonaForWorld } from '../../game/ai/weapon-personas.js';
import { configureMerchantWeaponPurchase } from '../../game/ai/merchant-weapon-intent.js';
import { configureSpellBrokerPurchase } from '../../game/ai/spell-broker-intent.js';
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
import { getRuntimeMobMotionProfile } from '../../shared/mob-motion.js';
import {
  FLOOR1_BOSS_BATTLE_QUEST_ID,
  FLOOR1_BOSS_UNLOCK_QUEST_ID,
  FLOOR1_SHOP_QUEST_ID,
  FLOOR1_TUTORIAL_QUEST_ID,
  getQuestDef,
  objectiveTarget,
} from '../../shared/quest-types.js';
import { UI_DEPTH_CUTOFF, WORLD_VFX_DEPTH } from '../../shared/render-depths.js';
import { ftToPx, pxToFt } from '../../shared/units.js';
import { loadLabState, saveLabState } from '../lab-persistence.js';
import { registerLab, type LabCategory } from '../registry.js';
import { createSessionRecorderControls } from '../session-recorder-controls.js';
import { buildSmoothedOverlayPath, OVERLAY_LINE_OF_SIGHT_SAMPLE_PX } from './path-overlay.js';
import {
  AI_RUNNER_SCENARIO_PRESETS,
  DEFAULT_AI_RUNNER_SCENARIO_PRESET_ID,
  getAiRunnerScenarioPreset,
  type AiRunnerScenarioPresetId,
} from './scenario-presets.js';

const LAB_ID = 'ai-runner-lab';
const AI_RUNNER_PANEL_STYLES = `
  .ai-runner-panel {
    --runner-bg: #081120;
    --runner-surface: #0f172a;
    --runner-surface-raised: #172033;
    --runner-border: rgba(148, 163, 184, 0.24);
    --runner-border-strong: rgba(125, 211, 252, 0.42);
    --runner-text: #e2e8f0;
    --runner-muted: #94a3b8;
    --runner-cyan: #7dd3fc;
    --runner-blue: #38bdf8;
    --runner-amber: #fbbf24;
    min-height: 100%;
    color: var(--runner-text);
    background:
      linear-gradient(180deg, rgba(30, 41, 59, 0.34), transparent 180px),
      var(--runner-bg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 12px;
    line-height: 1.45;
  }
  .ai-runner-panel * { box-sizing: border-box; }
  .ai-runner-panel button,
  .ai-runner-panel input,
  .ai-runner-panel select {
    min-height: 34px;
    border: 1px solid var(--runner-border);
    border-radius: 7px;
    color: var(--runner-text);
    background: #0b1220;
    font: inherit;
  }
  .ai-runner-panel button {
    padding: 6px 9px;
    cursor: pointer;
    transition:
      border-color 120ms ease,
      background 120ms ease,
      box-shadow 120ms ease,
      transform 120ms ease;
  }
  .ai-runner-panel button:hover {
    border-color: rgba(125, 211, 252, 0.62);
    background: #172033;
    transform: translateY(-1px);
  }
  .ai-runner-panel button:focus-visible,
  .ai-runner-panel input:focus-visible,
  .ai-runner-panel select:focus-visible,
  .ai-runner-panel summary:focus-visible {
    outline: 2px solid var(--runner-blue);
    outline-offset: 2px;
  }
  .ai-runner-panel button:disabled {
    cursor: not-allowed;
    opacity: 0.48;
    transform: none;
  }
  .runner-app-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 10px 12px 8px;
    border-bottom: 1px solid var(--runner-border);
    background:
      linear-gradient(180deg, rgba(30, 41, 59, 0.84), rgba(15, 23, 42, 0.82)),
      repeating-conic-gradient(rgba(125, 211, 252, 0.04) 0% 25%, transparent 0% 50%) 0 0 /
        8px 8px;
  }
  .runner-title { min-width: 0; }
  .runner-eyebrow,
  .runner-section-label {
    color: var(--runner-muted);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .runner-title h3 {
    margin: 2px 0 0;
    color: #f8fafc;
    font-family: "Press Start 2P", ui-monospace, monospace;
    font-size: 11px;
    line-height: 1.4;
  }
  .runner-mode-pill {
    flex: 0 0 auto;
    max-width: 138px;
    overflow: hidden;
    padding: 4px 8px;
    border: 1px solid rgba(125, 211, 252, 0.34);
    border-radius: 999px;
    color: #bae6fd;
    background: rgba(14, 116, 144, 0.18);
    font-size: 10px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .runner-command-deck {
    position: sticky;
    top: 0;
    z-index: 8;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 10px;
    padding: 12px 10px 10px;
    border-bottom: 1px solid var(--runner-border-strong);
    background:
      linear-gradient(180deg, rgba(15, 23, 42, 0.98), rgba(8, 17, 32, 0.97)),
      repeating-conic-gradient(rgba(125, 211, 252, 0.035) 0% 25%, transparent 0% 50%) 0 0 /
        8px 8px,
      var(--runner-bg);
    box-shadow: 0 10px 24px rgba(2, 6, 23, 0.42);
  }
  .runner-command-deck,
  .runner-primary-actions,
  .runner-transport-row,
  .runner-details,
  .runner-details-body {
    min-width: 0;
    max-width: 100%;
  }
  .runner-status-row,
  .runner-transport-row,
  .runner-setup-heading,
  .runner-telemetry-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .runner-status-row { padding-bottom: 2px; }
  .runner-status {
    color: #f8fafc;
    font-size: 12px;
    font-weight: 700;
  }
  .runner-frame {
    min-width: 0;
    overflow: hidden;
    color: var(--runner-muted);
    font-size: 10px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .runner-primary-actions {
    display: grid;
    width: 100%;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }
  .runner-primary-actions button {
    min-width: 0;
    min-height: 44px;
    padding: 9px 7px;
    overflow: hidden;
    font-weight: 700;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .runner-takeover {
    border-color: rgba(251, 191, 36, 0.62) !important;
    color: #fef3c7 !important;
    background: linear-gradient(135deg, rgba(146, 64, 14, 0.9), rgba(120, 53, 15, 0.9)) !important;
    box-shadow: inset 3px 0 var(--runner-amber);
  }
  .runner-play {
    border-color: #7dd3fc !important;
    color: #082f49 !important;
    background: linear-gradient(135deg, #7dd3fc, #38bdf8) !important;
  }
  .runner-restart { color: #cbd5e1; }
  .runner-transport-row { align-items: stretch; }
  .runner-speed-group {
    display: grid;
    flex: 1 1 auto;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 16px;
  }
  .runner-speed-group button {
    min-height: 32px;
    padding: 4px 7px;
    border-color: rgba(148, 163, 184, 0.18);
    background: rgba(15, 23, 42, 0.66);
  }
  .runner-speed-group button[aria-pressed="true"] {
    border-color: rgba(125, 211, 252, 0.72);
    color: #e0f2fe;
    background: linear-gradient(180deg, rgba(14, 116, 144, 0.56), rgba(14, 116, 144, 0.28));
    box-shadow: 0 0 14px rgba(56, 189, 248, 0.14);
  }
  .runner-step { flex: 0 0 58px; }
  .runner-details {
    overflow: hidden;
    border-top: 1px solid rgba(148, 163, 184, 0.14);
    background: rgba(15, 23, 42, 0.56);
  }
  #ai-run-setup {
    margin-top: 12px;
    border: 1px solid rgba(125, 211, 252, 0.18);
    border-radius: 7px;
    background: rgba(14, 116, 144, 0.08);
  }
  #ai-run-setup > summary > span:first-child::before {
    margin-right: 6px;
    color: var(--runner-cyan);
    content: "◇";
  }
  .runner-details > summary {
    display: flex;
    min-height: 38px;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 10px;
    color: #cbd5e1;
    cursor: pointer;
    font-weight: 700;
    list-style: none;
  }
  .runner-details > summary::-webkit-details-marker { display: none; }
  .runner-details > summary::after {
    display: grid;
    width: 20px;
    height: 20px;
    flex: 0 0 20px;
    place-items: center;
    color: var(--runner-muted);
    content: "+";
    font-size: 16px;
    line-height: 1;
  }
  .runner-details[open] > summary::after { content: "−"; }
  .runner-details-body {
    display: grid;
    gap: 8px;
    padding: 0 10px 10px;
  }
  .runner-field-grid {
    display: grid;
    grid-template-columns: 94px minmax(0, 1fr);
    gap: 7px;
  }
  .runner-field { display: grid; gap: 3px; }
  .runner-field label {
    color: var(--runner-muted);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .runner-field input,
  .runner-field select { width: 100%; min-width: 0; padding: 5px 7px; }
  .runner-setup-actions {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 6px;
  }
  .runner-apply {
    border-color: rgba(125, 211, 252, 0.55) !important;
    color: #e0f2fe !important;
    background: rgba(14, 116, 144, 0.28) !important;
    font-weight: 700;
  }
  .runner-note {
    color: var(--runner-muted);
    font-size: 10px;
    line-height: 1.45;
  }
  .runner-telemetry-strip {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 1px;
    border-bottom: 1px solid var(--runner-border);
    background: var(--runner-border);
  }
  .runner-telemetry-cell {
    min-width: 0;
    padding: 8px 9px;
    background: #0c1526;
  }
  .runner-telemetry-cell strong,
  .runner-telemetry-cell span {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .runner-telemetry-cell strong {
    margin-bottom: 2px;
    color: var(--runner-muted);
    font-size: 8px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .runner-content { display: grid; gap: 8px; padding: 8px; }
  .runner-card {
    overflow: hidden;
    border: 1px solid var(--runner-border);
    border-radius: 9px;
    background: var(--runner-surface);
  }
  .runner-card .runner-details-body { padding-inline: 9px; }
  #ai-telemetry .runner-details-body {
    padding: 22px 20px 32px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    line-height: 2;
  }
  #ai-telemetry { padding: 6px 0 8px; }
  .runner-tree-details {
    margin-top: 4px;
    border: 1px solid rgba(148, 163, 184, 0.14);
    border-radius: 7px;
    background: rgba(15, 10, 45, 0.38);
  }
  .runner-tree-details > summary {
    padding: 8px;
    color: #cbd5e1;
    cursor: pointer;
    font-weight: 700;
  }
  .runner-tree-details #ai-tree { padding: 0 8px 8px; }
  .runner-decision-grid { display: grid; gap: 5px; }
  .runner-debug-grid { display: grid; gap: 7px; }
  .runner-debug-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; }
  .runner-debug-row select { min-width: 0; width: 100%; padding: 5px 7px; }
  .runner-check {
    display: flex;
    align-items: center;
    gap: 7px;
    color: #cbd5e1;
    cursor: pointer;
  }
  .runner-check input { min-height: auto; }
  .runner-tips { margin: 0; padding-left: 16px; color: var(--runner-muted); }
  .runner-tips li + li { margin-top: 4px; }
  @media (prefers-reduced-motion: reduce) {
    .ai-runner-panel button { transition: none; }
  }
`;
const INITIAL_SEED = 42;
const SPEED_OPTIONS = [1, 4, 16] as const;
const INVENTORY_PREVIEW_TICKS = 4;
const SCENARIO_VISUAL_BRIGHTENING: Record<
  AiRunnerScenarioPresetId,
  { ambient: number; sourceIntensity: number; discoveredLight: number } | null
> = {
  'floor1-default': null,
  'spawner-sealable-room': { ambient: 0.38, sourceIntensity: 1.1, discoveredLight: 0.12 },
  'spawner-unsealable-room': { ambient: 0.38, sourceIntensity: 1.1, discoveredLight: 0.12 },
  'spawner-cave': { ambient: 0.4, sourceIntensity: 1.15, discoveredLight: 0.14 },
  // Inspection scene, not a gameplay scene: fully lit so wall/door junctions and
  // corner silhouettes are never hidden by fog or falloff. `ambient` and
  // `discoveredLight` are clamped to [0,1], so 1.0 is "no darkening at all".
  'terrain-wall-junctions': { ambient: 1, sourceIntensity: 1.2, discoveredLight: 1 },
};
type ControlsWithGui = HTMLElement & { __labGui?: GUI };

/**
 * Read `?scenario=<id>` so a specific slice can be linked to and jumped
 * straight into — e.g. `?lab=ai-runner&scenario=terrain-wall-junctions`.
 *
 * This takes priority over the persisted selection on purpose: a link that
 * silently lands on whatever scenario you last had open is not a jump-to link,
 * and the whole point is to make "go look at exactly this" reproducible for the
 * next agent or session. An unknown (but non-empty) id falls back to the
 * default preset rather than returning `null`, so a stale link does not
 * silently restore the persisted scenario (which could be an unrelated spawner
 * preset the user happened to have open last time).
 */
function scenarioPresetIdFromUrl(): AiRunnerScenarioPresetId | null {
  if (typeof window === 'undefined') return null;
  const requested = new URLSearchParams(window.location.search).get('scenario');
  if (!requested) return null;
  return AI_RUNNER_SCENARIO_PRESETS.some((preset) => preset.id === requested)
    ? (requested as AiRunnerScenarioPresetId)
    : DEFAULT_AI_RUNNER_SCENARIO_PRESET_ID;
}

interface AiRunnerLabState {
  showFlowField: boolean;
  lighting: LightingConfig;
  fov: FovConfig;
  /** A/B axis 1 — AI pathing mode (persisted across lab reloads). */
  pathingMode?: AIPathingModeValue;
  /** A/B axis 2 — AI decision mode (persisted across lab reloads). */
  decisionMode?: AIDecisionModeValue;
  seed?: number;
  floorId?: string;
  scenarioPresetId?: AiRunnerScenarioPresetId;
  aiConfig: {
    visualRiskRewardFields: boolean;
    threatPreviewFrames: number;
    autoPauseOnDamage: boolean;
    weaponPersonas?: boolean;
    /** Single shared flag for both optional AI purchases. Replaces the former independent fields. */
    optionalPurchases?: boolean;
    /**
     * @deprecated Retained for reading old persisted state only.
     */
    merchantWeaponPurchase?: boolean;
    /** @deprecated See `merchantWeaponPurchase` deprecation note. */
    spellBrokerPurchase?: boolean;
  };
}

type AiRunnerRunTargetKey = `floor:${string}` | `scenario:${AiRunnerScenarioPresetId}`;

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
  effectiveFloor: 'floor1' | 'floor2' | 'unknown';
  scenarioPreset: AiRunnerScenarioPresetId;
  arenaEntryFrame: number | null;
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
  // When `?scenario=<id>` is present we want the deep link to be fully
  // reproducible: use the preset's own default seed and force floor1, so a
  // tab that last ran Floor 2 with a different seed doesn't contaminate the
  // inspection scene with the wrong floor or the wrong RNG state.
  const urlScenario = scenarioPresetIdFromUrl();
  let selectedScenarioPresetId =
    urlScenario ?? persisted?.scenarioPresetId ?? DEFAULT_AI_RUNNER_SCENARIO_PRESET_ID;
  let currentSeed =
    urlScenario != null
      ? (getAiRunnerScenarioPreset(urlScenario)?.defaultSeed ?? INITIAL_SEED)
      : (persisted?.seed ?? INITIAL_SEED);
  let pendingRunSettingsNote: string | null = null;
  let arenaEntryFrame: number | null = null;

  // AI configuration state. The A/B mode selection (pathingMode/decisionMode)
  // both default to production defaults (DEFAULT_CONFIG) so a fresh lab session
  // matches the shipped game. All fields persist across lab
  // reloads; pathingMode/decisionMode are passed into every BehaviorTreeAI the
  // lab constructs.
  const aiConfig: {
    pathingMode: AIPathingModeValue;
    decisionMode: AIDecisionModeValue;
    visualRiskRewardFields: boolean;
    threatPreviewFrames: number;
    autoPauseOnDamage: boolean;
    weaponPersonas: boolean;
    /** Single shared flag for both optional AI purchases. Default true. */
    optionalPurchases: boolean;
  } = {
    pathingMode: persisted?.pathingMode ?? DEFAULT_CONFIG.pathingMode,
    decisionMode: persisted?.decisionMode ?? DEFAULT_CONFIG.decisionMode,
    visualRiskRewardFields: persisted?.aiConfig?.visualRiskRewardFields ?? false,
    threatPreviewFrames: persisted?.aiConfig?.threatPreviewFrames ?? 0,
    autoPauseOnDamage: persisted?.aiConfig?.autoPauseOnDamage ?? false,
    weaponPersonas: persisted?.aiConfig?.weaponPersonas ?? true,
    optionalPurchases: persisted?.aiConfig?.optionalPurchases ?? true,
  };

  let ai = new BehaviorTreeAI({
    seed: currentSeed,
    aggression: 1,
    retreatThreshold: DEFAULT_CONFIG.retreatThreshold,
    farmPullWeight: DEFAULT_CONFIG.farmPullWeight,
    debug: true,
    pathingMode: aiConfig.pathingMode,
    decisionMode: aiConfig.decisionMode,
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
  let fusedCandidatesGraphics: Phaser.GameObjects.Graphics | null = null;
  let pausedEnemyHoverText: Phaser.GameObjects.Text | null = null;
  let showFlowField = persisted?.showFlowField ?? false;
  let lastStepReason = '';
  const floorDebug = {
    showAllRooms: false,
    jumpTarget: 'spawn-room' as JumpTarget,
    questId: FLOOR1_TUTORIAL_QUEST_ID,
    questAction: 'accept' as 'accept' | 'complete',
  };

  const persistLabState = (): void => {
    saveLabState(LAB_ID, {
      showFlowField,
      lighting: { ...lightingSettings },
      fov: { ...fovSettings },
      pathingMode: aiConfig.pathingMode,
      decisionMode: aiConfig.decisionMode,
      seed: currentSeed,
      floorId: currentFloor,
      scenarioPresetId: selectedScenarioPresetId,
      aiConfig: {
        visualRiskRewardFields: aiConfig.visualRiskRewardFields,
        threatPreviewFrames: aiConfig.threatPreviewFrames,
        autoPauseOnDamage: aiConfig.autoPauseOnDamage,
        weaponPersonas: aiConfig.weaponPersonas,
        optionalPurchases: aiConfig.optionalPurchases,
      },
    });
  };

  const applyScenarioVisualProfile = (presetId: AiRunnerScenarioPresetId): void => {
    const profile = SCENARIO_VISUAL_BRIGHTENING[presetId];
    if (profile === null) {
      Object.assign(lightingSettings, {
        ambient: DEFAULT_LIGHTING_CONFIG.ambient,
        sourceIntensity: DEFAULT_LIGHTING_CONFIG.sourceIntensity,
      });
      fovSettings.discoveredLight = DEFAULT_LIGHTING_CONFIG.discoveredLight;
      return;
    }
    lightingSettings.ambient = profile.ambient;
    lightingSettings.sourceIntensity = profile.sourceIntensity;
    fovSettings.discoveredLight = profile.discoveredLight;
  };

  applyScenarioVisualProfile(selectedScenarioPresetId);

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
          // Capture the fused scorer's candidate fan only when the viz is on.
          // Set on the current `ai` each poll so it stays correct across rebuild/reseed.
          // Default-off elsewhere → zero overhead.
          ai.fusedDebugCapture = aiConfig.visualRiskRewardFields;
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
    configureMerchantWeaponPurchase(world, aiConfig.optionalPurchases);
    configureSpellBrokerPurchase(world, aiConfig.optionalPurchases);
    autoFloor1ProgressionSystem(world, playerEid, ai, aiConfig.weaponPersonas);
    autoFloor2ProgressionSystem(world, playerEid);
    runEagerMaintenanceTick(world, playerEid);
    runSettlementMaintenancePlanner(world);
  };
  let currentFloor = urlScenario != null ? 'floor1' : (persisted?.floorId ?? 'floor1');
  let stagedSeedText = String(currentSeed);
  let stagedRunTarget: AiRunnerRunTargetKey | null = null;
  const recorderControls = createSessionRecorderControls({
    title: 'AI Session Recorder',
    initialController: 'AI',
  });

  // Build scene options from a floor's base options, layering the selected
  // scenario preset's world tweaks on top of the floor's own configureWorld.
  // Shared by the initial build and changeFloor so switching floors preserves
  // the active scenario preset instead of clobbering it.
  const composeSceneOptions: (
    base: ReturnType<typeof createFloorMainSceneOptions>,
  ) => ReturnType<typeof createFloorMainSceneOptions> = (base) => ({
    ...base,
    configureWorld: (world: GameWorld, playerEid: number) => {
      base.configureWorld(world, playerEid);
      const scenarioPreset = getAiRunnerScenarioPreset(selectedScenarioPresetId);
      scenarioPreset?.configureWorld?.(world, playerEid);
    },
    inputCaptureOverride: aiInputProvider,
    worldSeed: currentSeed,
    postSystems: [...base.postSystems, aiAutoDriverSystem],
    autoLevelUpAllocator: (world: GameWorld, playerEid: number, available: number) =>
      manualControl
        ? null
        : computeAiStatAllocation(world, playerEid, available, aiConfig.weaponPersonas),
    sessionRecorderFactory: recorderControls.factory,
    recomposeFloorTransitionOptions: (nextFloorOptions) => {
      // Synchronize lab state with the destination floor before composing.
      // Mirrors the non-reseed portion of applyRunSettings so that currentFloor,
      // selectedScenarioPresetId, and the visual profile stay consistent after an
      // automatic in-process floor transition. resolveScenarioPresetForFloor
      // forces the default for non-floor1 destinations, matching manual switching.
      const destinationFloorId = nextFloorOptions.floorId ?? currentFloor;
      const resolved = resolveScenarioPresetForFloor(destinationFloorId, selectedScenarioPresetId);
      currentFloor = destinationFloorId;
      selectedScenarioPresetId = resolved.presetId;
      applyScenarioVisualProfile(selectedScenarioPresetId);
      persistLabState();
      return composeSceneOptions(nextFloorOptions);
    },
  });

  const sceneOptions = composeSceneOptions(createFloorMainSceneOptions(currentFloor));

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
  const aiFolder = gui.addFolder('AI Configuration');
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
  aiFolder
    .add(aiConfig, 'optionalPurchases')
    .name('Optional purchases (merchant + broker)')
    .onChange(() => {
      persistLabState();
    });
  aiFolder.close();

  // Rebuild the AI brain in place (preserving the current seed) so an A/B mode
  // toggle takes effect immediately without restarting the scene/floor.
  const rebuildAiBrain = (): void => {
    ai = new BehaviorTreeAI({
      seed: currentSeed,
      aggression: 1,
      retreatThreshold: DEFAULT_CONFIG.retreatThreshold,
      farmPullWeight: DEFAULT_CONFIG.farmPullWeight,
      debug: true,
      pathingMode: aiConfig.pathingMode,
      decisionMode: aiConfig.decisionMode,
    });
  };

  const aiModesFolder = gui.addFolder('AI Modes (A/B)');
  aiModesFolder
    .add(aiConfig, 'weaponPersonas')
    .name('Weapon personas')
    .onChange(() => {
      persistLabState();
    });
  aiModesFolder
    .add(aiConfig, 'pathingMode', [AIPathingMode.RISK_REWARD_FUSED])
    .name('Pathing')
    .onChange(() => {
      rebuildAiBrain();
      persistLabState();
    });
  aiModesFolder
    .add(aiConfig, 'decisionMode', [AIDecisionMode.LEGACY])
    .name('Decision')
    .onChange(() => {
      rebuildAiBrain();
      persistLabState();
    });

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

  const resolveScenarioPresetForFloor = (
    floorId: string,
    scenarioPresetId: AiRunnerScenarioPresetId,
  ): { presetId: AiRunnerScenarioPresetId; forcedDefault: boolean } => {
    if (floorId === 'floor1') {
      return { presetId: scenarioPresetId, forcedDefault: false };
    }
    return { presetId: DEFAULT_AI_RUNNER_SCENARIO_PRESET_ID, forcedDefault: true };
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
      retreatThreshold: DEFAULT_CONFIG.retreatThreshold,
      farmPullWeight: DEFAULT_CONFIG.farmPullWeight,
      debug: true,
      pathingMode: aiConfig.pathingMode,
      decisionMode: aiConfig.decisionMode,
    });
    pollCount = 0;
    arenaEntryFrame = null;
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
    fusedCandidatesGraphics?.destroy();
    fusedCandidatesGraphics = null;

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

  const applyRunSettings = (next: {
    seed: number;
    floorId: string;
    scenarioPresetId: AiRunnerScenarioPresetId;
  }): { forcedDefault: boolean } => {
    const scenarioResolution = resolveScenarioPresetForFloor(next.floorId, next.scenarioPresetId);
    currentFloor = next.floorId;
    selectedScenarioPresetId = scenarioResolution.presetId;
    applyScenarioVisualProfile(selectedScenarioPresetId);
    Object.assign(sceneOptions, composeSceneOptions(createFloorMainSceneOptions(currentFloor)));
    reseed(next.seed);
    persistLabState();
    return { forcedDefault: scenarioResolution.forcedDefault };
  };

  const encodeFloorRunTarget = (floorId: string): AiRunnerRunTargetKey => `floor:${floorId}`;

  const encodeScenarioRunTarget = (
    scenarioPresetId: AiRunnerScenarioPresetId,
  ): AiRunnerRunTargetKey => `scenario:${scenarioPresetId}`;

  const decodeRunTarget = (
    runTarget: string,
  ):
    | { kind: 'floor'; floorId: string }
    | { kind: 'scenario'; scenarioPresetId: AiRunnerScenarioPresetId } => {
    if (runTarget.startsWith('scenario:')) {
      const maybeScenario = runTarget.slice('scenario:'.length) as AiRunnerScenarioPresetId;
      const scenarioPreset =
        getAiRunnerScenarioPreset(maybeScenario) ??
        getAiRunnerScenarioPreset(DEFAULT_AI_RUNNER_SCENARIO_PRESET_ID);
      return {
        kind: 'scenario',
        scenarioPresetId: scenarioPreset?.id ?? DEFAULT_AI_RUNNER_SCENARIO_PRESET_ID,
      };
    }
    if (runTarget.startsWith('floor:')) {
      return { kind: 'floor', floorId: runTarget.slice('floor:'.length) };
    }
    return { kind: 'floor', floorId: 'floor1' };
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
        const offeredSpellId = sceneOptions.getSpellRewardOptions?.(world)?.[0]?.id;
        if (offeredSpellId) {
          sceneOptions.selectSpellFromBossBattle?.(world, playerEid, offeredSpellId);
        }
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

  const ensurePausedEnemyHoverText = (): Phaser.GameObjects.Text | null => {
    const scene = getPhaserScene();
    if (!scene) {
      return null;
    }
    if (!pausedEnemyHoverText || !pausedEnemyHoverText.scene) {
      pausedEnemyHoverText = scene.add
        .text(0, 0, '', {
          fontFamily: '"Press Start 2P", ui-monospace, monospace',
          fontSize: '10px',
          color: '#e2e8f0',
          backgroundColor: 'rgba(8, 17, 32, 0.92)',
          padding: { x: 8, y: 6 },
          lineSpacing: 4,
        })
        .setDepth(UI_DEPTH_CUTOFF)
        .setScrollFactor(0)
        .setVisible(false);
    }
    return pausedEnemyHoverText;
  };

  const resolveEnemyDisplayName = (world: GameWorld, eid: number): string => {
    const archetypeId =
      world.floorScenario?.enemyArchetypes.get(eid) ??
      world.enemyAppearanceKeys.get(eid) ??
      world.floorExtendedState?.ambientEnemyArchetypes?.get(eid);
    const profile = archetypeId ? getRuntimeMobMotionProfile(archetypeId) : undefined;
    return profile?.name ?? archetypeId ?? 'Enemy';
  };

  const syncPausedEnemyHoverTooltip = (): void => {
    const text = ensurePausedEnemyHoverText();
    const scene = getScene();
    const phaserScene = getPhaserScene();
    const world = scene?.world;
    const simulationPaused = scene?.isSimulationPaused?.() ?? isPaused;
    if (!text || !scene || !phaserScene || !world || !simulationPaused) {
      if (text) {
        text.setVisible(false);
      }
      return;
    }

    const pointer = phaserScene.input.activePointer;
    const camera = phaserScene.cameras.main;
    if (!pointer || !camera) {
      text.setVisible(false);
      return;
    }

    const worldPoint = camera.getWorldPoint(pointer.x, pointer.y);
    let hoveredEnemy: {
      eid: number;
      currentHp: number;
      maxHp: number;
      name: string;
    } | null = null;
    let hoveredDistSq = Number.POSITIVE_INFINITY;
    for (const eid of query(world.ecs, [Enemy, Position, Health])) {
      const currentHp = world.stores.health.current[eid] ?? 0;
      if (currentHp <= 0) {
        continue;
      }
      const ex = world.stores.position.x[eid] ?? 0;
      const ey = world.stores.position.y[eid] ?? 0;
      const radiusFt = Math.max(world.stores.size.radius[eid] ?? 0, 1);
      const dx = ex - pxToFt(worldPoint.x);
      const dy = ey - pxToFt(worldPoint.y);
      const distSq = dx * dx + dy * dy;
      if (distSq > radiusFt * radiusFt || distSq >= hoveredDistSq) {
        continue;
      }
      hoveredDistSq = distSq;
      hoveredEnemy = {
        eid,
        currentHp: Math.max(0, Math.round(currentHp)),
        maxHp: Math.max(0, Math.round(world.stores.health.max[eid] ?? 0)),
        name: resolveEnemyDisplayName(world, eid),
      };
    }

    if (!hoveredEnemy) {
      text.setVisible(false);
      return;
    }

    text.setText(
      `${hoveredEnemy.name}\n` +
        `eid: ${hoveredEnemy.eid}\n` +
        `health: ${hoveredEnemy.currentHp}/${hoveredEnemy.maxHp}`,
    );
    const maxX = Math.max(8, phaserScene.scale.width - text.width - 8);
    const maxY = Math.max(8, phaserScene.scale.height - text.height - 8);
    text.setPosition(Math.min(pointer.x + 16, maxX), Math.min(pointer.y + 16, maxY));
    text.setVisible(true);
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
   * Debug overlay: draw a danger/reward heatmap around the player.
   * - Red:   danger from *live* enemies only (health > 0 filter)
   * - Green: reward from nearby pickups (XP gems, gold, dropped items)
   * - Cells with no risk AND no reward are skipped entirely (transparent)
   */
  const drawRiskRewardFieldsOverlay = (): void => {
    if (!aiConfig.visualRiskRewardFields) {
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
    // Single source of truth: read the scorer's real field constants so this
    // heatmap can never drift from computeRiskRewardFusedHeading again.
    const DANGER_RADIUS = RISK_REWARD_FIELD_CONSTANTS.dangerRadiusFt;
    const REWARD_RADIUS = 10; // ft — pickup pull radius (heatmap-only radius model)
    const FOG_DANGER = RISK_REWARD_FIELD_CONSTANTS.fogDanger;
    const DRAW_THRESHOLD = 0.05; // skip cells with no meaningful field value

    // Live enemies — mirrors scorer: project by velocity * (lookahead + preview frames)
    // Enemies always move toward the player (flow-map driven), so projected position
    // is always closer — use it directly, not min(current, projected).
    const VELOCITY_LOOKAHEAD = RISK_REWARD_FIELD_CONSTANTS.velocityLookaheadFrames;
    const WALL_PROXIMITY_FT = RISK_REWARD_FIELD_CONSTANTS.wallProximityFt;
    const WALL_AMPLIFICATION = RISK_REWARD_FIELD_CONSTANTS.wallAmplification;
    const totalLookahead = VELOCITY_LOOKAHEAD + aiConfig.threatPreviewFrames;
    const threatPoints: { x: number; y: number; radiusFt: number }[] = [];
    for (const eid of query(world.ecs, [Enemy, Position, Health])) {
      if ((world.stores.health.current[eid] ?? 0) <= 0) continue;
      const ex = world.stores.position.x[eid] ?? 0;
      const ey = world.stores.position.y[eid] ?? 0;
      // Mirrors the scorer's per-threat radius (base danger radius vs. actual
      // ranged attackRange, whichever is larger) — see
      // computeRiskRewardFusedHeading's threatPoints construction.
      const attackRangeFt = world.stores.enemyBehavior.attackRange[eid] ?? 0;
      const radiusFt = Math.max(DANGER_RADIUS, attackRangeFt);
      if (Math.hypot(ex - playerX, ey - playerY) < sampleRadius + radiusFt) {
        const vx = world.stores.velocity.x[eid] ?? 0;
        const vy = world.stores.velocity.y[eid] ?? 0;
        threatPoints.push({ x: ex + vx * totalLookahead, y: ey + vy * totalLookahead, radiusFt });
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
          // Enemy danger using projected positions (per-threat radius).
          for (const t of threatPoints) {
            const dist = Math.hypot(x - t.x, y - t.y);
            if (dist < t.radiusFt) {
              const norm = 1 - dist / t.radiusFt;
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

  const ensureFusedCandidatesGraphics = (): Phaser.GameObjects.Graphics | null => {
    const scene = getPhaserScene();
    if (!scene) {
      return null;
    }
    if (!fusedCandidatesGraphics || !fusedCandidatesGraphics.scene) {
      fusedCandidatesGraphics = scene.add.graphics();
      // Draw above the field heatmap so the chosen ray reads clearly on top of it.
      fusedCandidatesGraphics.setDepth(WORLD_VFX_DEPTH.debugFlowField + 2);
      (scene.cameras.getCamera('ui') as Phaser.Cameras.Scene2D.Camera | null)?.ignore(
        fusedCandidatesGraphics,
      );
    }
    return fusedCandidatesGraphics;
  };

  /**
   * Faithful decision view for RISK_REWARD_FUSED: draws the exact 13-candidate
   * heading fan the scorer evaluated this poll (colored worst→best by score),
   * the chosen heading (bright cyan), and the projected threat points the scorer
   * actually used. Sourced from `ai.getFusedDebug()` — the real scorer output,
   * never a re-derivation — so it can never drift from the decision.
   */
  const drawFusedCandidateOverlay = (): void => {
    const debug: FusedHeadingDebug | null = ai.getFusedDebug();
    if (!aiConfig.visualRiskRewardFields || !debug || debug.candidates.length === 0) {
      fusedCandidatesGraphics?.clear();
      return;
    }
    const graphics = ensureFusedCandidatesGraphics();
    if (!graphics) {
      return;
    }
    graphics.clear();

    const px = ftToPx(debug.playerX);
    const py = ftToPx(debug.playerY);
    const rayLenPx = ftToPx(debug.dangerRadiusFt); // rays span the danger horizon

    // Normalize score across the fan so color encodes relative rank (red→green).
    let minScore = Number.POSITIVE_INFINITY;
    let maxScore = Number.NEGATIVE_INFINITY;
    for (const c of debug.candidates) {
      if (c.score < minScore) minScore = c.score;
      if (c.score > maxScore) maxScore = c.score;
    }
    const span = maxScore - minScore || 1;

    // Projected threat points the scorer used (enemy pos + velocity * lookahead).
    // Each threat's danger-bubble radius is drawn individually — a ranged
    // enemy's bubble extends to its actual attack range, not just the base
    // dangerRadiusFt (see computeRiskRewardFusedHeading's threatPoints).
    for (const t of debug.threats) {
      graphics.fillStyle(0xff3030, 0.5);
      graphics.fillCircle(ftToPx(t.x), ftToPx(t.y), 4);
      graphics.lineStyle(1, 0xff3030, 0.25);
      graphics.strokeCircle(ftToPx(t.x), ftToPx(t.y), ftToPx(t.radiusFt));
    }

    // Candidate rays (skip the chosen one — drawn last, on top).
    for (const c of debug.candidates) {
      if (c.chosen) {
        continue;
      }
      const ex = px + c.dirX * rayLenPx;
      const ey = py + c.dirY * rayLenPx;
      const norm = (c.score - minScore) / span; // 0 = worst, 1 = best
      const rv = Math.round(255 * (1 - norm));
      const gv = Math.round(220 * norm);
      const color = (rv << 16) | (gv << 8) | 0x30;
      graphics.lineStyle(2, color, 0.7);
      graphics.beginPath();
      graphics.moveTo(px, py);
      graphics.lineTo(ex, ey);
      graphics.strokePath();
    }

    // Chosen heading — bright cyan, thick, on top.
    const chosen = debug.candidates.find((c) => c.chosen);
    if (chosen) {
      const ex = px + chosen.dirX * rayLenPx;
      const ey = py + chosen.dirY * rayLenPx;
      graphics.lineStyle(4, 0x33ffff, 0.95);
      graphics.beginPath();
      graphics.moveTo(px, py);
      graphics.lineTo(ex, ey);
      graphics.strokePath();
      graphics.fillStyle(0x33ffff, 0.95);
      graphics.fillCircle(ex, ey, 5);
    }
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
    const focusedId =
      panelRoot.contains(document.activeElement) && document.activeElement instanceof HTMLElement
        ? document.activeElement.id
        : '';
    const openDetails = new Set(
      [...panelRoot.querySelectorAll<HTMLDetailsElement>('details[open]')].map(
        (details) => details.id,
      ),
    );
    const hadRenderedPanel = panelRoot.childElementCount > 0;
    const floorOptions = getAvailableFloorIds();
    const appliedRunTarget: AiRunnerRunTargetKey =
      currentFloor === 'floor1' && selectedScenarioPresetId !== DEFAULT_AI_RUNNER_SCENARIO_PRESET_ID
        ? encodeScenarioRunTarget(selectedScenarioPresetId)
        : encodeFloorRunTarget(currentFloor);
    const selectedRunTarget = stagedRunTarget ?? appliedRunTarget;
    const runTargetOptions = [
      ...floorOptions.map(
        (id) =>
          `<option value="${encodeFloorRunTarget(id)}"${selectedRunTarget === encodeFloorRunTarget(id) ? ' selected' : ''}>Floor: ${id}</option>`,
      ),
      ...AI_RUNNER_SCENARIO_PRESETS.filter(
        (preset) => preset.id !== DEFAULT_AI_RUNNER_SCENARIO_PRESET_ID,
      ).map(
        (preset) =>
          `<option value="${encodeScenarioRunTarget(preset.id)}"${selectedRunTarget === encodeScenarioRunTarget(preset.id) ? ' selected' : ''}>Scenario: ${preset.label}</option>`,
      ),
    ].join('');
    const selectedTarget = decodeRunTarget(selectedRunTarget);
    const selectedScenarioPreset =
      getAiRunnerScenarioPreset(
        selectedTarget.kind === 'scenario'
          ? selectedTarget.scenarioPresetId
          : DEFAULT_AI_RUNNER_SCENARIO_PRESET_ID,
      ) ?? getAiRunnerScenarioPreset(DEFAULT_AI_RUNNER_SCENARIO_PRESET_ID);
    const jumpOptions = Object.entries(JUMP_TARGET_LABELS)
      .map(([value, label]) => `<option value="${value}">${label}</option>`)
      .join('');
    const questOptions = Object.entries(QUEST_DEBUG_TARGETS)
      .map(([label, value]) => `<option value="${value}">${label}</option>`)
      .join('');
    panelRoot.innerHTML = `
      <style>${AI_RUNNER_PANEL_STYLES}</style>
      <section class="ai-runner-panel" aria-label="AI Runner controls">
        <header class="runner-app-bar">
          <div class="runner-title">
            <div class="runner-eyebrow">Live simulation</div>
            <h3>AI Runner</h3>
          </div>
          <span id="ai-control-mode" class="runner-mode-pill">AI is driving</span>
        </header>
        <div id="ai-playback-dock" class="runner-command-deck">
          <div class="runner-status-row">
            <span id="ai-runner-status" class="runner-status" aria-live="polite">Paused</span>
            <span id="ai-runner-debug" class="runner-frame">frame 0</span>
          </div>
          <div class="runner-primary-actions" aria-label="Primary run commands">
            <button id="ai-manual-toggle" class="runner-takeover" type="button">◆ Control</button>
            <button id="ai-toggle-run" class="runner-play" type="button">Resume</button>
            <button id="ai-restart-current" class="runner-restart" type="button" title="Restart with the currently applied seed and target">↻ Restart</button>
          </div>
          <div class="runner-transport-row">
            <div class="runner-speed-group" role="group" aria-label="Simulation speed">
              <button id="ai-speed-1" type="button" aria-pressed="${selectedSpeed === 1}">1x</button>
              <button id="ai-speed-4" type="button" aria-pressed="${selectedSpeed === 4}">4x</button>
              <button id="ai-speed-16" type="button" aria-pressed="${selectedSpeed === 16}">16x</button>
            </div>
            <button id="ai-step-frame" class="runner-step" type="button" title="Advance one frame (Space)">Step</button>
          </div>
          <details id="ai-run-setup" class="runner-details"${openDetails.has('ai-run-setup') ? ' open' : ''}>
            <summary id="ai-run-setup-summary">
              <span>Run setup</span>
              <span class="runner-frame">${currentFloor} · seed ${currentSeed}</span>
            </summary>
            <div class="runner-details-body">
              <div class="runner-field-grid">
                <div class="runner-field">
                  <label for="ai-seed-input">Seed</label>
                  <input id="ai-seed-input" type="number" value="${stagedSeedText}" />
                </div>
                <div class="runner-field">
                  <label for="ai-run-target-select">Target</label>
                  <select id="ai-run-target-select">${runTargetOptions}</select>
                </div>
              </div>
              <div class="runner-setup-actions">
                <button id="ai-run-apply" class="runner-apply" type="button">Apply staged + restart</button>
                <button id="ai-seed-random" type="button" title="Stage a random seed">Randomize</button>
              </div>
              <div id="ai-run-settings-note" class="runner-note">${pendingRunSettingsNote ?? 'Stage a seed or target here; Restart above always replays the applied run.'}</div>
              <div id="ai-scenario-description" class="runner-note">${selectedRunTarget.startsWith('scenario:') ? (selectedScenarioPreset?.description ?? '') : 'Floor target selected — scenario overrides are disabled for this run.'}</div>
            </div>
          </details>
        </div>
        <div class="runner-telemetry-strip" aria-label="Live telemetry summary">
          <div class="runner-telemetry-cell"><strong>State</strong><span id="ai-state">-</span></div>
          <div class="runner-telemetry-cell"><strong>Target</strong><span id="ai-target">-</span></div>
          <div class="runner-telemetry-cell"><strong>Persona</strong><span id="ai-persona">Off</span></div>
        </div>
        <div class="runner-content">
          <details id="ai-telemetry" class="runner-details runner-card"${!hadRenderedPanel || openDetails.has('ai-telemetry') ? ' open' : ''}>
            <summary id="ai-telemetry-summary"><span>Decision telemetry</span><span id="ai-arena-entry-frame" class="runner-frame">Lock-in pending</span></summary>
            <div class="runner-details-body">
              <div id="ai-decision" class="runner-decision-grid">
                <div><strong>Reason:</strong> <span id="ai-reason">-</span></div>
                <div><strong>Path:</strong> <span id="ai-path">-</span></div>
                <div><strong>Modes:</strong> <span id="ai-modes">-</span></div>
                <div><strong>Slack:</strong> <span id="ai-slack">-</span></div>
              </div>
              <details id="ai-tree-details" class="runner-tree-details"${openDetails.has('ai-tree-details') ? ' open' : ''}>
                <summary id="ai-tree-details-summary">Decision tree</summary>
                <div id="ai-tree"></div>
              </details>
            </div>
          </details>
          <details id="ai-floor-debug" class="runner-details runner-card"${openDetails.has('ai-floor-debug') ? ' open' : ''}>
            <summary id="ai-floor-debug-summary"><span>Floor 1 Debug</span></summary>
            <div class="runner-details-body runner-debug-grid">
              <div class="runner-debug-row">
                <select id="ai-jump-target" aria-label="Jump target">${jumpOptions}</select>
                <button id="ai-jump-now" type="button">Jump</button>
              </div>
              <label for="ai-show-all-rooms" class="runner-check">
                <input id="ai-show-all-rooms" type="checkbox" />
                <span>Reveal all rooms (dim)</span>
              </label>
              <select id="ai-quest-target" aria-label="Quest target">${questOptions}</select>
              <div class="runner-debug-row">
                <select id="ai-quest-action" aria-label="Quest action">
                  <option value="accept">Accept / enable quest</option>
                  <option value="complete">Complete quest now</option>
                </select>
                <button id="ai-quest-apply" type="button">Apply</button>
              </div>
            </div>
          </details>
          <details id="ai-recorder" class="runner-details runner-card"${openDetails.has('ai-recorder') ? ' open' : ''}>
            <summary id="ai-recorder-summary"><span>Session recorder</span></summary>
            <div id="ai-recorder-host" class="runner-details-body"></div>
          </details>
          <details id="ai-tips" class="runner-details runner-card"${openDetails.has('ai-tips') ? ' open' : ''}>
            <summary id="ai-tips-summary"><span>Expert shortcuts</span></summary>
            <div class="runner-details-body">
              <ul class="runner-tips">
                <li>Space steps one frame while AI control is paused.</li>
                <li>WASD/arrows move, Space attacks, and E interacts in manual control.</li>
                <li>Lighting, FOV, path overlays, and auto-pause live in the folders above.</li>
              </ul>
            </div>
          </details>
        </div>
      </section>
    `;

    const statusElem = document.getElementById('ai-runner-status');
    if (statusElem) {
      const scene = getScene();
      const scenePaused = scene?.isSimulationPaused?.();
      statusElem.textContent = isPaused
        ? `Paused @ ${selectedSpeed}x`
        : `Running @ ${selectedSpeed}x${scenePaused ? ' (scene paused)' : ''}`;
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
    const personaElem = document.getElementById('ai-persona');
    if (personaElem) {
      const world = getScene()?.world;
      personaElem.textContent = aiConfig.weaponPersonas
        ? world
          ? (getWeaponPersonaForWorld(world)?.name ?? 'Unmapped weapon')
          : 'Pending loadout'
        : 'Off';
    }
    const arenaEntryElem = document.getElementById('ai-arena-entry-frame');
    if (arenaEntryElem) {
      arenaEntryElem.textContent =
        arenaEntryFrame === null
          ? 'AI lock-in frame: pending'
          : `AI lock-in frame: ${arenaEntryFrame}`;
    }

    const runTargetSelect = document.getElementById(
      'ai-run-target-select',
    ) as HTMLSelectElement | null;
    const seedInput = document.getElementById('ai-seed-input') as HTMLInputElement | null;
    const runSettingsNote = document.getElementById('ai-run-settings-note');
    const setScenarioDescription = (presetId: AiRunnerScenarioPresetId): void => {
      const preset =
        getAiRunnerScenarioPreset(presetId) ??
        getAiRunnerScenarioPreset(DEFAULT_AI_RUNNER_SCENARIO_PRESET_ID);
      const description = document.getElementById('ai-scenario-description');
      if (description) {
        description.textContent = preset?.description ?? '';
      }
    };
    if (runTargetSelect) {
      runTargetSelect.onchange = () => {
        stagedRunTarget = runTargetSelect.value as AiRunnerRunTargetKey;
        const decoded = decodeRunTarget(runTargetSelect.value);
        if (decoded.kind === 'scenario') {
          setScenarioDescription(decoded.scenarioPresetId);
        } else {
          const description = document.getElementById('ai-scenario-description');
          if (description) {
            description.textContent =
              'Floor target selected — scenario overrides are disabled for this run.';
          }
        }
        pendingRunSettingsNote =
          'Pick either a Floor target or a Scenario target, then apply once to restart.';
        if (runSettingsNote) {
          runSettingsNote.textContent = pendingRunSettingsNote;
        }
      };
    }
    if (seedInput) {
      seedInput.oninput = () => {
        stagedSeedText = seedInput.value;
      };
    }
    const runApplyButton = document.getElementById('ai-run-apply') as HTMLButtonElement | null;
    if (runApplyButton && runTargetSelect) {
      runApplyButton.onclick = () => {
        const parsed = Number.parseInt(seedInput?.value ?? '', 10);
        const nextSeed = Number.isFinite(parsed) ? parsed : currentSeed;
        const runTarget = decodeRunTarget(runTargetSelect.value);
        const nextFloorId = runTarget.kind === 'scenario' ? 'floor1' : runTarget.floorId;
        const requestedPresetId =
          runTarget.kind === 'scenario'
            ? runTarget.scenarioPresetId
            : DEFAULT_AI_RUNNER_SCENARIO_PRESET_ID;
        const result = applyRunSettings({
          seed: nextSeed,
          floorId: nextFloorId,
          scenarioPresetId: requestedPresetId,
        });
        pendingRunSettingsNote = result.forcedDefault
          ? 'Applied. Non-floor1 runs use the Default Floor 1 scenario preset automatically.'
          : 'Applied. Restarted with the staged Seed/Floor/Scenario.';
        stagedSeedText = String(nextSeed);
        stagedRunTarget = null;
        renderControls();
      };
    }
    const restartButton = document.getElementById('ai-restart-current') as HTMLButtonElement | null;
    if (restartButton) {
      restartButton.onclick = () => {
        applyRunSettings({
          seed: currentSeed,
          floorId: currentFloor,
          scenarioPresetId: selectedScenarioPresetId,
        });
        pendingRunSettingsNote = 'Restarted the currently applied run.';
        renderControls();
      };
    }

    const toggleButton = document.getElementById('ai-toggle-run') as HTMLButtonElement | null;
    if (toggleButton) {
      toggleButton.textContent = isPaused ? 'Resume' : 'Pause';
      toggleButton.style.background = isPaused ? '#1d4ed8' : '#0f766e';
      toggleButton.style.borderColor = isPaused ? '#2563eb' : '#0d9488';
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
      manualButton.textContent = manualControl ? '◆ Return AI' : '◆ Control';
      manualButton.classList.toggle('runner-takeover', !manualControl);
      manualButton.classList.toggle('runner-play', manualControl);
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
      button.setAttribute('aria-pressed', String(selectedSpeed === speed));
      button.onclick = () => {
        selectedSpeed = speed;
        syncSceneSimulationState();
        renderControls();
      };
    }

    const randomButton = document.getElementById('ai-seed-random') as HTMLButtonElement | null;
    if (randomButton) {
      randomButton.onclick = () => {
        const nextSeed = randomRunSeed();
        stagedSeedText = String(nextSeed);
        if (seedInput) {
          seedInput.value = stagedSeedText;
        }
        pendingRunSettingsNote = 'Random seed staged. Click "Apply staged + restart" to run it.';
        if (runSettingsNote) {
          runSettingsNote.textContent = pendingRunSettingsNote;
        }
      };
    }

    const recorderHost = document.getElementById('ai-recorder-host');
    if (recorderHost) {
      recorderControls.mount(recorderHost);
    }
    if (focusedId) {
      document.getElementById(focusedId)?.focus({ preventScroll: true });
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
    if (
      target?.closest(
        'button, input, select, textarea, summary, a, [contenteditable="true"], [role="button"]',
      )
    ) {
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
    const effectiveFloor =
      world?.floorId === 'floor1' || world?.floorId === 'floor2' ? world.floorId : 'unknown';
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
      effectiveFloor,
      scenarioPreset: selectedScenarioPresetId,
      arenaEntryFrame,
      quests,
    };
  };
  if (typeof window !== 'undefined') {
    window.__aiRunnerDebug = buildDebugSnapshot;
  }

  const updateInterval = setInterval(() => {
    autoAdvanceSceneUi();
    const decision = ai.getDecision();
    const scene = getScene();
    const world = scene?.world;
    if (arenaEntryFrame === null && world && decision.reason.startsWith('Arena lock-in')) {
      arenaEntryFrame = world.frameCount;
    }
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
    const modesElem = document.getElementById('ai-modes');
    if (modesElem) {
      let modesText = `pathing=${ai.getPathingMode()} · decision=${ai.getDecisionMode()}`;
      const fused = ai.getFusedDebug();
      if (fused) {
        const chosen = fused.candidates.find((c) => c.chosen);
        const angle = chosen ? `${chosen.angleDeg.toFixed(0)}°` : '?';
        modesText += ` · fused[chosen ${angle} · best ${fused.bestScore.toFixed(2)} · ${fused.candidates.length} cand]`;
      }
      modesElem.textContent = modesText;
    }
    const slackElem = document.getElementById('ai-slack');
    if (slackElem) {
      // Reads the run-plan slack signal. Only populated while travelling under
      // a Floor-1 run plan; 'n/a' otherwise.
      const debug = ai.getTacticalRunDebug();
      const runPlan = debug.runPlan;
      if (!runPlan) {
        slackElem.textContent = 'n/a';
        slackElem.style.color = '#888';
      } else {
        const slackMs = Math.round(runPlan.slackMs);
        const urgency = runPlan.urgency;
        slackElem.textContent = `slack=${slackMs}ms · urgency=${urgency.toFixed(2)}`;
        slackElem.style.color = slackMs < 0 ? '#ff5555' : urgency > 0.66 ? '#ffbb33' : '#55dd55';
      }
    }
    if (treeElem) {
      renderDecisionTree(treeElem, ai.getTree().serialize(), decision);
    }
    syncLightingTelemetry();
    syncFovTelemetry();
    drawPathOverlay();
    drawFlowFieldOverlay();
    drawRiskRewardFieldsOverlay();
    drawFusedCandidateOverlay();
    syncPausedEnemyHoverTooltip();
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
    const personaElem = document.getElementById('ai-persona');
    if (personaElem) {
      personaElem.textContent = !aiConfig.weaponPersonas
        ? 'Off'
        : world
          ? (getWeaponPersonaForWorld(world)?.name ?? 'Unmapped weapon')
          : 'Pending loadout';
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
    riskRewardFieldsGraphics?.destroy();
    riskRewardFieldsGraphics = null;
    fusedCandidatesGraphics?.destroy();
    fusedCandidatesGraphics = null;
    pausedEnemyHoverText?.destroy();
    pausedEnemyHoverText = null;
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
