import { z } from 'zod';
import manifestJson from './data/queen-mab-art-manifest.json';

/**
 * Strict, versioned, extensible manifest of Queen Mab's generated replacement
 * art. It is deliberately Node-side only (never bundled into the game) and
 * scoped to Queen Mab for this arena slice, but the schema is shaped so the
 * other 17 Floor 2 abilities can be appended later without a rewrite.
 *
 * Every required visual phase must declare a procedural/placeholder fallback,
 * and every generated-art asset must be non-blocking for the arena slice — the
 * validator proves both invariants so the arena can ship on procedural visuals
 * while the real art remains an optional upgrade path.
 */
const idSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const externalIssueRefSchema = z
  .object({
    kind: z.literal('issue'),
    number: z.number().int().positive(),
    url: z.string().url(),
  })
  .strict();

const dimensionsSchema = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    frames: z.number().int().positive(),
  })
  .strict();

const requiredVisualPhaseSchema = z
  .object({
    phaseId: idSchema,
    description: z.string().min(10),
    proceduralFallback: z.string().min(10),
    renderer: z.string().min(1),
  })
  .strict();

const assetReferencesSchema = z
  .object({
    issue: externalIssueRefSchema.nullable(),
    briefPath: z.string().min(1).nullable(),
    approvedAssetId: idSchema.nullable(),
  })
  .strict();

const assetSchema = z
  .object({
    assetId: idSchema,
    abilityId: idSchema,
    bossId: idSchema,
    kind: z.enum(['codex-icon', 'status-icon', 'cast-animation', 'vfx-sprite']),
    dimensions: dimensionsSchema.nullable(),
    state: z.enum(['not-requested', 'planned', 'requested', 'in-progress', 'approved', 'verified']),
    references: assetReferencesSchema,
    proceduralFallback: z.string().min(10),
    coversPhaseId: idSchema.nullable(),
    requiredFor: z.enum(['arena', 'production-enablement', 'optional-polish']),
    blockingForArena: z.literal(false),
  })
  .strict();

export const queenMabArtManifestSchema = z
  .object({
    schemaVersion: z.literal('mob-ability-art-manifest/v1'),
    generatedArtScope: z.literal('queen-mab-only'),
    lastReviewedAt: z.iso.date(),
    boss: z
      .object({
        bossId: idSchema,
        bossArchetypeId: idSchema,
        familyId: idSchema,
      })
      .strict(),
    requiredVisualPhases: z.array(requiredVisualPhaseSchema).min(1),
    assets: z.array(assetSchema).min(1),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const phaseIds = new Set<string>();
    for (const [index, phase] of manifest.requiredVisualPhases.entries()) {
      if (phaseIds.has(phase.phaseId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['requiredVisualPhases', index, 'phaseId'],
          message: `duplicate visual phase "${phase.phaseId}"`,
        });
      }
      phaseIds.add(phase.phaseId);
    }

    const assetIds = new Set<string>();
    for (const [index, asset] of manifest.assets.entries()) {
      if (assetIds.has(asset.assetId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['assets', index, 'assetId'],
          message: `duplicate asset "${asset.assetId}"`,
        });
      }
      assetIds.add(asset.assetId);
      if (asset.coversPhaseId !== null && !phaseIds.has(asset.coversPhaseId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['assets', index, 'coversPhaseId'],
          message: `asset references unknown visual phase "${asset.coversPhaseId}"`,
        });
      }
    }
  });

export type QueenMabArtManifest = z.infer<typeof queenMabArtManifestSchema>;
export type QueenMabArtAsset = QueenMabArtManifest['assets'][number];
export type QueenMabRequiredVisualPhase = QueenMabArtManifest['requiredVisualPhases'][number];

/** The seven required visual phases from the issue's presentation contract. */
export const REQUIRED_VISUAL_PHASE_IDS = [
  'cast-start-cue',
  'locked-telegraph-circle',
  'anticipation-fill',
  'resolution-burst',
  'tarnished-indicator',
  'cleanup-expiry',
  'announcement',
] as const;

/**
 * Parse + validate the manifest and prove fallback completeness: every required
 * visual phase declares a non-empty procedural fallback, and no generated-art
 * asset is a blocker for the arena slice.
 */
export function loadQueenMabArtManifest(json: unknown = manifestJson): QueenMabArtManifest {
  const manifest = queenMabArtManifestSchema.parse(json);
  const errors: string[] = [];

  const declaredPhaseIds = new Set(manifest.requiredVisualPhases.map((phase) => phase.phaseId));
  for (const requiredPhaseId of REQUIRED_VISUAL_PHASE_IDS) {
    if (!declaredPhaseIds.has(requiredPhaseId)) {
      errors.push(`missing required visual phase "${requiredPhaseId}"`);
    }
  }

  for (const phase of manifest.requiredVisualPhases) {
    if (phase.proceduralFallback.trim().length === 0) {
      errors.push(`visual phase "${phase.phaseId}" has no procedural fallback`);
    }
  }

  for (const asset of manifest.assets) {
    if (asset.blockingForArena !== false) {
      errors.push(`asset "${asset.assetId}" must be non-blocking for the arena slice`);
    }
    if (asset.proceduralFallback.trim().length === 0) {
      errors.push(`asset "${asset.assetId}" has no procedural fallback`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid Queen Mab art manifest:\n- ${errors.join('\n- ')}`);
  }
  return manifest;
}

export const QUEEN_MAB_ART_MANIFEST = loadQueenMabArtManifest();
