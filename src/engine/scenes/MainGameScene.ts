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
  playerInputSystem,
  projectileCleanupSystem,
  returningProjectileSystem,
  spawnPlayer,
  trapSystem,
  type GameWorld,
} from '../../core/index.js';
import { GAME } from '../../shared/constants.js';
import { TerrainType } from '../../shared/map-types.js';
import { createInputState, type InputState } from '../../shared/input.js';
import { createInputCapture } from '../InputCapture.js';
import { createModalPickerUI } from '../ModalPickerUI.js';
import { createPhaserBridge } from '../PhaserBridge.js';
import { createHudUI } from '../HudUI.js';
import { createLogger } from '../../shared/logger.js';
import { getWeaponDef } from '../../shared/weaponDefs.js';

/** Maximum simulation steps per frame to prevent spiral of death. */
const MAX_STEPS_PER_FRAME = 4;
const logger = createLogger('engine:main-game-scene');
const ATOMIZATION_OVERLAY_DEPTH = 6000;
const ATOMIZATION_PIXEL_COUNT = 220;
const ATOMIZATION_SWIRL_MS = 1450;
const TAU = 6.283185307179586;

const TERRAIN_COLORS: Readonly<Record<number, number>> = {
  [TerrainType.VOID]: 0x05060f,
  [TerrainType.STONE_FLOOR]: 0x1f2937,
  [TerrainType.STONE_WALL]: 0x111827,
  [TerrainType.DOOR]: 0x8b5e34,
  [TerrainType.CORRIDOR]: 0x233044,
  [TerrainType.WATER]: 0x1d4ed8,
  [TerrainType.LAVA]: 0xb91c1c,
  [TerrainType.GRASS]: 0x166534,
  [TerrainType.DIRT]: 0x6b3f24,
  [TerrainType.WOOD_FLOOR]: 0x5b4430,
  [TerrainType.WOOD_WALL]: 0x3a2d20,
  [TerrainType.CAVE_FLOOR]: 0x2a2a3d,
  [TerrainType.CAVE_WALL]: 0x1b1b29,
  [TerrainType.TREE]: 0x14532d,
  [TerrainType.RUBBLE]: 0x334155,
};

export interface MainGameSceneOptions {
  preSystems?: ReadonlyArray<(world: GameWorld) => void>;
  postSystems?: ReadonlyArray<(world: GameWorld) => void>;
  configureWorld?: (world: GameWorld, playerEid: number) => void;
  selectLoadoutOption?: (world: GameWorld, optionIndex: number) => void;
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

  private mapGraphics?: Phaser.GameObjects.Graphics;

  private doorGraphics?: Phaser.GameObjects.Graphics;

  private safeRoomMarker?: Phaser.GameObjects.Arc;

  private staircaseMarker?: Phaser.GameObjects.Arc;

  private objectiveText?: Phaser.GameObjects.Text;

  private loadoutText?: Phaser.GameObjects.Text;

  private hudUi?: ReturnType<typeof createHudUI>;

  private keyOne?: Phaser.Input.Keyboard.Key;

  private keyTwo?: Phaser.Input.Keyboard.Key;

  private keyThree?: Phaser.Input.Keyboard.Key;

  private atomizationSequenceStarted = false;

  private atomizationOverlay?: Phaser.GameObjects.Container;

  private atomizationMessage?: Phaser.GameObjects.Text;

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
    this.atomizationSequenceStarted = false;
    this.atomizationOverlay = undefined;
    this.atomizationMessage = undefined;

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
    this.initializeUi();
    this.drawFloorTerrain();
    this.openLoadoutModal();
    this.bridge.sync(this.world);
    this.updateOverlayText();

