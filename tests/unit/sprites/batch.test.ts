/**
 * Unit tests for the batch orchestrator.
 *
 * Coverage:
 *   1. Empty brief list → zero-attempt summary, no errors.
 *   2. Single happy-path brief via a stub `generate` factory.
 *   3. Budget exhaustion BEFORE brief 2 → brief 1 runs, briefs 2+ are
 *      marked `skipped-over-budget` and the stub is NOT invoked.
 *   4. A brief that throws → captured as `failed`, subsequent briefs
 *      still run.
 *   5. `batch-summary.json` is written incrementally (file is present
 *      after brief 1, valid JSON, contains brief 1's entry, BEFORE
 *      brief 2 runs).
 *   6. Shared cache + budget instances accumulate stats across briefs.
 *   7. `projectDryRunCost` math.
 */

import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  projectDryRunCost,
  runBatch,
  type RunFullFactory,
} from '../../../scripts/sprites/batch.js';
import { JudgeBudget } from '../../../scripts/sprites/cost-tracker.js';
import { JudgeCache } from '../../../scripts/sprites/judge-cache.js';
import type { GenerateOneResult } from '../../../scripts/sprites/generate-one.js';
import type { RunSummary } from '../../../scripts/sprites/run-artifacts.js';
import type { ImageProvider } from '../../../scripts/sprites/provider/types.js';

const fixedClock = () => new Date('2026-06-07T22:30:00.000Z');

function tmpRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'crawler-batch-'));
}

function noopImageProvider(): ImageProvider {
  return {
    async generateSheet() {
      throw new Error('image provider should not be called in batch unit tests');
    },
  };
}

function fakeRunSummary(brief: string, runId: string): RunSummary {
  return {
    brief,
    briefPath: `briefs/${brief}.yaml`,
    runId,
    createdAt: '2026-06-07T22:30:00.000Z',
    promptHash: 'abc123',
    attempts: 1,
    variantCount: 4,
    candidates: [
      // Two judged variants, one over-cap, one over-budget — exercises
      // the totals roll-up.
      {
        index: 0,
        score: 8,
        outOf: 10,
        breakdown: [],
        passed: true,
        rawPath: 'raw/00.png',
        processedPath: 'processed/00.png',
        scorecardPath: 'processed/00.scorecard.json',
        derivedAnchor: null,
        derivedAnchors: { hold: null, centerOfGravity: null },
        anchorSidecarPath: null,
        centerOfGravitySidecarPath: null,
        anchorOverlayPath: 'processed/00.anchor-overlay.png',
        judgeScorecard: {
          variantIndex: 0,
          modelDeployment: 'mock',
          judgedAt: '2026-06-07T22:30:00.000Z',
          passed: true,
          minScore: 5,
          styleMatch: { score: 5, rationale: 'great' },
          briefMatch: { score: 5, rationale: 'great' },
          readability: { score: 5, rationale: 'great' },
          rejectedBy: [],
          usage: { promptTokens: 1500, completionTokens: 80, totalTokens: 1580 },
        },
        judgeSkipReason: null,
        combinedPassed: true,
      },
      {
        index: 1,
        score: 7,
        outOf: 10,
        breakdown: [],
        passed: true,
        rawPath: 'raw/01.png',
        processedPath: 'processed/01.png',
        scorecardPath: 'processed/01.scorecard.json',
        derivedAnchor: null,
        derivedAnchors: { hold: null, centerOfGravity: null },
        anchorSidecarPath: null,
        centerOfGravitySidecarPath: null,
        anchorOverlayPath: 'processed/01.anchor-overlay.png',
        judgeScorecard: {
          variantIndex: 1,
          modelDeployment: 'mock',
          judgedAt: '2026-06-07T22:30:00.000Z',
          passed: true,
          minScore: 5,
          styleMatch: { score: 5, rationale: 'ok' },
          briefMatch: { score: 5, rationale: 'ok' },
          readability: { score: 5, rationale: 'ok' },
          rejectedBy: [],
          usage: { promptTokens: 1500, completionTokens: 80, totalTokens: 1580 },
        },
        judgeSkipReason: null,
        combinedPassed: true,
      },
      {
        index: 2,
        score: 6,
        outOf: 10,
        breakdown: [],
        passed: true,
        rawPath: 'raw/02.png',
        processedPath: 'processed/02.png',
        scorecardPath: 'processed/02.scorecard.json',
        derivedAnchor: null,
        derivedAnchors: { hold: null, centerOfGravity: null },
        anchorSidecarPath: null,
        centerOfGravitySidecarPath: null,
        anchorOverlayPath: 'processed/02.anchor-overlay.png',
        judgeScorecard: null,
        judgeSkipReason: 'over-cap',
        combinedPassed: false,
      },
      {
        index: 3,
        score: 5,
        outOf: 10,
        breakdown: [],
        passed: true,
        rawPath: 'raw/03.png',
        processedPath: 'processed/03.png',
        scorecardPath: 'processed/03.scorecard.json',
        derivedAnchor: null,
        derivedAnchors: { hold: null, centerOfGravity: null },
        anchorSidecarPath: null,
        centerOfGravitySidecarPath: null,
        anchorOverlayPath: 'processed/03.anchor-overlay.png',
        judgeScorecard: null,
        judgeSkipReason: 'over-budget',
        combinedPassed: false,
      },
    ],
    diversity: null,
    variations: {
      seed: [],
      proposed: [],
      final: [],
      minVariations: 0,
      skippedReason: null,
    },
    chosen: null,
    judgeBudget: null,
    judgeCache: null,
  };
}

