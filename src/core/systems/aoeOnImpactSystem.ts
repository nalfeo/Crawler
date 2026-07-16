import { entityExists, hasComponent, query } from 'bitecs';
import { AoeOnImpact, Owner, Position, Team } from '../components.js';
import { spawnAreaAttack } from '../helpers.js';
import { isEntityInSafeSpace } from '../safe-space.js';
import type { GameWorld } from '../world.js';
import { getActivationForEntity, withActivationId } from '../weapon-telemetry.js';
import { readDamageMeta, tagDamageMeta, type PersistedDamageMeta } from '../damage-meta.js';

interface AoeSnapshot {
  eid: number;
  x: number;
  y: number;
  radius: number;
  damage: number;
  ownerEid: number;
  teamId: number;
  /**
   * Weapon-telemetry activation id of the source projectile, captured while it
   * still exists so the explosion folds into the SAME cast (a fireball = one
   * activation). `undefined` when telemetry is disabled or the projectile was
   * untagged (e.g. an enemy AoE projectile).
   */
  activationId: number | undefined;
  skillIds: { classSkillId: string; typeSkillId: string } | undefined;
  /**
   * The source projectile's persisted damage-scaling metadata, captured
   * before it's destroyed (`clearEntityStores` zeroes its store slot) so the
   * spawned explosion can propagate the SAME origin/affinity/scaling/crit
   * eligibility (e.g. a magic weapon's AoE-on-impact splash stays magic).
   */
  damageMeta: PersistedDamageMeta;
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

    const ownerEid = hasComponent(world.ecs, eid, Owner) ? (owner.eid[eid] ?? 0) : -1;
    snapshots.push({
      eid,
      x: position.x[eid] ?? 0,
      y: position.y[eid] ?? 0,
      radius: aoeOnImpact.radius[eid] ?? 0,
      damage: aoeOnImpact.damage[eid] ?? 0,
      ownerEid,
      teamId: hasComponent(world.ecs, eid, Team) ? (team.id[eid] ?? 0) : 0,
      activationId: getActivationForEntity(world, eid),
      skillIds:
        world.attackWeaponSkillsByEntity.get(eid) ??
        (ownerEid >= 0 ? world.attackerWeaponSkills.get(ownerEid) : undefined),
      damageMeta: readDamageMeta(world, eid),
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
    if (snap.ownerEid >= 0 && isEntityInSafeSpace(world, snap.ownerEid)) {
      continue;
    }

    if (snap.radius > 0) {
      // Fold the explosion into the source projectile's cast so a fireball stays
      // a single weapon-telemetry activation (no-op wrapper when telemetry off).
      withActivationId(world, snap.activationId, () => {
        const explosionEid = spawnAreaAttack(
          world,
          snap.x,
          snap.y,
          snap.ownerEid,
          snap.damage,
          snap.radius,
          50,
          snap.teamId,
        );
        tagDamageMeta(world, explosionEid, snap.damageMeta);
        if (snap.skillIds !== undefined) {
          world.attackWeaponSkillsByEntity.set(explosionEid, snap.skillIds);
        }
      });
    }
  }

  snapshots.length = 0;
}
