/**
 * generate-wiring: Given a placeholder-audit report, generate code patches to
 * wire up new generated assets and retire placeholders.
 *
 * This module is pure: no IO, no globals. It examines which placeholders have
 * real assets available and emits code changes needed to wire them up in:
 *   1. src/shared/mobDefs.ts (spriteId replacements)
 *   2. src/shared/data/entity-sprite-mappings.json (renderKinds generated pins)
 *
 * Manifest-only item placeholders are NOT wired here. Item icons resolve via
 * `resolveItemSprite(itemId)` (version-tolerant, placeholder-deprioritized;
 * ADR 0051), so a manifest-only placeholder whose real art is versioned
 * (`iron-ore-v1-var-N`) is a DATA-MIGRATION candidate for
 * `npm run sprites:normalize-names` (re-key the real art to the bare item id
 * and retire the placeholder) — it is NOT auto-resolved by `itemId === briefId`.
 *
 * The CLI wrapper (generate-wiring-cli.ts) does file IO and applies the patches.
 */

import type { PlaceholderAuditReport, ConceptAudit } from './placeholder-audit.js';
import type { EntitySpriteMappings } from '../../src/shared/data/entity-sprite-mappings.js';
import ENTITY_SPRITE_MAPPINGS from '../../src/shared/data/entity-sprite-mappings.json';

/** A single code patch to apply. */
export interface CodePatch {
  /** Absolute path to the file to modify, or `public/`-relative for manifests. */
  readonly filePath: string;
  /** Human description of the change. */
  readonly description: string;
  /** Old text to find and replace. */
  readonly oldText: string;
  /** New text to replace with. */
  readonly newText: string;
}

/** Results of wiring generation. */
export interface WiringPlan {
  /** Code patches to apply to files. */
  readonly patches: readonly CodePatch[];
  /** Rendered patch summary (for human review). */
  readonly summary: string;
  /** Total replaceable placeholders that can be wired. */
  readonly replaceableCount: number;
  /**
   * Manifest-only placeholders (no mob-def / sprite-registry reference). For an
   * ITEM whose real art is versioned, this is a data-migration candidate
   * (`sprites:normalize-names`), NOT an auto-resolved no-op: the bare item id
   * matches only the placeholder briefId until the real art is re-keyed bare.
   * Runtime resolution is handled separately by `resolveItemSprite` (ADR 0051).
   */
  readonly manifestOnly: readonly ConceptAudit[];
  /** Placeholders in sprite registry or mob defs (require wiring). */
  readonly needsWiring: readonly ConceptAudit[];
}

/** Mapping of concept to new generated sprite brief ID. */
interface ConceptMapping {
  readonly newBriefId: string;
  readonly newTextureKey: string;
  readonly audit: ConceptAudit;
}

/**
 * Generate wiring patches from a placeholder-audit report. Pure.
 *
 * Only processes replaceable placeholders (exact concept match, no suggestions).
 * Skips manifest-only entries: they carry no mob-def / sprite-registry code
 * reference to patch. Item icons resolve at runtime via `resolveItemSprite`
 * (ADR 0051); a manifest-only item placeholder with versioned real art is a
 * `sprites:normalize-names` data-migration candidate, not a code patch.
 */
export function generateWiringPlan(report: PlaceholderAuditReport): WiringPlan {
  const patches: CodePatch[] = [];
  const needsWiring: ConceptAudit[] = [];
  const manifestOnly: ConceptAudit[] = [];

  // Build a mapping of concept -> newest generated asset for quick lookup.
  const conceptMapping = new Map<string, ConceptMapping>();
  for (const audit of report.replaceable) {
    // Pick the newest real asset (sorted by spriteName, which includes versioning).
    const newest = audit.realAssets[audit.realAssets.length - 1];
    if (newest) {
      conceptMapping.set(audit.concept, {
        newBriefId: newest.briefId,
        newTextureKey: newest.spriteName,
        audit,
      });
    }
  }

  // Categorizes replaceable placeholders.
  for (const audit of report.replaceable) {
    const hasMobDef = audit.placeholders.some((p) => p.kind === 'mob-def');
    const hasSpriteRegistry = audit.placeholders.some((p) => p.kind === 'sprite-registry');
    const hasManifest = audit.placeholders.some((p) => p.kind === 'manifest');

    if (hasMobDef || hasSpriteRegistry) {
      needsWiring.push(audit);
    } else if (hasManifest) {
      manifestOnly.push(audit);
    }
  }

  // Generate patches for mob defs.
  const mobDefPatches = generateMobDefPatches(needsWiring, conceptMapping);
  patches.push(...mobDefPatches);

  // Generate patches for ENTITY_GENERATED_SPRITE.
  const entitySpritePatches = generateEntitySpritePatches(needsWiring, conceptMapping);
  patches.push(...entitySpritePatches);

  const summary = renderWiringSummary(report.replaceable, manifestOnly, needsWiring, patches);

  return {
    patches,
    summary,
    replaceableCount: report.replaceable.length,
    manifestOnly,
    needsWiring,
  };
}

