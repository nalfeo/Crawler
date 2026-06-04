import { hasComponent, query, setComponent } from 'bitecs';
import { Enemy, EnemyBehavior, Player, Position, Velocity } from '../core/components.js';
import { spawnEnemy } from '../core/helpers.js';
import type { GameWorld } from '../core/world.js';
import { GAME } from '../shared/constants.js';

export interface SpawnerConfig {
  maxEnemies: number;
  spawnIntervalMs: number;
  enemyHp: number;
  enemySpeed: number;
}

export interface SpawnerBounds {
  width: number;
  height: number;
}

interface SpawnerState {
  lastSpawnMs: number;
}

const spawnerStates = new WeakMap<GameWorld, SpawnerState>();
const spawnerBounds = new WeakMap<GameWorld, SpawnerBounds>();

function getSpawnerState(world: GameWorld): SpawnerState {
  let state = spawnerStates.get(world);

  if (state === undefined) {
    state = { lastSpawnMs: Number.NEGATIVE_INFINITY };
    spawnerStates.set(world, state);
  }

  return state;
}

function getSpawnerBounds(world: GameWorld): SpawnerBounds {
  return spawnerBounds.get(world) ?? { width: GAME.WIDTH, height: GAME.HEIGHT };
}

function getPlayerEntity(world: GameWorld): number | undefined {
  const players = query(world.ecs, [Player, Position]);
  return players[0];
}

function setVelocityTowardPlayer(
  world: GameWorld,
  enemy: number,
  targetX: number,
  targetY: number,
  enemySpeed: number,
): void {
  const enemyX = world.stores.position.x[enemy] ?? 0;
  const enemyY = world.stores.position.y[enemy] ?? 0;
  const deltaX = targetX - enemyX;
  const deltaY = targetY - enemyY;
  const distance = Math.hypot(deltaX, deltaY);

  if (distance <= 0.0001) {
    setComponent(world.ecs, enemy, Velocity, { x: 0, y: 0 });
    return;
  }

  setComponent(world.ecs, enemy, Velocity, {
    x: (deltaX / distance) * enemySpeed,
    y: (deltaY / distance) * enemySpeed,
  });
}

function getRandomEdgePosition(world: GameWorld): { x: number; y: number } {
  const { width, height } = getSpawnerBounds(world);
  const edge = world.rng.nextInt(0, 3);

  switch (edge) {
    case 0:
      return { x: world.rng.next() * width, y: 0 };
    case 1:
      return { x: width, y: world.rng.next() * height };
    case 2:
      return { x: world.rng.next() * width, y: height };
    default:
      return { x: 0, y: world.rng.next() * height };
  }
}

export function configureEnemySpawner(world: GameWorld, bounds: SpawnerBounds): void {
  spawnerBounds.set(world, {
    width: Math.max(1, bounds.width),
    height: Math.max(1, bounds.height),
  });
}

export function enemySpawnerSystem(world: GameWorld, config: SpawnerConfig): void {
  const player = getPlayerEntity(world);

  if (player === undefined) {
    return;
  }

  const playerX = world.stores.position.x[player] ?? 0;
  const playerY = world.stores.position.y[player] ?? 0;
  const enemies = query(world.ecs, [Enemy, Position, Velocity]);

  for (const enemy of enemies) {
    if (enemy === undefined) {
      continue;
    }

    // Skip enemies with AI behavior — they're steered by enemyAISystem
    if (hasComponent(world.ecs, enemy, EnemyBehavior)) {
      continue;
    }

    setVelocityTowardPlayer(world, enemy, playerX, playerY, config.enemySpeed);
  }

  if (enemies.length >= config.maxEnemies) {
    return;
  }

  const state = getSpawnerState(world);

  if (world.elapsedMs - state.lastSpawnMs < config.spawnIntervalMs) {
    return;
  }

  const spawnPoint = getRandomEdgePosition(world);
  const enemy = spawnEnemy(world, spawnPoint.x, spawnPoint.y, config.enemyHp);
  setVelocityTowardPlayer(world, enemy, playerX, playerY, config.enemySpeed);
  state.lastSpawnMs = world.elapsedMs;
}