    this.events.once('shutdown', () => {
      logger.info('Main game scene shutdown');
      this.inputCapture?.destroy();
      this.inputCapture = undefined;
      this.modalPicker?.destroy();
      this.modalPicker = undefined;
      this.bridge?.destroy();
      this.bridge = undefined;
      this.mapGraphics?.destroy();
      this.doorGraphics?.destroy();
      this.safeRoomMarker?.destroy();
      this.staircaseMarker?.destroy();
      this.objectiveText?.destroy();
      this.loadoutText?.destroy();
      this.hudUi?.destroy();
      this.atomizationOverlay?.destroy(true);
      this.atomizationMessage?.destroy();
      this.mapGraphics = undefined;
      this.doorGraphics = undefined;
      this.safeRoomMarker = undefined;
      this.staircaseMarker = undefined;
      this.objectiveText = undefined;
      this.loadoutText = undefined;
      this.hudUi = undefined;
      this.atomizationOverlay = undefined;
      this.atomizationMessage = undefined;
    });
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

    if (this.modalPicker?.isOpen()) {
      this.updateOverlayText();
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
      this.updateCamera();
      this.updateObjectiveMarkers();
      this.updateOverlayText();
      return;
    }

    if (this.world.state !== 'playing') {
      this.startAtomizationSequenceIfNeeded();
      this.updateDoorOverlay();
      this.bridge.sync(this.world);
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
    this.updateCamera();
    this.updateObjectiveMarkers();
    this.updateOverlayText();
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
    this.mapGraphics?.destroy();
    this.doorGraphics?.destroy();
    this.mapGraphics = undefined;
    this.doorGraphics = undefined;

    const floorMap = this.world.floorMap;
    if (!floorMap) {
      return;
    }

    const g = this.add.graphics().setDepth(-20);
    const tileSize = floorMap.config.tileSizePx;
    for (let y = 0; y < floorMap.height; y += 1) {
      for (let x = 0; x < floorMap.width; x += 1) {
        const idx = y * floorMap.width + x;
        const color = TERRAIN_COLORS[floorMap.terrain[idx] ?? TerrainType.VOID] ?? 0x05060f;
        g.fillStyle(color, 1);
        g.fillRect(x * tileSize, y * tileSize, tileSize, tileSize);
      }
    }

    this.mapGraphics = g;
    this.doorGraphics = this.add.graphics().setDepth(-19);
    this.updateDoorOverlay();
    this.cameras.main.setBounds(0, 0, floorMap.widthPx, floorMap.heightPx);
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
    this.staircaseMarker.setPosition(objective.staircasePos.x, objective.staircasePos.y);
    this.staircaseMarker.setRadius(objective.markerRadiusPx);
    this.staircaseMarker.setVisible(objective.staircaseUnlocked && !objective.staircaseDiscovered);
  }

  private startAtomizationSequenceIfNeeded(): void {
    if (this.atomizationSequenceStarted) {
      return;
    }
    if (this.world.state !== 'game_over' || this.world.floor1?.failReason !== 'stair_atomization') {
      return;
    }

    this.atomizationSequenceStarted = true;
    this.objectiveText?.setVisible(false);
    this.loadoutText?.setVisible(false);
    this.safeRoomMarker?.setVisible(false);
    this.staircaseMarker?.setVisible(false);
    this.hudUi?.setAlpha(1);

    const centerX = GAME.WIDTH * 0.5;
    const centerY = GAME.HEIGHT * 0.5;
    const overlay = this.add.container(0, 0).setScrollFactor(0).setDepth(ATOMIZATION_OVERLAY_DEPTH);
    const blackout = this.add
      .rectangle(centerX, centerY, GAME.WIDTH, GAME.HEIGHT, 0x02030a, 0)
      .setScrollFactor(0);
    const singularity = this.add
      .circle(centerX, centerY, 14, 0x000000, 0.95)
      .setScrollFactor(0)
      .setScale(0.2);

    overlay.add([blackout, singularity]);
    this.atomizationOverlay = overlay;

    if (this.objectiveText) {
      this.tweens.add({
        targets: this.objectiveText,
        alpha: 0,
        duration: 300,
        ease: 'Quad.easeOut',
      });
    }
    if (this.loadoutText) {
      this.tweens.add({
        targets: this.loadoutText,
        alpha: 0,
        duration: 300,
        ease: 'Quad.easeOut',
      });
    }

    const hudAlpha = { value: 1 };
    this.tweens.add({
      targets: hudAlpha,
      value: 0,
      duration: 420,
      ease: 'Quad.easeOut',
      onUpdate: () => this.hudUi?.setAlpha(hudAlpha.value),
    });

    this.tweens.add({
      targets: blackout,
      alpha: 0.78,
      duration: 550,
      ease: 'Quad.easeOut',
    });

    this.tweens.add({
      targets: singularity,
      scaleX: 1.8,
      scaleY: 1.8,
      duration: ATOMIZATION_SWIRL_MS,
      ease: 'Sine.easeInOut',
      yoyo: true,
      repeat: -1,
    });

    this.spawnAtomizationSwirl(overlay, centerX, centerY);

    this.time.delayedCall(ATOMIZATION_SWIRL_MS, () => {
      if (!this.sys.isActive()) {
        return;
      }
      this.atomizationMessage = this.add
        .text(centerX, centerY, 'MATERIALS RECLAIMED', {
          fontFamily: 'monospace',
          fontSize: '42px',
          color: '#f8fafc',
          backgroundColor: '#000000cc',
          padding: { x: 18, y: 10 },
          align: 'center',
        })
        .setOrigin(0.5)
        .setScrollFactor(0)
        .setDepth(ATOMIZATION_OVERLAY_DEPTH + 1)
        .setAlpha(0);

      this.tweens.add({
        targets: this.atomizationMessage,
        alpha: 1,
        duration: 240,
        ease: 'Quad.easeOut',
      });
    });
  }

