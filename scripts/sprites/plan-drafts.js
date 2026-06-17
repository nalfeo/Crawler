import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { SPRITES } from '../../src/engine/sprites/index.js';
import { ITEM_CATALOG } from '../../src/shared/items.js';
import { deepMergeDefaults } from './deep-merge.js';
import {
  STATUS_ORDER,
  buildAssetPlanReport,
  collectCommittedBriefs,
  collectDraftBriefs,
  loadApprovedSprites,
  loadAssetPlan,
} from './asset-plan.js';
import { briefDirectoryForType } from './brief-paths.js';
export const DEFAULT_PLAN_DRAFT_STATUSES = ['needs-art-placeholder', 'planned'];
export function materializePlanDrafts(options) {
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
  const written = [];
  const skipped = [];
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
function toDraftRecord(asset, outputRoot) {
  return {
    assetId: asset.id,
    briefId: asset.briefId,
    type: asset.type,
    draftPath: path.join(outputRoot, briefDirectoryForType(asset.type), `${asset.briefId}.yaml`),
    status: asset.status,
  };
}
function buildDraftBrief(type, briefId, description, overrides) {
  const merged = deepMergeDefaults({ type, name: briefId, description }, overrides ?? {});
  merged.type = type;
  merged.name = briefId;
  if (typeof merged.description !== 'string' && typeof merged.prompt !== 'string') {
    merged.description = description;
  }
  return merged;
}
export function parseStatusValue(value) {
  if (STATUS_ORDER.includes(value)) {
    return value;
  }
  throw new Error(`Unknown status '${value}'. Expected one of: ${STATUS_ORDER.join(', ')}`);
}
//# sourceMappingURL=plan-drafts.js.map
