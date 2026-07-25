import {
  formatBossAbilityAnnouncement,
  getFloor2BossAbilityById,
  type BossAbilityDef,
} from '../../shared/boss-abilities.js';
import type { MobAbilityResolveContext, MobAbilityRuntimeDefinition } from './types.js';
import { activateMobAbilitySelfBuff } from './runtime.js';
import type { GameWorld } from '../world.js';

export const BAMBOO_FED_BERSERK_ABILITY_ID = 'big-panda-wei-bamboo-fed-berserk';

const KNOCKBACK_RESISTANCE_BY_DESCRIPTOR: Record<string, number> = {
  light: 0.85,
  moderate: 0.65,
  heavy: 0.35,
};

interface CatalogDesignValue {
  readonly value: number | string | boolean;
  readonly unit: string;
}

interface BerserkTuning {
  readonly durationMs: number;
  readonly movementSpeedMultiplier: number;
  readonly meleeDamageMultiplier: number;
  readonly knockbackResistanceMultiplier: number;
  readonly stacking: boolean;
}

function designValue(ability: BossAbilityDef, id: string): CatalogDesignValue {
  const found = ability.effect.designValues.find((value) => value.id === id);
  if (found === undefined) {
    throw new Error(`Bamboo-Fed Berserk catalog entry missing effect design value "${id}"`);
  }
  return { value: found.value, unit: found.unit };
}

function expectUnit(actualUnit: string, expectedUnit: string, id: string): void {
  if (actualUnit !== expectedUnit) {
    throw new Error(
      `Bamboo-Fed Berserk design value "${id}" must use unit "${expectedUnit}", got "${actualUnit}"`,
    );
  }
}

function asNumber(entry: CatalogDesignValue, id: string, expectedUnit: string): number {
  expectUnit(entry.unit, expectedUnit, id);
  const value = entry.value;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Bamboo-Fed Berserk design value "${id}" must be a finite number`);
  }
  return value;
}

function asString(entry: CatalogDesignValue, id: string, expectedUnit: string): string {
  expectUnit(entry.unit, expectedUnit, id);
  if (typeof entry.value !== 'string' || entry.value.length === 0) {
    throw new Error(`Bamboo-Fed Berserk design value "${id}" must be a non-empty string`);
  }
  return entry.value;
}

function asBoolean(entry: CatalogDesignValue, id: string, expectedUnit: string): boolean {
  expectUnit(entry.unit, expectedUnit, id);
  if (typeof entry.value !== 'boolean') {
    throw new Error(`Bamboo-Fed Berserk design value "${id}" must be a boolean`);
  }
  return entry.value;
}

function percentBonusToMultiplier(percent: number): number {
  return 1 + percent / 100;
}

function readAuraRadiusFt(ability: BossAbilityDef): number {
  const metric = ability.telegraph.metrics.find((m) => m.id === 'radius');
  if (metric === undefined || typeof metric.value !== 'number' || metric.unit !== 'feet') {
    throw new Error('Bamboo-Fed Berserk telegraph is missing a numeric "radius" metric in feet');
  }
  if (metric.value <= 0) {
    throw new Error('Bamboo-Fed Berserk telegraph radius must be > 0 feet');
  }
  return metric.value;
}

function readTuning(ability: BossAbilityDef): BerserkTuning {
  const knockbackDescriptor = asString(
    designValue(ability, 'knockback-resistance'),
    'knockback-resistance',
    'descriptor',
  );
  const knockbackResistanceMultiplier = KNOCKBACK_RESISTANCE_BY_DESCRIPTOR[knockbackDescriptor];
  if (knockbackResistanceMultiplier === undefined) {
    throw new Error(
      `Bamboo-Fed Berserk has unknown knockback-resistance "${knockbackDescriptor}"`,
    );
  }
  const stacking = asBoolean(designValue(ability, 'stacking'), 'stacking', 'flag');
  if (stacking) {
    throw new Error('Bamboo-Fed Berserk stacking must be false');
  }
  return {
    durationMs: asNumber(designValue(ability, 'duration'), 'duration', 'milliseconds'),
    movementSpeedMultiplier: percentBonusToMultiplier(
      asNumber(designValue(ability, 'movement-speed-bonus'), 'movement-speed-bonus', 'percent'),
    ),
    meleeDamageMultiplier: percentBonusToMultiplier(
      asNumber(designValue(ability, 'melee-damage-bonus'), 'melee-damage-bonus', 'percent'),
    ),
    knockbackResistanceMultiplier,
    stacking,
  };
}

function makeResolveHandler(ability: BossAbilityDef, auraRadiusFt: number, tuning: BerserkTuning) {
  return function resolveBambooFedBerserk(world: GameWorld, ctx: MobAbilityResolveContext): void {
    activateMobAbilitySelfBuff(world, {
      abilityId: ability.id,
      casterEid: ctx.casterEid,
      sourceId: ctx.sourceId,
      durationMs: tuning.durationMs,
      movementSpeedMultiplier: tuning.movementSpeedMultiplier,
      meleeDamageMultiplier: tuning.meleeDamageMultiplier,
      knockbackResistanceMultiplier: tuning.knockbackResistanceMultiplier,
      auraRadiusFt,
    });
  };
}

export function createBambooFedBerserkDefinition(): MobAbilityRuntimeDefinition {
  const ability = getFloor2BossAbilityById(BAMBOO_FED_BERSERK_ABILITY_ID);
  if (ability === undefined) {
    throw new Error(`Catalog is missing ability "${BAMBOO_FED_BERSERK_ABILITY_ID}"`);
  }
  const auraRadiusFt = readAuraRadiusFt(ability);
  const tuning = readTuning(ability);
  return {
    abilityId: ability.id,
    bossArchetypeKey: ability.bossArchetypeId,
    firstEligibleAfterMs: ability.timing.firstEligibleAfterMs,
    cooldownMs: ability.timing.cooldownMs,
    telegraphDurationMs: ability.telegraph.durationMs,
    dangerColor: ability.telegraph.dangerColor,
    announcementText: formatBossAbilityAnnouncement(ability),
    geometry: { kind: 'circle', radiusFt: auraRadiusFt },
    targetingMode: 'self',
    originMode: 'follows-caster',
    lockCasterDuringTelegraph: true,
    selfBuff: {
      durationMs: tuning.durationMs,
      movementSpeedMultiplier: tuning.movementSpeedMultiplier,
      meleeDamageMultiplier: tuning.meleeDamageMultiplier,
      knockbackResistanceMultiplier: tuning.knockbackResistanceMultiplier,
      auraRadiusFt,
    },
    resolve: makeResolveHandler(ability, auraRadiusFt, tuning),
  };
}
