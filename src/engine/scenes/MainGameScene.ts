import { entityExists, query } from 'bitecs';
import Phaser from 'phaser';
import {
  aoeOnImpactPostDamage,
  aoeOnImpactPreDamage,
  areaDamageSystem,
  beamSystem,
  collisionSystem,
  createGameWorld,
  damageSystem,
  deathTimerSystem,
  doorSystem,
  dropSystem,
  Enemy,
  fovSystem,
  healthSystem,
  isInSafeContext,
  itemPickupSystem,
  knockbackSystem,
  lifetimeSystem,
  meleeSwingSystem,
  movementSystem,
  npcSystem,
  playerInputSystem,
  projectileCleanupSystem,
  returningProjectileSystem,
  safeRoomSystem,
  spawnPlayer,
  trapSystem,
  type GameWorld,
} from '../../core/index.js';
import { GAME } from '../../shared/constants.js';
import { UI_DEPTH_CUTOFF } from '../../shared/render-depths.js';
import {
  ACTIVE_ABILITY_SLOT_LIMIT,
  FLOOR1_BOSS_REWARD_SPELL_IDS,
  type AbilityState,
  type Floor1BossRewardSpellId,
} from '../../shared/abilities.js';
import { createInputState, type InputState } from '../../shared/input.js';
import { buildTerrainLayer } from '../terrain-renderer.js';
import { createInputCapture } from '../InputCapture.js';
import { createModalPickerUI } from '../ModalPickerUI.js';
import { createDialogueBox, type DialogueBox } from '../DialogueBox.js';
import { getUiScale, onUiScaleChange } from '../ui-scale.js';
import { createPhaserBridge } from '../PhaserBridge.js';
import { createHudUI } from '../HudUI.js';
import { createInventoryUI } from '../InventoryUI.js';
import { createEquipmentUI } from '../EquipmentUI.js';
import { createGameOverUI } from '../GameOverUI.js';
import { createLevelUpUI } from '../LevelUpUI.js';
import { PRIMARY_STATS, type PrimaryStatId } from '../../shared/stats.js';
import { createLogger } from '../../shared/logger.js';
import { getWeaponDef } from '../../shared/weaponDefs.js';
import {
  getNpcDef,
  SHOPKEEPER_DONE_DIALOGUE,
  SHOPKEEPER_EQUIP_HINT_DIALOGUE,
  SHOPKEEPER_LOCKED_DIALOGUE,
  SHOPKEEPER_RETURN_DIALOGUE,
  SHOPKEEPER_SHOP_DIALOGUE,
  SPELL_QUEST_GIVER_LOCKED_DIALOGUE,
} from '../../shared/npc-types.js';
import type { ShopkeeperStage } from '../../shared/quest-types.js';
import type { SessionRecorder } from '../../shared/session-recorder-types.js';

/** Maximum simulation steps per frame to prevent spiral of death. */
const MAX_STEPS_PER_FRAME = 4;
/**
 * Render frames the level-up modal is held open before an `autoLevelUpAllocator`
 * (AI driver) auto-confirms it. ~0.4s at 60fps — long enough for a viewer to see
 * the screen, short enough not to stall the AI playthrough. Counts render frames
 * (the modal freeze skips the fixed-step), so it is independent of sim speed.
 */
