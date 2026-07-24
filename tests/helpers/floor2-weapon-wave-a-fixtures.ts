import { query } from 'bitecs';
import { expect } from 'vitest';
import {
  AoeOnImpact,
  Bouncing,
  Damage,
  LineDamage,
  MeleeSwing,
  Projectile,
  Returning,
  Trap,
} from '../../src/core/components.js';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { generateEquipmentInstance } from '../../src/game/generated-equipment-generator.js';
import { setActiveWeapon, weaponSystem } from '../../src/game/weaponSystem.js';
import { WeaponType } from '../../src/shared/constants.js';
import type { Floor2WeaponBaseDefinition } from '../../src/shared/data/floor2-weapon-bases.js';
import type { ActiveWeaponSnapshotV1 } from '../../src/shared/generated-equipment-types.js';
import { createTestWorld } from './world-factory.js';

/**
 * Shared fixtures for spawning a generated Floor 2 Wave A weapon instance,
 * running it through `weaponSystem`, and asserting the resulting attack
 * entity shape.
 *
 * Consumed by:
 * - tests/unit/floor2-weapon-wave-a.test.ts, which routes every one of the
 *   25 frozen bases through `weaponSystem` alone (single-system coverage).
 * - tests/integration/floor2-weapon-wave-a-pipeline.test.ts, which drives a
 *   representative weapon per attack kind through the full downstream
 *   combat pipeline (collision/damage/AoE/movement/returning/beam/trap).
 */

export type ExpectedAttackKind =
  | 'melee'
  | 'projectile'
  | 'bouncing-projectile'
  | 'returning-projectile'
  | 'aoe-projectile'
  | 'beam'
  | 'trap';

export interface GeneratedWeaponFixture {
  readonly world: ReturnType<typeof createTestWorld>;
  readonly enemy: number | null;
  readonly snapshot: ActiveWeaponSnapshotV1;
  readonly attackKind: ExpectedAttackKind;
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled attack kind ${String(value)}`);
}

export function expectedAttackKind(definition: Floor2WeaponBaseDefinition): ExpectedAttackKind {
  const { weaponDef } = definition;
  switch (weaponDef.weaponType) {
    case WeaponType.MELEE:
      return 'melee';
    case WeaponType.RANGED:
      return weaponDef.bounceCount > 0 ? 'bouncing-projectile' : 'projectile';
    case WeaponType.MAGIC:
      return 'aoe-projectile';
    case WeaponType.THROWN:
      if (weaponDef.returnSpeed > 0 && weaponDef.maxRange > 0) {
        return 'returning-projectile';
      }
      return weaponDef.bounceCount > 0 ? 'bouncing-projectile' : 'projectile';
    case WeaponType.BEAM:
      return 'beam';
    case WeaponType.TRAP:
      return 'trap';
    default:
      throw new Error(`Unhandled weapon type for ${weaponDef.id}`);
  }
}

export function spawnGeneratedWeaponFixture(
  definition: Floor2WeaponBaseDefinition,
  opts: { enemy?: boolean } = {},
): GeneratedWeaponFixture {
  const attackKind = expectedAttackKind(definition);
  const withEnemy = opts.enemy ?? attackKind !== 'trap';
  const world = createTestWorld({
    seed: 42,
    generatedEquipmentRunKey: `wave-a-pipeline-${definition.weaponDef.id}`,
  });
  spawnPlayer(world, 0, 0);
  const enemy = withEnemy ? spawnEnemy(world, attackKind === 'melee' ? 1.25 : 6.25, 0, 200) : null;
  const generated = generateEquipmentInstance(world, {
    baseId: definition.stableId,
    itemLevel: 6,
    rarity: 'common',
    enhancementLevel: 1,
  });
  const snapshot = generated.frozen.activeWeaponSnapshot;
  if (!snapshot) {
    throw new Error(`Expected active weapon snapshot for ${definition.stableId}`);
  }
  world.rng.next = () => 0;
  setActiveWeapon(world, snapshot);
  world.elapsedMs = snapshot.cooldownMs;
  weaponSystem(world);
  return { world, enemy, snapshot, attackKind };
}

export function expectSpawnedAttack(
  world: GeneratedWeaponFixture['world'],
  attackKind: ExpectedAttackKind,
  snapshot: ActiveWeaponSnapshotV1,
): number {
  switch (attackKind) {
    case 'melee': {
      const attacks = Array.from(query(world.ecs, [MeleeSwing]));
      expect(attacks).toHaveLength(1);
      return attacks[0]!;
    }
    case 'projectile': {
      const attacks = Array.from(query(world.ecs, [Projectile, Damage]));
      expect(attacks).toHaveLength(1);
      expect(Array.from(query(world.ecs, [Bouncing]))).toHaveLength(0);
      expect(Array.from(query(world.ecs, [Returning]))).toHaveLength(0);
      expect(Array.from(query(world.ecs, [AoeOnImpact]))).toHaveLength(0);
      const attack = attacks[0]!;
      expect(world.stores.damage.amount[attack]).toBe(snapshot.baseDamage);
      return attack;
    }
    case 'bouncing-projectile': {
      const attacks = Array.from(query(world.ecs, [Projectile, Bouncing, Damage]));
      expect(attacks).toHaveLength(1);
      const attack = attacks[0]!;
      expect(world.stores.damage.amount[attack]).toBe(snapshot.baseDamage);
      expect(world.stores.bouncing.remainingBounces[attack]).toBe(snapshot.bounceCount);
      return attack;
    }
    case 'returning-projectile': {
      const attacks = Array.from(query(world.ecs, [Projectile, Returning, Damage]));
      expect(attacks).toHaveLength(1);
      const attack = attacks[0]!;
      expect(world.stores.damage.amount[attack]).toBe(snapshot.baseDamage);
      expect(world.stores.returning.returnSpeed[attack]).toBe(snapshot.returnSpeed);
      expect(world.stores.returning.maxRange[attack]).toBe(snapshot.maxRange);
      return attack;
    }
    case 'aoe-projectile': {
      const attacks = Array.from(query(world.ecs, [Projectile, AoeOnImpact, Damage]));
      expect(attacks).toHaveLength(1);
      const attack = attacks[0]!;
      expect(world.stores.damage.amount[attack]).toBe(snapshot.baseDamage);
      expect(world.stores.aoeOnImpact.radius[attack]).toBe(snapshot.aoeRadius);
      expect(world.stores.aoeOnImpact.damage[attack]).toBe(snapshot.baseDamage);
      return attack;
    }
    case 'beam': {
      const attacks = Array.from(query(world.ecs, [LineDamage]));
      expect(attacks).toHaveLength(1);
      const attack = attacks[0]!;
      expect(world.stores.lineDamage.damage[attack]).toBe(snapshot.baseDamage);
      expect(world.stores.lineDamage.length[attack]).toBe(snapshot.beamLength);
      expect(world.stores.lineDamage.tickMs[attack]).toBe(snapshot.beamTickMs);
      return attack;
    }
    case 'trap': {
      const attacks = Array.from(query(world.ecs, [Trap]));
      expect(attacks).toHaveLength(1);
      const attack = attacks[0]!;
      expect(world.stores.trap.triggerRadius[attack]).toBe(snapshot.trapTriggerRadius);
      expect(world.stores.trap.explosionRadius[attack]).toBe(snapshot.trapExplosionRadius);
      expect(world.stores.trap.armAtMs[attack]).toBe(world.elapsedMs + snapshot.trapArmMs);
      return attack;
    }
    default:
      return assertNever(attackKind);
  }
}
