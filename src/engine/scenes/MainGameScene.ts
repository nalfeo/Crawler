import { entityExists, query } from 'bitecs';
import Phaser from 'phaser';
import {
  createGameWorld,
  Enemy,
  fovSystem,
  Harvestable,
  isInSafeContext,
  Position,
  Prop,
  PropLight,
  spawnPlayer,
  type GameWorld,
} from '../../core/index.js';
import {
  CAMERA,
  FLOOR2_STAIR_MARKER_RADIUS_FT,
  GAME,
  safeRoomCameraZoom,
} from '../../shared/constants.js';
import { LIGHTING_OVERLAY_DEPTH, UI_DEPTH_CUTOFF } from '../../shared/render-depths.js';
import { ftToPx, pxToFt, PIXELS_PER_FOOT } from '../../shared/units.js';
import { INTRO_DATA_REGISTRY_KEY } from '../../shared/intro-config.js';
import { getRenderScale } from '../render-scale.js';
import { ACTIVE_ABILITY_SLOT_LIMIT, type AbilityState } from '../../shared/abilities.js';
import { generatedEquipmentRunKeyFromSeed } from '../../shared/generated-equipment-types.js';
import { getAbilityPresentation } from '../../shared/ability-presentation.js';
import { HARVESTABLE_DEFS } from '../../shared/harvestableDefs.js';
import { createInputState, type InputState } from '../../shared/input.js';
import { getFloorManifest } from '../../shared/floor-registry.js';
import { getTerrainPack } from '../../shared/terrain-pack-registry.js';
import {
  resolveDoorOrientationFromFlanks,
  resolveDoorPoolVariant,
} from '../../shared/terrain-pack-variants.js';
import { TERRAIN_PACK_CELL_PX } from '../../shared/terrain-pack-types.js';
import {
  buildTerrainLayer,
  type LineworkRunStats,
  type TerrainPackFamily,
} from '../terrain-renderer.js';
import type { TerrainPackId, TransformId } from '../../shared/terrain-pack-types.js';
import {
  resolveDoorRenderMode,
  GENERATED_DOOR_TEXTURE_KEY,
  DOOR_SHEET_KEY,
  DOOR_CLOSED_FRAME,
  DOOR_OPEN_FRAME,
} from '../sprites/door-visuals.js';
import { createBarrierOverlay } from '../BarrierOverlay.js';
import { createInputCapture } from '../InputCapture.js';
import { createAbilityLoadoutUI, type AbilityLoadoutEntry } from '../AbilityLoadoutUI.js';
import { createModalPickerUI } from '../ModalPickerUI.js';
import { createDialogueBox, type DialogueBox } from '../DialogueBox.js';
import { getUiScale, onUiScaleChange } from '../ui-scale.js';
import { createPhaserBridge } from '../PhaserBridge.js';
import { runSimulationStep } from '../sim/simulation-step.js';
import {
  areLightingRectsEqual,
  findNearestNearbyNpc,
  formatAbilityTrigger,
  getFloorRunOutcome,
  getLightingViewRect,
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
import { createBossChestUI } from '../BossChestUI.js';
import {
  createAudioCueEngine,
  type AudioCueEngine,
  type SynthCueSpec,
} from '../audio/audio-cue-engine.js';
import { createRewardOpeningAudioController } from '../reward-opening-audio.js';
import { prefersReducedMotion } from '../reduced-motion.js';
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
import { createLogger } from '../../shared/logger.js';
import { getItemById } from '../../shared/items.js';
import { getWeaponDef } from '../../shared/weaponDefs.js';
import { getNpcDef } from '../../shared/npc-types.js';
import type { ShopkeeperStage, NpcQuestIndicatorState } from '../../shared/quest-types.js';
import type { SessionRecorder } from '../../shared/session-recorder-types.js';
import { getAchievementById } from '../../shared/achievements.js';

/** Maximum simulation steps per frame to prevent spiral of death. */
const MAX_STEPS_PER_FRAME = 4;
/**
 * Render frames the level-up modal is held open before an `autoLevelUpAllocator`
 * (AI driver) auto-confirms it. ~0.4s at 60fps — long enough for a viewer to see
 * the screen, short enough not to stall the AI playthrough. Counts render frames
 * (the modal freeze skips the fixed-step), so it is independent of sim speed.
 */
const LEVEL_UP_AUTO_HOLD_FRAMES = 24;
const DIRECTOR_LABEL_TEXT = 'DIRECTOR';
/** Duration each temporary commentary line stays visible (ms). */
const DIRECTOR_COMMENTARY_MS = 3600;
const MOBILE_CORNER_BUTTON_MAX_SCALE = 1.4;
const CORNER_BUTTON_DEPTH = 1100;
const MODAL_DISMISS_BUTTON_DEPTH = 5001;
const INTERACTION_HINT_MAX_SCALE = 1.25;
const INTERACTION_HINT_BOTTOM_MARGIN = 12;
const MOBILE_CORNER_BUTTON_DEPTH = CORNER_BUTTON_DEPTH;
const SET_PIECE_LIGHT_RADIUS_FT = 20;
const SET_PIECE_LIGHT_INTENSITY = 0.7;
const FLOOR_1_COMMENTARY = {
  intro: 'Floor 1 opens. {playerName} enters the dungeon and the cameras are rolling.',
  questAccepted: 'Tutorial Goon unlocks XP drops. First milestone: hit level 2 for the audience.',
  questCompleted: 'Quota complete. Boss room is live for the next segment.',
  bossBattleStarted: 'Boss encounter started. This is the ratings spike moment.',
  staircaseBossDefeated: 'Boss down. Stairs unlocked and the crowd wants a clean finish.',
  staircaseDiscovered: 'Floor 1 cleared. Queueing the transfer to the next floor.',
  timeout: 'Time expired before the stairs. Floor 1 run ends here.',
} as const;
const logger = createLogger('engine:main-game-scene');

function resolveSetPieceLightEmission(
  spriteId: string,
): { radiusFt: number; intensity: number } | null {
  if (/^prop-wall-sconce-v1-var-\d+$/.test(spriteId)) {
    return { radiusFt: SET_PIECE_LIGHT_RADIUS_FT, intensity: SET_PIECE_LIGHT_INTENSITY };
  }
  if (/^prop-torch-v1-var-\d+$/.test(spriteId)) {
    return { radiusFt: SET_PIECE_LIGHT_RADIUS_FT, intensity: SET_PIECE_LIGHT_INTENSITY };
  }
  if (/^prop-lantern-v\d+-var-\d+$/.test(spriteId)) {
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
   * Called when Floor 1 is cleared (player descends the stairs).
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
  /** Floor-specific Director narration copy. */
  director?: {
    intro: string;
    victory: string;
    timeout?: string;
  };
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
    /** Dev-only: human player session recorder. Set when MainGameSceneOptions.sessionRecorderFactory is provided. */
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

  private simulationPaused = false;

  private simulationSpeed = 1;

  private pendingSimulationSteps = 0;

  private warnedMissingDependencies = false;

  private modalPicker?: ReturnType<typeof createModalPickerUI>;
  private abilityLoadoutUI?: ReturnType<typeof createAbilityLoadoutUI>;

  /**
   * Dev-only: human player session recorder. Non-null only when
   * `options.sessionRecorderFactory` is provided.
   */
  private sessionRecorder?: SessionRecorder;

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
    packLineworkRuns: [],
    packLineworkHubs: [],
  };

  /**
   * Diagnostic door-render counts from the last `updateDoorOverlay()` pass. Read
   * by the main-scene-probe-lab observe seam (`getDoorRenderSummary`) to prove —
   * in a REAL booted scene — that CLOSED dungeon doors render the active terrain
   * pack's doorSet art when a pack is active (`closedPackCount`), while non-pack
   * floors keep the generated/Kenney/color fallback path. The kind buckets are
   * mutually exclusive;
   * `renderableClosedCount` is the sum of the three CLOSED buckets so the e2e can
   * tell "no eligible closed doors on the map" (0) apart from "wrong branch taken"
   * (generated !== renderable). Doors are drawn per-frame, so these reflect the
   * most recent overlay pass.
   */
  private doorRenderSummary: {
    closedPackCount: number;
    closedGeneratedCount: number;
    closedKenneyCount: number;
    closedColorCount: number;
    openPackCount: number;
    openKenneyCount: number;
    openColorCount: number;
    renderableClosedCount: number;
  } = {
    closedPackCount: 0,
    closedGeneratedCount: 0,
    closedKenneyCount: 0,
    closedColorCount: 0,
    openPackCount: 0,
    openKenneyCount: 0,
    openColorCount: 0,
    renderableClosedCount: 0,
  };

  /** Dynamic darkness overlay rendered from a configurable light field. */
  private lightOverlayRt?: Phaser.GameObjects.RenderTexture;

  private doorGraphics?: Phaser.GameObjects.Graphics;

  /** Per-frame overlay renderer for dynamic barriers (spawner arena, etc.). */
  private barrierOverlay?: ReturnType<typeof createBarrierOverlay>;

  /** Per-door sprite Images (Tiny Dungeon door art), rebuilt on door updates. */
  private doorImages: Phaser.GameObjects.Image[] = [];

  private staircaseMarker?: Phaser.GameObjects.Arc;

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

  private keyBossChests?: Phaser.Input.Keyboard.Key;

  private inventoryUI?: ReturnType<typeof createInventoryUI>;
  private equipmentUI?: ReturnType<typeof createEquipmentUI>;
  private achievementsUI?: ReturnType<typeof createAchievementsUI>;
  /** Shared full-screen anticipation->reveal->summary sequence (achievements + boss chests). */
  private rewardOpeningUI?: ReturnType<typeof createRewardOpeningUI>;
  private bossChestUI?: ReturnType<typeof createBossChestUI>;
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

  /** Chest ids already surfaced via a one-time "ready to open" toast. */
  private readonly notifiedBossChestIds = new Set<string>();

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

  /** Screen-space pixel-themed NPC dialogue box shown while a line is active. */
  private dialogueBox?: DialogueBox;

  /** Screen-space temporary commentary text for scenario callouts. */
  private directorCommentaryText?: Phaser.GameObjects.Text;

  private floorCompletionScreen?: Phaser.GameObjects.Container;

  private floorCompletionTitleText?: Phaser.GameObjects.Text;

  private floorCompletionSubtitleText?: Phaser.GameObjects.Text;

  private floorCompletionBodyText?: Phaser.GameObjects.Text;

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

  /** Touch button for the boss chest panel. */
  private bossChestButton?: Phaser.GameObjects.Text;

  /** One-frame latch set by tapping the on-screen achievements button. */
  private queuedAchievementsToggle = false;

  /** One-frame latch set by tapping the on-screen boss chest button. */
  private queuedBossChestsToggle = false;

  /**
   * Tracks whether the currently open modalPicker is the abilities config modal
   * (vs loadout or spell-selection modals). Used to allow [B] to toggle-close
   * and to auto-close when the player leaves the safe room.
   */
  private abilitiesModalOpen = false;

  /** Transient "New achievement" toast, separate from the interaction hint. */
  private achievementToast?: Phaser.GameObjects.Text;

  private offMobileButtonScale?: () => void;

  private floorCompletionMessageShown = false;

  private floorCompletionMessagePending = false;

  private commentaryHideAtMs = 0;

  private commentaryMilestones = {
    floorIntro: false,
    questAccepted: false,
    questCompleted: false,
    bossBattleStarted: false,
    staircaseBossDefeated: false,
    staircaseDiscovered: false,
    timeout: false,
  };

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
    const worldSeed = this.options.worldSeed ?? 42;
    this.world = createGameWorld({
      seed: worldSeed,
      generatedEquipmentRunKey:
        this.options.generatedEquipmentRunKey ?? generatedEquipmentRunKeyFromSeed(worldSeed),
    });

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
    this.commentaryMilestones = {
      floorIntro: false,
      questAccepted: false,
      questCompleted: false,
      bossBattleStarted: false,
      staircaseBossDefeated: false,
      staircaseDiscovered: false,
      timeout: false,
    };

    this.playerEid = spawnPlayer(this.world, GAME.WIDTH / 2, GAME.HEIGHT / 2);
    this.options.configureWorld?.(this.world, this.playerEid);

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
    this.keyBossChests = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.C);
    this.input.keyboard?.on('keydown-E', this.handleKeyboardE, this);
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.handleWindowKeyDown, true);
    }
    this.inventoryUI = createInventoryUI(this, {
      // Double-click an equippable item to equip it (safe-room gated by
      // equipFromBag). Both panes refresh so the paper-doll and bag stay in
      // sync after the swap.
      onEquipItem: (itemId) => {
        if (this.playerEid < 0) return;
        const result = equipFromBag(this.world, this.playerEid, itemId);
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
    this.achievementsUI = createAchievementsUI(this, this.rewardOpeningUI, {
      onGrantFailed: () => {
        this.flashHint('Reward could not be granted — check your bag has room and try again.');
      },
      onPresentationQueueDrained: () => {
        this.resumePendingRewardPresentations();
      },
    });
    this.bossChestUI = createBossChestUI(this, this.rewardOpeningUI, {
      getPlayerEid: () => (this.playerEid >= 0 ? this.playerEid : undefined),
      onGrantFailed: () => {
        this.flashHint(
          'Chest reward could not be granted — check your bag has room and try again.',
        );
      },
      onPresentationQueueDrained: () => {
        this.resumePendingRewardPresentations();
      },
    });
    this.gameOverUI = createGameOverUI(this, {
      // Both actions reload for now — a title screen / main menu doesn't exist yet.
      // TODO: differentiate onQuit to navigate to a title screen once it's implemented.
      onRestart: () => {
        window.location.reload();
      },
      onQuit: () => {
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
    this.drawFloorTerrain();
    this.ensureUiCamera();
    this.events.on(Phaser.Scenes.Events.ADDED_TO_SCENE, this.markCameraMasksDirty, this);
    this.events.on(Phaser.Scenes.Events.REMOVED_FROM_SCENE, this.markCameraMasksDirty, this);
    this.refreshCameraMasks();
    this.openLoadoutModal();
    this.runFovSystemWithPerf(this.world);
    this.updateLightingOverlay(true);
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
      this.stairsLabel?.destroy();
      for (const indicator of this.npcQuestIndicators.values()) {
        indicator.destroy();
      }
      this.npcQuestIndicators.clear();
      this.interactionHint?.destroy();
      this.offInteractionHintScale?.();
      this.offInteractionHintScale = undefined;
      this.inventoryButton?.destroy();
      this.inventoryButton = undefined;
      this.equipButton?.destroy();
      this.equipButton = undefined;
      this.bossChestButton?.destroy();
      this.bossChestButton = undefined;
      this.offMobileButtonScale?.();
      this.offMobileButtonScale = undefined;
      this.dialogueBox?.destroy();
      this.directorCommentaryText?.destroy();
      this.floorCompletionScreen?.destroy();
      this.loadoutText?.destroy();
      this.hudUi?.destroy();
      this.inventoryUI?.destroy();
      this.inventoryUI = undefined;
      this.equipmentUI?.destroy();
      this.equipmentUI = undefined;
      this.achievementsUI?.destroy();
      this.achievementsUI = undefined;
      this.rewardOpeningUI?.destroy();
      this.rewardOpeningUI = undefined;
      this.rewardAudioEngine?.dispose();
      this.rewardAudioEngine = undefined;
      this.rewardAudioController = undefined;
      this.rewardAudioCueLog.length = 0;
      this.bossChestUI?.destroy();
      this.bossChestUI = undefined;
      this.achievementsButton?.destroy();
      this.achievementsButton = undefined;
      this.abilitiesButton?.destroy();
      this.abilitiesButton = undefined;
      this.abilitiesModalOpen = false;
      this.achievementToast?.destroy();
      this.achievementToast = undefined;
      this.gameOverUI?.destroy();
      this.gameOverUI = undefined;
      this.levelUpUI?.destroy();
      this.levelUpUI = undefined;
      if (this.uiCamera) {
        this.cameras.remove(this.uiCamera);
        this.uiCamera = undefined;
      }
      this.mapRt = undefined;
      this.lightOverlayRt = undefined;
      this.lightField = undefined;
      this.doorGraphics = undefined;
      this.staircaseMarker = undefined;
      this.stairsLabel = undefined;
      this.interactionHint = undefined;
      this.dialogueBox = undefined;
      this.directorCommentaryText = undefined;
      this.floorCompletionScreen = undefined;
      this.floorCompletionTitleText = undefined;
      this.floorCompletionSubtitleText = undefined;
      this.floorCompletionBodyText = undefined;
      this.loadoutText = undefined;
      this.hudUi = undefined;
      this.keyAbilities = undefined;
      this.conversationNpcEid = null;
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
      isCornerButtonHit(this.bossChestButton)
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
      this.keyBossChests,
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

  public requestBossChestsToggle(): void {
    this.tappedInteraction = false;
    this.queuedInteraction = false;
    this.queuedBossChestsToggle = true;
  }

  private resumePendingRewardPresentations(): void {
    if (this.rewardOpeningUI?.isOpen()) {
      return;
    }
    this.achievementsUI?.resumePendingPresentation(this.world);
    if (this.rewardOpeningUI?.isOpen()) {
      return;
    }
    this.bossChestUI?.resumePendingPresentation(this.world);
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
      keepBossChests?: boolean;
    } = {},
  ): void {
    const {
      keepInventory = false,
      keepEquipment = false,
      keepAchievements = false,
      keepBossChests = false,
    } = options;
    if (!keepAchievements && this.achievementsUI?.isOpen()) {
      this.achievementsUI.toggle(this.world);
    }
    if (!keepBossChests && this.bossChestUI?.isOpen()) {
      this.bossChestUI.toggle(this.world);
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
      (this.inventoryUI?.isOpen() ?? false) ||
      (this.equipmentUI?.isOpen() ?? false) ||
      (this.achievementsUI?.isOpen() ?? false) ||
      (this.bossChestUI?.isOpen() ?? false) ||
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

    // While the reward-opening sequence (achievement box / boss chest reveal)
    // is presenting, freeze the simulation but keep rendering/camera alive and
    // drive its own deltaMs-based tick — this is the one full-screen overlay
    // that can appear outside a safe room (e.g. right after a boss kill), so
    // unlike the achievements/inventory/equipment panels it must own input and
    // pause gameplay exactly like the level-up screen.
    if (this.rewardOpeningUI?.isOpen()) {
      this.rewardOpeningUI.tick(delta);
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

      // Dev-only: record telemetry from the human player each sim step.
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
    this.bridge.sync(this.world);
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
      (this.rewardOpeningUI?.isOpen() ?? false);

    // Per-panel open state — used below to show each panel's own button as a
    // touch dismiss affordance even while that panel is blocking other opens.
    const inventoryOpen = this.inventoryUI?.isOpen() ?? false;
    const equipOpen = this.equipmentUI?.isOpen() ?? false;
    const achievementsOpen = this.achievementsUI?.isOpen() ?? false;
    const bossChestsOpen = this.bossChestUI?.isOpen() ?? false;
    const abilitiesOpen = this.abilityLoadoutUI?.isOpen() ?? false;

    // A "hard blocker" prevents all touch-button navigation (conversation,
    // level-up, map overlay, or a non-abilities modal).
    const hardBlocker =
      this.conversationNpcEid !== null ||
      (this.hudUi?.isMapOverlayOpen() ?? false) ||
      (this.levelUpUI?.isOpen() ?? false) ||
      (this.rewardOpeningUI?.isOpen() ?? false) ||
      (!abilitiesOpen && (this.modalPicker?.isOpen() ?? false));

    // canOpenNew: no panel or modal is blocking, so "open" buttons should show.
    const canOpenNew =
      !hardBlocker &&
      !inventoryOpen &&
      !equipOpen &&
      !achievementsOpen &&
      !bossChestsOpen &&
      !abilitiesOpen;

    // Toggle the on-screen touch buttons in step with the key affordances.
    // Each button shows when its own panel is open (to allow touch dismiss) OR
    // when nothing is blocking (to allow opening a panel).
    this.inventoryButton?.setVisible(unlocks.inventory && safeCtx && (inventoryOpen || canOpenNew));
    this.equipButton?.setVisible(unlocks.equipment && safeCtx && (equipOpen || canOpenNew));
    this.achievementsButton?.setVisible(
      safeCtx && this.world.achievements.unlockedIds.size > 0 && (achievementsOpen || canOpenNew),
    );
    this.abilitiesButton
      ?.setDepth(abilitiesOpen ? MODAL_DISMISS_BUTTON_DEPTH : MOBILE_CORNER_BUTTON_DEPTH)
      .setVisible(unlocks.spells && safeCtx && (abilitiesOpen || canOpenNew));
    this.bossChestButton
      ?.setDepth(bossChestsOpen ? MODAL_DISMISS_BUTTON_DEPTH : MOBILE_CORNER_BUTTON_DEPTH)
      .setVisible(this.world.bossChests.size > 0 && (bossChestsOpen || canOpenNew));

    if (unlocks.inventory && !this.inventoryUnlockNotified) {
      this.inventoryUnlockNotified = true;
      this.flashHint('Inventory unlocked! Press [I] or tap Bag in a safe room to open your pack.');
    }
    if (unlocks.equipment && !this.equipmentUnlockNotified) {
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
    if (unlocks.equipment && safeCtx && !isUiLockOpen() && equipRequested) {
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

    // Boss chests have no in-world entity and no safe-room gate — a den is
    // rarely a designated SAFE room, so unlike achievements/inventory/equipment
    // this panel must stay reachable anywhere once at least one chest exists.
    // Surface a one-time "ready" toast per chest the moment it becomes
    // available (deduped via `notifiedBossChestIds` so reopening the panel or
    // re-running this per-frame check never re-flashes the same chest).
    for (const chest of this.world.bossChests.values()) {
      if (chest.state === 'available' && !this.notifiedBossChestIds.has(chest.chestId)) {
        this.notifiedBossChestIds.add(chest.chestId);
        this.flashHint('Boss chest ready! Press [C] or tap Chests to open it.');
      }
    }
    const bossChestsToggleRequested = Boolean(
      this.queuedBossChestsToggle ||
      (this.keyBossChests && Phaser.Input.Keyboard.JustDown(this.keyBossChests)),
    );
    this.queuedBossChestsToggle = false;
    if (this.world.bossChests.size > 0 && !isUiLockOpen() && bossChestsToggleRequested) {
      this.closeMapOverlayIfOpen();
      this.closeCharacterPanels({ keepBossChests: true });
      this.bossChestUI?.toggle(this.world);
    } else if (bossChestsOpen) {
      this.bossChestUI?.refresh(this.world);
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
    packLineworkRuns: readonly LineworkRunStats[];
    packLineworkHubs: readonly { readonly tx: number; readonly ty: number }[];
  } {
    return this.terrainRenderSummary;
  }

  /**
   * Diagnostic door-render provenance counts from the last `updateDoorOverlay()`
   * pass. Lets the main-scene-probe-lab prove — in a REAL booted scene — that a
   * pack-using floor stamps `doorSet` textures (`closedPackCount`) and non-pack
   * floors preserve the generated/Kenney/color fallback chain.
   */
  getDoorRenderSummary(): {
    closedPackCount: number;
    closedGeneratedCount: number;
    closedKenneyCount: number;
    closedColorCount: number;
    openPackCount: number;
    openKenneyCount: number;
    openColorCount: number;
    renderableClosedCount: number;
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
      .text(GAME.WIDTH / 2, GAME.HEIGHT - INTERACTION_HINT_BOTTOM_MARGIN, '', {
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
      this.interactionHint?.setScale(hintScale).setY(GAME.HEIGHT - INTERACTION_HINT_BOTTOM_MARGIN);
    };
    applyInteractionHintScale(getUiScale(this));
    this.offInteractionHintScale = onUiScaleChange(this, applyInteractionHintScale);

    // Top-left on-screen buttons for inventory ([I]) and equipment ([G]) so the
    // pack and gear are reachable on touch devices with no keyboard.
    const makeCornerButton = (
      y: number,
      label: string,
      onTap: () => void,
    ): Phaser.GameObjects.Text =>
      this.add
        .text(16, y, label, {
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
    this.inventoryButton = makeCornerButton(16, '🎒 Bag', () => {
      this.queuedInventoryToggle = true;
    });
    this.equipButton = makeCornerButton(72, '⚔ Gear', () => {
      this.queuedEquip = true;
    });
    this.achievementsButton = makeCornerButton(128, '🏆 Awards', () => {
      this.queuedAchievementsToggle = true;
    });
    this.abilitiesButton = makeCornerButton(184, '🔮 Skills', () => {
      this.queuedAbilitiesToggle = true;
    });
    this.bossChestButton = makeCornerButton(240, '💎 Chests', () => {
      this.queuedBossChestsToggle = true;
    });
    const applyMobileButtonScale = (scale: number): void => {
      const buttonScale = Math.min(scale, MOBILE_CORNER_BUTTON_MAX_SCALE);
      this.inventoryButton?.setScale(buttonScale);
      this.equipButton?.setScale(buttonScale);
      this.achievementsButton?.setScale(buttonScale);
      this.abilitiesButton?.setScale(buttonScale);
      this.bossChestButton?.setScale(buttonScale);
      // Keep buttons clear of each other when scaled.
      const bagH = (this.inventoryButton?.height ?? 44) * buttonScale + 8;
      this.equipButton?.setY(16 + bagH);
      const gearH = (this.equipButton?.height ?? 44) * buttonScale + 8;
      this.achievementsButton?.setY(16 + bagH + gearH);
      const awardsH = (this.achievementsButton?.height ?? 44) * buttonScale + 8;
      this.abilitiesButton?.setY(16 + bagH + gearH + awardsH);
      const skillsH = (this.abilitiesButton?.height ?? 44) * buttonScale + 8;
      this.bossChestButton?.setY(16 + bagH + gearH + awardsH + skillsH);
    };
    applyMobileButtonScale(getUiScale(this));
    this.offMobileButtonScale = onUiScaleChange(this, applyMobileButtonScale);

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
    this.floorCompletionScreen = this.add
      .container(0, 0, [
        completionBackdrop,
        completionPanel,
        this.floorCompletionTitleText,
        this.floorCompletionSubtitleText,
        this.floorCompletionBodyText,
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
      const fresh: AbilityState = {
        learnedSpellIds: [],
        equippedActiveAbilityIds: [],
        ownedActiveAbilityIds: [],
        passiveAbilityIds: [],
        cooldownByAbilityId: new Map(),
        cooldownFramesByAbilityId: new Map(),
        appliedPassiveAbilityIds: new Set(),
      };
      this.world.abilityStatesByEntity.set(this.playerEid, fresh);
    }
    const state = this.world.abilityStatesByEntity.get(this.playerEid)!;
    const availableIds = [
      ...new Set([
        ...state.equippedActiveAbilityIds,
        ...state.learnedSpellIds,
        ...(state.ownedActiveAbilityIds ?? []),
      ]),
    ];
    if (availableIds.length === 0) {
      this.flashHint('No learned spells yet. Defeat the Slime Rat and claim a spellbook first.');
      return;
    }

    const buildEntries = (): AbilityLoadoutEntry[] =>
      availableIds.map((abilityId) => {
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
        closedPackCount: 0,
        closedGeneratedCount: 0,
        closedKenneyCount: 0,
        closedColorCount: 0,
        openPackCount: 0,
        openKenneyCount: 0,
        openColorCount: 0,
        renderableClosedCount: 0,
      };
      return;
    }

    g.clear();
    for (const img of this.doorImages) {
      img.destroy();
    }
    this.doorImages.length = 0;

    const tileSize = floorMap.config.tileSizeFt * PIXELS_PER_FOOT;
    const hasSheet = this.textures.exists(DOOR_SHEET_KEY);

    // Derive the generated closed-door scale ONCE from the texture's ACTUAL
    // loaded width (mirrors terrain-renderer's resolveGeneratedScale): a usable
    // width yields tileSize/width so the single 256² PNG fills exactly one tile;
    // a missing texture or a zero/undefined width falls through to Kenney.
    let generatedDoorScale: number | null = null;
    if (this.textures.exists(GENERATED_DOOR_TEXTURE_KEY)) {
      const source = this.textures.get(GENERATED_DOOR_TEXTURE_KEY).getSourceImage() as {
        width?: number;
      };
      const srcWidth = typeof source?.width === 'number' ? source.width : 0;
      if (srcWidth > 0) {
        generatedDoorScale = tileSize / srcWidth;
      }
    }
    const hasGeneratedClosed = generatedDoorScale !== null;
    const doorManifest = this.options.floorId ? getFloorManifest(this.options.floorId) : undefined;
    const terrainPackId =
      doorManifest?.terrainPacks?.stone ??
      doorManifest?.terrainPackId ??
      doorManifest?.terrainPacks?.cave;
    const activeDoorSet = terrainPackId ? getTerrainPack(terrainPackId).doorSet : null;

    // Door images are recreated every frame, AFTER refreshCameraMasks() has
    // already rebuilt the camera ignore lists. Without pinning uiCamera.ignore
    // here, the scroll-locked UI camera renders them at raw world coordinates, so
    // doors appear pinned to the screen and "follow" the player. Centralized here
    // so every image branch (generated + both Kenney frames) gets it.
    const addDoorImage = (
      px: number,
      py: number,
      key: string,
      frame: number | undefined,
      scale: number,
    ): void => {
      const img = this.add.image(px, py, key, frame).setOrigin(0.5).setDepth(-19).setScale(scale);
      this.uiCamera?.ignore(img);
      this.doorImages.push(img);
    };

    let closedPackCount = 0;
    let closedGeneratedCount = 0;
    let closedKenneyCount = 0;
    let closedColorCount = 0;
    let openPackCount = 0;
    let openKenneyCount = 0;
    let openColorCount = 0;

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
        const cy = y * tileSize + tileSize / 2;
        const orientation = resolveDoorOrientationFromFlanks(horizontalDoorway);
        const packDoorVariant = activeDoorSet
          ? resolveDoorPoolVariant(activeDoorSet, { isOpen, orientation })
          : null;
        const packDoorTextureKey =
          packDoorVariant && this.textures.exists(packDoorVariant.textureKey)
            ? packDoorVariant.textureKey
            : undefined;
        const mode = resolveDoorRenderMode(isOpen, {
          hasGeneratedClosed,
          hasSheet,
          packDoorTextureKey,
        });

        switch (mode.kind) {
          case 'pack': {
            addDoorImage(cx, cy, mode.textureKey, undefined, tileSize / TERRAIN_PACK_CELL_PX);
            if (isOpen) {
              openPackCount += 1;
            } else {
              closedPackCount += 1;
            }
            break;
          }
          case 'generated': {
            // 'generated' is only chosen when hasGeneratedClosed, so
            // generatedDoorScale is non-null here (?? 1 is unreachable but keeps
            // the type checker happy without a non-null assertion).
            addDoorImage(cx, cy, GENERATED_DOOR_TEXTURE_KEY, undefined, generatedDoorScale ?? 1);
            closedGeneratedCount += 1;
            break;
          }
          case 'kenney-closed': {
            addDoorImage(cx, cy, DOOR_SHEET_KEY, DOOR_CLOSED_FRAME, tileSize / 16);
            closedKenneyCount += 1;
            break;
          }
          case 'kenney-open': {
            addDoorImage(cx, cy, DOOR_SHEET_KEY, DOOR_OPEN_FRAME, tileSize / 16);
            openKenneyCount += 1;
            break;
          }
          case 'color': {
            // Fallback for environments without any door art (e.g. tests).
            g.fillStyle(mode.open ? 0xd2b48c : 0x6b4423, 1);
            g.fillRect(x * tileSize, y * tileSize, tileSize, tileSize);
            g.lineStyle(1, mode.open ? 0xf5deb3 : 0x3d2615, 0.9);
            g.strokeRect(x * tileSize + 0.5, y * tileSize + 0.5, tileSize - 1, tileSize - 1);
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
      closedPackCount,
      closedGeneratedCount,
      closedKenneyCount,
      closedColorCount,
      openPackCount,
      openKenneyCount,
      openColorCount,
      renderableClosedCount:
        closedPackCount + closedGeneratedCount + closedKenneyCount + closedColorCount,
    };
  }

  private updateCamera(): void {
    if (this.playerEid < 0) {
      return;
    }
    const px = this.world.stores.position.x[this.playerEid];
    const py = this.world.stores.position.y[this.playerEid];
    this.cameras.main.centerOn(
      px !== undefined ? ftToPx(px) : GAME.WIDTH * 0.5,
      py !== undefined ? ftToPx(py) : GAME.HEIGHT * 0.5,
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

  private updateObjectiveMarkers(): void {
    const floor2State = this.world.floorExtendedState?.familyState;
    if (!this.world.floorScenario) {
      // Floor 2: show exit staircase marker once victory fires and stairs pop
      if (
        floor2State?.staircaseSpawned &&
        !floor2State.staircaseDiscovered &&
        floor2State.staircasePos
      ) {
        const staircaseX = ftToPx(floor2State.staircasePos.x);
        const staircaseY = ftToPx(floor2State.staircasePos.y);
        const markerRadiusPx = ftToPx(FLOOR2_STAIR_MARKER_RADIUS_FT);
        if (!this.staircaseMarker) {
          this.staircaseMarker = this.add
            .circle(staircaseX, staircaseY, markerRadiusPx, 0x10b981, 0.25)
            .setStrokeStyle(2, 0x86efac, 0.95)
            .setDepth(20);
        }
        this.staircaseMarker.setPosition(staircaseX, staircaseY);
        this.staircaseMarker.setRadius(markerRadiusPx);
        this.staircaseMarker.setFillStyle(0x10b981, 0.25);
        this.staircaseMarker.setStrokeStyle(2, 0x86efac, 0.95);
        this.staircaseMarker.setVisible(true);
        if (!this.stairsLabel) {
          this.stairsLabel = this.add
            .text(staircaseX, staircaseY - markerRadiusPx - 10, '▼ EXIT', {
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
        this.stairsLabel.setPosition(staircaseX, staircaseY - markerRadiusPx - 10);
        this.stairsLabel.setColor('#86efac');
        this.stairsLabel.setVisible(true);
      } else {
        this.staircaseMarker?.setVisible(false);
        this.stairsLabel?.setVisible(false);
      }
      this.updateNpcQuestIndicators();
      return;
    }

    const objective = this.world.floorScenario.objective;
    // Marker positions/radii are in feet; scale to pixels for world rendering.
    const staircaseX = ftToPx(objective.staircasePos.x);
    const staircaseY = ftToPx(objective.staircasePos.y);
    const markerRadiusPx = ftToPx(objective.markerRadiusFt);
    if (!this.staircaseMarker) {
      this.staircaseMarker = this.add
        .circle(staircaseX, staircaseY, markerRadiusPx, 0x10b981, 0.25)
        .setStrokeStyle(2, 0x86efac, 0.95)
        .setDepth(20);
    }
    const staircaseFill = objective.staircaseLocked ? 0xf59e0b : 0x10b981;
    const staircaseStroke = objective.staircaseLocked ? 0xfcd34d : 0x86efac;
    this.staircaseMarker.setPosition(staircaseX, staircaseY);
    this.staircaseMarker.setRadius(markerRadiusPx);
    this.staircaseMarker.setFillStyle(staircaseFill, 0.25);
    this.staircaseMarker.setStrokeStyle(2, staircaseStroke, 0.95);
    this.staircaseMarker.setVisible(objective.staircaseSpawned && !objective.staircaseDiscovered);
    // World-space staircase label above the marker
    if (!this.stairsLabel) {
      this.stairsLabel = this.add
        .text(staircaseX, staircaseY - markerRadiusPx - 10, '▼ STAIRS', {
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
    this.stairsLabel.setPosition(staircaseX, staircaseY - markerRadiusPx - 10);
    this.stairsLabel.setColor(objective.staircaseLocked ? '#fcd34d' : '#86efac');
    this.stairsLabel.setVisible(objective.staircaseSpawned && !objective.staircaseDiscovered);
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
      (this.bossChestUI?.isOpen() ?? false) ||
      (this.rewardOpeningUI?.isOpen() ?? false) ||
      (this.modalPicker?.isOpen() ?? false) ||
      (this.abilityLoadoutUI?.isOpen() ?? false) ||
      (this.levelUpUI?.isOpen() ?? false);
    const abilityLoadoutOpen = this.abilityLoadoutUI?.isOpen() ?? false;
    const bossChestsOpen = this.bossChestUI?.isOpen() ?? false;
    if (panelOpen !== this.hudHiddenForPanel) {
      this.hudHiddenForPanel = panelOpen;
      this.hudUi?.setVisible(!panelOpen);
      if (panelOpen) {
        this.interactionHint?.setVisible(false);
        this.inventoryButton?.setVisible(false);
        this.equipButton?.setVisible(false);
        this.achievementsButton?.setVisible(false);
        this.bossChestButton
          ?.setDepth(bossChestsOpen ? MODAL_DISMISS_BUTTON_DEPTH : MOBILE_CORNER_BUTTON_DEPTH)
          .setVisible(bossChestsOpen);
        this.abilitiesButton
          ?.setDepth(abilityLoadoutOpen ? MODAL_DISMISS_BUTTON_DEPTH : MOBILE_CORNER_BUTTON_DEPTH)
          .setVisible(abilityLoadoutOpen);
      }
    }
    this.bossChestButton?.setDepth(
      bossChestsOpen ? MODAL_DISMISS_BUTTON_DEPTH : MOBILE_CORNER_BUTTON_DEPTH,
    );
    this.abilitiesButton?.setDepth(
      abilityLoadoutOpen ? MODAL_DISMISS_BUTTON_DEPTH : MOBILE_CORNER_BUTTON_DEPTH,
    );
    // HUD (health bar, floor timer, boss bar, minimap) updates every frame
    this.hudUi?.sync(this.world, this.playerEid);
    this.updateDirectorCommentary();

    if (!this.world.floorScenario) {
      this.loadoutText?.setVisible(false);
      return;
    }

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

    const director = this.options.director;
    if (!director) {
      return;
    }
    const floorScenario = this.world.floorScenario;
    if (floorScenario && this.world.floor === 1) {
      const objective = floorScenario.objective;
      if (!this.commentaryMilestones.floorIntro) {
        this.commentaryMilestones.floorIntro = true;
        this.queueDirectorCommentary(director.intro ?? FLOOR_1_COMMENTARY.intro);
        return;
      }
      if (objective.questAccepted && !this.commentaryMilestones.questAccepted) {
        this.commentaryMilestones.questAccepted = true;
        this.queueDirectorCommentary(FLOOR_1_COMMENTARY.questAccepted);
        return;
      }
      if (objective.questCompleted && !this.commentaryMilestones.questCompleted) {
        this.commentaryMilestones.questCompleted = true;
        this.queueDirectorCommentary(FLOOR_1_COMMENTARY.questCompleted);
        return;
      }
      const staircaseBattle = objective.bossBattles.get('staircase');
      if (staircaseBattle?.started && !this.commentaryMilestones.bossBattleStarted) {
        this.commentaryMilestones.bossBattleStarted = true;
        this.queueDirectorCommentary(FLOOR_1_COMMENTARY.bossBattleStarted);
        return;
      }
      if (staircaseBattle?.defeated && !this.commentaryMilestones.staircaseBossDefeated) {
        this.commentaryMilestones.staircaseBossDefeated = true;
        this.queueDirectorCommentary(FLOOR_1_COMMENTARY.staircaseBossDefeated);
        return;
      }
      if (objective.staircaseDiscovered && !this.commentaryMilestones.staircaseDiscovered) {
        this.commentaryMilestones.staircaseDiscovered = true;
        this.queueDirectorCommentary(director.victory ?? FLOOR_1_COMMENTARY.staircaseDiscovered);
        return;
      }
      if (floorScenario.failReason === 'stair_timeout' && !this.commentaryMilestones.timeout) {
        this.commentaryMilestones.timeout = true;
        this.queueDirectorCommentary(director.timeout ?? FLOOR_1_COMMENTARY.timeout);
      }
      return;
    }
    if (!this.commentaryMilestones.floorIntro) {
      this.commentaryMilestones.floorIntro = true;
      this.queueDirectorCommentary(director.intro);
      return;
    }
    if (
      this.world.goalFlags.get('floor2-victory') === true &&
      !this.commentaryMilestones.staircaseDiscovered
    ) {
      this.commentaryMilestones.staircaseDiscovered = true;
      this.queueDirectorCommentary(director.victory);
      return;
    }
    if (
      this.world.state === 'game_over' &&
      director.timeout &&
      !this.commentaryMilestones.timeout
    ) {
      this.commentaryMilestones.timeout = true;
      this.queueDirectorCommentary(director.timeout);
    }
  }

  private showFloorCompletionScreenIfNeeded(): void {
    const outcome = getFloorRunOutcome(this.world);
    if (!outcome || !this.shouldShowFloorCompletionMessage()) {
      return;
    }

    if (outcome === 'failed_timeout') {
      this.floorCompletionTitleText?.setText('Game Over');
      this.floorCompletionSubtitleText?.setText('Floor 1 failed');
      this.floorCompletionBodyText?.setText(
        'You ran out of time before reaching the stairs.\nTry again and move faster through objectives.',
      );
    } else if (this.world.floorExtendedState?.familyState?.staircaseDiscovered) {
      this.floorCompletionTitleText?.setText('Victory!');
      this.floorCompletionSubtitleText?.setText('Floor 2 complete!');
      this.floorCompletionBodyText?.setText(
        'Congratulations — you escaped the dungeon!\nMore floors coming soon...',
      );
    } else if (this.options.onFloor1Cleared) {
      this.floorCompletionTitleText?.setText('Floor 1 Complete!');
      this.floorCompletionSubtitleText?.setText('Heading to Floor 2...');
      this.floorCompletionBodyText?.setText('Prepare yourself for the next challenge!');
      this.floorCompletionMessagePending = false;
      this.floorCompletionMessageShown = true;
      this.floorCompletionScreen?.setVisible(true);
      this.time.delayedCall(1500, () => {
        const nextOptions = this.options.onFloor1Cleared?.(this.world, this.playerEid);
        if (nextOptions) {
          const composedNextOptions =
            this.options.recomposeFloorTransitionOptions?.(nextOptions) ?? nextOptions;
          this.scene.restart({ mainGameSceneOptions: composedNextOptions });
        }
      });
      return;
    } else {
      this.floorCompletionTitleText?.setText('Floor 1 Complete!');
      this.floorCompletionSubtitleText?.setText('Floor 1 complete!');
      this.floorCompletionBodyText?.setText(
        'Thanks for completing the first floor!\nMore game coming soon...',
      );
    }

    this.floorCompletionMessagePending = false;
    this.floorCompletionMessageShown = true;
    this.floorCompletionScreen?.setVisible(true);
  }

  private shouldShowFloorCompletionMessage(): boolean {
    return getFloorRunOutcome(this.world) !== null && !this.floorCompletionMessageShown;
  }

  /**
   * Shows the death screen when the player was slain (world.state === 'game_over'
   * and no floor-completion screen is handling the transition).
   *
   * Floor completion outcomes (cleared_floor, failed_timeout) take precedence:
   * those cases are already handled by showFloorCompletionScreenIfNeeded() and
   * should not additionally trigger the death screen.
   */
  private showDeathScreenIfNeeded(): void {
    if (
      this.world.state !== 'game_over' ||
      this.deathScreenShown ||
      getFloorRunOutcome(this.world) !== null
    ) {
      return;
    }
    this.deathScreenShown = true;
    this.gameOverUI?.show();
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

    const floor1Objective = this.world.floorScenario?.objective;
    const floor2State = this.world.floorExtendedState?.familyState;
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
        this.conversationNpcEid = null;
        this.dialogueBox?.hide();
      } else {
        const def = getNpcDef(instance.defId);
        const activeDialogue = resolveDialogueLines(
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
          this.conversationNpcEid = null;
          this.dialogueBox?.hide();
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
            this.conversationNpcEid = null;
            this.dialogueBox?.hide();
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

    // Check stair proximity — floor-aware (Floor 1 vs Floor 2)
    const nearStairs = floor2State
      ? floor2State.staircaseUnlocked === true &&
        floor2State.staircaseSpawned === true &&
        floor2State.staircaseDiscovered !== true &&
        floor2State.staircasePos !== undefined &&
        Math.hypot(playerX - floor2State.staircasePos.x, playerY - floor2State.staircasePos.y) <=
          FLOOR2_STAIR_MARKER_RADIUS_FT
      : floor1Objective !== undefined &&
        floor1Objective.staircaseUnlocked &&
        floor1Objective.staircaseSpawned &&
        !floor1Objective.staircaseDiscovered &&
        Math.hypot(
          playerX - floor1Objective.staircasePos.x,
          playerY - floor1Objective.staircasePos.y,
        ) <= floor1Objective.markerRadiusFt;

    if (nearNpcEid >= 0) {
      this.interactionHint?.setText('Talk').setVisible(true);
      this.dialogueBox?.setCloseVisible(false);

      if (interactionRequested) {
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
      if (interactionRequested && this.modalPicker) {
        if (!this.modalPicker.isOpen()) {
          const isFloor2 = floor2State !== null;
          this.modalPicker.open(
            {
              title: isFloor2 ? 'Victory! Ready to exit?' : 'Proceed to the next floor?',
              subtitle: isFloor2 ? 'You are at the exit.' : 'You are at the stairs.',
              body: isFloor2
                ? 'Floor 2 is cleared. Are you ready to exit the dungeon?'
                : 'The boss is defeated. Are you ready to descend to the next floor?',
              options: [
                {
                  id: 'confirm-descend',
                  label: isFloor2 ? 'Yes, exit now' : 'Yes, descend now',
                  description: isFloor2 ? 'You win!' : 'Start Floor 2.',
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
      const shortfall = Math.max(0, shop.equipmentCost - this.world.playerGold);
      this.modalPicker.open(
        {
          title: "The Merchant's Wares",
          subtitle: `Gold: ${this.world.playerGold}`,
          body: affordable
            ? `Buy the ${shop.equipmentName} for ${shop.equipmentCost} gold?`
            : `The ${shop.equipmentName} costs ${shop.equipmentCost} gold. You can't afford it yet.`,
          options: affordable
            ? [
                {
                  id: 'buy-equipment',
                  label: `Buy ${shop.equipmentName} (${shop.equipmentCost}g)`,
                  description: 'A faintly damp, weirdly lucky charm.',
                },
              ]
            : [
                {
                  id: 'need-more-gold',
                  label: `Need ${shortfall} more gold`,
                  description: 'Leave and come back after looting a little more.',
                },
              ],
          allowCancel: true,
          initialSelectedId: affordable ? 'buy-equipment' : 'need-more-gold',
        },
        {
          onConfirm: () => {
            if (affordable && shop.purchase(this.world, this.playerEid)) {
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
      const optionRows = stock.map((entry) => {
        const item = getItemById(entry.itemId);
        const owned = item
          ? this.world.inventories
              .get(this.playerEid)
              ?.slots.some((slot) => slot.itemId === item.id)
          : false;
        const affordable = this.world.playerGold >= entry.cost;
        return {
          id: `shop-stock:${entry.itemId}`,
          label: item ? `${item.name} (${entry.cost}g)` : `${entry.itemId} (${entry.cost}g)`,
          description: owned ? 'Already owned.' : (item?.description ?? 'Unknown item.'),
          disabled: owned || !affordable,
        };
      });
      const firstEnabled = optionRows.find((row) => !row.disabled);
      if (!firstEnabled) {
        this.flashHint('No affordable merchant stock right now.');
        return false;
      }
      this.modalPicker.open(
        {
          title: "The Merchant's Extra Wares",
          subtitle: `Gold: ${this.world.playerGold}`,
          body: 'Fresh basics for the next rounds: weapons.',
          options: optionRows,
          allowCancel: true,
          initialSelectedId: firstEnabled?.id ?? optionRows[0]?.id,
        },
        {
          onConfirm: ({ option }) => {
            const itemId = option.id.replace(/^shop-stock:/, '');
            if (shop.purchasePostQuestItem?.(this.world, this.playerEid, itemId)) {
              this.flashHint('Purchased and added to your bag.');
              this.inventoryUI?.refresh(this.world);
            }
            this.updateOverlayText();
          },
        },
      );
      return true;
    }
    return false;
  }
}
