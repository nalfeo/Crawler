/**
 * Floor 2 contested-resource definitions — data-driven per ADR 0011 / ADR 0040.
 *
 * The roster lives in `resources.json` and is loaded/validated here through
 * Zod. Every Floor 2 run seeds *one* resource from this pool as the Mother Lode.
 */
import { z } from 'zod';
import resourcesJson from './resources.json';

/** Zod schema for a single contested-resource definition. */
export const resourceDefSchema = z
  .object({
    /** Stable identifier, e.g. `glimmercap`. */
    id: z.string().min(1),
    /** Display name, e.g. "Glimmercap Spores". */
    name: z.string().min(1),
    /** Street name / nickname used in-fiction. */
    streetName: z.string().min(1),
    /** What the resource is refined into (Director commentary flavor). */
    product: z.string().min(1),
  })
  .strict();

export type ResourceDef = z.infer<typeof resourceDefSchema>;

const resourceRosterSchema = z.array(resourceDefSchema).min(10).max(20);

let cachedResources: readonly ResourceDef[] | null = null;

/**
 * Load and validate all resource definitions. Enforces id uniqueness and the
 * 10–20 pool size the Floor 2 spec calls for.
 */
export function loadResources(): readonly ResourceDef[] {
  if (cachedResources !== null) return cachedResources;
  const parsed = resourceRosterSchema.parse(resourcesJson);
  const seen = new Set<string>();
  for (const r of parsed) {
    if (seen.has(r.id)) {
      throw new Error(`Duplicate resource id: ${r.id}`);
    }
    seen.add(r.id);
  }
  cachedResources = Object.freeze(parsed.slice());
  return cachedResources;
}

/** Test-only reset of the load cache. */
export function _resetResourceCache(): void {
  cachedResources = null;
}
