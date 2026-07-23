import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { AreaDamage } from '../../src/core/components.js';
import { spawnEnemy } from '../../src/core/helpers.js';
import {
  aoeOnImpactPostDamage,
  aoeOnImpactPreDamage,
} from '../../src/core/systems/aoeOnImpactSystem.js';
import { areaDamageSystem } from '../../src/core/systems/areaDamageSystem.js';
import { beamSystem } from '../../src/core/systems/beamSystem.js';
import { collisionSystem } from '../../src/core/systems/collisionSystem.js';
import { damageSystem } from '../../src/core/systems/damageSystem.js';
import { meleeSwingSystem } from '../../src/core/systems/meleeSwingSystem.js';
import { movementSystem } from '../../src/core/systems/movementSystem.js';
import { returningProjectileSystem } from '../../src/core/systems/returningProjectileSystem.js';
import { trapSystem } from '../../src/core/systems/trapSystem.js';
import { GAME } from '../../src/shared/constants.js';
import {
  FLOOR2_WEAPON_WAVE_A_BASES,
  type Floor2WeaponBaseDefinition,
} from '../../src/shared/data/floor2-weapon-bases.js';
import {
  assertNever,
  expectSpawnedAttack,
  spawnGeneratedWeaponFixture,
} from '../helpers/floor2-weapon-wave-a-fixtures.js';

/**
 * Drives a representative Floor 2 Wave A weapon per attack kind through the
 * full downstream combat pipeline: weaponSystem spawns the attack, then
 * collision/damage/AoE/movement/returning/beam/trap systems resolve it into
 * enemy damage. This exercises multiple production systems together, so it
 * lives under tests/integration rather than tests/unit.
 *
 * See tests/unit/floor2-weapon-wave-a.test.ts for the catalog-shape checks
 * and the single-system (weaponSystem-only) routing coverage across all 25
 * frozen bases.
 */

const REPRESENTATIVE_PIPELINE_BASE_IDS = [
  'weapon.iron-cleaver',
  'weapon.ashwood-bow',
  'weapon.storm-sling',
  'weapon.ember-wand',
  'weapon.throwing-knives',
  'weapon.twin-katar',
  'weapon.alchemist-sprayer',
  'weapon.sawblade-launcher',
] as const;

function getWaveABase(stableId: string): Floor2WeaponBaseDefinition {
  const definition = FLOOR2_WEAPON_WAVE_A_BASES.find((entry) => entry.stableId === stableId);
  if (!definition) {
    throw new Error(`Missing Floor 2 wave A base: ${stableId}`);
  }
  return definition;
}

function expectRepresentativeDamagePipeline(definition: Floor2WeaponBaseDefinition): void {
  const fixture = spawnGeneratedWeaponFixture(definition);
  const attack = expectSpawnedAttack(fixture.world, fixture.attackKind, fixture.snapshot);

  switch (fixture.attackKind) {
    case 'melee': {
      const initialHp = fixture.world.stores.health.current[fixture.enemy!]!;
      const collision = collisionSystem(fixture.world);
      meleeSwingSystem(fixture.world, collision);
      expect(fixture.world.stores.health.current[fixture.enemy!]!).toBeLessThan(initialHp);
      return;
    }
    case 'projectile':
    case 'bouncing-projectile': {
      const initialHp = fixture.world.stores.health.current[fixture.enemy!]!;
      fixture.world.stores.position.x[attack] = fixture.world.stores.position.x[fixture.enemy!]!;
      fixture.world.stores.position.y[attack] = fixture.world.stores.position.y[fixture.enemy!]!;
      const collision = collisionSystem(fixture.world);
      damageSystem(fixture.world, collision);
      expect(fixture.world.stores.health.current[fixture.enemy!]!).toBeLessThan(initialHp);
      return;
    }
    case 'aoe-projectile': {
      const initialHp = fixture.world.stores.health.current[fixture.enemy!]!;
      fixture.world.stores.position.x[attack] = fixture.world.stores.position.x[fixture.enemy!]!;
      fixture.world.stores.position.y[attack] = fixture.world.stores.position.y[fixture.enemy!]!;
      let collision = collisionSystem(fixture.world);
      aoeOnImpactPreDamage(fixture.world);
      damageSystem(fixture.world, collision);
      aoeOnImpactPostDamage(fixture.world);
      expect(Array.from(query(fixture.world.ecs, [AreaDamage])).length).toBeGreaterThanOrEqual(1);
      collision = collisionSystem(fixture.world);
      areaDamageSystem(fixture.world, collision);
      expect(fixture.world.stores.health.current[fixture.enemy!]!).toBeLessThan(initialHp);
      return;
    }
    case 'returning-projectile': {
      for (
        let step = 0;
        step < 200 && (fixture.world.stores.returning.isReturning[attack] ?? 0) === 0;
        step += 1
      ) {
        fixture.world.elapsedMs += GAME.DELTA_MS;
        movementSystem(fixture.world);
        returningProjectileSystem(fixture.world);
      }
      expect(fixture.world.stores.returning.isReturning[attack]).toBe(1);
      const inboundEnemy = spawnEnemy(fixture.world, 1.25, 0, 200);
      const initialHp = fixture.world.stores.health.current[inboundEnemy]!;
      fixture.world.stores.position.x[attack] = fixture.world.stores.position.x[inboundEnemy]!;
      fixture.world.stores.position.y[attack] = fixture.world.stores.position.y[inboundEnemy]!;
      const collision = collisionSystem(fixture.world);
      damageSystem(fixture.world, collision);
      expect(fixture.world.stores.health.current[inboundEnemy]!).toBeLessThan(initialHp);
      return;
    }
    case 'beam': {
      const initialHp = fixture.world.stores.health.current[fixture.enemy!]!;
      beamSystem(fixture.world);
      expect(fixture.world.stores.health.current[fixture.enemy!]!).toBeLessThan(initialHp);
      return;
    }
    case 'trap': {
      fixture.world.elapsedMs += fixture.snapshot.trapArmMs + 1;
      const trapEnemy = spawnEnemy(fixture.world, 0.625, 0, 200);
      const initialHp = fixture.world.stores.health.current[trapEnemy]!;
      let collision = collisionSystem(fixture.world);
      trapSystem(fixture.world, collision);
      expect(Array.from(query(fixture.world.ecs, [AreaDamage])).length).toBeGreaterThanOrEqual(1);
      collision = collisionSystem(fixture.world);
      areaDamageSystem(fixture.world, collision);
      expect(fixture.world.stores.health.current[trapEnemy]!).toBeLessThan(initialHp);
      return;
    }
    default:
      return assertNever(fixture.attackKind);
  }
}

describe('Floor 2 weapon content wave A downstream combat pipelines', () => {
  it('realizes deterministic damage through representative downstream combat pipelines', () => {
    for (const stableId of REPRESENTATIVE_PIPELINE_BASE_IDS) {
      expectRepresentativeDamagePipeline(getWaveABase(stableId));
    }
  });
});
