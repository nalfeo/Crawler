import { addComponent, query, set, setComponent } from 'bitecs';
import GUI from 'lil-gui';
import Phaser from 'phaser';
import { BroadcastScore, Enemy, Velocity } from '../../core/components.js';
import {
  collisionSystem,
  createGameWorld,
  damageSystem,
  healthSystem,
  movementSystem,
  playerInputSystem,
  projectileCleanupSystem,
  spawnPlayer,
  type GameWorld,
} from '../../core/index.js';
import { createInputCapture } from '../../engine/InputCapture.js';
import { createPhaserBridge } from '../../engine/PhaserBridge.js';
import {
  configureEnemySpawner,
  enemySpawnerSystem,
  setActiveWeapon,
  weaponSystem,
} from '../../game/index.js';
import { GAME, PLAYER_SPEED } from '../../shared/constants.js';
import { ftToPx, pxToFt } from '../../shared/units.js';
import { getWeaponDef } from '../../shared/weaponDefs.js';
import { createInputState, type InputState } from '../../shared/input.js';
import { registerLab, type LabCategory } from '../registry.js';
import { loadLabState, saveLabState } from '../lab-persistence.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

interface CombatLabSettings {
  playerSpeed: number;
  maxEnemies: number;
  spawnIntervalMs: number;
  enemyHp: number;
  enemySpeed: number;
}

const MAX_STEPS_PER_FRAME = 4;
const LAB_SEED = 1337;
const LAB_ID = 'combat-lab';

function createCombatLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const root = document.createElement('div');
  root.style.position = 'relative';
  root.style.width = '100%';
  root.style.height = '100%';
  root.style.overflow = 'hidden';
  root.style.background = 'radial-gradient(circle at top, #2b1228 0%, #120714 45%, #05050a 100%)';

  const gameHost = document.createElement('div');
  gameHost.style.width = '100%';
  gameHost.style.height = '100%';

  const hud = document.createElement('div');
  hud.style.position = 'absolute';
  hud.style.top = '16px';
  hud.style.left = '16px';
  hud.style.padding = '12px 14px';
  hud.style.borderRadius = '12px';
  hud.style.background = 'rgba(20, 7, 20, 0.78)';
  hud.style.border = '1px solid rgba(255, 255, 255, 0.12)';
  hud.style.color = '#f8fafc';
  hud.style.lineHeight = '1.5';
  hud.style.whiteSpace = 'pre-line';
  hud.style.pointerEvents = 'none';

  const hint = document.createElement('p');
  hint.textContent =
    'Move with WASD or arrow keys. Weapons auto-fire at the nearest enemy while the spawner floods the arena.';
  hint.style.marginTop = '16px';
  hint.style.color = '#fbcfe8';
  hint.style.lineHeight = '1.6';

  controls.append(hint);
  root.append(gameHost, hud);
  canvasHost.append(root);

  const settings: CombatLabSettings = {
    playerSpeed: PLAYER_SPEED,
    maxEnemies: 30,
    spawnIntervalMs: 750,
    enemyHp: 20,
    enemySpeed: 0.15625,
    ...(loadLabState<CombatLabSettings>(LAB_ID) ?? {}),
  };

  let resetWorldFromGui = () => undefined;

  class CombatLabScene extends Phaser.Scene {
    private accumulator = 0;

    private bridge?: ReturnType<typeof createPhaserBridge>;

    private inputCapture?: ReturnType<typeof createInputCapture>;

    private inputState!: InputState;

    private playerEid = -1;

    private world!: GameWorld;

    constructor() {
      super({ key: 'CombatLabScene' });
    }

    create(): void {
      resetWorldFromGui = () => {
        this.resetWorld();
      };

      this.inputState = createInputState();
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
      this.accumulator = 0;

      this.cameras.main.setBackgroundColor('#110814');
      this.bridge = createPhaserBridge(this);
      this.resetWorld();

      const handleResize = () => {
        this.applySpawnerBounds();
      };

      this.scale.on('resize', handleResize);
      this.events.once('shutdown', () => {
        resetWorldFromGui = () => undefined;
        this.scale.off('resize', handleResize);
        this.inputCapture?.destroy();
        this.inputCapture = undefined;
        this.bridge?.destroy();
        this.bridge = undefined;
      });
    }

    update(_time: number, delta: number): void {
      if (!this.bridge || !this.inputCapture) {
        return;
      }

      if (this.world.state === 'playing') {
        this.inputCapture.poll(this.inputState);
        this.accumulator += delta;
        let steps = 0;

        while (
          this.accumulator >= GAME.DELTA_MS &&
          steps < MAX_STEPS_PER_FRAME &&
          this.world.state === 'playing'
        ) {
          this.world.frameCount += 1;
          this.world.elapsedMs += GAME.DELTA_MS;

          this.applySpawnerBounds();

          playerInputSystem(this.world, this.inputState);
          this.applyPlayerSpeedSetting();
          weaponSystem(this.world);
          enemySpawnerSystem(this.world, {
            maxEnemies: settings.maxEnemies,
            spawnIntervalMs: settings.spawnIntervalMs,
            enemyHp: settings.enemyHp,
            enemySpeed: settings.enemySpeed,
          });
          movementSystem(this.world);
          damageSystem(this.world, collisionSystem(this.world));
          healthSystem(this.world);
          projectileCleanupSystem(this.world);

          this.accumulator -= GAME.DELTA_MS;
          steps += 1;
        }

        if (this.accumulator > GAME.DELTA_MS * MAX_STEPS_PER_FRAME) {
          this.accumulator = 0;
        }
      }

      this.bridge.sync(this.world);
      this.updateHud();
    }

    private applyPlayerSpeedSetting(): void {
      if (this.playerEid < 0) {
        return;
      }

      const scale = PLAYER_SPEED > 0 ? settings.playerSpeed / PLAYER_SPEED : 1;
      const velocityX = (this.world.stores.velocity.x[this.playerEid] ?? 0) * scale;
      const velocityY = (this.world.stores.velocity.y[this.playerEid] ?? 0) * scale;

      setComponent(this.world.ecs, this.playerEid, Velocity, {
        x: velocityX,
        y: velocityY,
      });
    }

    private applySpawnerBounds(): void {
      configureEnemySpawner(this.world, {
        width: pxToFt(this.getSimulationWidth()),
        height: pxToFt(this.getSimulationHeight()),
      });
    }

    private getSimulationHeight(): number {
      return Math.max(1, Math.round(this.scale.height || this.cameras.main.height || GAME.HEIGHT));
    }

    private getSimulationWidth(): number {
      return Math.max(1, Math.round(this.scale.width || this.cameras.main.width || GAME.WIDTH));
    }

    private resetWorld(): void {
      this.accumulator = 0;
      this.world = createGameWorld({ seed: LAB_SEED });
      this.playerEid = spawnPlayer(
        this.world,
        pxToFt(this.getSimulationWidth()) / 2,
        pxToFt(this.getSimulationHeight()) / 2,
      );
      addComponent(this.world.ecs, this.playerEid, set(BroadcastScore, { current: 0 }));

      const pistol = getWeaponDef('pistol');
      if (pistol) setActiveWeapon(this.world, pistol);
      this.applySpawnerBounds();
      this.bridge?.sync(this.world);
      this.updateHud();
    }

    private updateHud(): void {
      const playerHp =
        this.playerEid >= 0 ? (this.world.stores.health.current[this.playerEid] ?? 0) : 0;
      const score =
        this.playerEid >= 0 ? (this.world.stores.broadcastScore.current[this.playerEid] ?? 0) : 0;
      const enemyCount = query(this.world.ecs, [Enemy]).length;

      hud.textContent = [
        `Player HP: ${playerHp.toFixed(0)}`,
        `Score: ${score.toFixed(0)}`,
        `Enemies: ${enemyCount}`,
        `Game State: ${this.world.state}`,
      ].join('\n');
    }
  }

  const controlsApi = {
    reset: () => {
      resetWorldFromGui();
    },
  };

  gui.add(settings, 'playerSpeed', 0.125, 1.875, 0.0125).name('Player Speed');
  gui.add(settings, 'maxEnemies', 5, 200, 1).name('Max Enemies');
  gui.add(settings, 'spawnIntervalMs', 100, 5000, 1).name('Spawn Interval');
  gui.add(settings, 'enemyHp', 10, 500, 1).name('Enemy HP');
  gui.add(settings, 'enemySpeed', 0.0625, 0.625, 0.0125).name('Enemy Speed');
  gui.add(controlsApi, 'reset').name('Reset');
  gui.onChange(() => saveLabState(LAB_ID, settings));

  const getSize = () => ({
    width: Math.max(1, Math.round(gameHost.clientWidth || GAME.WIDTH)),
    height: Math.max(1, Math.round(gameHost.clientHeight || GAME.HEIGHT)),
  });

  const initialSize = getSize();
  const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    parent: gameHost,
    width: initialSize.width,
    height: initialSize.height,
    backgroundColor: '#110814',
    scene: [CombatLabScene],
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
  };

  const game = new Phaser.Game(config);
  const resizeObserver = new ResizeObserver(() => {
    const nextSize = getSize();
    game.scale.resize(nextSize.width, nextSize.height);
  });
  resizeObserver.observe(gameHost);

  return () => {
    resizeObserver.disconnect();
    game.destroy(true);
    hint.remove();
    root.remove();
  };
}

registerLab('combat-lab', {
  category: 'Combat' as LabCategory,
  name: 'Combat Lab',
  description:
    'Stress-test auto-attacks, deterministic enemy spawns, and the combat damage pipeline.',
  create: createCombatLab,
});
