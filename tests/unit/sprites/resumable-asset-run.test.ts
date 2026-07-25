import { describe, expect, it, vi } from 'vitest';
import { createIssueCheckpointController } from '../../../scripts/sprites/issue-pipeline-checkpoint.js';
import type { RunStore } from '../../../scripts/sprites/store/types.js';

const mocks = vi.hoisted(() => ({
  generateOne: vi.fn(),
  loadRunSummary: vi.fn(),
  repostprocessRun: vi.fn(),
  rejudgeRun: vi.fn(),
}));

vi.mock('../../../scripts/sprites/generate-one.js', () => ({
  generateOne: mocks.generateOne,
}));
vi.mock('../../../scripts/sprites/rerun.js', () => ({
  loadRunSummary: mocks.loadRunSummary,
  repostprocessRun: mocks.repostprocessRun,
  rejudgeRun: mocks.rejudgeRun,
}));
vi.mock('../../../scripts/sprites/load-reference-pngs.js', () => ({
  loadRecordedReferencePngs: () => [],
}));
vi.mock('../../../scripts/sprites/build-prompt.js', () => ({
  loadStyleGuide: () => 'style guide',
}));

import { runResumableAssetRun } from '../../../scripts/sprites/resumable-asset-run.js';

function makeStore(): RunStore {
  const mem = new Map<string, Buffer>();
  return {
    backend: 'local',
    async put(key, data) {
      mem.set(key, data);
    },
    async get(key) {
      const value = mem.get(key);
      if (!value) throw new Error(`Missing ${key}`);
      return value;
    },
    async has(key) {
      return mem.has(key);
    },
    async list(prefix) {
      return [...mem.keys()].filter((key) => key.startsWith(prefix));
    },
    async remove(key) {
      mem.delete(key);
    },
    resolve(key) {
      return key;
    },
  };
}

function candidateSummary() {
  return {
    brief: 'bone-dagger',
    runId: 'run-1',
    candidates: [
      {
        index: 0,
        score: 4,
        outOf: 5,
        judgeScorecard: {
          minScore: 3,
          confidence: 0.9,
          hardBlockEvaluated: true,
          hardBlocked: false,
        },
      },
    ],
  };
}

function options(store: RunStore) {
  return {
    checkpoint: createIssueCheckpointController({
      store,
      issueNumber: 42,
      fingerprint: 'fingerprint-1',
      now: () => new Date('2026-07-24T00:00:00.000Z'),
    }),
    briefPath: '/repo/briefs/draft/weapons/bone-dagger.yaml',
    loaded: {
      brief: {},
      palette: {},
    } as never,
    repoRoot: '/repo',
    store,
    imageProvider: {} as never,
    textProvider: null,
    visionProvider: {} as never,
    env: {},
    now: () => new Date('2026-07-24T00:00:00.000Z'),
  };
}

describe('runResumableAssetRun', () => {
  it('retries a transient judge failure without regenerating and resumes completed stages later', async () => {
    vi.clearAllMocks();
    const store = makeStore();
    const summary = candidateSummary();
    mocks.generateOne.mockResolvedValue({
      summary,
      summaryPath: 'bone-dagger/run-1/summary.json',
    });
    mocks.loadRunSummary.mockResolvedValue(summary);
    mocks.repostprocessRun.mockResolvedValue({
      summaryPath: 'bone-dagger/run-1/summary.json',
    });
    mocks.rejudgeRun
      .mockRejectedValueOnce(new Error('temporary judge outage'))
      .mockResolvedValueOnce({ summaryPath: 'bone-dagger/run-1/summary.json' });

    const first = await runResumableAssetRun(options(store));
    expect(first.selectedIndexes).toEqual([0]);
    expect(mocks.generateOne).toHaveBeenCalledTimes(1);
    expect(mocks.generateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        maxAttempts: 1,
      }),
    );
    expect(mocks.repostprocessRun).toHaveBeenCalledTimes(1);
    expect(mocks.rejudgeRun).toHaveBeenCalledTimes(2);

    await runResumableAssetRun(options(store));
    expect(mocks.generateOne).toHaveBeenCalledTimes(1);
    expect(mocks.repostprocessRun).toHaveBeenCalledTimes(1);
    expect(mocks.rejudgeRun).toHaveBeenCalledTimes(2);
  });
});
