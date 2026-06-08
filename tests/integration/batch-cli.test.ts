/**
 * Integration tests for the batch CLI orchestrator (Phase 3 build 6).
 *
 * Drives `runBatch` against the REAL `generateOne` pipeline with mock
 * image + vision providers — the same scaffolding as
 * `judge-budget-cache.test.ts`, but with three briefs and a shared
 * budget that exhausts mid-batch. This is the test that proves the
 * single ceiling actually stops new briefs from starting.
 *
 * Coverage:
 *   1. Three briefs, budget sized to absorb the first brief's calls but
 *      run out before the second starts → 1 succeeds, 2 marked
 *      `skipped-over-budget`, no `generateOne` work attempted for the
 *      latter two (we assert via the vision provider call count).
 *   2. The shared `JudgeCache` accumulates stats across the briefs that
 *      DO run.
 *   3. `batch-summary.json` is written to disk and matches the returned
 *      summary structure.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';

import { runBatch, type BatchSummary } from '../../scripts/sprites/batch.js';
import { JudgeBudget } from '../../scripts/sprites/cost-tracker.js';
import { generateOne } from '../../scripts/sprites/generate-one.js';
import { JudgeCache } from '../../scripts/sprites/judge-cache.js';
import type { GenerateSheetRequest, ImageProvider } from '../../scripts/sprites/provider/types.js';
import type {
  VisionProvider,
  EvaluateRequest,
  EvaluateResponse,
} from '../../scripts/sprites/provider/vision-types.js';
import { buildGoodSwordFixture } from '../fixtures/sprites/builders.js';

const STYLE_GUIDE = [
  '# Style guide',
  '',
  '> --- STYLE PREAMBLE (do not deviate) ---',
  '> Rule 1: no text.',
  '> --- END STYLE PREAMBLE ---',
].join('\n');

const PALETTE_JSON = JSON.stringify([
  [0, 0, 0],
  [160, 192, 192],
  [192, 192, 200],
  [255, 255, 255],
]);

function briefYaml(name: string): string {
  return `
type: weapon
name: ${name}
size: { width: 16, height: 16 }
palette: { id: test-palette }
anchor: { x: 8, y: 8 }
tags: [sword]
prompt: An iron sword.
references:
  - { path: refs/a.png }
  - { path: refs/b.png }
generation:
  sheet: { rows: 2, cols: 2, emptyCells: [], nativeCanvas: 1024 }
sensors:
  weapon:
    orientation: diagonal
judge:
  enabled: true
  maxVariants: 16
`.trim();
}

function tileVariantsIntoSheet(variants: Buffer[], rows: number, cols: number): Buffer {
  const cellSize = 1024;
  const sheet = new PNG({ width: cols * cellSize, height: rows * cellSize });
  for (let i = 0; i < variants.length; i++) {
    const cell = PNG.sync.read(variants[i]!);
    const r = Math.floor(i / cols);
    const c = i % cols;
    for (let y = 0; y < cellSize; y++) {
      const srcStart = y * cellSize * 4;
      const dstStart = ((r * cellSize + y) * sheet.width + c * cellSize) * 4;
      cell.data.copy(sheet.data, dstStart, srcStart, srcStart + cellSize * 4);
    }
  }
  return PNG.sync.write(sheet);
}

function perturbedGoodSword(index: number): Buffer {
  const decoded = PNG.sync.read(buildGoodSwordFixture());
  for (let k = 0; k <= index; k++) {
    const baseX = 32 + 64 * k;
    const baseY = 32;
    for (let dy = 0; dy < 4; dy++) {
      for (let dx = 0; dx < 4; dx++) {
        const px = baseX + dx;
        const py = baseY + dy;
        const idx = (py * decoded.width + px) * 4;
        decoded.data[idx] = 192;
        decoded.data[idx + 1] = 192;
        decoded.data[idx + 2] = 200;
        decoded.data[idx + 3] = 255;
      }
    }
  }
  return PNG.sync.write(decoded);
}

function makeMockImageProvider(sheet: Buffer): ImageProvider {
  return {
    async generateSheet(_req: GenerateSheetRequest): Promise<Buffer> {
      return sheet;
    },
  };
}

function makeCountingVisionProvider(canned: EvaluateResponse): {
  provider: VisionProvider;
  callCount: () => number;
} {
  let count = 0;
  const provider: VisionProvider = {
    modelDeployment: 'mock-vision-deployment',
    async evaluate(_req: EvaluateRequest): Promise<EvaluateResponse> {
      count += 1;
      return canned;
    },
  };
  return { provider, callCount: () => count };
}

function makePerfectScorecard(): EvaluateResponse {
  return {
    json: {
      style_match: { score: 5, rationale: 'great' },
      brief_match: { score: 5, rationale: 'great' },
      readability: { score: 5, rationale: 'great' },
    },
    modelDeployment: 'mock-vision-deployment',
    usage: { promptTokens: 1500, completionTokens: 80, totalTokens: 1580 },
  };
}

interface BatchHarness {
  root: string;
  outputRoot: string;
  briefPaths: string[];
}

function setupBatchHarness(briefNames: string[]): BatchHarness {
  const root = mkdtempSync(path.join(tmpdir(), 'crawler-batch-'));
  mkdirSync(path.join(root, 'data', 'palettes'), { recursive: true });
  mkdirSync(path.join(root, 'docs', 'agent-os'), { recursive: true });
  mkdirSync(path.join(root, 'briefs', 'weapons'), { recursive: true });
  mkdirSync(path.join(root, 'refs'), { recursive: true });
  writeFileSync(path.join(root, 'data', 'palettes', 'test-palette.json'), PALETTE_JSON);
  writeFileSync(path.join(root, 'docs', 'agent-os', 'sprite-style.md'), STYLE_GUIDE);
  writeFileSync(path.join(root, 'refs', 'a.png'), buildGoodSwordFixture());
  writeFileSync(path.join(root, 'refs', 'b.png'), buildGoodSwordFixture());
  const briefPaths = briefNames.map((name) => {
    const briefPath = path.join(root, 'briefs', 'weapons', `${name}.yaml`);
    writeFileSync(briefPath, briefYaml(name));
    return briefPath;
  });
  return { root, outputRoot: path.join(root, 'generated'), briefPaths };
}

const fixedClock = () => new Date('2026-06-07T22:30:12.000Z');

describe('runBatch (integration)', () => {
  let harness: BatchHarness;
  afterEach(() => harness && rmSync(harness.root, { recursive: true, force: true }));

  it('threads a shared budget across three briefs — one succeeds, two skip over-budget', async () => {
    harness = setupBatchHarness(['iron-sword-1', 'iron-sword-2', 'iron-sword-3']);
    const variants = [0, 1, 2, 3].map((i) => perturbedGoodSword(i));
    const sheet = tileVariantsIntoSheet(variants, 2, 2);

    // gpt-4o: 1500 prompt @ $2.50/M + 80 completion @ $10/M = $0.00455/call.
    // Set cap to $0.001 — brief 1 still runs its 4 variants because the
    // per-variant budget gate inside `generateOne` is bypassed when a
    // JudgeCache is provided (see generate-one.ts line 305: cache
    // misses can't be predicted pre-call, so the gate defers to the
    // cache; this is the "gap noted in report" — a known interaction).
    // After brief 1 the shared budget snapshot is well past $0.001 so
    // wouldExceed() returns true; the BATCH pre-flight gate then skips
    // briefs 2 + 3 entirely (no generateOne invocation). That's the
    // property this test pins down.
    const stateFile = path.join(harness.root, 'cost-state.json');
    const budget = new JudgeBudget({
      budgetUsd: 0.001,
      modelDeployment: 'gpt-4o',
      stateFile,
      reset: true,
    });
    const cacheDir = path.join(harness.root, 'judge-cache');
    const cache = new JudgeCache({ cacheDir });
    const { provider: vision, callCount } = makeCountingVisionProvider(makePerfectScorecard());

    const summary: BatchSummary = await runBatch({
      briefPaths: harness.briefPaths,
      repoRoot: harness.root,
      outputRoot: harness.outputRoot,
      judgeBudget: budget,
      judgeCache: cache,
      provider: makeMockImageProvider(sheet),
      visionProvider: vision,
      now: fixedClock,
      generate: (options) => generateOne({ ...options, env: {} }),
    });

    // 4 vision calls happened (all of brief 1). Briefs 2 + 3 NEVER
    // hit the provider because the batch pre-flight gate skipped them.
    // The reverse — 12 calls (4 per brief × 3 briefs) — would mean
    // the shared-budget plumbing is broken. That's what this assert
    // is really pinning down.
    expect(callCount()).toBe(4);

    // Brief outcomes: brief 1 succeeded; briefs 2 + 3 skipped pre-flight.
    expect(summary.briefs).toHaveLength(3);
    expect(summary.briefs[0]!.status).toBe('succeeded');
    expect(summary.briefs[1]!.status).toBe('skipped-over-budget');
    expect(summary.briefs[2]!.status).toBe('skipped-over-budget');

    // Per-brief run-dir present on success, absent on skip.
    expect(summary.briefs[0]!.runDir).not.toBe('');
    expect(summary.briefs[0]!.summary).toBeDefined();
    expect(summary.briefs[1]!.runDir).toBe('');
    expect(summary.briefs[1]!.summary).toBeUndefined();

    // Totals reflect the same view.
    expect(summary.totals.briefsAttempted).toBe(3);
    expect(summary.totals.briefsSucceeded).toBe(1);
    expect(summary.totals.briefsFailed).toBe(0);
    expect(summary.totals.briefsSkippedOverBudget).toBe(2);
    // Brief 1 judged all 4 variants (cache present bypasses per-variant gate).
    expect(summary.totals.variantsJudged).toBe(4);
    expect(summary.totals.variantsSkipped).toBe(0);

    // Budget snapshot threaded through correctly.
    expect(summary.judgeBudget).not.toBeNull();
    expect(summary.judgeBudget!.budgetUsd).toBe(0.001);
    expect(summary.judgeBudget!.callsThisRun).toBe(4);
    expect(summary.judgeBudget!.spentUsd).toBeGreaterThan(0.001);

    // Cache stats: 4 misses (cold cache, 4 distinct variants in brief 1).
    // Briefs 2/3 skipped pre-flight so no extra cache traffic.
    expect(summary.judgeCache.misses).toBe(4);
    expect(summary.judgeCache.hits).toBe(0);

    // batch-summary.json on disk matches what runBatch returned.
    const onDisk = JSON.parse(
      readFileSync(
        path.join(harness.outputRoot, 'runs', '_batch', summary.batchId, 'batch-summary.json'),
        'utf8',
      ),
    ) as BatchSummary;
    expect(onDisk.batchId).toBe(summary.batchId);
    expect(onDisk.briefs).toHaveLength(3);
    expect(onDisk.briefs[0]!.status).toBe('succeeded');
    expect(onDisk.briefs[1]!.status).toBe('skipped-over-budget');
    expect(onDisk.briefs[2]!.status).toBe('skipped-over-budget');
    expect(onDisk.totals).toEqual(summary.totals);
  }, 60_000);
});
