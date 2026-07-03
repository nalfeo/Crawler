/**
 * Integration test for the runFull one-shot pipeline (ADR 0024).
 *
 * `runFull` is the developer-facing full pipeline used by the CLI
 * (`sprites:run`) and batch tooling. It composes the sheet-only GENERATE core
 * (`generateSheetCore`) with the SAME shared `run-pipeline.ts` post-process /
 * score / judge helpers the explicit re-run endpoints use, so a one-shot run
 * and a generate → postprocess → judge sequence produce identical artifacts.
 *
 * These assertions (ranked candidates, processed / scorecard / anchor-overlay
 * artifacts, pipeline manifests) previously lived in `generate-one.test.ts`
 * back when GENERATE was a coupled orchestrator. They moved here when GENERATE
 * became sheet-only; `generate-one.test.ts` now asserts the sheet-only
 * contract + the retry gate.
 *
 * No real network and no on-disk briefs from the repo root — the test writes a
 * temporary brief + style guide + palette into a tmp dir.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { runFull } from '../../scripts/sprites/run-full.js';
import { loadBrief, type LoadedBrief } from '../../scripts/sprites/load-brief.js';
import type { GenerateSheetRequest, ImageProvider } from '../../scripts/sprites/provider/types.js';
import {
  buildGoodSwordFixture,
  buildEmptyFixture,
  buildHorizontalBarFixture,
} from '../fixtures/sprites/builders.js';
import { seedGeneratedReference } from '../fixtures/sprites/seed-generated-reference.js';

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

describe('runFull — one-shot full pipeline (integration)', () => {
  let root: string;
  let outputRoot: string;
  let preloaded: LoadedBrief;
  let briefPath: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'crawler-runfull-'));
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
    seedGeneratedReference(root);
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
    const variants = Array.from({ length: 4 }, () => buildGoodSwordFixture());
    const sheet = tileVariantsIntoSheet(variants, 2, 2);
    const result = await runFull({
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

  it('ranks passing candidates ahead of failing ones, then by score desc', async () => {
    // Mix: 2 good + 1 horizontal bar (fails diag axis) + 1 empty (fails bbox).
    const variants = [
      buildGoodSwordFixture(),
      buildHorizontalBarFixture(),
      buildGoodSwordFixture(),
      buildEmptyFixture(),
    ];
    const sheet = tileVariantsIntoSheet(variants, 2, 2);
    const result = await runFull({
      briefPath,
      preloaded,
      provider: makeMockProvider(sheet),
      repoRoot: root,
      outputRoot,
      now: fixedClock,
    });
    const passed = result.summary.candidates.filter((c) => c.passed);
    expect(passed).toHaveLength(2);
    // All passed candidates come before any failed one in the ranking.
    const firstFailIdx = result.summary.candidates.findIndex((c) => !c.passed);
    expect(firstFailIdx).toBe(2);
  });
});
