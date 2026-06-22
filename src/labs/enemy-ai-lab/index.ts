import { hasComponent, query, removeEntity, setComponent } from 'bitecs';
import GUI from 'lil-gui';
import Phaser from 'phaser';
import { Enemy, EnemyBehavior, Health, Player, Position, Sprite } from '../../core/components.js';
import {
  clearEntityStores,
  collisionSystem,
  createGameWorld,
  damageSystem,
  healthSystem,
  movementSystem,
  playerInputSystem,
  projectileCleanupSystem,
  spawnBehaviorEnemy,
  spawnPlayer,
  type GameWorld,
} from '../../core/index.js';
import { createInputCapture } from '../../engine/InputCapture.js';
import { createPhaserBridge } from '../../engine/PhaserBridge.js';
import { AI_TYPE, enemyAISystem } from '../../game/index.js';
import { GAME } from '../../shared/constants.js';
import { createInputState, type InputState } from '../../shared/input.js';
import { registerLab, type LabCategory } from '../registry.js';
import { loadLabState, saveLabState } from '../lab-persistence.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

interface EnemyAiLabSettings {
  chaseSpeed: number;
  swarmSpeed: number;
  rangedSpeed: number;
  leaperSpeed: number;
  aggroRange: number;
  attackRange: number;
}

