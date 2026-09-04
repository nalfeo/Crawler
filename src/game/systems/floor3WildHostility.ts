import { hasComponent, query, setComponent } from 'bitecs';
import { DeathTimer, Enemy, Health, Player, Position } from '../../core/components.js';
import { isFloor3WildEnemy, isFloor3WildEnemyHostile } from '../../core/enemy-targeting.js';
import type { GameWorld } from '../../core/world.js';
import tuning from '../../shared/data/tuning.json';

export const FLOOR3_WILD_AGGRO_RANGE_FT = tuning.floor3Companion.wildAggroRangeFt;
const FLOOR3_WILD_DISENGAGE_RANGE_FT = FLOOR3_WILD_AGGRO_RANGE_FT * 2;
const lastUpdatedFrameByWorld = new WeakMap<GameWorld, number>();

function resolveHostileWilds(world: GameWorld): Set<number> {
  let hostileWilds = world.floorExtendedState?.floor3HostileWildEnemyEids;
  if (!hostileWilds) {
    hostileWilds = new Set<number>();
    world.floorExtendedState = {
      ...world.floorExtendedState,
      floor3HostileWildEnemyEids: hostileWilds,
    };
  }
  return hostileWilds;
}

export function updateFloor3WildHostility(world: GameWorld): void {
  if (world.floorId !== 'floor3') return;
  if (lastUpdatedFrameByWorld.get(world) === world.frameCount) return;
  const player = query(world.ecs, [Player, Position])[0];
  if (player === undefined) return;
  lastUpdatedFrameByWorld.set(world, world.frameCount);

  const playerX = world.stores.position.x[player] ?? 0;
  const playerY = world.stores.position.y[player] ?? 0;
  const aggroRangeSq = FLOOR3_WILD_AGGRO_RANGE_FT * FLOOR3_WILD_AGGRO_RANGE_FT;
  const disengageRangeSq = FLOOR3_WILD_DISENGAGE_RANGE_FT * FLOOR3_WILD_DISENGAGE_RANGE_FT;
  const hostileWilds = resolveHostileWilds(world);
  const liveWilds = new Set<number>();

  for (const eid of query(world.ecs, [Enemy, Position])) {
    if (!isFloor3WildEnemy(world, eid)) continue;
    liveWilds.add(eid);
    if (hasComponent(world.ecs, eid, DeathTimer)) {
      hostileWilds.delete(eid);
      continue;
    }
    const dx = playerX - (world.stores.position.x[eid] ?? 0);
    const dy = playerY - (world.stores.position.y[eid] ?? 0);
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq <= aggroRangeSq) {
      hostileWilds.add(eid);
      continue;
    }
    if (isFloor3WildEnemyHostile(world, eid) && distanceSq > disengageRangeSq) {
      hostileWilds.delete(eid);
      if (hasComponent(world.ecs, eid, Health)) {
        setComponent(world.ecs, eid, Health, {
          current: world.stores.health.max[eid] ?? world.stores.health.current[eid] ?? 0,
        });
      }
    }
  }
  for (const eid of hostileWilds) {
    if (!liveWilds.has(eid)) hostileWilds.delete(eid);
  }
}
