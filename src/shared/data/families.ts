/**
 * Floor 2 family definitions — data-driven per ADR 0011 / ADR 0040.
 *
 * The roster lives in `families.json` and is loaded/validated here through Zod.
 * The runtime relationship value is NOT stored here (see
 * `world.factionRelations` in `src/core/faction-relations.ts`); this module only
 * defines the *content*.
 */
import { z } from 'zod';
import familiesJson from './families.json';

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** Zod schema for a single boss definition inside a family. */
export const familyBossSchema = z
  .object({
    title: z.string().min(1),
    name: z.string().min(1),
    archetype: z.string().min(1),
  })
  .strict();

/** Zod schema for a single family definition. */
export const familyDefSchema = z
  .object({
    /** Stable identifier, e.g. `goblins`. */
    id: z.string().min(1),
    /** Display name, e.g. "The Snaggle Cartel". */
    name: z.string().min(1),
    /** Species label for flavor/Director commentary. */
    species: z.string().min(1),
    /** Boss info for the family (one boss per family). */
    boss: familyBossSchema,
    /** Preferred AI archetype key used later by the family-aware AI slice. */
    aiArchetype: z.string().min(1),
    /** 6-digit hex color used by the HUD widget and minimap tint. */
    hudColor: z.string().regex(HEX_COLOR_RE, 'hudColor must be #RRGGBB'),
    /** How this family refines the contested resource (Director flavor). */
    refinementStyle: z.string().min(1),
    /** Signature product name (Director flavor). */
    signature: z.string().min(1),
  })
  .strict();

export type FamilyDef = z.infer<typeof familyDefSchema>;

const familyRosterSchema = z.array(familyDefSchema).min(15);

let cachedFamilies: readonly FamilyDef[] | null = null;

/**
 * Load and validate all family definitions. Enforces id uniqueness and the
 * ≥15-family floor required by the Floor 2 spec (FR4).
 */
export function loadFamilies(): readonly FamilyDef[] {
  if (cachedFamilies !== null) return cachedFamilies;
  const parsed = familyRosterSchema.parse(familiesJson);
  const seen = new Set<string>();
  for (const family of parsed) {
    if (seen.has(family.id)) {
      throw new Error(`Duplicate family id: ${family.id}`);
    }
    seen.add(family.id);
  }
  cachedFamilies = Object.freeze(parsed.slice());
  return cachedFamilies;
}

/** Test-only reset of the load cache. */
export function _resetFamilyCache(): void {
  cachedFamilies = null;
}
