import { describe, expect, it } from 'vitest';
import {
  SPRITE_PIPELINE_TIMING_STAGES,
  SpritePipelineTimingCollector,
  spritePipelineTimingSchema,
} from '../../../scripts/sprites/pipeline-timing.js';

describe('SpritePipelineTimingCollector', () => {
  it('uses injected monotonic samples and makes totalMs equal every attributed stage', async () => {
    const samples = [0, 5, 15, 22, 40, 40];
    const timing = new SpritePipelineTimingCollector(() => samples.shift() ?? Number.NaN);

    await timing.measure('provider', async () => undefined);
    await timing.measure('candidatePersistence', async () => undefined);

    const snapshot = timing.snapshot();
    expect(snapshot).toEqual({
      scope: 'initial-run',
      totalMs: 40,
      stages: {
        variationExpansion: 0,
        referenceSelectionAndPngReads: 0,
        provider: 10,
        initialSheetPersistence: 0,
        slicingAndPostprocess: 0,
        candidatePersistence: 18,
        judging: 0,
        runOrchestration: 12,
      },
      invalidSamples: 0,
    });
    expect(snapshot.totalMs).toBe(
      SPRITE_PIPELINE_TIMING_STAGES.reduce((total, stage) => total + snapshot.stages[stage], 0),
    );
  });

  it('fails open when an injected clock throws or moves backwards', async () => {
    const samples: Array<number | Error> = [0, 10, 5, new Error('clock unavailable')];
    const timing = new SpritePipelineTimingCollector(() => {
      const sample = samples.shift();
      if (sample instanceof Error) throw sample;
      return sample ?? Number.NaN;
    });

    await expect(timing.measure('provider', async () => 'generated')).resolves.toBe('generated');

    const snapshot = timing.snapshot();
    expect(snapshot.stages.provider).toBe(0);
    expect(snapshot.invalidSamples).toBeGreaterThan(0);
  });

  it('returns the same finalized snapshot when read more than once', () => {
    const samples = [0, 5, 10, 15];
    const timing = new SpritePipelineTimingCollector(() => samples.shift() ?? Number.NaN);
    timing.finish('provider', timing.start());

    expect(timing.snapshot()).toEqual(timing.snapshot());
  });

  it('rejects timing documents whose total does not reconcile with their stages', () => {
    const timing = new SpritePipelineTimingCollector(() => 0).snapshot();
    expect(
      spritePipelineTimingSchema.safeParse({ ...timing, totalMs: timing.totalMs + 1 }).success,
    ).toBe(false);
  });
});
