import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  AoeOnImpact,
  AreaDamage,
  Bouncing,
  Damage,
  LineDamage,
  MeleeSwing,
  Projectile,
  Returning,
  Trap,
} from '../../src/core/components.js';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
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
import { getEquippableItemIds } from '../../src/shared/equipmentDefs.js';
import {
  FLOOR2_WEAPON_WAVE_A_BASES,
  FLOOR2_WEAPON_WAVE_A_BASE_IDS,
  type Floor2WeaponBaseFamily,
  type Floor2WeaponBaseDefinition,
} from '../../src/shared/data/floor2-weapon-bases.js';
import { FLOOR2_EQUIPMENT_ART_DEFINITIONS } from '../../src/shared/data/floor2-equipment-art.js';
import {
  RARITY_EFFECT_BUDGET,
  type ActiveWeaponSnapshotV1,
} from '../../src/shared/generated-equipment-types.js';
import { GAME, WeaponType } from '../../src/shared/constants.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import {
  generateEquipmentInstance,
  getGeneratedEquipmentBaseV1,
} from '../../src/game/generated-equipment-generator.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { setActiveWeapon, weaponSystem } from '../../src/game/weaponSystem.js';

const EXPECTED_BASE_IDS = [
  'weapon.iron-cleaver',
  'weapon.bone-saw',
  'weapon.dueling-saber',
  'weapon.war-pick',
  'weapon.butcher-hook',
  'weapon.rune-axe',
  'weapon.chain-flail',
  'weapon.stone-maul',
  'weapon.sun-hammer',
  'weapon.quarterstaff',
  'weapon.blood-lance',
  'weapon.grave-shovel',
  'weapon.ashwood-bow',
  'weapon.hand-crossbow',
  'weapon.storm-sling',
  'weapon.musketeer-rifle',
  'weapon.cog-pistol',
  'weapon.throwing-knives',
  'weapon.twin-katar',
  'weapon.ember-wand',
  'weapon.frost-crook',
  'weapon.alchemist-sprayer',
  'weapon.thorn-whip',
  'weapon.sawblade-launcher',
  'weapon.oil-lantern',
] as const;

const EXPECTED_FAMILY_COUNTS: Readonly<Record<Floor2WeaponBaseFamily, number>> = {
  blade: 3,
  axe: 3,
  bludgeon: 3,
  polearm: 3,
  bow: 3,
  firearm: 2,
  thrown: 2,
  'magic-focus': 2,
  beam: 2,
  trap: 2,
};

type ExpectedAttackKind =
  | 'melee'
  | 'projectile'
  | 'bouncing-projectile'
  | 'returning-projectile'
  | 'aoe-projectile'
  | 'beam'
  | 'trap';

interface GeneratedWeaponFixture {
  readonly world: ReturnType<typeof createTestWorld>;
  readonly enemy: number | null;
  readonly snapshot: ActiveWeaponSnapshotV1;
  readonly attackKind: ExpectedAttackKind;
}

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

function assertNever(value: never): never {
  throw new Error(`Unhandled attack kind ${String(value)}`);
}

function getWaveABase(stableId: string): Floor2WeaponBaseDefinition {
  const definition = FLOOR2_WEAPON_WAVE_A_BASES.find((entry) => entry.stableId === stableId);
  if (!definition) {
    throw new Error(`Missing Floor 2 wave A base: ${stableId}`);
  }
  return definition;
}

