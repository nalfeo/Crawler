#!/usr/bin/env node
interface AssetPlanCliArgs {
  readonly planPath: string;
  readonly manifestPath: string;
  readonly format: 'table' | 'json';
  readonly failOnPlaceholder: boolean;
}
export declare function parseArgs(argv: ReadonlyArray<string>): AssetPlanCliArgs;
export {};
//# sourceMappingURL=asset-plan-cli.d.ts.map
