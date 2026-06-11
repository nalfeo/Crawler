import { entityExists } from 'bitecs';
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
  fovSystem,
  healthSystem,
  itemPickupSystem,
  knockbackSystem,
  lifetimeSystem,
  meleeSwingSystem,
  movementSystem,
  npcSystem,
  playerInputSystem,
  projectileCleanupSystem,
  returningProjectileSystem,
  spawnPlayer,
  trapSystem,
  type GameWorld,
} from '../../core/index.js';
import { GAME } from '../../shared/constants.js';
import { createInputState, type InputState } from '../../shared/input.js';
import { buildTerrainLayer } from '../terrain-renderer.js';
import { createInputCapture } from '../InputCapture.js';
import { createModalPickerUI } from '../ModalPickerUI.js';
import { createPhaserBridge } from '../PhaserBridge.js';
import { createHudUI } from '../HudUI.js';
import { createLogger } from '../../shared/logger.js';
import { getWeaponDef } from '../../shared/weaponDefs.js';
import { getNpcDef } from '../../shared/npc-types.js';

/** Maximum simulation steps per frame to prevent spiral of death. */
const MAX_STEPS_PER_FRAME = 4;
const UI_DEPTH_CUTOFF = 900;
const TUTORIAL_GOON_POST_BOSS_DIALOGUE = [
  'You did it! Boss dropped, room cleared.',
  'Stairs are live. Descend when you are ready.',
  'Floor 2 will hit harder. Keep moving and kite smart.',
] as const;
const logger = createLogger('engine:main-game-scene');
export interface MainGameSceneOptions {
  preSystems?: ReadonlyArray<(world: GameWorld) => void>;
  postSystems?: ReadonlyArray<(world: GameWorld) => void>;
  configureWorld?: (world: GameWorld, playerEid: number) => void;
  selectLoadoutOption?: (world: GameWorld, optionIndex: number) => void;
  onStairDescend?: (world: GameWorld, playerEid: number) => boolean | void;
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

  private warnedMissingDependencies = false;

  private modalPicker?: ReturnType<typeof createModalPickerUI>;

  /** Terrain tile layer — baked once per floor as a RenderTexture. */
  private mapRt?: Phaser.GameObjects.RenderTexture;

  private doorGraphics?: Phaser.GameObjects.Graphics;

  private safeRoomMarker?: Phaser.GameObjects.Arc;

  private staircaseMarker?: Phaser.GameObjects.Arc;

  private objectiveText?: Phaser.GameObjects.Text;

  private loadoutText?: Phaser.GameObjects.Text;

  private hudUi?: ReturnType<typeof createHudUI>;

  private keyOne?: Phaser.Input.Keyboard.Key;

  private keyTwo?: Phaser.Input.Keyboard.Key;

  private keyThree?: Phaser.Input.Keyboard.Key;

  private keyE?: Phaser.Input.Keyboard.Key;

  private keyEsc?: Phaser.Input.Keyboard.Key;

  /** World-space label shown above the staircase marker. */
  private stairsLabel?: Phaser.GameObjects.Text;

  /** Screen-space interaction hint shown when near an NPC or the stairs. */
  private interactionHint?: Phaser.GameObjects.Text;

  /** Screen-space NPC dialogue text shown while a dialogue line is active. */
  private npcDialogueText?: Phaser.GameObjects.Text;

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

  private floorCompletionMessageShown = false;

  private floorCompletionMessagePending = false;

  private cameraMasksDirty = true;

  constructor(private readonly options: MainGameSceneOptions = {}) {
    super({ key: MainGameScene.KEY });
  }

