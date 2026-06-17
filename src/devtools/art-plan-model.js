import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import {
  briefKey,
  resolveArtPlanStatus,
  resolveIntegrationState,
} from '../shared/art-plan-status.js';
const spriteTypes = ['weapon', 'enemy', 'item', 'tile', 'vfx', 'character'];
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
export const STATUS_ORDER = [
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
];
export function parseFloorArtPlans(rawPlans) {
  const parsed = [];
  for (const source of Object.values(rawPlans)) {
    const value = parseYaml(source);
    const result = assetPlanSchema.safeParse(value);
    if (result.success) {
      parsed.push(result.data);
    }
  }
  return parsed.sort((left, right) => left.id.localeCompare(right.id));
}
export function parseCommittedBriefKeys(rawBriefs) {
  return parseBriefKeys(rawBriefs, 'committed');
}
export function parseDraftBriefKeys(rawBriefs) {
  return parseBriefKeys(rawBriefs, 'draft');
}
function parseBriefKeys(rawBriefs, mode) {
  const keys = new Set();
  for (const [path, source] of Object.entries(rawBriefs)) {
    const isDraft = path.toLowerCase().includes('/draft/');
    if (mode === 'committed' && isDraft) {
      continue;
    }
    if (mode === 'draft' && !isDraft) {
      continue;
    }
    const value = parseYaml(source);
    const result = minimalBriefSchema.safeParse(value);
    if (!result.success) {
      continue;
    }
    keys.add(briefKey(result.data.type, result.data.name));
  }
  return keys;
}
export function parseApprovedSprites(manifest, options) {
  const out = new Map();
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
export function buildFloorArtPlanReport(plan, options) {
  const assets = plan.assets.map((asset) => {
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
  const counts = Object.fromEntries(STATUS_ORDER.map((status) => [status, 0]));
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
  })
  .passthrough();
const generatedManifestSchema = z
  .object({
    version: z.literal(1),
    entries: z.record(z.string(), manifestEntrySchema),
  })
  .strict();
//# sourceMappingURL=art-plan-model.js.map
