/**
 * Placeholder-replacement audit — pure logic.
 *
 * Answers one question deterministically: "Given the art the project knows
 * about, which placeholders now have a real generated asset that could replace
 * them?" Used by the `placeholder-audit` skill after new art lands.
 *
 * The project carries placeholders in three places:
 *   1. The generated manifest — entries whose `sourceRun`/`sensorScore` is
 *      `"placeholder"` or whose asset path ends in `-placeholder.png`. These
 *      back item icons (an item resolves its sprite via `resolveItemSprite`,
 *      which is version-tolerant and de-prioritizes these placeholders; ADR 0051).
 *   2. The engine sprite registry (`SPRITES`) — temp CC0 Kenney frames whose
 *      `note` says "temp CC0 art" (e.g. `enemy.slime`, `enemy.rat`, `player`).
 *   3. Mob defs — any mob whose `spriteId` is the shared `mob-placeholder`.
 *   4. Enemy-pack archetypes — any configured enemy archetype id that still has
 *      no dedicated real generated asset under its own concept id.
 *
 * Real generated assets carry a versioned briefId (`slime-queen`), so they
 * do NOT auto-wire over a bare-concept placeholder (`slime-queen`); that
 * version asymmetry is exactly the wiring gap this audit surfaces.
 *
 * This module is pure: no IO, no globals, no Phaser. All inputs are passed in
 * so it is trivially unit-testable. The CLI wrapper
 * (`placeholder-audit-cli.ts`) does the file/git IO and maps real project data
 * onto these inputs.
 */

import type { ManifestEntry } from '../../src/shared/generated-assets.js';

/** The shared generic placeholder spriteId every un-arted mob falls back to. */
export const MOB_PLACEHOLDER_SPRITE_ID = 'mob-placeholder';

/** Where a placeholder reference was found. */
export type PlaceholderSourceKind = 'manifest' | 'sprite-registry' | 'mob-def' | 'enemy-pack';

/** A single placeholder still present in the project, tagged with its source. */
export interface PlaceholderRef {
  readonly kind: PlaceholderSourceKind;
  /** Source-native id: manifest map key, sprite registry id, or mob id. */
  readonly id: string;
  /** Human detail: asset path, registry note, or the placeholder spriteId. */
  readonly detail: string;
}

/** A real (non-placeholder) generated asset. */
export interface RealAssetRef {
  /** Versioned brief id, e.g. `slime-queen`. */
  readonly briefId: string;
  /** Variant texture/sprite name, e.g. `slime-queen-var-0`. */
  readonly spriteName: string;
  /** `public/`-relative asset path, forward-slashed. */
  readonly assetPath: string;
  /** True when this asset was added since the `--since` git ref. */
  readonly isNew: boolean;
}

/** Everything known about one normalized concept (e.g. `slime-queen`). */
export interface ConceptAudit {
  readonly concept: string;
  readonly placeholders: readonly PlaceholderRef[];
  readonly realAssets: readonly RealAssetRef[];
}

/** A heuristic name-relation between a placeholder concept and a real concept. */
export interface RelatedSuggestion {
  readonly placeholderConcept: string;
  readonly realConcept: string;
  readonly placeholders: readonly PlaceholderRef[];
  readonly realAssets: readonly RealAssetRef[];
}

export interface PlaceholderAuditCounts {
  readonly concepts: number;
  readonly replaceable: number;
  readonly newRealAssets: number;
  readonly newReplaceable: number;
  readonly placeholderOnly: number;
  readonly relatedSuggestions: number;
}

export interface PlaceholderAuditReport {
  /** Concepts that have at least one placeholder AND at least one real asset. */
  readonly replaceable: readonly ConceptAudit[];
  /** Concepts with a real asset but no same-name placeholder (new content). */
  readonly newContent: readonly ConceptAudit[];
  /** Concepts with a placeholder but no real asset yet (still need art). */
  readonly placeholderOnly: readonly ConceptAudit[];
  /** Heuristic name links (e.g. `slime` placeholder ~> `slime-queen` real). */
  readonly relatedSuggestions: readonly RelatedSuggestion[];
  /** Every concept, sorted by name — the full picture. */
  readonly concepts: readonly ConceptAudit[];
  readonly counts: PlaceholderAuditCounts;
  /** True when the audit was scoped to assets added since a git ref. */
  readonly scopedToNew: boolean;
}

