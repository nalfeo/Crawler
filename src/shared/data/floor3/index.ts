/**
 * Floor 3 — Companion League data surface (spec slice 1).
 *
 * See `.specify/specs/floor3-companion-league.md` and ADR 0071.
 */
export * from './affinity.js';
export * from './styles.js';
export {
  ABILITY_MILESTONE_LEVELS,
  FORM_MIN_LEVELS,
  formForLevel,
  getPetSpecies,
  learnedAbilityIds,
  loadPetSpecies,
  petSpeciesByAffinity,
  petSpeciesByStyle,
  petSpeciesDefSchema,
  speciesForToken,
  speciesTokenForId,
  type PetFormDef,
  type PetSpeciesDef,
} from './species.js';
