import { performance } from 'node:perf_hooks';
import { z } from 'zod';

export const SPRITE_PIPELINE_TIMING_STAGES = [
  'variationExpansion',
  'referenceSelectionAndPngReads',
  'provider',
  'initialSheetPersistence',
  'slicingAndPostprocess',
  'candidatePersistence',
  'judging',
  'runOrchestration',
] as const;

export type SpritePipelineTimingStage = (typeof SPRITE_PIPELINE_TIMING_STAGES)[number];
export type MonotonicNow = () => number;

const durationSchema = z.number().finite().nonnegative();
const spritePipelineTimingStageShape = {
  variationExpansion: durationSchema,
  referenceSelectionAndPngReads: durationSchema,
  provider: durationSchema,
  initialSheetPersistence: durationSchema,
  slicingAndPostprocess: durationSchema,
  candidatePersistence: durationSchema,
  judging: durationSchema,
  runOrchestration: durationSchema,
} satisfies Record<SpritePipelineTimingStage, typeof durationSchema>;

export const spritePipelineTimingSchema = z
  .object({
    scope: z.literal('initial-run'),
    totalMs: durationSchema,
    stages: z.object(spritePipelineTimingStageShape).strict(),
    invalidSamples: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((timing, context) => {
    const stageTotal = SPRITE_PIPELINE_TIMING_STAGES.reduce(
      (total, stage) => total + timing.stages[stage],
      0,
    );
    if (timing.totalMs !== stageTotal) {
      context.addIssue({
        code: 'custom',
        path: ['totalMs'],
        message: `totalMs must equal attributed stage total ${stageTotal}`,
      });
    }
  });

export type SpritePipelineTimingSnapshot = z.infer<typeof spritePipelineTimingSchema>;

export class SpritePipelineTimingCollector {
  private readonly durations = Object.fromEntries(
    SPRITE_PIPELINE_TIMING_STAGES.map((stage) => [stage, 0]),
  ) as Record<SpritePipelineTimingStage, number>;

  private invalidSamples = 0;
  private readonly runStartedAt: number | null;
  private snapshotDirty = true;
  private cachedSnapshot: SpritePipelineTimingSnapshot | null = null;

  constructor(private readonly nowMs: MonotonicNow = () => performance.now()) {
    this.runStartedAt = this.start();
  }

  private readNow(): number | null {
    try {
      const value = this.nowMs();
      if (Number.isFinite(value)) return value;
    } catch {
      // Timing is observational and must never change pipeline behavior.
    }
    return null;
  }

  start(): number | null {
    const value = this.readNow();
    if (value !== null) return value;
    this.invalidSamples++;
    this.snapshotDirty = true;
    return null;
  }

  finish(stage: SpritePipelineTimingStage, startedAt: number | null): void {
    if (startedAt === null) return;
    let completedAt: number;
    try {
      completedAt = this.nowMs();
    } catch {
      this.invalidSamples++;
      this.snapshotDirty = true;
      return;
    }
    const elapsed = completedAt - startedAt;
    if (!Number.isFinite(elapsed) || elapsed < 0) {
      this.invalidSamples++;
      this.snapshotDirty = true;
      return;
    }
    this.durations[stage] += elapsed;
    this.snapshotDirty = true;
  }

  async measure<T>(stage: SpritePipelineTimingStage, operation: () => Promise<T>): Promise<T> {
    const startedAt = this.start();
    try {
      return await operation();
    } finally {
      this.finish(stage, startedAt);
    }
  }

  snapshot(): SpritePipelineTimingSnapshot {
    if (this.cachedSnapshot !== null && !this.snapshotDirty) {
      return this.cachedSnapshot;
    }

    const stages = { ...this.durations };
    const completedAt = this.readNow();
    const measuredStagesMs = SPRITE_PIPELINE_TIMING_STAGES.filter(
      (stage) => stage !== 'runOrchestration',
    ).reduce((total, stage) => total + stages[stage], 0);
    if (this.runStartedAt !== null && completedAt !== null) {
      const elapsed = completedAt - this.runStartedAt;
      if (Number.isFinite(elapsed) && elapsed >= measuredStagesMs) {
        stages.runOrchestration = elapsed - measuredStagesMs;
      } else {
        this.invalidSamples++;
        this.snapshotDirty = true;
      }
    }

    const snapshot = {
      scope: 'initial-run',
      totalMs: SPRITE_PIPELINE_TIMING_STAGES.reduce((total, stage) => total + stages[stage], 0),
      stages,
      invalidSamples: this.invalidSamples,
    } satisfies SpritePipelineTimingSnapshot;
    this.cachedSnapshot = snapshot;
    this.snapshotDirty = false;
    return snapshot;
  }
}
