import { entityExists, query } from 'bitecs';
import Phaser from 'phaser';
import { getGeneratedEquipmentInstance } from '../../core/generated-equipment-registry.js';
import {
  createGameWorld,
  Enemy,
  fovSystem,
  Glowing,
  Harvestable,
  isInSafeContext,
  Position,
  Prop,
  PropLight,
  spawnPlayer,
  type GameWorld,
} from '../../core/index.js';
import { CAMERA, GAME, safeRoomCameraZoom } from '../../shared/constants.js';
import {
  selectScenarioCompletionVariant,
  type ScenarioPresentationContract,
} from '../../shared/scenario-presentation.js';
import {
  LIGHTING_OVERLAY_DEPTH,
  UI_DEPTH_CUTOFF,
  WORLD_VFX_DEPTH,
} from '../../shared/render-depths.js';
import { ftToPx, pxToFt, PIXELS_PER_FOOT } from '../../shared/units.js';
import { INTRO_DATA_REGISTRY_KEY } from '../../shared/intro-config.js';
import { getRenderScale } from '../render-scale.js';
import { ACTIVE_ABILITY_SLOT_LIMIT, createEmptyAbilityState } from '../../shared/abilities.js';
import {
  generatedEquipmentRunKeyFromSeed,
  type GeneratedEquipmentInstanceKey,
} from '../../shared/generated-equipment-types.js';
import { getAbilityPresentation } from '../../shared/ability-presentation.js';
import { HARVESTABLE_DEFS } from '../../shared/harvestableDefs.js';
import { createInputState, type InputState } from '../../shared/input.js';
import { resolveDoorOrientationFromFlanks } from '../../shared/terrain-pack-variants.js';
import {
  buildTerrainLayer,
  type LineworkRunStats,
  type TerrainPackFamily,
} from '../terrain-renderer.js';
import type { TerrainPackId, TransformId } from '../../shared/terrain-pack-types.js';
import {
  resolveDoorRenderMode,
  GENERATED_DOOR_TEXTURE_KEYS,
  DOOR_SHEET_KEY,
  DOOR_TARGET_HEIGHT_FT,
  DOOR_CLOSED_FRAME,
  DOOR_OPEN_FRAME,
  KENNEY_DOOR_FRAME_PX,
  resolveDoorContainFit,
} from '../sprites/door-visuals.js';
import { STAIRS_TEXTURE_KEY, resolveStairsContainFit } from '../sprites/stairs-visuals.js';
import { GENERATED_SPRITE_REGISTRY_KEY } from '../generatedAssets/index.js';
import { type GeneratedSpriteRegistry, type OpaqueBounds } from '../../shared/generated-assets.js';
import { createBarrierOverlay } from '../BarrierOverlay.js';
import { createInputCapture } from '../InputCapture.js';
import { createAbilityLoadoutUI, type AbilityLoadoutEntry } from '../AbilityLoadoutUI.js';
import { createModalPickerUI } from '../ModalPickerUI.js';
import { createDialogueBox, type DialogueBox } from '../DialogueBox.js';
import { getUiScale, onUiScaleChange, type ScreenBounds } from '../ui-scale.js';
import { getSafeAreaInsets, onSafeAreaChange } from '../safe-area.js';
import { createPhaserBridge } from '../PhaserBridge.js';
import { runSimulationStep } from '../sim/simulation-step.js';
import {
  areLightingRectsEqual,
  extrapolateRenderPosition,
  findNearestNearbyNpc,
  formatAbilityTrigger,
  getLightingViewRect,
  renderInterpolationAlpha,
  resolveDialogueLines,
  resolveNpcQuestIndicatorState,
} from './main-game-scene-helpers.js';
import { createHudUI } from '../HudUI.js';
import { createInventoryUI } from '../InventoryUI.js';
import { createEquipmentUI } from '../EquipmentUI.js';
import { equipFromBag } from '../../core/systems/equipmentSystem.js';
import { createAchievementsUI } from '../AchievementsUI.js';
import { createGameOverUI } from '../GameOverUI.js';
import { createLevelUpUI } from '../LevelUpUI.js';
import { createRewardOpeningUI } from '../RewardOpeningUI.js';
import { createBossIntroUI } from '../BossIntroUI.js';
import { resolvePendingBossIntro } from '../boss-intro-state.js';
import { createShopPanelUI } from '../shop/ShopPanelUI.js';
import { createRunSurveyUI } from '../RunSurveyUI.js';
import { validatePlaytestSurvey } from '../../shared/playtest-survey.js';
import { submitRunSurvey } from '../run-bundle-upload.js';
import {
  createAudioCueEngine,
  type AudioCueEngine,
  type SynthCueSpec,
} from '../audio/audio-cue-engine.js';
import { createRewardOpeningAudioController } from '../reward-opening-audio.js';
import { prefersReducedMotion } from '../reduced-motion.js';
import { acknowledgeBossChestReveal } from '../../core/systems/bossChestRewards.js';
import { loadFamilies } from '../../shared/data/families.js';
import {
  blurLightField,
  chooseAutoStepPx,
  clampLightingStepPx,
  computeLightField,
  createLightField,
  DEFAULT_LIGHTING_CONFIG,
  forEachDarknessRun,
  getLightingPresetStepPx,
  LIGHTING_DARKNESS_LEVELS,
  LIGHTING_MIN_DARKNESS,
  type LightField,
  type LightFieldDirtyRect,
  type LightingConfig,
  type LightingPresetId,
} from '../lighting/light-field.js';
import {
  cellPxToSubFactor,
  DEFAULT_FOV_SUB_FACTOR,
  FOV_TILE_SIZE_PX,
  getFovPresetSubFactor,
  normalizeSubFactor,
  subFactorToCellPx,
  type FovConfig,
  type FovPerfSnapshot,
  type FovPresetId,
} from '../fov/fov-config.js';
import { PRIMARY_STATS, type PrimaryStatId } from '../../shared/stats.js';
import {
  createLogCursor,
  createLogger,
  readLogsSince,
  type LogCursor,
} from '../../shared/logger.js';
import { createRunBundle, type RunBundle, type RunEndReason } from '../../shared/run-bundle.js';
import {
  buildFileIssuePayload,
  serializeIssueScreenshot,
  submitFileIssue,
  type FileIssuePayload,
} from '../file-issue.js';
import { getItemById } from '../../shared/items.js';
import { getWeaponDef } from '../../shared/weaponDefs.js';
import { getNpcDef } from '../../shared/npc-types.js';
import type { Floor1SpellBrokerOffer, Floor2ShopInstance } from '../../shared/floor-types.js';
import { getShopArchetype } from '../../shared/data/shop-archetypes.js';
import type { ShopkeeperStage, NpcQuestIndicatorState } from '../../shared/quest-types.js';
import type { SessionRecorder } from '../../shared/session-recorder-types.js';
import { getAchievementById } from '../../shared/achievements.js';
import { listStaticInventorySlots } from '../../shared/inventory.js';
import {
  getQuartermasterOfferViews,
  purchaseQuartermasterOffer,
} from '../../core/quartermaster-purchase.js';
import {
  getSettlementShopOfferViews,
  purchaseSettlementShopOffer,
  type SettlementShopOfferView,
} from '../../core/settlement-shop-purchase.js';
import type { ShopPanelOfferView } from '../shop/ShopPanelUI.js';
import {
  blockReasonFromGold,
  describeShopPurchaseFailure,
  type ShopOffer,
} from '../shop/shop-offer-model.js';
import { openShopModal } from '../shop/shop-modal-presenter.js';

/** Maximum simulation steps per frame to prevent spiral of death. */
const MAX_STEPS_PER_FRAME = 4;
/**
 * Render frames the level-up modal is held open before an `autoLevelUpAllocator`
 * (AI driver) auto-confirms it. ~0.4s at 60fps — long enough for a viewer to see
 * the screen, short enough not to stall the AI playthrough. Counts render frames
 * (the modal freeze skips the fixed-step), so it is independent of sim speed.
 */
const LEVEL_UP_AUTO_HOLD_FRAMES = 24;
/**
 * Render frames the boss-intro lore sheet is held open before an AI-driven run
 * (`autoLevelUpAllocator` wired) auto-dismisses it. ~1s at 60fps — long enough
 * for a viewer/recording to read the billing, short enough not to stall a
 * headless-adjacent AI playthrough. Human play dismisses on input instead.
 */
const BOSS_INTRO_AUTO_HOLD_FRAMES = 60;
/**
 * Render frames the reward-opening `summary` screen is held open before an
 * AI-driven run (`isAutoDriven`/`autoLevelUpAllocator` wired) auto-acknowledges
 * it. ~1s at 60fps — long enough for a viewer/recording to read the reveal,
 * short enough not to stall an AI playthrough forever. Human play (including
 * the AI Runner Lab's manual-control mode) waits for a click/Enter/Space
 * instead — see `RewardOpeningUI`'s own input handling.
 */
const REWARD_OPENING_AUTO_HOLD_FRAMES = 60;
const DIRECTOR_LABEL_TEXT = 'DIRECTOR';
/** Duration each temporary commentary line stays visible (ms). */
const DIRECTOR_COMMENTARY_MS = 3600;
/** Latch ids for the two scenario-independent Director bookend beats. */
const COMMENTARY_INTRO_ID = 'scenario:intro';
const COMMENTARY_VICTORY_ID = 'scenario:victory';
const COMMENTARY_TIMEOUT_ID = 'scenario:timeout';
const MOBILE_CORNER_BUTTON_MAX_SCALE = 1.4;
const CORNER_BUTTON_DEPTH = 1100;
const MODAL_DISMISS_BUTTON_DEPTH = 5001;
const INTERACTION_HINT_MAX_SCALE = 1.25;
const INTERACTION_HINT_BOTTOM_MARGIN = 12;
/** Design-space margin from the safe rect's top-left for the mobile corner buttons. */
const MOBILE_CORNER_BUTTON_MARGIN = 16;
const MOBILE_CORNER_BUTTON_DEPTH = CORNER_BUTTON_DEPTH;
const SET_PIECE_LIGHT_RADIUS_FT = 20;
const SET_PIECE_LIGHT_INTENSITY = 0.7;

// Floor-transition progress bar dimensions (used in both create() and
// startFloorTransitionProgress()).
const FLOOR_TRANS_BAR_W = 400;
const FLOOR_TRANS_BAR_H = 14;
const FLOOR_TRANS_BAR_INNER_W = FLOOR_TRANS_BAR_W - 2;
const FLOOR_TRANS_BAR_INNER_H = FLOOR_TRANS_BAR_H - 2;

const logger = createLogger('engine:main-game-scene');

/** Mark a named stage in the browser performance timeline (no-op in Node). */
function markGame(label: string): void {
  if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
    performance.mark(label);
  }
}

function resolveSetPieceLightEmission(
  spriteId: string,
): { radiusFt: number; intensity: number } | null {
  if (/^prop-wall-sconce-var-\d+$/.test(spriteId)) {
    return { radiusFt: SET_PIECE_LIGHT_RADIUS_FT, intensity: SET_PIECE_LIGHT_INTENSITY };
  }
  if (/^prop-torch-var-\d+$/.test(spriteId)) {
    return { radiusFt: SET_PIECE_LIGHT_RADIUS_FT, intensity: SET_PIECE_LIGHT_INTENSITY };
  }
  if (/^prop-lantern-var-\d+$/.test(spriteId)) {
    return { radiusFt: SET_PIECE_LIGHT_RADIUS_FT, intensity: SET_PIECE_LIGHT_INTENSITY };
  }
  return null;
}

export interface MainGameSceneOptions {
  inputCaptureOverride?: {
    poll: (state: InputState, world: GameWorld) => void;
    reset?: () => void;
    destroy?: () => void;
  };
  /**
   * Seed for the simulation world RNG. When omitted, the world defaults to its
   * built-in seed (42). Exposed so labs/harnesses can replay or randomize runs.
   */
  worldSeed?: number;
  /** Immutable generated-equipment identity shared by every floor in this run. */
  generatedEquipmentRunKey?: string;
  preSystems?: ReadonlyArray<(world: GameWorld) => void>;
  postSystems?: ReadonlyArray<(world: GameWorld) => void>;
  configureWorld?: (world: GameWorld, playerEid: number) => void;
  selectLoadoutOption?: (world: GameWorld, optionIndex: number) => void;
  onStairDescend?: (world: GameWorld, playerEid: number) => boolean | void;
  /**
   * Called when a cleared floor should transition in-process to the next floor.
   * When it returns next-floor options, the scene restarts in process with a
   * fresh world after the transitional message.
   */
  onFloor1Cleared?: (
    world: GameWorld,
    playerEid: number,
  ) => MainGameSceneTransitionOptions | undefined;
  /**
   * Reapplies host-owned options (AI input, recording, lab presets) to the
   * next floor's base options before an in-process restart.
   */
  recomposeFloorTransitionOptions?: (
    nextFloorOptions: MainGameSceneTransitionOptions,
  ) => MainGameSceneTransitionOptions;
  /**
   * Destination floor identifier set by {@link createFloorMainSceneOptions}.
   * Carried through {@link recomposeFloorTransitionOptions} so host layers
   * (e.g. the AI Runner lab) can synchronize their floor-tracking state when
   * the scene transitions in-process to a new floor.
   */
  floorId?: string;
  /** Shopkeeper errand callbacks (game-layer logic injected from main.ts). */
  shopkeeper?: {
    getIndicatorState?: (world: GameWorld) => NpcQuestIndicatorState;
    getStage: (world: GameWorld) => ShopkeeperStage;
    meet: (world: GameWorld) => void;
    returnPrize: (world: GameWorld, playerEid: number) => boolean;
    purchase: (world: GameWorld, playerEid: number) => boolean;
    getPostQuestStock?: (world: GameWorld) => ReadonlyArray<{ itemId: string; cost: number }>;
    purchasePostQuestItem?: (world: GameWorld, playerEid: number, itemId: string) => boolean;
    equip: (world: GameWorld, playerEid: number) => boolean;
    equipmentCost: number;
    equipmentName: string;
    /** True while the merchant is gated behind the welcome-goon quest. */
    isLocked?: (world: GameWorld) => boolean;
  };
  /** Tutorial Goon callbacks — fired on first player-NPC interaction. */
  tutorialGoon?: {
    getIndicatorState?: (world: GameWorld) => NpcQuestIndicatorState;
    meet: (world: GameWorld) => void;
  };
  spellQuestGiver?: {
    getIndicatorState?: (world: GameWorld) => NpcQuestIndicatorState;
    meet: (world: GameWorld) => void;
    /** True while the Spell Broker is gated behind the welcome-goon quest. */
    isLocked?: (world: GameWorld) => boolean;
    getSpellBrokerOffers?: (world: GameWorld) => readonly Floor1SpellBrokerOffer[];
    canPurchaseSpell?: (world: GameWorld, playerEid: number, spellId: string) => boolean;
    purchaseSpell?: (world: GameWorld, playerEid: number, spellId: string) => boolean;
  };
  /** Floor 2 Broker callbacks — fired when the player reads all intro dialogue lines. */
  broker?: {
    met: (world: GameWorld) => void;
  };
  /** Spell selection callback for floor1 boss battle reward. */
  selectSpellFromBossBattle?: (world: GameWorld, playerEid: number, spellId: string) => void;
  getSpellRewardOptions?: (
    world: GameWorld,
  ) => Array<{ id: string; label: string; description: string }>;
  /**
   * Apply level-up stat allocations (game-layer `spendPoints` injected from
   * main.ts). When omitted, the level-up screen is skipped and the run resumes
   * immediately — labs/harnesses without progression wiring keep working.
   */
  allocateStatPoints?: (
    world: GameWorld,
    playerEid: number,
    allocations: Partial<Record<PrimaryStatId, number>>,
  ) => void;
  /**
   * Optional AI driver for the level-up screen. When set, the scene lets the
   * level-up modal render for a brief, deterministic hold (so a viewer can see
   * it) and then auto-confirms it with this allocator's chosen points — driving
   * the real level-up UX instead of bypassing it. Used by the AI Runner Lab;
   * omitted for human play so the player allocates manually.
   */
  autoLevelUpAllocator?: (
    world: GameWorld,
    playerEid: number,
    available: number,
  ) => Partial<Record<PrimaryStatId, number>> | null;
  /**
   * Optional predicate reporting whether an AI — not a human — is currently
   * driving the run. Surfaces that would otherwise wait forever for a keypress
   * (the boss-intro lore sheet) auto-advance only while this returns true.
   *
   * Distinct from {@link autoLevelUpAllocator} on purpose: the AI Runner Lab
   * always supplies an allocator but hands control back to a human in
   * manual-control mode, so allocator presence is NOT a reliable "AI is
   * driving" signal. When omitted, allocator presence is used as the fallback
   * for harnesses that only wire the allocator.
   */
  isAutoDriven?: () => boolean;
  /**
   * Optional factory for a human player session recorder (dev/debug only).
   *
   * Called once after the world and player entity are created. The factory
   * receives the live world and playerEid and should return a {@link SessionRecorder}.
   * The scene calls `recorder.tick()` every simulation step and emits kill/levelup
   * events. The recorder is also exposed as `window.__playerSessionRecorder`.
   *
   * Implement with `createPlayerSessionRecorder` from
   * `src/game/ai/player-session-recorder.ts`. The engine only depends on the
   * shared {@link SessionRecorder} interface, keeping layer boundaries intact.
   */
  sessionRecorderFactory?: (world: GameWorld, playerEid: number) => SessionRecorder;
  /** Builds the concrete game-layer RunStats without importing game code here. */
  runStatsFactory?: (
    world: GameWorld,
    playerEid: number,
    outcome: 'victory' | 'death' | 'timeout' | 'stalled' | 'quit',
    runStartXp?: number,
    recorderStats?: ReturnType<SessionRecorder['getStats']>,
  ) => unknown;
  /** Receives the completed run artifact before reload or scene restart. */
  onRunBundle?: (bundle: RunBundle) => Promise<unknown> | void;
  /**
   * Per-floor lighting overrides, merged over {@link DEFAULT_LIGHTING_CONFIG}
   * when the scene is created. The shipped game passes the floor manifest's
   * ambient here (see `createFloorMainSceneOptions`); labs may omit it to use
   * the global defaults.
   */
  lightingConfig?: Partial<LightingConfig>;
  /**
   * Registry-backed terrain pack id for this floor (e.g. Floor 2's
   * `industrial-cave`). Set by `createFloorMainSceneOptions` from the floor
   * manifest's `terrainPackId`. When present, `drawFloorTerrain` forwards it to
   * {@link buildTerrainLayer} so WALL/FLOOR/CORRIDOR tiles stamp the pack's
   * atlas/pool textures; when omitted (Floor 1) the legacy path renders.
   */
  terrainPackId?: TerrainPackId;
  /** Optional per-terrain-family overrides for mixed-biome floors. */
  terrainPacks?: Partial<Record<TerrainPackFamily, TerrainPackId>>;
  /**
   * The active scenario's presentation contract (Director beats, stair
   * marker/confirmation, terminal outcome and completion copy). Supplied by
   * `createFloorMainSceneOptions`; when omitted the scene simply presents none
   * of those surfaces, so labs that boot a bare world stay valid.
   *
   * This is the seam that keeps floor identity out of the engine: the scene
   * asks the contract what to narrate, mark, prompt, and conclude instead of
   * branching on Floor 1 vs Floor 2 state.
   */
  scenarioPresentation?: ScenarioPresentationContract<GameWorld>;
}

export type MainGameSceneTransitionOptions = MainGameSceneOptions &
  Required<Pick<MainGameSceneOptions, 'configureWorld' | 'preSystems' | 'postSystems'>>;

interface MainGameSceneInitData {
  readonly mainGameSceneOptions?: MainGameSceneOptions;
}

/**
 * One synthesized reward-opening audio cue as actually dispatched to the
 * `AudioCueEngine`, captured for test/automation observability (unit,
 * integration, and E2E). Mirrors `SynthCueSpec` rather than internal
 * intensity/rarity inputs so tests assert on the real synthesized signal
 * (label ordering, gain monotonicity, reduced-intensity scaling) instead of
 * implementation details.
 */
export interface RewardAudioCueLogEntry {
  readonly label: string;
  readonly frequencyHz: number;
  readonly durationMs: number;
  readonly gain: number;
}

declare global {
  interface Window {
    __floor1Debug?: {
      getState: () => {
        worldState: GameWorld['state'];
        runOutcome: string | null;
        floorCompletionMessagePending: boolean;
        floorCompletionMessageShown: boolean;
        modalOpen: boolean;
      };
      forceCompletionModal: () => void;
      /** Dev-only: direct world + player access for screenshot/automation scripts. */
      getWorld?: () => GameWorld;
      getPlayerEid?: () => number;
      getIntroData?: () =>
        | { playerName: string; playerGender: 'female' | 'male' | 'other' }
        | undefined;
      getDirectorCommentaryText?: () => string | null;
      /**
       * Dev-only: which art each door tile rendered from on the last overlay
       * pass, in the REAL game (the probe lab has its own copy of this seam).
       */
      getDoorRenderSummary?: () => {
        closedGeneratedCount: number;
        closedKenneyCount: number;
        closedColorCount: number;
        openGeneratedCount: number;
        openKenneyCount: number;
        openColorCount: number;
        crossOrientationCount: number;
        renderableClosedCount: number;
        renderableOpenCount: number;
      };
      /** Dev-only: is a texture key actually registered in the Phaser cache? */
      hasTexture?: (key: string) => boolean;
      lighting: {
        getConfig: () => LightingConfig;
        setConfig: (partial: Partial<LightingConfig>) => void;
        usePreset: (preset: LightingPresetId) => void;
        getPerf: () => {
          computeMsAvg: number;
          stepPx: number;
          fieldStepPx: number;
          updateEveryNFrames: number;
        };
      };
      fov: {
        getConfig: () => FovConfig;
        setConfig: (partial: Partial<FovConfig>) => FovConfig;
        usePreset: (preset: FovPresetId) => FovConfig;
        getPerf: () => FovPerfSnapshot;
      };
    };
    /** Optional human player session recorder. Set when the factory is provided. */
    __playerSessionRecorder?: SessionRecorder;
  }
}

export class MainGameScene extends Phaser.Scene {
  static readonly KEY = 'MainGameScene';

  private bridge?: ReturnType<typeof createPhaserBridge>;

  private inputState!: InputState;

  private inputCapture?: ReturnType<typeof createInputCapture>;

  private playerEid = -1;

  private world!: GameWorld;

  private previousWorldState: GameWorld['state'] | null = null;

  /** Accumulated real time not yet consumed by fixed-step simulation (ms). */
  private accumulator = 0;

  private accumulatorClampCount = 0;

  /**
   * Render-side interpolation factor for the current frame (`0..1`): how far
   * into the next fixed simulation step the rendered frame sits. Zero on frozen
   * frames (pause, modals, dialogue) where no step is in flight. Consumed by
   * `bridge.sync` and `updateCamera` so both extrapolate identically.
   */
  private renderInterpAlpha = 0;
  private playerRenderSampleFrame = -1;
  private playerRenderSampleEid = -1;
  private playerRenderPrevX = 0;
  private playerRenderPrevY = 0;
  private playerRenderCurrX = 0;
  private playerRenderCurrY = 0;

  private simulationPaused = false;

  private simulationSpeed = 1;

  private pendingSimulationSteps = 0;

  private warnedMissingDependencies = false;

  private modalPicker?: ReturnType<typeof createModalPickerUI>;
  private abilityLoadoutUI?: ReturnType<typeof createAbilityLoadoutUI>;
  private issueButton?: Phaser.GameObjects.Text;
  private issueReportPausedState?: boolean;
  private issueReportDescription = '';
  private issueReportIncludeLogs = true;
  private issueReportIncludeScreenshot = false;
  private issueReportScreenshot?: string;
  private issueReportScreenshotError?: string;
  private issueReportSubmitting = false;
  private issueReportRunId?: string;
  private issueReportRetryPayload?: FileIssuePayload;
  private issueReportAttemptCounter = 0;

  /**
   * Optional human player session recorder. Non-null only when
   * `options.sessionRecorderFactory` is provided.
   */
  private sessionRecorder?: SessionRecorder;
  private runStartXp = 0;
  private runLogCursor!: LogCursor;
  private runBundleEmitted = false;
  private lastRunBundle?: RunBundle;
  private lastRunBundleUpload?: Promise<unknown>;
  private runSurveyUI?: ReturnType<typeof createRunSurveyUI>;
  private runSurveyShown = false;
  private runSurveySubmitted = false;

  /** Enemy count from the previous simulation step — used to detect kills. */
  private prevEnemyCount = 0;

  /** Player level from the previous simulation step — used to detect level-ups. */
  private prevPlayerLevel = 0;

