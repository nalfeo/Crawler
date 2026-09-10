import { hasComponent } from 'bitecs';
import { Companion, Enemy, Team } from './components.js';
import type { GameWorld } from './world.js';
import { TeamId } from '../shared/constants.js';

function isPlayerTeamEnemy(world: GameWorld, enemyEid: number): boolean {
  return (
    hasComponent(world.ecs, enemyEid, Enemy) &&
    hasComponent(world.ecs, enemyEid, Team) &&
    (world.stores.team.id[enemyEid] ?? 0) === TeamId.PLAYER
  );
}

export function isEnemyHostileToPlayer(world: GameWorld, enemyEid: number): boolean {
  if (!hasComponent(world.ecs, enemyEid, Enemy) || isPlayerTeamEnemy(world, enemyEid)) {
    return false;
  }
  if (isFloor3WildEnemy(world, enemyEid)) {
    return isFloor3WildEnemyHostile(world, enemyEid);
  }
  return true;
}

export function isFloor3WildEnemy(world: GameWorld, enemyEid: number): boolean {
  return (
    world.floorId === 'floor3' &&
    hasComponent(world.ecs, enemyEid, Enemy) &&
    !hasComponent(world.ecs, enemyEid, Companion) &&
    hasComponent(world.ecs, enemyEid, Team) &&
    (world.stores.team.id[enemyEid] ?? 0) === TeamId.ENEMY
  );
}

export function isFloor3WildEnemyHostile(world: GameWorld, enemyEid: number): boolean {
  return world.floorExtendedState?.floor3HostileWildEnemyEids?.has(enemyEid) === true;
}