/** Minimal shape of a sprite registry entry this audit needs. */
export interface SpriteRegistryLike {
  readonly id: string;
  readonly note?: string;
}

/** Minimal shape of a mob def this audit needs. */
export interface MobDefLike {
  readonly id: string;
  readonly spriteId: string;
}

export interface PlaceholderAuditInput {
  /** Parsed generated-manifest entries, keyed by manifest map key. */
  readonly manifestEntries: Readonly<Record<string, ManifestEntry>>;
  /** Engine sprite registry entries (`SPRITES`). */
  readonly spriteRegistry: readonly SpriteRegistryLike[];
  /** Mob defs to scan for `mob-placeholder` usage. */
  readonly mobDefs: readonly MobDefLike[];
  /**
   * Enemy archetype IDs that should have dedicated generated art. Any id whose
   * concept lacks a real generated asset is tracked as a placeholder-needed mob.
   */
  readonly enemyArchetypeIds?: readonly string[];
  /**
   * `public/`-relative, forward-slashed asset paths added since a git ref.
   * When provided, real assets are flagged `isNew` and the report is scoped:
   * `replaceable`/`newContent` only include concepts touching a new asset.
   */
  readonly newAssetPaths?: ReadonlySet<string>;
}

/**
 * Normalize an art name down to its bare concept so a placeholder and its real
 * replacement collapse to the same key.
 *
 * Examples:
 *   `slime-queen-var-0` -> `slime-queen`
 *   `iron-sword-v1`        -> `iron-sword`
 *   `aether-dust-placeholder` -> `aether-dust`
 *   `enemy.slime`          -> `slime`
 *   `npc.guide`            -> `guide`
 */
export function normalizeConcept(name: string): string {
  const lastSegment = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
  return lastSegment
    .trim()
    .toLowerCase()
    .replace(/-var-\d+$/, '')
    .replace(/-v\d+$/, '')
    .replace(/-placeholder$/, '');
}

/** True when a manifest entry is a placeholder rather than real generated art. */
export function isPlaceholderManifestEntry(entry: ManifestEntry): boolean {
  return (
    entry.sourceRun === 'placeholder' ||
    entry.sensorScore === 'placeholder' ||
    /-placeholder\.png$/i.test(entry.assetPath)
  );
}

/** True when a sprite registry note marks a temporary placeholder frame. */
export function isPlaceholderSpriteNote(note: string | undefined): boolean {
  if (!note) return false;
  return /temp\s+cc0\s+art|placeholder/i.test(note);
}

interface MutableConcept {
  concept: string;
  placeholders: PlaceholderRef[];
  realAssets: RealAssetRef[];
}

function conceptFor(map: Map<string, MutableConcept>, concept: string): MutableConcept {
  let entry = map.get(concept);
  if (!entry) {
    entry = { concept, placeholders: [], realAssets: [] };
    map.set(concept, entry);
  }
  return entry;
}

/**
 * Build the placeholder-replacement audit from project data. Deterministic and
 * pure — given the same inputs it always returns the same report.
 */
