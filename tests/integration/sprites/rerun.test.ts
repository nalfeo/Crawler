/**
 * Unit tests for the re-run orchestration (`rerun.ts`): re-running PostProcess
 * and Judge over an ALREADY-GENERATED run without regenerating the sheet.
 *
 * Each test seeds a real run through `generateOne` (`seedRun`) into a
 * `LocalRunStore`, then drives the re-run functions over the stored artifacts.
 * Re-running shares the same per-variant pipeline as generation, so a
 * re-post-process reproduces the generation-time processed bytes exactly.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  RerunError,
  loadRunSummary,
  rejudgeRun,
  repostprocessRun,
  resolveRunSheet,
} from '../../../scripts/sprites/rerun.js';
import { buildEmptyFixture, buildGoodSwordFixture } from '../../fixtures/sprites/builders.js';
import { mockVisionProvider, scorecard, seedRun } from '../../fixtures/sprites/seed-run.js';
import type { SeededRun } from '../../fixtures/sprites/seed-run.js';

let root: string;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function freshRoot(): string {
  root = mkdtempSync(path.join(tmpdir(), 'crawler-rerun-'));
  return root;
}

async function processedBytes(seed: SeededRun, index: number): Promise<Buffer> {
  return seed.store.get(
    `${seed.briefId}/${seed.runId}/processed/${String(index).padStart(2, '0')}.png`,
  );
}

describe('loadRunSummary', () => {
  it('returns the parsed summary for an existing run', async () => {
    const seed = await seedRun({ repoRoot: freshRoot() });
    const summary = await loadRunSummary(seed.store, seed.briefId, seed.runId);
    expect(summary.runId).toBe(seed.runId);
    expect(typeof summary.briefPath).toBe('string');
    expect(summary.candidates).toHaveLength(4);
  });

  it('throws run-not-found when the run is absent', async () => {
    const seed = await seedRun({ repoRoot: freshRoot() });
    await expect(loadRunSummary(seed.store, seed.briefId, 'no-such-run')).rejects.toMatchObject({
      name: 'RerunError',
      kind: 'run-not-found',
    });
  });

  it('throws summary-invalid when summary.json is corrupt', async () => {
    const seed = await seedRun({ repoRoot: freshRoot() });
    await seed.store.put(`${seed.briefId}/${seed.runId}/summary.json`, Buffer.from('{not json'));
    await expect(loadRunSummary(seed.store, seed.briefId, seed.runId)).rejects.toMatchObject({
      kind: 'summary-invalid',
    });
  });
});

describe('resolveRunSheet', () => {
  it('defaults to the (only/newest) sheet', async () => {
    const seed = await seedRun({ repoRoot: freshRoot() });
    const { sheetFile, sheetPng } = await resolveRunSheet(seed.store, seed.briefId, seed.runId);
    expect(sheetFile).toBe('sheet-00.png');
    expect(sheetPng.length).toBeGreaterThan(0);
  });

  it('honours an explicit, existing sheet filename', async () => {
    const seed = await seedRun({ repoRoot: freshRoot() });
    const { sheetFile } = await resolveRunSheet(
      seed.store,
      seed.briefId,
      seed.runId,
      'sheet-00.png',
    );
    expect(sheetFile).toBe('sheet-00.png');
  });

  it('rejects an unsupported sheet filename', async () => {
    const seed = await seedRun({ repoRoot: freshRoot() });
    await expect(
      resolveRunSheet(seed.store, seed.briefId, seed.runId, 'foo.png'),
    ).rejects.toMatchObject({ kind: 'unsupported-sheet-filename' });
  });

  it('throws sheet-not-found for a well-formed but absent sheet', async () => {
    const seed = await seedRun({ repoRoot: freshRoot() });
    await expect(
      resolveRunSheet(seed.store, seed.briefId, seed.runId, 'sheet-09.png'),
    ).rejects.toMatchObject({ kind: 'sheet-not-found' });
  });
});

describe('repostprocessRun', () => {
  it('reproduces the generation-time processed bytes and resets judge verdicts', async () => {
    // Seed WITH judge enabled so candidates carry judge verdicts to reset.
    const { provider } = mockVisionProvider([
      scorecard({ style: 5, brief: 5, readability: 5 }),
      scorecard({ style: 5, brief: 5, readability: 5 }),
      scorecard({ style: 5, brief: 5, readability: 5 }),
      scorecard({ style: 5, brief: 5, readability: 5 }),
    ]);
    const seed = await seedRun({
      repoRoot: freshRoot(),
      judgeBlock: '  enabled: true\n  maxVariants: 16',
      visionProvider: provider,
    });
    const before = await loadRunSummary(seed.store, seed.briefId, seed.runId);
    expect(before.candidates.some((c) => c.judgeScorecard !== null)).toBe(true);
    const originalProcessed = await processedBytes(seed, 0);

    const result = await repostprocessRun({
      store: seed.store,
      briefId: seed.briefId,
      runId: seed.runId,
      summary: before,
      brief: seed.brief,
      palette: seed.palette,
    });

    expect(result.sheetFile).toBe('sheet-00.png');
    // Re-slicing + re-post-processing the SAME sheet with the SAME options is
    // byte-for-byte identical to generation.
    expect(await processedBytes(seed, 0)).toEqual(originalProcessed);
    // Judge verdicts are reset; combinedPassed gates on sensors alone.
    for (const c of result.summary.candidates) {
      expect(c.judgeScorecard).toBeNull();
      expect(c.judgeSkipReason).toBeNull();
      expect(c.combinedPassed).toBe(c.passed);
    }
    expect(result.summary.judgeBudget).toBeNull();
    expect(result.summary.judgeCache).toBeNull();
    // Run identity is preserved.
    expect(result.summary.runId).toBe(before.runId);
    expect(result.summary.briefPath).toBe(before.briefPath);
    expect(result.summary.createdAt).toBe(before.createdAt);
  });

  it('honours tweaked post-processing options', async () => {
    const seed = await seedRun({ repoRoot: freshRoot() });
    const before = await loadRunSummary(seed.store, seed.briefId, seed.runId);
    const baseline = await processedBytes(seed, 0);

    // A huge background color tolerance changes which pixels are treated as
    // background, so the processed artifact must differ from the defaults.
    await repostprocessRun({
      store: seed.store,
      briefId: seed.briefId,
      runId: seed.runId,
      summary: before,
      brief: seed.brief,
      palette: seed.palette,
      options: { background: { colorToleranceSq: 5_000_000 } },
    });
    expect(await processedBytes(seed, 0)).not.toEqual(baseline);
  });
});

describe('rejudgeRun', () => {
  it('judges sensor-passing variants and folds verdicts into combinedPassed', async () => {
    const seed = await seedRun({ repoRoot: freshRoot() }); // judge disabled at gen time
    const before = await loadRunSummary(seed.store, seed.briefId, seed.runId);
    const { provider, calls } = mockVisionProvider([
      scorecard({ style: 5, brief: 5, readability: 5 }),
      scorecard({ style: 5, brief: 5, readability: 5 }),
      scorecard({ style: 5, brief: 5, readability: 5 }),
      scorecard({ style: 5, brief: 5, readability: 5 }),
    ]);

    const result = await rejudgeRun({
      store: seed.store,
      briefId: seed.briefId,
      runId: seed.runId,
      summary: before,
      brief: seed.brief,
      referencePngs: seed.referencePngs,
      styleGuide: seed.styleGuide,
      visionProvider: provider,
      env: {},
    });

    expect(calls).toHaveLength(4); // all four good variants sensor-pass
    for (const c of result.summary.candidates) {
      expect(c.judgeScorecard).not.toBeNull();
      expect(c.combinedPassed).toBe(true);
    }
  });

  it('merges a partial re-judge over prior verdicts', async () => {
    const seed = await seedRun({ repoRoot: freshRoot() });
    const before = await loadRunSummary(seed.store, seed.briefId, seed.runId);
    const first = await rejudgeRun({
      store: seed.store,
      briefId: seed.briefId,
      runId: seed.runId,
      summary: before,
      brief: seed.brief,
      referencePngs: seed.referencePngs,
      styleGuide: seed.styleGuide,
      visionProvider: mockVisionProvider([
        scorecard({ style: 5, brief: 5, readability: 5 }),
        scorecard({ style: 5, brief: 5, readability: 5 }),
        scorecard({ style: 5, brief: 5, readability: 5 }),
        scorecard({ style: 5, brief: 5, readability: 5 }),
      ]).provider,
      env: {},
    });

    // Re-judge ONLY variant 0 with a different style score.
    const second = await rejudgeRun({
      store: seed.store,
      briefId: seed.briefId,
      runId: seed.runId,
      summary: first.summary,
      brief: seed.brief,
      referencePngs: seed.referencePngs,
      styleGuide: seed.styleGuide,
      visionProvider: mockVisionProvider([scorecard({ style: 3, brief: 3, readability: 3 })])
        .provider,
      variantIndexes: [0],
      env: {},
    });

    const byIndex = new Map(second.summary.candidates.map((c) => [c.index, c]));
    expect(byIndex.get(0)!.judgeScorecard!.styleMatch.score).toBe(3); // updated
    expect(byIndex.get(1)!.judgeScorecard!.styleMatch.score).toBe(5); // preserved
    expect(byIndex.get(2)!.judgeScorecard!.styleMatch.score).toBe(5); // preserved
    expect(byIndex.get(3)!.judgeScorecard!.styleMatch.score).toBe(5); // preserved
  });

  it('force judges a sensor-failed variant', async () => {
    // Two good (sensor-pass) at 0,3 and two empty (sensor-fail) at 1,2.
    const seed = await seedRun({
      repoRoot: freshRoot(),
      variants: [
        buildGoodSwordFixture(),
        buildEmptyFixture(),
        buildEmptyFixture(),
        buildGoodSwordFixture(),
      ],
    });
    const before = await loadRunSummary(seed.store, seed.briefId, seed.runId);
    const failed = before.candidates.find((c) => !c.passed)!;

    const { provider, calls } = mockVisionProvider([
      scorecard({ style: 4, brief: 4, readability: 4 }),
    ]);
    const result = await rejudgeRun({
      store: seed.store,
      briefId: seed.briefId,
      runId: seed.runId,
      summary: before,
      brief: seed.brief,
      referencePngs: seed.referencePngs,
      styleGuide: seed.styleGuide,
      visionProvider: provider,
      force: true,
      variantIndexes: [failed.index],
      env: {},
    });

    expect(calls).toHaveLength(1); // the forced, sensor-failed variant got judged
    const judged = result.summary.candidates.find((c) => c.index === failed.index)!;
    expect(judged.judgeScorecard).not.toBeNull();

    // The structured per-sensor breakdown (which sensors failed and why) is
    // preserved on the candidate so the PostProcess/Judge UI can surface it.
    const failingSensors = judged.breakdown.filter((s) => s.ok === false);
    expect(failingSensors.length).toBeGreaterThan(0);
    for (const sensor of failingSensors) {
      expect(typeof sensor.sensor).toBe('string');
      expect(typeof (sensor as { reason?: unknown }).reason).toBe('string');
    }
  });

  it('throws processed-missing when a processed PNG is absent', async () => {
    const seed = await seedRun({ repoRoot: freshRoot() });
    const before = await loadRunSummary(seed.store, seed.briefId, seed.runId);
    await seed.store.remove(`${seed.briefId}/${seed.runId}/processed/00.png`);

    await expect(
      rejudgeRun({
        store: seed.store,
        briefId: seed.briefId,
        runId: seed.runId,
        summary: before,
        brief: seed.brief,
        referencePngs: seed.referencePngs,
        styleGuide: seed.styleGuide,
        visionProvider: mockVisionProvider([]).provider,
        env: {},
      }),
    ).rejects.toMatchObject({ name: 'RerunError', kind: 'processed-missing' });
  });
});

describe('RerunError', () => {
  it('carries a kind and message', () => {
    const err = new RerunError('sheet-not-found', 'nope');
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe('sheet-not-found');
    expect(err.message).toBe('nope');
  });
});
