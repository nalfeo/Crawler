/**
 * King Skritt the Unburnt — ROMAN-CANDLE CORONATION typed runtime definition
 * + resolve handler.
 *
 * Contract (see issue #1955 / `.specify/specs/boss-abilities.md`):
 *   - 8s first eligibility, 8s cooldown anchored after resolution, 0 jitter;
 *   - 1.3s telegraph showing twelve hostile-red radial spoke paths from the
 *     caster position, locked at telegraph start;
 *   - Alternating casts rotate the committed pattern by exactly 15 degrees:
 *     even cast ordinals (0, 2, 4…) use 0°, odd ordinals (1, 3, 5…) use 15°;
 *   - Resolution launches twelve simultaneous straight, non-homing crown-flame
 *     projectiles along the committed spokes;
 *   - No player-position targeting: the spokes always radiate from the caster
 *     and never track any entity during or after the telegraph.
 *
 * The alternation derives deterministically from `resolvedCasts` at telegraph-
 * start time. No `Math.random()`, no wall-clock time.
 *
 * Phaser-free: lives in `src/core` so it runs identically in the visual game,
 * the headless runner, and the combat arena lab.
 */

import { ENEMY_PROJECTILE } from '../../shared/constants.js';
import {
  formatBossAbilityAnnouncement,
  getFloor2BossAbilityById,
  type BossAbilityDef,
} from '../../shared/boss-abilities.js';
import { spawnEnemyProjectile } from '../spawners/projectiles.js';
import type { GameWorld } from '../world.js';
import type { MobAbilityResolveContext, MobAbilityRuntimeDefinition } from './types.js';

export const ROMAN_CANDLE_CORONATION_ABILITY_ID = 'king-skritt-roman-candle-coronation';

/**
 * Crown-flame projectile speed (ft/step). Matches the standard enemy
 * projectile speed so the threat-read is consistent with other ranged enemies.
 */
const CROWN_FLAME_SPEED = ENEMY_PROJECTILE.SPEED;

/**
 * Crown-flame projectile damage. Boss-tier value, higher than the standard
 * ranged enemy hit so the counterplay incentive (step into a gap) is meaningful.
 */
const CROWN_FLAME_DAMAGE = 20;

/**
 * Spoke length for the visual telegraph (feet). Represents how far each
 * danger path extends from the caster for player readability.
 */
const SPOKE_LENGTH_FT = 28;

interface CatalogDesignValue {
  readonly value: number | string | boolean;
  readonly unit: string;
}

function designValue(ability: BossAbilityDef, id: string): CatalogDesignValue {
  const found = ability.effect.designValues.find((value) => value.id === id);
  if (found === undefined) {
    throw new Error(`Roman Candle Coronation catalog entry missing effect design value "${id}"`);
  }
  return { value: found.value, unit: found.unit };
}

function expectUnit(actualUnit: string, expectedUnit: string, id: string): void {
  if (actualUnit !== expectedUnit) {
    throw new Error(
      `Roman Candle Coronation design value "${id}" must use unit "${expectedUnit}", got "${actualUnit}"`,
    );
  }
}

function asPositiveInt(entry: CatalogDesignValue, id: string, expectedUnit: string): number {
  expectUnit(entry.unit, expectedUnit, id);
  if (typeof entry.value !== 'number' || !Number.isInteger(entry.value) || entry.value <= 0) {
    throw new Error(`Roman Candle Coronation design value "${id}" must be a positive integer`);
  }
  return entry.value;
}

function asPositiveNumber(entry: CatalogDesignValue, id: string, expectedUnit: string): number {
  expectUnit(entry.unit, expectedUnit, id);
  if (typeof entry.value !== 'number' || !Number.isFinite(entry.value) || entry.value <= 0) {
    throw new Error(
      `Roman Candle Coronation design value "${id}" must be a positive finite number`,
    );
  }
  return entry.value;
}

function asBoolean(entry: CatalogDesignValue, id: string, expectedUnit: string): boolean {
  expectUnit(entry.unit, expectedUnit, id);
  if (typeof entry.value !== 'boolean') {
    throw new Error(`Roman Candle Coronation design value "${id}" must be a boolean`);
  }
  return entry.value;
}

/** Read the projectile count from the telegraph metrics (shared with effect). */
function readProjectileCount(ability: BossAbilityDef): number {
  const metric = ability.telegraph.metrics.find((m) => m.id === 'projectile-count');
  if (metric === undefined || metric.unit !== 'count') {
    throw new Error(
      'Roman Candle Coronation telegraph must include a "projectile-count" metric in unit "count"',
    );
  }
  if (typeof metric.value !== 'number' || !Number.isInteger(metric.value) || metric.value <= 0) {
    throw new Error(
      'Roman Candle Coronation telegraph projectile-count must be a positive integer',
    );
  }
  return metric.value;
}

