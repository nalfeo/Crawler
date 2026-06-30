/**
 * generate-wiring: Given a placeholder-audit report, generate code patches to
 * wire up new generated assets and retire placeholders.
 *
 * This module is pure: no IO, no globals. It examines which placeholders have
 * real assets available and emits code changes needed to wire them up in:
 *   1. src/shared/mobDefs.ts (spriteId replacements)
 *   2. src/engine/PhaserBridge.ts (ENTITY_GENERATED_SPRITE mapping updates)
 *
 * Manifest items (resolved by itemId === briefId) require no code changes.
 *
 * The CLI wrapper (generate-wiring-cli.ts) does file IO and applies the patches.
 */

import type { PlaceholderAuditReport, ConceptAudit } from './placeholder-audit.js';

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
  /** Placeholders in manifest entries (auto-resolved, no code needed). */
  readonly manifestOnly: readonly ConceptAudit[];
  /** Placeholders in sprite registry or mob defs (require wiring). */
  readonly needsWiring: readonly ConceptAudit[];
}

/** Mapping of concept to new generated sprite brief ID. */
interface ConceptMapping {
  readonly newBriefId: string;
  readonly audit: ConceptAudit;
}

/**
 * Generate wiring patches from a placeholder-audit report. Pure.
 *
 * Only processes replaceable placeholders (exact concept match, no suggestions).
 * Skips manifest-only entries (they auto-resolve by itemId === briefId).
 */
export function generateWiringPlan(report: PlaceholderAuditReport): WiringPlan {
  const patches: CodePatch[] = [];
  const needsWiring: ConceptAudit[] = [];
  const manifestOnly: ConceptAudit[] = [];

  // Build a mapping of concept → new brief ID for quick lookup.
  const conceptMapping = new Map<string, ConceptMapping>();
  for (const audit of report.replaceable) {
    // Pick the newest real asset (sorted by spriteName, which includes versioning).
    const newest = audit.realAssets[audit.realAssets.length - 1];
    if (newest) {
      conceptMapping.set(audit.concept, { newBriefId: newest.briefId, audit });
    }
  }

  // Categorize replaceable placeholders.
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
  const patches: CodePatch[] = [];

  for (const audit of needsWiring) {
    for (const placeholder of audit.placeholders) {
      if (placeholder.kind !== 'mob-def') continue;

      const mapping = conceptMapping.get(audit.concept);
      if (!mapping) continue;

      const mobId = placeholder.id;
      const newBriefId = mapping.newBriefId;

      // Pattern: `spriteId: 'mob-placeholder',` in a mob def
      // We need to update it to: `spriteId: '<newBriefId>',`
      // But we can't do a simple replace without context.
      // Instead, we'll search for the mob's definition and replace the spriteId line.

      // For now, we'll emit a patch that replaces the spriteId line in the specific mob.
      // This assumes the mob is defined as an object property.

      const description = `Replace mob "${mobId}" spriteId from 'mob-placeholder' to '${newBriefId}'`;
      const oldPattern = `spriteId: 'mob-placeholder', // ${mobId}`;
      const newPattern = `spriteId: '${newBriefId}', // ${mobId}`;

      // Try a more general pattern first.
      patches.push({
        filePath: 'src/shared/mobDefs.ts',
        description,
        oldText: oldPattern,
        newText: newPattern,
      });
    }
  }

  return patches;
}

/**
 * Generate patches for src/engine/PhaserBridge.ts. The ENTITY_GENERATED_SPRITE
 * mapping is updated to point to the new generated sprite brief IDs.
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
      const newBriefId = mapping.newBriefId;

      // Heuristic: infer entity type from spriteId.
      const entityType = inferEntityTypeFromSprite(spriteId);
      if (!entityType) continue;

      const description = `Update ENTITY_GENERATED_SPRITE[${entityType}] to '${newBriefId}'`;
      const oldPattern = `  ${entityType}: '${inferCurrentBriefId(spriteId)}',`;
      const newPattern = `  ${entityType}: '${newBriefId}',`;

      patches.push({
        filePath: 'src/engine/PhaserBridge.ts',
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
  if (spriteId === 'enemy.boss') return 'enemy_boss';
  if (spriteId === 'enemy.orc') return 'enemy';
  if (spriteId === 'player') return 'player';
  if (spriteId === 'npc.guide') return 'npc';
  // Add more mappings as needed.
  return null;
}

/**
 * Infer the current (placeholder or old) brief ID from a sprite registry ID.
 * Used to generate the old-text pattern in patches.
 */
function inferCurrentBriefId(spriteId: string): string {
  // This is a heuristic; in practice, we'd need to scan the actual file
  // or maintain this mapping. For now, return a placeholder pattern.
  if (spriteId === 'enemy.rat') return 'rat-v1-var-3';
  if (spriteId === 'enemy.slime') return 'slime-v1-var-2';
  if (spriteId === 'enemy.boss') return 'enemy.boss'; // fallback
  if (spriteId === 'player') return 'player';
  return spriteId;
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
  lines.push(`  - Manifest-only (auto-resolved): ${manifestOnly.length}`);
  lines.push(`  - Need wiring (code changes): ${needsWiring.length}`);
  lines.push('');

  if (patches.length > 0) {
    lines.push('Code Patches to Apply:');
    for (const patch of patches) {
      lines.push(`  [${patch.filePath}] ${patch.description}`);
    }
  } else {
    lines.push('No code patches needed (all placeholders are manifest-only).');
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
}
