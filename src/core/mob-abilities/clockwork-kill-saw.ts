import {
  formatBossAbilityAnnouncement,
  getFloor2BossAbilityById,
  type BossAbilityDef,
} from '../../shared/boss-abilities.js';
import type { GameWorld } from '../world.js';
import type { MobAbilityResolveContext, MobAbilityRuntimeDefinition } from './types.js';

export const CLOCKWORK_KILL_SAW_ABILITY_ID = 'overseer-fizzwick-clockwork-kill-saw';
export const CLOCKWORK_KILL_SAW_DAMAGE_PER_PASS = 20;
export const CLOCKWORK_KILL_SAW_SPEED_FT_PER_TICK = 1;

interface CatalogDesignValue {
  readonly value: number | string | boolean;
  readonly unit: string;
}

function telegraphMetric(ability: BossAbilityDef, id: string): CatalogDesignValue {
  const found = ability.telegraph.metrics.find((metric) => metric.id === id);
  if (found === undefined) {
    throw new Error(`Clockwork Kill-Saw telegraph is missing metric "${id}"`);
  }
  return { value: found.value, unit: found.unit };
}

function effectValue(ability: BossAbilityDef, id: string): CatalogDesignValue {
  const found = ability.effect.designValues.find((value) => value.id === id);
  if (found === undefined) {
    throw new Error(`Clockwork Kill-Saw effect is missing design value "${id}"`);
  }
  return { value: found.value, unit: found.unit };
}

function asNumber(entry: CatalogDesignValue, id: string, unit: string): number {
  if (entry.unit !== unit) {
    throw new Error(`Clockwork Kill-Saw "${id}" must use unit "${unit}", got "${entry.unit}"`);
  }
  if (typeof entry.value !== 'number' || !Number.isFinite(entry.value) || entry.value <= 0) {
    throw new Error(`Clockwork Kill-Saw "${id}" must be a positive finite number`);
  }
  return entry.value;
}

function asBoolean(entry: CatalogDesignValue, id: string, unit: string): boolean {
  if (entry.unit !== unit) {
    throw new Error(`Clockwork Kill-Saw "${id}" must use unit "${unit}", got "${entry.unit}"`);
  }
  if (typeof entry.value !== 'boolean') {
    throw new Error(`Clockwork Kill-Saw "${id}" must be a boolean`);
  }
  return entry.value;
}

function readWidthFt(ability: BossAbilityDef): number {
  return asNumber(telegraphMetric(ability, 'width'), 'width', 'feet');
}

function readMaxRangeFt(ability: BossAbilityDef): number {
  return asNumber(telegraphMetric(ability, 'max-range'), 'max-range', 'feet');
}

function readHoldMs(ability: BossAbilityDef): number {
  return asNumber(effectValue(ability, 'endpoint-hold'), 'endpoint-hold', 'milliseconds');
}

function assertTwoPassContract(ability: BossAbilityDef): void {
  const telegraphPasses = asNumber(
    telegraphMetric(ability, 'damaging-passes'),
    'damaging-passes',
    'count',
  );
  const effectPasses = asNumber(
    effectValue(ability, 'damaging-passes'),
    'damaging-passes',
    'count',
  );
  if (telegraphPasses !== 2 || effectPasses !== 2) {
    throw new Error('Clockwork Kill-Saw damaging-passes must be exactly 2');
  }
  if (asBoolean(effectValue(ability, 'path-tracking'), 'path-tracking', 'flag')) {
    throw new Error('Clockwork Kill-Saw path-tracking must be false');
  }
}

function resolveClockworkKillSaw(_world: GameWorld, _ctx: MobAbilityResolveContext): void {
  // Damage is applied during the outbound and return lane passes by the typed
  // runtime's active returning-lane state. Telegraph resolution only launches it.
}

export function createClockworkKillSawDefinition(): MobAbilityRuntimeDefinition {
  const ability = getFloor2BossAbilityById(CLOCKWORK_KILL_SAW_ABILITY_ID);
  if (ability === undefined) {
    throw new Error(`Catalog is missing ability "${CLOCKWORK_KILL_SAW_ABILITY_ID}"`);
  }
  assertTwoPassContract(ability);
  return {
    abilityId: ability.id,
    bossArchetypeKey: ability.bossArchetypeId,
    firstEligibleAfterMs: ability.timing.firstEligibleAfterMs,
    cooldownMs: ability.timing.cooldownMs,
    telegraphDurationMs: ability.telegraph.durationMs,
    dangerColor: ability.telegraph.dangerColor,
    announcementText: formatBossAbilityAnnouncement(ability),
    geometry: {
      kind: 'lane',
      widthFt: readWidthFt(ability),
      maxRangeFt: readMaxRangeFt(ability),
    },
    activeEffect: {
      kind: 'returning-lane',
      speedFtPerTick: CLOCKWORK_KILL_SAW_SPEED_FT_PER_TICK,
      holdMs: readHoldMs(ability),
      damageAmount: CLOCKWORK_KILL_SAW_DAMAGE_PER_PASS,
    },
    resolve: resolveClockworkKillSaw,
  };
}
