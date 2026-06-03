import { query, setComponent } from 'bitecs';
import { Enemy, EnemyBehavior, Player, Position, Velocity } from '../core/components.js';
import { spawnEnemyProjectile } from '../core/helpers.js';
import type { GameWorld } from '../core/world.js';
import { ENEMY_PROJECTILE } from '../shared/constants.js';

export const AI_TYPE = { CHASE: 0, SWARM: 1, RANGED: 2 } as const;

const DEFAULT_ENEMY_SPEED = 1.5;
const EPSILON = 0.0001;
const SWARM_NEIGHBOR_RADIUS = 30;
const SWARM_PLAYER_WEIGHT = 1;
const SWARM_SEPARATION_WEIGHT = 1.4;
const SWARM_COHESION_WEIGHT = 0.2;

function setVelocity(world: GameWorld, eid: number, x: number, y: number): void {
  setComponent(world.ecs, eid, Velocity, { x, y });
}

function normalize(x: number, y: number): { x: number; y: number; length: number } {
  const length = Math.hypot(x, y);
  if (length <= EPSILON) {
    return { x: 0, y: 0, length: 0 };
  }

  return { x: x / length, y: y / length, length };
}

function getEnemySpeed(world: GameWorld, eid: number): number {
  const speed = world.stores.enemyBehavior.speed[eid] ?? 0;
  return speed > 0 ? speed : DEFAULT_ENEMY_SPEED;
}

function isAggroActive(aggroRange: number, distanceToPlayer: number): boolean {
  return aggroRange <= 0 || distanceToPlayer <= aggroRange;
}

function applyChaseBehavior(
  world: GameWorld,
  eid: number,
  playerDx: number,
  playerDy: number,
  distanceToPlayer: number,
  aggroRange: number,
  speed: number,
): void {
  if (!isAggroActive(aggroRange, distanceToPlayer)) {
    setVelocity(world, eid, 0, 0);
    return;
  }

  const direction = normalize(playerDx, playerDy);
  setVelocity(world, eid, direction.x * speed, direction.y * speed);
}

function applySwarmBehavior(
  world: GameWorld,
  eid: number,
  swarmEntities: number[],
  playerDx: number,
  playerDy: number,
  distanceToPlayer: number,
  aggroRange: number,
  speed: number,
): void {
  if (!isAggroActive(aggroRange, distanceToPlayer)) {
    setVelocity(world, eid, 0, 0);
    return;
  }

  const { position } = world.stores;
  const enemyX = position.x[eid] ?? 0;
  const enemyY = position.y[eid] ?? 0;
  const toPlayer = normalize(playerDx, playerDy);
  let separationX = 0;
  let separationY = 0;
  let cohesionX = 0;
  let cohesionY = 0;
  let neighborCount = 0;

  for (const other of swarmEntities) {
    if (other === eid) {
      continue;
    }

    const otherX = position.x[other] ?? 0;
    const otherY = position.y[other] ?? 0;
    const offsetX = enemyX - otherX;
    const offsetY = enemyY - otherY;
    const distance = Math.hypot(offsetX, offsetY);

    if (distance <= EPSILON || distance > SWARM_NEIGHBOR_RADIUS) {
      continue;
    }

    const weight = (SWARM_NEIGHBOR_RADIUS - distance) / SWARM_NEIGHBOR_RADIUS;
    separationX += (offsetX / distance) * weight;
    separationY += (offsetY / distance) * weight;
    cohesionX += otherX;
    cohesionY += otherY;
    neighborCount += 1;
  }

  let steerX = toPlayer.x * SWARM_PLAYER_WEIGHT;
  let steerY = toPlayer.y * SWARM_PLAYER_WEIGHT;

  if (neighborCount > 0) {
    steerX += separationX * SWARM_SEPARATION_WEIGHT;
    steerY += separationY * SWARM_SEPARATION_WEIGHT;

    const localCenterX = cohesionX / neighborCount;
    const localCenterY = cohesionY / neighborCount;
    const cohesion = normalize(localCenterX - enemyX, localCenterY - enemyY);
    steerX += cohesion.x * SWARM_COHESION_WEIGHT;
    steerY += cohesion.y * SWARM_COHESION_WEIGHT;
  }

  const direction = normalize(steerX, steerY);
  setVelocity(world, eid, direction.x * speed, direction.y * speed);
}

