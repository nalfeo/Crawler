/**
 * spell-effect-summary — player-facing numeric summaries for spell abilities.
 *
 * Spell copy in `ability-presentation.ts` is prose only ("Hurl a ball of fire
 * that explodes in an area"), which leaves the player choosing a spell — at the
 * boss reward picker, the Spell Broker, or the abilities bar — with no idea how
 * much damage it deals or how far it reaches. This module derives that stat line
 * from the SAME authored `CatalogEffect` values the runtime casts (see
 * `game/systems/progressionEffects.ts`), so the numbers can never drift from
 * balance changes the way a hand-written string would.
 *
 * Pure and dependency-free (no Phaser/DOM/world), so the engine UI, the game
 * layer, and labs all format identically and it is unit-testable.
 */
import type { CatalogEffect, TimedBuffModifier } from './progression-effects.js';
import { STAT_DISPLAY } from './stat-display.js';
import type { ScalableOutput, StatKey } from './stats.js';
import { GAME } from './constants.js';

/**
 * Tile size used when no floor map is loaded. Mirrors
 * `DEFAULT_MAP_CONFIG.tileSizeFt` and the runtime fallback in
 * `progressionEffects.ts#tilesToFeet`.
 */
export const DEFAULT_TILE_SIZE_FT = 4;

/** Separator between stat segments — matches the abilities-bar detail rows. */
const SEGMENT_SEPARATOR = ' • ';

export interface SpellEffectSummaryOptions {
  /** Feet per map tile; spell radii/ranges are authored in tiles. */
  readonly tileSizeFt?: number;
}

/** Trims trailing zeros so `12.0` reads as `12` and `3.6` stays `3.6`. */
function formatNumber(value: number, maxDecimals = 1): string {
  const rounded = Number(value.toFixed(maxDecimals));
  return String(rounded);
}

function formatFeet(tiles: number, tileSizeFt: number): string {
  return `${formatNumber(tiles * tileSizeFt)} ft`;
}

function formatSeconds(milliseconds: number): string {
  return `${formatNumber(milliseconds / 1000)}s`;
}

/** Speed multipliers are authored as the REMAINING fraction (0.55 → 45% slow). */
function formatSlow(multiplier: number, durationMs: number): string {
  const slowPercent = Math.round((1 - multiplier) * 100);
  return `Slow ${slowPercent}% for ${formatSeconds(durationMs)}`;
}

/**
 * Stats whose modifier value is a BONUS FRACTION rather than a flat amount —
 * `foldLegacyStatModifier` accumulates both `add` and `multiply` ops into the
 * same fraction lane for these (see `shared/stats.ts`), so 0.05 means +5%.
 */
const FRACTION_STATS = new Set<StatKey>(['moveSpeed', 'attackSpeed']);

function formatModifier(modifier: TimedBuffModifier): string {
  const stat: StatKey = modifier.stat;
  const label = STAT_DISPLAY[stat].label;
  const value = modifier.value.base;
  // `damage` splits by op: `add` is flat damage, `multiply` is a percentage.
  if (FRACTION_STATS.has(stat) || (stat === 'damage' && modifier.op === 'multiply')) {
    return `${label} +${formatNumber(value * 100)}%`;
  }
  return `${label} +${formatNumber(value, 2)}`;
}

