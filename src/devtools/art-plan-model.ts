import { z } from 'zod';
import { parse as parseYaml } from 'yaml';

const spriteTypes = ['weapon', 'enemy', 'item', 'tile', 'vfx', 'character'] as const;

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

export type IntegrationState = 'integrated' | 'missing' | 'not-applicable';
export type FloorArtStatus =
  | 'ready'
  | 'approved'
  | 'approved-not-integrated'
  | 'approved-missing-file'
  | 'brief-ready'
  | 'brief-ready-placeholder'
  | 'needs-art-placeholder'
  | 'planned';

export interface ApprovedSpriteEntry {
  readonly briefId: string;
  readonly assetPath: string;
  readonly exists: boolean;
}

export interface FloorArtAssetReport {
  readonly id: string;
  readonly type: FloorArtAsset['type'];
  readonly label: string;
  readonly briefId: string;
  readonly placeholderInUse: boolean;
  readonly integration: IntegrationTarget | null;
  readonly briefAuthored: boolean;
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
  const keys = new Set<string>();
  for (const [path, source] of Object.entries(rawBriefs)) {
    if (path.toLowerCase().includes('/draft/')) {
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
    const briefId = entry.briefId || mapKey;
    out.set(briefId, {
      briefId,
      assetPath: entry.assetPath,
      exists: options.existingAssets.has(entry.assetPath),
    });
  }
  return out;
}

export function buildFloorArtPlanReport(plan: FloorArtPlan, options: {
  readonly briefKeys: ReadonlySet<string>;
  readonly approvedSprites: ReadonlyMap<string, ApprovedSpriteEntry>;
  readonly spriteRegistryIds: ReadonlySet<string>;
  readonly itemCatalogIds: ReadonlySet<string>;
}): FloorArtPlanReport {
  const assets: FloorArtAssetReport[] = plan.assets.map((asset) => {
    const briefId = asset.briefId ?? asset.id;
    const briefAuthored = options.briefKeys.has(briefKey(asset.type, briefId));
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
      placeholderInUse: asset.placeholderInUse,
      integration: asset.integration ?? null,
      briefAuthored,
      approved,
      approvedAssetExists,
      integrationState,
      status: resolveStatus({
        briefAuthored,
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

function resolveIntegrationState(
  target: IntegrationTarget | undefined,
  approvedAssetExists: boolean,
  spriteRegistryIds: ReadonlySet<string>,
  itemCatalogIds: ReadonlySet<string>,
): IntegrationState {
  if (!target) {
    return 'not-applicable';
  }
  if (target.kind === 'sprite-registry') {
    return spriteRegistryIds.has(target.id) ? 'integrated' : 'missing';
  }
  return itemCatalogIds.has(target.id) && approvedAssetExists ? 'integrated' : 'missing';
}

function resolveStatus(args: {
  readonly briefAuthored: boolean;
  readonly approved: boolean;
  readonly approvedAssetExists: boolean;
  readonly integrationState: IntegrationState;
  readonly placeholderInUse: boolean;
}): FloorArtStatus {
  if (args.approved && !args.approvedAssetExists) {
    return 'approved-missing-file';
  }
  if (args.approved && args.integrationState === 'integrated') {
    return 'ready';
  }
  if (args.approved && args.integrationState === 'not-applicable') {
    return 'approved';
  }
  if (args.approved) {
    return 'approved-not-integrated';
  }
  if (args.briefAuthored && args.placeholderInUse) {
    return 'brief-ready-placeholder';
  }
  if (args.briefAuthored) {
    return 'brief-ready';
  }
  if (args.placeholderInUse) {
    return 'needs-art-placeholder';
  }
  return 'planned';
}

function briefKey(type: string, name: string): string {
  return `${type}::${name}`;
}

const manifestEntrySchema = z
  .object({
    briefId: z.string().min(1),
    assetPath: z.string().min(1),
  })
  .passthrough();

const generatedManifestSchema = z
  .object({
    version: z.literal(1),
    entries: z.record(z.string(), manifestEntrySchema),
  })
  .strict();