/** Read the alternation offset (degrees) from the telegraph metrics. */
function readAlternateOffsetDeg(ability: BossAbilityDef): number {
  const metric = ability.telegraph.metrics.find((m) => m.id === 'alternate-offset');
  if (metric === undefined || metric.unit !== 'degrees') {
    throw new Error(
      'Roman Candle Coronation telegraph must include an "alternate-offset" metric in unit "degrees"',
    );
  }
  if (
    typeof metric.value !== 'number' ||
    !Number.isFinite(metric.value) ||
    metric.value <= 0 ||
    metric.value >= 360
  ) {
    throw new Error(
      'Roman Candle Coronation alternate-offset must be a positive finite degrees in (0, 360)',
    );
  }
  return metric.value;
}

/**
 * Validate that the effect design values match the telegraph contract.
 * Both sides must agree on projectile-count and alternate-offset.
 */
function validateEffectDesignValues(
  ability: BossAbilityDef,
  telegraphCount: number,
  alternateOffsetDeg: number,
): void {
  const effectCount = asPositiveInt(
    designValue(ability, 'projectile-count'),
    'projectile-count',
    'count',
  );
  if (effectCount !== telegraphCount) {
    throw new Error(
      `Roman Candle Coronation effect projectile-count (${effectCount}) must match telegraph count (${telegraphCount})`,
    );
  }
  const effectOffset = asPositiveNumber(
    designValue(ability, 'alternate-offset'),
    'alternate-offset',
    'degrees',
  );
  if (effectOffset !== alternateOffsetDeg) {
    throw new Error(
      `Roman Candle Coronation effect alternate-offset (${effectOffset}) must match telegraph offset (${alternateOffsetDeg})`,
    );
  }
  const homing = asBoolean(designValue(ability, 'homing'), 'homing', 'flag');
  if (homing !== false) {
    throw new Error('Roman Candle Coronation homing must be false (non-homing projectiles only)');
  }
}

/**
 * Build the resolve handler for ROMAN-CANDLE CORONATION.
 *
 * At resolution, fires exactly `count` simultaneous straight projectiles along
 * the committed spoke directions. The spoke directions are fully determined by
 * the committed geometry (locked at telegraph start), so the resolver reads
 * only from `ctx.geometry` — it never re-samples or tracks anything.
 */
function makeResolveHandler(count: number) {
  return function resolveRomanCandleCoronation(
    world: GameWorld,
    ctx: MobAbilityResolveContext,
  ): void {
    const { geometry, casterEid } = ctx;
    if (geometry.kind !== 'radial-projectiles') return;

    const { casterX, casterY, offsetDeg } = geometry;
    for (let i = 0; i < count; i += 1) {
      // Spoke angle: evenly divide a full rotation plus the committed offset.
      const angleDeg = (i / count) * 360 + offsetDeg;
      const angleRad = (angleDeg * Math.PI) / 180;
      const vx = CROWN_FLAME_SPEED * Math.cos(angleRad);
      const vy = CROWN_FLAME_SPEED * Math.sin(angleRad);
      const eid = spawnEnemyProjectile(
        world,
        casterX,
        casterY,
        vx,
        vy,
        CROWN_FLAME_DAMAGE,
        casterEid,
      );
      ctx.registerOwnedEntity?.(eid);
    }
  };
}

/**
 * Build the typed runtime definition for King Skritt's Roman Candle Coronation
 * from the approved Floor 2 catalog. Throws if the catalog entry is missing (a
 * regression guard — the catalog is the source of truth).
 */
export function createRomanCandleCoronationDefinition(): MobAbilityRuntimeDefinition {
  const ability = getFloor2BossAbilityById(ROMAN_CANDLE_CORONATION_ABILITY_ID);
  if (ability === undefined) {
    throw new Error(`Catalog is missing ability "${ROMAN_CANDLE_CORONATION_ABILITY_ID}"`);
  }
  const count = readProjectileCount(ability);
  const alternateOffsetDeg = readAlternateOffsetDeg(ability);
  validateEffectDesignValues(ability, count, alternateOffsetDeg);

  return {
    abilityId: ability.id,
    bossArchetypeKey: ability.bossArchetypeId,
    firstEligibleAfterMs: ability.timing.firstEligibleAfterMs,
    cooldownMs: ability.timing.cooldownMs,
    telegraphDurationMs: ability.telegraph.durationMs,
    dangerColor: ability.telegraph.dangerColor,
    announcementText: formatBossAbilityAnnouncement(ability),
    geometry: {
      kind: 'radial-projectiles',
      count,
      spokeLengthFt: SPOKE_LENGTH_FT,
      alternateOffsetDeg,
    },
    resolve: makeResolveHandler(count),
  };
}
