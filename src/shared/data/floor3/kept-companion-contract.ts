/**
 * Floor 3 Slice 11 — kept-companion persistence contract (producer side).
 *
 * Spec R7 §9.3 / ADR 0071 D6: on winning the season the player keeps **one**
 * party Companion, carried forward at its ultimate (adult / final-evolution)
 * form as a permanent ally on later floors. This module defines the
 * persistence-contract shape and the builder that resolves it from a
 * species definition; the record is stored on the same in-process
 * floor-transition carryover channel used for generated-equipment carryover
 * (ADR 0064 precedent) — see `capturePlayerCarryover` in
 * `src/game/playerCarryover.ts`.
 *
 * Floor 4+ **consuming** this contract to re-host the Companion is a
 * separate, out-of-scope epic concern (spec R7): only the producer is
 * defined here.
 */
import type { Affinity } from './affinity.js';
import type { FightingStyle } from './styles.js';
import { ABILITY_MILESTONE_LEVELS, learnedAbilityIds, type PetSpeciesDef } from './species.js';

export const KEPT_COMPANION_CONTRACT_SCHEMA_VERSION = 'floor3-kept-companion/v1' as const;

/** Highest ability-milestone level — every species has learned all of its abilities by here. */
const ULTIMATE_FORM_LEVEL: number =
  ABILITY_MILESTONE_LEVELS[ABILITY_MILESTONE_LEVELS.length - 1] ?? 0;

/**
 * Persisted record for the single Floor 3 party Companion the player keeps
 * on win (spec R7 §9.3). Always describes the species at its **ultimate**
 * form — the kept Companion is promoted to adult with its full milestone
 * ability set regardless of the level it actually reached during the run.
 */
export interface KeptCompanionContract {
  readonly schemaVersion: typeof KEPT_COMPANION_CONTRACT_SCHEMA_VERSION;
  readonly speciesId: string;
  readonly affinity: Affinity;
  readonly fightingStyle: FightingStyle;
  /** Always adult / final-evolution form (spec R7). */
  readonly form: 2;
  readonly levelBand: 'floor3-graduate';
  readonly learnedAbilityIds: readonly string[];
}

/**
 * Builds the persisted contract for `species` at its ultimate form, i.e.
 * every ability-milestone id it has learned by {@link ULTIMATE_FORM_LEVEL}.
 */
export function buildKeptCompanionContract(species: PetSpeciesDef): KeptCompanionContract {
  return {
    schemaVersion: KEPT_COMPANION_CONTRACT_SCHEMA_VERSION,
    speciesId: species.speciesId,
    affinity: species.affinity,
    fightingStyle: species.fightingStyle,
    form: 2,
    levelBand: 'floor3-graduate',
    learnedAbilityIds: learnedAbilityIds(species, ULTIMATE_FORM_LEVEL),
  };
}
