import { query, setComponent } from 'bitecs';
import GUI from 'lil-gui';
import Phaser from 'phaser';
import { Enemy, Health } from '../../core/components.js';
import {
  collisionSystem,
  createGameWorld,
  damageSystem,
  healthSystem,
  movementSystem,
  playerInputSystem,
  projectileCleanupSystem,
  lifetimeSystem,
  meleeSwingSystem,
  knockbackSystem,
  spawnPlayer,
  spawnEnemy,
  type GameWorld,
} from '../../core/index.js';
import { dropSystem } from '../../core/systems/dropSystem.js';
import { deathTimerSystem } from '../../core/systems/deathTimerSystem.js';
import { createInputCapture } from '../../engine/InputCapture.js';
import { createPhaserBridge } from '../../engine/PhaserBridge.js';
import { createGoreVfx } from '../../engine/GoreVfx.js';
import { setActiveWeapon, weaponSystem } from '../../game/index.js';
import { GAME, PLAYER_SPEED } from '../../shared/constants.js';
import { createInputState, type InputState } from '../../shared/input.js';
import { WEAPON_DEFS } from '../../shared/weaponDefs.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

const WEAPON_IDS = [...WEAPON_DEFS.keys()];
const LAB_SEED = 6660;

interface GoreLabSettings {
  intensity: number;
  hitGoreEnabled: boolean;
  enemyHp: number;
  respawnDelayMs: number;
  activeWeapon: string;
}

const MAX_STEPS_PER_FRAME = 4;

function createGoreLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const settings: GoreLabSettings = {
    intensity: 1.0,
    hitGoreEnabled: true,
    enemyHp: 30,
    respawnDelayMs: 1000,
    activeWeapon: WEAPON_IDS[0] ?? 'sword',
  };

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
    'Move with WASD to trigger weapon auto-fire on the stationary enemy. Watch for gore particles on hit and death.';
  hint.style.marginTop = '16px';
  hint.style.color = '#fbcfe8';
  hint.style.lineHeight = '1.6';

  controls.append(hint);
  root.append(gameHost, hud);
  canvasHost.append(root);

  class GoreLabScene extends Phaser.Scene {
    private accumulator = 0;
    private bridge?: ReturnType<typeof createPhaserBridge>;
    private gore?: ReturnType<typeof createGoreVfx>;
    private inputCapture?: ReturnType<typeof createInputCapture>;
    private inputState!: InputState;
    private playerEid = -1;
    private enemyEid = -1;
    private world!: GameWorld;
    private respawnTimer = 0;

    constructor() {
      super({ key: 'GoreLabScene' });
    }

    create(): void {
      this.inputState = createInputState();
      this.inputCapture = createInputCapture(this);
      this.accumulator = 0;

      this.cameras.main.setBackgroundColor('#120714');
      this.bridge = createPhaserBridge(this);
      this.gore = createGoreVfx(this, {
        intensity: settings.intensity,
        hitGoreEnabled: settings.hitGoreEnabled,
      });
      this.resetWorld();

      this.events.once('shutdown', () => {
        this.inputCapture?.destroy();
        this.inputCapture = undefined;
        this.gore?.destroy();
        this.gore = undefined;
        this.bridge?.destroy();
        this.bridge = undefined;
      });
    }

    update(_time: number, delta: number): void {
      if (!this.bridge || !this.inputCapture || !this.gore) return;

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

          // Apply live settings
          this.gore.config.intensity = settings.intensity;
          this.gore.config.hitGoreEnabled = settings.hitGoreEnabled;
          this.applyActiveWeapon();

          playerInputSystem(this.world, this.inputState);
          this.applyPlayerSpeed();
          weaponSystem(this.world);
          movementSystem(this.world);
          meleeSwingSystem(this.world);

          const collision = collisionSystem(this.world);
          damageSystem(this.world, collision);

          dropSystem(this.world);
          knockbackSystem(this.world);
          deathTimerSystem(this.world);
          healthSystem(this.world);
          lifetimeSystem(this.world);
          projectileCleanupSystem(this.world);

          this.handleEnemyRespawn();
          this.keepEnemyStationary();

          this.accumulator -= GAME.DELTA_MS;
          steps += 1;
        }

        if (this.accumulator > GAME.DELTA_MS * MAX_STEPS_PER_FRAME) {
          this.accumulator = GAME.DELTA_MS;
        }
      }

      const renderElapsedMs = this.world.elapsedMs + this.accumulator;
      const interpAlpha = Math.min(1, Math.max(0, this.accumulator / GAME.DELTA_MS));

      // Gore VFX processes combat events and animates particles
      this.gore.update(this.world, renderElapsedMs, delta);

      this.bridge.sync(this.world, renderElapsedMs, interpAlpha);
      this.updateHud();
    }

    private applyActiveWeapon(): void {
      const def = WEAPON_DEFS.get(settings.activeWeapon);
      if (def) setActiveWeapon(this.world, def);
    }

    private applyPlayerSpeed(): void {
      if (this.playerEid < 0) return;
      const vx = this.world.stores.velocity.x[this.playerEid] ?? 0;
      const vy = this.world.stores.velocity.y[this.playerEid] ?? 0;
      const scale = PLAYER_SPEED > 0 ? PLAYER_SPEED / PLAYER_SPEED : 1;
      this.world.stores.velocity.x[this.playerEid] = vx * scale;
      this.world.stores.velocity.y[this.playerEid] = vy * scale;
    }

    private keepEnemyStationary(): void {
      if (this.enemyEid < 0) return;
      const enemies = query(this.world.ecs, [Enemy]);
      if (!enemies.includes(this.enemyEid)) return;
      this.world.stores.velocity.x[this.enemyEid] = 0;
      this.world.stores.velocity.y[this.enemyEid] = 0;
    }

    private handleEnemyRespawn(): void {
      const enemies = query(this.world.ecs, [Enemy]);
      if (enemies.length === 0) {
        this.respawnTimer += GAME.DELTA_MS;
        if (this.respawnTimer >= settings.respawnDelayMs) {
          this.spawnTargetEnemy();
          this.respawnTimer = 0;
        }
      } else {
        this.respawnTimer = 0;
        const eid = enemies[0]!;
        if (this.world.stores.health.max[eid] !== settings.enemyHp) {
          setComponent(this.world.ecs, eid, Health, {
            current: this.world.stores.health.current[eid] ?? settings.enemyHp,
            max: settings.enemyHp,
          });
        }
      }
    }

    private spawnTargetEnemy(): void {
      const cx = this.getSimWidth() / 2;
      const cy = this.getSimHeight() / 2 - 60;
      this.enemyEid = spawnEnemy(this.world, cx, cy, settings.enemyHp);
    }

    private resetWorld(): void {
      this.accumulator = 0;
      this.respawnTimer = 0;
      this.world = createGameWorld({ seed: LAB_SEED });
      this.playerEid = spawnPlayer(
        this.world,
        this.getSimWidth() / 2,
        this.getSimHeight() / 2 + 60,
      );
      this.spawnTargetEnemy();
      this.applyActiveWeapon();
      this.bridge?.sync(this.world);
    }

    private getSimWidth(): number {
      return Math.max(1, Math.round(this.scale.width || this.cameras.main.width || GAME.WIDTH));
    }

    private getSimHeight(): number {
      return Math.max(1, Math.round(this.scale.height || this.cameras.main.height || GAME.HEIGHT));
    }

    private updateHud(): void {
      const enemies = query(this.world.ecs, [Enemy]);
      const enemyHp = enemies.length > 0 ? (this.world.stores.health.current[enemies[0]!] ?? 0) : 0;
      const def = WEAPON_DEFS.get(settings.activeWeapon);
      const goreEvents = this.world.combatEvents.filter(
        (e) => e.type === 'hit' || e.type === 'death',
      ).length;

      hud.textContent = [
        `Weapon: ${def?.name ?? settings.activeWeapon}`,
        `Enemy HP: ${enemyHp.toFixed(0)} / ${settings.enemyHp}`,
        `Gore Events: ${goreEvents}`,
        `Intensity: ${settings.intensity.toFixed(1)}x`,
      ].join('\n');
    }
  }

  // GUI controls
  gui
    .add(settings, 'activeWeapon', WEAPON_IDS)
    .name('Weapon')
    .onChange(() => {});
  gui.add(settings, 'intensity', 0, 3, 0.1).name('Gore Intensity');
  gui.add(settings, 'hitGoreEnabled').name('Hit Gore');
  gui.add(settings, 'enemyHp', 5, 200, 1).name('Enemy HP');
  gui.add(settings, 'respawnDelayMs', 200, 5000, 100).name('Respawn Delay (ms)');

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
    backgroundColor: '#120714',
    scene: [GoreLabScene],
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

registerLab('gore-lab', {
  category: 'Combat' as LabCategory,
  name: 'Gore Lab',
  description:
    'Stationary enemy target with live gore VFX. Tune intensity, weapon type, and enemy HP to see blood splatter effects.',
  create: createGoreLab,
});