const LEVEL_UP_AUTO_HOLD_FRAMES = 24;
const TUTORIAL_GOON_POST_BOSS_DIALOGUE = [
  'You did it! Boss dropped, room cleared.',
  'Stairs are live. Descend when you are ready.',
  'Floor 2 will hit harder. Keep moving and kite smart.',
] as const;
const DIRECTOR_LABEL_TEXT = 'DIRECTOR';
/** Duration each temporary commentary line stays visible (ms). */
const DIRECTOR_COMMENTARY_MS = 3600;
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
    getStage: (world: GameWorld) => ShopkeeperStage;
    meet: (world: GameWorld) => void;
    returnPrize: (world: GameWorld, playerEid: number) => boolean;
    purchase: (world: GameWorld, playerEid: number) => boolean;
    equip: (world: GameWorld, playerEid: number) => boolean;
    equipmentCost: number;
    equipmentName: string;
    /** True while the merchant is gated behind the welcome-goon quest. */
    isLocked?: (world: GameWorld) => boolean;
  };
  /** Tutorial Goon callbacks — fired on first player-NPC interaction. */
  tutorialGoon?: {
    meet: (world: GameWorld) => void;
  };
  spellQuestGiver?: {
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

  private doorGraphics?: Phaser.GameObjects.Graphics;

  /** Per-door sprite Images (Tiny Dungeon door art), rebuilt on door updates. */
  private doorImages: Phaser.GameObjects.Image[] = [];

  private safeRoomMarker?: Phaser.GameObjects.Arc;

  private staircaseMarker?: Phaser.GameObjects.Arc;

  private loadoutText?: Phaser.GameObjects.Text;

  private hudUi?: ReturnType<typeof createHudUI>;

  private keyOne?: Phaser.Input.Keyboard.Key;

  private keyTwo?: Phaser.Input.Keyboard.Key;

  private keyThree?: Phaser.Input.Keyboard.Key;

  private keyE?: Phaser.Input.Keyboard.Key;

  private keyEsc?: Phaser.Input.Keyboard.Key;

  private keyInventory?: Phaser.Input.Keyboard.Key;

  private keyEquip?: Phaser.Input.Keyboard.Key;

  private keyAbilities?: Phaser.Input.Keyboard.Key;

  private inventoryUI?: ReturnType<typeof createInventoryUI>;
  private equipmentUI?: ReturnType<typeof createEquipmentUI>;

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

  /** Screen-space boss health bar shown during the Floor 1 boss fight. */
  private bossHealthShell?: Phaser.GameObjects.Rectangle;

  private bossHealthFill?: Phaser.GameObjects.Rectangle;

  private bossHealthLabel?: Phaser.GameObjects.Text;

  private bossHealthName?: Phaser.GameObjects.Text;

  /** Dedicated UI camera so HUD is not affected by world camera zoom. */
  private uiCamera?: Phaser.Cameras.Scene2D.Camera;

  private readonly uiMaskIgnoreList: Phaser.GameObjects.GameObject[] = [];

  private readonly worldMaskIgnoreList: Phaser.GameObjects.GameObject[] = [];

  private previousBossEid: number | null = null;

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
                x: this.world.stores.position.x[this.playerEid] ?? 0,
                y: this.world.stores.position.y[this.playerEid] ?? 0,
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
    this.input.keyboard?.on('keydown-E', this.handleKeyboardE, this);
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.handleWindowKeyDown, true);
    }
    this.inventoryUI = createInventoryUI(this);
    this.equipmentUI = createEquipmentUI(this);
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
    this.drawFloorTerrain();
    this.ensureUiCamera();
    this.events.on(Phaser.Scenes.Events.ADDED_TO_SCENE, this.markCameraMasksDirty, this);
    this.events.on(Phaser.Scenes.Events.REMOVED_FROM_SCENE, this.markCameraMasksDirty, this);
    this.refreshCameraMasks();
    this.openLoadoutModal();
    this.bridge.sync(this.world);
    this.updateOverlayText();
    if (typeof window !== 'undefined') {
      window.__floor1Debug = {
        getState: () => ({
          worldState: this.world.state,
          runOutcome: this.world.floor1?.runSummary?.outcome ?? null,
          floorCompletionMessagePending: this.floorCompletionMessagePending,
          floorCompletionMessageShown: this.floorCompletionMessageShown,
          modalOpen: this.modalPicker?.isOpen() ?? false,
        }),
        forceCompletionModal: () => {
          if (this.world.floor1) {
            this.world.floor1.runSummary ??= {
              outcome: 'cleared_floor',
              viewsEarned: 0,
              fansEarned: 0,
            };
            this.world.floor1.runSummary.outcome = 'cleared_floor';
            this.floorCompletionMessagePending = true;
            this.showFloorCompletionScreenIfNeeded();
          }
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
      this.doorGraphics?.destroy();
      for (const img of this.doorImages) {
        img.destroy();
      }
      this.doorImages.length = 0;
      this.safeRoomMarker?.destroy();
      this.staircaseMarker?.destroy();
      this.stairsLabel?.destroy();
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
      this.bossHealthShell?.destroy();
      this.bossHealthFill?.destroy();
      this.bossHealthLabel?.destroy();
      this.bossHealthName?.destroy();
      this.loadoutText?.destroy();
      this.hudUi?.destroy();
      this.inventoryUI?.destroy();
      this.inventoryUI = undefined;
      this.equipmentUI?.destroy();
      this.equipmentUI = undefined;
      this.gameOverUI?.destroy();
      this.gameOverUI = undefined;
      this.levelUpUI?.destroy();
      this.levelUpUI = undefined;
      if (this.uiCamera) {
        this.cameras.remove(this.uiCamera);
        this.uiCamera = undefined;
      }
      this.mapRt = undefined;
      this.doorGraphics = undefined;
      this.safeRoomMarker = undefined;
      this.staircaseMarker = undefined;
      this.stairsLabel = undefined;
      this.interactionHint = undefined;
      this.dialogueBox = undefined;
      this.directorCommentaryText = undefined;
      this.floorCompletionScreen = undefined;
      this.floorCompletionTitleText = undefined;
      this.floorCompletionSubtitleText = undefined;
      this.floorCompletionBodyText = undefined;
      this.bossHealthShell = undefined;
      this.bossHealthFill = undefined;
      this.bossHealthLabel = undefined;
      this.bossHealthName = undefined;
      this.loadoutText = undefined;
      this.hudUi = undefined;
      this.keyAbilities = undefined;
      this.conversationNpcEid = null;
      this.tappedInteraction = false;
      this.queuedInteraction = false;
      this.queuedConversationClose = false;
      this.queuedAbilitiesToggle = false;
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

      playerInputSystem(this.world, this.inputState);
      for (const sys of this.options.preSystems ?? []) {
        sys(this.world);
      }

      if (this.simulationPaused && this.pendingSimulationSteps > 0) {
        this.pendingSimulationSteps = Math.max(0, this.pendingSimulationSteps - steps);
        this.accumulator = 0;
      }
      movementSystem(this.world);
      returningProjectileSystem(this.world);
      const collision = collisionSystem(this.world);
      aoeOnImpactPreDamage(this.world);
      damageSystem(this.world, collision);
      aoeOnImpactPostDamage(this.world);
      areaDamageSystem(this.world, collision);
      meleeSwingSystem(this.world);
      knockbackSystem(this.world);
      beamSystem(this.world);
      trapSystem(this.world, collision);
      itemPickupSystem(this.world, collision);
      dropSystem(this.world);
      deathTimerSystem(this.world);
      healthSystem(this.world);
      lifetimeSystem(this.world);
      projectileCleanupSystem(this.world);
      doorSystem(this.world);
      fovSystem(this.world);
      safeRoomSystem(this.world);
      npcSystem(this.world);
      for (const sys of this.options.postSystems ?? []) {
        sys(this.world);
      }

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
    this.bridge.sync(this.world);
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
      this.equipmentUI?.toggle(this.world);
    } else if (this.equipmentUI?.isOpen()) {
      if (safeCtx) {
        this.equipmentUI.refresh(this.world);
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
    const objective = this.world.floor1?.objective;
    const bossEid = objective?.staircaseBossEid ?? null;
    if (bossEid === this.previousBossEid) {
      return;
    }

    this.previousBossEid = bossEid;
    if (bossEid === null || !entityExists(this.world.ecs, bossEid)) {
      return;
    }

    const x = this.world.stores.position.x[bossEid] ?? 0;
    const y = this.world.stores.position.y[bossEid] ?? 0;

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
      .text(GAME.WIDTH / 2, GAME.HEIGHT - 56, '', {
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
      this.interactionHint?.setScale(scale);
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
    const applyMobileButtonScale = (scale: number): void => {
      this.inventoryButton?.setScale(scale);
      this.equipButton?.setScale(scale);
      // Keep the second button clear of the (scaled) first button.
      this.equipButton?.setY(16 + (this.inventoryButton?.height ?? 44) * scale + 8);
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

    const bossBarWidth = 360;
    const bossBarX = GAME.WIDTH / 2 - bossBarWidth / 2;
    const bossBarY = 16;
    this.bossHealthShell = this.add
      .rectangle(bossBarX + bossBarWidth / 2, bossBarY + 10, bossBarWidth + 4, 24, 0x111827, 0.92)
      .setStrokeStyle(2, 0x4b5563)
      .setScrollFactor(0)
      .setDepth(1000)
      .setVisible(false);
    this.bossHealthFill = this.add
      .rectangle(bossBarX, bossBarY + 10, bossBarWidth, 20, 0xf97316)
      .setOrigin(0, 0.5)
      .setScrollFactor(0)
      .setDepth(1001)
      .setVisible(false);
    this.bossHealthLabel = this.add
      .text(GAME.WIDTH / 2, bossBarY, 'BOSS', {
        fontFamily: 'monospace',
        fontSize: '12px',
        color: '#fde68a',
      })
      .setOrigin(0.5, 0)
      .setScrollFactor(0)
      .setDepth(1001)
      .setVisible(false);
    this.bossHealthName = this.add
      .text(GAME.WIDTH / 2, bossBarY + 28, 'Rat-Slime Hybrid', {
        fontFamily: 'monospace',
        fontSize: '13px',
        color: '#f8fafc',
        backgroundColor: '#0f172acc',
        padding: { x: 6, y: 3 },
      })
      .setOrigin(0.5, 0)
      .setScrollFactor(0)
      .setDepth(1001)
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
    this.doorGraphics?.destroy();
    for (const img of this.doorImages) {
      img.destroy();
    }
    this.doorImages.length = 0;
    this.mapRt = undefined;
    this.doorGraphics = undefined;

    const floorMap = this.world.floorMap;
    if (!floorMap) {
      return;
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
    this.updateDoorOverlay();
    this.cameras.main.setBounds(0, 0, floorMap.widthPx, floorMap.heightPx);
    this.cameras.main.setZoom(2.0);
  }

  private ensureUiCamera(): void {
    if (this.uiCamera) {
      return;
    }
    this.uiCamera = this.cameras.add(0, 0, GAME.WIDTH, GAME.HEIGHT, false, 'ui');
    this.uiCamera.setScroll(0, 0);
    this.uiCamera.setZoom(1);
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
    if (!this.modalPicker || this.world.state !== 'loadout' || !this.world.floor1) {
      return;
    }
    if (this.modalPicker.isOpen() || !this.options.selectLoadoutOption) {
      return;
    }

    const options = this.world.floor1.starterChoices.map((id, index) => {
      const weapon = getWeaponDef(id);
      return {
        id,
        label: weapon?.name ?? `Option ${index + 1}`,
        description: weapon ? `Starter weapon: ${weapon.name}` : id,
      };
    });
    const baseBonuses = this.world.floor1.baseStatBonuses;
    const baseBonusText = `Base bonuses: HP +${baseBonuses.maxHp}, Move +${baseBonuses.moveSpeed.toFixed(1)}, Pickup +${baseBonuses.pickupRange}`;

    this.modalPicker.open(
      {
        title: 'Choose your opening loadout',
        subtitle: `${this.world.floor1.protagonistName} · Floor 1 is paused until you confirm a starter weapon.`,
        body: `${baseBonusText}\nPick the weapon you want to begin with.`,
        options,
        allowCancel: true,
        initialSelectedId: this.world.floor1.starterChoices[0],
      },
      {
        onConfirm: ({ option }) => {
          const choiceIndex = this.world.floor1?.starterChoices.indexOf(option.id) ?? -1;
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

  private formatAbilityTrigger(abilityId: string): string {
    const triggerText: Record<string, string> = {
      fireball: 'Auto: fires at enemy clusters (2+ targets)',
      heal: 'Auto: casts when HP deficit warrants it',
      'pulse-shield': 'Auto: casts at low HP when surrounded',
    };
    return triggerText[abilityId] ?? 'Auto trigger';
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
          description: 'Launches a fireball at clumps of enemies.',
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
        } • ${this.formatAbilityTrigger(abilityId)}`,
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

    const tileSize = floorMap.config.tileSizePx;
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
    const x = this.world.stores.position.x[this.playerEid] ?? GAME.WIDTH * 0.5;
    const y = this.world.stores.position.y[this.playerEid] ?? GAME.HEIGHT * 0.5;
    this.cameras.main.centerOn(x, y);
  }

  private updateObjectiveMarkers(): void {
    if (!this.world.floor1) {
      this.safeRoomMarker?.setVisible(false);
      this.staircaseMarker?.setVisible(false);
      return;
    }

    const objective = this.world.floor1.objective;
    if (!this.safeRoomMarker) {
      this.safeRoomMarker = this.add
        .circle(
          objective.safeRoomPos.x,
          objective.safeRoomPos.y,
          objective.markerRadiusPx,
          0x2563eb,
          0.25,
        )
        .setStrokeStyle(2, 0x93c5fd, 0.95)
        .setDepth(20);
    } else {
      this.safeRoomMarker.setPosition(objective.safeRoomPos.x, objective.safeRoomPos.y);
      this.safeRoomMarker.setRadius(objective.markerRadiusPx);
      this.safeRoomMarker.setVisible(!objective.safeRoomDiscovered);
    }

    if (!this.staircaseMarker) {
      this.staircaseMarker = this.add
        .circle(
          objective.staircasePos.x,
          objective.staircasePos.y,
          objective.markerRadiusPx,
          0x10b981,
          0.25,
        )
        .setStrokeStyle(2, 0x86efac, 0.95)
        .setDepth(20);
    }
    const staircaseFill = objective.staircaseLocked ? 0xf59e0b : 0x10b981;
    const staircaseStroke = objective.staircaseLocked ? 0xfcd34d : 0x86efac;
    this.staircaseMarker.setPosition(objective.staircasePos.x, objective.staircasePos.y);
    this.staircaseMarker.setRadius(objective.markerRadiusPx);
    this.staircaseMarker.setFillStyle(staircaseFill, 0.25);
    this.staircaseMarker.setStrokeStyle(2, staircaseStroke, 0.95);
    this.staircaseMarker.setVisible(objective.staircaseSpawned && !objective.staircaseDiscovered);

    // World-space staircase label above the marker
    if (!this.stairsLabel) {
      this.stairsLabel = this.add
        .text(
          objective.staircasePos.x,
          objective.staircasePos.y - objective.markerRadiusPx - 10,
          '▼ STAIRS',
          {
            fontFamily: 'monospace',
            fontSize: '13px',
            color: '#fef9c3',
            backgroundColor: '#422006cc',
            padding: { x: 8, y: 4 },
            align: 'center',
          },
        )
        .setOrigin(0.5, 1)
        .setDepth(25)
        .setVisible(false);
    }
    this.stairsLabel.setPosition(
      objective.staircasePos.x,
      objective.staircasePos.y - objective.markerRadiusPx - 10,
    );
    this.stairsLabel.setColor(objective.staircaseLocked ? '#fcd34d' : '#86efac');
    this.stairsLabel.setVisible(objective.staircaseSpawned && !objective.staircaseDiscovered);
  }

  private updateOverlayText(): void {
    // HUD (health bar, floor timer, minimap) updates every frame
    this.hudUi?.sync(this.world, this.playerEid);
    this.updateBossHealthBar();
    this.updateDirectorCommentary();

    if (!this.world.floor1) {
      this.loadoutText?.setVisible(false);
      return;
    }

    if (this.world.state === 'loadout') {
      const modalOpen = this.modalPicker?.isOpen() ?? false;
      this.loadoutText?.setVisible(!modalOpen);
      if (modalOpen) {
        return;
      }
      const choices = this.world.floor1.starterChoices
        .map((id, idx) => `${idx + 1}. ${id}`)
        .join('\n');
      this.loadoutText?.setText(
        [
          `${this.world.floor1.protagonistName}`,
          `Base bonuses: HP +${this.world.floor1.baseStatBonuses.maxHp}, Move +${this.world.floor1.baseStatBonuses.moveSpeed.toFixed(1)}, Pickup +${this.world.floor1.baseStatBonuses.pickupRange}`,
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

    const floor1 = this.world.floor1;
    if (!floor1 || this.world.floor !== 1) {
      return;
    }

    const objective = floor1.objective;
    if (!this.commentaryMilestones.floorIntro) {
      this.commentaryMilestones.floorIntro = true;
      this.queueDirectorCommentary(FLOOR_1_COMMENTARY.intro);
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
    if (objective.bossBattleStarted && !this.commentaryMilestones.bossBattleStarted) {
      this.commentaryMilestones.bossBattleStarted = true;
      this.queueDirectorCommentary(FLOOR_1_COMMENTARY.bossBattleStarted);
      return;
    }
    if (objective.staircaseBossDefeated && !this.commentaryMilestones.staircaseBossDefeated) {
      this.commentaryMilestones.staircaseBossDefeated = true;
      this.queueDirectorCommentary(FLOOR_1_COMMENTARY.staircaseBossDefeated);
      return;
    }
    if (objective.staircaseDiscovered && !this.commentaryMilestones.staircaseDiscovered) {
      this.commentaryMilestones.staircaseDiscovered = true;
      this.queueDirectorCommentary(FLOOR_1_COMMENTARY.staircaseDiscovered);
      return;
    }
    if (floor1.failReason === 'stair_timeout' && !this.commentaryMilestones.timeout) {
      this.commentaryMilestones.timeout = true;
      this.queueDirectorCommentary(FLOOR_1_COMMENTARY.timeout);
    }
  }

  private showFloorCompletionScreenIfNeeded(): void {
    const outcome = this.getFloorRunOutcome();
    if (!outcome || !this.shouldShowFloorCompletionMessage()) {
      return;
    }

    if (outcome === 'failed_timeout') {
      this.floorCompletionTitleText?.setText('Game Over');
      this.floorCompletionSubtitleText?.setText('Floor 1 failed');
      this.floorCompletionBodyText?.setText(
        'You ran out of time before reaching the stairs.\nTry again and move faster through objectives.',
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
    return this.getFloorRunOutcome() !== null && !this.floorCompletionMessageShown;
  }

  private getFloorRunOutcome(): 'cleared_floor' | 'failed_timeout' | null {
    const outcome = this.world.floor1?.runSummary?.outcome;
    if (outcome === 'cleared_floor' || outcome === 'failed_timeout') {
      return outcome;
    }
    return null;
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
      this.getFloorRunOutcome() !== null
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

  private updateBossHealthBar(): void {
    const objective = this.world.floor1?.objective;
    const bossEid = objective?.staircaseBossEid ?? null;
    const bossAlive = bossEid !== null && entityExists(this.world.ecs, bossEid);
    const barVisible = !!objective?.bossBattleStarted && bossAlive;
    const shell = this.bossHealthShell;
    const fill = this.bossHealthFill;
    const label = this.bossHealthLabel;
    const name = this.bossHealthName;
    if (!shell || !fill || !label || !name) {
      return;
    }

    shell.setVisible(barVisible);
    fill.setVisible(barVisible);
    label.setVisible(barVisible);
    name.setVisible(barVisible);
    if (!barVisible || bossEid === null) {
      return;
    }

    const current = this.world.stores.health.current[bossEid] ?? 0;
    const max = Math.max(1, this.world.stores.health.max[bossEid] ?? 1);
    const pct = Math.max(0, Math.min(1, current / max));
    const width = 360;
    fill.setSize(Math.max(1, Math.round(width * pct)), 20);
    fill.setFillStyle(pct > 0.5 ? 0x22c55e : pct >= 0.25 ? 0xf59e0b : 0xef4444);
    name.setText(`Rat Slime  ${Math.ceil(current)} / ${Math.ceil(max)}`);
  }

  private updateInteractions(): void {
    const tapped = this.tappedInteraction || this.queuedInteraction;
    const closeRequested = this.queuedConversationClose;
    this.tappedInteraction = false;
    this.queuedInteraction = false;
    this.queuedConversationClose = false;

    if (!this.world.floor1 || this.world.state !== 'playing') {
      this.interactionHint?.setVisible(false);
      this.dialogueBox?.hide();
      return;
    }

    const objective = this.world.floor1.objective;
    const playerX = this.world.stores.position.x[this.playerEid] ?? 0;
    const playerY = this.world.stores.position.y[this.playerEid] ?? 0;

    // Find nearest NPC with nearbyPlayer flag set
    let nearNpcEid = -1;
    for (const [eid, instance] of this.world.npcs.entries()) {
      if (instance.nearbyPlayer) {
        nearNpcEid = eid;
        break;
      }
    }

    // Active conversation: game is frozen until the player advances/closes dialogue.
    if (this.conversationNpcEid !== null) {
      const instance = this.world.npcs.get(this.conversationNpcEid);
      if (!instance || !instance.nearbyPlayer) {
        this.conversationNpcEid = null;
        this.dialogueBox?.hide();
      } else {
        const def = getNpcDef(instance.defId);
        const activeDialogue = this.resolveDialogueLines(instance.defId);
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

    // Check stair proximity (only when unlocked and not yet discovered)
    const nearStairs =
      objective.staircaseUnlocked &&
      objective.staircaseSpawned &&
      !objective.staircaseDiscovered &&
      Math.hypot(playerX - objective.staircasePos.x, playerY - objective.staircasePos.y) <=
        objective.markerRadiusPx;

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
          const activeDialogue = this.resolveDialogueLines(instance.defId);
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
          this.modalPicker.open(
            {
              title: 'Proceed to the next floor?',
              subtitle: 'You are at the stairs.',
              body: 'The boss is defeated. Are you ready to descend to the next floor?',
              options: [
                { id: 'confirm-descend', label: 'Yes, descend now', description: 'Start Floor 2.' },
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

  private resolveDialogueLines(defId: string): string[] {
    const objective = this.world.floor1?.objective;
    if (defId === 'tutorial-goon' && objective?.staircaseBossDefeated) {
      return [...TUTORIAL_GOON_POST_BOSS_DIALOGUE];
    }
    if (defId === 'shopkeeper' && this.options.shopkeeper) {
      if (this.options.shopkeeper.isLocked?.(this.world)) {
        return [...SHOPKEEPER_LOCKED_DIALOGUE];
      }
      const stage = this.options.shopkeeper.getStage(this.world);
      if (stage === 'complete') {
        return [...SHOPKEEPER_DONE_DIALOGUE];
      }
      if (stage === 'awaiting-equip') {
        return [...SHOPKEEPER_EQUIP_HINT_DIALOGUE];
      }
      if (stage === 'ready-to-buy') {
        return this.shopkeeperJustReturned
          ? [...SHOPKEEPER_RETURN_DIALOGUE]
          : [...SHOPKEEPER_SHOP_DIALOGUE];
      }
      // not-met / awaiting-prize: the merchant's initial fetch request.
    }
    if (defId === 'spell-quest-giver' && this.options.spellQuestGiver?.isLocked?.(this.world)) {
      return [...SPELL_QUEST_GIVER_LOCKED_DIALOGUE];
    }
    const def = getNpcDef(defId);
    return def?.dialogue.map((line) => line.text) ?? [];
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
    return false;
  }
}