  /** Terrain tile layer — baked once per floor as a RenderTexture. */
  private mapRt?: Phaser.GameObjects.RenderTexture;

  /**
   * Diagnostic tile counts from the last `buildTerrainLayer` bake. Read by the
   * main-scene-probe-lab observe seam (`getTerrainRenderSummary`) to prove — in
   * a REAL booted scene — that approved generated tile textures actually stamp
   * (`generatedCount > 0`). Terrain bakes into ONE RenderTexture, so display-list
   * counting cannot see per-tile provenance; these counts are the only seam.
   */
  private terrainRenderSummary: {
    generatedCount: number;
    spriteCount: number;
    colorCount: number;
    packWallCount: number;
    packFloorCount: number;
    packCorridorCount: number;
    packSpecialFloorCount: number;
    packFloorSourceCounts: Record<string, number>;
    packFloorTransformCounts: Partial<Record<TransformId, number>>;
    packFloorComboCounts: Record<string, number>;
    packCorridorSourceCounts: Record<string, number>;
    packCorridorTransformCounts: Partial<Record<TransformId, number>>;
    packCorridorComboCounts: Record<string, number>;
    packWallAccentedCount: number;
    packWallAccentCounts: Record<string, number>;
    packGroundDecalCount: number;
    packLineworkTileCount: number;
    packLineworkPropCount: number;
    packLineworkBuriedCount: number;
    packLineworkBuriedSample: readonly { readonly tx: number; readonly ty: number }[];
    packLineworkRuns: readonly LineworkRunStats[];
    packLineworkHubs: readonly { readonly tx: number; readonly ty: number }[];
  } = {
    generatedCount: 0,
    spriteCount: 0,
    colorCount: 0,
    packWallCount: 0,
    packFloorCount: 0,
    packCorridorCount: 0,
    packSpecialFloorCount: 0,
    packFloorSourceCounts: {},
    packFloorTransformCounts: {},
    packFloorComboCounts: {},
    packCorridorSourceCounts: {},
    packCorridorTransformCounts: {},
    packCorridorComboCounts: {},
    packWallAccentedCount: 0,
    packWallAccentCounts: {},
    packGroundDecalCount: 0,
    packLineworkTileCount: 0,
    packLineworkPropCount: 0,
    packLineworkBuriedCount: 0,
    packLineworkBuriedSample: [],
    packLineworkRuns: [],
    packLineworkHubs: [],
  };

  /**
   * Diagnostic door-render counts from the last `updateDoorOverlay()` pass. Read
   * by the main-scene-probe-lab observe seam (`getDoorRenderSummary`) to prove —
   * in a REAL booted scene — that every dungeon door renders from the single
   * unified door path, on every floor, with no placeholder fallback.
   *
   * The kind buckets are mutually exclusive; `renderableClosedCount` is the sum of
   * the three CLOSED buckets so an e2e can tell "no eligible closed doors on this
   * map" (0) apart from "wrong branch taken" (generated !== renderable).
   *
   * `crossOrientationCount` is deliberately NOT a kind bucket — it counts doors
   * that rendered generated art authored for the OTHER orientation, which is a
   * visible projection defect a kind-count gate cannot detect: every E/W doorway
   * could borrow the face-on N/S leaf while `openGeneratedCount` still equals
   * `renderableOpenCount`. Doors are drawn per-frame, so these reflect the most
   * recent overlay pass.
   */
  private doorRenderSummary: {
    closedGeneratedCount: number;
    closedKenneyCount: number;
    closedColorCount: number;
    openGeneratedCount: number;
    openKenneyCount: number;
    openColorCount: number;
    crossOrientationCount: number;
    renderableClosedCount: number;
    renderableOpenCount: number;
  } = {
    closedGeneratedCount: 0,
    closedKenneyCount: 0,
    closedColorCount: 0,
    openGeneratedCount: 0,
    openKenneyCount: 0,
    openColorCount: 0,
    crossOrientationCount: 0,
    renderableClosedCount: 0,
    renderableOpenCount: 0,
  };

  /** Dynamic darkness overlay rendered from a configurable light field. */
  private lightOverlayRt?: Phaser.GameObjects.RenderTexture;

  private doorGraphics?: Phaser.GameObjects.Graphics;

  /** Per-frame overlay renderer for dynamic barriers (spawner arena, etc.). */
  private barrierOverlay?: ReturnType<typeof createBarrierOverlay>;

  /** Per-door sprite Images (Tiny Dungeon door art), rebuilt on door updates. */
  private doorImages: Phaser.GameObjects.Image[] = [];

  private staircaseMarker?: Phaser.GameObjects.Arc;

  /** Generated stairs-art decal stamped over `staircaseMarker`'s footprint, when loaded. */
  private staircaseSprite?: Phaser.GameObjects.Image;

  /**
   * Whether the last `renderStaircaseMarker()` pass stamped the approved
   * generated stairs art (vs. the plain-circle fallback). Read by the
   * main-scene-probe-lab observe seam (`getStaircaseMarkerRenderInfo`) to
   * prove — in a REAL booted scene — that the floor-exit marker renders real
   * stairs art rather than only a circle.
   */
  private staircaseMarkerUsesGeneratedArt = false;

  /**
   * Cached opaque-bounds lookup for `STAIRS_TEXTURE_KEY` in the generated
   * sprite registry: `undefined` = not yet looked up, `null` = looked up but
   * not found. The registry entry never changes after boot, so this avoids
   * re-scanning it on every `renderStaircaseMarker()` call.
   */
  private staircaseBoundsCache?: OpaqueBounds | null;

  private readonly npcQuestIndicators = new Map<number, Phaser.GameObjects.Text>();

  private loadoutText?: Phaser.GameObjects.Text;

  private hudUi?: ReturnType<typeof createHudUI>;

  // Tracks whether the HUD is currently hidden because a full-screen character
  // panel (equipment/inventory) is open, so we only toggle on change.
  private hudHiddenForPanel = false;

  private keyOne?: Phaser.Input.Keyboard.Key;

  private keyTwo?: Phaser.Input.Keyboard.Key;

  private keyThree?: Phaser.Input.Keyboard.Key;

  private keyE?: Phaser.Input.Keyboard.Key;

  private keyEsc?: Phaser.Input.Keyboard.Key;

  private keyInventory?: Phaser.Input.Keyboard.Key;

  private keyEquip?: Phaser.Input.Keyboard.Key;

  private keyAbilities?: Phaser.Input.Keyboard.Key;

  private keyAchievements?: Phaser.Input.Keyboard.Key;

  private keyQuartermaster?: Phaser.Input.Keyboard.Key;

  private inventoryUI?: ReturnType<typeof createInventoryUI>;
  private equipmentUI?: ReturnType<typeof createEquipmentUI>;
  private achievementsUI?: ReturnType<typeof createAchievementsUI>;
  /** Shared full-screen anticipation->reveal->summary sequence (achievements + boss chests). */
  private rewardOpeningUI?: ReturnType<typeof createRewardOpeningUI>;
  private shopPanelUI?: ReturnType<typeof createShopPanelUI>;
  /** Procedural WebAudio synth backing the reward-opening audio cues; safe no-op if unavailable. */
  private rewardAudioEngine?: ReturnType<typeof createAudioCueEngine>;
  private rewardAudioController?: ReturnType<typeof createRewardOpeningAudioController>;
  /**
   * Test/automation observability only: every `SynthCueSpec` actually
   * dispatched to `rewardAudioEngine.play()`, in dispatch order. Populated by
   * a thin logging wrapper around the real engine so unit/integration/E2E
   * coverage can assert on cue ordering, intensity monotonicity, and
   * reduced-motion scaling against the REAL wiring — never read by gameplay
   * code.
   */
  private rewardAudioCueLog: RewardAudioCueLogEntry[] = [];

  private gameOverUI?: ReturnType<typeof createGameOverUI>;

  private levelUpUI?: ReturnType<typeof createLevelUpUI>;

  private bossIntroUI?: ReturnType<typeof createBossIntroUI>;

  /** `BossIntroContent.introId`s already presented this run (show-once). */
  private readonly shownBossIntroIds = new Set<string>();

  /** Frames the boss-intro sheet has been held open for an AI-driven run. */
  private bossIntroAutoHoldFrames = 0;

  /** Chest ids already surfaced via a one-time "ready to open" toast. */
  private readonly notifiedBossChestIds = new Set<string>();

  /**
   * Frames the reward-opening `summary` screen has been held open for an
   * AI-driven run. Reset whenever the overlay is not open or not yet at
   * `summary` (the `anticipation`/`revealing` phases already advance on their
   * own via `tick()`).
   */
  private rewardOpeningAutoHoldFrames = 0;

  /**
   * Frames the level-up modal has been held open while an `autoLevelUpAllocator`
   * (AI driver) is wired. Counts render frames so the modal stays visible briefly
   * before the AI auto-confirms it. Reset whenever the modal is not open.
   */
  private levelUpAutoHoldFrames = 0;

  /** Latches true once the death-screen has been shown (to avoid re-triggering). */
  private deathScreenShown = false;

  /** True when the prize was handed over during the current shopkeeper talk. */
  private shopkeeperJustReturned = false;

  /** Latches so the inventory/equipment unlock toasts only show once. */
  private inventoryUnlockNotified = false;

  private equipmentUnlockNotified = false;

  private spellsUnlockNotified = false;

  /** World-space label shown above the staircase marker. */
  private stairsLabel?: Phaser.GameObjects.Text;

  /** Screen-space interaction hint shown when near an NPC or the stairs. */
  private interactionHint?: Phaser.GameObjects.Text;

  private offInteractionHintScale?: () => void;
  private offInteractionHintSafeArea?: () => void;

  /** Screen-space pixel-themed NPC dialogue box shown while a line is active. */
  private dialogueBox?: DialogueBox;

  /** Screen-space temporary commentary text for scenario callouts. */
  private directorCommentaryText?: Phaser.GameObjects.Text;

  private floorCompletionScreen?: Phaser.GameObjects.Container;

  private floorCompletionTitleText?: Phaser.GameObjects.Text;

  private floorCompletionSubtitleText?: Phaser.GameObjects.Text;

  private floorCompletionBodyText?: Phaser.GameObjects.Text;

  /** Progress bar shown during floor-to-floor transitions (hidden otherwise). */
  private floorTransitionProgressTrack?: Phaser.GameObjects.Rectangle;

  private floorTransitionProgressFill?: Phaser.GameObjects.Rectangle;

  private floorTransitionProgressShine?: Phaser.GameObjects.Rectangle;

  private floorTransitionProgressLabel?: Phaser.GameObjects.Text;

  /** Dedicated UI camera so HUD is not affected by world camera zoom. */
  private uiCamera?: Phaser.Cameras.Scene2D.Camera;

  /**
   * Tracks whether the world camera is currently zoomed in for a safe room, so
   * the smooth zoom tween only fires on the enter/leave transition.
   */
  private cameraInSafeRoom = false;

  private readonly uiMaskIgnoreList: Phaser.GameObjects.GameObject[] = [];

  private readonly worldMaskIgnoreList: Phaser.GameObjects.GameObject[] = [];

  private previousBossEids: Map<string, number | null> = new Map();

  /** Active NPC conversation lock; when set, fixed-step simulation pauses. */
  private conversationNpcEid: number | null = null;
  /** Stable dialogue snapshot for the active conversation so lines cannot swap mid-talk. */
  private activeConversationLines: readonly string[] | null = null;

  /** One-frame latch set by pointer tap/click to advance or start dialogue. */
  private tappedInteraction = false;

  /** One-frame latch set by tapping the interaction hint button. */
  private queuedInteraction = false;

  /** One-frame latch set by tapping the dialogue close button. */
  private queuedConversationClose = false;
  /** One-frame latch for opening the abilities configurator from global keyboard capture. */
  private queuedAbilitiesToggle = false;
  /** One-frame latch set by tapping the on-screen inventory button. */
  private queuedInventoryToggle = false;
  /** One-frame latch set by tapping the on-screen equip button. */
  private queuedEquip = false;

  private inventoryButton?: Phaser.GameObjects.Text;

  private equipButton?: Phaser.GameObjects.Text;

  private achievementsButton?: Phaser.GameObjects.Text;

  /** Touch button for the abilities config modal. */
  private abilitiesButton?: Phaser.GameObjects.Text;

  /** Touch dismiss button for the Quartermaster panel while it is open. */
  private quartermasterButton?: Phaser.GameObjects.Text;

  /** One-frame latch set by tapping the on-screen achievements button. */
  private queuedAchievementsToggle = false;

  /** One-frame latch set by tapping the on-screen quartermaster dismiss button. */
  private queuedQuartermasterToggle = false;
  /** One-frame latch set by interacting with any settlement shop NPC. */
  private queuedSettlementShopNpcEid: number | null = null;
  /** NPC identity whose settlement stock is currently being shown in the shared shop panel. */
  private activeSettlementShopNpcEid: number | null = null;

  /**
   * Tracks whether the currently open modalPicker is the abilities config modal
   * (vs loadout or spell-selection modals). Used to allow [B] to toggle-close
   * and to auto-close when the player leaves the safe room.
   */
  private abilitiesModalOpen = false;

  /** Transient "New achievement" toast, separate from the interaction hint. */
  private achievementToast?: Phaser.GameObjects.Text;

  private offMobileButtonScale?: () => void;
  private offMobileButtonSafeArea?: () => void;

  private floorCompletionMessageShown = false;

  private floorCompletionMessagePending = false;

  private commentaryHideAtMs = 0;

  /**
   * Ids of Director beats already shown this run, latched so each beat fires
   * exactly once. Holds the scenario's own milestone ids plus the two
   * scenario-independent bookends below.
   */
  private shownCommentaryIds = new Set<string>();

  private cameraMasksDirty = true;

  private lighting: LightingConfig = { ...DEFAULT_LIGHTING_CONFIG };

  private lightField?: LightField;

  private lightingDirty = true;

  private lightingLastSource?: { x: number; y: number };

  private lightingLastSecondarySourcesKey?: string;

  private lightingLastViewRect?: LightFieldDirtyRect;

  private lightingComputeMsAvg = 0;

  private lightingOverBudgetFrames = 0;

  /**
   * Scene-owned canonical FOV sub-tile factor (the lab's selection). Re-applied
   * to each freshly-installed FloorMap in `drawFloorTerrain` so a chosen
   * granularity survives floor transitions / reseeds (C3). Defaults to the
   * historical quarter-tile resolution.
   */
  private fovSubFactor: number = DEFAULT_FOV_SUB_FACTOR;

  private fovComputeMsAvg = 0;

  private fovLastComputeMs = 0;

  constructor(private options: MainGameSceneOptions = {}) {
    super({ key: MainGameScene.KEY });
  }

  init(data?: MainGameSceneInitData): void {
    if (data?.mainGameSceneOptions) {
      this.options = data.mainGameSceneOptions;
    }
  }

