import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import {
  briefKey,
  resolveArtPlanStatus,
  resolveIntegrationState,
  type ArtPlanStatus,
  type IntegrationState,
} from '../shared/art-plan-status.js';

const spriteTypes = [
  'weapon',
  'equipment',
  'enemy',
  'item',
  'prop',
  'tile',
  'vfx',
  'character',
] as const;

const integrationTargetSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('sprite-registry'),
      id: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('item-catalog'),
      id: z.string().trim().min(1),
    })
    .strict(),
]);

const assetPlanEntrySchema = z
  .object({
    id: z.string().trim().min(1),
    type: z.enum(spriteTypes),
    label: z.string().trim().min(1),
    brief: z.string().trim().min(1),
    briefId: z.string().trim().min(1).optional(),
    briefOverrides: z.record(z.string(), z.unknown()).optional(),
    placeholderInUse: z.boolean().default(true),
    integration: integrationTargetSchema.optional(),
  })
  .strict();

const assetPlanSchema = z
  .object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    summary: z.string().trim().default(''),
    assets: z.array(assetPlanEntrySchema).min(1),
  })
  .strict();

const minimalBriefSchema = z
  .object({
    type: z.enum(spriteTypes),
    name: z.string().trim().min(1),
  })
  .passthrough();

export type FloorArtPlan = z.infer<typeof assetPlanSchema>;
export type FloorArtAsset = z.infer<typeof assetPlanEntrySchema>;
export type IntegrationTarget = z.infer<typeof integrationTargetSchema>;

export type { IntegrationState };
/** Alias kept for backward compatibility — same values as ArtPlanStatus. */
export type FloorArtStatus = ArtPlanStatus;

export interface ApprovedSpriteEntry {
  readonly briefId: string;
  readonly assetPath: string;
  readonly sourceRun: string;
  readonly variantIndex: number;
  readonly exists: boolean;
}

export interface FloorArtAssetReport {
  readonly id: string;
  readonly type: FloorArtAsset['type'];
  readonly label: string;
  readonly briefId: string;
  readonly sourceRun: string | null;
  readonly variantIndex: number | null;
  readonly placeholderInUse: boolean;
  readonly integration: IntegrationTarget | null;
  readonly briefAuthored: boolean;
  readonly draftAuthored: boolean;
  readonly approved: boolean;
  readonly approvedAssetExists: boolean;
  readonly integrationState: IntegrationState;
  readonly status: FloorArtStatus;
}

export interface FloorArtPlanReport {
  readonly planId: string;
  readonly title: string;
  readonly summary: string;
  readonly assets: readonly FloorArtAssetReport[];
  readonly counts: Readonly<Record<FloorArtStatus, number>>;
  readonly unresolvedPlaceholders: number;
}

export const STATUS_ORDER: readonly FloorArtStatus[] = [
  'ready',
  'approved',
  'approved-not-integrated',
  'approved-missing-file',
  'brief-ready',
  'brief-ready-placeholder',
  'draft-ready',
  'draft-ready-placeholder',
  'needs-art-placeholder',
  'planned',
] as const;

export function parseFloorArtPlans(rawPlans: Readonly<Record<string, string>>): FloorArtPlan[] {
  const parsed: FloorArtPlan[] = [];
  for (const source of Object.values(rawPlans)) {
    const value = parseYaml(source) as unknown;
    const result = assetPlanSchema.safeParse(value);
    if (result.success) {
      parsed.push(result.data);
    }
  }
  return parsed.sort((left, right) => left.id.localeCompare(right.id));
}

export function parseCommittedBriefKeys(rawBriefs: Readonly<Record<string, string>>): Set<string> {
  return parseBriefKeys(rawBriefs, 'committed');
}

export function parseDraftBriefKeys(rawBriefs: Readonly<Record<string, string>>): Set<string> {
  return parseBriefKeys(rawBriefs, 'draft');
}

