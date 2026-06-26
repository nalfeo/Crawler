import { hasComponent, query, removeEntity } from 'bitecs';
import GUI from 'lil-gui';
import Phaser from 'phaser';
import { Enemy, Health, Owner, Spawner } from '../../core/components.js';
import {
  clearEntityStores,
  collisionSystem,
  createGameWorld,
  damageSystem,
  deathTimerSystem,
  dropSystem,
  healthSystem,
  knockbackSystem,
  movementSystem,
  playerInputSystem,
  projectileCleanupSystem,
  spawnPlayer,
  spawnSpawner,
  type GameWorld,
} from '../../core/index.js';
import { createInputCapture } from '../../engine/InputCapture.js';
import { createPhaserBridge } from '../../engine/PhaserBridge.js';
import {
  enemyAISystem,
  getSpawnerArchetype,
  getSpawnerArchetypeIndex,
  spawnerSystem,
} from '../../game/index.js';
import { GAME } from '../../shared/constants.js';
import { createInputState, type InputState } from '../../shared/input.js';
import { registerLab, type LabCategory } from '../registry.js';

const LAB_ID = 'spawner-lab';
const MAX_STEPS_PER_FRAME = 4;
const PLAYER_HEALTH = 5_000;
const POKE_DAMAGE = 15;

const RATS_NEST = getSpawnerArchetype('rats-nest')!;
const SLIME_POOL = getSpawnerArchetype('slime-pool')!;
const RATS_NEST_INDEX = getSpawnerArchetypeIndex('rats-nest');
const SLIME_POOL_INDEX = getSpawnerArchetypeIndex('slime-pool');

function createSpawnerLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as HTMLElement & { __labGui?: GUI }).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const root = document.createElement('div');
  root.style.position = 'relative';
  root.style.width = '100%';
  root.style.height = '100%';
  root.style.overflow = 'hidden';
  root.style.background = 'radial-gradient(circle at top, #201018 0%, #0d0a12 60%, #05060b 100%)';

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
    'Move with WASD / arrow keys. Two spawners are placed: a Rats Nest (left) and a Slime Pool (right). They trickle mobs passively. "Poke" a nest to enrage it (faster, harder), or "Destroy" it to trigger its on-death finale (Rat King/Queen, Mama/Papa Slime).';
  hint.style.marginTop = '16px';
  hint.style.color = '#e7d2ff';
  hint.style.lineHeight = '1.6';

  controls.append(hint);
  root.append(gameHost, info);
  canvasHost.append(root);

  let pokeNests = (_archetypeIndex?: number) => undefined as void;
  let destroyNests = (_archetypeIndex?: number) => undefined as void;
  let respawnNests = () => undefined as void;
  let clearMobs = () => undefined as void;
  let resetScene = () => undefined as void;

  class SpawnerLabScene extends Phaser.Scene {
    private accumulator = 0;
    private bridge?: ReturnType<typeof createPhaserBridge>;
    private inputCapture?: ReturnType<typeof createInputCapture>;
    private inputState!: InputState;
    private playerEid = -1;
    private world!: GameWorld;

    constructor() {
      super({ key: 'SpawnerLabScene' });
    }

    create(): void {
      this.cameras.main.setBackgroundColor('#0a0810');
      this.accumulator = 0;
      this.world = createGameWorld({ seed: 1990 });
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

      this.playerEid = spawnPlayer(this.world, this.viewportW() / 2, this.viewportH() / 2);
      this.world.stores.health.current[this.playerEid] = PLAYER_HEALTH;
      this.world.stores.health.max[this.playerEid] = PLAYER_HEALTH;

      this.placeNests();

      this.bridge = createPhaserBridge(this);
      this.bridge.sync(this.world);
      this.updateInfo();

      pokeNests = (archetypeIndex?: number) => this.pokeNests(archetypeIndex);
      destroyNests = (archetypeIndex?: number) => this.destroyNests(archetypeIndex);
      respawnNests = () => {
        this.clearAllEnemies();
        this.placeNests();
        this.bridge?.sync(this.world);
        this.updateInfo();
      };
      clearMobs = () => {
        this.clearChildMobs();
        this.bridge?.sync(this.world);
        this.updateInfo();
      };
      resetScene = () => this.scene.restart();

      this.events.once('shutdown', () => {
        pokeNests = () => undefined;
        destroyNests = () => undefined;
        respawnNests = () => undefined;
        clearMobs = () => undefined;
        resetScene = () => undefined;
        this.inputCapture?.destroy();
        this.inputCapture = undefined;
        this.bridge?.destroy();
        this.bridge = undefined;
      });
    }

    update(_time: number, delta: number): void {
      if (!this.bridge || !this.inputCapture) return;

      this.inputCapture.poll(this.inputState);
      this.accumulator += delta;
      let steps = 0;

      while (this.accumulator >= GAME.DELTA_MS && steps < MAX_STEPS_PER_FRAME) {
        if (this.world.state !== 'playing') break;

        this.world.frameCount += 1;
        this.world.elapsedMs += GAME.DELTA_MS;

        playerInputSystem(this.world, this.inputState);
        enemyAISystem(this.world);
        spawnerSystem(this.world);
        movementSystem(this.world);
        const collisions = collisionSystem(this.world);
        damageSystem(this.world, collisions);
        knockbackSystem(this.world);
        dropSystem(this.world);
        deathTimerSystem(this.world);
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

    private placeNests(): void {
      const cy = this.viewportH() / 2;
      spawnSpawner(this.world, this.viewportW() * 0.28, cy, RATS_NEST.hp, {
        defIndex: RATS_NEST_INDEX,
        contactDamage: RATS_NEST.contactDamage,
        bloodColor: RATS_NEST.bloodColor,
        spriteWidth: RATS_NEST.spriteWidth,
        spriteHeight: RATS_NEST.spriteHeight,
      });
      spawnSpawner(this.world, this.viewportW() * 0.72, cy, SLIME_POOL.hp, {
        defIndex: SLIME_POOL_INDEX,
        contactDamage: SLIME_POOL.contactDamage,
        bloodColor: SLIME_POOL.bloodColor,
        spriteWidth: SLIME_POOL.spriteWidth,
        spriteHeight: SLIME_POOL.spriteHeight,
      });
    }

    private pokeNests(archetypeIndex?: number): void {
      for (const eid of query(this.world.ecs, [Spawner, Health])) {
        if (
          archetypeIndex !== undefined &&
          this.world.stores.spawner.defIndex[eid] !== archetypeIndex
        ) {
          continue;
        }
        const hp = this.world.stores.health.current[eid] ?? 0;
        this.world.stores.health.current[eid] = Math.max(1, hp - POKE_DAMAGE);
      }
      this.updateInfo();
    }

    private destroyNests(archetypeIndex?: number): void {
      for (const eid of query(this.world.ecs, [Spawner, Health])) {
        if (
          archetypeIndex !== undefined &&
          this.world.stores.spawner.defIndex[eid] !== archetypeIndex
        ) {
          continue;
        }
        this.world.stores.health.current[eid] = 0;
      }
      this.updateInfo();
    }

    private clearChildMobs(): void {
      for (const eid of Array.from(query(this.world.ecs, [Enemy]))) {
        if (hasComponent(this.world.ecs, eid, Spawner)) continue;
        clearEntityStores(this.world, eid);
        removeEntity(this.world.ecs, eid);
      }
    }

    private clearAllEnemies(): void {
      for (const eid of Array.from(query(this.world.ecs, [Enemy]))) {
        clearEntityStores(this.world, eid);
        removeEntity(this.world.ecs, eid);
      }
    }

    private viewportW(): number {
      return Math.max(1, Math.round(this.scale.width || this.cameras.main.width || GAME.WIDTH));
    }

    private viewportH(): number {
      return Math.max(1, Math.round(this.scale.height || this.cameras.main.height || GAME.HEIGHT));
    }

    private updateInfo(): void {
      const lines: string[] = [];
      const playerHp =
        this.playerEid >= 0 ? (this.world.stores.health.current[this.playerEid] ?? 0) : 0;
      lines.push(`Player HP: ${playerHp.toFixed(0)}  State: ${this.world.state}`);

      const spawners = query(this.world.ecs, [Spawner, Health]);
      for (const eid of spawners) {
        const defIndex = this.world.stores.spawner.defIndex[eid] ?? 0;
        const def = defIndex === RATS_NEST_INDEX ? RATS_NEST : SLIME_POOL;
        const hp = this.world.stores.health.current[eid] ?? 0;
        const mode = (this.world.stores.spawner.mode[eid] ?? 0) === 1 ? 'DEFENSIVE' : 'passive';
        const total = this.world.stores.spawner.spawnedTotal[eid] ?? 0;
        let alive = 0;
        for (const child of query(this.world.ecs, [Enemy, Owner])) {
          if (
            this.world.stores.owner.eid[child] === eid &&
            (this.world.stores.health.current[child] ?? 0) > 0
          ) {
            alive += 1;
          }
        }
        lines.push(
          `${def.name}: HP ${hp.toFixed(0)}/${def.hp}  mode ${mode}  alive ${alive}  total ${total}`,
        );
      }
      if (spawners.length === 0) {
        lines.push('No spawners — use "Respawn nests".');
      }

      info.textContent = lines.join('\n');
    }
  }

  const api = {
    pokeRatsNest: () => pokeNests(RATS_NEST_INDEX),
    pokeSlimePool: () => pokeNests(SLIME_POOL_INDEX),
    destroyRatsNest: () => destroyNests(RATS_NEST_INDEX),
    destroySlimePool: () => destroyNests(SLIME_POOL_INDEX),
    respawnNests: () => respawnNests(),
    clearMobs: () => clearMobs(),
    reset: () => resetScene(),
  };

  gui.add(api, 'pokeRatsNest').name('Poke Rats Nest (enrage)');
  gui.add(api, 'pokeSlimePool').name('Poke Slime Pool (enrage)');
  gui.add(api, 'destroyRatsNest').name('Destroy Rats Nest (finale)');
  gui.add(api, 'destroySlimePool').name('Destroy Slime Pool (finale)');
  gui.add(api, 'clearMobs').name('Clear spawned mobs');
  gui.add(api, 'respawnNests').name('Respawn nests');
  gui.add(api, 'reset').name('Reset');

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
    backgroundColor: '#0a0810',
    scene: [SpawnerLabScene],
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

registerLab(LAB_ID, {
  category: 'Entities' as LabCategory,
  name: 'Spawner Lab',
  description:
    'Watch the generic Spawner mob-type: Rats Nest and Slime Pool trickle mobs passively, enrage when poked, and burst a boss finale on death.',
  create: createSpawnerLab,
});
