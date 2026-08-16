/**
 * Floor 3 companion species roster — data-driven per ADR 0011 / ADR 0071 D3.
 *
 * The roster lives in `species.json` (49 grid species = 7 affinities x 7 styles,
 * plus 3 off-grid signature species = 52 species x 3 forms) and is loaded and
 * validated here through Zod. Content source of truth:
 * `docs/knowledge/game-design/floor3-pet-roster.md`.
 *
 * Names are freely renameable — nothing keys off a display name, only off the
 * stable `speciesId`.
 */
import { z } from 'zod';
import { AFFINITY_RING, type Affinity } from './affinity.js';
import { FIGHTING_STYLES, type FightingStyle } from './styles.js';
import speciesJson from './species.json';

/** Evolution stage index: baby | adolescent | adult. */
export const FORM_MIN_LEVELS = [1, 10, 25] as const;
/** Levels at which a species learns an ability. */
export const ABILITY_MILESTONE_LEVELS = [1, 8, 16, 25, 34] as const;

const affinitySchema = z.enum(AFFINITY_RING);
const fightingStyleSchema = z.enum(FIGHTING_STYLES);

const petFormSchema = z
  .object({
    /** 0 = baby, 1 = adolescent, 2 = adult. */
    form: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    /** Display name for this form. */
    name: z.string().min(1),
    /** Level at which this form is reached (1 / 10 / 25). */
    minLevel: z.number().int().positive(),
    /** Multiplier over the style's base archetype for this form. */
    statScale: z.number().positive(),
  })
  .strict();

export type PetFormDef = z.infer<typeof petFormSchema>;

const abilityIdsByLevelSchema = z
  .object({
    '1': z.string().min(1),
    '8': z.string().min(1),
    '16': z.string().min(1),
    '25': z.string().min(1),
    '34': z.string().min(1),
  })
  .strict();

export const petSpeciesDefSchema = z
  .object({
    /** Stable identifier, e.g. `ember-charger`. */
    speciesId: z.string().min(1),
    affinity: affinitySchema,
    fightingStyle: fightingStyleSchema,
    /** Exactly three forms, ordered baby -> adolescent -> adult. */
    forms: z.tuple([petFormSchema, petFormSchema, petFormSchema]),
    /** Ability unlocked at each milestone level. */
    abilityIdsByLevel: abilityIdsByLevelSchema,
    /** Display name of the L1 innate ability (roster doc). */
    innateAbilityName: z.string().min(1),
    /** Display name of the L25 adult signature ability (roster doc). */
    adultSignatureAbilityName: z.string().min(1),
    /** Off-grid rare line (starter-exclusive offer / Final Four ace). */
    signature: z.boolean().optional(),
  })
  .strict()
  .superRefine((species, ctx) => {
    species.forms.forEach((form, index) => {
      if (form.form !== index) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${species.speciesId}: forms must be ordered 0,1,2 (got ${form.form} at index ${index})`,
        });
      }
      if (form.minLevel !== FORM_MIN_LEVELS[index]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${species.speciesId}: form ${index} minLevel must be ${FORM_MIN_LEVELS[index]}`,
        });
      }
    });
    for (let i = 1; i < species.forms.length; i++) {
      const previous = species.forms[i - 1];
      const current = species.forms[i];
      if (previous === undefined || current === undefined) continue;
      if (current.statScale <= previous.statScale) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${species.speciesId}: statScale must increase across forms`,
        });
      }
    }
  });

export type PetSpeciesDef = z.infer<typeof petSpeciesDefSchema>;

const rosterSchema = z.array(petSpeciesDefSchema).min(52);

let cachedSpecies: readonly PetSpeciesDef[] | null = null;

/**
 * Load and validate the full species roster. Enforces `speciesId` uniqueness and
 * complete 7x7 affinity-by-style grid coverage (no dead cells), which the
 * recruiting-coverage design depends on.
 */
export function loadPetSpecies(): readonly PetSpeciesDef[] {
  if (cachedSpecies !== null) return cachedSpecies;
  const parsed = rosterSchema.parse(speciesJson);

  const seenIds = new Set<string>();
  const seenCells = new Set<string>();
  for (const species of parsed) {
    if (seenIds.has(species.speciesId)) {
      throw new Error(`Duplicate Floor 3 speciesId: ${species.speciesId}`);
    }
    seenIds.add(species.speciesId);
    if (species.signature !== true) {
      const cell = `${species.affinity}/${species.fightingStyle}`;
      if (seenCells.has(cell)) {
        throw new Error(`Duplicate Floor 3 grid cell: ${cell}`);
      }
      seenCells.add(cell);
    }
  }
  for (const affinity of AFFINITY_RING) {
    for (const style of FIGHTING_STYLES) {
      if (!seenCells.has(`${affinity}/${style}`)) {
        throw new Error(`Missing Floor 3 grid cell: ${affinity}/${style}`);
      }
    }
  }

  cachedSpecies = Object.freeze(parsed.slice());
  return cachedSpecies;
}

/** Look up one species by its stable id, or `undefined` when unknown. */
export function getPetSpecies(speciesId: string): PetSpeciesDef | undefined {
  return loadPetSpecies().find((species) => species.speciesId === speciesId);
}

/** All species of one affinity (7 grid species plus any signature lines). */
export function petSpeciesByAffinity(affinity: Affinity): readonly PetSpeciesDef[] {
  return loadPetSpecies().filter((species) => species.affinity === affinity);
}

/** All species of one fighting style (7 grid species plus any signature lines). */
export function petSpeciesByStyle(style: FightingStyle): readonly PetSpeciesDef[] {
  return loadPetSpecies().filter((species) => species.fightingStyle === style);
}

/** The form a species is in at `level` (0 baby / 1 adolescent / 2 adult). */
export function formForLevel(species: PetSpeciesDef, level: number): PetFormDef {
  let current = species.forms[0];
  for (const form of species.forms) {
    if (level >= form.minLevel) current = form;
  }
  return current;
}

/** Ability ids a species has learned by `level`, in milestone order. */
export function learnedAbilityIds(species: PetSpeciesDef, level: number): readonly string[] {
  return ABILITY_MILESTONE_LEVELS.filter((milestone) => level >= milestone).map(
    (milestone) =>
      species.abilityIdsByLevel[
        String(milestone) as `${(typeof ABILITY_MILESTONE_LEVELS)[number]}`
      ],
  );
}

/** Test-only reset of the load cache. */
export function _resetPetSpeciesCache(): void {
  cachedSpecies = null;
}
