/**
 * Integration tests for the judge cost ceiling + vision cache wired
 * into `generateOne`.
 *
 * Coverage:
 *   1. Budget exhaustion: a tiny cap forces only the first variant
 *      through, the rest are tagged `judgeSkipReason: 'over-budget'`,
 *      and the RunSummary surfaces the skip counters cleanly.
 *   2. Cache replay: two `generateOne` runs with identical inputs.
 *      First populates the cache; second issues ZERO provider calls,
 *      all judge scorecards come from cache, and the RunSummary cache
 *      stats reflect this (hits == sensor-passing-variants, misses == 0).
 *   3. Cache + budget interaction: a cache hit must NOT bill the
 *      budget. We pre-seed the cache, then point a $0 budget at the
 *      same brief and assert the run still produces judged scorecards
 *      (the cache hit short-circuits the budget gate, as intended).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';

import { generateOne } from '../../scripts/sprites/generate-one.js';
import { JudgeBudget } from '../../scripts/sprites/cost-tracker.js';
import { JudgeCache } from '../../scripts/sprites/judge-cache.js';
import { loadBrief, type LoadedBrief } from '../../scripts/sprites/load-brief.js';
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
  weapon:
    orientation: diagonal
  edge:
    allowMainTouch: true
    allowDetachedEdgeComponents: true
    maxDetachedEdgePixels: 16
minVariations: 0
postprocessing:
  trimAndFit: false
  minDimension: 64
  paletteMode: strict
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

/**
 * Stamp `index + 1` distinct 16×16 color blocks *inside the existing blade
 * silhouette* so each variant produces distinct processed bytes without
 * changing the outer content bounds that the content-aware slicer infers from
 * the sheet.
 */
