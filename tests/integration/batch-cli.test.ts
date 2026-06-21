/**
 * Integration tests for the batch CLI orchestrator (Phase 3 build 6).
 *
 * Drives `runBatch` against the REAL `generateOne` pipeline with mock
 * image + vision providers — the same scaffolding as
 * `judge-budget-cache.test.ts`, but with three briefs under a shared
 * budget in the no-text-provider path. This is the test that proves
 * all briefs complete deterministically without entering judge passes.
 *
 * Coverage:
 *   1. Three briefs all succeed when no text provider is supplied.
 *   2. No judge pass occurs in this path (asserted via vision provider
 *      call count and zero judged variants).
 *   3. The shared `JudgeCache` remains untouched when no judge pass runs.
 *   4. `batch-summary.json` is written to disk and matches the returned
 *      summary structure.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function briefYaml(): string {
  return `
type: weapon
name: iron-sword
size: { width: 32, height: 32 }
palette: { id: test-palette }
anchor: { x: 16, y: 16 }
tags: [sword]
prompt: An iron sword.
references:
  - { path: refs/a.png }
  - { path: refs/b.png }
generation:
  sheet: { rows: 2, cols: 2, emptyCells: [], nativeCanvas: 1024 }
sensors:
  edge:
    allowMainTouch: true
    allowDetachedEdgeComponents: true
    maxDetachedEdgePixels: 16
  weapon:
    orientation: diagonal
minVariations: 0
postprocessing:
  trimAndFit: false
  minDimension: 64
  paletteMode: strict
judge:
  enabled: false
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
  const colors = [
    [255, 255, 255],
    [120, 90, 60],
    [160, 192, 192],
    [200, 170, 50],
  ] as const;
  for (let k = 0; k <= index; k++) {
    const color = colors[k % colors.length];
    if (!color) {
      throw new Error('expected perturbation color to exist');
    }
    const [r, g, b] = color;
    const baseX = 360 + 64 * k;
    const baseY = 660 - 64 * k;
    for (let dy = 0; dy < 16; dy++) {
      for (let dx = 0; dx < 16; dx++) {
        const px = baseX + dx;
        const py = baseY + dy;
        const idx = (py * decoded.width + px) * 4;
        decoded.data[idx] = r;
        decoded.data[idx + 1] = g;
        decoded.data[idx + 2] = b;
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
  mkdirSync(path.join(root, 'data', 'sprite-types'), { recursive: true });
  mkdirSync(path.join(root, 'docs', 'agent-os'), { recursive: true });
  mkdirSync(path.join(root, 'briefs', 'weapons'), { recursive: true });
  mkdirSync(path.join(root, 'refs'), { recursive: true });
  writeFileSync(path.join(root, 'data', 'palettes', 'test-palette.json'), PALETTE_JSON);
  cpSync(
    path.join(process.cwd(), 'data', 'sprite-types', 'weapon.json'),
    path.join(root, 'data', 'sprite-types', 'weapon.json'),
  );
  writeFileSync(path.join(root, 'docs', 'agent-os', 'sprite-style.md'), STYLE_GUIDE);
  writeFileSync(path.join(root, 'refs', 'a.png'), buildGoodSwordFixture());
  writeFileSync(path.join(root, 'refs', 'b.png'), buildGoodSwordFixture());
  const briefPaths = briefNames.map((name) => {
    const briefPath = path.join(root, 'briefs', 'weapons', `${name}.yaml`);
    writeFileSync(briefPath, briefYaml());
    return briefPath;
  });
  return { root, outputRoot: path.join(root, 'generated'), briefPaths };
}

const fixedClock = () => new Date('2026-06-07T22:30:12.000Z');

describe('runBatch (integration)', () => {
  let harness: BatchHarness;
  afterEach(() => harness && rmSync(harness.root, { recursive: true, force: true }));

  it('completes three briefs and writes a stable batch summary under a shared budget', async () => {
    harness = setupBatchHarness(['iron-sword-1', 'iron-sword-2', 'iron-sword-3']);
    const variants = [0, 1, 2, 3].map((i) => perturbedGoodSword(i));
    const sheet = tileVariantsIntoSheet(variants, 2, 2);

    // Keep a shared budget wired in; this path does not consume it because
    // judge is disabled for these briefs.
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

    // Judge is disabled for this harness, so the batch still succeeds and
    // emits deterministic aggregate output without any vision calls.
    expect(callCount()).toBe(0);

    // Brief outcomes: all briefs complete and produce summaries.
    expect(summary.briefs).toHaveLength(3);
    expect(summary.briefs[0]!.status).toBe('succeeded');
    expect(summary.briefs[1]!.status).toBe('succeeded');
    expect(summary.briefs[2]!.status).toBe('succeeded');

    // Per-brief run-dir and summary are present on success.
    expect(summary.briefs[0]!.runDir).not.toBe('');
    expect(summary.briefs[0]!.summary).toBeDefined();
    expect(summary.briefs[1]!.runDir).not.toBe('');
    expect(summary.briefs[1]!.summary).toBeDefined();
    expect(summary.briefs[2]!.runDir).not.toBe('');
    expect(summary.briefs[2]!.summary).toBeDefined();

    // Totals reflect the same view.
    expect(summary.totals.briefsAttempted).toBe(3);
    expect(summary.totals.briefsSucceeded).toBe(3);
    expect(summary.totals.briefsFailed).toBe(0);
    expect(summary.totals.briefsSkippedOverBudget).toBe(0);
    expect(summary.totals.variantsJudged).toBe(0);
    expect(summary.totals.variantsSkipped).toBe(0);

    // Budget snapshot threaded through correctly.
    expect(summary.judgeBudget).not.toBeNull();
    expect(summary.judgeBudget!.budgetUsd).toBe(0.001);
    expect(summary.judgeBudget!.callsThisRun).toBe(0);
    expect(summary.judgeBudget!.spentUsd).toBe(0);

    // No judge pass => cache remains untouched.
    expect(summary.judgeCache.misses).toBe(0);
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
    expect(onDisk.briefs[1]!.status).toBe('succeeded');
    expect(onDisk.briefs[2]!.status).toBe('succeeded');
    expect(onDisk.totals).toEqual(summary.totals);
  }, 120_000);
});