function parseBriefKeys(
  rawBriefs: Readonly<Record<string, string>>,
  mode: 'committed' | 'draft',
): Set<string> {
  const keys = new Set<string>();
  for (const [path, source] of Object.entries(rawBriefs)) {
    const isDraft = path.toLowerCase().includes('/draft/');
    if (mode === 'committed' && isDraft) {
      continue;
    }
    if (mode === 'draft' && !isDraft) {
      continue;
    }
    const value = parseYaml(source) as unknown;
    const result = minimalBriefSchema.safeParse(value);
    if (!result.success) {
      continue;
    }
    keys.add(briefKey(result.data.type, result.data.name));
  }
  return keys;
}

export function parseApprovedSprites(
  manifest: unknown,
  options: { existingAssets: ReadonlySet<string> },
): Map<string, ApprovedSpriteEntry> {
  const out = new Map<string, ApprovedSpriteEntry>();
  const parsed = generatedManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    return out;
  }
  for (const [mapKey, entry] of Object.entries(parsed.data.entries)) {
    if (entry.sourceRun === 'placeholder') {
      continue;
    }
    const briefId = entry.briefId || mapKey;
    out.set(briefId, {
      briefId,
      assetPath: entry.assetPath,
      sourceRun: entry.sourceRun,
      variantIndex: entry.variantIndex,
      exists: options.existingAssets.has(entry.assetPath),
    });
  }
  return out;
}

export function buildFloorArtPlanReport(
  plan: FloorArtPlan,
  options: {
    readonly briefKeys: ReadonlySet<string>;
    readonly draftBriefKeys: ReadonlySet<string>;
    readonly approvedSprites: ReadonlyMap<string, ApprovedSpriteEntry>;
    readonly spriteRegistryIds: ReadonlySet<string>;
    readonly itemCatalogIds: ReadonlySet<string>;
  },
): FloorArtPlanReport {
  const assets: FloorArtAssetReport[] = plan.assets.map((asset) => {
    const briefId = asset.briefId ?? asset.id;
    const briefAuthored = options.briefKeys.has(briefKey(asset.type, briefId));
    const draftAuthored = options.draftBriefKeys.has(briefKey(asset.type, briefId));
    const approvedEntry = options.approvedSprites.get(briefId);
    const approved = approvedEntry !== undefined;
    const approvedAssetExists = approvedEntry?.exists ?? false;
    const integrationState = resolveIntegrationState(
      asset.integration,
      approvedAssetExists,
      options.spriteRegistryIds,
      options.itemCatalogIds,
    );
    return {
      id: asset.id,
      type: asset.type,
      label: asset.label,
      briefId,
      sourceRun: approvedEntry?.sourceRun ?? null,
      variantIndex: approvedEntry?.variantIndex ?? null,
      placeholderInUse: asset.placeholderInUse,
      integration: asset.integration ?? null,
      briefAuthored,
      draftAuthored,
      approved,
      approvedAssetExists,
      integrationState,
      status: resolveArtPlanStatus({
        briefAuthored,
        draftAuthored,
        approved,
        approvedAssetExists,
        integrationState,
        placeholderInUse: asset.placeholderInUse,
      }),
    };
  });

  const counts = Object.fromEntries(STATUS_ORDER.map((status) => [status, 0])) as Record<
    FloorArtStatus,
    number
  >;
  for (const asset of assets) {
    counts[asset.status] += 1;
  }
  const unresolvedPlaceholders = assets.filter(
    (asset) => asset.placeholderInUse && asset.status !== 'ready',
  ).length;

  return {
    planId: plan.id,
    title: plan.title,
    summary: plan.summary,
    assets,
    counts,
    unresolvedPlaceholders,
  };
}

const manifestEntrySchema = z
  .object({
    briefId: z.string().min(1),
    assetPath: z.string().min(1),
    sourceRun: z.string().min(1),
    variantIndex: z.number().int().min(0),
  })
  .passthrough();

const generatedManifestSchema = z
  .object({
    version: z.literal(1),
    entries: z.record(z.string(), manifestEntrySchema),
  })
  .strict();
