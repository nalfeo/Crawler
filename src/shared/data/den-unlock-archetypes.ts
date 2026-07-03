/**
 * Floor 2 den-unlock objective archetypes — the pool the floor-init step
 * seeds one entry per present family from (FR13). Each archetype describes a
 * quest *template*: `initializeFloor2Bosses` clones one per family and
 * substitutes the family id into the ids / goal flags before installing the
 * concrete quest pack via `installQuestPacks`.
 *
 * See:
 *   - `.specify/specs/floor2-family-territories.md` FR13
 *   - `docs/knowledge/game-design/floor2-families-and-resources.md` §5
 *   - `docs/knowledge/adr/0040-floor2-family-territory-and-relationship-architecture.md` D4
 */
import { z } from 'zod';
import archetypesJson from './quests.floor2.dens.json';

const baseSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    summary: z.string().min(1),
    objectiveLabel: z.string().min(1),
  })
  .strict();

const killTargetsArchetypeSchema = baseSchema.extend({
  kind: z.literal('killTargets'),
  killTarget: z.number().int().positive(),
});

const collectArchetypeSchema = baseSchema.extend({
  kind: z.literal('collect'),
  itemIdSuffix: z.string().min(1),
  collectTarget: z.number().int().positive(),
});

const friendlyArchetypeSchema = baseSchema.extend({
  kind: z.literal('friendly'),
});

const goalFlagArchetypeSchema = baseSchema.extend({
  kind: z.literal('goalFlag'),
  goalIdSuffix: z.string().min(1),
});

const archetypeSchema = z.discriminatedUnion('kind', [
  killTargetsArchetypeSchema,
  collectArchetypeSchema,
  friendlyArchetypeSchema,
  goalFlagArchetypeSchema,
]);

/** Union of all den-unlock archetype variants. */
export type DenUnlockArchetype = z.infer<typeof archetypeSchema>;

const archetypesFileSchema = z
  .object({
    version: z.literal(1),
    packId: z.string().min(1),
    archetypes: z.array(archetypeSchema).min(6),
  })
  .strict();

let cached: readonly DenUnlockArchetype[] | null = null;

/**
 * Load and validate all den-unlock archetypes. Requires ≥6 entries — one per
 * unlock-objective type documented in FR13.
 */
export function loadDenUnlockArchetypes(): readonly DenUnlockArchetype[] {
  if (cached !== null) return cached;
  const parsed = archetypesFileSchema.parse(archetypesJson);
  const seen = new Set<string>();
  for (const archetype of parsed.archetypes) {
    if (seen.has(archetype.id)) {
      throw new Error(`Duplicate den-unlock archetype id: ${archetype.id}`);
    }
    seen.add(archetype.id);
  }
  cached = Object.freeze(parsed.archetypes.slice());
  return cached;
}

/** Test-only reset of the load cache. */
export function _resetDenUnlockArchetypeCache(): void {
  cached = null;
}
