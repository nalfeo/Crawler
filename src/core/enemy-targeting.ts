import { hasComponent } from 'bitecs';
import { Enemy, Team } from './components.js';
import type { GameWorld } from './world.js';
import { TeamId } from '../shared/constants.js';

export function isPlayerTeamEnemy(world: GameWorld, enemyEid: number): boolean {
  return (
    hasComponent(world.ecs, enemyEid, Enemy) &&
    hasComponent(world.ecs, enemyEid, Team) &&
    (world.stores.team.id[enemyEid] ?? 0) === TeamId.PLAYER
  );
}

export function isEnemyHostileToPlayer(world: GameWorld, enemyEid: number): boolean {
  return hasComponent(world.ecs, enemyEid, Enemy) && !isPlayerTeamEnemy(world, enemyEid);
}
