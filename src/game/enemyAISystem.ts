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

/**
 * Maximum allowed overlap fraction between enemy entities (0.25 = 25%).
 * When two enemies overlap beyond this threshold, a separation force is applied.
 */
const MAX_OVERLAP_FRACTION = 0.25;
const SEPARATION_FORCE = 2.0;
const ENEMY_RADIUS = 8; // half of 16x16 sprite

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
  const speed = world.stores.enemyBehavior.speed[eid]!;
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
  const enemyX = position.x[eid]!;
  const enemyY = position.y[eid]!;
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

    const otherX = position.x[other]!;
    const otherY = position.y[other]!;
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
  const cooldown = enemyBehavior.fireCooldownMs[eid]!;
  const effectiveCooldown = cooldown > 0 ? cooldown : ENEMY_PROJECTILE.FIRE_COOLDOWN_MS;
  const lastFire = enemyBehavior.lastFireMs[eid]!;

  // lastFireMs=0 means "never fired" — allow immediate first shot
  if (lastFire > 0 && world.elapsedMs - lastFire < effectiveCooldown) {
    return;
  }

  const direction = normalize(toPlayerX, toPlayerY);
  if (direction.length <= EPSILON) {
    return;
  }

  const enemyX = position.x[eid]!;
  const enemyY = position.y[eid]!;
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
  _aggroRange: number,
  attackRange: number,
  speed: number,
): void {

  if (attackRange <= EPSILON) {
    const direction = normalize(playerDx, playerDy);
    setVelocity(world, eid, direction.x * speed, direction.y * speed);
    return;
  }

  const retreatDistance = attackRange * 0.5;
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

/**
 * Post-process separation pass: pushes enemies apart when they exceed
 * the MAX_OVERLAP_FRACTION threshold. Uses a simple pairwise distance check
 * and blends a repulsion vector into the existing velocity.
 */
function applySeparation(
  world: GameWorld,
  enemyList: number[],
  position: GameWorld['stores']['position'],
  velocity: GameWorld['stores']['velocity'],
): void {
  const minDistance = ENEMY_RADIUS * 2 * (1 - MAX_OVERLAP_FRACTION); // 12px for 25% overlap

  for (let i = 0; i < enemyList.length; i += 1) {
    const a = enemyList[i]!;
    const ax = position.x[a]!;
    const ay = position.y[a]!;

    for (let j = i + 1; j < enemyList.length; j += 1) {
      const b = enemyList[j]!;
      const bx = position.x[b]!;
      const by = position.y[b]!;

      const dx = ax - bx;
      const dy = ay - by;
      const dist = Math.hypot(dx, dy);

      if (dist >= minDistance || dist <= EPSILON) {
        continue;
      }

      // Penetration depth as fraction of overlap beyond allowed threshold
      const penetration = (minDistance - dist) / minDistance;
      const force = penetration * SEPARATION_FORCE;
      const nx = dx / dist;
      const ny = dy / dist;

      // Push each entity in opposite directions
      velocity.x[a] = (velocity.x[a] ?? 0) + nx * force;
      velocity.y[a] = (velocity.y[a] ?? 0) + ny * force;
      velocity.x[b] = (velocity.x[b] ?? 0) - nx * force;
      velocity.y[b] = (velocity.y[b] ?? 0) - ny * force;
    }
  }

  // Write updated velocities back to ECS
  for (const eid of enemyList) {
    setComponent(world.ecs, eid, Velocity, {
      x: velocity.x[eid] ?? 0,
      y: velocity.y[eid] ?? 0,
    });
  }
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

  const { enemyBehavior, position, velocity } = world.stores;
  const enemyList = Array.from(enemies);
  const playerX = position.x[playerEid]!;
  const playerY = position.y[playerEid]!;
  const swarmEntities = enemyList.filter(
    (eid) => enemyBehavior.type[eid] === AI_TYPE.SWARM,
  );

  for (const eid of enemies) {
    const enemyX = position.x[eid]!;
    const enemyY = position.y[eid]!;
    const playerDx = playerX - enemyX;
    const playerDy = playerY - enemyY;
    const distanceToPlayer = Math.hypot(playerDx, playerDy);
    const behaviorType = enemyBehavior.type[eid]!;
    const aggroRange = enemyBehavior.aggroRange[eid]!;
    const attackRange = enemyBehavior.attackRange[eid]!;
    const speed = getEnemySpeed(world, eid);

    switch (behaviorType) {
      case AI_TYPE.SWARM:
        applySwarmBehavior(
          world,
          eid,
          swarmEntities,
          playerDx,
          playerDy,
          distanceToPlayer,
          aggroRange,
          speed,
        );
        break;
      case AI_TYPE.RANGED:
        applyRangedBehavior(
          world,
          eid,
          playerDx,
          playerDy,
          distanceToPlayer,
          aggroRange,
          attackRange,
          speed,
        );
        break;
      case AI_TYPE.CHASE:
      default:
        applyChaseBehavior(world, eid, playerDx, playerDy, distanceToPlayer, aggroRange, speed);
        break;
    }
  }

  // Enforce max 25% overlap between all enemy pairs via separation forces
  applySeparation(world, enemyList, position, velocity);
}