function fakeResult(runDir: string, brief: string): GenerateOneResult {
  return {
    summary: fakeRunSummary(brief, 'run-1'),
    summaryPath: path.join(runDir, 'summary.json'),
    runDir,
    attempts: 1,
    // Bare minimum brief — only `name` is read out by the batch layer.
    brief: { name: brief } as unknown as GenerateOneResult['brief'],
  };
}

describe('runBatch', () => {
  it('empty brief list produces zero-attempt summary with no errors', async () => {
    const root = tmpRoot();
    try {
      const generate: RunFullFactory = vi.fn();
      const summary = await runBatch({
        briefPaths: [],
        repoRoot: root,
        outputRoot: path.join(root, 'generated'),
        judgeBudget: null,
        judgeCache: null,
        provider: noopImageProvider(),
        generate,
        now: fixedClock,
      });
      expect(summary.totals.briefsAttempted).toBe(0);
      expect(summary.briefs).toHaveLength(0);
      expect(summary.finishedAt).not.toBeNull();
      expect(generate).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('single happy-path brief is captured in the summary', async () => {
    const root = tmpRoot();
    try {
      const generate: RunFullFactory = vi.fn(async (_opts) => {
        return fakeResult(path.join(root, 'generated', 'runs', 'sword'), 'sword');
      });
      const summary = await runBatch({
        briefPaths: ['briefs/sword.yaml'],
        repoRoot: root,
        outputRoot: path.join(root, 'generated'),
        judgeBudget: null,
        judgeCache: null,
        provider: noopImageProvider(),
        generate,
        now: fixedClock,
      });
      expect(summary.totals.briefsAttempted).toBe(1);
      expect(summary.totals.briefsSucceeded).toBe(1);
      expect(summary.briefs[0]!.status).toBe('succeeded');
      expect(summary.briefs[0]!.briefId).toBe('sword');
      expect(summary.briefs[0]!.summary).toBeDefined();
      expect(summary.totals.variantsJudged).toBe(2);
      expect(summary.totals.variantsSkipped).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('marks subsequent briefs `skipped-over-budget` once cap is reached and does not invoke generate', async () => {
    const root = tmpRoot();
    try {
      // gpt-4o per-call (1500 in @ $2.50/M + 80 out @ $10/M) ≈ $0.00455.
      // Set a $0.001 cap with reset → first brief's first call records
      // spend that pushes us over; brief 2 + 3 must be skipped at the
      // batch layer (without ever entering `generate`).
      const stateFile = path.join(root, 'cost-state.json');
      const budget = new JudgeBudget({
        budgetUsd: 0.001,
        modelDeployment: 'gpt-4o',
        stateFile,
        reset: true,
      });
      const generate: RunFullFactory = vi.fn(async (_opts) => {
        // Simulate runFull recording one judge call (pushes spend past cap).
        budget.recordCall({ promptTokens: 1500, completionTokens: 80, totalTokens: 1580 });
        return fakeResult(path.join(root, 'generated', 'runs', 'a'), 'a');
      });
      const summary = await runBatch({
        briefPaths: ['briefs/a.yaml', 'briefs/b.yaml', 'briefs/c.yaml'],
        repoRoot: root,
        outputRoot: path.join(root, 'generated'),
        judgeBudget: budget,
        judgeCache: null,
        provider: noopImageProvider(),
        generate,
        now: fixedClock,
      });
      expect(generate).toHaveBeenCalledTimes(1);
      expect(summary.briefs.map((b) => b.status)).toEqual([
        'succeeded',
        'skipped-over-budget',
        'skipped-over-budget',
      ]);
      expect(summary.totals.briefsSkippedOverBudget).toBe(2);
      expect(summary.judgeBudget).not.toBeNull();
      expect(summary.judgeBudget!.callsThisRun).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('captures a failing brief without stopping the batch', async () => {
    const root = tmpRoot();
    try {
      const calls: string[] = [];
      const generate: RunFullFactory = vi.fn(async (opts) => {
        calls.push(opts.briefPath);
        if (opts.briefPath.endsWith('boom.yaml')) {
          throw new Error('bad-grid: expected 4 got 3');
        }
        return fakeResult(path.join(root, 'generated', 'runs', 'x'), 'x');
      });
      const summary = await runBatch({
        briefPaths: ['briefs/ok1.yaml', 'briefs/boom.yaml', 'briefs/ok2.yaml'],
        repoRoot: root,
        outputRoot: path.join(root, 'generated'),
        judgeBudget: null,
        judgeCache: null,
        provider: noopImageProvider(),
        generate,
        now: fixedClock,
      });
      expect(calls).toHaveLength(3);
      expect(summary.briefs.map((b) => b.status)).toEqual(['succeeded', 'failed', 'succeeded']);
      expect(summary.briefs[1]!.error?.message).toContain('bad-grid');
      expect(summary.totals.briefsFailed).toBe(1);
      expect(summary.totals.briefsSucceeded).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes batch-summary.json incrementally so a Ctrl-C mid-batch leaves usable evidence', async () => {
    const root = tmpRoot();
    try {
      const batchDir = path.join(root, 'generated', 'runs', '_batch', 'fixed');
      let snapshotAfterFirst: string | null = null;
      const generate: RunFullFactory = vi.fn(async (_opts) => {
        // Capture the on-disk summary immediately after brief 1 returns
        // but BEFORE brief 2 starts (via onBriefComplete hook below).
        return fakeResult(path.join(root, 'generated', 'runs', 'x'), 'x');
      });
      const summary = await runBatch({
        briefPaths: ['briefs/one.yaml', 'briefs/two.yaml'],
        repoRoot: root,
        outputRoot: path.join(root, 'generated'),
        batchDir,
        judgeBudget: null,
        judgeCache: null,
        provider: noopImageProvider(),
        generate,
        now: fixedClock,
        onBriefComplete: (_result, index) => {
          if (index === 0) {
            snapshotAfterFirst = readFileSync(path.join(batchDir, 'batch-summary.json'), 'utf8');
          }
        },
      });
      expect(snapshotAfterFirst).not.toBeNull();
      // Snapshot after brief 1 must:
      //   - exist + parse,
      //   - contain exactly brief 1 (brief 2 not yet recorded),
      //   - have finishedAt = null because the batch is still in flight.
      const parsed = JSON.parse(snapshotAfterFirst!) as typeof summary;
      expect(parsed.briefs).toHaveLength(1);
      expect(parsed.briefs[0]!.briefPath).toBe('briefs/one.yaml');
      expect(parsed.finishedAt).toBeNull();
      // Returned summary covers both briefs.
      expect(summary.briefs).toHaveLength(2);
      // Final summary on disk reflects both briefs + finishedAt populated.
      const finalOnDisk = JSON.parse(
        readFileSync(path.join(batchDir, 'batch-summary.json'), 'utf8'),
      ) as typeof summary;
      expect(finalOnDisk.briefs).toHaveLength(2);
      expect(finalOnDisk.finishedAt).not.toBeNull();
      expect(existsSync(path.join(batchDir, 'batch-summary.json'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('threads the same budget + cache instances through every brief (stats accumulate)', async () => {
    const root = tmpRoot();
    try {
      const stateFile = path.join(root, 'cost-state.json');
      const budget = new JudgeBudget({
        budgetUsd: Number.POSITIVE_INFINITY,
        modelDeployment: 'gpt-4o',
        stateFile,
        reset: true,
      });
      const cache = new JudgeCache({ cacheDir: path.join(root, 'cache') });
      const generate: RunFullFactory = vi.fn(async (opts) => {
        // Each brief simulates one judge call + one cache miss.
        budget.recordCall({ promptTokens: 1500, completionTokens: 80, totalTokens: 1580 });
        cache.put(
          `key-${path.basename(opts.briefPath, '.yaml')}`,
          {
            variantIndex: 0,
            modelDeployment: 'mock',
            judgedAt: '2026-06-07T22:30:00.000Z',
            passed: true,
            minScore: 5,
            styleMatch: { score: 5, rationale: 'r' },
            briefMatch: { score: 5, rationale: 'r' },
            readability: { score: 5, rationale: 'r' },
            rejectedBy: [],
            usage: { promptTokens: 1500, completionTokens: 80, totalTokens: 1580 },
          },
          { variantPath: 'x', briefId: 'b' },
        );
        return fakeResult(path.join(root, 'generated', 'runs', 'x'), 'x');
      });
      const summary = await runBatch({
        briefPaths: ['briefs/a.yaml', 'briefs/b.yaml', 'briefs/c.yaml'],
        repoRoot: root,
        outputRoot: path.join(root, 'generated'),
        judgeBudget: budget,
        judgeCache: cache,
        provider: noopImageProvider(),
        generate,
        now: fixedClock,
      });
      expect(summary.judgeBudget!.callsThisRun).toBe(3);
      expect(summary.judgeCache.misses).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects concurrency > 1 today (documented limitation)', async () => {
    await expect(
      runBatch({
        briefPaths: [],
        repoRoot: '.',
        judgeBudget: null,
        judgeCache: null,
        provider: noopImageProvider(),
        concurrency: 2,
        generate: vi.fn(),
      }),
    ).rejects.toThrow(/concurrency > 1/);
  });
});

describe('projectDryRunCost', () => {
  it('matches the documented "4 variants × ~1500 in + ~80 out × gpt-4o × N briefs" formula', () => {
    const projection = projectDryRunCost({ briefCount: 10 });
    // per-call: 1500/1e6 * 2.50 + 80/1e6 * 10.0 = 0.00375 + 0.0008 = 0.00455
    // total: 0.00455 * 4 * 10 = 0.182
    expect(projection.projectedUsd).toBeCloseTo(0.182, 6);
    expect(projection.variantsPerBrief).toBe(4);
    expect(projection.briefCount).toBe(10);
  });

  it('honours overrides for variant count and rates', () => {
    const projection = projectDryRunCost({
      briefCount: 1,
      variantsPerBrief: 9,
      inputTokensPerCall: 1000,
      outputTokensPerCall: 100,
      inputPerMillionUsd: 1.0,
      outputPerMillionUsd: 4.0,
    });
    // per-call: 1000/1e6 * 1.0 + 100/1e6 * 4.0 = 0.001 + 0.0004 = 0.0014
    // total: 0.0014 * 9 * 1 = 0.0126
    expect(projection.projectedUsd).toBeCloseTo(0.0126, 6);
  });
});

// (BatchBriefResult and RunFullFactory are imported for type usage above;
// the imports stay even if every assertion gets inlined later.)
