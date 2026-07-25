import { describe, expect, it } from 'vitest';

import { autoSelectVariants } from '../../../scripts/sprites/auto-selection.js';
import type { RunSummaryEntry } from '../../../scripts/sprites/run-artifacts.js';
import { JUDGE_HARD_BLOCK_PHRASE, type JudgeScorecard } from '../../../scripts/sprites/judge.js';

function makeJudgeScorecard(overrides: Partial<JudgeScorecard> = {}): JudgeScorecard {
  return {
    variantIndex: 0,
    styleMatch: { score: 4, rationale: 'ok' },
    briefMatch: { score: 4, rationale: 'ok' },
    readability: { score: 4, rationale: 'ok' },
    passed: true,
    minScore: 4,
    rejectedBy: [],
    judgedAt: '2026-07-24T00:00:00.000Z',
    modelDeployment: 'test-model',
    hardBlockEvaluated: true,
    hardBlocked: false,
    hardBlockInstruction: null,
    hardBlockRationale: 'acceptable',
    confidence: 0.5,
    usage: null,
    ...overrides,
  };
}

function makeEntry(overrides: Partial<RunSummaryEntry> = {}): RunSummaryEntry {
  return {
    index: 0,
    score: 7,
    outOf: 7,
    breakdown: [],
    passed: true,
    rawPath: 'C:\\test\\raw\\00.png',
    processedPath: 'C:\\test\\processed\\00.png',
    scorecardPath: 'C:\\test\\processed\\00.scorecard.json',
    derivedAnchor: null,
    derivedAnchors: { hold: null, centerOfGravity: null },
    anchorSidecarPath: null,
    centerOfGravitySidecarPath: null,
    anchorOverlayPath: 'C:\\test\\processed\\00.anchor-overlay.png',
    judgeScorecard: makeJudgeScorecard(),
    judgeSkipReason: null,
    combinedPassed: true,
    ...overrides,
  };
}

describe('autoSelectVariants', () => {
  it('rejects candidates with more than two sensor failures', () => {
    const result = autoSelectVariants([
      makeEntry({
        index: 4,
        score: 4,
        outOf: 7,
      }),
    ]);

    expect(result.selected).toEqual([]);
    expect(result.rejected).toEqual([
      expect.objectContaining({
        entryIndex: 4,
        reason: 'sensor-failures-exceeded',
        sensorFailures: 3,
      }),
    ]);
  });

  it('rejects explicitly hard-blocked candidates', () => {
    const result = autoSelectVariants([
      makeEntry({
        index: 2,
        judgeScorecard: makeJudgeScorecard({
          hardBlocked: true,
          hardBlockInstruction: JUDGE_HARD_BLOCK_PHRASE,
          hardBlockRationale: 'Do not ship this.',
        }),
      }),
    ]);

    expect(result.selected).toEqual([]);
    expect(result.rejected).toEqual([
      expect.objectContaining({
        entryIndex: 2,
        reason: 'hard-blocked',
        hardBlockInstruction: JUDGE_HARD_BLOCK_PHRASE,
      }),
    ]);
  });

  it('rejects missing and hard-block-unevaluated judge scorecards', () => {
    const result = autoSelectVariants([
      makeEntry({
        index: 1,
        judgeScorecard: null,
        judgeSkipReason: 'over-cap',
        combinedPassed: false,
      }),
      makeEntry({
        index: 3,
        judgeScorecard: makeJudgeScorecard({
          hardBlockEvaluated: false,
          hardBlocked: false,
          hardBlockInstruction: null,
          hardBlockRationale: null,
          confidence: null,
        }),
      }),
    ]);

    expect(result.selected).toEqual([]);
    expect(result.rejected).toEqual([
      expect.objectContaining({
        entryIndex: 1,
        reason: 'missing-judge-scorecard',
      }),
      expect.objectContaining({
        entryIndex: 3,
        reason: 'hard-block-not-evaluated',
      }),
    ]);
  });

  it('uses the explicit hard block as the judge veto instead of the strict judge pass flag', () => {
    const result = autoSelectVariants([
      makeEntry({
        index: 6,
        score: 5,
        outOf: 7,
        judgeScorecard: makeJudgeScorecard({
          passed: false,
          minScore: 2,
          rejectedBy: ['readability'],
          hardBlockEvaluated: true,
          hardBlocked: false,
        }),
        combinedPassed: false,
      }),
    ]);

    expect(result.selected.map((entry) => entry.index)).toEqual([6]);
    expect(result.rejected).toEqual([]);
  });

  it('returns the deterministic top three acceptable variants', () => {
    const result = autoSelectVariants([
      makeEntry({
        index: 0,
        score: 7,
        outOf: 7,
        judgeScorecard: makeJudgeScorecard({ minScore: 4, confidence: 0.95 }),
      }),
      makeEntry({
        index: 1,
        score: 6,
        outOf: 7,
        judgeScorecard: makeJudgeScorecard({ minScore: 5, confidence: 1.0 }),
      }),
      makeEntry({
        index: 2,
        score: 7,
        outOf: 7,
        judgeScorecard: makeJudgeScorecard({ minScore: 4, confidence: 0.4 }),
      }),
      makeEntry({
        index: 3,
        score: 7,
        outOf: 7,
        judgeScorecard: makeJudgeScorecard({ minScore: 5, confidence: 0.7 }),
      }),
      makeEntry({
        index: 4,
        score: 7,
        outOf: 7,
        judgeScorecard: makeJudgeScorecard({ minScore: 5, confidence: 0.7 }),
      }),
      makeEntry({
        index: 5,
        score: 7,
        outOf: 7,
        judgeScorecard: makeJudgeScorecard({ minScore: 5, confidence: 0.9 }),
      }),
    ]);

    expect(result.selected.map((entry) => entry.index)).toEqual([5, 3, 4]);
    expect(result.selected).toHaveLength(3);
    expect(result.rejected).toEqual([]);
  });
});