export function buildPlaceholderAudit(input: PlaceholderAuditInput): PlaceholderAuditReport {
  const scopedToNew = input.newAssetPaths !== undefined;
  const newAssetPaths = input.newAssetPaths ?? new Set<string>();
  const byConcept = new Map<string, MutableConcept>();

  // 1. Manifest entries: split into placeholders vs real generated assets.
  for (const [mapKey, entry] of Object.entries(input.manifestEntries)) {
    const concept = normalizeConcept(entry.briefId || mapKey);
    const bucket = conceptFor(byConcept, concept);
    if (isPlaceholderManifestEntry(entry)) {
      bucket.placeholders.push({
        kind: 'manifest',
        id: mapKey,
        detail: entry.assetPath,
      });
    } else {
      bucket.realAssets.push({
        briefId: entry.briefId,
        spriteName: entry.spriteName,
        assetPath: entry.assetPath,
        isNew: newAssetPaths.has(entry.assetPath),
      });
    }
  }

  // 2. Sprite registry: temp CC0 frames are placeholders in active use.
  for (const sprite of input.spriteRegistry) {
    if (!isPlaceholderSpriteNote(sprite.note)) continue;
    const bucket = conceptFor(byConcept, normalizeConcept(sprite.id));
    bucket.placeholders.push({
      kind: 'sprite-registry',
      id: sprite.id,
      detail: sprite.note ?? '',
    });
  }

  // 3. Mob defs still pointing at the shared generic placeholder.
  for (const mob of input.mobDefs) {
    if (mob.spriteId !== MOB_PLACEHOLDER_SPRITE_ID) continue;
    const bucket = conceptFor(byConcept, normalizeConcept(mob.id));
    bucket.placeholders.push({
      kind: 'mob-def',
      id: mob.id,
      detail: mob.spriteId,
    });
  }

  // 4. Enemy archetypes with no dedicated generated art yet.
  for (const archetypeId of input.enemyArchetypeIds ?? []) {
    const bucket = conceptFor(byConcept, normalizeConcept(archetypeId));
    if (bucket.realAssets.length > 0) continue;
    bucket.placeholders.push({
      kind: 'enemy-pack',
      id: archetypeId,
      detail: 'missing-generated-art',
    });
  }

  const concepts: ConceptAudit[] = Array.from(byConcept.values())
    .map((entry) => ({
      concept: entry.concept,
      placeholders: sortPlaceholders(entry.placeholders),
      realAssets: sortRealAssets(entry.realAssets),
    }))
    .sort((a, b) => a.concept.localeCompare(b.concept));

  const touchesNew = (audit: ConceptAudit): boolean =>
    !scopedToNew || audit.realAssets.some((asset) => asset.isNew);

  const replaceable = concepts.filter(
    (audit) => audit.placeholders.length > 0 && audit.realAssets.length > 0 && touchesNew(audit),
  );
  const newContent = concepts.filter(
    (audit) => audit.placeholders.length === 0 && audit.realAssets.length > 0 && touchesNew(audit),
  );
  const placeholderOnly = concepts.filter(
    (audit) => audit.placeholders.length > 0 && audit.realAssets.length === 0,
  );

  const relatedSuggestions = buildRelatedSuggestions(concepts, scopedToNew);

  const newRealAssets = concepts.reduce(
    (sum, audit) => sum + audit.realAssets.filter((asset) => asset.isNew).length,
    0,
  );

  return {
    replaceable,
    newContent,
    placeholderOnly,
    relatedSuggestions,
    concepts,
    scopedToNew,
    counts: {
      concepts: concepts.length,
      replaceable: replaceable.length,
      newRealAssets,
      newReplaceable: replaceable.filter((audit) => audit.realAssets.some((a) => a.isNew)).length,
      placeholderOnly: placeholderOnly.length,
      relatedSuggestions: relatedSuggestions.length,
    },
  };
}

/**
 * Heuristic: a placeholder concept and a real concept are "related" when one is
 * a hyphen-delimited prefix of the other (e.g. `slime` ~> `slime-queen`). These
 * are suggestions only — never authoritative — because the names merely share a
 * stem rather than collapsing to an identical concept.
 */
function buildRelatedSuggestions(
  concepts: readonly ConceptAudit[],
  scopedToNew: boolean,
): RelatedSuggestion[] {
  const placeholderConcepts = concepts.filter((audit) => audit.placeholders.length > 0);
  const realConcepts = concepts.filter((audit) => audit.realAssets.length > 0);
  const out: RelatedSuggestion[] = [];
  for (const ph of placeholderConcepts) {
    for (const real of realConcepts) {
      if (ph.concept === real.concept) continue;
      const related =
        real.concept.startsWith(`${ph.concept}-`) || ph.concept.startsWith(`${real.concept}-`);
      if (!related) continue;
      if (scopedToNew && !real.realAssets.some((asset) => asset.isNew)) continue;
      out.push({
        placeholderConcept: ph.concept,
        realConcept: real.concept,
        placeholders: ph.placeholders,
        realAssets: real.realAssets,
      });
    }
  }
  return out;
}

function sortPlaceholders(refs: readonly PlaceholderRef[]): PlaceholderRef[] {
  return [...refs].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}

function sortRealAssets(refs: readonly RealAssetRef[]): RealAssetRef[] {
  return [...refs].sort((a, b) => a.spriteName.localeCompare(b.spriteName));
}
