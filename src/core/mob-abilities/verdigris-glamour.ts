/**
 * Queen Mab Tarnish — VERDIGRIS GLAMOUR typed runtime definition + resolve
 * handler.
 *
 * This adapter reads the *known, named* fields it needs out of the approved
 * catalog entry (`src/shared/boss-abilities.ts`) into strongly typed values. It
 * is NOT a generic `designValues` interpreter — every value it consumes is read
 * by id with an explicit type + validation, and the effect is a hand-written
 * handler. Adding another ability means writing another typed adapter + handler,
 * not extending a DSL.
 *
 * Contract (see issue #1260 / `.specify/specs/boss-abilities.md`):
 *   - 9s first eligibility, 9s cooldown anchored after resolution, 0 jitter;
 *   - 12-foot hostile-red circle locked to the player's position at telegraph
 *     start; 1.5s telegraph that never tracks after lock;
 *   - moderate damage only inside the committed circle;
 *   - Tarnished for 4s: 0.70 move-speed and 0.75 attack-speed multipliers,
 *     non-stacking (replace);
 *   - damage/effects/cooldowns are catalog-defined and never inherit level-scaled
 *     contact damage.
 */

import { hasComponent, query } from 'bitecs';
import { Enemy, Health, Position } from '../components.js';
import { applyDamage } from '../apply-damage.js';
import { applyStatusEffect, clearStatusEffects } from '../status-effects.js';
import type { StatusEffectSpec } from '../../shared/status-effect-types.js';
import {
  formatBossAbilityAnnouncement,
  getFloor2BossAbilityById,
  type BossAbilityDef,
} from '../../shared/boss-abilities.js';
import type { GameWorld } from '../world.js';
import type { MobAbilityResolveContext, MobAbilityRuntimeDefinition } from './types.js';

export const VERDIGRIS_GLAMOUR_ABILITY_ID = 'queen-mab-verdigris-glamour';

/**
 * Catalog-defined damage descriptors mapped to fixed simulation amounts. The
 * descriptor comes from the catalog (`effect.designValues['damage-profile']`);
 * this typed table turns it into a concrete, catalog-scoped amount. Deliberately
 * NOT the level-scaled contact `Damage` component (issue #1260, PR #1237).
 */
const DAMAGE_PROFILE_AMOUNTS = {
  light: 10,
  moderate: 20,
  heavy: 35,
} as const;
type DamageProfile = keyof typeof DAMAGE_PROFILE_AMOUNTS;

/** Strongly typed values extracted from the catalog Tarnished effect. */
interface TarnishedTuning {
  readonly durationMs: number;
  readonly moveSpeedMultiplier: number;
  readonly attackSpeedMultiplier: number;
  readonly stacking: boolean;
  readonly damageAmount: number;
}

interface CatalogDesignValue {
  readonly value: number | string | boolean;
  readonly unit: string;
}

function designValue(ability: BossAbilityDef, id: string): CatalogDesignValue {
  const found = ability.effect.designValues.find((value) => value.id === id);
  if (found === undefined) {
    throw new Error(`Verdigris Glamour catalog entry missing effect design value "${id}"`);
  }
  return { value: found.value, unit: found.unit };
}

function expectUnit(actualUnit: string, expectedUnit: string, id: string): void {
  if (actualUnit !== expectedUnit) {
    throw new Error(
      `Verdigris Glamour design value "${id}" must use unit "${expectedUnit}", got "${actualUnit}"`,
    );
  }
}