  private spawnAtomizationSwirl(
    overlay: Phaser.GameObjects.Container,
    centerX: number,
    centerY: number,
  ): void {
    const rng = this.world.rng;
    for (let i = 0; i < ATOMIZATION_PIXEL_COUNT; i += 1) {
      const size = rng.nextInt(2, 4);
      const startX = rng.nextInt(0, GAME.WIDTH);
      const startY = rng.nextInt(0, GAME.HEIGHT);
      const color = Phaser.Display.Color.GetColor(
        rng.nextInt(180, 255),
        rng.nextInt(180, 255),
        rng.nextInt(180, 255),
      );
      const pixel = this.add
        .rectangle(startX, startY, size, size, color, 0.9)
        .setScrollFactor(0)
        .setRotation(rng.next() * TAU);
      overlay.add(pixel);

      const startAngle = Phaser.Math.Angle.Between(centerX, centerY, startX, startY);
      const startRadius = Phaser.Math.Distance.Between(centerX, centerY, startX, startY);
      const spinTurns = (3.5 + rng.next() * 4) * TAU;
      const state = { t: 0 };

      this.tweens.add({
        targets: state,
        t: 1,
        duration: rng.nextInt(900, ATOMIZATION_SWIRL_MS),
        delay: rng.nextInt(0, 220),
        ease: 'Cubic.easeIn',
        onUpdate: () => {
          const t = state.t;
          const radius = Phaser.Math.Linear(startRadius, 0, t * t);
          const angle = startAngle + spinTurns * t;
          pixel.x = centerX + Math.cos(angle) * radius;
          pixel.y = centerY + Math.sin(angle) * radius;
          pixel.rotation += 0.28;
          pixel.alpha = 1 - t;
        },
        onComplete: () => pixel.destroy(),
      });
    }
  }

  private updateOverlayText(): void {
    // HUD (health bar, floor timer, minimap) updates every frame
    this.hudUi?.sync(this.world, this.playerEid);

    if (!this.world.floor1) {
      this.objectiveText?.setText(`State: ${this.world.state}`);
      this.loadoutText?.setVisible(false);
      return;
    }

    const objective = this.world.floor1.objective;
    this.objectiveText?.setText(
      [
        `Floor 1 Tutorial`,
        `Rats: ${objective.ratsKilled}/${objective.requiredRats}`,
        `Slimes: ${objective.slimesKilled}/${objective.requiredSlimes}`,
        `Gold: ${objective.goldCollected}/${objective.requiredGold}`,
        `Junk: ${objective.junkCollected}/${objective.requiredJunk}`,
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
}
