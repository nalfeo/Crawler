import { hasComponent, query, setComponent } from 'bitecs';
import { Enemy, EnemyBehavior, Player, Position, Velocity } from '../core/components.js';
import { spawnEnemy } from '../core/helpers.js';
import type { GameWorld } from '../core/world.js';
import { ARENA } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';

const logger = createLogger('game:enemy-spawner');

const ENEMY_RADIUS = 1; // half of the default 2×2 ft enemy sprite
const MAX_OVERLAP_FRACTION = 0.25;
const SEPARATION_FORCE = 0.25;
const EPSILON = 0.0001;

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
  return spawnerBounds.get(world) ?? { width: ARENA.WIDTH_FT, height: ARENA.HEIGHT_FT };
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

/**
 * Pushes simple (non-AI) enemies apart when they overlap more than
 * MAX_OVERLAP_FRACTION of their combined radius, mirroring the separation pass
 * in enemyAISystem for AI-steered enemies.
 */
function applySeparation(
  simpleEnemies: number[],
  position: GameWorld['stores']['position'],
  velocity: GameWorld['stores']['velocity'],
  enemySpeed: number,
): void {
  const minDistance = ENEMY_RADIUS * 2 * (1 - MAX_OVERLAP_FRACTION);

  for (let i = 0; i < simpleEnemies.length; i += 1) {
    const a = simpleEnemies[i]!;
    const ax = position.x[a] ?? 0;
    const ay = position.y[a] ?? 0;

    for (let j = i + 1; j < simpleEnemies.length; j += 1) {
      const b = simpleEnemies[j]!;
      const bx = position.x[b] ?? 0;
      const by = position.y[b] ?? 0;

      const dx = ax - bx;
      const dy = ay - by;
      const dist = Math.hypot(dx, dy);

      if (dist >= minDistance) {
        continue;
      }

      let nx: number;
      let ny: number;
      let penetration: number;

      if (dist <= EPSILON) {
        nx = a % 2 === 0 ? 1 : -1;
        ny = b % 2 === 0 ? 1 : -1;
        const len = Math.hypot(nx, ny);
        nx /= len;
        ny /= len;
        penetration = 1;
      } else {
        penetration = (minDistance - dist) / minDistance;
        nx = dx / dist;
        ny = dy / dist;
      }

      const force = penetration * SEPARATION_FORCE;
      velocity.x[a] = (velocity.x[a] ?? 0) + nx * force;
      velocity.y[a] = (velocity.y[a] ?? 0) + ny * force;
      velocity.x[b] = (velocity.x[b] ?? 0) - nx * force;
      velocity.y[b] = (velocity.y[b] ?? 0) - ny * force;
    }
  }

  // Clamp each enemy's velocity to its configured speed
  for (const eid of simpleEnemies) {
    const vx = velocity.x[eid] ?? 0;
    const vy = velocity.y[eid] ?? 0;
    const mag = Math.hypot(vx, vy);

    if (mag > enemySpeed && mag > EPSILON) {
      const scale = enemySpeed / mag;
      velocity.x[eid] = vx * scale;
      velocity.y[eid] = vy * scale;
    }
  }
}

export function configureEnemySpawner(world: GameWorld, bounds: SpawnerBounds): void {
  spawnerBounds.set(world, {
    width: Math.max(1, bounds.width),
    height: Math.max(1, bounds.height),
  });
  logger.info('Configured enemy spawner bounds', {
    width: Math.max(1, bounds.width),
    height: Math.max(1, bounds.height),
  });
}

export function enemySpawnerSystem(world: GameWorld, config: SpawnerConfig): void {
  const player = getPlayerEntity(world);

  if (player === undefined) {
    logger.warn('Enemy spawner skipped tick because player entity is missing');
    return;
  }

  const playerX = world.stores.position.x[player] ?? 0;
  const playerY = world.stores.position.y[player] ?? 0;
  const enemies = query(world.ecs, [Enemy, Position, Velocity]);
  const simpleEnemies: number[] = [];

  for (const enemy of enemies) {
    if (enemy === undefined) {
      continue;
    }

    // Skip enemies with AI behavior — they're steered by enemyAISystem
    if (hasComponent(world.ecs, enemy, EnemyBehavior)) {
      continue;
    }

    setVelocityTowardPlayer(world, enemy, playerX, playerY, config.enemySpeed);
    simpleEnemies.push(enemy);
  }

  // Apply separation to prevent simple enemies from stacking on each other
  applySeparation(simpleEnemies, world.stores.position, world.stores.velocity, config.enemySpeed);

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
  logger.debug('Spawned enemy', {
    enemy,
    x: spawnPoint.x,
    y: spawnPoint.y,
    enemyHp: config.enemyHp,
    elapsedMs: world.elapsedMs,
  });
}