const GROUP_OFFSET = 220;
const GROUP_RADIUS = 84;
const MAX_STEPS_PER_FRAME = 4;
const PLAYER_HEALTH = 1_000;
const SWARM_RADIUS = 56;
const LAB_ID = 'enemy-ai-lab';
const COLLISION_EPSILON = 0.0001;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function createEnemyAiLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const root = document.createElement('div');
  root.style.position = 'relative';
  root.style.width = '100%';
  root.style.height = '100%';
  root.style.overflow = 'hidden';
  root.style.background = 'radial-gradient(circle at top, #1c1028 0%, #0d0a17 60%, #05060b 100%)';

  const gameHost = document.createElement('div');
  gameHost.style.width = '100%';
  gameHost.style.height = '100%';

  const info = document.createElement('div');
  info.style.position = 'absolute';
  info.style.left = '16px';
  info.style.bottom = '16px';
  info.style.padding = '10px 12px';
  info.style.borderRadius = '12px';
  info.style.background = 'rgba(12, 10, 20, 0.82)';
  info.style.border = '1px solid rgba(255, 255, 255, 0.12)';
  info.style.color = '#f8fafc';
  info.style.lineHeight = '1.5';
  info.style.whiteSpace = 'pre-line';
  info.style.pointerEvents = 'none';

  const hint = document.createElement('p');
  hint.textContent =
    'Move with WASD or arrow keys. Spawn chasers, swarmers, ranged, and leapers (slimes) to compare their movement live. Keep moving near a leaper to watch it pounce, miss, and freeze.';
  hint.style.marginTop = '16px';
  hint.style.color = '#d7d2ff';
  hint.style.lineHeight = '1.6';

  controls.append(hint);
  root.append(gameHost, info);
  canvasHost.append(root);

  const settings: EnemyAiLabSettings = {
    chaseSpeed: 1.8,
    swarmSpeed: 1.4,
    rangedSpeed: 1.1,
    leaperSpeed: 1.5,
    aggroRange: 260,
    attackRange: 180,
    ...(loadLabState<EnemyAiLabSettings>(LAB_ID) ?? {}),
  };

  let spawnChasersFromGui = () => undefined;
  let spawnSwarmFromGui = () => undefined;
  let spawnRangedFromGui = () => undefined;
  let spawnLeapersFromGui = () => undefined;
  let clearEnemiesFromGui = () => undefined;
  let resetFromGui = () => undefined;
  let syncSettingsFromGui = () => undefined;

  class EnemyAiLabScene extends Phaser.Scene {
    private accumulator = 0;

    private bridge?: ReturnType<typeof createPhaserBridge>;

    private inputCapture?: ReturnType<typeof createInputCapture>;

    private inputState!: InputState;

    private playerEid = -1;

    private world!: GameWorld;

    constructor() {
      super({ key: 'EnemyAiLabScene' });
    }

    create(): void {
      this.cameras.main.setBackgroundColor('#080910');
      this.accumulator = 0;
      this.world = createGameWorld({ seed: 2027 });
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
      this.playerEid = spawnPlayer(
        this.world,
        this.getViewportWidth() / 2,
        this.getViewportHeight() / 2,
      );
      setComponent(this.world.ecs, this.playerEid, Health, {
        current: PLAYER_HEALTH,
        max: PLAYER_HEALTH,
      });
      this.spawnGroup(AI_TYPE.CHASE, 5);
      this.spawnGroup(AI_TYPE.SWARM, 10);
      this.spawnGroup(AI_TYPE.RANGED, 5);
      this.spawnGroup(AI_TYPE.LEAPER, 4);

      this.bridge = createPhaserBridge(this);
      this.bridge.sync(this.world);
      this.updateInfo();

      spawnChasersFromGui = () => {
        this.spawnGroup(AI_TYPE.CHASE, 5);
      };
      spawnSwarmFromGui = () => {
        this.spawnGroup(AI_TYPE.SWARM, 10);
      };
      spawnRangedFromGui = () => {
        this.spawnGroup(AI_TYPE.RANGED, 5);
      };
      spawnLeapersFromGui = () => {
        this.spawnGroup(AI_TYPE.LEAPER, 4);
      };
      clearEnemiesFromGui = () => {
        this.clearEnemies();
      };
      resetFromGui = () => {
        this.scene.restart();
      };
      syncSettingsFromGui = () => {
        this.syncEnemySettings();
      };

      const handleResize = () => {
        this.updateInfo();
      };

      this.scale.on('resize', handleResize);
      this.events.once('shutdown', () => {
        spawnChasersFromGui = () => undefined;
        spawnSwarmFromGui = () => undefined;
        spawnRangedFromGui = () => undefined;
        spawnLeapersFromGui = () => undefined;
        clearEnemiesFromGui = () => undefined;
        resetFromGui = () => undefined;
        syncSettingsFromGui = () => undefined;

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

      this.inputCapture.poll(this.inputState);
      this.accumulator += delta;
      let steps = 0;

      while (this.accumulator >= GAME.DELTA_MS && steps < MAX_STEPS_PER_FRAME) {
        if (this.world.state !== 'playing') {
          break;
        }

        this.world.frameCount += 1;
        this.world.elapsedMs += GAME.DELTA_MS;

        playerInputSystem(this.world, this.inputState);
        enemyAISystem(this.world);
        movementSystem(this.world);
        const collisions = collisionSystem(this.world);
        this.resolveEnemyCollisions(collisions.pairs);
        damageSystem(this.world, collisions);
        healthSystem(this.world);
        projectileCleanupSystem(this.world);

        this.accumulator -= GAME.DELTA_MS;
        steps += 1;
      }

      if (this.accumulator > GAME.DELTA_MS * MAX_STEPS_PER_FRAME) {
        this.accumulator = 0;
      }

      this.bridge.sync(this.world);
      this.updateInfo();
    }

    private resolveEnemyCollisions(pairs: Array<{ a: number; b: number }>): void {
      const { position, sprite } = this.world.stores;

      for (const pair of pairs) {
        const { a, b } = pair;
        const aIsEnemy = hasComponent(this.world.ecs, a, Enemy);
        const bIsEnemy = hasComponent(this.world.ecs, b, Enemy);
        const aIsPlayer = hasComponent(this.world.ecs, a, Player);
        const bIsPlayer = hasComponent(this.world.ecs, b, Player);
        const isEnemyVsEnemy = aIsEnemy && bIsEnemy;
        const isEnemyVsPlayer = (aIsEnemy && bIsPlayer) || (bIsEnemy && aIsPlayer);

        if (!isEnemyVsEnemy && !isEnemyVsPlayer) {
          continue;
        }

        if (
          !hasComponent(this.world.ecs, a, Position) ||
          !hasComponent(this.world.ecs, b, Position) ||
          !hasComponent(this.world.ecs, a, Sprite) ||
          !hasComponent(this.world.ecs, b, Sprite)
        ) {
          continue;
        }

        const ax = position.x[a]!;
        const ay = position.y[a]!;
        const bx = position.x[b]!;
        const by = position.y[b]!;
        const halfWidthA = sprite.width[a]! * 0.5;
        const halfHeightA = sprite.height[a]! * 0.5;
        const halfWidthB = sprite.width[b]! * 0.5;
        const halfHeightB = sprite.height[b]! * 0.5;
        const dx = bx - ax;
        const dy = by - ay;
        // collisionSystem only returns pair IDs, so this lab recomputes overlap depth
        // to apply a small local separation response for visual feedback.
        const overlapX = halfWidthA + halfWidthB - Math.abs(dx);
        const overlapY = halfHeightA + halfHeightB - Math.abs(dy);

        if (overlapX <= 0 || overlapY <= 0) {
          continue;
        }

        const resolveAlongX = overlapX <= overlapY;
        const axisDelta = resolveAlongX ? dx : dy;
        // When centers are exactly aligned on the resolution axis, use a stable ID-based
        // tie-breaker so separation stays deterministic and avoids frame-to-frame jitter.
        const axisSign = axisDelta !== 0 ? Math.sign(axisDelta) : a < b ? 1 : -1;
        const pushDistance = (resolveAlongX ? overlapX : overlapY) + COLLISION_EPSILON;

        // Keep player movement authoritative in this lab: only push enemies out of player overlap.
        // For enemy-vs-enemy overlap, split correction evenly so both agents react.
        if (isEnemyVsPlayer) {
          const enemyEid = aIsEnemy ? a : b;
          const enemyDirection = enemyEid === a ? -axisSign : axisSign;
          if (resolveAlongX) {
            position.x[enemyEid]! += enemyDirection * pushDistance;
          } else {
            position.y[enemyEid]! += enemyDirection * pushDistance;
          }
          continue;
        }

        const pushA = -axisSign * pushDistance * 0.5;
        const pushB = axisSign * pushDistance * 0.5;

        if (resolveAlongX) {
          position.x[a] = ax + pushA;
          position.x[b] = bx + pushB;
        } else {
          position.y[a] = ay + pushA;
          position.y[b] = by + pushB;
        }
      }
    }

    private clearEnemies(): void {
      for (const eid of Array.from(query(this.world.ecs, [Enemy]))) {
        clearEntityStores(this.world, eid);
        removeEntity(this.world.ecs, eid);
      }

      this.bridge?.sync(this.world);
      this.updateInfo();
    }

    private getGroupAnchor(type: number): { x: number; y: number } {
      const centerX = this.getViewportWidth() / 2;
      const centerY = this.getViewportHeight() / 2;

      switch (type) {
        case AI_TYPE.SWARM:
          return { x: centerX, y: centerY - GROUP_OFFSET };
        case AI_TYPE.RANGED:
          return { x: centerX + GROUP_OFFSET, y: centerY };
        case AI_TYPE.LEAPER:
          return { x: centerX, y: centerY + GROUP_OFFSET };
        case AI_TYPE.CHASE:
        default:
          return { x: centerX - GROUP_OFFSET, y: centerY };
      }
    }

    private getSpeedForType(type: number): number {
      switch (type) {
        case AI_TYPE.SWARM:
          return settings.swarmSpeed;
        case AI_TYPE.RANGED:
          return settings.rangedSpeed;
        case AI_TYPE.LEAPER:
          return settings.leaperSpeed;
        case AI_TYPE.CHASE:
        default:
          return settings.chaseSpeed;
      }
    }

    private getViewportHeight(): number {
      return Math.max(1, Math.round(this.scale.height || this.cameras.main.height || GAME.HEIGHT));
    }

    private getViewportWidth(): number {
      return Math.max(1, Math.round(this.scale.width || this.cameras.main.width || GAME.WIDTH));
    }

    private spawnGroup(type: number, count: number): void {
      const anchor = this.getGroupAnchor(type);
      const radius = type === AI_TYPE.SWARM ? SWARM_RADIUS : GROUP_RADIUS;
      const speed = this.getSpeedForType(type);
      const hp = type === AI_TYPE.RANGED ? 18 : 24;
      const maxX = this.getViewportWidth() - 24;
      const maxY = this.getViewportHeight() - 24;

      for (let index = 0; index < count; index += 1) {
        const angle = ((Math.PI * 2) / Math.max(1, count)) * index;
        const jitter = (this.world.rng.next() - 0.5) * 0.75;
        const distance = radius * (0.45 + this.world.rng.next() * 0.55);
        const x = clamp(anchor.x + Math.cos(angle + jitter) * distance, 24, maxX);
        const y = clamp(anchor.y + Math.sin(angle + jitter) * distance, 24, maxY);

        spawnBehaviorEnemy(
          this.world,
          x,
          y,
          hp,
          type,
          speed,
          settings.aggroRange,
          settings.attackRange,
        );
      }

      this.bridge?.sync(this.world);
      this.updateInfo();
    }

    private syncEnemySettings(): void {
      for (const eid of query(this.world.ecs, [Enemy, EnemyBehavior])) {
        const behaviorType = this.world.stores.enemyBehavior.type[eid] ?? AI_TYPE.CHASE;
        setComponent(this.world.ecs, eid, EnemyBehavior, {
          type: behaviorType,
          speed: this.getSpeedForType(behaviorType),
          aggroRange: settings.aggroRange,
          attackRange: settings.attackRange,
        });
      }

      this.updateInfo();
    }

    private updateInfo(): void {
      let chasers = 0;
      let swarmers = 0;
      let ranged = 0;
      let leapers = 0;

      for (const eid of query(this.world.ecs, [Enemy, EnemyBehavior])) {
        const behaviorType = this.world.stores.enemyBehavior.type[eid] ?? AI_TYPE.CHASE;

        if (behaviorType === AI_TYPE.SWARM) {
          swarmers += 1;
        } else if (behaviorType === AI_TYPE.RANGED) {
          ranged += 1;
        } else if (behaviorType === AI_TYPE.LEAPER) {
          leapers += 1;
        } else {
          chasers += 1;
        }
      }

      const playerHealth =
        this.playerEid >= 0 ? (this.world.stores.health.current[this.playerEid] ?? 0) : 0;

      info.textContent = [
        `Player HP: ${playerHealth.toFixed(0)}  State: ${this.world.state}`,
        `Chasers: ${chasers}  Swarm: ${swarmers}  Ranged: ${ranged}  Leapers: ${leapers}`,
        `Aggro: ${settings.aggroRange.toFixed(0)}  Attack: ${settings.attackRange.toFixed(0)}`,
        `Speeds → Chase ${settings.chaseSpeed.toFixed(1)} | Swarm ${settings.swarmSpeed.toFixed(1)} | Ranged ${settings.rangedSpeed.toFixed(1)} | Leaper ${settings.leaperSpeed.toFixed(1)}`,
      ].join('\n');
    }
  }

  const controlsApi = {
    spawnChasers: () => {
      spawnChasersFromGui();
    },
    spawnSwarm: () => {
      spawnSwarmFromGui();
    },
    spawnRanged: () => {
      spawnRangedFromGui();
    },
    spawnLeapers: () => {
      spawnLeapersFromGui();
    },
    clearEnemies: () => {
      clearEnemiesFromGui();
    },
    reset: () => {
      resetFromGui();
    },
  };

  gui.add(controlsApi, 'spawnChasers').name('Spawn Chasers (5)');
  gui.add(controlsApi, 'spawnSwarm').name('Spawn Swarm (10)');
  gui.add(controlsApi, 'spawnRanged').name('Spawn Ranged (5)');
  gui.add(controlsApi, 'spawnLeapers').name('Spawn Leapers (4)');
  gui
    .add(settings, 'chaseSpeed', 0.5, 5, 0.1)
    .name('Chase Speed')
    .onChange(() => syncSettingsFromGui());
  gui
    .add(settings, 'swarmSpeed', 0.5, 5, 0.1)
    .name('Swarm Speed')
    .onChange(() => syncSettingsFromGui());
  gui
    .add(settings, 'rangedSpeed', 0.5, 3, 0.1)
    .name('Ranged Speed')
    .onChange(() => syncSettingsFromGui());
  gui
    .add(settings, 'leaperSpeed', 0.5, 3, 0.1)
    .name('Leaper Speed')
    .onChange(() => syncSettingsFromGui());
  gui
    .add(settings, 'aggroRange', 50, 400, 5)
    .name('Aggro Range')
    .onChange(() => syncSettingsFromGui());
  gui
    .add(settings, 'attackRange', 100, 300, 5)
    .name('Attack Range')
    .onChange(() => syncSettingsFromGui());
  gui.add(controlsApi, 'clearEnemies').name('Clear Enemies');
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
    backgroundColor: '#080910',
    scene: [EnemyAiLabScene],
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

registerLab('enemy-ai-lab', {
  category: 'Entities' as LabCategory,
  name: 'Enemy AI Lab',
  description:
    'Compare chase, swarm, and ranged enemy behaviors with live spawn and tuning controls.',
  create: createEnemyAiLab,
});