/**
 * Generate patches for src/shared/mobDefs.ts. Each mob using `mob-placeholder`
 * spriteId is updated to point to the new generated sprite.
 */
function generateMobDefPatches(
  needsWiring: readonly ConceptAudit[],
  conceptMapping: Map<string, ConceptMapping>,
): CodePatch[] {
  void needsWiring;
  void conceptMapping;
  // Mob defs require block-aware anchoring in src/shared/mobDefs.ts. Until we have
  // an AST/block-aware patch generator, avoid emitting brittle replace patches.
  return [];
}

/**
 * Generate patches for src/shared/data/entity-sprite-mappings.json. The
 * renderKinds.<entity>.generated.pinnedTextureKey is updated to point to the
 * newest generated sprite variant.
 */
function generateEntitySpritePatches(
  needsWiring: readonly ConceptAudit[],
  conceptMapping: Map<string, ConceptMapping>,
): CodePatch[] {
  const patches: CodePatch[] = [];

  for (const audit of needsWiring) {
    for (const placeholder of audit.placeholders) {
      if (placeholder.kind !== 'sprite-registry') continue;

      const mapping = conceptMapping.get(audit.concept);
      if (!mapping) continue;

      const spriteId = placeholder.id; // e.g., 'enemy.rat'
      const newTextureKey = mapping.newTextureKey;

      // Only emit replacement patches for sprite IDs with existing generated mappings.
      const entityType = inferEntityTypeFromSprite(spriteId);
      if (!entityType) continue;

      const currentTextureKey = inferCurrentTextureKey(entityType);
      if (!currentTextureKey) continue;
      if (currentTextureKey === newTextureKey) continue;

      const description = `Update renderKinds.${entityType}.generated.pinnedTextureKey to '${newTextureKey}'`;
      const oldPattern = `"pinnedTextureKey": "${currentTextureKey}"`;
      const newPattern = `"pinnedTextureKey": "${newTextureKey}"`;

      patches.push({
        filePath: 'src/shared/data/entity-sprite-mappings.json',
        description,
        oldText: oldPattern,
        newText: newPattern,
      });
    }
  }

  return patches;
}

/**
 * Try to infer the entity-type key from a sprite registry ID.
 * E.g., 'enemy.rat' → 'enemy_rat', 'enemy.slime' → 'enemy_slime'.
 */
function inferEntityTypeFromSprite(spriteId: string): string | null {
  if (spriteId === 'enemy.rat') return 'enemy_rat';
  if (spriteId === 'enemy.slime') return 'enemy_slime';
  return null;
}

/**
 * Read the current generated pinned texture key from renderKinds config.
 */
function inferCurrentTextureKey(entityType: string): string | null {
  const renderKinds = (ENTITY_SPRITE_MAPPINGS as EntitySpriteMappings).renderKinds;
  return renderKinds[entityType]?.generated?.pinnedTextureKey ?? null;
}

/**
 * Render a human-readable summary of the wiring plan.
 */
function renderWiringSummary(
  replaceable: readonly ConceptAudit[],
  manifestOnly: readonly ConceptAudit[],
  needsWiring: readonly ConceptAudit[],
  patches: readonly CodePatch[],
): string {
  const lines: string[] = [];
  lines.push('Wiring Plan Summary');
  lines.push('='.repeat('Wiring Plan Summary'.length));
  lines.push('');

  lines.push(`Replaceable placeholders found: ${replaceable.length}`);
  lines.push(`  - Manifest-only (migrate via sprites:normalize-names): ${manifestOnly.length}`);
  lines.push(`  - Need wiring (code changes): ${needsWiring.length}`);
  lines.push('');

  if (patches.length > 0) {
    lines.push('Code Patches to Apply:');
    for (const patch of patches) {
      lines.push(`  [${patch.filePath}] ${patch.description}`);
    }
  } else {
    lines.push(
      'No code patches needed. Any manifest-only item placeholders are ' +
        'data-migration candidates (sprites:normalize-names), not code wiring.',
    );
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
}