/** Stat segments for one spell effect, or `[]` when the effect is not a spell. */
function summarizeEffect(effect: CatalogEffect, tileSizeFt: number): string[] {
  switch (effect.type) {
    case 'spell_fireball':
      return [
        `Damage ${formatNumber(effect.damage.base)}`,
        // The blast radius doubles as the targeting reach: the epicentre is
        // chosen from enemies within it (progressionEffects.ts#castFireball),
        // so one segment names both rather than repeating the same number.
        `Target & blast radius ${formatFeet(effect.radiusTiles.base, tileSizeFt)}`,
      ];
    case 'spell_magic_missile':
      return [
        `Damage ${formatNumber(effect.damage.base)}`,
        `Range ${formatFeet(effect.rangeTiles.base, tileSizeFt)}`,
      ];
    case 'spell_frost_nova':
      return [
        `Damage ${formatNumber(effect.damage.base)}`,
        `Radius ${formatFeet(effect.radiusTiles.base, tileSizeFt)}`,
        formatSlow(effect.slowMultiplier.base, effect.slowDurationMs.base),
      ];
    case 'spell_life_drain':
      return [
        `Damage ${formatNumber(effect.damage.base)}`,
        `Range ${formatFeet(effect.rangeTiles.base, tileSizeFt)}`,
        `Heals ${formatNumber(effect.heal.base)}`,
      ];
    case 'spell_pulse_shield':
      return [
        `Radius ${formatFeet(effect.radiusTiles.base, tileSizeFt)}`,
        `Knockback ${formatNumber(effect.knockbackForce.base, 2)}`,
      ];
    case 'spell_enemy_slow_burst':
      return [
        `Radius ${formatFeet(effect.radiusTiles.base, tileSizeFt)}`,
        formatSlow(effect.slowMultiplier.base, effect.slowDurationMs.base),
      ];
    case 'spell_heal':
      return [`Heals ${formatNumber(effect.heal.base)}`];
    case 'spell_timed_buff':
      return [
        ...effect.modifiers.map(formatModifier),
        `Duration ${formatSeconds((effect.durationFrames.base / GAME.TARGET_FPS) * 1000)}`,
      ];
    default:
      return [];
  }
}

/** True when any of the spell's outputs grows with Intelligence. */
function anyScalesWithIntelligence(...outputs: readonly ScalableOutput[]): boolean {
  return outputs.some((output) => output.scalesWithIntelligence);
}

function scalesWithIntelligence(effect: CatalogEffect): boolean {
  switch (effect.type) {
    case 'spell_fireball':
      return anyScalesWithIntelligence(effect.damage, effect.radiusTiles);
    case 'spell_magic_missile':
      return anyScalesWithIntelligence(effect.damage, effect.rangeTiles);
    case 'spell_frost_nova':
      return anyScalesWithIntelligence(
        effect.damage,
        effect.radiusTiles,
        effect.slowMultiplier,
        effect.slowDurationMs,
      );
    case 'spell_life_drain':
      return anyScalesWithIntelligence(effect.damage, effect.rangeTiles, effect.heal);
    case 'spell_heal':
      return anyScalesWithIntelligence(effect.heal);
    case 'spell_pulse_shield':
      return anyScalesWithIntelligence(effect.knockbackForce, effect.radiusTiles);
    case 'spell_enemy_slow_burst':
      return anyScalesWithIntelligence(
        effect.radiusTiles,
        effect.slowMultiplier,
        effect.slowDurationMs,
      );
    case 'spell_timed_buff':
      return (
        effect.durationFrames.scalesWithIntelligence ||
        effect.modifiers.some((modifier) => modifier.value.scalesWithIntelligence)
      );
    default:
      return false;
  }
}

/**
 * One-line stat summary for a spell's effects, or `undefined` when the ability
 * has no spell effects (passives keep their authored `passiveEffectSummary`).
 *
 * The values shown are the authored BASE outputs. At cast time they are further
 * raised by Intelligence (when the output scales with it) and by the spell's
 * mastery efficacy multiplier, so the line closes with a scaling note rather
 * than presenting the numbers as a final guaranteed hit.
 */
export function formatSpellEffectSummary(
  effects: readonly CatalogEffect[],
  options: SpellEffectSummaryOptions = {},
): string | undefined {
  const tileSizeFt = options.tileSizeFt ?? DEFAULT_TILE_SIZE_FT;
  const segments: string[] = [];
  let intelligenceScaled = false;
  for (const effect of effects) {
    const effectSegments = summarizeEffect(effect, tileSizeFt);
    if (effectSegments.length === 0) continue;
    segments.push(...effectSegments);
    intelligenceScaled ||= scalesWithIntelligence(effect);
  }
  if (segments.length === 0) return undefined;
  segments.push(
    intelligenceScaled ? 'Base — scales with INT & mastery' : 'Base — scales with mastery',
  );
  return segments.join(SEGMENT_SEPARATOR);
}
