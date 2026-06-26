/**
 * Integration test for the generateOne GENERATE stage (Option B, ADR 0024).
 *
 * Uses a mock ImageProvider that returns a synthetic 2x2 sheet built from the
 * same primitives the unit tests use. Generate must:
 *   load brief -> build prompt -> mock provider -> slice (GATE ONLY) ->
 *   store the RAW sheet + a minimal sheet-only summary.
 *
 * It must NOT post-process, score, or judge — those are explicit, re-runnable
 * stages exercised in `run-full.test.ts` and `sprites/rerun.test.ts`. The
 * sliceability retry gate (bad-grid -> retry) is still covered here because it
 * is the one quality check Generate keeps.
 *
 * No real network and no on-disk briefs from the repo root — the test writes a
 * temporary brief + style guide + palette into a tmp dir.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
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
  const sheet = new PNG({ width: cols * cellSize, height: rows * cellSize });
  for (let i = 0; i < variants.length; i++) {
    const cell = PNG.sync.read(variants[i]!);
    if (cell.width !== cellSize || cell.height !== cellSize) {
      throw new Error(
        `tileVariants: variant ${i} is ${cell.width}x${cell.height}, expected 1024x1024`,
      );
    }
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
            Array.from({ length: 4 }, () => buildGoodSwordFixture()),
            2,
            2,
          );
        }
        throw error;
      },
    },
  };
}

describe('generateOne — sheet-only generate stage (integration)', () => {
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

  it('stores ONLY the raw sheet plus a minimal sheet-only summary', async () => {
    // 4 good sword variants. Generate must store the raw sheet and a summary
    // with NO candidates / postprocess / judge — those are explicit later
    // stages (ADR 0024). The sliceability gate still runs internally (it must,
    // to reject bad grids) but its sliced cells are discarded here.
    const variants = Array.from({ length: 4 }, () => buildGoodSwordFixture());
    const sheet = tileVariantsIntoSheet(variants, 2, 2);
    const result = await generateOne({
      briefPath,
      preloaded,
      provider: makeMockProvider(sheet),
      repoRoot: root,
      outputRoot,
      now: fixedClock,
    });

    // The raw sheet + summary are written...
    expect(existsSync(path.join(result.runDir, 'sheet-00.png'))).toBe(true);
    expect(existsSync(result.summaryPath)).toBe(true);
    expect(result.attempts).toBe(1);

    // ...but NOTHING is post-processed: empty candidates and no raw/processed dirs.
    expect(result.summary.candidates).toEqual([]);
    expect(result.summary.diversity).toBeNull();
    expect(result.summary.chosen).toBeNull();
    expect(result.summary.judgeBudget).toBeNull();
    expect(result.summary.judgeCache).toBeNull();
    expect(result.summary.variantCount).toBe(4);
    expect(existsSync(path.join(result.runDir, 'processed'))).toBe(false);
    expect(existsSync(path.join(result.runDir, 'raw'))).toBe(false);

    // Identity + variation metadata is still captured for auditability.
    expect(typeof result.summary.runId).toBe('string');
    expect(result.summary.runId.length).toBeGreaterThan(0);
    expect(Array.isArray(result.summary.variations.final)).toBe(true);
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
    // Sheet-only: the successful (2nd) attempt's sheet is stored; the gate
    // passed but Generate produces no candidates.
    expect(existsSync(path.join(result.runDir, 'sheet-01.png'))).toBe(true);
    expect(result.summary.candidates).toEqual([]);
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
