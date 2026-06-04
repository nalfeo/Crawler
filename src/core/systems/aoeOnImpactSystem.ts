import { entityExists, hasComponent, query } from 'bitecs';
import { AoeOnImpact, Owner, Position, Team } from '../components.js';
import { spawnAreaAttack } from '../helpers.js';
import type { GameWorld } from '../world.js';

interface AoeSnapshot {
  eid: number;
  x: number;
  y: number;
  radius: number;
  damage: number;
  ownerEid: number;
  teamId: number;
}

const trackedSnapshots = new WeakMap<GameWorld, AoeSnapshot[]>();

function getSnapshots(world: GameWorld): AoeSnapshot[] {
  let arr = trackedSnapshots.get(world);
  if (arr === undefined) {
    arr = [];
    trackedSnapshots.set(world, arr);
  }
  return arr;
}

/** Call before damageSystem to snapshot current AoE projectile data. */
export function aoeOnImpactPreDamage(world: GameWorld): void {
  const snapshots = getSnapshots(world);
  snapshots.length = 0;

  const entities = query(world.ecs, [AoeOnImpact, Position]);
  const { position, aoeOnImpact, owner, team } = world.stores;

  for (const eid of entities) {
    if (eid === undefined) continue;

    snapshots.push({
      eid,
      x: position.x[eid] ?? 0,
      y: position.y[eid] ?? 0,
      radius: aoeOnImpact.radius[eid] ?? 0,
      damage: aoeOnImpact.damage[eid] ?? 0,
      ownerEid: hasComponent(world.ecs, eid, Owner) ? (owner.eid[eid] ?? 0) : -1,
      teamId: hasComponent(world.ecs, eid, Team) ? (team.id[eid] ?? 0) : 0,
    });
  }
}

/** Call after damageSystem to spawn explosions for destroyed AoE projectiles. */
export function aoeOnImpactPostDamage(world: GameWorld): void {
  const snapshots = getSnapshots(world);

  for (const snap of snapshots) {
    if (entityExists(world.ecs, snap.eid)) {
      continue; // still alive, no explosion yet
    }

    if (snap.radius > 0) {
      spawnAreaAttack(world, snap.x, snap.y, snap.ownerEid, snap.damage, snap.radius, 50, snap.teamId);
    }
  }

  snapshots.length = 0;
}
