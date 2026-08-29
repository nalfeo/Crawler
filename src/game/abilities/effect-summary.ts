import { getAbilityDefinition } from './registry.js';
import { formatSpellEffectSummary } from '../../shared/spell-effect-summary.js';

/**
 * Player-facing numeric stat line for an ability, derived from the authored
 * catalog effects (damage, range/radius, heal, slow, buff duration), or
 * `undefined` for abilities with no spell effects.
 *
 * The registry is the single source of truth: every surface that offers a spell
 * (boss reward picker, Spell Broker, abilities bar) reads the same numbers the
 * runtime casts, so a balance edit can never leave stale copy behind.
 *
 * @param tileSizeFt - Feet per tile for the loaded floor; falls back to the
 *   default map tile size, matching the runtime's own fallback.
 */
export function getAbilityEffectSummary(
  abilityId: string,
  tileSizeFt?: number,
): string | undefined {
  const definition = getAbilityDefinition(abilityId);
  if (!definition) return undefined;
  return formatSpellEffectSummary(
    definition.effects,
    tileSizeFt === undefined ? {} : { tileSizeFt },
  );
}
