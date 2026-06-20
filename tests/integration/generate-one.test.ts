/**
 * Integration test for the generateOne orchestrator.
 *
 * Uses a mock ImageProvider that returns a synthetic 2x2 sheet built from
 * the same primitives the unit tests use. The whole pipeline runs:
 *   load brief -> build prompt -> mock provider -> slice -> postprocess ->
 *   score -> write artifacts -> rank.
 *
 * No real network and no on-disk briefs from the repo root — the test
 * writes a temporary brief + style guide + palette into a tmp dir and
 * points the orchestrator at it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { generateOne } from '../../scripts/sprites/generate-one.js';
import { loadBrief, type LoadedBrief } from '../../scripts/sprites/load-brief.js';
import type { GenerateSheetRequest, ImageProvider } from '../../scripts/sprites/provider/types.js';
import { ProviderError } from '../../scripts/sprites/provider/types.js';
import { buildGoodSwordFixture } from '../fixtures/sprites/builders.js';

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

const BRIEF_YAML = `
type: weapon
name: iron-sword
size: { width: 16, height: 16 }
palette: { id: test-palette }
anchor: { x: 8, y: 8 }
tags: [sword]
prompt: An iron sword.
references:
  - { path: refs/a.png }
  - { path: refs/b.png }
generation:
  sheet:
    rows: 3
    cols: 3
    emptyCells:
      - [0, 1]
      - [1, 0]
      - [1, 1]
      - [1, 2]
      - [2, 1]
    nativeCanvas: 1536
sensors:
  weapon:
    orientation: diagonal
  edge:
    allowMainTouch: true
    allowDetachedEdgeComponents: true
    maxDetachedEdgePixels: 16
`.trim();

/**
 * Tile N variant PNGs (each 1024x1024) into a single rows*1024 x cols*1024 sheet,
 * in row-major reading order. The test feeds this directly to the orchestrator
 * via the mock provider so the slicer recovers each 1024x1024 fixture intact.
 */