function perturbedGoodSword(index: number): Buffer {
  const decoded = PNG.sync.read(buildGoodSwordFixture());
  const colors = [
    [255, 255, 255],
    [120, 90, 60],
    [160, 192, 192],
    [200, 170, 50],
  ] as const;
  for (let k = 0; k <= index; k++) {
    const [r, g, b] = colors[k % colors.length] ?? colors[0];
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

interface Harness {
  root: string;
  briefPath: string;
  preloaded: LoadedBrief;
  outputRoot: string;
}

function setupHarness(): Harness {
  const root = mkdtempSync(path.join(tmpdir(), 'crawler-budget-cache-'));
  mkdirSync(path.join(root, 'data', 'palettes'), { recursive: true });
  mkdirSync(path.join(root, 'docs', 'agent-os'), { recursive: true });
  mkdirSync(path.join(root, 'briefs', 'weapons'), { recursive: true });
  mkdirSync(path.join(root, 'refs'), { recursive: true });
  writeFileSync(path.join(root, 'data', 'palettes', 'test-palette.json'), PALETTE_JSON);
  writeFileSync(path.join(root, 'docs', 'agent-os', 'sprite-style.md'), STYLE_GUIDE);
  const briefPath = path.join(root, 'briefs', 'weapons', 'iron-sword.yaml');
  writeFileSync(briefPath, briefYaml());
  writeFileSync(path.join(root, 'refs', 'a.png'), buildGoodSwordFixture());
  writeFileSync(path.join(root, 'refs', 'b.png'), buildGoodSwordFixture());
  const outputRoot = path.join(root, 'generated');
  const preloaded = loadBrief(briefPath, { projectRoot: root });
  return { root, briefPath, preloaded, outputRoot };
}

const fixedClock = () => new Date('2026-06-05T12:00:00.000Z');
const isJudgedCandidate = (candidate: { judgeSkipReason: string | null }) =>
  candidate.judgeSkipReason === null;

describe('generateOne + JudgeBudget (integration)', () => {
  let harness: Harness;
  afterEach(() => harness && rmSync(harness.root, { recursive: true, force: true }));

  it('skips remaining judge calls once the per-call cost would push spend over the cap', async () => {
    harness = setupHarness();
    // 4 distinct variants — perturb so cache doesn't collapse them all
    // into one entry.
    const variants = [0, 1, 2, 3].map((i) => perturbedGoodSword(i));
    const sheet = tileVariantsIntoSheet(variants, 2, 2);

    // gpt-4o rates: 1500 prompt @ $2.50/M + 80 completion @ $10/M
    //             = $0.00375 + $0.0008 = $0.00455 per call.
    // Set a $0.001 cap: the first call always proceeds (budget not yet
    // exceeded), but post-call spend $0.00455 > $0.001 so calls 2-4 skip.
    const stateFile = path.join(harness.root, 'cost-state.json');
    const budget = new JudgeBudget({
      budgetUsd: 0.001,
      modelDeployment: 'gpt-4o',
      stateFile,
      reset: true,
    });
    const { provider, callCount } = makeCountingVisionProvider(makePerfectScorecard());

    const result = await generateOne({
      briefPath: harness.briefPath,
      preloaded: harness.preloaded,
      provider: makeMockImageProvider(sheet),
      visionProvider: provider,
      judgeBudget: budget,
      repoRoot: harness.root,
      outputRoot: harness.outputRoot,
      now: fixedClock,
      env: {},
    });

    // First variant judged, the next three skipped over-budget.
    expect(callCount()).toBe(1);
    const skipped = result.summary.candidates.filter((c) => c.judgeSkipReason === 'over-budget');
    expect(skipped.length).toBe(3);

    // RunSummary surfaces the budget snapshot.
    expect(result.summary.judgeBudget).not.toBeNull();
    expect(result.summary.judgeBudget!.budgetUsd).toBe(0.001);
    expect(result.summary.judgeBudget!.callsThisRun).toBe(1);
    expect(result.summary.judgeBudget!.callsSkippedDueToBudget).toBe(3);
    expect(result.summary.judgeBudget!.spentUsd).toBeGreaterThan(0);
  });

  it('with budget=Infinity, judges every sensor-passing variant and records spend', async () => {
    harness = setupHarness();
    const variants = [0, 1, 2, 3].map((i) => perturbedGoodSword(i));
    const sheet = tileVariantsIntoSheet(variants, 2, 2);

    const stateFile = path.join(harness.root, 'cost-state.json');
    const budget = new JudgeBudget({
      budgetUsd: Number.POSITIVE_INFINITY,
      modelDeployment: 'gpt-4o',
      stateFile,
      reset: true,
    });
    const { provider, callCount } = makeCountingVisionProvider(makePerfectScorecard());

    const result = await generateOne({
      briefPath: harness.briefPath,
      preloaded: harness.preloaded,
      provider: makeMockImageProvider(sheet),
      visionProvider: provider,
      judgeBudget: budget,
      repoRoot: harness.root,
      outputRoot: harness.outputRoot,
      now: fixedClock,
      env: {},
    });

    expect(callCount()).toBe(4);
    expect(
      result.summary.candidates.filter((c) => c.judgeSkipReason === 'over-budget'),
    ).toHaveLength(0);
    expect(result.summary.judgeBudget!.callsThisRun).toBe(4);
    expect(result.summary.judgeBudget!.callsSkippedDueToBudget).toBe(0);
  });
});

describe('generateOne + JudgeCache (integration)', () => {
  let harness: Harness;
  afterEach(() => harness && rmSync(harness.root, { recursive: true, force: true }));

  it('second run with identical inputs makes ZERO provider calls (full cache replay)', async () => {
    harness = setupHarness();
    const variants = [0, 1, 2, 3].map((i) => perturbedGoodSword(i));
    const sheet = tileVariantsIntoSheet(variants, 2, 2);

    const cacheDir = path.join(harness.root, 'judge-cache');
    const cache = new JudgeCache({ cacheDir });

    // Run 1: cache empty -> all calls go through.
    const run1 = makeCountingVisionProvider(makePerfectScorecard());
    const result1 = await generateOne({
      briefPath: harness.briefPath,
      preloaded: harness.preloaded,
      provider: makeMockImageProvider(sheet),
      visionProvider: run1.provider,
      judgeCache: cache,
      repoRoot: harness.root,
      outputRoot: harness.outputRoot,
      now: fixedClock,
      env: {},
    });
    const firstRunCache = result1.summary.judgeCache;
    expect(firstRunCache).not.toBeNull();
    const firstRunMisses = firstRunCache?.misses ?? 0;
    expect(run1.callCount()).toBe(firstRunMisses);
    expect(firstRunMisses).toBeGreaterThan(0);
    expect(firstRunCache?.bypassed).toBe(0);

    // Run 2: same inputs, same cache -> zero provider calls.
    const run2 = makeCountingVisionProvider(makePerfectScorecard());
    const result2 = await generateOne({
      briefPath: harness.briefPath,
      preloaded: harness.preloaded,
      provider: makeMockImageProvider(sheet),
      visionProvider: run2.provider,
      judgeCache: cache,
      repoRoot: harness.root,
      outputRoot: harness.outputRoot,
      now: fixedClock,
      env: {},
    });
    expect(run2.callCount()).toBe(0);
    // The cache instance was reused, so its stats accumulate across runs.
    // misses should stay unchanged (no new misses); hits should increase from replay.
    expect(result2.summary.judgeCache).toEqual({
      hits: expect.any(Number),
      misses: firstRunMisses,
      bypassed: 0,
    });
    expect(result2.summary.judgeCache!.hits).toBeGreaterThan(firstRunCache?.hits ?? 0);

    // Every judged candidate still has a judge scorecard.
    const judgedCandidates = result2.summary.candidates.filter(isJudgedCandidate);
    expect(judgedCandidates.length).toBeGreaterThan(0);
    for (const c of judgedCandidates) {
      expect(c.judgeScorecard).not.toBeNull();
      expect(c.judgeScorecard!.passed).toBe(true);
    }
  });

  it('a cache hit does not bill the budget (cache and budget interact correctly)', async () => {
    harness = setupHarness();
    const variants = [0, 1, 2, 3].map((i) => perturbedGoodSword(i));
    const sheet = tileVariantsIntoSheet(variants, 2, 2);

    const cacheDir = path.join(harness.root, 'judge-cache');
    const cache = new JudgeCache({ cacheDir });

    // Seed the cache by doing a first run with an Infinity budget.
    const seedBudget = new JudgeBudget({
      budgetUsd: Number.POSITIVE_INFINITY,
      modelDeployment: 'gpt-4o',
      stateFile: path.join(harness.root, 'seed.json'),
      reset: true,
    });
    const seedProv = makeCountingVisionProvider(makePerfectScorecard());
    await generateOne({
      briefPath: harness.briefPath,
      preloaded: harness.preloaded,
      provider: makeMockImageProvider(sheet),
      visionProvider: seedProv.provider,
      judgeBudget: seedBudget,
      judgeCache: cache,
      repoRoot: harness.root,
      outputRoot: harness.outputRoot,
      now: fixedClock,
      env: {},
    });
    const seededMisses = cache.stats.misses;
    expect(seedProv.callCount()).toBe(seededMisses);
    expect(seededMisses).toBeGreaterThan(0);

    // Second run: $0 budget, but everything should come from cache so
    // no actual Azure call happens => no skips, no recorded spend.
    const zeroBudget = new JudgeBudget({
      budgetUsd: 0,
      modelDeployment: 'gpt-4o',
      stateFile: path.join(harness.root, 'zero.json'),
      reset: true,
    });
    const replay = makeCountingVisionProvider(makePerfectScorecard());
    const result = await generateOne({
      briefPath: harness.briefPath,
      preloaded: harness.preloaded,
      provider: makeMockImageProvider(sheet),
      visionProvider: replay.provider,
      judgeBudget: zeroBudget,
      judgeCache: cache,
      repoRoot: harness.root,
      outputRoot: harness.outputRoot,
      now: fixedClock,
      env: {},
    });
    expect(replay.callCount()).toBe(0);
    expect(result.summary.judgeBudget!.spentUsd).toBe(0);
    expect(result.summary.judgeBudget!.callsThisRun).toBe(0);
    expect(result.summary.judgeBudget!.callsSkippedDueToBudget).toBe(0);
    for (const c of result.summary.candidates.filter(isJudgedCandidate)) {
      expect(c.judgeScorecard).not.toBeNull();
    }
  });
});
