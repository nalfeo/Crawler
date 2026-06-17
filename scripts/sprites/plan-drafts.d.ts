import { type Brief } from './brief-schema.js';
import { type AssetPlanStatus } from './asset-plan.js';
type SpriteType = Brief['type'];
export declare const DEFAULT_PLAN_DRAFT_STATUSES: readonly AssetPlanStatus[];
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
export declare function materializePlanDrafts(
  options: MaterializePlanDraftsOptions,
): MaterializePlanDraftsResult;
export declare function parseStatusValue(value: string): AssetPlanStatus;
export {};
//# sourceMappingURL=plan-drafts.d.ts.map