  create(): void {
    markGame('game:create-start');
    const worldSeed = this.options.worldSeed ?? 42;
    this.world = createGameWorld({
      seed: worldSeed,
      generatedEquipmentRunKey:
        this.options.generatedEquipmentRunKey ?? generatedEquipmentRunKeyFromSeed(worldSeed),
    });
    this.runLogCursor = createLogCursor();
    this.runBundleEmitted = false;
    this.lastRunBundle = undefined;
    this.lastRunBundleUpload = undefined;
    this.runSurveyShown = false;
    this.runSurveySubmitted = false;

    // Apply player identity selected in IntroScene BEFORE configureWorld, so
    // scenario initializers (e.g. initializeFloor1Scenario) see the chosen name.
    const introData = this.game.registry.get(INTRO_DATA_REGISTRY_KEY) as
      | { playerName: string; playerGender: 'female' | 'male' | 'other' }
      | undefined;
    if (introData) {
      this.world.playerName = introData.playerName;
      this.world.playerGender = introData.playerGender;
    }
    this.inputState = createInputState();
    if (this.options.inputCaptureOverride) {
      this.inputCapture = {
        poll: (state: InputState) => this.options.inputCaptureOverride?.poll(state, this.world),
        reset: () => this.options.inputCaptureOverride?.reset?.(),
        destroy: () => this.options.inputCaptureOverride?.destroy?.(),
      };
    } else {
      this.inputCapture = createInputCapture(this, {
        getFollowOrigin: () =>
          this.playerEid < 0
            ? undefined
            : {
                // Camera world-space is pixels; scale the player's feet position.
                x: ftToPx(this.world.stores.position.x[this.playerEid] ?? 0),
                y: ftToPx(this.world.stores.position.y[this.playerEid] ?? 0),
              },
      });
    }
    this.accumulator = 0;
    this.previousWorldState = this.world.state;
    this.accumulatorClampCount = 0;
    this.warnedMissingDependencies = false;
    this.floorCompletionMessageShown = false;
    this.floorCompletionMessagePending = false;
    this.deathScreenShown = false;
    this.commentaryHideAtMs = 0;
    this.shownCommentaryIds.clear();

    this.playerEid = spawnPlayer(this.world, GAME.WIDTH / 2, GAME.HEIGHT / 2);
    this.options.configureWorld?.(this.world, this.playerEid);
    this.runStartXp = this.world.playerLevel?.xp ?? 0;

    logger.info('Main game scene created', {
      state: this.world.state,
      preSystems: this.options.preSystems?.length ?? 0,
      postSystems: this.options.postSystems?.length ?? 0,
    });

    // Wire session recorder if factory provided (dev/debug injection from caller).
    if (this.options.sessionRecorderFactory) {
      this.sessionRecorder = this.options.sessionRecorderFactory(this.world, this.playerEid);
      this.prevEnemyCount = query(this.world.ecs, [Enemy]).length;
      this.prevPlayerLevel = this.world.playerLevel?.level ?? 0;
      if (typeof window !== 'undefined') {
        window.__playerSessionRecorder = this.sessionRecorder;
      }
      logger.info('[session-recorder] Player session recording started');
    }

    this.bridge = createPhaserBridge(this);
    this.modalPicker = createModalPickerUI(this);
    this.abilityLoadoutUI = createAbilityLoadoutUI(this);
    this.keyOne = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.ONE);
    this.keyTwo = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.TWO);
    this.keyThree = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.THREE);
    this.keyE = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.E);
    this.keyEsc = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.ESC);
    this.keyInventory = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.I);
    this.keyEquip = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.G);
    this.keyAbilities = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.B);
    this.keyAchievements = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.V);
    this.keyQuartermaster = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.Q);
    this.input.keyboard?.on('keydown-E', this.handleKeyboardE, this);
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.handleWindowKeyDown, true);
    }
    this.inventoryUI = createInventoryUI(this, {
      // Double-click an equippable item to equip it (safe-room gated by
      // equipFromBag). Both panes refresh so the paper-doll and bag stay in
      // sync after the swap.
      onEquipItem: (inventoryEntry) => {
        if (this.playerEid < 0) return;
        const result = equipFromBag(this.world, this.playerEid, inventoryEntry);
        if (result.ok) {
          this.inventoryUI?.refresh(this.world);
          this.equipmentUI?.refresh(this.world);
        }
      },
    });
    this.equipmentUI = createEquipmentUI(this, {
      onSlotFilterChange: (slotId) => this.inventoryUI?.setEquipmentSlotFilter(slotId),
      // Equipping/unequipping from the integrated bag mutates the shared world;
      // refresh a separately-open standalone InventoryUI ([I]) so it stays in sync.
      onInventoryChanged: () => {
        if (this.inventoryUI?.isOpen()) {
          this.inventoryUI.refresh(this.world);
        }
      },
    });
    this.rewardAudioEngine = createAudioCueEngine();
    this.rewardAudioController = createRewardOpeningAudioController(
      this.createRewardAudioCueLoggingEngine(this.rewardAudioEngine),
      () =>
        this.rewardOpeningUI?.getExcitement() ?? {
          tierWeight: 0,
          rarityWeight: 0,
          score: 0,
          bucket: 'modest',
        },
      () => prefersReducedMotion(),
    );
    this.rewardOpeningUI = createRewardOpeningUI(this, {
      onVisibilityChange: (open) => {
        this.clearPendingInteractionInput();
        if (open) {
          this.rewardAudioController?.open();
        } else {
          this.rewardAudioController?.closed();
        }
      },
      onPhaseChange: (phase) => {
        this.rewardAudioController?.phaseChanged(phase);
      },
      onItemRevealed: (index, total, rarityWeight) => {
        this.rewardAudioController?.itemRevealed({ index, total, rarityWeight });
      },
      onSkip: () => {
        this.rewardAudioController?.skipped();
      },
    });
    this.bossIntroUI = createBossIntroUI(this);
    this.achievementsUI = createAchievementsUI(this, this.rewardOpeningUI, {
      onVisibilityChange: () => {
        this.clearPendingInteractionInput();
      },
      onGrantFailed: () => {
        this.flashHint('Reward could not be granted — check your bag has room and try again.');
      },
      onPresentationQueueDrained: () => {
        this.resumePendingRewardPresentations();
      },
    });
    this.shopPanelUI = createShopPanelUI(this, {
      getPlayerEid: () => (this.playerEid >= 0 ? this.playerEid : undefined),
      getTitle: (world) => this.resolveSettlementShopPanelTitle(world),
      getOffers: (world, playerEid) => this.getSettlementShopPanelOffers(world, playerEid),
      purchaseOffer: (world, playerEid, offer) =>
        this.purchaseSettlementShopPanelOffer(world, playerEid, offer),
      onPurchaseResult: (result) => {
        if (result.ok) {
          this.hudUi?.sync(this.world, this.playerEid);
          this.inventoryUI?.refresh(this.world);
        } else {
          this.flashHint(describeShopPurchaseFailure(result.reason));
        }
      },
      onPanelClosed: () => {
        this.activeSettlementShopNpcEid = null;
      },
    });
    this.gameOverUI = createGameOverUI(this, {
      // Both actions reload for now — a title screen / main menu doesn't exist yet.
      // TODO: differentiate onQuit to navigate to a title screen once it's implemented.
      onRestart: () => {
        window.location.reload();
      },
      onQuit: () => {
        // Death/victory/timeout already emitted the terminal bundle before
        // showing this UI. A future active-run quit screen can use this same
        // path to emit the distinct quit outcome.
        this.emitRunBundle('quit');
        window.location.reload();
      },
    });
    this.levelUpUI = createLevelUpUI(this, {
      onConfirm: (allocations) => {
        // Apply the player's allocation (no-op if empty / points banked), then
        // resume the run. statsSystem (preSystems) recomputes next frame.
        if (this.playerEid >= 0) {
          this.options.allocateStatPoints?.(this.world, this.playerEid, allocations);
        }
        this.world.state = 'playing';
      },
    });
    // Fresh-create AND save/load resume both funnel through here:
    // `configureWorld` (called above at spawnPlayer time) is where a carried-over
    // save restores `pendingPresentations`/`revealedGrant` onto the fresh world
    // (see `src/game/playerCarryover.ts`), so by this point any reward that was
    // claimed-but-not-yet-acknowledged in a prior session is already present on
    // `this.world` and ready to auto-surface here exactly once.
    this.resumePendingRewardPresentations();
    this.input.on('pointerdown', this.handlePointerDown, this);
    this.initializeUi();
    // Apply this floor's lighting over a clean DEFAULT base BEFORE the first
    // light-field build in drawFloorTerrain(), so the field is built with the
    // right stepPx, and so a scene restart resets any prior live tweaks. Routing
    // through setLightingConfig() gives clamping + a stepPx-change rebuild.
    this.setLightingConfig({ ...DEFAULT_LIGHTING_CONFIG, ...this.options.lightingConfig });
    markGame('game:terrain-bake-start');
    this.drawFloorTerrain();
    markGame('game:terrain-bake-end');
    this.ensureUiCamera();
    this.events.on(Phaser.Scenes.Events.ADDED_TO_SCENE, this.markCameraMasksDirty, this);
    this.events.on(Phaser.Scenes.Events.REMOVED_FROM_SCENE, this.markCameraMasksDirty, this);
    this.refreshCameraMasks();
    this.openLoadoutModal();
    this.runFovSystemWithPerf(this.world);
    markGame('game:lighting-start');
    this.updateLightingOverlay(true);
    markGame('game:lighting-end');
    this.bridge.sync(this.world);
    this.updateOverlayText();
    if (typeof window !== 'undefined') {
      window.__floor1Debug = {
        getState: () => ({
          worldState: this.world.state,
          runOutcome: this.world.floorScenario?.runSummary?.outcome ?? null,
          floorCompletionMessagePending: this.floorCompletionMessagePending,
          floorCompletionMessageShown: this.floorCompletionMessageShown,
          modalOpen: this.modalPicker?.isOpen() ?? false,
        }),
        forceCompletionModal: () => {
          if (this.world.floorScenario) {
            this.world.floorScenario.runSummary ??= {
              outcome: 'cleared_floor',
              viewsEarned: 0,
              fansEarned: 0,
            };
            this.world.floorScenario.runSummary.outcome = 'cleared_floor';
            this.floorCompletionMessagePending = true;
            this.showFloorCompletionScreenIfNeeded();
          }
        },
        ...((import.meta as { env?: { DEV?: boolean } }).env?.DEV
          ? {
              getWorld: () => this.world,
              getPlayerEid: () => this.playerEid,
              getIntroData: () =>
                this.game.registry.get(INTRO_DATA_REGISTRY_KEY) as
                  | { playerName: string; playerGender: 'female' | 'male' | 'other' }
                  | undefined,
              getDirectorCommentaryText: () => this.directorCommentaryText?.text ?? null,
              // Door-art provenance for the REAL game, not just the probe lab.
              // Without this the only instrument for "which door art actually
              // rendered" lived in main-scene-probe-lab, so a lab-green door
              // e2e could coexist with the game drawing placeholder art and
              // nothing would disagree.
              getDoorRenderSummary: () => this.getDoorRenderSummary(),
              hasTexture: (key: string) => this.textures.exists(key),
            }
          : {}),
        lighting: {
          getConfig: () => ({ ...this.lighting }),
          setConfig: (partial: Partial<LightingConfig>) => this.setLightingConfig(partial),
          usePreset: (preset: LightingPresetId) => this.setLightingPreset(preset),
          getPerf: () => ({
            computeMsAvg: this.lightingComputeMsAvg,
            stepPx: this.lighting.stepPx,
            fieldStepPx: this.lightField?.stepPx ?? 0,
            updateEveryNFrames: this.lighting.updateEveryNFrames,
          }),
        },
        fov: {
          getConfig: () => this.getFovConfig(),
          setConfig: (partial: Partial<FovConfig>) => this.setFovConfig(partial),
          usePreset: (preset: FovPresetId) => this.setFovPreset(preset),
          getPerf: () => this.getFovPerf(),
        },
      };
    }

    markGame('game:create-end');
    if (typeof performance !== 'undefined' && typeof performance.measure === 'function') {
      try {
        const terrain = performance.measure(
          'game:terrain-bake',
          'game:terrain-bake-start',
          'game:terrain-bake-end',
        );
        const lighting = performance.measure(
          'game:lighting',
          'game:lighting-start',
          'game:lighting-end',
        );
        const total = performance.measure('game:create', 'game:create-start', 'game:create-end');
        logger.info('MainGameScene.create() timing', {
          totalMs: Math.round(total.duration),
          terrainBakeMs: Math.round(terrain.duration),
          lightingMs: Math.round(lighting.duration),
        });
      } catch {
        // Marks may be missing in headless / test environments — safe to ignore.
      }
    }
    this.events.once('shutdown', () => {
      logger.info('Main game scene shutdown');
      this.inputCapture?.destroy();
      this.inputCapture = undefined;
      this.modalPicker?.destroy();
      this.modalPicker = undefined;
      this.abilityLoadoutUI?.destroy();
      this.abilityLoadoutUI = undefined;
      this.bridge?.destroy();
      this.bridge = undefined;
      this.mapRt?.destroy();
      this.lightOverlayRt?.destroy();
      this.doorGraphics?.destroy();
      this.barrierOverlay?.destroy();
      this.barrierOverlay = undefined;
      for (const img of this.doorImages) {
        img.destroy();
      }
      this.doorImages.length = 0;
      this.staircaseMarker?.destroy();
      this.staircaseSprite?.destroy();
      this.stairsLabel?.destroy();
      for (const indicator of this.npcQuestIndicators.values()) {
        indicator.destroy();
      }
      this.npcQuestIndicators.clear();
      this.interactionHint?.destroy();
      this.offInteractionHintScale?.();
      this.offInteractionHintScale = undefined;
      this.offInteractionHintSafeArea?.();
      this.offInteractionHintSafeArea = undefined;
      this.offMobileButtonScale?.();
      this.offMobileButtonScale = undefined;
      this.offMobileButtonSafeArea?.();
      this.offMobileButtonSafeArea = undefined;
      this.inventoryButton?.destroy();
      this.inventoryButton = undefined;
      this.equipButton?.destroy();
      this.equipButton = undefined;
      this.quartermasterButton?.destroy();
      this.quartermasterButton = undefined;
      this.dialogueBox?.destroy();
      this.dialogueBox = undefined;
      this.hudUi?.destroy();
      this.hudUi = undefined;
      this.inventoryUI?.destroy();
      this.inventoryUI = undefined;
      this.equipmentUI?.destroy();
      this.equipmentUI = undefined;
      this.achievementsUI?.destroy();
      this.achievementsUI = undefined;
      this.rewardOpeningUI?.destroy();
      this.rewardOpeningUI = undefined;
      this.shopPanelUI?.destroy();
      this.shopPanelUI = undefined;
      this.rewardAudioEngine?.dispose();
      this.rewardAudioEngine = undefined;
      this.achievementsButton?.destroy();
      this.achievementsButton = undefined;
      this.abilitiesButton?.destroy();
      this.abilitiesButton = undefined;
      this.issueButton?.destroy();
      this.issueButton = undefined;
      this.abilitiesModalOpen = false;
      this.achievementToast?.destroy();
      this.achievementToast = undefined;
      this.gameOverUI?.destroy();
      this.gameOverUI = undefined;
      this.runSurveyUI?.destroy();
      this.runSurveyUI = undefined;
      this.levelUpUI?.destroy();
      this.levelUpUI = undefined;
      this.bossIntroUI?.destroy();
      this.bossIntroUI = undefined;
      this.shownBossIntroIds.clear();
      this.bossIntroAutoHoldFrames = 0;
      if (this.uiCamera) {
        this.cameras.remove(this.uiCamera);
        this.uiCamera = undefined;
      }
      this.mapRt = undefined;
      this.lightOverlayRt = undefined;
      this.lightField = undefined;
      this.doorGraphics = undefined;
      this.staircaseMarker = undefined;
      this.staircaseSprite = undefined;
      this.stairsLabel = undefined;
      this.interactionHint = undefined;
      this.directorCommentaryText = undefined;
      this.floorCompletionScreen?.destroy();
      this.floorCompletionScreen = undefined;
      this.floorCompletionTitleText = undefined;
      this.floorCompletionSubtitleText = undefined;
      this.floorCompletionBodyText = undefined;
      this.floorTransitionProgressTrack = undefined;
      this.floorTransitionProgressFill = undefined;
      this.floorTransitionProgressShine = undefined;
      this.floorTransitionProgressLabel = undefined;
      this.loadoutText = undefined;
      this.keyAbilities = undefined;
      this.conversationNpcEid = null;
      this.activeConversationLines = null;
      this.tappedInteraction = false;
      this.queuedInteraction = false;
      this.queuedConversationClose = false;
      this.queuedAbilitiesToggle = false;
      this.lightingLastSource = undefined;
      this.lightingLastViewRect = undefined;
      this.lightingDirty = true;
      this.lightingComputeMsAvg = 0;
      this.lightingOverBudgetFrames = 0;
      this.fovComputeMsAvg = 0;
      this.fovLastComputeMs = 0;
      this.events.off(Phaser.Scenes.Events.ADDED_TO_SCENE, this.markCameraMasksDirty, this);
      this.events.off(Phaser.Scenes.Events.REMOVED_FROM_SCENE, this.markCameraMasksDirty, this);
      this.input.off('pointerdown', this.handlePointerDown, this);
      this.input.keyboard?.off('keydown-E', this.handleKeyboardE, this);
      if (typeof window !== 'undefined') {
        window.removeEventListener('keydown', this.handleWindowKeyDown, true);
      }
      if (typeof window !== 'undefined' && window.__floor1Debug) {
        delete window.__floor1Debug;
      }
      if (typeof window !== 'undefined' && window.__playerSessionRecorder) {
        delete window.__playerSessionRecorder;
      }
      this.sessionRecorder = undefined;
    });
  }

  /**
   * Screen-space bounds of the bottom-centre interaction hint / Talk button,
   * or `null` when it is not showing. Test/automation affordance so e2e probes
   * can assert this canvas-rendered tap target clears the safe-area bands.
   */
  getInteractionHintBounds(): ScreenBounds | null {
    if (!this.interactionHint?.visible) {
      return null;
    }
    const bounds = this.interactionHint.getBounds();
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  }

  /**
   * Baseline Y for the bottom-anchored interaction hint, lifted clear of the
   * home-indicator band on notched devices (zero inset elsewhere).
   */
  private interactionHintY(): number {
    return GAME.HEIGHT - INTERACTION_HINT_BOTTOM_MARGIN - getSafeAreaInsets(this).bottom;
  }

  private isTouchPointer(pointer: Phaser.Input.Pointer): boolean {
    const nativeEvent = pointer.event as { pointerType?: string; type?: string } | undefined;
    return nativeEvent?.pointerType === 'touch' || nativeEvent?.type?.startsWith('touch') === true;
  }

  private handlePointerDown(pointer: Phaser.Input.Pointer): void {
    if (this.abilityLoadoutUI?.isOpen()) {
      return;
    }
    if (this.isTouchPointer(pointer)) {
      return;
    }
    const isCornerButtonHit = (button?: Phaser.GameObjects.Text): boolean =>
      Boolean(
        button &&
        button.visible &&
        button.input?.enabled &&
        button.getBounds().contains(pointer.x, pointer.y),
      );
    if (
      isCornerButtonHit(this.inventoryButton) ||
      isCornerButtonHit(this.equipButton) ||
      isCornerButtonHit(this.achievementsButton) ||
      isCornerButtonHit(this.abilitiesButton) ||
      isCornerButtonHit(this.quartermasterButton) ||
      isCornerButtonHit(this.issueButton)
    ) {
      return;
    }
    this.tappedInteraction = true;
  }

  private handleKeyboardE(): void {
    if (this.isBlockingSurfaceOpen()) {
      return;
    }
    this.queuedInteraction = true;
  }

  private clearPendingInteractionInput(): void {
    this.queuedInteraction = false;
    this.tappedInteraction = false;
    this.inputCapture?.reset();
    this.inputState.moveX = 0;
    this.inputState.moveY = 0;
    this.inputState.action = false;
    for (const key of [
      this.keyE,
      this.keyInventory,
      this.keyEquip,
      this.keyAchievements,
      this.keyAbilities,
      this.keyQuartermaster,
      this.keyEsc,
    ]) {
      if (key) {
        Phaser.Input.Keyboard.JustDown(key);
      }
    }
  }

  private isTextEntryTarget(event: KeyboardEvent): boolean {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return false;
    }
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
  }

  private handleWindowKeyDown = (event: KeyboardEvent): void => {
    if (this.isTextEntryTarget(event)) {
      return;
    }
    if (this.abilityLoadoutUI?.isOpen()) {
      if (event.code === 'KeyB' && !event.repeat) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.queuedAbilitiesToggle = false;
        this.closeAbilitiesModal();
      }
      return;
    }
    if (this.isBlockingSurfaceOpen()) {
      return;
    }
    if (event.code === 'F8' && !event.repeat) {
      event.preventDefault();
      this.openIssueReport();
      return;
    }
    if (event.code === 'KeyE') {
      // Allow browser key-repeat so holding E can advance dialogue lines.
      this.queuedInteraction = true;
      return;
    }
  };

  private markCameraMasksDirty(): void {
    this.cameraMasksDirty = true;
  }

  public requestInventoryToggle(): void {
    this.tappedInteraction = false;
    this.queuedInteraction = false;
    this.queuedInventoryToggle = true;
  }

  public requestEquipAction(): void {
    this.tappedInteraction = false;
    this.queuedInteraction = false;
    this.queuedEquip = true;
  }

  public requestAchievementsToggle(): void {
    this.tappedInteraction = false;
    this.queuedInteraction = false;
    this.queuedAchievementsToggle = true;
  }

  public requestQuartermasterToggle(): void {
    this.tappedInteraction = false;
    this.queuedInteraction = false;
    this.queuedQuartermasterToggle = true;
  }

  private resolveSettlementShopByNpc(
    npcEid: number,
  ): { kind: 'quartermaster' | 'shop'; shop: Floor2ShopInstance } | null {
    const settlement = this.world.floorExtendedState?.settlement;
    if (!settlement) {
      return null;
    }
    if (settlement.quartermasterShop.npcEid === npcEid) {
      return { kind: 'quartermaster', shop: settlement.quartermasterShop };
    }
    const shop = settlement.shops.find((entry) => entry.npcEid === npcEid);
    return shop ? { kind: 'shop', shop } : null;
  }

  private isSettlementShopNpc(npcEid: number): boolean {
    return this.resolveSettlementShopByNpc(npcEid) !== null;
  }

  private tryQueueSettlementShopOpenFromNpc(npcEid: number): boolean {
    if (!this.isSettlementShopNpc(npcEid)) {
      return false;
    }
    this.queuedSettlementShopNpcEid = npcEid;
    return true;
  }

  private resolveActiveSettlementShop(): {
    kind: 'quartermaster' | 'shop';
    shop: Floor2ShopInstance;
  } | null {
    if (this.activeSettlementShopNpcEid !== null) {
      const active = this.resolveSettlementShopByNpc(this.activeSettlementShopNpcEid);
      if (active) {
        return active;
      }
    }
    const settlement = this.world.floorExtendedState?.settlement;
    return settlement ? { kind: 'quartermaster', shop: settlement.quartermasterShop } : null;
  }

  private resolveSettlementShopPanelTitle(_world: GameWorld): string {
    const selection = this.resolveActiveSettlementShop();
    if (!selection) {
      return '🛒 SHOP';
    }
    if (selection.kind === 'quartermaster') {
      return '🛒 QUARTERMASTER';
    }
    const archetypeName = getShopArchetype(selection.shop.archetypeId)?.name ?? 'Shop';
    return `🛒 ${archetypeName.toUpperCase()}`;
  }

  private getSettlementShopPanelOffers(
    world: GameWorld,
    playerEid: number,
  ): readonly ShopPanelOfferView[] {
    const selection = this.resolveActiveSettlementShop();
    if (!selection) {
      return Object.freeze([]);
    }
    if (selection.kind === 'quartermaster') {
      return getQuartermasterOfferViews(world, playerEid);
    }
    return getSettlementShopOfferViews(world, playerEid, selection.shop.npcEid);
  }

  private purchaseSettlementShopPanelOffer(
    world: GameWorld,
    playerEid: number,
    offer: ShopPanelOfferView,
  ): { ok: boolean; reason?: string; goldSpent?: number } {
    const selection = this.resolveActiveSettlementShop();
    if (!selection) {
      return { ok: false, reason: 'unknown-shop' };
    }
    if (selection.kind === 'quartermaster') {
      if (!('stockId' in offer)) {
        return { ok: false, reason: 'invalid-stock-identity' };
      }
      return purchaseQuartermasterOffer(world, playerEid, {
        stockId: offer.stockId,
        offerId: offer.offerId,
        quantity: 1,
      });
    }
    const shopOffer = offer as SettlementShopOfferView;
    return purchaseSettlementShopOffer(world, playerEid, selection.shop.npcEid, {
      itemId: shopOffer.itemId,
      quantity: 1,
    });
  }

  public getSettlementShopOfferSnapshot(): ReadonlyArray<{
    stockId?: string;
    offerId: string;
    quantity: number;
    unitPrice: number;
    displayName: string | null;
  }> {
    if (this.playerEid < 0) {
      return [];
    }
    return this.getSettlementShopPanelOffers(this.world, this.playerEid).map((offer) => ({
      ...('stockId' in offer ? { stockId: offer.stockId } : {}),
      offerId: offer.offerId,
      quantity: offer.quantity,
      unitPrice: offer.unitPrice,
      displayName: offer.displayName,
    }));
  }

  public purchaseFirstSettlementShopOffer(): {
    ok: boolean;
    reason?: string;
    goldSpent?: number;
    itemId?: string;
    instanceId?: GeneratedEquipmentInstanceKey;
  } {
    if (this.playerEid < 0) {
      return { ok: false, reason: 'no-player' };
    }
    const offer = this.getSettlementShopPanelOffers(this.world, this.playerEid).find(
      (entry) => entry.canPurchase,
    );
    if (!offer) {
      return { ok: false, reason: 'none-purchasable' };
    }
    const result = this.purchaseSettlementShopPanelOffer(this.world, this.playerEid, offer);
    this.shopPanelUI?.refresh(this.world);
    if (!result.ok) {
      return result;
    }
    this.hudUi?.sync(this.world, this.playerEid);
    this.inventoryUI?.refresh(this.world);
    if ('stockId' in offer) {
      const itemId = getGeneratedEquipmentInstance(this.world, offer.instanceId)?.baseId;
      return itemId ? { ...result, itemId, instanceId: offer.instanceId } : result;
    }
    return result;
  }

  public getActiveSettlementShopNpcEid(): number | null {
    return this.resolveActiveSettlementShop()?.shop.npcEid ?? null;
  }

  private openSettlementShopPanel(npcEid: number): void {
    this.activeSettlementShopNpcEid = npcEid;
    this.closeMapOverlayIfOpen();
    this.closeCharacterPanels({ keepQuartermaster: true });
    if (this.shopPanelUI?.isOpen()) {
      this.shopPanelUI.refresh(this.world);
    } else {
      this.shopPanelUI?.toggle(this.world);
    }
  }

  private resumePendingRewardPresentations(): void {
    if (this.rewardOpeningUI?.isOpen()) {
      return;
    }
    this.achievementsUI?.resumePendingPresentation(this.world);
    if (this.rewardOpeningUI?.isOpen()) {
      return;
    }
    this.resumePendingBossChestPresentation(this.world);
  }

  /**
   * Resume presenting a boss chest that is in `revealed` state but whose
   * reward animation has not yet been acknowledged (e.g. after a reload).
   * Deterministic order: sorted by chestId so multiple pending chests always
   * surface in the same order.
   */
  private resumePendingBossChestPresentation(world: GameWorld): void {
    if (this.rewardOpeningUI?.isOpen()) return;
    const chests = [...world.bossChests.values()]
      .filter((c) => c.state === 'revealed' && c.revealedGrant)
      .sort((a, b) => a.chestId.localeCompare(b.chestId));
    const chest = chests[0];
    if (!chest || !chest.revealedGrant) return;
    const familyMap = new Map(loadFamilies().map((f) => [f.id, f]));
    const family = familyMap.get(chest.familyId);
    this.rewardOpeningUI?.open({
      world,
      presentation: chest.revealedGrant,
      reducedMotion: prefersReducedMotion(),
      sourceLabel: family ? `Boss Chest: ${family.boss.name}` : 'Boss Chest',
      onAcknowledge: () => {
        acknowledgeBossChestReveal(world, chest.chestId);
        this.resumePendingBossChestPresentation(world);
        if (!this.rewardOpeningUI?.isOpen()) {
          this.resumePendingRewardPresentations();
        }
      },
    });
  }

  /**
   * Wraps the real `AudioCueEngine` so every dispatched `SynthCueSpec` is
   * appended to `rewardAudioCueLog` before being forwarded unchanged for
   * synthesis. Test/automation observability only — playback behavior is
   * untouched.
   */
  private createRewardAudioCueLoggingEngine(engine: AudioCueEngine): AudioCueEngine {
    return {
      isAvailable: () => engine.isAvailable(),
      play: (spec: SynthCueSpec) => {
        this.rewardAudioCueLog.push({
          label: spec.label,
          frequencyHz: spec.frequencyHz,
          durationMs: spec.durationMs,
          gain: spec.gain,
        });
        engine.play(spec);
      },
      stopAll: () => engine.stopAll(),
      dispose: () => engine.dispose(),
    };
  }

  public isInventoryOpen(): boolean {
    return this.inventoryUI?.isOpen() ?? false;
  }

  private closeMapOverlayIfOpen(): void {
    if (this.hudUi?.isMapOverlayOpen()) {
      this.hudUi.closeMapOverlay();
    }
  }

  /**
   * Close the abilities config modal and reset tracking state.
   * Safe to call even if the modal is not open.
   */
  private closeAbilitiesModal(): void {
    if (this.abilityLoadoutUI?.isOpen()) {
      this.abilityLoadoutUI.close();
    } else if (this.abilitiesModalOpen && this.modalPicker?.isOpen()) {
      this.modalPicker.close();
    }
    this.abilitiesModalOpen = false;
    this.updateOverlayText();
  }

  private closeConversation(): void {
    this.conversationNpcEid = null;
    this.activeConversationLines = null;
    this.dialogueBox?.hide();
  }

  private processOpenAbilitiesModal(): void {
    if (!(this.abilitiesModalOpen && (this.modalPicker?.isOpen() ?? false))) {
      return;
    }
    if (this.queuedAbilitiesToggle) {
      this.queuedAbilitiesToggle = false;
      this.closeAbilitiesModal();
      return;
    }
    if (!isInSafeContext(this.world)) {
      this.closeAbilitiesModal();
    }
  }
  private closeCharacterPanels(
    options: {
      keepInventory?: boolean;
      keepEquipment?: boolean;
      keepAchievements?: boolean;
      keepQuartermaster?: boolean;
    } = {},
  ): void {
    const {
      keepInventory = false,
      keepEquipment = false,
      keepAchievements = false,
      keepQuartermaster = false,
    } = options;
    if (!keepAchievements && this.achievementsUI?.isOpen()) {
      this.achievementsUI.toggle(this.world);
    }
    if (!keepQuartermaster && this.shopPanelUI?.isOpen()) {
      this.shopPanelUI.toggle(this.world);
    }
    if (!keepEquipment && this.equipmentUI?.isOpen()) {
      this.equipmentUI.toggle(this.world);
    }
    if (!keepInventory && this.inventoryUI?.isOpen()) {
      this.inventoryUI.toggle(this.world);
    }
  }

  private isBlockingSurfaceOpen(): boolean {
    return (
      this.conversationNpcEid !== null ||
      (this.hudUi?.isMapOverlayOpen() ?? false) ||
      (this.modalPicker?.isOpen() ?? false) ||
      (this.abilityLoadoutUI?.isOpen() ?? false) ||
      (this.levelUpUI?.isOpen() ?? false) ||
      (this.bossIntroUI?.isOpen() ?? false) ||
      (this.inventoryUI?.isOpen() ?? false) ||
      (this.equipmentUI?.isOpen() ?? false) ||
      (this.achievementsUI?.isOpen() ?? false) ||
      (this.shopPanelUI?.isOpen() ?? false) ||
      (this.rewardOpeningUI?.isOpen() ?? false)
    );
  }

  update(_time: number, delta: number): void {
    if (!this.bridge || !this.inputCapture) {
      if (!this.warnedMissingDependencies) {
        logger.warn('Skipping update because bridge or input capture is unavailable');
        this.warnedMissingDependencies = true;
      }
      return;
    } else if (this.warnedMissingDependencies) {
      this.warnedMissingDependencies = false;
    }

    if (this.previousWorldState !== this.world.state) {
      logger.info('World state changed', { from: this.previousWorldState, to: this.world.state });
      this.previousWorldState = this.world.state;
    }
    // Frozen frames (modals, dialogue, pause, level-up) render the world exactly
    // as the last completed step left it; only the fixed-step path below has a
    // partially-elapsed step to interpolate.
    this.renderInterpAlpha = 0;
    this.floorCompletionMessagePending = this.shouldShowFloorCompletionMessage();
    this.showFloorCompletionScreenIfNeeded();
    this.showDeathScreenIfNeeded();
    this.refreshCameraMasks();

    this.processOpenAbilitiesModal();
    if (this.modalPicker?.isOpen()) {
      this.updateOverlayText();
      return;
    }

    if (this.abilityLoadoutUI?.isOpen()) {
      if (this.queuedAbilitiesToggle || !isInSafeContext(this.world)) {
        this.queuedAbilitiesToggle = false;
        this.closeAbilitiesModal();
      }
      this.updateOverlayText();
      return;
    }

    // A boss battle just started: freeze the sim behind The Director's lore
    // sheet so the player reads who they are fighting before taking a hit.
    // Same freeze contract as the level-up/reward branches — rendering and
    // camera stay alive, the fixed step does not run.
    this.showBossIntroIfNeeded();
    if (this.bossIntroUI?.isOpen()) {
      this.driveAutoBossIntro();
      this.bridge.sync(this.world);
      this.updateCamera();
      this.updateOverlayText();
      return;
    }

    // While the reward-opening sequence (achievement box / boss chest reveal)
    // is presenting, freeze the simulation but keep rendering/camera alive and
    // drive its own deltaMs-based tick — this is the one full-screen overlay
    // that can appear outside a safe room (e.g. right after a boss kill), so
    // unlike the achievements/inventory/equipment panels it must own input and
    // pause gameplay exactly like the level-up screen.
    if (this.rewardOpeningUI?.isOpen()) {
      this.rewardOpeningUI.tick(delta);
      this.driveAutoRewardOpening();
      this.bridge.sync(this.world);
      this.updateCamera();
      this.updateOverlayText();
      return;
    }

    // While the level-up allocation screen is open, freeze the simulation (no
    // fixed-step) but keep rendering/camera responsive — mirrors the modal/pause
    // freeze branches below.
    if (this.levelUpUI?.isOpen()) {
      this.driveAutoLevelUp();
      this.bridge.sync(this.world);
      this.updateCamera();
      this.updateOverlayText();
      return;
    }

    if (this.hudUi?.isMapOverlayOpen()) {
      this.updateDoorOverlay();
      this.updateLightingOverlay();
      this.bridge.sync(this.world);
      this.playBossSpawnIntro();
      this.updateCamera();
      this.updateObjectiveMarkers();
      this.updateOverlayText();
      this.updateFeatureUnlocks();
      return;
    }

    // On level-up, open the stat-allocation screen so the player can spend the
    // points they earned. If there are no points to spend (or no allocation
    // callback is wired), just resume the run.
    if (this.world.state === 'level_up') {
      this.showLevelUpScreenIfNeeded();
      if (this.levelUpUI?.isOpen()) {
        this.driveAutoLevelUp();
        this.bridge.sync(this.world);
        this.updateCamera();
        this.updateOverlayText();
        return;
      }
      this.world.state = 'playing';
    }

    // Freeze fixed-step gameplay while an NPC dialogue is active.
    if (this.conversationNpcEid !== null) {
      this.updateDoorOverlay();
      this.updateLightingOverlay();
      this.bridge.sync(this.world);
      this.playBossSpawnIntro();
      this.updateCamera();
      this.updateObjectiveMarkers();
      this.updateOverlayText();
      this.updateInteractions();
      this.updateFeatureUnlocks();
      return;
    }

    if (this.simulationPaused && this.pendingSimulationSteps <= 0) {
      this.updateDoorOverlay();
      this.updateLightingOverlay();
      this.bridge.sync(this.world);
      this.playBossSpawnIntro();
      this.updateCamera();
      this.updateObjectiveMarkers();
      this.updateOverlayText();
      this.updateInteractions();
      this.updateFeatureUnlocks();
      return;
    }

    this.inputCapture.poll(this.inputState);
    if (this.achievementsUI?.isOpen()) {
      this.inputState.moveX = 0;
      this.inputState.moveY = 0;
      this.inputState.action = false;
    }

    if (this.world.state === 'loadout') {
      this.openLoadoutModal();
      if (this.modalPicker?.isOpen()) {
        this.updateOverlayText();
        return;
      }
      this.processLoadoutInput();
      this.updateDoorOverlay();
      this.bridge.sync(this.world);
      this.playBossSpawnIntro();
      this.updateCamera();
      this.updateObjectiveMarkers();
      this.updateOverlayText();
      this.updateFeatureUnlocks();
      return;
    }

    if (this.world.state !== 'playing') {
      this.updateDoorOverlay();
      this.bridge.sync(this.world);
      this.playBossSpawnIntro();
      this.updateCamera();
      this.updateObjectiveMarkers();
      this.updateOverlayText();
      this.updateFeatureUnlocks();
      return;
    }

    // Check if spell selection modal should be shown (before simulation)
    this.openSpellSelectionModal();
    if (this.modalPicker?.isOpen()) {
      this.updateDoorOverlay();
      this.bridge.sync(this.world);
      this.updateCamera();
      this.updateObjectiveMarkers();
      this.updateOverlayText();
      return;
    }

    // Fixed-timestep accumulator: run simulation at GAME.DELTA_MS intervals
    if (this.simulationPaused) {
      this.accumulator = GAME.DELTA_MS;
    } else {
      const scaledDelta = delta * this.simulationSpeed;
      this.accumulator += scaledDelta;
    }
    let steps = 0;
    const maxStepsThisFrame = this.simulationPaused
      ? 1
      : Math.max(MAX_STEPS_PER_FRAME, Math.ceil(MAX_STEPS_PER_FRAME * this.simulationSpeed));

    while (this.accumulator >= GAME.DELTA_MS && steps < maxStepsThisFrame) {
      // The input override (headless-parity AI) is polled once per rendered frame
      // above, but at high simulation speeds this loop runs many sim steps per
      // frame. Replaying a single stale move vector for N steps makes the AI
      // overshoot waypoint-reached radii and vibrate in place. Re-poll the
      // override every sim step (after the first, which used the poll above) so
      // in-browser AI runs share the headless runner's strict 1:1 poll:step
      // cadence. Human input keeps its once-per-frame poll.
      //
      // This re-poll MUST happen BEFORE this iteration's frameCount/elapsedMs
      // increment below, exactly like headless-runner.ts's poll-then-step
      // ordering (poll(); runSimulationStep()) and the once-per-frame poll
      // above (which also runs before this loop's first increment). The
      // telegraphed-shot dodge math in bt-ai-provider.ts reads world.elapsedMs
      // live at poll time and assumes it always observes the value from BEFORE
      // the current step's own increment; polling after the increment here
      // would make the AI see one step less telegraph time remaining than it
      // does in headless, shifting the dodge-horizon boundary by a frame
      // between the two AI-driving contexts (copilot-pull-request-reviewer
      // finding).
      if (this.options.inputCaptureOverride && steps > 0) {
        this.inputCapture.poll(this.inputState);
      }

      this.world.frameCount += 1;
      this.world.elapsedMs += GAME.DELTA_MS;

      // The ordered ECS system pipeline lives in `runSimulationStep` (one
      // src/engine module). Call order + arguments are identical to the former
      // inline body; the paused single-step drain stays at its exact original
      // seam (between preSystems and movementSystem) via the `afterInput` hook.
      runSimulationStep(this.world, this.inputState, {
        preSystems: this.options.preSystems,
        postSystems: this.options.postSystems,
        runFovSystem: (world) => this.runFovSystemWithPerf(world),
        afterInput: () => {
          if (this.simulationPaused && this.pendingSimulationSteps > 0) {
            // Each loop iteration runs exactly one sim step, so consume one
            // pending step here. `steps` is still 0 at this point (it increments
            // at the end of the loop), so decrementing by `steps` would never
            // drain the queue: pendingSimulationSteps would stay > 0 forever, the
            // paused early-return guard above would never re-arm, and the scene
            // would step every frame — making the AI runner lab's Pause/Advance-
            // frame controls do nothing.
            this.pendingSimulationSteps = Math.max(0, this.pendingSimulationSteps - 1);
            this.accumulator = 0;
          }
        },
      });

      this.accumulator -= GAME.DELTA_MS;
      steps += 1;

      // Record telemetry from the human player each sim step when configured.
      if (this.sessionRecorder) {
        const currentEnemyCount = query(this.world.ecs, [Enemy]).length;
        const currentLevel = this.world.playerLevel?.level ?? 0;
        if (currentEnemyCount < this.prevEnemyCount) {
          const killed = this.prevEnemyCount - currentEnemyCount;
          for (let k = 0; k < killed; k += 1) {
            this.sessionRecorder.onKill(this.sessionRecorder.getStats().totalKills + 1);
          }
        }
        if (currentLevel > this.prevPlayerLevel) {
          this.sessionRecorder.onLevelUp(currentLevel);
        }
        this.prevEnemyCount = currentEnemyCount;
        this.prevPlayerLevel = currentLevel;
        this.sessionRecorder.tick(this.inputState);
      }

      if (this.world.state !== 'playing') {
        break;
      }
    }

    // Cap accumulator to prevent spiral of death after long pauses
    if (this.accumulator > GAME.DELTA_MS * maxStepsThisFrame) {
      this.accumulator = 0;
      this.accumulatorClampCount += 1;
      logger.warn('Fixed-step accumulator clamped to avoid spiral of death', {
        frameCount: this.world.frameCount,
        clampCount: this.accumulatorClampCount,
      });
    }

    this.updateDoorOverlay();
    this.updateLightingOverlay();
    // Render between fixed steps: the accumulator holds the fraction of the next
    // step already elapsed in wall-clock time. Feeding it to the bridge (and to
    // the camera below, via the same alpha) removes the judder caused by rAF
    // frames not lining up with the 60Hz sim step — most visible on high-refresh
    // displays, where sprites would otherwise only move on every other frame.
    // This is render-side only: no world state is read or written differently.
    this.renderInterpAlpha = renderInterpolationAlpha(this.accumulator, GAME.DELTA_MS);
    this.bridge.sync(
      this.world,
      this.world.elapsedMs + this.renderInterpAlpha * GAME.DELTA_MS,
      this.renderInterpAlpha,
    );
    this.resumePendingRewardPresentations();
    if (this.rewardOpeningUI?.isOpen()) {
      this.updateCamera();
      this.updateOverlayText();
      return;
    }
    this.barrierOverlay?.update();
    this.playBossSpawnIntro();
    this.updateCamera();
    this.updateObjectiveMarkers();
    this.updateOverlayText();
    this.updateInteractions();
    this.updateFeatureUnlocks();
  }

  /**
   * Inventory ([I]) and equip ([G]) input plus one-time unlock toasts. The
   * inventory panel only opens after the player picks up the merchant's fetch
   * item; equipping is only allowed after a purchase makes the feature unlock.
   */
  private updateFeatureUnlocks(): void {
    const unlocks = this.world.featureUnlocks;
    const safeCtx = isInSafeContext(this.world);
    const mapOverlayOpen = this.hudUi?.isMapOverlayOpen() ?? false;
    const isUiLockOpen = (): boolean =>
      this.conversationNpcEid !== null ||
      (this.modalPicker?.isOpen() ?? false) ||
      (this.abilityLoadoutUI?.isOpen() ?? false) ||
      (this.levelUpUI?.isOpen() ?? false) ||
      (this.bossIntroUI?.isOpen() ?? false) ||
      (this.rewardOpeningUI?.isOpen() ?? false);

    // Per-panel open state — used below to show each panel's own button as a
    // touch dismiss affordance even while that panel is blocking other opens.
    const inventoryOpen = this.inventoryUI?.isOpen() ?? false;
    const equipOpen = this.equipmentUI?.isOpen() ?? false;
    const achievementsOpen = this.achievementsUI?.isOpen() ?? false;
    const quartermasterOpen = this.shopPanelUI?.isOpen() ?? false;
    const abilitiesOpen = this.abilityLoadoutUI?.isOpen() ?? false;

    // A "hard blocker" prevents all touch-button navigation (conversation,
    // level-up, map overlay, or a non-abilities modal).
    const hardBlocker =
      this.conversationNpcEid !== null ||
      (this.hudUi?.isMapOverlayOpen() ?? false) ||
      (this.levelUpUI?.isOpen() ?? false) ||
      (this.bossIntroUI?.isOpen() ?? false) ||
      (this.rewardOpeningUI?.isOpen() ?? false) ||
      (!abilitiesOpen && (this.modalPicker?.isOpen() ?? false));

    // canOpenNew: no panel or modal is blocking, so "open" buttons should show.
    const canOpenNew =
      !hardBlocker &&
      !inventoryOpen &&
      !equipOpen &&
      !achievementsOpen &&
      !quartermasterOpen &&
      !abilitiesOpen;

    // Toggle the on-screen touch buttons in step with the key affordances.
    // Each button shows when its own panel is open (to allow touch dismiss) OR
    // when nothing is blocking (to allow opening a panel).
    this.inventoryButton?.setVisible(unlocks.inventory && safeCtx && (inventoryOpen || canOpenNew));
    this.equipButton?.setVisible(unlocks.equipmentPanel && safeCtx && (equipOpen || canOpenNew));
    this.achievementsButton?.setVisible(
      safeCtx && this.world.achievements.unlockedIds.size > 0 && (achievementsOpen || canOpenNew),
    );
    this.abilitiesButton
      ?.setDepth(abilitiesOpen ? MODAL_DISMISS_BUTTON_DEPTH : MOBILE_CORNER_BUTTON_DEPTH)
      .setVisible(unlocks.spells && safeCtx && (abilitiesOpen || canOpenNew));
    this.quartermasterButton
      ?.setDepth(quartermasterOpen ? MODAL_DISMISS_BUTTON_DEPTH : MOBILE_CORNER_BUTTON_DEPTH)
      .setVisible(quartermasterOpen);

    if (unlocks.inventory && !this.inventoryUnlockNotified) {
      this.inventoryUnlockNotified = true;
      this.flashHint('Inventory unlocked! Press [I] or tap Bag in a safe room to open your pack.');
    }
    if (unlocks.equipmentPanel && !this.equipmentUnlockNotified) {
      this.equipmentUnlockNotified = true;
      this.flashHint('Equipment unlocked! Press [G] or tap Gear in a safe room to equip new gear.');
    }
    if (unlocks.spells && !this.spellsUnlockNotified) {
      this.spellsUnlockNotified = true;
      this.flashHint(
        'Abilities unlocked! Press [B] or tap Skills in a safe room to configure your bar.',
      );
    }

    const inventoryToggleRequested =
      this.queuedInventoryToggle ||
      Boolean(this.keyInventory && Phaser.Input.Keyboard.JustDown(this.keyInventory));
    this.queuedInventoryToggle = false;
    if (mapOverlayOpen) {
      this.closeCharacterPanels();
    }

    if (unlocks.inventory && safeCtx && !isUiLockOpen() && inventoryToggleRequested) {
      this.closeMapOverlayIfOpen();
      this.closeCharacterPanels({ keepInventory: true });
      this.inventoryUI?.toggle(this.world);
    } else if (this.inventoryUI?.isOpen()) {
      if (safeCtx) {
        this.inventoryUI.refresh(this.world);
      } else {
        this.inventoryUI.toggle(this.world);
      }
    }

    const equipRequested =
      this.queuedEquip || Boolean(this.keyEquip && Phaser.Input.Keyboard.JustDown(this.keyEquip));
    this.queuedEquip = false;
    if (unlocks.equipmentPanel && safeCtx && !isUiLockOpen() && equipRequested) {
      this.closeMapOverlayIfOpen();
      this.closeCharacterPanels({ keepEquipment: true });
      // [G] toggles the equipment panel only. The bag is now integrated into the
      // panel itself (paper-doll | stats | equippable-bag), so we no longer
      // auto-open the standalone InventoryUI — [I] still opens the full pack.
      this.equipmentUI?.toggle(this.world);
    } else if (this.equipmentUI?.isOpen()) {
      if (safeCtx) {
        this.equipmentUI.refresh(this.world);
        if (unlocks.inventory) {
          this.inventoryUI?.refresh(this.world);
        }
      } else {
        this.equipmentUI.toggle(this.world);
      }
    }

    const abilitiesToggleRequested =
      this.queuedAbilitiesToggle ||
      Boolean(this.keyAbilities && Phaser.Input.Keyboard.JustDown(this.keyAbilities));
    this.queuedAbilitiesToggle = false;
    // Three branches for abilities:
    //   1. Toggle-close: [B] / Skills button pressed while modal is open → close it.
    //   2. Open: prerequisites met and player requested toggle → open the config modal.
    //   3. Auto-close: player left the saferoom while modal was open → force-close.
    if (abilitiesToggleRequested && abilitiesOpen) {
      this.closeAbilitiesModal();
    } else if (unlocks.spells && safeCtx && !isUiLockOpen() && abilitiesToggleRequested) {
      this.closeMapOverlayIfOpen();
      this.closeCharacterPanels();
      this.openAbilitiesConfigModal();
    } else if (abilitiesOpen && !safeCtx) {
      this.closeAbilitiesModal();
    }

    const achievementsToggleRequested =
      this.queuedAchievementsToggle ||
      Boolean(this.keyAchievements && Phaser.Input.Keyboard.JustDown(this.keyAchievements));
    this.queuedAchievementsToggle = false;
    const achievementsAvailable = safeCtx && this.world.achievements.unlockedIds.size > 0;
    if (achievementsAvailable && !isUiLockOpen() && achievementsToggleRequested) {
      this.closeMapOverlayIfOpen();
      this.closeCharacterPanels({ keepAchievements: true });
      this.achievementsUI?.toggle(this.world);
    } else if (this.achievementsUI?.isOpen()) {
      if (safeCtx) {
        this.achievementsUI.refresh(this.world);
      } else {
        this.achievementsUI.toggle(this.world);
      }
    }

    // Boss chests now appear as physical in-world entities. Surface a one-time
    // proximity hint per chest the moment it becomes available (deduped via
    // `notifiedBossChestIds` so re-running this per-frame check never re-flashes).
    for (const chest of this.world.bossChests.values()) {
      if (chest.state === 'available' && !this.notifiedBossChestIds.has(chest.chestId)) {
        this.notifiedBossChestIds.add(chest.chestId);
        this.flashHint('Boss chest dropped! Walk up to it to open it.');
      }
    }

    const quartermasterToggleRequested = Boolean(
      this.queuedQuartermasterToggle ||
      (this.keyQuartermaster && Phaser.Input.Keyboard.JustDown(this.keyQuartermaster)),
    );
    const settlementShopNpcEidRequested = this.queuedSettlementShopNpcEid;
    this.queuedQuartermasterToggle = false;
    this.queuedSettlementShopNpcEid = null;
    if (quartermasterOpen && quartermasterToggleRequested) {
      this.shopPanelUI?.toggle(this.world);
    } else if (settlementShopNpcEidRequested !== null && safeCtx && !isUiLockOpen()) {
      this.openSettlementShopPanel(settlementShopNpcEidRequested);
    } else if (this.shopPanelUI?.isOpen()) {
      if (safeCtx) {
        this.shopPanelUI.refresh(this.world);
      } else {
        this.shopPanelUI.toggle(this.world);
      }
    }

    this.processAchievementUnlocks();
    // Surface toggles above can change HUD/minimap visibility in the same frame.
    this.updateOverlayText();
  }

  private processAchievementUnlocks(): void {
    const unlockedId = this.world.achievements.pendingUnlockIds.shift();
    if (!unlockedId) {
      return;
    }

    const achievement = getAchievementById(unlockedId);
    if (!achievement) {
      return;
    }

    this.flashAchievementToast(`🏆 New achievement: ${achievement.title}`);
  }

  /** Achievement reveal toast — own slot/timer so it isn't clobbered by hints. */
  private flashAchievementToast(message: string): void {
    if (!this.achievementToast) {
      return;
    }
    this.achievementToast.setText(message).setVisible(true);
    this.time.delayedCall(2800, () => {
      if (this.achievementToast?.text === message) {
        this.achievementToast.setVisible(false);
      }
    });
  }

  /** Briefly show a transient message in the interaction-hint slot. */
  private flashHint(message: string): void {
    if (!this.interactionHint) {
      return;
    }
    this.interactionHint.setText(message).setVisible(true);
    this.time.delayedCall(2500, () => {
      if (this.interactionHint?.text === message) {
        this.interactionHint.setVisible(false);
      }
    });
  }

  private playBossSpawnIntro(): void {
    const objective = this.world.floorScenario?.objective;
    if (!objective) {
      return;
    }

    for (const [bossId, battle] of objective.bossBattles) {
      const bossEid = battle.bossEid;
      if (bossEid !== this.previousBossEids.get(bossId)) {
        this.previousBossEids.set(bossId, bossEid);
        if (bossEid !== null && entityExists(this.world.ecs, bossEid)) {
          this.triggerBossSpawnFx(
            ftToPx(this.world.stores.position.x[bossEid] ?? 0),
            ftToPx(this.world.stores.position.y[bossEid] ?? 0),
          );
        }
      }
    }
  }

  private triggerBossSpawnFx(x: number, y: number): void {
    this.cameras.main.shake(160, 0.008);
    this.cameras.main.flash(140, 255, 230, 160);

    const ring = this.add
      .circle(x, y, 12, 0xffd166, 0.35)
      .setDepth(880)
      .setBlendMode(Phaser.BlendModes.ADD);
    const core = this.add
      .circle(x, y, 4, 0xffffff, 0.95)
      .setDepth(881)
      .setBlendMode(Phaser.BlendModes.ADD);
    const burst = this.add
      .circle(x, y, 20, 0xff6b6b, 0.18)
      .setDepth(879)
      .setBlendMode(Phaser.BlendModes.ADD);

    this.tweens.add({
      targets: [ring, core, burst],
      scale: { from: 0.35, to: 4.5 },
      alpha: { from: 1, to: 0 },
      duration: 720,
      ease: 'Cubic.easeOut',
      onComplete: () => {
        ring.destroy();
        core.destroy();
        burst.destroy();
      },
    });
  }

  /** Set a debug flag at runtime. Safe to call any time after create(). */
  setDebugFlag<K extends keyof GameWorld['debugFlags']>(
    key: K,
    value: GameWorld['debugFlags'][K],
  ): void {
    if (this.world) {
      this.world.debugFlags[key] = value;
    }
  }

  setSimulationPaused(paused: boolean): void {
    this.simulationPaused = paused;
  }

  isSimulationPaused(): boolean {
    return this.simulationPaused;
  }

  /**
   * Observe seam (probe/e2e): tile-provenance counts from the last terrain bake.
   * Terrain bakes into one RenderTexture, so per-tile provenance is invisible to
   * display-list counting — this accessor lets the main-scene-probe-lab prove
   * that approved generated tile textures actually stamp (`generatedCount > 0`).
   */
  getTerrainRenderSummary(): {
    generatedCount: number;
    spriteCount: number;
    colorCount: number;
    packWallCount: number;
    packFloorCount: number;
    packCorridorCount: number;
    packSpecialFloorCount: number;
    packFloorSourceCounts: Record<string, number>;
    packFloorTransformCounts: Partial<Record<TransformId, number>>;
    packFloorComboCounts: Record<string, number>;
    packCorridorSourceCounts: Record<string, number>;
    packCorridorTransformCounts: Partial<Record<TransformId, number>>;
    packCorridorComboCounts: Record<string, number>;
    packWallAccentedCount: number;
    packWallAccentCounts: Record<string, number>;
    packGroundDecalCount: number;
    packLineworkTileCount: number;
    packLineworkPropCount: number;
    packLineworkBuriedCount: number;
    packLineworkBuriedSample: readonly { readonly tx: number; readonly ty: number }[];
    packLineworkRuns: readonly LineworkRunStats[];
    packLineworkHubs: readonly { readonly tx: number; readonly ty: number }[];
  } {
    return this.terrainRenderSummary;
  }

  /**
   * Diagnostic door-render provenance counts from the last `updateDoorOverlay()`
   * pass. Lets the main-scene-probe-lab prove — in a REAL booted scene — that every
   * floor renders doors from the one unified path with correct per-orientation art
   * and no placeholder fallback.
   */
  getDoorRenderSummary(): {
    closedGeneratedCount: number;
    closedKenneyCount: number;
    closedColorCount: number;
    openGeneratedCount: number;
    openKenneyCount: number;
    openColorCount: number;
    crossOrientationCount: number;
    renderableClosedCount: number;
    renderableOpenCount: number;
  } {
    return this.doorRenderSummary;
  }

  setSimulationSpeed(speed: number): void {
    this.simulationSpeed = Math.max(1, speed);
  }

  getSimulationSpeed(): number {
    return this.simulationSpeed;
  }

  advanceSimulationFrames(frames: number = 1): void {
    const safeFrames = Math.max(1, Math.floor(frames));
    this.pendingSimulationSteps += safeFrames;
  }

  private initializeUi(): void {
    // Loadout info overlay — top-center, visible during weapon selection
    this.loadoutText = this.add
      .text(GAME.WIDTH / 2, 56, '', {
        fontFamily: 'monospace',
        fontSize: '16px',
        color: '#dbeafe',
        backgroundColor: '#0b1020dd',
        padding: { x: 14, y: 10 },
        align: 'center',
      })
      .setOrigin(0.5, 0)
      .setDepth(1000)
      .setScrollFactor(0);

    // HUD — health bar, floor timer, minimap
    this.hudUi = createHudUI(this);

    // Screen-space interaction hint / Talk button — bottom-center, big tap target.
    this.interactionHint = this.add
      .text(GAME.WIDTH / 2, this.interactionHintY(), '', {
        fontFamily: 'monospace',
        fontSize: '22px',
        fontStyle: 'bold',
        color: '#fef9c3',
        backgroundColor: '#422006ee',
        padding: { x: 22, y: 14 },
        align: 'center',
      })
      .setOrigin(0.5, 1)
      .setDepth(CORNER_BUTTON_DEPTH)
      .setScrollFactor(0)
      .setInteractive({ useHandCursor: true })
      .setVisible(false);
    this.interactionHint.on('pointerdown', () => {
      this.queuedInteraction = true;
    });
    const applyInteractionHintScale = (scale: number): void => {
      const hintScale = Math.min(scale, INTERACTION_HINT_MAX_SCALE);
      this.interactionHint?.setScale(hintScale).setY(this.interactionHintY());
    };
    applyInteractionHintScale(getUiScale(this));
    this.offInteractionHintScale = onUiScaleChange(this, applyInteractionHintScale);
    this.offInteractionHintSafeArea = onSafeAreaChange(this, () => {
      applyInteractionHintScale(getUiScale(this));
    });

    // Top-left on-screen buttons for inventory ([I]) and equipment ([G]) so the
    // pack and gear are reachable on touch devices with no keyboard.
    const makeCornerButton = (
      y: number,
      label: string,
      onTap: () => void,
    ): Phaser.GameObjects.Text =>
      this.add
        .text(MOBILE_CORNER_BUTTON_MARGIN + getSafeAreaInsets(this).left, y, label, {
          fontFamily: 'monospace',
          fontSize: '20px',
          fontStyle: 'bold',
          color: '#e5e7eb',
          backgroundColor: '#1f2937ee',
          padding: { x: 16, y: 12 },
          align: 'left',
        })
        .setOrigin(0, 0)
        .setDepth(MOBILE_CORNER_BUTTON_DEPTH)
        .setScrollFactor(0)
        .setInteractive({ useHandCursor: true })
        .setVisible(false)
        .on('pointerdown', onTap);
    const cornerButtonTop = (): number => MOBILE_CORNER_BUTTON_MARGIN + getSafeAreaInsets(this).top;
    this.inventoryButton = makeCornerButton(cornerButtonTop(), '🎒 Bag', () => {
      this.queuedInventoryToggle = true;
    });
    this.equipButton = makeCornerButton(cornerButtonTop() + 56, '⚔ Gear', () => {
      this.queuedEquip = true;
    });
    this.achievementsButton = makeCornerButton(cornerButtonTop() + 112, '🏆 Awards', () => {
      this.queuedAchievementsToggle = true;
    });
    this.abilitiesButton = makeCornerButton(cornerButtonTop() + 168, '🔮 Skills', () => {
      this.queuedAbilitiesToggle = true;
    });
    this.quartermasterButton = makeCornerButton(cornerButtonTop() + 224, '✕ Shop', () => {
      this.queuedQuartermasterToggle = true;
    });
    this.issueButton = makeCornerButton(cornerButtonTop() + 280, '⚑ Issue', () => {
      this.openIssueReport();
    });
    const applyMobileButtonScale = (scale: number): void => {
      const buttonScale = Math.min(scale, MOBILE_CORNER_BUTTON_MAX_SCALE);
      this.inventoryButton?.setScale(buttonScale);
      this.equipButton?.setScale(buttonScale);
      this.achievementsButton?.setScale(buttonScale);
      this.abilitiesButton?.setScale(buttonScale);
      this.quartermasterButton?.setScale(buttonScale);
      this.issueButton?.setScale(buttonScale);
      // Re-anchor to the current safe rect (rotation can change the insets).
      const top = cornerButtonTop();
      const left = MOBILE_CORNER_BUTTON_MARGIN + getSafeAreaInsets(this).left;
      for (const button of [
        this.inventoryButton,
        this.equipButton,
        this.achievementsButton,
        this.abilitiesButton,
        this.quartermasterButton,
        this.issueButton,
      ]) {
        button?.setX(left);
      }
      this.inventoryButton?.setY(top);
      // Keep buttons clear of each other when scaled.
      const bagH = (this.inventoryButton?.height ?? 44) * buttonScale + 8;
      this.equipButton?.setY(top + bagH);
      const gearH = (this.equipButton?.height ?? 44) * buttonScale + 8;
      this.achievementsButton?.setY(top + bagH + gearH);
      const awardsH = (this.achievementsButton?.height ?? 44) * buttonScale + 8;
      this.abilitiesButton?.setY(top + bagH + gearH + awardsH);
      const skillsH = (this.abilitiesButton?.height ?? 44) * buttonScale + 8;
      this.quartermasterButton?.setY(top + bagH + gearH + awardsH + skillsH);
      const shopH = (this.quartermasterButton?.height ?? 44) * buttonScale + 8;
      this.issueButton?.setY(top + bagH + gearH + awardsH + skillsH + shopH);
    };
    applyMobileButtonScale(getUiScale(this));
    this.offMobileButtonScale = onUiScaleChange(this, applyMobileButtonScale);
    this.offMobileButtonSafeArea = onSafeAreaChange(this, () => {
      applyMobileButtonScale(getUiScale(this));
    });

    // Screen-space NPC dialogue box — bottom-center, well above the interaction hint
    this.dialogueBox = createDialogueBox(this, {
      onClose: () => {
        this.queuedConversationClose = true;
      },
      onAdvance: () => {
        this.queuedInteraction = true;
      },
    });

    this.directorCommentaryText = this.add
      .text(GAME.WIDTH / 2, 96, '', {
        fontFamily: 'monospace',
        fontSize: '14px',
        color: '#fef3c7',
        backgroundColor: '#451a03dd',
        padding: { x: 12, y: 8 },
        align: 'center',
        wordWrap: { width: GAME.WIDTH - 80 },
      })
      .setOrigin(0.5, 0)
      .setDepth(1100)
      .setScrollFactor(0)
      .setVisible(false);

    this.achievementToast = this.add
      .text(GAME.WIDTH / 2, 150, '', {
        fontFamily: 'monospace',
        fontSize: '16px',
        fontStyle: 'bold',
        color: '#fde68a',
        backgroundColor: '#1f2937ee',
        padding: { x: 14, y: 10 },
        align: 'center',
        wordWrap: { width: GAME.WIDTH - 80 },
      })
      .setOrigin(0.5, 0)
      .setDepth(1100)
      .setScrollFactor(0)
      .setVisible(false);

    const completionBackdrop = this.add
      .rectangle(0, 0, GAME.WIDTH, GAME.HEIGHT, 0x020617, 0.84)
      .setOrigin(0, 0);
    const completionPanel = this.add
      .rectangle(GAME.WIDTH / 2, GAME.HEIGHT / 2, 620, 260, 0x0f172a, 0.98)
      .setStrokeStyle(2, 0x334155, 1);
    this.floorCompletionTitleText = this.add
      .text(GAME.WIDTH / 2, GAME.HEIGHT / 2 - 72, 'Game Over', {
        fontFamily: 'Segoe UI, Arial, sans-serif',
        fontSize: '38px',
        color: '#f8fafc',
      })
      .setOrigin(0.5, 0.5);
    this.floorCompletionSubtitleText = this.add
      .text(GAME.WIDTH / 2, GAME.HEIGHT / 2 - 26, 'Floor 1 complete!', {
        fontFamily: 'Segoe UI, Arial, sans-serif',
        fontSize: '24px',
        color: '#cbd5e1',
      })
      .setOrigin(0.5, 0.5);
    this.floorCompletionBodyText = this.add
      .text(
        GAME.WIDTH / 2,
        GAME.HEIGHT / 2 + 34,
        'Thanks for completing the first floor!\nMore game coming soon...',
        {
          fontFamily: 'Segoe UI, Arial, sans-serif',
          fontSize: '20px',
          color: '#94a3b8',
          align: 'center',
        },
      )
      .setOrigin(0.5, 0.5);

    // Floor-transition progress bar — hidden by default, shown only when the
    // scene is about to restart into the next floor.
    const floorBarX = GAME.WIDTH / 2 - FLOOR_TRANS_BAR_W / 2;
    const floorBarY = GAME.HEIGHT / 2 + 75;
    this.floorTransitionProgressTrack = this.add
      .rectangle(floorBarX, floorBarY, FLOOR_TRANS_BAR_W, FLOOR_TRANS_BAR_H, 0x0a0e18, 1)
      .setStrokeStyle(1, 0x02040a, 1)
      .setOrigin(0, 0)
      .setVisible(false);
    this.floorTransitionProgressFill = this.add
      .rectangle(floorBarX + 1, floorBarY + 1, 0, FLOOR_TRANS_BAR_INNER_H, 0x4ea8ff, 1)
      .setOrigin(0, 0)
      .setVisible(false);
    this.floorTransitionProgressShine = this.add
      .rectangle(
        floorBarX + 1,
        floorBarY + 1,
        0,
        Math.max(1, Math.floor(FLOOR_TRANS_BAR_INNER_H / 3)),
        0xffffff,
        0.18,
      )
      .setOrigin(0, 0)
      .setVisible(false);
    this.floorTransitionProgressLabel = this.add
      .text(GAME.WIDTH / 2, GAME.HEIGHT / 2 + 100, 'Loading next floor...', {
        fontFamily: 'monospace',
        fontSize: '12px',
        color: '#64748b',
      })
      .setOrigin(0.5, 0)
      .setVisible(false);

    this.floorCompletionScreen = this.add
      .container(0, 0, [
        completionBackdrop,
        completionPanel,
        this.floorCompletionTitleText,
        this.floorCompletionSubtitleText,
        this.floorCompletionBodyText,
        this.floorTransitionProgressTrack,
        this.floorTransitionProgressFill,
        this.floorTransitionProgressShine,
        this.floorTransitionProgressLabel,
      ])
      .setDepth(5500)
      .setScrollFactor(0)
      .setVisible(false);
  }

  private processLoadoutInput(): void {
    if (!this.options.selectLoadoutOption) {
      return;
    }
    if (this.keyOne && Phaser.Input.Keyboard.JustDown(this.keyOne)) {
      this.options.selectLoadoutOption(this.world, 0);
    } else if (this.keyTwo && Phaser.Input.Keyboard.JustDown(this.keyTwo)) {
      this.options.selectLoadoutOption(this.world, 1);
    } else if (this.keyThree && Phaser.Input.Keyboard.JustDown(this.keyThree)) {
      this.options.selectLoadoutOption(this.world, 2);
    }
  }

  private drawFloorTerrain(): void {
    this.mapRt?.destroy();
    this.lightOverlayRt?.destroy();
    this.doorGraphics?.destroy();
    this.barrierOverlay?.destroy();
    this.barrierOverlay = undefined;
    for (const img of this.doorImages) {
      img.destroy();
    }
    this.doorImages.length = 0;
    this.mapRt = undefined;
    this.lightOverlayRt = undefined;
    this.lightField = undefined;
    this.doorGraphics = undefined;
    this.lightingLastSource = undefined;
    this.lightingLastSecondarySourcesKey = undefined;
    this.lightingLastViewRect = undefined;
    this.lightingDirty = true;
    this.lightingComputeMsAvg = 0;
    this.lightingOverBudgetFrames = 0;

    const floorMap = this.world.floorMap;
    if (!floorMap) {
      return;
    }

    // C3: a freshly-built FloorMap constructs at the default sub-factor. Re-apply
    // the scene's canonical FOV selection BEFORE the initial FOV compute + light
    // field build below, so a lab-chosen granularity survives floor reseeds.
    if (floorMap.subFactor !== this.fovSubFactor) {
      this.fovSubFactor = floorMap.setSubFactor(this.fovSubFactor);
    }

    const {
      rt,
      generatedCount,
      spriteCount,
      colorCount,
      packWallCount,
      packFloorCount,
      packCorridorCount,
      packSpecialFloorCount,
      packFloorSourceCounts,
      packFloorTransformCounts,
      packFloorComboCounts,
      packCorridorSourceCounts,
      packCorridorTransformCounts,
      packCorridorComboCounts,
      packWallAccentedCount,
      packWallAccentCounts,
      packGroundDecalCount,
      packLineworkTileCount,
      packLineworkPropCount,
      packLineworkBuriedCount,
      packLineworkBuriedSample,
      packLineworkRuns,
      packLineworkHubs,
    } = buildTerrainLayer(this, floorMap, {
      terrainPackId: this.options.terrainPackId,
      terrainPacks: this.options.terrainPacks,
    });
    rt.setDepth(-20);
    this.mapRt = rt;
    this.terrainRenderSummary = {
      generatedCount,
      spriteCount,
      colorCount,
      packWallCount,
      packFloorCount,
      packCorridorCount,
      packSpecialFloorCount,
      packFloorSourceCounts,
      packFloorTransformCounts,
      packFloorComboCounts,
      packCorridorSourceCounts,
      packCorridorTransformCounts,
      packCorridorComboCounts,
      packWallAccentedCount,
      packWallAccentCounts,
      packGroundDecalCount,
      packLineworkTileCount,
      packLineworkPropCount,
      packLineworkBuriedCount,
      packLineworkBuriedSample,
      packLineworkRuns,
      packLineworkHubs,
    };

    if (colorCount > 0) {
      logger.debug('Terrain layer: tiles using color fallback', {
        colorCount,
        hint: 'Add entries to TILE_SPRITES in src/engine/sprites/tile-visuals.ts to replace fallbacks.',
      });
    }

    this.doorGraphics = this.add.graphics().setDepth(-19);
    this.barrierOverlay = createBarrierOverlay(this, floorMap, this.world.barriers);
    this.barrierOverlay.update();
    this.lightOverlayRt = this.add
      .renderTexture(0, 0, ftToPx(floorMap.widthFt), ftToPx(floorMap.heightFt))
      .setOrigin(0, 0)
      .setDepth(LIGHTING_OVERLAY_DEPTH);
    this.rebuildLightField();
    this.updateDoorOverlay();
    this.updateLightingOverlay(true);
    this.cameras.main.setBounds(0, 0, ftToPx(floorMap.widthFt), ftToPx(floorMap.heightFt));
    this.cameras.main.setZoom(CAMERA.BASE_ZOOM * getRenderScale(this));
    this.cameraInSafeRoom = false;
  }

  private setLightingPreset(preset: LightingPresetId): void {
    const floorMap = this.world.floorMap;
    const tileSize = floorMap ? ftToPx(floorMap.config.tileSizeFt) : 32;
    this.setLightingConfig({ stepPx: getLightingPresetStepPx(preset, tileSize) });
  }

  private setLightingConfig(partial: Partial<LightingConfig>): void {
    const floorMap = this.world.floorMap;
    const tileSize = floorMap ? ftToPx(floorMap.config.tileSizeFt) : 32;
    const next: LightingConfig = { ...this.lighting, ...partial };
    next.stepPx = clampLightingStepPx(next.stepPx, tileSize);
    next.ambient = Math.max(0, Math.min(1, next.ambient));
    next.discoveredLight = Math.max(0, Math.min(1, next.discoveredLight));
    next.sourceIntensity = Math.max(0, Math.min(2, next.sourceIntensity));
    next.sourceRadiusPx = Math.max(1, next.sourceRadiusPx);
    next.falloffExponent = Math.max(0.1, next.falloffExponent);
    next.updateEveryNFrames = Math.max(1, Math.round(next.updateEveryNFrames));
    next.targetComputeMs = Math.max(0.25, next.targetComputeMs);
    const stepChanged = next.stepPx !== this.lighting.stepPx;
    this.lighting = next;
    this.lightingDirty = true;
    if (stepChanged) {
      this.rebuildLightField();
    }
  }

  private rebuildLightField(): void {
    const floorMap = this.world.floorMap;
    if (!floorMap) {
      this.lightField = undefined;
      return;
    }
    this.lightField = createLightField(
      ftToPx(floorMap.widthFt),
      ftToPx(floorMap.heightFt),
      this.lighting.stepPx,
    );
    this.lightingDirty = true;
  }

  private updateLightingOverlay(force = false): void {
    const floorMap = this.world.floorMap;
    const rt = this.lightOverlayRt;
    const field = this.lightField;
    if (!floorMap || !rt || !field || this.playerEid < 0) return;

    const viewRect = getLightingViewRect(field, this.cameras.main.worldView);
    const viewRectUnchanged =
      this.lightingLastViewRect !== undefined &&
      areLightingRectsEqual(this.lightingLastViewRect, viewRect);
    const shouldSkip =
      !force &&
      !this.lightingDirty &&
      this.lighting.updateEveryNFrames > 1 &&
      this.world.frameCount % this.lighting.updateEveryNFrames !== 0 &&
      viewRectUnchanged;
    if (shouldSkip) {
      return;
    }

    const px = ftToPx(this.world.stores.position.x[this.playerEid] ?? 0);
    const py = ftToPx(this.world.stores.position.y[this.playerEid] ?? 0);
    const radius = this.lighting.sourceRadiusPx;
    // C1: FOV visibility (radius ~25 tiles) changes across a far wider area than
    // the torch light (`sourceRadiusPx`), so a torch-circle dirty rect would leave
    // stale fog / discovered-dimmed cells outside the torch ring whenever the
    // player moves while the camera is pinned (e.g. at a map edge). Recompute the
    // entire camera-visible window — the only region we draw — which is both
    // correct and cheap (< 0.03ms for a full field on the real floor-1 map).
    const dirtyRect = viewRect;

    const t0 = performance.now();

    // Build light source list: player torch first, then any PropLight entities.
    const lightSources: {
      x: number;
      y: number;
      radiusPx: number;
      intensity: number;
      colorHex?: number;
    }[] = [{ x: px, y: py, radiusPx: radius, intensity: this.lighting.sourceIntensity }];
    const secondarySourceKeyParts: string[] = [];
    for (const propEid of query(this.world.ecs, [Prop, PropLight, Position])) {
      const sourceX = ftToPx(this.world.stores.position.x[propEid] ?? 0);
      const sourceY = ftToPx(this.world.stores.position.y[propEid] ?? 0);
      const sourceRadius = this.world.stores.propLight.radiusPx[propEid] ?? 0;
      const sourceIntensity = this.world.stores.propLight.intensity[propEid] ?? 0;
      const r = this.world.stores.propLight.colorR[propEid] ?? 0;
      const g = this.world.stores.propLight.colorG[propEid] ?? 0;
      const b = this.world.stores.propLight.colorB[propEid] ?? 0;
      const colorHex = (r << 16) | (g << 8) | b;
      lightSources.push({
        x: sourceX,
        y: sourceY,
        radiusPx: sourceRadius,
        intensity: sourceIntensity,
        colorHex,
      });
      secondarySourceKeyParts.push(`p:${sourceX},${sourceY},${sourceRadius},${sourceIntensity}`);
    }
    // Transient/moving light emitters (e.g. an in-flight Magic Missile bolt —
    // issue #3248). Unlike PropLight, `Glowing` is not tied to a static Prop,
    // so any entity can carry it.
    for (const glowEid of query(this.world.ecs, [Glowing, Position])) {
      const sourceX = ftToPx(this.world.stores.position.x[glowEid] ?? 0);
      const sourceY = ftToPx(this.world.stores.position.y[glowEid] ?? 0);
      const sourceRadius = this.world.stores.glowing.radiusPx[glowEid] ?? 0;
      const sourceIntensity = this.world.stores.glowing.intensity[glowEid] ?? 0;
      const r = this.world.stores.glowing.colorR[glowEid] ?? 0;
      const g = this.world.stores.glowing.colorG[glowEid] ?? 0;
      const b = this.world.stores.glowing.colorB[glowEid] ?? 0;
      const colorHex = (r << 16) | (g << 8) | b;
      lightSources.push({
        x: sourceX,
        y: sourceY,
        radiusPx: sourceRadius,
        intensity: sourceIntensity,
        colorHex,
      });
      secondarySourceKeyParts.push(`g:${sourceX},${sourceY},${sourceRadius},${sourceIntensity}`);
    }
    for (const harvestableEid of query(this.world.ecs, [Harvestable, Position])) {
      const defIndex = this.world.stores.harvestable.defIndex[harvestableEid] ?? -1;
      if (defIndex < 0 || defIndex >= HARVESTABLE_DEFS.length) {
        continue;
      }
      const lightEmission = HARVESTABLE_DEFS[defIndex]?.lightEmission;
      if (lightEmission === undefined) {
        continue;
      }
      const sourceX = ftToPx(this.world.stores.position.x[harvestableEid] ?? 0);
      const sourceY = ftToPx(this.world.stores.position.y[harvestableEid] ?? 0);
      const sourceRadius = ftToPx(lightEmission.radiusFt);
      const sourceIntensity = lightEmission.intensity;
      lightSources.push({
        x: sourceX,
        y: sourceY,
        radiusPx: sourceRadius,
        intensity: sourceIntensity,
      });
      secondarySourceKeyParts.push(`h:${sourceX},${sourceY},${sourceRadius},${sourceIntensity}`);
    }
    for (const setPieceProp of this.world.setPieceProps) {
      const sprite = setPieceProp.render.sprite;
      if (sprite.source !== 'catalog') {
        continue;
      }
      const lightEmission = resolveSetPieceLightEmission(sprite.spriteId);
      if (lightEmission === null) {
        continue;
      }
      const sourceX = ftToPx(setPieceProp.x);
      const sourceY = ftToPx(setPieceProp.y);
      const sourceRadius = ftToPx(lightEmission.radiusFt);
      const sourceIntensity = lightEmission.intensity;
      lightSources.push({
        x: sourceX,
        y: sourceY,
        radiusPx: sourceRadius,
        intensity: sourceIntensity,
      });
      secondarySourceKeyParts.push(`s:${sourceX},${sourceY},${sourceRadius},${sourceIntensity}`);
    }

    const secondarySourcesKey = secondarySourceKeyParts.join('|');
    const sourceUnchanged =
      this.lightingLastSource?.x === px &&
      this.lightingLastSource?.y === py &&
      this.lightingLastSecondarySourcesKey === secondarySourcesKey;
    if (!force && !this.lightingDirty && sourceUnchanged && viewRectUnchanged) {
      return;
    }

    computeLightField({
      // The light field is expressed in render pixels; the FloorMap reasons in
      // feet (the single internal spatial unit). Bridge the two here — pixels
      // are an engine-only concept, so the conversion stays at this boundary.
      // Use sub-tile resolution for isVisible/isDiscovered so the fog-of-war
      // boundary follows shadow edges at the configured FOV granularity.
      map: {
        pixelToTile: (mx, my) => floorMap.worldToSubTile(pxToFt(mx), pxToFt(my)),
        isVisible: (hx, hy) => floorMap.isVisibleSubtile(hx, hy),
        isDiscovered: (hx, hy) => floorMap.isDiscoveredSubtile(hx, hy),
        hasLineOfSight: (x0, y0, x1, y1) =>
          floorMap.hasLineOfSight(pxToFt(x0), pxToFt(y0), pxToFt(x1), pxToFt(y1)),
      },
      field,
      sources: lightSources,
      ambient: this.lighting.ambient,
      discoveredLight: this.lighting.discoveredLight,
      falloffExponent: this.lighting.falloffExponent,
      dirtyRect,
    });
    if (this.lighting.softness) {
      blurLightField(field, dirtyRect);
    }

    // rt.clear() wipes the whole texture, so redraw the camera-visible window
    // (plus a small buffer) every update. forEachDarknessRun batches each row
    // into a handful of fills instead of one fill per cell.
    rt.clear();
    const bounds = viewRect;
    const step = field.stepPx;
    forEachDarknessRun(
      field,
      bounds,
      LIGHTING_DARKNESS_LEVELS,
      LIGHTING_MIN_DARKNESS,
      (cellX, cellY, lengthCells, darkness) => {
        rt.fill(0x000000, darkness, cellX * step, cellY * step, lengthCells * step, step);
      },
    );
    rt.render();

    // Acknowledge this frame's recompute BEFORE the auto-quality block may
    // rebuild the field. A step change runs setLightingConfig() ->
    // rebuildLightField(), which reallocates an all-zero field and sets
    // lightingDirty = true to force a full recompute next frame. That signal
    // must survive — clearing it after the rebuild would strand every cell
    // outside the next (player-sized) dirty rect at darkness 1, leaving most of
    // the map black until the next floor load.
    this.lightingLastSource = { x: px, y: py };
    this.lightingLastSecondarySourcesKey = secondarySourcesKey;
    this.lightingLastViewRect = viewRect;
    this.lightingDirty = false;

    const computeMs = performance.now() - t0;
    this.lightingComputeMsAvg = this.lightingComputeMsAvg * 0.9 + computeMs * 0.1;
    if (
      this.lighting.autoAdjustQuality &&
      this.lightingComputeMsAvg > this.lighting.targetComputeMs
    ) {
      this.lightingOverBudgetFrames += 1;
      if (this.lightingOverBudgetFrames >= 20) {
        const nextStep = chooseAutoStepPx(this.lighting.stepPx, ftToPx(floorMap.config.tileSizeFt));
        if (nextStep !== this.lighting.stepPx) {
          this.setLightingConfig({ stepPx: nextStep });
        }
        this.lightingOverBudgetFrames = 0;
      }
    } else {
      this.lightingOverBudgetFrames = 0;
    }
  }

  /** Tile size in render pixels for the active floor (falls back to the canonical 32px). */
  private fovTileSizePx(): number {
    const floorMap = this.world.floorMap;
    return floorMap ? ftToPx(floorMap.config.tileSizeFt) : FOV_TILE_SIZE_PX;
  }

  /**
   * Runs the core `fovSystem` while timing it (engine-only perf telemetry) so the
   * FOV granularity knob is measurable in the lab. Behavior-identical to calling
   * `fovSystem(world)` directly — this only records an EWMA of the compute cost.
   */
  private runFovSystemWithPerf(world: GameWorld): void {
    const t0 = performance.now();
    fovSystem(world);
    const ms = performance.now() - t0;
    this.fovLastComputeMs = ms;
    this.fovComputeMsAvg = this.fovComputeMsAvg * 0.9 + ms * 0.1;
  }

  /** Current FOV configuration (granularity + the discovered-dim light level). */
  private getFovConfig(): FovConfig {
    const subFactor = this.world.floorMap?.subFactor ?? this.fovSubFactor;
    return {
      subFactor,
      cellPx: subFactorToCellPx(subFactor, this.fovTileSizePx()),
      discoveredLight: this.lighting.discoveredLight,
    };
  }

  /** FOV perf snapshot (compute-cost EWMA + active granularity). */
  private getFovPerf(): FovPerfSnapshot {
    const subFactor = this.world.floorMap?.subFactor ?? this.fovSubFactor;
    return {
      computeMsAvg: this.fovComputeMsAvg,
      lastComputeMs: this.fovLastComputeMs,
      subFactor,
      cellPx: subFactorToCellPx(subFactor, this.fovTileSizePx()),
    };
  }

  /**
   * Apply a FOV config change (lab-driven). A `subFactor` (or a `cellPx` that maps
   * to one) re-buckets the fog grid; `discoveredLight` is routed to the lighting
   * config (its single owner). Returns the resolved config (echoing the snapped
   * sub-factor + its exact cellPx).
   */
  private setFovConfig(partial: Partial<FovConfig>): FovConfig {
    if (partial.discoveredLight !== undefined) {
      this.setLightingConfig({ discoveredLight: partial.discoveredLight });
    }
    let targetSubFactor: number | undefined;
    if (partial.subFactor !== undefined) {
      targetSubFactor = partial.subFactor;
    } else if (partial.cellPx !== undefined) {
      targetSubFactor = cellPxToSubFactor(partial.cellPx, this.fovTileSizePx());
    }
    if (targetSubFactor !== undefined) {
      this.applyFovSubFactor(targetSubFactor);
    }
    return this.getFovConfig();
  }

  /** Apply a named FOV granularity preset (32/16/8/4px → factor 1/2/4/8). */
  private setFovPreset(preset: FovPresetId): FovConfig {
    return this.setFovConfig({ subFactor: getFovPresetSubFactor(preset, this.fovTileSizePx()) });
  }

  /**
   * Change the active FOV sub-tile factor: update the scene's canonical selection,
   * re-bucket the FloorMap's fog bitmaps, then recompute FOV + rebuild the light
   * field so the change is visible immediately. Reallocation resets discovered
   * memory (acceptable — this is a lab-only granularity switch).
   */
  private applyFovSubFactor(subFactor: number): void {
    const floorMap = this.world.floorMap;
    if (!floorMap) {
      this.fovSubFactor = normalizeSubFactor(subFactor);
      return;
    }
    this.fovSubFactor = floorMap.setSubFactor(subFactor);
    this.runFovSystemWithPerf(this.world);
    this.rebuildLightField();
    this.lightingDirty = true;
    this.updateLightingOverlay(true);
  }

  private ensureUiCamera(): void {
    if (this.uiCamera) {
      return;
    }
    const renderScale = getRenderScale(this);
    this.uiCamera = this.cameras.add(
      0,
      0,
      GAME.WIDTH * renderScale,
      GAME.HEIGHT * renderScale,
      false,
      'ui',
    );
    this.uiCamera.setScroll(0, 0);
    // Scale the 1280×720 design-space UI up to fill the supersampled framebuffer.
    // Origin (0,0) pivots the zoom at the top-left, so scroll-factor-0 HUD/modal
    // objects map design (x, y) → framebuffer (x × S, y × S) rather than zooming
    // around the centre (which would push the corners off-screen).
    this.uiCamera.setOrigin(0, 0);
    this.uiCamera.setZoom(renderScale);
    this.uiCamera.roundPixels = true;
  }

  private refreshCameraMasks(): void {
    if (!this.cameraMasksDirty) {
      return;
    }
    this.cameraMasksDirty = false;
    const mainCamera = this.cameras.main;
    if (!mainCamera) {
      return;
    }
    this.ensureUiCamera();
    const uiCamera = this.uiCamera;
    if (!uiCamera) {
      return;
    }

    this.uiMaskIgnoreList.length = 0;
    this.worldMaskIgnoreList.length = 0;
    for (const object of this.children.list) {
      const depth = (object as { depth?: number }).depth ?? 0;
      if (depth >= UI_DEPTH_CUTOFF) {
        this.uiMaskIgnoreList.push(object);
      } else {
        this.worldMaskIgnoreList.push(object);
      }
    }
    if (this.uiMaskIgnoreList.length > 0) {
      mainCamera.ignore(this.uiMaskIgnoreList);
    }
    if (this.worldMaskIgnoreList.length > 0) {
      uiCamera.ignore(this.worldMaskIgnoreList);
    }
  }

  private openLoadoutModal(): void {
    if (!this.modalPicker || this.world.state !== 'loadout' || !this.world.floorScenario) {
      return;
    }
    if (this.modalPicker.isOpen() || !this.options.selectLoadoutOption) {
      return;
    }

    const options = this.world.floorScenario.starterChoices.map((id, index) => {
      const weapon = getWeaponDef(id);
      return {
        id,
        label: weapon?.name ?? `Option ${index + 1}`,
        description: weapon ? `Starter weapon: ${weapon.name}` : id,
      };
    });
    const baseBonuses = this.world.floorScenario.baseStatBonuses;
    const baseBonusText = `Base bonuses: HP +${baseBonuses.maxHp}, Move +${baseBonuses.moveSpeed.toFixed(1)}, Pickup +${baseBonuses.pickupRange}`;

    this.modalPicker.open(
      {
        title: 'Choose your opening loadout',
        subtitle: `${this.world.floorScenario.protagonistName} · Floor 1 is paused until you confirm a starter weapon.`,
        body: `${baseBonusText}\nPick the weapon you want to begin with.`,
        options,
        allowCancel: true,
        initialSelectedId: this.world.floorScenario.starterChoices[0],
      },
      {
        onConfirm: ({ option }) => {
          const choiceIndex = this.world.floorScenario?.starterChoices.indexOf(option.id) ?? -1;
          if (choiceIndex >= 0) {
            this.options.selectLoadoutOption?.(this.world, choiceIndex);
          }
          this.updateOverlayText();
        },
        onCancel: () => {
          this.options.selectLoadoutOption?.(this.world, 0);
          this.updateOverlayText();
        },
      },
    );
  }

  private openSpellSelectionModal(): void {
    if (!this.modalPicker || this.world.state !== 'playing') {
      return;
    }
    if (this.modalPicker.isOpen()) {
      return;
    }

    // Check if spell selection should be shown: boss quest completed and spells not yet unlocked
    if (
      this.world.goalFlags.get('floor1-boss-battle-complete') !== true ||
      this.world.featureUnlocks.spells === true
    ) {
      return;
    }

    const options = this.options.getSpellRewardOptions?.(this.world) ?? [];
    if (options.length === 0) {
      return;
    }

    this.modalPicker.open(
      {
        title: 'Learn a Spell',
        subtitle: 'You defeated the Slime Rat boss!',
        body: 'Choose a spellbook to unlock your ability system. Your pick is slotted onto your abilities bar and will auto-trigger by its combat rules.',
        options,
        allowCancel: false,
        initialSelectedId: options[0]?.id,
      },
      {
        onConfirm: ({ option }) => {
          this.options.selectSpellFromBossBattle?.(this.world, this.playerEid, option.id as string);
          this.flashHint('Spell learned! Press [B] to configure your abilities bar.');
          this.updateOverlayText();
        },
        onCancel: () => {
          // No cancellation allowed for spell selection
          this.updateOverlayText();
        },
      },
    );
  }

  private openAbilitiesConfigModal(): void {
    if (!this.abilityLoadoutUI || !isInSafeContext(this.world) || this.abilityLoadoutUI.isOpen()) {
      return;
    }
    const existingState = this.world.abilityStatesByEntity.get(this.playerEid);
    if (!existingState) {
      this.world.abilityStatesByEntity.set(this.playerEid, createEmptyAbilityState());
    }
    const state = this.world.abilityStatesByEntity.get(this.playerEid)!;
    const activeIds = [
      ...new Set([
        ...state.equippedActiveAbilityIds,
        ...state.learnedSpellIds,
        ...(state.ownedActiveAbilityIds ?? []),
      ]),
    ];
    const passiveIds = [...new Set(state.passiveAbilityIds)];
    if (activeIds.length === 0 && passiveIds.length === 0) {
      this.flashHint('No learned spells yet. Defeat the Slime Rat and claim a spellbook first.');
      return;
    }

    const buildEntries = (): AbilityLoadoutEntry[] => {
      const activeEntries = activeIds.map((abilityId) => {
        const presentation = getAbilityPresentation(abilityId);
        const cooldownSeconds = presentation?.cooldownFrames ? presentation.cooldownFrames / 60 : 0;
        return {
          id: abilityId,
          name: presentation?.name ?? abilityId,
          shortLabel: presentation?.shortLabel ?? abilityId.slice(0, 5).toUpperCase(),
          description: presentation?.description ?? 'Configured auto ability.',
          category: presentation?.category ?? 'utility',
          details: `${presentation?.kind === 'spell' ? 'SPELL' : 'AUTO'}  •  ${cooldownSeconds}s CD  •  ${formatAbilityTrigger(abilityId)}`,
          equipped: state.equippedActiveAbilityIds.includes(abilityId),
        };
      });
      const passiveEntries = passiveIds.map((abilityId) => {
        const presentation = getAbilityPresentation(abilityId);
        const active = state.appliedPassiveAbilityIds.has(abilityId);
        const requirement = presentation?.passiveRequirementSummary;
        const requirementText =
          !active && requirement ? ` • Inactive: requires ${requirement}` : '';
        return {
          id: abilityId,
          name: presentation?.name ?? abilityId,
          shortLabel: presentation?.shortLabel ?? abilityId.slice(0, 5).toUpperCase(),
          description: presentation?.description ?? 'Passive skill bonus.',
          category: presentation?.category ?? 'utility',
          details: `PASSIVE • ${active ? 'ACTIVE' : 'INACTIVE'} • ${presentation?.passiveEffectSummary ?? 'Effect bonus'}${requirementText}`,
          equipped: false,
          canToggle: false,
        };
      });
      return [...activeEntries, ...passiveEntries];
    };

    this.abilitiesModalOpen = true;
    this.clearPendingInteractionInput();
    this.abilityLoadoutUI.open({
      entries: buildEntries(),
      slotLimit: ACTIVE_ABILITY_SLOT_LIMIT,
      onToggle: (abilityId) => {
        const presentation = getAbilityPresentation(abilityId);
        const name = presentation?.name ?? abilityId;
        const equippedIndex = state.equippedActiveAbilityIds.indexOf(abilityId);
        if (equippedIndex >= 0) {
          state.equippedActiveAbilityIds.splice(equippedIndex, 1);
          this.updateOverlayText();
          return {
            entries: buildEntries(),
            feedback: `${name} removed from the auto bar.`,
            tone: 'success',
          };
        }
        if (state.equippedActiveAbilityIds.length >= ACTIVE_ABILITY_SLOT_LIMIT) {
          return {
            entries: buildEntries(),
            feedback: `All ${ACTIVE_ABILITY_SLOT_LIMIT} slots are full. Remove an ability first.`,
            tone: 'warning',
          };
        }
        state.equippedActiveAbilityIds.push(abilityId);
        this.updateOverlayText();
        return {
          entries: buildEntries(),
          feedback: `${name} equipped to the auto bar.`,
          tone: 'success',
        };
      },
      onClose: () => {
        this.abilitiesModalOpen = false;
        this.clearPendingInteractionInput();
        this.updateOverlayText();
      },
    });
  }

  private updateDoorOverlay(): void {
    const floorMap = this.world.floorMap;
    const g = this.doorGraphics;
    if (!floorMap || !g) {
      // Nothing to render this pass — zero the observe seam so a prior floor's
      // counts can't mislead the probe into a false "closed door rendered".
      this.doorRenderSummary = {
        closedGeneratedCount: 0,
        closedKenneyCount: 0,
        closedColorCount: 0,
        openGeneratedCount: 0,
        openKenneyCount: 0,
        openColorCount: 0,
        crossOrientationCount: 0,
        renderableClosedCount: 0,
        renderableOpenCount: 0,
      };
      return;
    }

    g.clear();
    for (const img of this.doorImages) {
      img.destroy();
    }
    this.doorImages.length = 0;

    const tileSize = floorMap.config.tileSizeFt * PIXELS_PER_FOOT;
    const doorTargetHeightPx = ftToPx(DOOR_TARGET_HEIGHT_FT);
    const hasSheet = this.textures.exists(DOOR_SHEET_KEY);

    // Derive each door texture's scale ONCE from its ACTUAL loaded opaque box
    // (mirrors terrain-renderer's resolveGeneratedScale). Doors are CONTAIN-fitted
    // into THE DOORWAY BOX — one cell (tileSize) wide × DOOR_TARGET_HEIGHT_FT tall,
    // floor-anchored — with a single uniform scale = min(tileSize / box.width,
    // doorHeightPx / box.height) that never exceeds EITHER axis. Whichever term is
    // smaller binds; the other comes in under its cap. See DOOR_TARGET_HEIGHT_FT.
    //
    // ONE FIT, EVERY SOURCE. No draw branch below computes its own scale. This is
    // the core of the door unification: a per-source scale constant is exactly how
    // door SIZE came to be decided by asset availability rather than design. The
    // retired terrain-pack branch drew at `tileSize / TERRAIN_PACK_CELL_PX`, which
    // is why Floor 1's doors were a square 4 ft × 4 ft against a 5.75 ft player.
    //
    // This clamps WIDTH to one cell. Under a HEIGHT-authoritative rule
    // (`doorHeightPx / box.height` alone) width follows the art's ~1:1.25 aspect and
    // renders ~5.2 ft in a 4 ft cell, overhanging the doorway. The width cap removes
    // that. The cost — face-on N/S art binds on width and renders ~4.9–5.1 ft tall
    // rather than 6.5 ft — was accepted explicitly (a generator ceiling blocks taller
    // art). Side-on E/W art (aspect ~0.47) binds on HEIGHT instead and renders as a
    // correct narrow tall strip.
    //
    // The art contract this relies on: door textures are bottom-aligned, so the
    // opaque box's bottom edge is the floor line (anchorBase origins pin the box
    // bottom to the tile's bottom edge) and any excess height extends NORTH. No
    // rotation is applied — the vertical key is genuinely side-on art. Pinned
    // deterministically by tests/unit/generated-door-art.test.ts.
    //
    // Degrades safely: an entry with no/mismatched bounds falls back to the whole
    // canvas, which still yields a correctly contain-fitted door.
    const rawDoorRegistry = this.game?.registry?.get?.(GENERATED_SPRITE_REGISTRY_KEY) as
      | GeneratedSpriteRegistry
      | undefined;
    const generatedDoorRegistry =
      rawDoorRegistry && typeof rawDoorRegistry.entries === 'function' ? rawDoorRegistry : null;
    const generatedDoorBounds = new Map<string, OpaqueBounds>();
    if (generatedDoorRegistry) {
      for (const entry of generatedDoorRegistry.entries()) {
        if (entry.opaqueBounds !== undefined) {
          generatedDoorBounds.set(entry.textureKey, entry.opaqueBounds);
        }
      }
    }
    const generatedDoorFits = new Map<
      string,
      {
        scale: number;
        originX: number;
        originY: number;
      }
    >();
    // Use the canonical per-state key map directly so the exported contract is
    // exercised in runtime code (not tests-only).
    for (const key of Object.values(GENERATED_DOOR_TEXTURE_KEYS)) {
      if (!this.textures.exists(key)) {
        continue;
      }
      const source = this.textures.get(key).getSourceImage() as {
        width?: number;
        height?: number;
      };
      const canvasWidth = typeof source?.width === 'number' ? source.width : 0;
      const canvasHeight = typeof source?.height === 'number' ? source.height : 0;
      if (canvasWidth <= 0 || canvasHeight <= 0) {
        continue;
      }
      const bounds = generatedDoorBounds.get(key);
      // Shared with tests/unit/generated-door-art.test.ts to prevent the
      // production fit wiring and regression gates from drifting apart.
      const fit = resolveDoorContainFit({
        bounds,
        canvasWidth,
        canvasHeight,
        targetWidth: tileSize,
        targetHeight: doorTargetHeightPx,
      });
      generatedDoorFits.set(key, {
        scale: fit.scale,
        originX: fit.originX,
        originY: fit.originY,
      });
    }
    const availableGeneratedKeys: ReadonlySet<string> = new Set(generatedDoorFits.keys());

    // The Kenney placeholder goes through the SAME fit as generated art rather than
    // a bespoke `tileSize / 16`. Its frame is a 16×16 SQUARE with no opaque-bounds
    // metadata, so contain-fit necessarily binds on width and lands at exactly one
    // cell — numerically identical to the old constant. That equivalence is the
    // point: the constant is gone, so no future change to the doorway box can leave
    // this branch behind.
    const kenneyDoorFit = resolveDoorContainFit({
      bounds: undefined,
      canvasWidth: KENNEY_DOOR_FRAME_PX,
      canvasHeight: KENNEY_DOOR_FRAME_PX,
      targetWidth: tileSize,
      targetHeight: doorTargetHeightPx,
    });

    // Door images are recreated every frame, AFTER refreshCameraMasks() has
    // already rebuilt the camera ignore lists. Without pinning uiCamera.ignore
    // here, the scroll-locked UI camera renders them at raw world coordinates, so
    // doors appear pinned to the screen and "follow" the player. Centralized here
    // so every image branch (pack + generated + both Kenney frames) gets it.
    //
    // Anchored BOTTOM-centre on the tile's bottom edge, not centre-centre on the
    // tile: art taller than one tile then grows UPWARD into the wall above
    // instead of straddling the doorway. For square art (every Kenney frame)
    // bottom-anchoring at the tile's bottom edge is pixel-identical to
    // centre-anchoring at the tile centre.
    const addDoorImage = (
      px: number,
      tileBottomY: number,
      key: string,
      frame: number | undefined,
      scale: number,
      originX = 0.5,
      originY = 1,
    ): void => {
      const img = this.add
        .image(px, tileBottomY, key, frame)
        .setOrigin(originX, originY)
        .setDepth(-19)
        .setScale(scale);
      this.uiCamera?.ignore(img);
      this.doorImages.push(img);
    };

    let closedGeneratedCount = 0;
    let closedKenneyCount = 0;
    let closedColorCount = 0;
    let openGeneratedCount = 0;
    let openKenneyCount = 0;
    let openColorCount = 0;
    // Doors that rendered generated art authored for the OTHER orientation. Counted
    // separately because a plain "all doors are generated" gate cannot see it: every
    // E/W doorway could borrow the face-on N/S leaf and still satisfy such a gate
    // while showing the wrong projection.
    let crossOrientationCount = 0;

    const tm = floorMap.tileMap;
    // A wall is an in-bounds tile that is neither passable nor a door.
    const isWall = (wx: number, wy: number): boolean =>
      tm.inBounds(wx, wy) && !tm.isPassable(wx, wy) && !tm.isDoor(wx, wy);

    for (let y = 0; y < floorMap.height; y += 1) {
      for (let x = 0; x < floorMap.width; x += 1) {
        if (!tm.isDoor(x, y)) {
          continue;
        }
        // Only render a door where it reads as set into a wall: flanked by
        // walls left+right (vertical wall run) or above+below (horizontal run).
        // Doors that ended up surrounded by floor get no sprite — plain floor
        // shows through instead of a door "floating" in the open.
        const horizontalDoorway = isWall(x - 1, y) && isWall(x + 1, y);
        const verticalDoorway = isWall(x, y - 1) && isWall(x, y + 1);
        if (!horizontalDoorway && !verticalDoorway) {
          continue;
        }
        const isOpen = tm.isPassable(x, y);
        const cx = x * tileSize + tileSize / 2;
        const tileBottomY = y * tileSize + tileSize;
        const orientation = resolveDoorOrientationFromFlanks(horizontalDoorway);
        const mode = resolveDoorRenderMode(isOpen, {
          orientation,
          availableGeneratedKeys,
          hasSheet,
        });

        switch (mode.kind) {
          case 'generated': {
            // 'generated' is only chosen for a key present in
            // availableGeneratedKeys, which is built from generatedDoorFits, so
            // the lookup always hits (the ?? branch is unreachable but keeps the
            // type checker happy without a non-null assertion).
            //
            // No rotation: the vertical (E/W) key is genuinely side-on art, and
            // both N/S and E/W art are contain-fitted and bottom-anchored the same
            // way. The old quarter-turn branch existed only because the previous
            // "side" keys were face-on art needing a 90° turn; those keys had no
            // approved art and the branch was provably dead, so it was removed.
            const fit = generatedDoorFits.get(mode.textureKey);
            addDoorImage(
              cx,
              tileBottomY,
              mode.textureKey,
              undefined,
              fit?.scale ?? 1,
              fit?.originX ?? 0.5,
              fit?.originY ?? 1,
            );
            if (mode.orientationMatch === 'cross') {
              crossOrientationCount += 1;
            }
            if (isOpen) {
              openGeneratedCount += 1;
            } else {
              closedGeneratedCount += 1;
            }
            break;
          }
          case 'kenney-closed': {
            addDoorImage(cx, tileBottomY, DOOR_SHEET_KEY, DOOR_CLOSED_FRAME, kenneyDoorFit.scale);
            closedKenneyCount += 1;
            break;
          }
          case 'kenney-open': {
            addDoorImage(cx, tileBottomY, DOOR_SHEET_KEY, DOOR_OPEN_FRAME, kenneyDoorFit.scale);
            openKenneyCount += 1;
            break;
          }
          case 'color': {
            // No art at all (e.g. tests). There is nothing to contain-fit, so this
            // draws the DOORWAY BOX's own footprint: one cell wide × doorTargetHeightPx
            // tall, floor-anchored on the same bottom edge every other branch anchors to.
            const doorH = doorTargetHeightPx;
            const doorY = tileBottomY - doorH;
            g.fillStyle(mode.open ? 0xd2b48c : 0x6b4423, 1);
            g.fillRect(x * tileSize, doorY, tileSize, doorH);
            g.lineStyle(1, mode.open ? 0xf5deb3 : 0x3d2615, 0.9);
            g.strokeRect(x * tileSize + 0.5, doorY + 0.5, tileSize - 1, doorH - 1);
            if (mode.open) {
              openColorCount += 1;
            } else {
              closedColorCount += 1;
            }
            break;
          }
        }
      }
    }

    this.doorRenderSummary = {
      closedGeneratedCount,
      closedKenneyCount,
      closedColorCount,
      openGeneratedCount,
      openKenneyCount,
      openColorCount,
      crossOrientationCount,
      renderableClosedCount: closedGeneratedCount + closedKenneyCount + closedColorCount,
      renderableOpenCount: openGeneratedCount + openKenneyCount + openColorCount,
    };
  }

  private updateCamera(): void {
    if (this.playerEid < 0) {
      return;
    }
    const px = this.world.stores.position.x[this.playerEid];
    const py = this.world.stores.position.y[this.playerEid];
    const playerX = px ?? 0;
    const playerY = py ?? 0;
    if (this.playerRenderSampleEid !== this.playerEid) {
      this.playerRenderSampleEid = this.playerEid;
      this.playerRenderSampleFrame = this.world.frameCount;
      this.playerRenderPrevX = playerX;
      this.playerRenderPrevY = playerY;
      this.playerRenderCurrX = playerX;
      this.playerRenderCurrY = playerY;
    } else if (this.playerRenderSampleFrame !== this.world.frameCount) {
      this.playerRenderPrevX = this.playerRenderCurrX;
      this.playerRenderPrevY = this.playerRenderCurrY;
      this.playerRenderCurrX = playerX;
      this.playerRenderCurrY = playerY;
      this.playerRenderSampleFrame = this.world.frameCount;
    } else if (this.playerRenderCurrX !== playerX || this.playerRenderCurrY !== playerY) {
      this.playerRenderPrevX = playerX;
      this.playerRenderPrevY = playerY;
      this.playerRenderCurrX = playerX;
      this.playerRenderCurrY = playerY;
    }
    // Follow the SAME extrapolated position the bridge renders the player sprite
    // at (`position + acceptedStepDisplacement * interpAlpha`).
    const alpha = this.renderInterpAlpha;
    const stepDx = this.playerRenderCurrX - this.playerRenderPrevX;
    const stepDy = this.playerRenderCurrY - this.playerRenderPrevY;
    this.cameras.main.centerOn(
      px !== undefined
        ? ftToPx(extrapolateRenderPosition(this.playerRenderCurrX, stepDx, alpha))
        : GAME.WIDTH * 0.5,
      py !== undefined
        ? ftToPx(extrapolateRenderPosition(this.playerRenderCurrY, stepDy, alpha))
        : GAME.HEIGHT * 0.5,
    );
    this.updateSafeRoomZoom();
  }

  /**
   * Delight: smoothly zoom the world camera 25% closer when the player enters a
   * safe room, and ease back out when they leave. Only fires on transition so
   * the zoom tween is not restarted every frame.
   */
  private updateSafeRoomZoom(): void {
    const inSafeRoom = this.world.playerInSafeRoom;
    if (inSafeRoom === this.cameraInSafeRoom) {
      return;
    }
    this.cameraInSafeRoom = inSafeRoom;
    this.cameras.main.zoomTo(
      safeRoomCameraZoom(inSafeRoom) * getRenderScale(this),
      CAMERA.SAFE_ROOM_ZOOM_DURATION_MS,
      undefined,
      true,
    );
  }

  /**
   * Stamp the approved "the-stairs" generated art at the marker's footprint,
   * falling back to the plain filled circle when the art isn't loaded.
   *
   * Mirrors `updateDoorOverlay`'s generated-art-first, degrade-gracefully
   * pattern: the fallback circle stays fully wired (fresh checkouts / a
   * pipeline unapproval never break the objective marker), it just yields
   * its fill to the sprite once real art is available, keeping only a thin
   * stroke ring for affordance.
   */
  private renderStaircaseMarker(
    x: number,
    y: number,
    radiusPx: number,
    fillColor: number,
    strokeColor: number,
    visible: boolean,
  ): void {
    if (!this.staircaseMarker) {
      this.staircaseMarker = this.add
        .circle(x, y, radiusPx, fillColor, 0.25)
        .setStrokeStyle(2, strokeColor, 0.95)
        .setDepth(WORLD_VFX_DEPTH.staircaseMarkerRing);
    }
    this.staircaseMarker.setPosition(x, y);
    this.staircaseMarker.setRadius(radiusPx);
    this.staircaseMarker.setStrokeStyle(2, strokeColor, 0.95);
    this.staircaseMarker.setVisible(visible);

    const hasStairsArt = this.textures.exists(STAIRS_TEXTURE_KEY);
    if (!hasStairsArt) {
      this.staircaseMarker.setFillStyle(fillColor, 0.25);
      this.staircaseSprite?.setVisible(false);
      this.staircaseMarkerUsesGeneratedArt = false;
      return;
    }
    const source = this.textures.get(STAIRS_TEXTURE_KEY).getSourceImage() as {
      width?: number;
      height?: number;
    };
    const canvasWidth = typeof source?.width === 'number' ? source.width : 0;
    const canvasHeight = typeof source?.height === 'number' ? source.height : 0;
    if (canvasWidth <= 0 || canvasHeight <= 0) {
      this.staircaseMarker.setFillStyle(fillColor, 0.25);
      this.staircaseSprite?.setVisible(false);
      this.staircaseMarkerUsesGeneratedArt = false;
      return;
    }
    if (this.staircaseBoundsCache === undefined) {
      const rawStairsRegistry = this.game?.registry?.get?.(GENERATED_SPRITE_REGISTRY_KEY) as
        | GeneratedSpriteRegistry
        | undefined;
      const stairsRegistry =
        rawStairsRegistry && typeof rawStairsRegistry.entries === 'function'
          ? rawStairsRegistry
          : null;
      this.staircaseBoundsCache = null;
      if (stairsRegistry) {
        for (const entry of stairsRegistry.entries()) {
          if (entry.textureKey === STAIRS_TEXTURE_KEY) {
            this.staircaseBoundsCache = entry.opaqueBounds ?? null;
            break;
          }
        }
      }
    }
    const bounds = this.staircaseBoundsCache ?? undefined;
    const fit = resolveStairsContainFit({
      bounds,
      canvasWidth,
      canvasHeight,
      markerRadiusPx: radiusPx,
    });
    if (!this.staircaseSprite) {
      this.staircaseSprite = this.add
        .image(x, y, STAIRS_TEXTURE_KEY)
        .setDepth(WORLD_VFX_DEPTH.staircaseMarkerSprite);
    }
    this.staircaseSprite
      .setTexture(STAIRS_TEXTURE_KEY)
      .setOrigin(fit.originX, fit.originY)
      .setScale(fit.scale)
      .setPosition(x, y)
      .setTint(strokeColor)
      .setVisible(visible);
    // Art carries the fill weight now; keep only the outline ring.
    this.staircaseMarker.setFillStyle(fillColor, 0);
    this.staircaseMarkerUsesGeneratedArt = true;
  }

  /**
   * Whether the last `renderStaircaseMarker()` pass stamped the approved
   * generated stairs art (vs. the plain-circle fallback), plus whether the
   * marker is currently visible. Lets the main-scene-probe-lab prove — in a
   * REAL booted scene — that the floor-exit marker renders real stairs art.
   */
  getStaircaseMarkerRenderInfo(): { usesGeneratedArt: boolean; visible: boolean } {
    return {
      usesGeneratedArt: this.staircaseMarkerUsesGeneratedArt,
      visible: this.staircaseSprite?.visible ?? this.staircaseMarker?.visible ?? false,
    };
  }

  private updateObjectiveMarkers(): void {
    // Fully scenario-driven: the contract reports where the floor exit is, how
    // wide its interaction radius is, whether it should be shown, and whether
    // descent is still barred. The renderer owns only pixels and colors.
    const markerState = this.options.scenarioPresentation?.getStairMarkerState?.(this.world);
    if (!markerState) {
      this.staircaseMarker?.setVisible(false);
      this.staircaseSprite?.setVisible(false);
      this.staircaseMarkerUsesGeneratedArt = false;
      this.stairsLabel?.setVisible(false);
      this.updateNpcQuestIndicators();
      return;
    }

    // Marker positions/radii are in feet; scale to pixels for world rendering.
    const staircaseX = ftToPx(markerState.positionFt.x);
    const staircaseY = ftToPx(markerState.positionFt.y);
    const markerRadiusPx = ftToPx(markerState.radiusFt);
    const staircaseFill = markerState.locked ? 0xf59e0b : 0x10b981;
    const staircaseStroke = markerState.locked ? 0xfcd34d : 0x86efac;
    this.renderStaircaseMarker(
      staircaseX,
      staircaseY,
      markerRadiusPx,
      staircaseFill,
      staircaseStroke,
      markerState.visible,
    );
    // World-space staircase label above the marker
    if (!this.stairsLabel) {
      this.stairsLabel = this.add
        .text(staircaseX, staircaseY - markerRadiusPx - 10, markerState.label, {
          fontFamily: 'monospace',
          fontSize: '13px',
          color: '#fef9c3',
          backgroundColor: '#422006cc',
          padding: { x: 8, y: 4 },
          align: 'center',
        })
        .setOrigin(0.5, 1)
        .setDepth(25)
        .setVisible(false);
    }
    this.stairsLabel.setText(markerState.label);
    this.stairsLabel.setPosition(staircaseX, staircaseY - markerRadiusPx - 10);
    this.stairsLabel.setColor(markerState.locked ? '#fcd34d' : '#86efac');
    this.stairsLabel.setVisible(markerState.visible);
    this.updateNpcQuestIndicators();
  }

  private updateNpcQuestIndicators(): void {
    const liveNpcEids = new Set<number>();
    const bobOffset = Math.sin(this.world.elapsedMs / 240) * 3;
    for (const [eid, instance] of this.world.npcs.entries()) {
      const indicatorState = resolveNpcQuestIndicatorState(
        instance.defId,
        this.world,
        this.options,
      );
      const indicator = this.npcQuestIndicators.get(eid);
      if (indicatorState === 'none') {
        indicator?.destroy();
        this.npcQuestIndicators.delete(eid);
        continue;
      }
      liveNpcEids.add(eid);
      const def = getNpcDef(instance.defId);
      // World-space indicator: scale the NPC's feet position to render px.
      const x = ftToPx(this.world.stores.position.x[eid] ?? 0);
      const y = ftToPx(this.world.stores.position.y[eid] ?? 0);
      const target =
        indicator ??
        this.add
          .text(x, y, '!', {
            fontFamily: 'monospace',
            fontSize: '28px',
            fontStyle: 'bold',
            stroke: '#0f172a',
            strokeThickness: 4,
          })
          .setOrigin(0.5, 1)
          .setDepth(45);
      const heightPx = ftToPx(def?.heightFt ?? 3.5);
      target.setColor(indicatorState === 'actionable' ? '#facc15' : '#9ca3af');
      target.setPosition(x, y - heightPx * 0.5 - 4 + bobOffset);
      this.npcQuestIndicators.set(eid, target);
    }
    for (const [eid, indicator] of this.npcQuestIndicators.entries()) {
      if (!liveNpcEids.has(eid)) {
        indicator.destroy();
        this.npcQuestIndicators.delete(eid);
      }
    }
  }

  private updateOverlayText(): void {
    // Hide the whole HUD while a full-screen character panel is open so the
    // docked minimap (top-right, HUD_DEPTH..+8) never punches through the
    // wide equipment/inventory panel. Change-detected so it catches every
    // open/close path (G/I toggles, ESC, click-away).
    const panelOpen =
      this.conversationNpcEid !== null ||
      (this.equipmentUI?.isOpen() ?? false) ||
      (this.inventoryUI?.isOpen() ?? false) ||
      (this.achievementsUI?.isOpen() ?? false) ||
      (this.shopPanelUI?.isOpen() ?? false) ||
      (this.rewardOpeningUI?.isOpen() ?? false) ||
      (this.modalPicker?.isOpen() ?? false) ||
      (this.abilityLoadoutUI?.isOpen() ?? false) ||
      (this.bossIntroUI?.isOpen() ?? false) ||
      (this.levelUpUI?.isOpen() ?? false);
    const abilityLoadoutOpen = this.abilityLoadoutUI?.isOpen() ?? false;
    const quartermasterOpen2 = this.shopPanelUI?.isOpen() ?? false;
    if (panelOpen !== this.hudHiddenForPanel) {
      this.hudHiddenForPanel = panelOpen;
      this.hudUi?.setVisible(!panelOpen);
      if (panelOpen) {
        this.interactionHint?.setVisible(false);
        this.inventoryButton?.setVisible(false);
        this.equipButton?.setVisible(false);
        this.achievementsButton?.setVisible(false);
        this.issueButton?.setVisible(false);
        this.quartermasterButton
          ?.setDepth(quartermasterOpen2 ? MODAL_DISMISS_BUTTON_DEPTH : MOBILE_CORNER_BUTTON_DEPTH)
          .setVisible(quartermasterOpen2);
        this.abilitiesButton
          ?.setDepth(abilityLoadoutOpen ? MODAL_DISMISS_BUTTON_DEPTH : MOBILE_CORNER_BUTTON_DEPTH)
          .setVisible(abilityLoadoutOpen);
      }
    }
    this.quartermasterButton?.setDepth(
      quartermasterOpen2 ? MODAL_DISMISS_BUTTON_DEPTH : MOBILE_CORNER_BUTTON_DEPTH,
    );
    this.abilitiesButton?.setDepth(
      abilityLoadoutOpen ? MODAL_DISMISS_BUTTON_DEPTH : MOBILE_CORNER_BUTTON_DEPTH,
    );
    const issueOpen = this.issueReportPausedState !== undefined;
    // HUD (health bar, floor timer, boss bar, minimap) updates every frame
    this.hudUi?.sync(this.world, this.playerEid);
    this.updateDirectorCommentary();

    if (!this.world.floorScenario) {
      this.loadoutText?.setVisible(false);
      return;
    }

    const canFileIssue = this.canFileIssue(issueOpen);
    this.issueButton?.setVisible(canFileIssue);

    if (this.world.state === 'loadout') {
      const modalOpen = this.modalPicker?.isOpen() ?? false;
      this.loadoutText?.setVisible(!modalOpen);
      if (modalOpen) {
        return;
      }
      const choices = this.world.floorScenario.starterChoices
        .map((id, idx) => `${idx + 1}. ${id}`)
        .join('\n');
      this.loadoutText?.setText(
        [
          `${this.world.floorScenario.protagonistName}`,
          `Base bonuses: HP +${this.world.floorScenario.baseStatBonuses.maxHp}, Move +${this.world.floorScenario.baseStatBonuses.moveSpeed.toFixed(1)}, Pickup +${this.world.floorScenario.baseStatBonuses.pickupRange}`,
          `Choose your starter weapon:`,
          choices,
          `Press 1, 2, or 3`,
        ].join('\n'),
      );
      return;
    }

    this.loadoutText?.setVisible(false);
  }

  private queueDirectorCommentary(text: string): void {
    // Substitute {playerName} with the player's chosen name (all occurrences).
    const resolved = text.replace(/{playerName}/g, () => this.world.playerName);
    this.directorCommentaryText?.setText(`${DIRECTOR_LABEL_TEXT}: ${resolved}`).setVisible(true);
    this.commentaryHideAtMs = this.time.now + DIRECTOR_COMMENTARY_MS;
  }

  private updateDirectorCommentary(): void {
    if (this.commentaryHideAtMs > 0 && this.time.now >= this.commentaryHideAtMs) {
      this.directorCommentaryText?.setVisible(false);
      this.commentaryHideAtMs = 0;
    }

    const director = this.options.scenarioPresentation?.director;
    if (!director) {
      return;
    }
    // Ordered, floor-agnostic evaluation: intro, then the scenario's own
    // milestones in declaration order, then the victory/timeout bookends.
    // One beat per pass so a burst of simultaneous milestones still reads.
    if (this.queueDirectorBeatOnce(COMMENTARY_INTRO_ID, director.intro)) {
      return;
    }
    for (const milestone of director.milestones) {
      if (
        milestone.isReached(this.world) &&
        this.queueDirectorBeatOnce(milestone.id, milestone.copy)
      ) {
        return;
      }
    }
    if (
      director.isVictoryReached(this.world) &&
      this.queueDirectorBeatOnce(COMMENTARY_VICTORY_ID, director.victory)
    ) {
      return;
    }
    if (director.timeout !== undefined && director.isTimeoutReached?.(this.world) === true) {
      this.queueDirectorBeatOnce(COMMENTARY_TIMEOUT_ID, director.timeout);
    }
  }

  /**
   * Shows a Director beat the first time its `id` is seen this run. Returns
   * true when the beat was queued (so the caller stops evaluating this pass)
   * and false when it had already been shown.
   */
  private queueDirectorBeatOnce(id: string, copy: string): boolean {
    if (this.shownCommentaryIds.has(id)) {
      return false;
    }
    this.shownCommentaryIds.add(id);
    this.queueDirectorCommentary(copy);
    return true;
  }

  private showFloorCompletionScreenIfNeeded(): void {
    const scenario = this.options.scenarioPresentation;
    if (!scenario) {
      return;
    }
    // Which screen to show is a pure function of the scenario's own terminal
    // outcome plus whether a transition callback is actually wired: a floor
    // that declares a `nextFloorId` but is booted without the callback (labs)
    // must not promise a transition it cannot perform.
    const hasFloorTransition = typeof this.options.onFloor1Cleared === 'function';
    const completionVariant = selectScenarioCompletionVariant(scenario.getRunOutcome(this.world), {
      nextFloorId: hasFloorTransition ? scenario.nextFloorId : undefined,
      isTerminalRunVictory: scenario.isTerminalRunVictory,
    });
    if (!completionVariant || !this.shouldShowFloorCompletionMessage()) {
      return;
    }

    this.emitRunBundle(completionVariant === 'failed_timeout' ? 'timeout' : 'victory');

    const copy = scenario.getCompletionCopy(completionVariant);
    this.floorCompletionTitleText?.setText(copy.title);
    this.floorCompletionSubtitleText?.setText(copy.subtitle);
    this.floorCompletionBodyText?.setText(copy.body);

    if (completionVariant === 'transition_to_next_floor') {
      this.floorCompletionMessagePending = false;
      this.floorCompletionMessageShown = true;
      this.floorCompletionScreen?.setVisible(true);
      this.startFloorTransitionProgress(() => {
        const nextOptions = this.options.onFloor1Cleared?.(this.world, this.playerEid);
        if (nextOptions) {
          const composedNextOptions =
            this.options.recomposeFloorTransitionOptions?.(nextOptions) ?? nextOptions;
          this.scene.restart({ mainGameSceneOptions: composedNextOptions });
        }
      });
      return;
    }

    if (completionVariant === 'terminal_victory') {
      this.showRunSurveyIfNeeded('victory');
    }
    this.floorCompletionMessagePending = false;
    this.floorCompletionMessageShown = true;
    this.floorCompletionScreen?.setVisible(true);
  }

  private shouldShowFloorCompletionMessage(): boolean {
    return this.hasReachedScenarioRunOutcome() && !this.floorCompletionMessageShown;
  }

  /**
   * True once the active scenario reports a terminal outcome (cleared or
   * timed out). Scenes booted without a scenario contract never reach one.
   */
  private hasReachedScenarioRunOutcome(): boolean {
    const scenario = this.options.scenarioPresentation;
    return scenario ? scenario.getRunOutcome(this.world) !== null : false;
  }

  /**
   * Animate the floor-transition progress bar from 0% to 100% over ~1300 ms,
   * then invoke `onComplete` so the caller can restart the scene.
   * The bar elements are shown immediately; the tween drives the fill width.
   */
  private startFloorTransitionProgress(onComplete: () => void): void {
    const track = this.floorTransitionProgressTrack;
    const fill = this.floorTransitionProgressFill;
    const shine = this.floorTransitionProgressShine;
    const label = this.floorTransitionProgressLabel;

    if (track) track.setVisible(true);
    if (fill) fill.setVisible(true);
    if (shine) shine.setVisible(true);
    if (label) label.setVisible(true);

    if (!fill || !shine) {
      // Fallback: no bar elements available — just delay then continue.
      this.time.delayedCall(1400, onComplete);
      return;
    }

    const progress = { value: 0 };
    this.tweens.add({
      targets: progress,
      value: 1,
      duration: 1300,
      ease: 'Linear',
      onUpdate: () => {
        const w = Math.max(1, Math.round(progress.value * FLOOR_TRANS_BAR_INNER_W));
        fill.setSize(w, FLOOR_TRANS_BAR_INNER_H);
        shine.setSize(w, Math.max(1, Math.floor(FLOOR_TRANS_BAR_INNER_H / 3)));
      },
      onComplete: () => {
        // Brief pause at 100% before the scene restarts.
        this.time.delayedCall(150, onComplete);
      },
    });
  }

  /**
   * Shows the death screen when the player was slain (world.state === 'game_over'
   * and no floor-completion screen is handling the transition).
   *
   * Floor completion outcomes (cleared_floor, failed_timeout) take precedence:
   * those cases are already handled by showFloorCompletionScreenIfNeeded() and
   * should not additionally trigger the death screen.
   */
  private canFileIssue(issueOpen = this.issueReportPausedState !== undefined): boolean {
    return (
      !issueOpen &&
      !this.issueReportSubmitting &&
      this.world.state !== 'loadout' &&
      this.world.state !== 'game_over' &&
      !this.isBlockingSurfaceOpen()
    );
  }

  private nextIssueReportRunId(): string {
    const randomUuid = globalThis.crypto?.randomUUID?.();
    if (randomUuid) {
      return randomUuid;
    }
    this.issueReportAttemptCounter += 1;
    return `issue-${this.world.seed}-${this.world.frameCount}-${this.issueReportAttemptCounter}`;
  }

  private showDeathScreenIfNeeded(): void {
    if (
      this.world.state !== 'game_over' ||
      this.deathScreenShown ||
      this.hasReachedScenarioRunOutcome()
    ) {
      return;
    }
    this.deathScreenShown = true;
    this.emitRunBundle('death');
    this.showRunSurveyIfNeeded('death');
    this.gameOverUI?.show();
  }

  private showRunSurveyIfNeeded(endReason: 'death' | 'victory'): void {
    if (this.runSurveyShown || this.runSurveySubmitted || !this.lastRunBundle) {
      return;
    }
    if (endReason !== 'death' && endReason !== 'victory') {
      return;
    }
    this.runSurveyShown = true;
    this.runSurveyUI = createRunSurveyUI({
      onSubmit: async (survey) => {
        const validSurvey = validatePlaytestSurvey(survey);
        if (!validSurvey || !this.lastRunBundle) {
          return false;
        }
        const bundle = this.lastRunBundle;
        await this.lastRunBundleUpload?.catch((error: unknown) => {
          if (typeof console !== 'undefined') {
            console.warn('Run completion upload failed before survey append', error);
          }
        });
        const result = await submitRunSurvey(bundle, validSurvey).catch((error: unknown) => {
          if (typeof console !== 'undefined') {
            console.warn('Run survey submission failed', error);
          }
          return { ok: false, used: 'fetch' as const, reason: 'run survey submission failed' };
        });
        if (result.ok) {
          this.runSurveySubmitted = true;
        }
        return result.ok;
      },
      onSkip: () => {
        this.runSurveySubmitted = true;
      },
    });
    this.runSurveyUI.show();
  }

  private nextRunBundleId(): string {
    const randomUuid = globalThis.crypto?.randomUUID?.();
    if (randomUuid) {
      return randomUuid;
    }
    return `run-${this.world.seed}-${this.world.frameCount}`;
  }

  private emitRunBundle(endReason: RunEndReason): void {
    if (this.runBundleEmitted || !this.options.runStatsFactory) {
      return;
    }
    const outcome =
      endReason === 'victory'
        ? 'victory'
        : endReason === 'death'
          ? 'death'
          : endReason === 'timeout'
            ? 'timeout'
            : 'quit';
    const bundle = createRunBundle({
      runStats: this.options.runStatsFactory(
        this.world,
        this.playerEid,
        outcome,
        this.runStartXp,
        this.sessionRecorder?.getStats(),
      ),
      recorderJsonl: this.sessionRecorder?.toJsonl?.() ?? '',
      logs: readLogsSince(this.runLogCursor),
      meta: {
        endReason,
        floorId: this.options.floorId,
        seed: this.world.seed,
        runId: this.nextRunBundleId(),
      },
    });
    this.runBundleEmitted = true;
    this.lastRunBundle = bundle;
    this.lastRunBundleUpload = Promise.resolve(this.options.onRunBundle?.(bundle));
  }

  private createIssueRunBundle(): RunBundle | null {
    if (!this.options.runStatsFactory) {
      return null;
    }
    const runId = this.issueReportRunId ?? this.nextIssueReportRunId();
    this.issueReportRunId = runId;
    return createRunBundle({
      runStats: this.options.runStatsFactory(
        this.world,
        this.playerEid,
        'quit',
        this.runStartXp,
        this.sessionRecorder?.getStats(),
      ),
      recorderJsonl: this.sessionRecorder?.toJsonl?.() ?? '',
      logs: readLogsSince(this.runLogCursor),
      meta: {
        endReason: 'quit',
        floorId: this.options.floorId,
        seed: this.world.seed,
        runId,
      },
    });
  }

  private openIssueReport(): void {
    if (
      !this.modalPicker ||
      this.issueReportPausedState !== undefined ||
      this.issueReportSubmitting ||
      !this.canFileIssue()
    ) {
      return;
    }
    if (!this.issueReportRetryPayload) {
      this.issueReportRunId = undefined;
    }
    const bundle = this.createIssueRunBundle();
    if (!bundle) {
      this.flashHint('Issue reporting is unavailable in this build.');
      return;
    }
    this.issueReportPausedState = this.isSimulationPaused();
    this.setSimulationPaused(true);
    if (this.issueReportRetryPayload) {
      this.issueReportDescription = this.issueReportRetryPayload.issue_description;
      this.issueReportIncludeLogs = this.issueReportRetryPayload.logs.length > 0;
      this.issueReportIncludeScreenshot = !!this.issueReportRetryPayload.screenshot?.base64;
      this.issueReportScreenshot = this.issueReportRetryPayload.screenshot?.base64;
      this.issueReportScreenshotError = undefined;
      this.issueReportRunId = this.issueReportRetryPayload.meta.runId;
    } else {
      this.issueReportDescription = '';
      this.issueReportIncludeLogs = true;
      this.issueReportIncludeScreenshot = false;
      this.issueReportScreenshot = undefined;
      this.issueReportScreenshotError = undefined;
      this.issueReportRunId = bundle.meta.runId;
    }
    void this.prepareIssueReport(bundle);
  }

  private async prepareIssueReport(bundle: RunBundle): Promise<void> {
    await this.captureIssueScreenshot();
    if (this.issueReportPausedState !== undefined) {
      this.showIssueReportPicker(bundle);
    }
  }

  private showIssueReportPicker(bundle: RunBundle, feedback?: string): void {
    if (!this.modalPicker) {
      this.finishIssueReport();
      return;
    }
    const description = this.issueReportDescription
      ? `Description: ${this.issueReportDescription.slice(0, 120)}`
      : 'Description: required';
    const screenshot = this.issueReportScreenshotError
      ? `Screenshot unavailable: ${this.issueReportScreenshotError}`
      : this.issueReportIncludeScreenshot
        ? this.issueReportScreenshot
          ? 'Attach screenshot: on'
          : 'Attach screenshot: waiting'
        : 'Attach screenshot: off';
    this.modalPicker.open(
      {
        title: 'File an issue',
        subtitle: feedback ?? 'F8 opens this flow. Simulation is paused while it is open.',
        body: description,
        options: [
          {
            id: 'description',
            label: 'Describe issue',
            description: this.issueReportDescription
              ? 'Edit the report description.'
              : 'Required before submit.',
          },
          {
            id: 'logs',
            label: this.issueReportIncludeLogs ? 'Attach logs: on' : 'Attach logs: off',
            description: 'Attach the current bounded run log buffer.',
          },
          {
            id: 'screenshot',
            label: screenshot,
            description: 'Capture the current Phaser game renderer as PNG.',
            disabled: this.issueReportIncludeScreenshot && !this.issueReportScreenshot,
          },
          {
            id: 'submit',
            label: this.issueReportSubmitting ? 'Submitting issue…' : 'Submit issue',
            description: 'Uploads this run bundle and creates a GitHub issue.',
            disabled: !this.issueReportDescription.trim() || this.issueReportSubmitting,
          },
        ],
        allowCancel: true,
      },
      {
        onCancel: () => this.finishIssueReport(),
        onConfirm: ({ option }) => {
          switch (option.id) {
            case 'description': {
              const description = window.prompt(
                'Describe what happened:',
                this.issueReportDescription,
              );
              if (description !== null) {
                this.issueReportDescription = description.slice(0, 4_000);
                this.issueReportRetryPayload = undefined;
              }
              this.reopenIssueReportPicker(bundle);
              break;
            }
            case 'logs':
              this.issueReportIncludeLogs = !this.issueReportIncludeLogs;
              this.issueReportRetryPayload = undefined;
              this.reopenIssueReportPicker(bundle);
              break;
            case 'screenshot':
              this.issueReportIncludeScreenshot = !this.issueReportIncludeScreenshot;
              this.issueReportRetryPayload = undefined;
              this.reopenIssueReportPicker(bundle);
              break;
            case 'submit':
              void this.submitIssueReport(bundle);
              break;
          }
        },
      },
    );
  }

  private reopenIssueReportPicker(bundle: RunBundle): void {
    this.time.delayedCall(0, () => this.showIssueReportPicker(bundle));
  }

  private async captureIssueScreenshot(): Promise<void> {
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        if (!this.game.renderer) {
          reject(new Error('Renderer is unavailable.'));
          return;
        }
        this.game.renderer.snapshot((snapshot) => {
          if (snapshot instanceof HTMLImageElement) {
            resolve(snapshot);
            return;
          }
          reject(new Error('Renderer screenshot did not produce an image.'));
        });
      });
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth || image.width;
      canvas.height = image.naturalHeight || image.height;
      const context = canvas.getContext('2d');
      if (!context || canvas.width <= 0 || canvas.height <= 0) {
        throw new Error('Renderer screenshot was empty.');
      }
      context.drawImage(image, 0, 0);
      this.issueReportScreenshot = serializeIssueScreenshot(canvas);
    } catch (error) {
      this.issueReportScreenshot = undefined;
      this.issueReportScreenshotError =
        error instanceof Error ? error.message : 'Screenshot capture failed.';
      logger.warn('Issue screenshot capture failed', error);
    }
  }

  private async submitIssueReport(bundle: RunBundle): Promise<void> {
    if (this.issueReportSubmitting) {
      return;
    }
    this.issueReportSubmitting = true;
    this.finishIssueReport();
    try {
      const payload =
        this.issueReportRetryPayload ??
        buildFileIssuePayload(bundle, this.issueReportDescription, {
          includeLogs: this.issueReportIncludeLogs,
          ...(this.issueReportIncludeScreenshot && this.issueReportScreenshot
            ? { screenshotBase64: this.issueReportScreenshot }
            : {}),
        });
      this.issueReportRetryPayload = payload;
      const response = await submitFileIssue(payload);
      this.flashHint(
        response.issueUrl
          ? `Issue created: ${response.issueUrl}`
          : `Run ${response.runId} uploaded. Issue creation is pending.`,
      );
      this.issueReportRetryPayload = undefined;
      this.issueReportRunId = undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Issue submission failed.';
      this.flashHint(`Could not submit issue: ${message}`);
    } finally {
      this.issueReportSubmitting = false;
    }
  }

  private finishIssueReport(): void {
    const wasPaused = this.issueReportPausedState;
    this.issueReportPausedState = undefined;
    if (!this.issueReportSubmitting && !this.issueReportRetryPayload) {
      this.issueReportRunId = undefined;
    }
    if (wasPaused !== undefined) {
      this.setSimulationPaused(wasPaused);
    }
  }

  /**
   * Open the boss-intro lore sheet when a boss encounter has just started and
   * has not been introduced yet. No-ops while any other blocking surface owns
   * the screen (conversation, level-up, reward reveal, ...), while the run is
   * over, or once this boss has already been introduced — the intro plays
   * exactly once per boss per run.
   */
  private showBossIntroIfNeeded(): void {
    const bossIntroUI = this.bossIntroUI;
    if (!bossIntroUI || bossIntroUI.isOpen() || this.isBlockingSurfaceOpen()) {
      return;
    }
    if (this.world.state === 'game_over' || (this.gameOverUI?.isVisible() ?? false)) {
      return;
    }
    const pending = resolvePendingBossIntro(this.world, this.shownBossIntroIds);
    if (!pending) {
      return;
    }
    // Latch BEFORE opening so a mid-sheet teardown (floor restart, death)
    // cannot re-trigger the same intro on the next frame.
    this.shownBossIntroIds.add(pending.content.introId);
    this.bossIntroAutoHoldFrames = 0;
    this.clearPendingInteractionInput();
    bossIntroUI.open({
      content: pending.content,
      ...(pending.appearanceKey === undefined ? {} : { appearanceKey: pending.appearanceKey }),
      reducedMotion: prefersReducedMotion(),
      onDismiss: () => {
        this.bossIntroAutoHoldFrames = 0;
        this.clearPendingInteractionInput();
      },
    });
  }

  /**
   * AI boss-intro driver. When the run is AI-driven (see
   * {@link MainGameSceneOptions.isAutoDriven}) there is no human to press a
   * key, so hold the sheet for {@link BOSS_INTRO_AUTO_HOLD_FRAMES} render
   * frames — enough for a viewer to read it — then dismiss it and resume the
   * run. No-op for human play (including the AI Runner Lab's manual-control
   * mode), where the sheet waits for input.
   */
  private driveAutoBossIntro(): void {
    const autoDriven =
      this.options.isAutoDriven?.() ?? this.options.autoLevelUpAllocator !== undefined;
    if (!autoDriven || !this.bossIntroUI?.isOpen()) {
      this.bossIntroAutoHoldFrames = 0;
      return;
    }
    this.bossIntroAutoHoldFrames += 1;
    if (this.bossIntroAutoHoldFrames < BOSS_INTRO_AUTO_HOLD_FRAMES) {
      return;
    }
    this.bossIntroUI.dismiss();
  }

  /**
   * AI level-up driver. When an `autoLevelUpAllocator` is wired (AI Runner Lab),
   * hold the open modal for {@link LEVEL_UP_AUTO_HOLD_FRAMES} render frames so a
   * viewer can see it, then auto-confirm via `LevelUpUI.autoResolve` with the
   * allocator's chosen points. This makes the AI go through the real level-up UX
   * (modal render + confirm + `allocateStatPoints`) rather than bypassing it.
   * No-op for human play (allocator omitted).
   */
  private driveAutoLevelUp(): void {
    const allocator = this.options.autoLevelUpAllocator;
    if (!allocator || !this.levelUpUI?.isOpen() || this.playerEid < 0) {
      this.levelUpAutoHoldFrames = 0;
      return;
    }
    const available = this.world.playerLevel.unspentPoints;
    const allocations = allocator(this.world, this.playerEid, available);
    if (allocations === null) {
      // Allocator opted out (e.g. manual control is active) — keep the modal
      // open and reset the hold timer so the human can allocate freely.
      this.levelUpAutoHoldFrames = 0;
      return;
    }
    this.levelUpAutoHoldFrames += 1;
    if (this.levelUpAutoHoldFrames < LEVEL_UP_AUTO_HOLD_FRAMES) {
      return;
    }
    this.levelUpUI.autoResolve(allocations);
    this.levelUpAutoHoldFrames = 0;
  }

  /**
   * AI reward-opening driver. `RewardOpeningUI.tick()` already auto-advances
   * `anticipation` -> `revealing` -> `summary` on its own, but `summary` only
   * ever exits via an explicit `acknowledge()`/`skip()`+`acknowledge()` input
   * (a click, Enter, Space, or Escape) — there is no human to press one when
   * the run is AI-driven (see {@link MainGameSceneOptions.isAutoDriven}), so
   * the reveal would otherwise sit at `summary` forever, freezing the sim
   * (mirrors `driveAutoBossIntro`'s freeze-the-simulation-while-open
   * contract). Hold the summary for {@link REWARD_OPENING_AUTO_HOLD_FRAMES}
   * render frames so a viewer/recording can still read the reveal, then
   * acknowledge it and resume the run. No-op for human play (including the
   * AI Runner Lab's manual-control mode), where the overlay waits for input.
   */
  private driveAutoRewardOpening(): void {
    const autoDriven =
      this.options.isAutoDriven?.() ?? this.options.autoLevelUpAllocator !== undefined;
    if (
      !autoDriven ||
      !this.rewardOpeningUI?.isOpen() ||
      this.rewardOpeningUI.getPhase() !== 'summary'
    ) {
      this.rewardOpeningAutoHoldFrames = 0;
      return;
    }
    this.rewardOpeningAutoHoldFrames += 1;
    if (this.rewardOpeningAutoHoldFrames < REWARD_OPENING_AUTO_HOLD_FRAMES) {
      return;
    }
    this.rewardOpeningUI.acknowledge();
    this.rewardOpeningAutoHoldFrames = 0;
  }

  /**
   * Opens the level-up stat-allocation screen when the player has unspent points
   * and an allocation callback is wired. No-ops if the screen is already open,
   * there are no points to spend, or the player entity is unknown — in those
   * cases the caller resumes the run.
   */
  private showLevelUpScreenIfNeeded(): void {
    if (!this.levelUpUI || this.levelUpUI.isOpen() || !this.options.allocateStatPoints) {
      return;
    }
    const available = this.world.playerLevel.unspentPoints;
    if (available <= 0 || this.playerEid < 0) {
      return;
    }
    const currentStats = {} as Record<PrimaryStatId, number>;
    for (const stat of PRIMARY_STATS) {
      currentStats[stat] = this.world.stores.coreStatPoints[stat][this.playerEid] ?? 0;
    }
    this.levelUpUI.open({
      level: this.world.playerLevel.level,
      available,
      currentStats,
    });
  }

  private updateInteractions(): void {
    const tapped = this.tappedInteraction || this.queuedInteraction;
    const interactionInputRequested =
      tapped || Boolean(this.keyE && Phaser.Input.Keyboard.JustDown(this.keyE));
    const interactionRequested =
      this.conversationNpcEid !== null
        ? interactionInputRequested
        : interactionInputRequested && !this.isBlockingSurfaceOpen();
    const closeRequested = this.queuedConversationClose;
    this.tappedInteraction = false;
    this.queuedInteraction = false;
    this.queuedConversationClose = false;

    if (
      (!this.world.floorScenario && !this.world.floorExtendedState?.familyState) ||
      this.world.state !== 'playing'
    ) {
      this.interactionHint?.setVisible(false);
      this.dialogueBox?.hide();
      return;
    }

    const playerX = this.world.stores.position.x[this.playerEid] ?? 0;
    const playerY = this.world.stores.position.y[this.playerEid] ?? 0;

    // Find the nearest NPC with nearbyPlayer flag set so shared-room hubs remain
    // selectable when several NPCs are in interaction range at once. Reads the
    // npc map + position stores directly to avoid a per-frame array allocation.
    const nearNpcEid = findNearestNearbyNpc(
      playerX,
      playerY,
      this.world.npcs,
      this.world.stores.position.x,
      this.world.stores.position.y,
    );

    // Active conversation: game is frozen until the player advances/closes dialogue.
    if (this.conversationNpcEid !== null) {
      const instance = this.world.npcs.get(this.conversationNpcEid);
      if (!instance || !instance.nearbyPlayer) {
        this.closeConversation();
      } else {
        const def = getNpcDef(instance.defId);
        const activeDialogue =
          this.activeConversationLines ??
          resolveDialogueLines(
            instance.defId,
            this.world,
            {
              shopkeeper: this.options.shopkeeper,
              spellQuestGiver: this.options.spellQuestGiver,
              shopkeeperJustReturned: this.shopkeeperJustReturned,
            },
            this.conversationNpcEid,
          );
        this.interactionHint?.setVisible(false);
        this.dialogueBox?.setCloseVisible(true);

        if (closeRequested || (this.keyEsc && Phaser.Input.Keyboard.JustDown(this.keyEsc))) {
          this.closeConversation();
          return;
        }

        if (interactionRequested && activeDialogue.length > 0) {
          const nextIndex = instance.dialogueIndex + 1;
          if (nextIndex >= activeDialogue.length) {
            // Fire broker callback when the player reads the last line of the Broker's
            // intro — this activates the Floor 2 reputation system.
            if (instance.defId === 'the-broker') {
              this.options.broker?.met(this.world);
            }
            this.closeConversation();
            return;
          }
          instance.dialogueIndex = nextIndex;
          const line = activeDialogue[instance.dialogueIndex] ?? '';
          this.dialogueBox?.showLine(def?.name ?? 'NPC', `"${line}"`);
          this.dialogueBox?.setHint(
            instance.dialogueIndex + 1 >= activeDialogue.length
              ? 'Tap to close ▶'
              : 'Tap to continue ▶',
          );
        }
      }
      return;
    }

    if (this.isBlockingSurfaceOpen()) {
      this.interactionHint?.setVisible(false);
      this.dialogueBox?.setCloseVisible(false);
      return;
    }

    // Stair proximity, straight off the scenario contract: the exit is
    // offerable while its marker is shown, descent is not barred, and the
    // player stands inside the marker radius.
    const stairMarker = this.options.scenarioPresentation?.getStairMarkerState?.(this.world);
    // The confirmation copy is required for the affordance, not just for the
    // modal: offering a "Descend" hint the scene cannot follow through on
    // would silently swallow the interact press.
    const stairConfirmation = this.options.scenarioPresentation?.stairConfirmation;
    const nearStairs =
      stairConfirmation !== undefined &&
      stairMarker !== undefined &&
      stairMarker !== null &&
      stairMarker.visible &&
      !stairMarker.locked &&
      Math.hypot(playerX - stairMarker.positionFt.x, playerY - stairMarker.positionFt.y) <=
        stairMarker.radiusFt;

    if (nearNpcEid >= 0) {
      this.interactionHint?.setText('Talk').setVisible(true);
      this.dialogueBox?.setCloseVisible(false);

      if (interactionRequested) {
        if (this.tryQueueSettlementShopOpenFromNpc(nearNpcEid)) {
          return;
        }
        const instance = this.world.npcs.get(nearNpcEid);
        if (instance) {
          const def = getNpcDef(instance.defId);
          // Shopkeeper errand: advance the merchant's multistep flow on talk.
          if (instance.defId === 'shopkeeper' && this.options.shopkeeper) {
            const openedModal = this.handleShopkeeperTalk();
            if (openedModal) {
              return;
            }
          }
          if (instance.defId === 'spell-quest-giver' && this.options.spellQuestGiver) {
            const openedModal = this.handleSpellBrokerTalk();
            if (openedModal) {
              return;
            }
          }
          const activeDialogue = resolveDialogueLines(
            instance.defId,
            this.world,
            {
              shopkeeper: this.options.shopkeeper,
              spellQuestGiver: this.options.spellQuestGiver,
              shopkeeperJustReturned: this.shopkeeperJustReturned,
            },
            nearNpcEid,
          );
          if (def && activeDialogue.length > 0) {
            this.conversationNpcEid = nearNpcEid;
            if (instance.defId === 'tutorial-goon' && this.options.tutorialGoon) {
              this.options.tutorialGoon.meet(this.world);
            }
            if (instance.defId === 'spell-quest-giver' && this.options.spellQuestGiver) {
              this.options.spellQuestGiver.meet(this.world);
            }
            this.activeConversationLines = [...activeDialogue];
            instance.dialogueIndex = 0;
            const text = activeDialogue[instance.dialogueIndex] ?? activeDialogue[0] ?? '';
            this.dialogueBox?.showLine(def.name, `"${text}"`);
            this.dialogueBox?.setHint(
              activeDialogue.length <= 1 ? 'Tap to close ▶' : 'Tap to continue ▶',
            );
          }
        }
      }
    } else if (nearStairs) {
      this.interactionHint?.setText('Descend').setVisible(true);
      this.dialogueBox?.hide();
      if (interactionRequested && this.modalPicker && stairConfirmation) {
        if (!this.modalPicker.isOpen()) {
          this.modalPicker.open(
            {
              title: stairConfirmation.title,
              subtitle: stairConfirmation.subtitle,
              body: stairConfirmation.body,
              options: [
                {
                  id: 'confirm-descend',
                  label: stairConfirmation.confirmLabel,
                  description: stairConfirmation.confirmDescription,
                },
              ],
              allowCancel: true,
              initialSelectedId: 'confirm-descend',
            },
            {
              onConfirm: () => {
                const descended = this.options.onStairDescend?.(this.world, this.playerEid);
                if (descended !== false && !this.floorCompletionMessageShown) {
                  this.time.delayedCall(0, () => this.showFloorCompletionScreenIfNeeded());
                }
                this.updateOverlayText();
              },
            },
          );
        }
      }
    } else {
      this.interactionHint?.setVisible(false);
      this.dialogueBox?.setCloseVisible(false);
      if (nearNpcEid < 0) {
        this.dialogueBox?.setBodyVisible(false);
      }
    }
  }

  /**
   * Advance the shopkeeper errand when the player talks to the merchant.
   * Returns true when a purchase modal was opened (so the caller skips the
   * normal conversation flow).
   */
  private handleShopkeeperTalk(): boolean {
    const shop = this.options.shopkeeper;
    if (!shop) {
      return false;
    }

    // Latch the "introduce yourself" objective.
    shop.meet(this.world);

    // If the player is carrying the prize, hand it over now.
    this.shopkeeperJustReturned = shop.returnPrize(this.world, this.playerEid);

    const stage = shop.getStage(this.world);
    // Shop is open and the prize is already handled: offer the purchase modal.
    if (stage === 'ready-to-buy' && !this.shopkeeperJustReturned && this.modalPicker) {
      if (this.modalPicker.isOpen()) {
        return true;
      }
      const affordable = this.world.playerGold >= shop.equipmentCost;
      const offer: ShopOffer = {
        id: 'buy-equipment',
        name: shop.equipmentName,
        priceGold: shop.equipmentCost,
        detail: 'A faintly damp, weirdly lucky charm.',
        purchasable: affordable,
        blockedReason: 'insufficient-funds',
      };
      openShopModal(
        this.modalPicker,
        {
          title: "The Merchant's Wares",
          body: affordable
            ? `Buy the ${shop.equipmentName} for ${shop.equipmentCost} gold?`
            : `The ${shop.equipmentName} costs ${shop.equipmentCost} gold. You can't afford it yet.`,
          gold: this.world.playerGold,
          offers: [offer],
          // The quest merchant always shows its ware, even unaffordably, so the
          // player learns what to save for instead of falling through to chat.
          whenNothingPurchasable: 'open-disabled',
        },
        {
          onPurchase: () => {
            if (shop.purchase(this.world, this.playerEid)) {
              this.flashHint('Purchased! Press [I] then [G] to equip your gear.');
              this.inventoryUI?.refresh(this.world);
            }
            this.updateOverlayText();
          },
        },
      );
      return true;
    }
    if (
      stage === 'complete' &&
      this.modalPicker &&
      shop.getPostQuestStock &&
      shop.purchasePostQuestItem
    ) {
      if (this.modalPicker.isOpen()) {
        return true;
      }
      const stock = shop.getPostQuestStock(this.world);
      if (stock.length <= 0) {
        return false;
      }
      const bag = this.world.inventories.get(this.playerEid);
      const offers: ShopOffer[] = stock.map((entry) => {
        const item = getItemById(entry.itemId);
        const owned =
          item !== undefined &&
          bag !== undefined &&
          listStaticInventorySlots(bag).some((slot) => slot.itemId === item.id);
        const affordable = this.world.playerGold >= entry.cost;
        return {
          id: `shop-stock:${entry.itemId}`,
          name: item?.name ?? entry.itemId,
          priceGold: entry.cost,
          detail: item?.description ?? 'Unknown item.',
          owned,
          purchasable: !owned && affordable,
          blockedReason: owned ? 'owned' : 'insufficient-funds',
        };
      });
      return openShopModal(
        this.modalPicker,
        {
          title: "The Merchant's Extra Wares",
          body: 'Fresh basics for the next rounds: weapons.',
          gold: this.world.playerGold,
          offers,
        },
        {
          onPurchase: (purchased) => {
            const itemId = purchased.id.replace(/^shop-stock:/, '');
            if (shop.purchasePostQuestItem?.(this.world, this.playerEid, itemId)) {
              this.flashHint('Purchased and added to your bag.');
              this.inventoryUI?.refresh(this.world);
            }
            this.updateOverlayText();
          },
          onDeclined: (reason) => {
            if (reason === 'nothing-purchasable') {
              this.flashHint('No affordable merchant stock right now.');
            }
          },
        },
      );
    }
    return false;
  }

  /** Open the authoritative Floor 1 Spell Broker stock after the quest gate. */
  private handleSpellBrokerTalk(): boolean {
    const broker = this.options.spellQuestGiver;
    if (
      !broker ||
      !this.modalPicker ||
      !broker.getSpellBrokerOffers ||
      !broker.purchaseSpell ||
      !broker.canPurchaseSpell
    ) {
      return false;
    }
    if (this.world.featureUnlocks.spells !== true) return false;
    broker.meet(this.world);
    const brokerOffers = broker.getSpellBrokerOffers(this.world);
    const offers: ShopOffer[] = brokerOffers.map((offer) => ({
      id: offer.spellId,
      name: getAbilityPresentation(offer.spellId)?.name ?? offer.spellId,
      priceGold: offer.cost,
      detail: 'A permanent spell for this run. One purchase per offer.',
      owned: offer.purchased,
      purchasable:
        !offer.purchased && broker.canPurchaseSpell!(this.world, this.playerEid, offer.spellId),
      // The Broker refuses spells for reasons beyond price (already learned this
      // run, no free ability slot), so only claim a gold shortfall when gold is
      // actually short.
      blockedReason: offer.purchased
        ? 'owned'
        : blockReasonFromGold(offer.cost, this.world.playerGold),
    }));
    return openShopModal(
      this.modalPicker,
      {
        kind: 'spell-broker',
        title: 'The Spell Broker',
        body: 'Choose one expensive spell from the Broker’s rotating stock.',
        gold: this.world.playerGold,
        offers,
      },
      {
        onPurchase: (purchased) => {
          if (broker.purchaseSpell!(this.world, this.playerEid, purchased.id)) {
            this.flashHint('Spell purchased and memorized!');
            this.updateOverlayText();
          }
        },
      },
    );
  }
}
