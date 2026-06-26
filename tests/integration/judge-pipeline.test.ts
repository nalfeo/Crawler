/**
 * Integration test for the VLM judge wired into runFull.
 *
 * Mocks both ImageProvider (returns a 2x2 sheet of good-sword fixtures) and
 * VisionProvider (returns canned scorecards keyed by call order). Asserts:
 *   - judge runs only on sensor-passing variants
 *   - processed/NN.judge.json sidecars appear on disk
 *   - summary.candidates carry judgeScorecard + combinedPassed
 *   - chosen prefers higher judge minScore
 *   - maxVariants caps judging; remainder get judgeSkipReason: 'over-cap'
 *   - judge.enabled without a vision provider throws a clear error
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { runFull } from '../../scripts/sprites/run-full.js';
import { loadBrief, type LoadedBrief } from '../../scripts/sprites/load-brief.js';
import type { GenerateSheetRequest, ImageProvider } from '../../scripts/sprites/provider/types.js';
import type {
  VisionProvider,
  EvaluateRequest,
  EvaluateResponse,
} from '../../scripts/sprites/provider/vision-types.js';
import { buildGoodSwordFixture, buildEmptyFixture } from '../fixtures/sprites/builders.js';
import { LocalRunStore } from '../../scripts/sprites/store/local-store.js';
import type { RunStore } from '../../scripts/sprites/store/types.js';

const STYLE_GUIDE = [
  '# Style guide',
  '',
  '> --- STYLE PREAMBLE (do not deviate) ---',
  '>',
  '> Rule 1: no text.',
  '>',
  '> --- END STYLE PREAMBLE ---',
].join('\n');

const PALETTE_JSON = JSON.stringify([
  [0, 0, 0],
  [160, 192, 192],
  [192, 192, 200],
  [255, 255, 255],
]);

function briefYaml(judgeBlock: string): string {
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
${judgeBlock}
`.trim();
}

function tileVariantsIntoSheet(variants: Buffer[], rows: number, cols: number): Buffer {
  if (variants.length !== rows * cols) {
    throw new Error(`tileVariants: expected ${rows * cols} variants, got ${variants.length}`);
  }
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

function makeMockProvider(sheet: Buffer): ImageProvider {
  return {
    async generateSheet(_req: GenerateSheetRequest): Promise<Buffer> {
      return sheet;
    },
  };
}

interface CapturedCall {
  imageLabels: readonly string[];
  systemInstructions: string;
  userPrompt: string;
}

interface MockVision {
  provider: VisionProvider;
  calls: CapturedCall[];
}

/**
 * Vision provider that returns the next canned response per call. Scores are
 * keyed by call index (in the order runFull issues them, which is sensor
 * score desc → index asc).
 */
function mockVisionProvider(responses: EvaluateResponse[]): MockVision {
  const calls: CapturedCall[] = [];
  let i = 0;
  const provider: VisionProvider = {
    modelDeployment: 'mock-vision-deployment',
    async evaluate(req: EvaluateRequest): Promise<EvaluateResponse> {
      calls.push({
        imageLabels: req.images.map((img) => img.label),
        systemInstructions: req.systemInstructions,
        userPrompt: req.userPrompt,
      });
      const res = responses[i++];
      if (!res) {
        throw new Error(`mockVisionProvider: no response staged for call ${i}`);
      }
      return res;
    },
  };
  return { provider, calls };
}

function scorecard(scores: {
  style: number;
  brief: number;
  readability: number;
}): EvaluateResponse {
  return {
    json: {
      style_match: { score: scores.style, rationale: `style ${scores.style}` },
      brief_match: { score: scores.brief, rationale: `brief ${scores.brief}` },
      readability: { score: scores.readability, rationale: `readability ${scores.readability}` },
    },
    modelDeployment: 'mock-vision-deployment',
    usage: { promptTokens: 1500, completionTokens: 80, totalTokens: 1580 },
  };
}

