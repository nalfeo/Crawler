#!/usr/bin/env node
import type { Brief } from './brief-schema.js';
import type { AssetPlanStatus } from './asset-plan.js';
type SpriteType = Brief['type'];
interface PlanDraftCliArgs {
  readonly planPath: string;
  readonly manifestPath: string;
  readonly outputRoot: string;
  readonly statuses: ReadonlyArray<AssetPlanStatus>;
  readonly types: ReadonlyArray<SpriteType>;
  readonly force: boolean;
  readonly dryRun: boolean;
}
export declare function parseArgs(argv: ReadonlyArray<string>): PlanDraftCliArgs;
export {};
//# sourceMappingURL=plan-drafts-cli.d.ts.map
