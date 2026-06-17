import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { SPRITES } from '../../src/engine/sprites/index.js';
import { parseGeneratedManifest } from '../../src/shared/generated-assets.js';
import {
  briefKey,
  resolveArtPlanStatus,
  resolveIntegrationState,
} from '../../src/shared/art-plan-status.js';
import { ITEM_CATALOG } from '../../src/shared/items.js';
import { SPRITE_TYPES, minimalBriefSchema } from './brief-schema.js';
const slugSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase kebab-case');
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
    id: slugSchema,
    type: z.enum(SPRITE_TYPES),
    label: z.string().trim().min(1),
    brief: z.string().trim().min(1),
    briefId: slugSchema.optional(),
    briefOverrides: z.record(z.string(), z.unknown()).optional(),
    placeholderInUse: z.boolean().default(true),
    integration: integrationTargetSchema.optional(),
  })
  .strict();
export const assetPlanSchema = z
  .object({
    id: slugSchema,
    title: z.string().trim().min(1),
    summary: z.string().trim().default(''),
    assets: z.array(assetPlanEntrySchema).min(1),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const seen = new Set();
    for (const asset of plan.assets) {
      if (seen.has(asset.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['assets'],
          message: `duplicate asset id "${asset.id}"`,
        });
      }
      seen.add(asset.id);
    }
  });
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
const DEFAULT_MANIFEST_PATH = path.join('public', 'assets', 'generated', 'manifest.json');
const spriteRegistryIds = new Set(SPRITES.map((sprite) => sprite.id));
const itemCatalogIds = new Set(ITEM_CATALOG.map((item) => item.id));
export function loadAssetPlan(planPath) {
  const absolute = path.resolve(planPath);
  const raw = readFileSync(absolute, 'utf8');
  const parsed = parseYaml(raw);
  return assetPlanSchema.parse(parsed);
}
export function collectCommittedBriefs(repoRoot) {
  return collectBriefIndex(repoRoot, 'committed');
}
export function collectDraftBriefs(repoRoot) {
  return collectBriefIndex(repoRoot, 'draft');
}
function collectBriefIndex(repoRoot, mode) {
  const briefsRoot = path.join(repoRoot, 'briefs');
  if (!existsSync(briefsRoot)) {
    return new Map();
  }
  const files = walkYamlFiles(briefsRoot);
  const out = new Map();
  for (const filePath of files) {
    const relative = path.relative(briefsRoot, filePath);
    const segments = relative.split(path.sep).map((segment) => segment.toLowerCase());
    const isDraft = segments.includes('draft');
    if (mode === 'committed' && isDraft) {
      continue;
    }
    if (mode === 'draft' && !isDraft) {
      continue;
    }
    const parsed = parseYaml(readFileSync(filePath, 'utf8'));
    const minimal = minimalBriefSchema.safeParse(parsed);
    if (!minimal.success) {
      continue;
    }
    out.set(briefKey(minimal.data.type, minimal.data.name), filePath);
  }
  return out;
}
export function loadApprovedSprites(repoRoot, manifestPath = DEFAULT_MANIFEST_PATH) {
  const absoluteManifestPath = path.resolve(repoRoot, manifestPath);
  if (!existsSync(absoluteManifestPath)) {
    return new Map();
  }
  const rawManifest = JSON.parse(readFileSync(absoluteManifestPath, 'utf8'));
  const manifest = parseGeneratedManifest(rawManifest);
  const out = new Map();
  for (const [mapKey, entry] of Object.entries(manifest.entries)) {
    const briefId = entry.briefId || mapKey;
    const assetExists = existsSync(
      path.join(repoRoot, 'public', 'assets', ...entry.assetPath.split('/')),
    );
    out.set(briefId, {
      briefId,
      manifest: entry,
      assetExists,
    });
  }
  return out;
}
export function buildAssetPlanReport(plan, options) {
  const availableSpriteIds = options.spriteRegistryIds ?? spriteRegistryIds;
  const availableItemIds = options.itemCatalogIds ?? itemCatalogIds;
  const assets = plan.assets.map((asset) => {
    const briefId = asset.briefId ?? asset.id;
    const briefAuthored = options.briefIndex.has(briefKey(asset.type, briefId));
    const draftAuthored = options.draftBriefIndex.has(briefKey(asset.type, briefId));
    const approvedRecord = options.approvedSprites.get(briefId);
    const approved = approvedRecord !== undefined;
    const approvedAssetExists = approvedRecord?.assetExists ?? false;
    const integrationState = resolveIntegrationState(
      asset.integration,
      approvedAssetExists,
      availableSpriteIds,
      availableItemIds,
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
        approved,
        approvedAssetExists,
        integrationState,
        briefAuthored,
        draftAuthored,
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
function walkYamlFiles(dirPath) {
  const entries = readdirSync(dirPath, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const absolute = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkYamlFiles(absolute));
      continue;
    }
    if (entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))) {
      out.push(absolute);
    }
  }
  return out.sort((left, right) => left.localeCompare(right));
}
//# sourceMappingURL=asset-plan.js.map