/**
 * A store that behaves like the Azure blob backend for the bits that matter to
 * the judge path: `backend` reports `'azure-blob'` and `resolve()` returns a
 * blob URL (no SAS), while reads/writes still hit a real tmp dir so the rest of
 * the pipeline runs unchanged. Used to reproduce the regression where the judge
 * sidecar was `writeFileSync`'d to a path built from a blob URL.
 */
function makeAzureLikeStore(runsDir: string): RunStore {
  const local = new LocalRunStore(runsDir);
  return {
    backend: 'azure-blob',
    put: (key, data) => local.put(key, data),
    get: (key) => local.get(key),
    has: (key) => local.has(key),
    list: (prefix) => local.list(prefix),
    remove: (key) => local.remove(key),
    resolve: (key) => `https://fake.blob.core.windows.net/generated-runs/${key}`,
  };
}

describe('runFull + VLM judge (integration)', () => {
  let root: string;
  let outputRoot: string;
  let preloaded: LoadedBrief;
  let briefPath: string;

  function setupBrief(judgeBlock: string): void {
    root = mkdtempSync(path.join(tmpdir(), 'crawler-judge-'));
    mkdirSync(path.join(root, 'data', 'palettes'), { recursive: true });
    mkdirSync(path.join(root, 'docs', 'agent-os'), { recursive: true });
    mkdirSync(path.join(root, 'briefs', 'weapons'), { recursive: true });
    mkdirSync(path.join(root, 'refs'), { recursive: true });
    writeFileSync(path.join(root, 'data', 'palettes', 'test-palette.json'), PALETTE_JSON);
    writeFileSync(path.join(root, 'docs', 'agent-os', 'sprite-style.md'), STYLE_GUIDE);
    briefPath = path.join(root, 'briefs', 'weapons', 'iron-sword.yaml');
    writeFileSync(briefPath, briefYaml(judgeBlock));
    writeFileSync(path.join(root, 'refs', 'a.png'), buildGoodSwordFixture());
    writeFileSync(path.join(root, 'refs', 'b.png'), buildGoodSwordFixture());
    outputRoot = path.join(root, 'generated');
    preloaded = loadBrief(briefPath, { projectRoot: root });
  }

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const fixedClock = () => new Date('2026-06-05T12:00:00.000Z');

  it('judges only sensor-passing variants and picks the highest judge minScore', async () => {
    setupBrief('  enabled: true\n  maxVariants: 16');
    // 4 variants: 2 good (sensor-pass), 2 empty (sensor-fail).
    // Sensor-pass order in the run will be: index 0 then index 3
    // (we put empties at 1 and 2). Judge gets called in sensor-score desc
    // order, all good fixtures score identically (~7/7), so call order is
    // index 0 then index 3.
    const variants = [
      buildGoodSwordFixture(),
      buildEmptyFixture(),
      buildEmptyFixture(),
      buildGoodSwordFixture(),
    ];
    const sheet = tileVariantsIntoSheet(variants, 2, 2);
    const { provider: visionProvider, calls } = mockVisionProvider([
      scorecard({ style: 4, brief: 4, readability: 4 }), // index 0: minScore 4
      scorecard({ style: 5, brief: 5, readability: 5 }), // index 3: minScore 5 (winner)
    ]);

    const result = await runFull({
      briefPath,
      preloaded,
      provider: makeMockProvider(sheet),
      visionProvider,
      repoRoot: root,
      outputRoot,
      now: fixedClock,
      env: {},
    });

    // Only 2 vision calls (the sensor-passing ones).
    expect(calls).toHaveLength(2);
    // All three evaluators named in a single call — cost discipline.
    for (const c of calls) {
      expect(c.imageLabels).toContain('candidate');
      expect(c.imageLabels).toContain('readability-composite');
      expect(c.systemInstructions).toMatch(/style_match/);
      expect(c.systemInstructions).toMatch(/brief_match/);
      expect(c.systemInstructions).toMatch(/readability/);
    }

    // 4 candidate entries: 2 passed sensors, 2 failed.
    expect(result.summary.candidates).toHaveLength(4);
    const byIndex = new Map(result.summary.candidates.map((c) => [c.index, c]));

    // Sensor-passing variants have judge scorecards; failing ones don't.
    expect(byIndex.get(0)!.judgeScorecard).not.toBeNull();
    expect(byIndex.get(3)!.judgeScorecard).not.toBeNull();
    expect(byIndex.get(1)!.judgeScorecard).toBeNull();
    expect(byIndex.get(1)!.judgeSkipReason).toBe('sensor-failed');
    expect(byIndex.get(2)!.judgeScorecard).toBeNull();
    expect(byIndex.get(2)!.judgeSkipReason).toBe('sensor-failed');

    // combinedPassed reflects sensor && judge.
    expect(byIndex.get(0)!.combinedPassed).toBe(true);
    expect(byIndex.get(3)!.combinedPassed).toBe(true);
    expect(byIndex.get(1)!.combinedPassed).toBe(false);
    expect(byIndex.get(2)!.combinedPassed).toBe(false);

    // Chosen = highest judge minScore among combined-passers.
    // Variant 3 has minScore 5; variant 0 has minScore 4. So chosen is 3.
    expect(result.summary.chosen).not.toBeNull();
    expect(result.summary.chosen!.index).toBe(3);
    expect(result.summary.chosen!.judgeScorecard).not.toBeNull();
    expect(result.summary.chosen!.judgeScorecard!.styleMatch.score).toBe(5);

    // Judge sidecar artifacts exist on disk.
    expect(existsSync(path.join(result.runDir, 'processed', '00.judge.json'))).toBe(true);
    expect(existsSync(path.join(result.runDir, 'processed', '03.judge.json'))).toBe(true);
    expect(existsSync(path.join(result.runDir, 'processed', '01.judge.json'))).toBe(false);
    expect(existsSync(path.join(result.runDir, 'processed', '02.judge.json'))).toBe(false);

    // Sensor scorecards still present (not overwritten).
    expect(existsSync(path.join(result.runDir, 'processed', '00.scorecard.json'))).toBe(true);
    expect(existsSync(path.join(result.runDir, 'processed', '03.scorecard.json'))).toBe(true);

    // Sidecar contents match scorecard shape.
    const sidecar = JSON.parse(
      readFileSync(path.join(result.runDir, 'processed', '03.judge.json'), 'utf8'),
    );
    expect(sidecar).toMatchObject({
      styleMatch: { score: 5, rationale: 'style 5' },
      briefMatch: { score: 5, rationale: 'brief 5' },
      readability: { score: 5, rationale: 'readability 5' },
      passed: true,
      modelDeployment: 'mock-vision-deployment',
    });
  });

  it('throws when judge.enabled but no visionProvider supplied', async () => {
    setupBrief('  enabled: true\n  maxVariants: 16');
    const variants = Array.from({ length: 4 }, () => buildGoodSwordFixture());
    const sheet = tileVariantsIntoSheet(variants, 2, 2);

    await expect(
      runFull({
        briefPath,
        preloaded,
        provider: makeMockProvider(sheet),
        // visionProvider intentionally omitted
        repoRoot: root,
        outputRoot,
        now: fixedClock,
        env: {},
      }),
    ).rejects.toThrow(/judge\.enabled: true.*vision provider/s);
  });

  it('caps judging to maxVariants and tags the rest with judgeSkipReason: over-cap', async () => {
    setupBrief('  enabled: true\n  maxVariants: 1');
    const variants = Array.from({ length: 4 }, () => buildGoodSwordFixture());
    const sheet = tileVariantsIntoSheet(variants, 2, 2);
    const { provider: visionProvider, calls } = mockVisionProvider([
      scorecard({ style: 5, brief: 5, readability: 5 }),
    ]);

    const result = await runFull({
      briefPath,
      preloaded,
      provider: makeMockProvider(sheet),
      visionProvider,
      repoRoot: root,
      outputRoot,
      now: fixedClock,
      env: {},
    });

    // Exactly one vision call, despite 4 sensor-passing variants.
    expect(calls).toHaveLength(1);

    const judged = result.summary.candidates.filter((c) => c.judgeScorecard !== null);
    const overCap = result.summary.candidates.filter((c) => c.judgeSkipReason === 'over-cap');
    expect(judged).toHaveLength(1);
    expect(overCap).toHaveLength(3);

    // Only the judged variant is combinedPassed.
    expect(judged[0]!.combinedPassed).toBe(true);
    for (const e of overCap) {
      expect(e.combinedPassed).toBe(false);
    }
  });

  it('with judge disabled, combinedPassed equals sensors.passed (back-compat)', async () => {
    setupBrief('  enabled: false');
    const variants = Array.from({ length: 4 }, () => buildGoodSwordFixture());
    const sheet = tileVariantsIntoSheet(variants, 2, 2);
    const { provider: visionProvider, calls } = mockVisionProvider([]);

    const result = await runFull({
      briefPath,
      preloaded,
      provider: makeMockProvider(sheet),
      visionProvider,
      repoRoot: root,
      outputRoot,
      now: fixedClock,
      env: {},
    });

    expect(calls).toHaveLength(0);
    expect(result.summary.candidates.every((c) => c.judgeScorecard === null)).toBe(true);
    expect(result.summary.candidates.every((c) => c.judgeSkipReason === 'judge-disabled')).toBe(
      true,
    );
    for (const c of result.summary.candidates) {
      expect(c.combinedPassed).toBe(c.passed);
    }
  });

  it('judges against a non-local (azure-blob) store without crashing on the sidecar write', async () => {
    // Regression: the VLM judge wrote `NN.judge.json` with writeFileSync to
    // `store.resolve(storeKey('processed'))`. For the Azure backend that resolves
    // to a blob URL, so `path.join(url, 'NN.judge.json')` produced a bogus relative
    // path under the CWD and threw ENOENT. The fix omits `processedDir` off-local;
    // the scorecard still flows into the summary, so no judge data is lost.
    setupBrief('  enabled: true\n  maxVariants: 16');
    const variants = [
      buildGoodSwordFixture(),
      buildEmptyFixture(),
      buildEmptyFixture(),
      buildGoodSwordFixture(),
    ];
    const sheet = tileVariantsIntoSheet(variants, 2, 2);
    const { provider: visionProvider, calls } = mockVisionProvider([
      scorecard({ style: 4, brief: 4, readability: 4 }),
      scorecard({ style: 5, brief: 5, readability: 5 }),
    ]);
    const store = makeAzureLikeStore(path.join(root, 'azure-runs'));

    // Must not throw (pre-fix this rejected with ENOENT from the sidecar write).
    const result = await runFull({
      briefPath,
      preloaded,
      provider: makeMockProvider(sheet),
      visionProvider,
      repoRoot: root,
      outputRoot,
      store,
      now: fixedClock,
      env: {},
    });

    // Judging still ran on both sensor-passing variants...
    expect(calls).toHaveLength(2);
    // ...and the scorecards are embedded in the summary (no data lost despite
    // skipping the standalone local sidecar file).
    const judged = result.summary.candidates.filter((c) => c.judgeScorecard !== null);
    expect(judged).toHaveLength(2);
    expect(judged.every((c) => typeof c.judgeScorecard!.passed === 'boolean')).toBe(true);
    // Recorded paths are blob URLs, and the buggy CWD-relative sidecar dir was
    // never created.
    expect(result.summary.candidates[0]!.processedPath).toMatch(/^https:\/\//);
    expect(existsSync(path.join(process.cwd(), 'https:'))).toBe(false);
  });
});