function tryFireEnemyProjectile(
  world: GameWorld,
  eid: number,
  toPlayerX: number,
  toPlayerY: number,
): void {
  const { enemyBehavior, position } = world.stores;
  const cooldown = enemyBehavior.fireCooldownMs[eid] ?? 0;
  const effectiveCooldown = cooldown > 0 ? cooldown : ENEMY_PROJECTILE.FIRE_COOLDOWN_MS;
  const lastFire = enemyBehavior.lastFireMs[eid] ?? 0;

  // lastFireMs=0 means "never fired" — allow immediate first shot
  if (lastFire > 0 && (world.elapsedMs - lastFire) < effectiveCooldown) {
    return;
  }

  const direction = normalize(toPlayerX, toPlayerY);
  if (direction.length <= EPSILON) {
    return;
  }

  const enemyX = position.x[eid] ?? 0;
  const enemyY = position.y[eid] ?? 0;
  const spawnX = enemyX + direction.x * ENEMY_PROJECTILE.MUZZLE_OFFSET;
  const spawnY = enemyY + direction.y * ENEMY_PROJECTILE.MUZZLE_OFFSET;

  spawnEnemyProjectile(
    world,
    spawnX,
    spawnY,
    direction.x * ENEMY_PROJECTILE.SPEED,
    direction.y * ENEMY_PROJECTILE.SPEED,
    ENEMY_PROJECTILE.DAMAGE,
  );

  enemyBehavior.lastFireMs[eid] = world.elapsedMs;
}

function applyRangedBehavior(
  world: GameWorld,
  eid: number,
  playerDx: number,
  playerDy: number,
  distanceToPlayer: number,
  aggroRange: number,
  attackRange: number,
  speed: number,
): void {
  if (!isAggroActive(aggroRange, distanceToPlayer) && distanceToPlayer > attackRange) {
    setVelocity(world, eid, 0, 0);
    return;
  }

  if (attackRange <= EPSILON) {
    applyChaseBehavior(world, eid, playerDx, playerDy, distanceToPlayer, aggroRange, speed);
    return;
  }

  const retreatDistance = Math.min(attackRange, Math.max(0, aggroRange * 0.5));
  const toPlayer = normalize(playerDx, playerDy);

  if (distanceToPlayer > attackRange) {
    setVelocity(world, eid, toPlayer.x * speed, toPlayer.y * speed);
    return;
  }

  // Within attack range — fire at the player
  tryFireEnemyProjectile(world, eid, playerDx, playerDy);

  if (distanceToPlayer < retreatDistance && distanceToPlayer > EPSILON) {
    setVelocity(world, eid, -toPlayer.x * speed, -toPlayer.y * speed);
    return;
  }

  const tangentX = -toPlayer.y;
  const tangentY = toPlayer.x;
  const tangent = normalize(tangentX, tangentY);
  setVelocity(world, eid, tangent.x * speed, tangent.y * speed);
}

export function enemyAISystem(world: GameWorld): void {
  const enemies = query(world.ecs, [Enemy, EnemyBehavior, Position, Velocity]);
  const players = query(world.ecs, [Player, Position]);
  const playerEid = players[0];

  if (playerEid === undefined) {
    for (const eid of enemies) {
      setVelocity(world, eid, 0, 0);
    }
    return;
  }

  const { enemyBehavior, position } = world.stores;
  const playerX = position.x[playerEid] ?? 0;
  const playerY = position.y[playerEid] ?? 0;
  const swarmEntities = Array.from(enemies).filter((eid) => enemyBehavior.type[eid] === AI_TYPE.SWARM);

  for (const eid of enemies) {
    const enemyX = position.x[eid] ?? 0;
    const enemyY = position.y[eid] ?? 0;
    const playerDx = playerX - enemyX;
    const playerDy = playerY - enemyY;
    const distanceToPlayer = Math.hypot(playerDx, playerDy);
    const behaviorType = enemyBehavior.type[eid] ?? AI_TYPE.CHASE;
    const aggroRange = enemyBehavior.aggroRange[eid] ?? 0;
    const attackRange = enemyBehavior.attackRange[eid] ?? 0;
    const speed = getEnemySpeed(world, eid);

    switch (behaviorType) {
      case AI_TYPE.SWARM:
        applySwarmBehavior(world, eid, swarmEntities, playerDx, playerDy, distanceToPlayer, aggroRange, speed);
        break;
      case AI_TYPE.RANGED:
        applyRangedBehavior(world, eid, playerDx, playerDy, distanceToPlayer, aggroRange, attackRange, speed);
        break;
      case AI_TYPE.CHASE:
      default:
        applyChaseBehavior(world, eid, playerDx, playerDy, distanceToPlayer, aggroRange, speed);
        break;
    }
  }
}
