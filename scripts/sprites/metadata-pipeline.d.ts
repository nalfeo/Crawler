import { z } from 'zod';
import { type SpriteCatalog, type SpriteCatalogRecord } from '../../src/shared/sprite-catalog.js';
export declare const DEFAULT_CATALOG_PATH = 'src/shared/data/sprite-catalog.json';
export declare const DEFAULT_MIN_SCORE = 70;
declare const draftSchema: z.ZodObject<
  {
    description: z.ZodString;
    tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
    tileConnectsTo: z.ZodOptional<z.ZodArray<z.ZodString>>;
    animationClips: z.ZodOptional<z.ZodArray<z.ZodString>>;
    rationale: z.ZodDefault<z.ZodString>;
  },
  z.core.$strict
>;
declare const judgmentSchema: z.ZodObject<
  {
    approved: z.ZodBoolean;
    score: z.ZodNumber;
    issues: z.ZodDefault<z.ZodArray<z.ZodString>>;
  },
  z.core.$strict
>;
export type MetadataDraft = z.infer<typeof draftSchema>;
export type DraftJudgment = z.infer<typeof judgmentSchema>;
interface ProviderContext {
  catalog: SpriteCatalog;
}
export interface MetadataProvider {
  readonly name: string;
  generate(entry: SpriteCatalogRecord, context: ProviderContext): Promise<MetadataDraft>;
  judge(
    entry: SpriteCatalogRecord,
    draft: MetadataDraft,
    context: ProviderContext,
  ): Promise<DraftJudgment>;
}
export interface PipelineOptions {
  provider: MetadataProvider;
  ids?: readonly string[];
  force?: boolean;
  minScore?: number;
}
export interface PipelineResult {
  updated: SpriteCatalog;
  changedCount: number;
  processedCount: number;
  rejectedCount: number;
  skippedCount: number;
}
export type MetadataProviderMode = 'auto' | 'heuristic' | 'openai';
export declare function createHeuristicProvider(): MetadataProvider;
export declare function runMetadataPipeline(
  catalog: SpriteCatalog,
  options: PipelineOptions,
): Promise<PipelineResult>;
export declare function resolveProvider(mode: MetadataProviderMode): Promise<MetadataProvider>;
export {};
//# sourceMappingURL=metadata-pipeline.d.ts.map
