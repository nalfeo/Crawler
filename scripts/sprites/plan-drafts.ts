import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { SPRITES } from '../../src/engine/sprites/index.js';
import { ITEM_CATALOG } from '../../src/shared/items.js';
import { deepMergeDefaults } from './deep-merge.js';
import { type Brief } from './brief-schema.js';
import {
  STATUS_ORDER,
  buildAssetPlanReport,
  collectCommittedBriefs,
  collectDraftBriefs,
  loadApprovedSprites,
  loadAssetPlan,
  type AssetPlanAssetReport,
  type AssetPlanStatus,
} from './asset-plan.js';
import { briefDirectoryForType } from './brief-paths.js';

type SpriteType = Brief['type'];

export const DEFAULT_PLAN_DRAFT_STATUSES: readonly AssetPlanStatus[] = [
  'needs-art-placeholder',
  'planned',
] as const;

export interface MaterializePlanDraftsOptions {
  readonly repoRoot: string;
  readonly planPath: string;
  readonly manifestPath?: string;
  readonly outputRoot?: string;
  readonly statuses?: ReadonlyArray<AssetPlanStatus>;
  readonly types?: ReadonlyArray<SpriteType>;
  readonly force?: boolean;
  readonly dryRun?: boolean;
}

export interface MaterializedDraftRecord {
  readonly assetId: string;
  readonly briefId: string;
  readonly type: SpriteType;
  readonly draftPath: string;
  readonly status: AssetPlanStatus;
}

export interface SkippedDraftRecord extends MaterializedDraftRecord {
  readonly reason: 'existing-draft' | 'committed-brief-exists';
}

export interface MaterializePlanDraftsResult {
  readonly planId: string;
  readonly written: ReadonlyArray<MaterializedDraftRecord>;
  readonly skipped: ReadonlyArray<SkippedDraftRecord>;
  readonly targeted: ReadonlyArray<MaterializedDraftRecord>;
}

export function materializePlanDrafts(
  options: MaterializePlanDraftsOptions,
): MaterializePlanDraftsResult {
  const repoRoot = path.resolve(options.repoRoot);
  const outputRoot = path.resolve(repoRoot, options.outputRoot ?? path.join('briefs', 'draft'));
  const plan = loadAssetPlan(path.resolve(repoRoot, options.planPath));
  const committedBriefs = collectCommittedBriefs(repoRoot);
  const draftBriefs = collectDraftBriefs(repoRoot);
  const approvedSprites = loadApprovedSprites(repoRoot, options.manifestPath);
  const report = buildAssetPlanReport(plan, {
    briefIndex: committedBriefs,
    draftBriefIndex: draftBriefs,
    approvedSprites,
    spriteRegistryIds: new Set(SPRITES.map((sprite) => sprite.id)),
    itemCatalogIds: new Set(ITEM_CATALOG.map((item) => item.id)),
  });
  const statusFilter = new Set(options.statuses ?? DEFAULT_PLAN_DRAFT_STATUSES);
  const typeFilter = new Set(options.types ?? []);
  const targeted = report.assets
    .filter((asset) => statusFilter.has(asset.status))
    .filter((asset) => typeFilter.size === 0 || typeFilter.has(asset.type))
    .map((asset) => toDraftRecord(asset, outputRoot));

  const written: MaterializedDraftRecord[] = [];
  const skipped: SkippedDraftRecord[] = [];

  for (const target of targeted) {
    const committedKey = `${target.type}::${target.briefId}`;
    if (committedBriefs.has(committedKey)) {
      skipped.push({ ...target, reason: 'committed-brief-exists' });
      continue;
    }
    if (!options.force && existsSync(target.draftPath)) {
      skipped.push({ ...target, reason: 'existing-draft' });
      continue;
    }

    if (!options.dryRun) {
      const planAsset = plan.assets.find((asset) => (asset.briefId ?? asset.id) === target.briefId);
      if (!planAsset) {
        throw new Error(
          `Asset plan entry for brief '${target.briefId}' disappeared during processing.`,
        );
      }
      const payload = buildDraftBrief(
        planAsset.type,
        target.briefId,
        planAsset.brief,
        planAsset.briefOverrides,
      );
      mkdirSync(path.dirname(target.draftPath), { recursive: true });
      writeFileSync(target.draftPath, `${stringifyYaml(payload).trimEnd()}\n`);
    }

    written.push(target);
  }

  return {
    planId: plan.id,
    written,
    skipped,
    targeted,
  };
}

function toDraftRecord(asset: AssetPlanAssetReport, outputRoot: string): MaterializedDraftRecord {
  return {
    assetId: asset.id,
    briefId: asset.briefId,
    type: asset.type,
    draftPath: path.join(outputRoot, briefDirectoryForType(asset.type), `${asset.briefId}.yaml`),
    status: asset.status,
  };
}

function buildDraftBrief(
  type: SpriteType,
  briefId: string,
  description: string,
  overrides: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const merged = deepMergeDefaults(
    { type, name: briefId, description } as Record<string, unknown>,
    overrides ?? {},
  );
  merged.type = type;
  merged.name = briefId;
  if (typeof merged.description !== 'string' && typeof merged.prompt !== 'string') {
    merged.description = description;
  }
  return merged;
}

export function parseStatusValue(value: string): AssetPlanStatus {
  if ((STATUS_ORDER as readonly string[]).includes(value)) {
    return value as AssetPlanStatus;
  }
  throw new Error(`Unknown status '${value}'. Expected one of: ${STATUS_ORDER.join(', ')}`);
}
