import { describe, expect, it } from 'vitest';
import { createRunBundle } from '../../src/shared/run-bundle.js';
import {
  buildRunBundleUploadRequest,
  buildRunSurveyAppendRequest,
} from '../../src/shared/run-bundle-telemetry.js';

const makeBundle = () =>
  createRunBundle({
    runStats: { outcome: 'victory', finalLevel: 5 },
    recorderJsonl: 'event=run-start\n',
    logs: ['run start', 'player died'],
    meta: { endReason: 'victory', floorId: 'floor1', seed: 13, runId: 'run-abc123' },
  });

describe('run bundle telemetry request builders', () => {
  it('serializes the silent-upload request with top-level fields matching the PR2 /runs contract', () => {
    const bundle = makeBundle();
    const request = buildRunBundleUploadRequest(bundle);

    expect(request).toEqual({
      runStats: bundle.runStats,
      recorderJsonl: bundle.recorderJsonl,
      logs: bundle.logs,
      meta: bundle.meta,
    });
    expect('survey' in request).toBe(false);
  });

  it('serializes the survey request as a runId-based append payload', () => {
    const bundle = makeBundle();
    const survey = {
      enjoyment: 5,
      immersion: 4,
      mastery: 3,
      control: 5,
      tension: 2,
      comment: 'The tension was excellent.',
    };
    const request = buildRunSurveyAppendRequest(bundle.meta.runId, survey);

    expect(request).toEqual({
      meta: { runId: bundle.meta.runId },
      survey,
    });
  });

  it('keeps the bundle runId stable across completion and survey request shapes', () => {
    const bundle = makeBundle();
    const silentRequest = buildRunBundleUploadRequest(bundle);
    const surveyRequest = buildRunSurveyAppendRequest(bundle.meta.runId, {
      enjoyment: 1,
      immersion: 1,
      mastery: 1,
      control: 1,
      tension: 1,
    });

    expect(silentRequest.meta.runId).toBe('run-abc123');
    expect(surveyRequest.meta.runId).toBe('run-abc123');
  });

  it('requires a runId for survey append payloads', () => {
    expect(() =>
      buildRunSurveyAppendRequest(undefined, {
        enjoyment: 1,
        immersion: 1,
        mastery: 1,
        control: 1,
        tension: 1,
      }),
    ).toThrow('runId is required');
  });
});