function asNumber(entry: CatalogDesignValue, id: string, expectedUnit: string): number {
  expectUnit(entry.unit, expectedUnit, id);
  const value = entry.value;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Verdigris Glamour design value "${id}" must be a finite number`);
  }
  return value;
}

function asString(entry: CatalogDesignValue, id: string, expectedUnit: string): string {
  expectUnit(entry.unit, expectedUnit, id);
  if (typeof entry.value !== 'string' || entry.value.length === 0) {
    throw new Error(`Verdigris Glamour design value "${id}" must be a non-empty string`);
  }
  return entry.value;
}

function asBoolean(entry: CatalogDesignValue, id: string, expectedUnit: string): boolean {
  expectUnit(entry.unit, expectedUnit, id);
  if (typeof entry.value !== 'boolean') {
    throw new Error(`Verdigris Glamour design value "${id}" must be a boolean`);
  }
  return entry.value;
}

/** Convert a signed percent modifier (e.g. -30) into a multiplier (0.70). */
function percentModifierToMultiplier(percent: number): number {
  return 1 + percent / 100;
}

function readTarnishedTuning(ability: BossAbilityDef): TarnishedTuning {
  const debuffId = asString(designValue(ability, 'debuff-id'), 'debuff-id', 'mode');
  if (debuffId !== 'tarnished') {
    throw new Error(`Verdigris Glamour debuff-id must be "tarnished", got "${debuffId}"`);
  }
  const profileRaw = asString(
    designValue(ability, 'damage-profile'),
    'damage-profile',
    'descriptor',
  );
  if (!(profileRaw in DAMAGE_PROFILE_AMOUNTS)) {
    throw new Error(`Verdigris Glamour has unknown damage-profile "${profileRaw}"`);
  }
  const profile = profileRaw as DamageProfile;
  return {
    durationMs: asNumber(designValue(ability, 'duration'), 'duration', 'milliseconds'),
    moveSpeedMultiplier: percentModifierToMultiplier(
      asNumber(
        designValue(ability, 'movement-speed-modifier'),
        'movement-speed-modifier',
        'percent',
      ),
    ),
    attackSpeedMultiplier: percentModifierToMultiplier(
      asNumber(designValue(ability, 'attack-speed-modifier'), 'attack-speed-modifier', 'percent'),
    ),
    stacking: asBoolean(designValue(ability, 'stacking'), 'stacking', 'flag'),
    damageAmount: DAMAGE_PROFILE_AMOUNTS[profile],
  };
}

function readRadiusFt(ability: BossAbilityDef): number {
  const metric = ability.telegraph.metrics.find((m) => m.id === 'radius');
  if (metric === undefined || typeof metric.value !== 'number' || metric.unit !== 'feet') {
    throw new Error('Verdigris Glamour telegraph is missing a numeric "radius" metric in feet');
  }
  if (metric.value <= 0) {
    throw new Error('Verdigris Glamour telegraph radius must be > 0 feet');
  }
  return metric.value;
}

/** Apply the Tarnished debuff to one entity (non-stacking replace). */
function applyTarnished(
  world: GameWorld,
  targetEid: number,
  sourceId: string,
  tuning: TarnishedTuning,
): void {
  // Non-stacking is expressed as the `replace` stack rule: re-applying the same
  // source+stat+op overwrites the existing effect rather than compounding.
  const stackRule = tuning.stacking
    ? ({ mode: 'refresh' } as const)
    : ({ mode: 'replace' } as const);
  if (!tuning.stacking) {
    // `replace` only overwrites effects sharing this exact sourceId. Tarnished is
    // a singleton debuff by identity, so a DIFFERENT caster (recycled slot, a
    // second boss in a future multi-boss preset) must not compound its own
    // Tarnished on top of ours. Clear any sibling Tarnished from other casters of
    // the same ability first so multipliers never stack (0.70 * 0.70, etc.).
    const abilityPrefix = sourceId.slice(0, sourceId.lastIndexOf(':') + 1);
    clearStatusEffects(
      world,
      targetEid,
      (e) =>
        e.sourceType === 'ability' &&
        e.sourceId !== sourceId &&
        e.sourceId.startsWith(abilityPrefix) &&
        (e.stat === 'speed' || e.stat === 'attackSpeed'),
    );
  }
  const move: StatusEffectSpec = {
    stat: 'speed',
    op: 'multiply',
    value: tuning.moveSpeedMultiplier,
    durationMs: tuning.durationMs,
    sourceType: 'ability',
    sourceId,
    stackRule,
  };
  const attack: StatusEffectSpec = {
    stat: 'attackSpeed',
    op: 'multiply',
    value: tuning.attackSpeedMultiplier,
    durationMs: tuning.durationMs,
    sourceType: 'ability',
    sourceId,
    stackRule,
  };
  applyStatusEffect(world, targetEid, move);
  applyStatusEffect(world, targetEid, attack);
}

/** Build the Verdigris Glamour resolve handler bound to the catalog tuning. */
function makeResolveHandler(ability: BossAbilityDef) {
  const tuning = readTarnishedTuning(ability);
  return function resolveVerdigrisGlamour(world: GameWorld, ctx: MobAbilityResolveContext): void {
    const { geometry, casterEid, sourceId } = ctx;
    if (geometry.kind !== 'circle') return;
    const r2 = geometry.radiusFt * geometry.radiusFt;
    // Every damageable entity inside the committed circle (except the caster)
    // takes moderate damage and is Tarnished. Entities outside are untouched.
    for (const eid of query(world.ecs, [Position, Health])) {
      if (eid === casterEid) continue;
      if (hasComponent(world.ecs, eid, Enemy)) {
        // Never friendly-fire enemies. The ability targets the player; skipping
        // ALL enemies (not just `!== targetEid`) also closes a recycled-ID hole:
        // if the player dies mid-telegraph and its id is reassigned to a freshly
        // spawned enemy, that enemy must not inherit the lock and take damage.
        continue;
      }
      const dx = (world.stores.position.x[eid] ?? 0) - geometry.x;
      const dy = (world.stores.position.y[eid] ?? 0) - geometry.y;
      if (dx * dx + dy * dy > r2) continue;
      const targetX = world.stores.position.x[eid] ?? 0;
      const targetY = world.stores.position.y[eid] ?? 0;
      applyDamage(world, eid, tuning.damageAmount, targetX, targetY, {
        origin: 'enemy',
        affinity: 'magic',
        scaleWithPrimary: false,
        canCrit: false,
        sourceEid: casterEid,
        sourceX: geometry.x,
        sourceY: geometry.y,
      });
      // Only Tarnish a target that survived the hit. If the 20 damage was lethal
      // the player is now at 0 HP and must not retain status effects during
      // game-over — that would violate the dead-target cleanup contract and cause
      // the VFX layer to render a Tarnished indicator post-death.
      if ((world.stores.health.current[eid] ?? 0) > 0) {
        applyTarnished(world, eid, sourceId, tuning);
      }
    }
  };
}

/**
 * Build the typed runtime definition for Queen Mab's Verdigris Glamour from the
 * approved Floor 2 catalog. Throws if the catalog entry is missing (a
 * regression guard — the catalog is the source of truth).
 */
export function createVerdigrisGlamourDefinition(): MobAbilityRuntimeDefinition {
  const ability = getFloor2BossAbilityById(VERDIGRIS_GLAMOUR_ABILITY_ID);
  if (ability === undefined) {
    throw new Error(`Catalog is missing ability "${VERDIGRIS_GLAMOUR_ABILITY_ID}"`);
  }
  return {
    abilityId: ability.id,
    bossArchetypeKey: ability.bossArchetypeId,
    firstEligibleAfterMs: ability.timing.firstEligibleAfterMs,
    cooldownMs: ability.timing.cooldownMs,
    telegraphDurationMs: ability.telegraph.durationMs,
    dangerColor: ability.telegraph.dangerColor,
    announcementText: formatBossAbilityAnnouncement(ability),
    geometry: { kind: 'circle', radiusFt: readRadiusFt(ability) },
    resolve: makeResolveHandler(ability),
  };
}
