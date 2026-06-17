import { z } from 'zod';
import { type ArtPlanStatus, type IntegrationState } from '../shared/art-plan-status.js';
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
declare const assetPlanSchema: z.ZodObject<
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
export type FloorArtPlan = z.infer<typeof assetPlanSchema>;
export type FloorArtAsset = z.infer<typeof assetPlanEntrySchema>;
export type IntegrationTarget = z.infer<typeof integrationTargetSchema>;
export type { IntegrationState };
/** Alias kept for backward compatibility — same values as ArtPlanStatus. */
export type FloorArtStatus = ArtPlanStatus;
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
export declare const STATUS_ORDER: readonly FloorArtStatus[];
export declare function parseFloorArtPlans(
  rawPlans: Readonly<Record<string, string>>,
): FloorArtPlan[];
export declare function parseCommittedBriefKeys(
  rawBriefs: Readonly<Record<string, string>>,
): Set<string>;
export declare function parseDraftBriefKeys(
  rawBriefs: Readonly<Record<string, string>>,
): Set<string>;
export declare function parseApprovedSprites(
  manifest: unknown,
  options: {
    existingAssets: ReadonlySet<string>;
  },
): Map<string, ApprovedSpriteEntry>;
export declare function buildFloorArtPlanReport(
  plan: FloorArtPlan,
  options: {
    readonly briefKeys: ReadonlySet<string>;
    readonly draftBriefKeys: ReadonlySet<string>;
    readonly approvedSprites: ReadonlyMap<string, ApprovedSpriteEntry>;
    readonly spriteRegistryIds: ReadonlySet<string>;
    readonly itemCatalogIds: ReadonlySet<string>;
  },
): FloorArtPlanReport;
//# sourceMappingURL=art-plan-model.d.ts.map
