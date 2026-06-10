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
const logger = createLogger('engine:main-game-scene');
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

  /** World-space label shown above the staircase marker. */
  private stairsLabel?: Phaser.GameObjects.Text;

  /** Screen-space interaction hint shown when near an NPC or the stairs. */
  private interactionHint?: Phaser.GameObjects.Text;

  /** Screen-space NPC dialogue text shown while a dialogue line is active. */
  private npcDialogueText?: Phaser.GameObjects.Text;

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
      this.mapRt?.destroy();
      this.doorGraphics?.destroy();
      this.safeRoomMarker?.destroy();
      this.staircaseMarker?.destroy();
      this.stairsLabel?.destroy();
      this.interactionHint?.destroy();
      this.npcDialogueText?.destroy();
      this.objectiveText?.destroy();
      this.loadoutText?.destroy();
      this.hudUi?.destroy();
      this.mapRt = undefined;
      this.doorGraphics = undefined;
      this.safeRoomMarker = undefined;
      this.staircaseMarker = undefined;
      this.stairsLabel = undefined;
      this.interactionHint = undefined;
      this.npcDialogueText = undefined;
      this.objectiveText = undefined;
      this.loadoutText = undefined;
      this.hudUi = undefined;
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

    if (this.hudUi?.isMapOverlayOpen()) {
      this.updateDoorOverlay();
      this.bridge.sync(this.world);
      this.updateCamera();
      this.updateObjectiveMarkers();
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
    this.updateCamera();
    this.updateObjectiveMarkers();
    this.updateOverlayText();
    this.updateInteractions();
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

  private formatRemainingMs(remainingMs: number): string {
    const totalSec = Math.max(0, Math.ceil(remainingMs / 1000));
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}:${sec.toString().padStart(2, '0')}`;
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
    const stairStatus = objective.staircaseSpawned
      ? objective.staircaseLocked
        ? 'Stairs: locked (kill Large Slime Rat boss)'
        : 'Stairs: unlocked'
      : objective.staircaseSpawnStartedMs !== null
        ? `Stairs spawn in: ${this.formatRemainingMs(objective.staircaseSpawnRemainingMs ?? 0)}`
        : 'Stairs: complete objectives to begin spawn countdown';
    this.objectiveText?.setText(
      [
        `Floor 1 Tutorial`,
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

  private updateInteractions(): void {
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

    // Check stair proximity (only when unlocked and not yet discovered)
    const nearStairs =
      objective.staircaseUnlocked &&
      objective.staircaseSpawned &&
      !objective.staircaseDiscovered &&
      Math.hypot(playerX - objective.staircasePos.x, playerY - objective.staircasePos.y) <=
        objective.markerRadiusPx;

    if (nearNpcEid >= 0) {
      this.interactionHint?.setText('[E] Talk').setVisible(true);

      if (this.keyE && Phaser.Input.Keyboard.JustDown(this.keyE)) {
        const instance = this.world.npcs.get(nearNpcEid);
        if (instance) {
          const def = getNpcDef(instance.defId);
          if (def && def.dialogue.length > 0) {
            instance.dialogueIndex = (instance.dialogueIndex + 1) % def.dialogue.length;
            const line = def.dialogue[instance.dialogueIndex]?.text ?? '';
            this.npcDialogueText?.setText(`${def.name}: "${line}"`).setVisible(true);
          }
        }
      }
    } else if (nearStairs) {
      this.interactionHint?.setText('[E] Descend').setVisible(true);
      this.npcDialogueText?.setVisible(false);
    } else {
      this.interactionHint?.setVisible(false);
      if (nearNpcEid < 0) {
        this.npcDialogueText?.setVisible(false);
      }
    }
  }
}
