import { z } from 'zod';
import { type ManifestEntry } from '../../src/shared/generated-assets.js';
import { type ArtPlanStatus, type IntegrationState } from '../../src/shared/art-plan-status.js';
declare const integrationTargetSchema: z.ZodDiscriminatedUnion<
  [
    z.ZodObject<
      {
        kind: z.ZodLiteral<'sprite-registry'>;
        id: z.ZodString;
      },
      z.core.$strict
    >,
    z.ZodObject<
      {
        kind: z.ZodLiteral<'item-catalog'>;
        id: z.ZodString;
      },
      z.core.$strict
    >,
  ],
  'kind'
>;
declare const assetPlanEntrySchema: z.ZodObject<
  {
    id: z.ZodString;
    type: z.ZodEnum<{
      enemy: 'enemy';
      item: 'item';
      weapon: 'weapon';
      tile: 'tile';
      vfx: 'vfx';
      character: 'character';
    }>;
    label: z.ZodString;
    brief: z.ZodString;
    briefId: z.ZodOptional<z.ZodString>;
    briefOverrides: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    placeholderInUse: z.ZodDefault<z.ZodBoolean>;
    integration: z.ZodOptional<
      z.ZodDiscriminatedUnion<
        [
          z.ZodObject<
            {
              kind: z.ZodLiteral<'sprite-registry'>;
              id: z.ZodString;
            },
            z.core.$strict
          >,
          z.ZodObject<
            {
              kind: z.ZodLiteral<'item-catalog'>;
              id: z.ZodString;
            },
            z.core.$strict
          >,
        ],
        'kind'
      >
    >;
  },
  z.core.$strict
>;
export declare const assetPlanSchema: z.ZodObject<
  {
    id: z.ZodString;
    title: z.ZodString;
    summary: z.ZodDefault<z.ZodString>;
    assets: z.ZodArray<
      z.ZodObject<
        {
          id: z.ZodString;
          type: z.ZodEnum<{
            enemy: 'enemy';
            item: 'item';
            weapon: 'weapon';
            tile: 'tile';
            vfx: 'vfx';
            character: 'character';
          }>;
          label: z.ZodString;
          brief: z.ZodString;
          briefId: z.ZodOptional<z.ZodString>;
          briefOverrides: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
          placeholderInUse: z.ZodDefault<z.ZodBoolean>;
          integration: z.ZodOptional<
            z.ZodDiscriminatedUnion<
              [
                z.ZodObject<
                  {
                    kind: z.ZodLiteral<'sprite-registry'>;
                    id: z.ZodString;
                  },
                  z.core.$strict
                >,
                z.ZodObject<
                  {
                    kind: z.ZodLiteral<'item-catalog'>;
                    id: z.ZodString;
                  },
                  z.core.$strict
                >,
              ],
              'kind'
            >
          >;
        },
        z.core.$strict
      >
    >;
  },
  z.core.$strict
>;
export type AssetPlan = z.infer<typeof assetPlanSchema>;
export type AssetPlanEntry = z.infer<typeof assetPlanEntrySchema>;
export type IntegrationTarget = z.infer<typeof integrationTargetSchema>;
export interface ApprovedSpriteRecord {
  readonly briefId: string;
  readonly manifest: ManifestEntry;
  readonly assetExists: boolean;
}
export type BriefIndex = ReadonlyMap<string, string>;
export type ApprovedSpriteIndex = ReadonlyMap<string, ApprovedSpriteRecord>;
export type DraftBriefIndex = ReadonlyMap<string, string>;
export type { IntegrationState };
/** Alias kept for backward compatibility — same values as ArtPlanStatus. */
export type AssetPlanStatus = ArtPlanStatus;
export interface AssetPlanAssetReport {
  readonly id: string;
  readonly type: AssetPlanEntry['type'];
  readonly label: string;
  readonly briefId: string;
  readonly placeholderInUse: boolean;
  readonly integration: IntegrationTarget | null;
  readonly briefAuthored: boolean;
  readonly draftAuthored: boolean;
  readonly approved: boolean;
  readonly approvedAssetExists: boolean;
  readonly integrationState: IntegrationState;
  readonly status: AssetPlanStatus;
}
export interface AssetPlanReport {
  readonly planId: string;
  readonly title: string;
  readonly summary: string;
  readonly assets: readonly AssetPlanAssetReport[];
  readonly counts: Readonly<Record<AssetPlanStatus, number>>;
  readonly unresolvedPlaceholders: number;
}
export declare const STATUS_ORDER: readonly AssetPlanStatus[];
export declare function loadAssetPlan(planPath: string): AssetPlan;
export declare function collectCommittedBriefs(repoRoot: string): BriefIndex;
export declare function collectDraftBriefs(repoRoot: string): DraftBriefIndex;
export declare function loadApprovedSprites(
  repoRoot: string,
  manifestPath?: string,
): ApprovedSpriteIndex;
export interface BuildAssetPlanReportOptions {
  readonly briefIndex: BriefIndex;
  readonly draftBriefIndex: DraftBriefIndex;
  readonly approvedSprites: ApprovedSpriteIndex;
  readonly spriteRegistryIds?: ReadonlySet<string>;
  readonly itemCatalogIds?: ReadonlySet<string>;
}
export declare function buildAssetPlanReport(
  plan: AssetPlan,
  options: BuildAssetPlanReportOptions,
): AssetPlanReport;
//# sourceMappingURL=asset-plan.d.ts.map