function expectedAttackKind(definition: Floor2WeaponBaseDefinition): ExpectedAttackKind {
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

function spawnGeneratedWeaponFixture(
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

function expectSpawnedAttack(
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

describe('Floor 2 weapon content wave A', () => {
  it('freezes exactly 25 explicit bases across all ten canonical families', () => {
    expect(FLOOR2_WEAPON_WAVE_A_BASE_IDS).toEqual(EXPECTED_BASE_IDS);
    expect(FLOOR2_WEAPON_WAVE_A_BASES).toHaveLength(25);
    expect(Object.isFrozen(FLOOR2_WEAPON_WAVE_A_BASES)).toBe(true);
    expect(
      Object.fromEntries(
        Object.keys(EXPECTED_FAMILY_COUNTS).map((family) => [
          family,
          FLOOR2_WEAPON_WAVE_A_BASES.filter((definition) => definition.family === family).length,
        ]),
      ),
    ).toEqual(EXPECTED_FAMILY_COUNTS);
  });

  it('preserves the full 50-ID manifest with five entries per family', () => {
    const weapons = FLOOR2_EQUIPMENT_ART_DEFINITIONS.filter(
      (definition) => definition.category === 'weapon',
    );
    expect(weapons).toHaveLength(50);
    for (const family of Object.keys(EXPECTED_FAMILY_COUNTS)) {
      expect(weapons.filter((definition) => definition.family === family)).toHaveLength(5);
    }
  });

  it('normalizes stable base IDs without leaking generated-only bases into inventory items', () => {
    const inventoryEquipmentIds = new Set(getEquippableItemIds());
    for (const definition of FLOOR2_WEAPON_WAVE_A_BASES) {
      const generatedBase = getGeneratedEquipmentBaseV1(definition.stableId);
      expect(generatedBase).toMatchObject({
        baseId: definition.stableId,
        template: { kind: 'weapon', weaponDefId: definition.weaponDef.id },
        displayName: definition.weaponDef.name,
        artKey: definition.artKey,
        slots: definition.equipmentDef.slots,
        weightLb: definition.equipmentDef.weightLb,
      });
      expect(getWeaponDef(definition.weaponDef.id)).toBe(definition.weaponDef);
      expect(inventoryEquipmentIds.has(definition.stableId)).toBe(false);
      expect(definition.equipmentDef.rarity).toBe('common');
      expect(definition.equipmentDef.statBonuses).toEqual({});
    }

    expect(getGeneratedEquipmentBaseV1('plasma-pistol').artKey).toBe('plasma-pistol');
  });

  it('generates deterministic legal Common, Uncommon, and Rare instances for every base', () => {
    const rarities = ['common', 'uncommon', 'rare'] as const;
    for (const definition of FLOOR2_WEAPON_WAVE_A_BASES) {
      for (const rarity of rarities) {
        const request = {
          baseId: definition.stableId,
          itemLevel: 6,
          rarity,
          enhancementLevel: 1,
        } as const;
        const left = createTestWorld({
          seed: 42,
          generatedEquipmentRunKey: `wave-a-${definition.weaponDef.id}-${rarity}`,
        });
        const right = createTestWorld({
          seed: 42,
          generatedEquipmentRunKey: `wave-a-${definition.weaponDef.id}-${rarity}`,
        });
        const leftInstance = generateEquipmentInstance(left, request);
        const rightInstance = generateEquipmentInstance(right, request);
        const spentUnits = leftInstance.resolvedEffects.reduce(
          (sum, effect) => sum + ('unitCost' in effect ? effect.unitCost : 0),
          0,
        );

        expect(rightInstance).toEqual(leftInstance);
        expect(leftInstance.frozen.artKey).toBe(definition.artKey);
        expect(leftInstance.frozen.activeWeaponSnapshot?.sourceWeaponDefId).toBe(
          definition.weaponDef.id,
        );
        expect(spentUnits).toBe(RARITY_EFFECT_BUDGET[rarity]);
        if (rarity === 'common') {
          expect(leftInstance.resolvedEffects).toHaveLength(0);
          expect(leftInstance.frozen.statBonuses).toEqual({});
        } else if (rarity === 'uncommon') {
          expect(leftInstance.resolvedEffects).toHaveLength(1);
          expect(leftInstance.resolvedEffects[0]).toMatchObject({ kind: 'stat', unitCost: 1 });
        } else {
          expect(leftInstance.resolvedEffects.length).toBeGreaterThanOrEqual(1);
          expect(leftInstance.resolvedEffects.length).toBeLessThanOrEqual(2);
        }
      }
    }
  });

  it('routes every generated snapshot into the intended production attack kind', () => {
    for (const definition of FLOOR2_WEAPON_WAVE_A_BASES) {
      const fixture = spawnGeneratedWeaponFixture(definition);
      expect(fixture.snapshot.sourceWeaponDefId).toBe(definition.weaponDef.id);
      expectSpawnedAttack(fixture.world, fixture.attackKind, fixture.snapshot);
    }
  });

  it('realizes deterministic damage through representative downstream combat pipelines', () => {
    for (const stableId of REPRESENTATIVE_PIPELINE_BASE_IDS) {
      expectRepresentativeDamagePipeline(getWaveABase(stableId));
    }
  });
});