function tileVariantsIntoSheet(variants: Buffer[], rows: number, cols: number): Buffer {
  if (variants.length !== rows * cols) {
    throw new Error(`tileVariants: expected ${rows * cols} variants, got ${variants.length}`);
  }
  const cellSize = 1024;
  const gutter = 64;
  const margin = 64;
  const sheet = new PNG({
    width: margin * 2 + cols * cellSize + (cols - 1) * gutter,
    height: margin * 2 + rows * cellSize + (rows - 1) * gutter,
  });
  for (let y = 0; y < sheet.height; y++) {
    for (let x = 0; x < sheet.width; x++) {
      const idx = (y * sheet.width + x) * 4;
      sheet.data[idx] = 255;
      sheet.data[idx + 1] = 0;
      sheet.data[idx + 2] = 255;
      sheet.data[idx + 3] = 255;
    }
  }
  for (let i = 0; i < variants.length; i++) {
    const cell = PNG.sync.read(variants[i]!);
    if (cell.width !== cellSize || cell.height !== cellSize) {
      throw new Error(
        `tileVariants: variant ${i} is ${cell.width}x${cell.height}, expected 1024x1024`,
      );
    }
    const r = Math.floor(i / cols);
    const c = i % cols;
    const x0 = margin + c * (cellSize + gutter);
    const y0 = margin + r * (cellSize + gutter);
    for (let y = 0; y < cellSize; y++) {
      const srcStart = y * cellSize * 4;
      const dstStart = ((y0 + y) * sheet.width + x0) * 4;
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

function makeFailingProvider(
  error: ProviderError,
  succeedsAfter = -1,
): {
  provider: ImageProvider;
  callCount: () => number;
} {
  let calls = 0;
  return {
    callCount: () => calls,
    provider: {
      async generateSheet(): Promise<Buffer> {
        calls++;
        if (succeedsAfter > 0 && calls > succeedsAfter) {
          // Return a valid 4-cell sheet so retries can succeed.
          return tileVariantsIntoSheet(
            [0, 1, 2, 3].map((i) => perturbedGoodSword(i)),
            2,
            2,
          );
        }
        throw error;
      },
    },
  };
}

describe('generateOne (integration)', () => {
  let root: string;
  let outputRoot: string;
  let preloaded: LoadedBrief;
  let briefPath: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'crawler-genone-'));
    mkdirSync(path.join(root, 'data', 'palettes'), { recursive: true });
    mkdirSync(path.join(root, 'docs', 'agent-os'), { recursive: true });
    mkdirSync(path.join(root, 'briefs', 'weapons'), { recursive: true });
    mkdirSync(path.join(root, 'refs'), { recursive: true });
    writeFileSync(path.join(root, 'data', 'palettes', 'test-palette.json'), PALETTE_JSON);
    writeFileSync(path.join(root, 'docs', 'agent-os', 'sprite-style.md'), STYLE_GUIDE);
    briefPath = path.join(root, 'briefs', 'weapons', 'iron-sword.yaml');
    writeFileSync(briefPath, BRIEF_YAML);
    // Two reference PNGs; the orchestrator just passes the bytes through.
    writeFileSync(path.join(root, 'refs', 'a.png'), buildGoodSwordFixture());
    writeFileSync(path.join(root, 'refs', 'b.png'), buildGoodSwordFixture());
    outputRoot = path.join(root, 'generated');
    // Preload so palette resolution honors our tmp `root` instead of cwd.
    preloaded = loadBrief(briefPath, { projectRoot: root });
  }, 30_000);

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const fixedClock = () => new Date('2026-06-04T12:00:00.000Z');

  it('runs the full pipeline end-to-end and writes ranked artifacts', async () => {
    // 4 good sword variants -> all pass -> rank is index-order on score tie.
    const variants = [0, 1, 2, 3].map((i) => perturbedGoodSword(i));
    const sheet = tileVariantsIntoSheet(variants, 2, 2);
    const result = await generateOne({
      briefPath,
      preloaded,
      provider: makeMockProvider(sheet),
      repoRoot: root,
      outputRoot,
      now: fixedClock,
    });
    expect(result.summary.candidates).toHaveLength(4);
    expect(result.summary.candidates.every((c) => c.passed)).toBe(true);
    // Artifacts live where we expect.
    expect(existsSync(path.join(result.runDir, 'sheet-00.png'))).toBe(true);
    expect(existsSync(result.summaryPath)).toBe(true);
    for (const candidate of result.summary.candidates) {
      expect(existsSync(candidate.rawPath)).toBe(true);
      expect(existsSync(candidate.processedPath)).toBe(true);
      expect(existsSync(candidate.scorecardPath)).toBe(true);
      // Every variant gets an anchor-overlay PNG, even when derivation
      // produced no anchor. The file always exists so the gallery can
      // composite it without branching on whether an anchor was found.
      expect(candidate.anchorOverlayPath).toMatch(/\.anchor-overlay\.png$/);
      expect(existsSync(candidate.anchorOverlayPath)).toBe(true);
      const card = JSON.parse(readFileSync(candidate.scorecardPath, 'utf8'));
      expect(card.passed).toBe(true);
      const padded = String(candidate.index).padStart(2, '0');
      const pipelinePath = path.join(result.runDir, 'processed', `${padded}.pipeline.json`);
      expect(existsSync(pipelinePath)).toBe(true);
      const pipeline = JSON.parse(readFileSync(pipelinePath, 'utf8')) as {
        profile?: string;
        steps?: Array<{ file?: string }>;
      };
      expect(pipeline.profile).toBe('default');
      expect(Array.isArray(pipeline.steps)).toBe(true);
      expect((pipeline.steps?.length ?? 0) > 0).toBe(true);
      const firstStep = pipeline.steps?.[0]?.file;
      expect(typeof firstStep).toBe('string');
      if (typeof firstStep === 'string') {
        expect(existsSync(path.join(result.runDir, 'processed', firstStep))).toBe(true);
      }
    }
    expect(result.attempts).toBe(1);
  });

  it('ranks passing candidates by score descending', async () => {
    const variants = [0, 1, 2, 3].map((i) => perturbedGoodSword(i));
    const sheet = tileVariantsIntoSheet(variants, 2, 2);
    const result = await generateOne({
      briefPath,
      preloaded,
      provider: makeMockProvider(sheet),
      repoRoot: root,
      outputRoot,
      now: fixedClock,
    });
    expect(result.summary.candidates).toHaveLength(4);
    expect(result.summary.candidates.every((c) => c.passed)).toBe(true);
    for (let i = 1; i < result.summary.candidates.length; i++) {
      expect(result.summary.candidates[i - 1]!.score).toBeGreaterThanOrEqual(
        result.summary.candidates[i]!.score,
      );
    }
  });

  it('retries on a bad-grid error and ultimately succeeds within maxAttempts', async () => {
    const { provider, callCount } = makeFailingProvider(
      new ProviderError('bad-grid', 'too few cells'),
      1, // fails once, succeeds on second call
    );
    const result = await generateOne({
      briefPath,
      preloaded,
      provider,
      repoRoot: root,
      outputRoot,
      maxAttempts: 3,
      now: fixedClock,
    });
    expect(callCount()).toBe(2);
    expect(result.attempts).toBe(2);
    expect(result.summary.candidates).toHaveLength(4);
  });

  it('does not retry on a non-retryable error (auth)', async () => {
    const { provider, callCount } = makeFailingProvider(new ProviderError('auth', 'bad key'));
    await expect(
      generateOne({
        briefPath,
        preloaded,
        provider,
        repoRoot: root,
        outputRoot,
        maxAttempts: 3,
        now: fixedClock,
      }),
    ).rejects.toMatchObject({ kind: 'auth' });
    expect(callCount()).toBe(1);
  });

  it('exhausts maxAttempts on a persistent retryable error and surfaces the kind', async () => {
    const { provider, callCount } = makeFailingProvider(
      new ProviderError('bad-grid', 'persistent'),
    );
    await expect(
      generateOne({
        briefPath,
        preloaded,
        provider,
        repoRoot: root,
        outputRoot,
        maxAttempts: 2,
        now: fixedClock,
      }),
    ).rejects.toMatchObject({ kind: 'bad-grid' });
    expect(callCount()).toBe(2);
  });
});