  create(): void {
    this.world = createGameWorld();
    this.inputState = createInputState();
    this.inputCapture = createInputCapture(this, {
      getFollowOrigin: () =>
        this.playerEid < 0
          ? undefined
          : {
              x: this.world.stores.position.x[this.playerEid] ?? 0,
              y: this.world.stores.position.y[this.playerEid] ?? 0,
            },
    });
    this.accumulator = 0;
    this.previousWorldState = this.world.state;
    this.accumulatorClampCount = 0;
    this.warnedMissingDependencies = false;
    this.floorCompletionMessageShown = false;
    this.floorCompletionMessagePending = false;

    this.playerEid = spawnPlayer(this.world, GAME.WIDTH / 2, GAME.HEIGHT / 2);
    this.options.configureWorld?.(this.world, this.playerEid);
    logger.info('Main game scene created', {
      state: this.world.state,
      preSystems: this.options.preSystems?.length ?? 0,
      postSystems: this.options.postSystems?.length ?? 0,
    });

    this.bridge = createPhaserBridge(this);
    this.modalPicker = createModalPickerUI(this);
    this.keyOne = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.ONE);
    this.keyTwo = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.TWO);
    this.keyThree = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.THREE);
    this.keyE = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.E);
    this.keyEsc = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.ESC);
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
      this.safeRoomMarker?.destroy();
      this.staircaseMarker?.destroy();
      this.stairsLabel?.destroy();
      this.interactionHint?.destroy();
      this.npcDialogueText?.destroy();
      this.floorCompletionScreen?.destroy();
      this.bossHealthShell?.destroy();
      this.bossHealthFill?.destroy();
      this.bossHealthLabel?.destroy();
      this.bossHealthName?.destroy();
      this.objectiveText?.destroy();
      this.loadoutText?.destroy();
      this.hudUi?.destroy();
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
      this.npcDialogueText = undefined;
      this.floorCompletionScreen = undefined;
      this.floorCompletionTitleText = undefined;
      this.floorCompletionSubtitleText = undefined;
      this.floorCompletionBodyText = undefined;
      this.bossHealthShell = undefined;
      this.bossHealthFill = undefined;
      this.bossHealthLabel = undefined;
      this.bossHealthName = undefined;
      this.objectiveText = undefined;
      this.loadoutText = undefined;
      this.hudUi = undefined;
      this.conversationNpcEid = null;
      this.tappedInteraction = false;
      this.events.off(Phaser.Scenes.Events.ADDED_TO_SCENE, this.markCameraMasksDirty, this);
      this.events.off(Phaser.Scenes.Events.REMOVED_FROM_SCENE, this.markCameraMasksDirty, this);
      this.input.off('pointerdown', this.handlePointerDown, this);
      if (typeof window !== 'undefined' && window.__floor1Debug) {
        delete window.__floor1Debug;
      }
    });
  }

  private handlePointerDown(): void {
    this.tappedInteraction = true;
  }

  private markCameraMasksDirty(): void {
    this.cameraMasksDirty = true;
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
    this.refreshCameraMasks();

    if (this.modalPicker?.isOpen()) {
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
      return;
    }

    // Floor 1 doesn't expose a stat-allocation UI, so keep the simulation flowing
    // instead of parking the whole scene on the level_up flag.
    if (this.world.state === 'level_up') {
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
      return;
    }

    if (this.world.state !== 'playing') {
      this.updateDoorOverlay();
      this.bridge.sync(this.world);
      this.playBossSpawnIntro();
      this.updateCamera();
      this.updateObjectiveMarkers();
      this.updateOverlayText();
      return;
    }

    // Fixed-timestep accumulator: run simulation at GAME.DELTA_MS intervals
    this.accumulator += delta;
    let steps = 0;

    while (this.accumulator >= GAME.DELTA_MS && steps < MAX_STEPS_PER_FRAME) {
      this.world.frameCount += 1;
      this.world.elapsedMs += GAME.DELTA_MS;

      playerInputSystem(this.world, this.inputState);
      for (const sys of this.options.preSystems ?? []) {
        sys(this.world);
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
      npcSystem(this.world);
      for (const sys of this.options.postSystems ?? []) {
        sys(this.world);
      }

      this.accumulator -= GAME.DELTA_MS;
      steps += 1;

      if (this.world.state !== 'playing') {
        break;
      }
    }

    // Cap accumulator to prevent spiral of death after long pauses
    if (this.accumulator > GAME.DELTA_MS * MAX_STEPS_PER_FRAME) {
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

  private initializeUi(): void {
    // Objective tracker — top-left, keeps floor1 kill/loot progress
    this.objectiveText = this.add
      .text(16, 16, '', {
        fontFamily: 'monospace',
        fontSize: '14px',
        color: '#e5e7eb',
        backgroundColor: '#111827cc',
        padding: { x: 10, y: 8 },
      })
      .setDepth(1000)
      .setScrollFactor(0);

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

    // Screen-space interaction hint — bottom-center, shows [E] Talk / [E] Descend prompts
    this.interactionHint = this.add
      .text(GAME.WIDTH / 2, GAME.HEIGHT - 56, '', {
        fontFamily: 'monospace',
        fontSize: '16px',
        color: '#fef9c3',
        backgroundColor: '#422006cc',
        padding: { x: 14, y: 8 },
        align: 'center',
      })
      .setOrigin(0.5, 1)
      .setDepth(1100)
      .setScrollFactor(0)
      .setVisible(false);

    // Screen-space NPC dialogue box — bottom-center, above the hint
    this.npcDialogueText = this.add
      .text(GAME.WIDTH / 2, GAME.HEIGHT - 72, '', {
        fontFamily: 'monospace',
        fontSize: '14px',
        color: '#e2e8f0',
        backgroundColor: '#0f172acc',
        padding: { x: 14, y: 10 },
        align: 'center',
        wordWrap: { width: GAME.WIDTH - 64 },
      })
      .setOrigin(0.5, 1)
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

    this.modalPicker.open(
      {
        title: 'Choose your opening loadout',
        subtitle: 'Floor 1 is paused until you confirm a starter weapon.',
        body: 'Pick the weapon you want to begin with. The game stays frozen while this modal is open.',
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

  private updateDoorOverlay(): void {
    const floorMap = this.world.floorMap;
    const g = this.doorGraphics;
    if (!floorMap || !g) {
      return;
    }

    g.clear();
    const tileSize = floorMap.config.tileSizePx;
    for (let y = 0; y < floorMap.height; y += 1) {
      for (let x = 0; x < floorMap.width; x += 1) {
        if (!floorMap.tileMap.isDoor(x, y)) {
          continue;
        }
        const isOpen = floorMap.tileMap.isPassable(x, y);
        g.fillStyle(isOpen ? 0xd2b48c : 0x6b4423, 1);
        g.fillRect(x * tileSize, y * tileSize, tileSize, tileSize);
        g.lineStyle(1, isOpen ? 0xf5deb3 : 0x3d2615, 0.9);
        g.strokeRect(x * tileSize + 0.5, y * tileSize + 0.5, tileSize - 1, tileSize - 1);
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

    if (!this.world.floor1) {
      this.objectiveText?.setText(`State: ${this.world.state}`);
      this.loadoutText?.setVisible(false);
      return;
    }

    const objective = this.world.floor1.objective;
    const totalKills = objective.ratsKilled + objective.slimesKilled;
    const requiredTotalKills = objective.requiredRats + objective.requiredSlimes;
    const killProgress = Math.min(totalKills, requiredTotalKills);
    const questStatus = !objective.questAccepted
      ? 'Quest: talk to Tutorial Goon'
      : objective.questCompleted
        ? 'Quest: complete'
        : `Quest: kill rats + slimes ${killProgress}/${requiredTotalKills}`;
    const stairStatus = objective.staircaseSpawned
      ? 'Stairs: spawned in boss room'
      : 'Stairs: defeat the boss to spawn';
    this.objectiveText?.setText(
      [
        `Floor 1 Tutorial`,
        questStatus,
        `Kill progress: ${killProgress}/${requiredTotalKills}`,
        `Rats: ${objective.ratsKilled}/${objective.requiredRats}`,
        `Slimes: ${objective.slimesKilled}/${objective.requiredSlimes}`,
        `Gold: ${objective.goldCollected}/${objective.requiredGold}`,
        `Junk: ${objective.junkCollected}/${objective.requiredJunk}`,
        stairStatus,
      ].join('\n'),
    );

    if (this.world.state === 'loadout') {
      this.loadoutText?.setVisible(true);
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
    name.setText(`Rat-Slime Hybrid  ${Math.ceil(current)} / ${Math.ceil(max)}`);
  }

  private updateInteractions(): void {
    const tapped = this.tappedInteraction;
    this.tappedInteraction = false;

    if (!this.world.floor1 || this.world.state !== 'playing') {
      this.interactionHint?.setVisible(false);
      this.npcDialogueText?.setVisible(false);
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
        this.npcDialogueText?.setVisible(false);
      } else {
        const def = getNpcDef(instance.defId);
        const activeDialogue = this.resolveDialogueLines(instance.defId);
        this.interactionHint?.setText('[E] Next  [Esc] Close').setVisible(true);

        if (this.keyEsc && Phaser.Input.Keyboard.JustDown(this.keyEsc)) {
          this.conversationNpcEid = null;
          this.npcDialogueText?.setVisible(false);
          return;
        }

        if (
          (tapped || (this.keyE && Phaser.Input.Keyboard.JustDown(this.keyE))) &&
          activeDialogue.length > 0
        ) {
          const nextIndex = instance.dialogueIndex + 1;
          if (nextIndex >= activeDialogue.length) {
            this.conversationNpcEid = null;
            this.npcDialogueText?.setVisible(false);
            return;
          }
          instance.dialogueIndex = nextIndex;
          const line = activeDialogue[instance.dialogueIndex] ?? '';
          this.npcDialogueText?.setText(`${def?.name ?? 'NPC'}: "${line}"`).setVisible(true);
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
      this.interactionHint?.setText('[E] Talk').setVisible(true);

      if (tapped || (this.keyE && Phaser.Input.Keyboard.JustDown(this.keyE))) {
        const instance = this.world.npcs.get(nearNpcEid);
        if (instance) {
          const def = getNpcDef(instance.defId);
          const activeDialogue = this.resolveDialogueLines(instance.defId);
          if (def && activeDialogue.length > 0) {
            this.conversationNpcEid = nearNpcEid;
            objective.questAccepted = true;
            instance.dialogueIndex = 0;
            const text = activeDialogue[instance.dialogueIndex] ?? activeDialogue[0] ?? '';
            this.npcDialogueText?.setText(`${def.name}: "${text}"`).setVisible(true);
          }
        }
      }
    } else if (nearStairs) {
      this.interactionHint?.setText('[E] Descend').setVisible(true);
      this.npcDialogueText?.setVisible(false);
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
      if (nearNpcEid < 0) {
        this.npcDialogueText?.setVisible(false);
      }
    }
  }

  private resolveDialogueLines(defId: string): string[] {
    const objective = this.world.floor1?.objective;
    if (defId === 'tutorial-goon' && objective?.staircaseBossDefeated) {
      return [...TUTORIAL_GOON_POST_BOSS_DIALOGUE];
    }
    const def = getNpcDef(defId);
    return def?.dialogue.map((line) => line.text) ?? [];
  }
}
