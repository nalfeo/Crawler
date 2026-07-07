import { entityExists, query } from 'bitecs';
import Phaser from 'phaser';
import {
  createGameWorld,
  Enemy,
  fovSystem,
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
import { getRenderScale } from '../render-scale.js';
import {
  ACTIVE_ABILITY_SLOT_LIMIT,
  FLOOR1_BOSS_REWARD_SPELL_IDS,
  type AbilityState,
  type Floor1BossRewardSpellId,
} from '../../shared/abilities.js';
import { createInputState, type InputState } from '../../shared/input.js';
import { buildTerrainLayer } from '../terrain-renderer.js';
import { createBarrierOverlay } from '../BarrierOverlay.js';
import { createInputCapture } from '../InputCapture.js';
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
const INTERACTION_HINT_MAX_SCALE = 1.25;
const INTERACTION_HINT_BOTTOM_MARGIN = 12;
const FLOOR_1_COMMENTARY = {
  intro: 'Floor 1 opens. Rhea Vale enters the dungeon and the cameras are rolling.',
  questAccepted: 'Tutorial Goon unlocks XP drops. First milestone: hit level 2 for the audience.',
  questCompleted: 'Quota complete. Boss room is live for the next segment.',
  bossBattleStarted: 'Boss encounter started. This is the ratings spike moment.',
  staircaseBossDefeated: 'Boss down. Stairs unlocked and the crowd wants a clean finish.',
  staircaseDiscovered: 'Floor 1 cleared. Queueing the transfer to the next floor.',
  timeout: 'Time expired before the stairs. Floor 1 run ends here.',
} as const;
const logger = createLogger('engine:main-game-scene');
export interface MainGameSceneOptions {
  inputCaptureOverride?: {
    poll: (state: InputState, world: GameWorld) => void;
    destroy?: () => void;
  };
  /**
   * Seed for the simulation world RNG. When omitted, the world defaults to its
   * built-in seed (42). Exposed so labs/harnesses can replay or randomize runs.
   */
  worldSeed?: number;
  preSystems?: ReadonlyArray<(world: GameWorld) => void>;
  postSystems?: ReadonlyArray<(world: GameWorld) => void>;
  configureWorld?: (world: GameWorld, playerEid: number) => void;
  selectLoadoutOption?: (world: GameWorld, optionIndex: number) => void;
  onStairDescend?: (world: GameWorld, playerEid: number) => boolean | void;
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
  /** Spell selection callback for floor1 boss battle reward. */
  selectSpellFromBossBattle?: (world: GameWorld, playerEid: number, spellId: string) => void;
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
  ) => Partial<Record<PrimaryStatId, number>>;
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
  /** Floor-specific Director narration copy. */
  director?: {
    intro: string;
    victory: string;
    timeout?: string;
  };
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

  private inventoryUI?: ReturnType<typeof createInventoryUI>;
  private equipmentUI?: ReturnType<typeof createEquipmentUI>;
  private achievementsUI?: ReturnType<typeof createAchievementsUI>;

  private gameOverUI?: ReturnType<typeof createGameOverUI>;

  private levelUpUI?: ReturnType<typeof createLevelUpUI>;

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

  /** One-frame latch set by tapping the on-screen achievements button. */
  private queuedAchievementsToggle = false;

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

  constructor(private readonly options: MainGameSceneOptions = {}) {
    super({ key: MainGameScene.KEY });
  }

  create(): void {
    this.world = createGameWorld({ seed: this.options.worldSeed });
    this.inputState = createInputState();
    if (this.options.inputCaptureOverride) {
      this.inputCapture = {
        poll: (state: InputState) => this.options.inputCaptureOverride?.poll(state, this.world),
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
    this.keyOne = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.ONE);
    this.keyTwo = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.TWO);
    this.keyThree = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.THREE);
    this.keyE = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.E);
    this.keyEsc = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.ESC);
    this.keyInventory = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.I);
    this.keyEquip = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.G);
    this.keyAbilities = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.B);
    this.keyAchievements = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.V);
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
    this.achievementsUI = createAchievementsUI(this);
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
      this.achievementsButton?.destroy();
      this.achievementsButton = undefined;
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
    if (this.isTouchPointer(pointer)) {
      return;
    }
    this.tappedInteraction = true;
  }

  private handleKeyboardE(): void {
    if (this.modalPicker?.isOpen()) {
      return;
    }
    this.queuedInteraction = true;
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
    if (this.modalPicker?.isOpen() || this.isTextEntryTarget(event)) {
      return;
    }
    if (event.code === 'KeyE') {
      // Allow browser key-repeat so holding E can advance dialogue lines.
      this.queuedInteraction = true;
      return;
    }
    if (event.code === 'KeyB' && !event.repeat) {
      this.queuedAbilitiesToggle = true;
    }
  };

  private markCameraMasksDirty(): void {
    this.cameraMasksDirty = true;
  }

  public requestInventoryToggle(): void {
    this.queuedInventoryToggle = true;
  }

  public requestEquipAction(): void {
    this.queuedEquip = true;
  }

  public requestAchievementsToggle(): void {
    this.queuedAchievementsToggle = true;
  }

  public isInventoryOpen(): boolean {
    return this.inventoryUI?.isOpen() ?? false;
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

    if (this.modalPicker?.isOpen()) {
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
      this.world.frameCount += 1;
      this.world.elapsedMs += GAME.DELTA_MS;

      // The input override (headless-parity AI) is polled once per rendered frame
      // above, but at high simulation speeds this loop runs many sim steps per
      // frame. Replaying a single stale move vector for N steps makes the AI
      // overshoot waypoint-reached radii and vibrate in place. Re-poll the
      // override every sim step (after the first, which used the poll above) so
      // in-browser AI runs share the headless runner's strict 1:1 poll:step
      // cadence. Human input keeps its once-per-frame poll.
      if (this.options.inputCaptureOverride && steps > 0) {
        this.inputCapture.poll(this.inputState);
      }

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

    // Toggle the on-screen touch buttons in step with the key affordances.
    this.inventoryButton?.setVisible(unlocks.inventory && safeCtx);
    this.equipButton?.setVisible(unlocks.equipment && safeCtx);
    this.achievementsButton?.setVisible(safeCtx && this.world.achievements.unlockedIds.size > 0);

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
      this.flashHint('Abilities unlocked! Press [B] to open Abilities and configure your bar.');
    }

    const inventoryToggleRequested =
      this.queuedInventoryToggle ||
      Boolean(this.keyInventory && Phaser.Input.Keyboard.JustDown(this.keyInventory));
    this.queuedInventoryToggle = false;
    if (unlocks.inventory && safeCtx && inventoryToggleRequested) {
      this.inventoryUI?.toggle(this.world);
    } else if (this.inventoryUI?.isOpen()) {
      this.inventoryUI.refresh(this.world);
    }

    const equipRequested =
      this.queuedEquip || Boolean(this.keyEquip && Phaser.Input.Keyboard.JustDown(this.keyEquip));
    this.queuedEquip = false;
    if (unlocks.equipment && safeCtx && equipRequested) {
      // [G] toggles the equipment panel only. The bag is now integrated into the
      // panel itself (paper-doll | stats | equippable-bag), so we no longer
      // auto-open the standalone InventoryUI — [I] still opens the full pack.
      this.equipmentUI?.toggle(this.world);
      if (
        this.equipmentUI?.isOpen() &&
        unlocks.inventory &&
        this.inventoryUI &&
        !this.inventoryUI.isOpen()
      ) {
        this.inventoryUI.toggle(this.world);
      }
      if (this.equipmentUI?.isOpen() && unlocks.inventory) {
        this.inventoryUI?.refresh(this.world);
      }
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
    if (unlocks.spells && abilitiesToggleRequested) {
      this.openAbilitiesConfigModal();
    }

    const achievementsToggleRequested =
      this.queuedAchievementsToggle ||
      Boolean(this.keyAchievements && Phaser.Input.Keyboard.JustDown(this.keyAchievements));
    this.queuedAchievementsToggle = false;
    const achievementsAvailable = safeCtx && this.world.achievements.unlockedIds.size > 0;
    if (achievementsAvailable && achievementsToggleRequested) {
      this.achievementsUI?.toggle(this.world);
    } else if (this.achievementsUI?.isOpen()) {
      if (safeCtx) {
        this.achievementsUI.refresh(this.world);
      } else {
        this.achievementsUI.toggle(this.world);
      }
    }

    this.processAchievementUnlocks();
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
      .setDepth(1100)
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
        .setDepth(1100)
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
    const applyMobileButtonScale = (scale: number): void => {
      const buttonScale = Math.min(scale, MOBILE_CORNER_BUTTON_MAX_SCALE);
      this.inventoryButton?.setScale(buttonScale);
      this.equipButton?.setScale(buttonScale);
      this.achievementsButton?.setScale(buttonScale);
      // Keep the second/third buttons clear of the (scaled) first button.
      const bagH = (this.inventoryButton?.height ?? 44) * buttonScale + 8;
      this.equipButton?.setY(16 + bagH);
      this.achievementsButton?.setY(16 + bagH + (this.equipButton?.height ?? 44) * buttonScale + 8);
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

    const { rt, colorCount } = buildTerrainLayer(this, floorMap);
    rt.setDepth(-20);
    this.mapRt = rt;

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
    const sourceUnchanged = this.lightingLastSource?.x === px && this.lightingLastSource?.y === py;
    if (!force && !this.lightingDirty && sourceUnchanged && viewRectUnchanged) {
      return;
    }
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
    const lightSources: { x: number; y: number; radiusPx: number; intensity: number }[] = [
      { x: px, y: py, radiusPx: radius, intensity: this.lighting.sourceIntensity },
    ];
    for (const propEid of query(this.world.ecs, [Prop, PropLight, Position])) {
      lightSources.push({
        x: ftToPx(this.world.stores.position.x[propEid] ?? 0),
        y: ftToPx(this.world.stores.position.y[propEid] ?? 0),
        radiusPx: this.world.stores.propLight.radiusPx[propEid] ?? 0,
        intensity: this.world.stores.propLight.intensity[propEid] ?? 0,
      });
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

    // The three available spells for the boss battle reward
    const spellIds = FLOOR1_BOSS_REWARD_SPELL_IDS;

    const options = spellIds.map((spellId) => {
      // Spell name and description (matching ability definitions)
      const spellNames: Record<Floor1BossRewardSpellId, string> = {
        fireball: 'Fireball',
        heal: 'Heal',
        'pulse-shield': 'Pulse Shield',
      };

      const spellDescriptions: Record<Floor1BossRewardSpellId, string> = {
        fireball: 'Unleash a fireball that damages enemies in an area',
        heal: 'Restore your health',
        'pulse-shield': 'Create a shockwave that knocks back nearby enemies',
      };

      return {
        id: spellId,
        label: spellNames[spellId],
        description: spellDescriptions[spellId],
      };
    });

    this.modalPicker.open(
      {
        title: 'Learn a Spell',
        subtitle: 'You defeated the Slime Rat boss!',
        body: 'Choose a spellbook to unlock your ability system. Your pick is slotted onto your abilities bar and will auto-trigger by its combat rules.',
        options,
        allowCancel: false,
        initialSelectedId: 'fireball',
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
    if (!this.modalPicker || this.world.state !== 'playing' || this.modalPicker.isOpen()) {
      return;
    }
    let state = this.world.abilityStatesByEntity.get(this.playerEid);
    if (!state) {
      state = {
        learnedSpellIds: [],
        equippedActiveAbilityIds: [],
        passiveAbilityIds: [],
        cooldownByAbilityId: new Map(),
        cooldownFramesByAbilityId: new Map(),
        appliedPassiveAbilityIds: new Set(),
      } satisfies AbilityState;
      this.world.abilityStatesByEntity.set(this.playerEid, state);
    }
    const learned =
      state.learnedSpellIds.length > 0 ? state.learnedSpellIds : state.equippedActiveAbilityIds;
    if (learned.length === 0) {
      this.flashHint('No learned spells yet. Defeat the Slime Rat and claim a spellbook first.');
      return;
    }

    const options = learned.map((abilityId) => {
      const equipped = state.equippedActiveAbilityIds.includes(abilityId);
      const spellMeta: Record<
        string,
        { name: string; mpCost: number; cooldownSec: number; description: string }
      > = {
        fireball: {
          name: 'Fireball',
          mpCost: 5,
          cooldownSec: 5,
          description: 'Launches a fireball at the nearest enemy, favoring clusters.',
        },
        heal: {
          name: 'Heal',
          mpCost: 10,
          cooldownSec: 30,
          description: 'Restores health when missing HP is high enough.',
        },
        'pulse-shield': {
          name: 'Pulse Shield',
          mpCost: 10,
          cooldownSec: 20,
          description: 'Knocks back nearby enemies when you are in danger.',
        },
      };
      const meta = spellMeta[abilityId];
      const label = meta?.name ?? abilityId;
      return {
        id: abilityId,
        label: equipped ? `${label} (Equipped)` : label,
        description: `${meta?.description ?? 'Configured ability'} • ${
          meta ? `${meta.mpCost} MP • ${meta.cooldownSec}s CD` : 'Spell'
        } • ${formatAbilityTrigger(abilityId)}`,
      };
    });

    this.modalPicker.open(
      {
        title: 'Abilities',
        subtitle: `Slots used: ${state.equippedActiveAbilityIds.length}/${ACTIVE_ABILITY_SLOT_LIMIT}`,
        body: 'Select a learned spell to toggle it on/off your abilities bar. Equipped spells auto-trigger from cooldown + combat rules.',
        options,
        allowCancel: true,
        initialSelectedId: learned[0],
      },
      {
        onConfirm: ({ option }) => {
          const abilityId = option.id;
          const equipped = state.equippedActiveAbilityIds.includes(abilityId);
          if (equipped) {
            const idx = state.equippedActiveAbilityIds.indexOf(abilityId);
            if (idx >= 0) {
              state.equippedActiveAbilityIds.splice(idx, 1);
            }
            this.flashHint(
              `${option.label.replace(' (Equipped)', '')} removed from abilities bar.`,
            );
          } else if (state.equippedActiveAbilityIds.length >= ACTIVE_ABILITY_SLOT_LIMIT) {
            this.flashHint(
              `Abilities bar is full (${ACTIVE_ABILITY_SLOT_LIMIT} slots). Unequip one first.`,
            );
          } else {
            state.equippedActiveAbilityIds.push(abilityId);
            this.flashHint(`${option.label} added to abilities bar.`);
          }
          this.updateOverlayText();
        },
        onCancel: () => {
          this.updateOverlayText();
        },
      },
    );
  }

  private updateDoorOverlay(): void {
    const floorMap = this.world.floorMap;
    const g = this.doorGraphics;
    if (!floorMap || !g) {
      return;
    }

    g.clear();
    for (const img of this.doorImages) {
      img.destroy();
    }
    this.doorImages.length = 0;

    const tileSize = floorMap.config.tileSizeFt * PIXELS_PER_FOOT;
    const TD_KEY = 'kenney-tiny-dungeon';
    const DOOR_CLOSED_FRAME = 46; // brown arched wooden door
    const DOOR_OPEN_FRAME = 34; // door swung open, clear passage
    const hasSheet = this.textures.exists(TD_KEY);

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
        if (hasSheet) {
          const frame = isOpen ? DOOR_OPEN_FRAME : DOOR_CLOSED_FRAME;
          const img = this.add
            .image(x * tileSize + tileSize / 2, y * tileSize + tileSize / 2, TD_KEY, frame)
            .setDepth(-19)
            .setScale(tileSize / 16);
          // Door images are recreated every frame, after refreshCameraMasks()
          // has already rebuilt the camera ignore lists. Without this, the
          // scroll-locked UI camera renders them at raw world coordinates, so
          // doors appear pinned to the screen and "follow" the player. Pinning
          // the ignore here guarantees only the scrolling world camera draws them.
          this.uiCamera?.ignore(img);
          this.doorImages.push(img);
        } else {
          // Fallback for environments without the sprite sheet (e.g. tests).
          g.fillStyle(isOpen ? 0xd2b48c : 0x6b4423, 1);
          g.fillRect(x * tileSize, y * tileSize, tileSize, tileSize);
          g.lineStyle(1, isOpen ? 0xf5deb3 : 0x3d2615, 0.9);
          g.strokeRect(x * tileSize + 0.5, y * tileSize + 0.5, tileSize - 1, tileSize - 1);
        }
      }
    }
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
      (this.equipmentUI?.isOpen() ?? false) || (this.inventoryUI?.isOpen() ?? false);
    if (panelOpen !== this.hudHiddenForPanel) {
      this.hudHiddenForPanel = panelOpen;
      this.hudUi?.setVisible(!panelOpen);
    }
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
    this.directorCommentaryText?.setText(`${DIRECTOR_LABEL_TEXT}: ${text}`).setVisible(true);
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
    } else {
      this.floorCompletionTitleText?.setText('Game Over');
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
    this.levelUpAutoHoldFrames += 1;
    if (this.levelUpAutoHoldFrames < LEVEL_UP_AUTO_HOLD_FRAMES) {
      return;
    }
    const available = this.world.playerLevel.unspentPoints;
    const allocations = allocator(this.world, this.playerEid, available);
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
        const activeDialogue = resolveDialogueLines(instance.defId, this.world, {
          shopkeeper: this.options.shopkeeper,
          spellQuestGiver: this.options.spellQuestGiver,
          shopkeeperJustReturned: this.shopkeeperJustReturned,
        });
        this.interactionHint?.setVisible(false);
        this.dialogueBox?.setCloseVisible(true);

        if (closeRequested || (this.keyEsc && Phaser.Input.Keyboard.JustDown(this.keyEsc))) {
          this.conversationNpcEid = null;
          this.dialogueBox?.hide();
          return;
        }

        if (
          (tapped || (this.keyE && Phaser.Input.Keyboard.JustDown(this.keyE))) &&
          activeDialogue.length > 0
        ) {
          const nextIndex = instance.dialogueIndex + 1;
          if (nextIndex >= activeDialogue.length) {
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

      if (tapped || (this.keyE && Phaser.Input.Keyboard.JustDown(this.keyE))) {
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
          const activeDialogue = resolveDialogueLines(instance.defId, this.world, {
            shopkeeper: this.options.shopkeeper,
            spellQuestGiver: this.options.spellQuestGiver,
            shopkeeperJustReturned: this.shopkeeperJustReturned,
          });
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
      if (
        (tapped || (this.keyE && Phaser.Input.Keyboard.JustDown(this.keyE))) &&
        this.modalPicker
      ) {
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
