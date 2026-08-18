/**
 * Integration test for the generateOne GENERATE stage (Option B, ADR 0024).
 *
 * Uses a mock ImageProvider that returns a synthetic 2x2 sheet built from the
 * same primitives the unit tests use. Generate must:
 *   load brief -> build prompt -> select OUR reference sprites -> mock provider
 *   -> slice (GATE ONLY) -> store the RAW sheet + a minimal sheet-only summary.
 *
 * It must NOT post-process, score, or judge — those are explicit, re-runnable
 * stages exercised in `run-full.test.ts` and `sprites/rerun.test.ts`. The
 * sliceability retry gate (bad-grid -> retry) is still covered here because it
 * is the one quality check Generate keeps.
 *
 * References are our OWN highest-quality approved generated sprites, selected
 * deterministically per brief (`reference-selector.ts`) — Kenney placeholder
 * spritesheets are retired. The selector is pure, so the caller pre-filters
 * candidates to those present on disk; this test injects a synthetic manifest
 * plus an existence/read shim so no real `public/assets/` files are needed, and
 * asserts the provider is handed bytes for `generated/` assets (never Kenney).
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
import { loadRecordedReferencePngs } from '../../scripts/sprites/load-reference-pngs.js';
import { loadBrief, type LoadedBrief } from '../../scripts/sprites/load-brief.js';
import type { GenerateSheetRequest, ImageProvider } from '../../scripts/sprites/provider/types.js';
import { ProviderError } from '../../scripts/sprites/provider/types.js';
import type { ManifestEntry } from '../../src/shared/generated-assets.js';
import type { SpriteType } from '../../src/shared/sprite-types.js';
import { buildGoodSwordFixture } from '../fixtures/sprites/builders.js';
import { resolvePendingAnnotationsPath } from '../../.github/extensions/sprite-editor/lib/pending-annotation-overlay.mjs';

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

// No `references:` — generation no longer reads them; it selects our own
// approved sprites at generate time. Kept absent to prove briefs need none.
const BRIEF_YAML = `
type: weapon
name: iron-sword
size: { width: 32, height: 32 }
palette: { id: test-palette }
anchor: { x: 16, y: 16 }
tags: [sword]
prompt: An iron sword.
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
 * A 4×4 / 16-cell brief. This is the shape an issue-request synthesises
 * (judge.maxVariants: 16) and the exact case that failed in production with
 * "expected 16 cells, slicer produced 8". We prove the honest happy path:
 * when the sheet genuinely contains 16 sliceable cells the exact-16 gate
 * passes without loosening it.
 */
const BRIEF_YAML_16 = `
type: weapon
name: iron-sword-16
size: { width: 32, height: 32 }
palette: { id: test-palette }
anchor: { x: 16, y: 16 }
tags: [sword]
prompt: An iron sword.
generation:
  sheet: { rows: 4, cols: 4, emptyCells: [], nativeCanvas: 1024 }
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

/** Build a valid, ELIGIBLE (real, high-quality, typed) generated-manifest entry. */
function refEntry(over: Pick<ManifestEntry, 'briefId'> & { type: SpriteType }): ManifestEntry {
  const spriteName = `${over.briefId}-var-0`;
  return {
    spriteName,
    assetPath: `generated/${spriteName}.png`,
    approvedAt: '2026-01-01T00:00:00.000Z',
    sourceRun: 'run-001',
    variantIndex: 0,
    anchor: null,
    sensorScore: '9/10',
    judgeScore: '4',
    ...over,
  };
}

/**
 * A pool of OUR approved weapon sprites the selector can draw from. All eligible
 * and same-`type` as the `iron-sword` briefs, so the selector fills all 3 refs
 * from same-type generated art. None is a Kenney path.
 */
const REFERENCE_CANDIDATES: readonly ManifestEntry[] = [
  refEntry({ briefId: 'battle-axe-v1', type: 'weapon' }),
  refEntry({ briefId: 'war-hammer-v1', type: 'weapon' }),
  refEntry({ briefId: 'dagger-v1', type: 'weapon' }),
  refEntry({ briefId: 'greatsword-v1', type: 'weapon' }),
  refEntry({ briefId: 'short-bow-v1', type: 'weapon' }),
];

/**
 * Reference-plumbing injection shared by every generateOne call: feed the
 * synthetic manifest, treat every asset as present, and return the resolved
 * absolute path as the "PNG" bytes so the test can assert exactly which files
 * were handed to the provider without needing real image bytes on disk.
 */
const refInjection = {
  loadReferenceCandidates: () => REFERENCE_CANDIDATES,
  referenceAssetExists: () => true,
  readReference: (absolutePath: string) => Buffer.from(absolutePath),
} as const;

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

function makeLocalLikeProvider(sheet: Buffer): ImageProvider {
  return {
    capabilities: { referenceImages: false },
    async generateSheet(_req: GenerateSheetRequest): Promise<Buffer> {
      return sheet;
    },
  };
}

/** Mock provider that records the last request so the test can inspect refs. */
function makeCapturingProvider(sheet: Buffer): {
  provider: ImageProvider;
  lastRequest: () => GenerateSheetRequest | null;
} {
  let last: GenerateSheetRequest | null = null;
  return {
    lastRequest: () => last,
    provider: {
      async generateSheet(req: GenerateSheetRequest): Promise<Buffer> {
        last = req;
        return sheet;
      },
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
    writeFileSync(path.join(root, 'data', 'palettes', 'test-palette.json'), PALETTE_JSON);
    writeFileSync(path.join(root, 'docs', 'agent-os', 'sprite-style.md'), STYLE_GUIDE);
    briefPath = path.join(root, 'briefs', 'weapons', 'iron-sword.yaml');
    writeFileSync(briefPath, BRIEF_YAML);
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
      ...refInjection,
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

  it('sends OUR approved generated sprites as references and records the selection (no Kenney)', async () => {
    const variants = Array.from({ length: 4 }, () => buildGoodSwordFixture());
    const sheet = tileVariantsIntoSheet(variants, 2, 2);
    const { provider, lastRequest } = makeCapturingProvider(sheet);
    const result = await generateOne({
      briefPath,
      preloaded,
      provider,
      repoRoot: root,
      outputRoot,
      now: fixedClock,
      ...refInjection,
    });

    // The provider was handed reference PNG bytes drawn from OUR generated
    // assets — the resolved absolute paths all live under public/assets/generated
    // and none is a Kenney placeholder spritesheet.
    const req = lastRequest();
    expect(req).not.toBeNull();
    expect(req!.referencePngs.length).toBe(3);
    for (const buf of req!.referencePngs) {
      const resolved = buf.toString();
      expect(resolved).toContain(path.join('public', 'assets', 'generated'));
      expect(resolved.toLowerCase()).not.toContain('kenney');
    }

    // The run summary records exactly which of our sprites were chosen, so a
    // later rejudge can replay the same references (see load-reference-pngs.ts).
    const selection = result.summary.referenceSprites;
    expect(selection).toBeTruthy();
    expect(selection!.selectorVersion).toBe('v1');
    expect(selection!.requestedCount).toBe(3);
    expect(selection!.selected.length).toBe(3);
    // All eligible candidates were same-type (weapon), so the whole set is same-type.
    expect(selection!.sameTypeCount).toBe(REFERENCE_CANDIDATES.length);
    for (const ref of selection!.selected) {
      expect(ref.type).toBe('weapon');
      expect(ref.assetPath.startsWith('generated/')).toBe(true);
      expect(ref.assetPath.toLowerCase()).not.toContain('kenney');
    }
    // Distinct concepts (no duplicate assets in a single 3-ref set).
    const paths = selection!.selected.map((r) => r.assetPath);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('records references a later rejudge replays verbatim (generate → summary → rejudge)', async () => {
    const variants = Array.from({ length: 4 }, () => buildGoodSwordFixture());
    const sheet = tileVariantsIntoSheet(variants, 2, 2);
    const result = await generateOne({
      briefPath,
      preloaded,
      provider: makeMockProvider(sheet),
      repoRoot: root,
      outputRoot,
      now: fixedClock,
      ...refInjection,
    });

    // A re-judge reloads references straight from the recorded selection — OUR
    // generated assets, resolved under public/assets/ — never the retired Kenney
    // `brief.references`. The bytes it loads must be exactly the files generate
    // selected, proving the generate → summary → rejudge contract end-to-end.
    const replayed = loadRecordedReferencePngs({
      summary: result.summary,
      repoRoot: root,
      assetExists: () => true,
      readReference: (absolutePath: string) => Buffer.from(absolutePath),
    });
    const expectedPaths = result.summary.referenceSprites!.selected.map((ref) =>
      path.resolve(root, 'public', 'assets', ref.assetPath),
    );
    expect(replayed.map((buf) => buf.toString())).toEqual(expectedPaths);
    for (const buf of replayed) {
      expect(buf.toString().toLowerCase()).not.toContain('kenney');
    }
  });

  it('fails fast with an actionable error when no generated references are eligible', async () => {
    const variants = Array.from({ length: 4 }, () => buildGoodSwordFixture());
    const sheet = tileVariantsIntoSheet(variants, 2, 2);
    await expect(
      generateOne({
        briefPath,
        preloaded,
        provider: makeMockProvider(sheet),
        repoRoot: root,
        outputRoot,
        now: fixedClock,
        loadReferenceCandidates: () => [],
        referenceAssetExists: () => true,
        readReference: (absolutePath: string) => Buffer.from(absolutePath),
      }),
    ).rejects.toThrow(/no eligible generated reference sprites/);
  });

  it('does not crash when annotation JSON is temporarily malformed', async () => {
    const variants = Array.from({ length: 4 }, () => buildGoodSwordFixture());
    const sheet = tileVariantsIntoSheet(variants, 2, 2);
    const generatedDir = path.join(root, 'public', 'assets', 'generated');
    mkdirSync(generatedDir, { recursive: true });
    writeFileSync(path.join(generatedDir, 'sprite-editor-annotations.json'), '{', 'utf8');

    const result = await generateOne({
      briefPath,
      preloaded,
      provider: makeMockProvider(sheet),
      repoRoot: root,
      outputRoot,
      now: fixedClock,
      ...refInjection,
    });

    expect(result.summary.variantCount).toBe(4);
    expect(result.summary.referenceSprites?.selected.length).toBeGreaterThan(0);
  });

  it('ignores null annotation notes while honoring disliked=true entries', async () => {
    const variants = Array.from({ length: 4 }, () => buildGoodSwordFixture());
    const sheet = tileVariantsIntoSheet(variants, 2, 2);
    const generatedDir = path.join(root, 'public', 'assets', 'generated');
    mkdirSync(generatedDir, { recursive: true });

    const disliked = refEntry({ briefId: 'alpha-disliked', type: 'weapon' });
    const liked = refEntry({ briefId: 'beta-liked', type: 'weapon' });
    writeFileSync(
      path.join(generatedDir, 'sprite-editor-annotations.json'),
      JSON.stringify(
        {
          sprites: {
            [disliked.spriteName]: { disliked: true },
            'invalid-null-note': null,
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const result = await generateOne({
      briefPath,
      preloaded,
      provider: makeMockProvider(sheet),
      repoRoot: root,
      outputRoot,
      now: fixedClock,
      loadReferenceCandidates: () => [disliked, liked],
      referenceAssetExists: () => true,
      readReference: (absolutePath: string) => Buffer.from(absolutePath),
    });

    const selectedNames =
      result.summary.referenceSprites?.selected.map((entry) => entry.spriteName) ?? [];
    expect(selectedNames).toContain(liked.spriteName);
    expect(selectedNames).not.toContain(disliked.spriteName);
  });

  it('excludes a queued-but-unpromoted disliked sprite via the pending annotation overlay', async () => {
    // Regression for a real gap: `markDurable` cleanup already resets the
    // TRACKED annotations file back to HEAD as soon as a queue-commit
    // succeeds, so a sprite disliked moments ago through the Sprite Editor is
    // invisible there until the reconciler promotes assets/queue. The ONLY
    // place that durable-but-unpromoted dislike is still visible is the
    // editor's untracked per-worktree pending overlay
    // (`pending-annotation-overlay.mjs`). generateOne must consume it via its
    // REAL default wiring (not test injection) so a sprite disliked and
    // queued a moment ago never slips back in as a reference.
    const previousCopilotHome = process.env.COPILOT_HOME;
    const copilotHome = mkdtempSync(path.join(tmpdir(), 'crawler-genone-copilot-home-'));
    process.env.COPILOT_HOME = copilotHome;
    try {
      const variants = Array.from({ length: 4 }, () => buildGoodSwordFixture());
      const sheet = tileVariantsIntoSheet(variants, 2, 2);
      const generatedDir = path.join(root, 'public', 'assets', 'generated');
      mkdirSync(generatedDir, { recursive: true });
      // The tracked file has already been cleaned back to HEAD by markDurable
      // -- it does NOT show the just-disliked sprite.
      writeFileSync(
        path.join(generatedDir, 'sprite-editor-annotations.json'),
        JSON.stringify({ version: 1, sprites: {} }),
        'utf8',
      );

      const disliked = refEntry({ briefId: 'gamma-pending-disliked', type: 'weapon' });
      const liked = refEntry({ briefId: 'delta-liked', type: 'weapon' });

      // Simulate the editor's own writer: a durably-queued dislike is visible
      // ONLY in the untracked pending overlay until promotion reaches this
      // worktree. The path MUST match production's: computed once via the
      // same shared `resolvePendingAnnotationsPath` helper, never duplicated.
      const pendingPath = resolvePendingAnnotationsPath(root);
      mkdirSync(path.dirname(pendingPath), { recursive: true });
      writeFileSync(
        pendingPath,
        JSON.stringify({
          version: 1,
          sprites: {
            [disliked.spriteName]: {
              annotation: { favorite: false, disliked: true, comment: '' },
              base: null,
            },
          },
        }),
        'utf8',
      );

      const result = await generateOne({
        briefPath,
        preloaded,
        provider: makeMockProvider(sheet),
        repoRoot: root,
        outputRoot,
        now: fixedClock,
        loadReferenceCandidates: () => [disliked, liked],
        referenceAssetExists: () => true,
        readReference: (absolutePath: string) => Buffer.from(absolutePath),
      });

      const selectedNames =
        result.summary.referenceSprites?.selected.map((entry) => entry.spriteName) ?? [];
      expect(selectedNames).toContain(liked.spriteName);
      expect(selectedNames).not.toContain(disliked.spriteName);
    } finally {
      if (previousCopilotHome === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = previousCopilotHome;
      rmSync(copilotHome, { recursive: true, force: true });
    }
  });

  it('skips reference selection for providers that declare no reference-image support', async () => {
    const variants = Array.from({ length: 4 }, () => buildGoodSwordFixture());
    const sheet = tileVariantsIntoSheet(variants, 2, 2);
    const result = await generateOne({
      briefPath,
      preloaded,
      provider: makeLocalLikeProvider(sheet),
      repoRoot: root,
      outputRoot,
      now: fixedClock,
      loadReferenceCandidates: () => [],
      referenceAssetExists: () => true,
      readReference: () => Buffer.alloc(0),
    });

    expect(result.summary.referenceSprites).toBeUndefined();
    expect(result.summary.variantCount).toBe(4);
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
      ...refInjection,
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
        ...refInjection,
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
        ...refInjection,
      }),
    ).rejects.toMatchObject({ kind: 'bad-grid' });
    expect(callCount()).toBe(2);
  });
});

/**
 * A minimal 2×2 icon-batch brief (4 cells, 4 iconBatch entries). Used to
 * exercise the icon-batch-specific mismatch gate in `generateSheetCore`: when
 * the slicer returns fewer cells than the brief requires, the orchestrator must
 * surface a `bad-grid` error and retry rather than proceeding with a broken
 * index mapping.
 */
const ICON_BATCH_BRIEF_YAML = `
type: icon
name: test-icon-batch
size: { width: 32, height: 32 }
palette: { id: test-palette }
anchor: { x: 8, y: 8 }
prompt: Pixel-art icons for testing.
generation:
  sheet: { rows: 2, cols: 2, emptyCells: [], nativeCanvas: 1024 }
minVariations: 0
iconBatch:
  - id: icon-test-a
    concept: Icon A
  - id: icon-test-b
    concept: Icon B
  - id: icon-test-c
    concept: Icon C
  - id: icon-test-d
    concept: Icon D
`.trim();

/**
 * Provider that returns a 1×1 (single-cell) sheet on the first N calls, then
 * a proper 2×2 four-cell sheet. Used to simulate the icon-batch under-slicing
 * scenario without throwing errors from the provider itself.
 */
function makeUnderSlicingProvider(underSlicedCalls = 1): {
  provider: ImageProvider;
  callCount: () => number;
} {
  let calls = 0;
  return {
    callCount: () => calls,
    provider: {
      async generateSheet(): Promise<Buffer> {
        calls++;
        if (calls <= underSlicedCalls) {
          // Single-cell sheet — the content-aware slicer finds 1 cell,
          // triggering the icon-batch count-mismatch gate.
          return tileVariantsIntoSheet([buildGoodSwordFixture()], 1, 1);
        }
        // Full 4-cell 2×2 sheet — slicer finds all 4, gate passes.
        return tileVariantsIntoSheet(
          Array.from({ length: 4 }, () => buildGoodSwordFixture()),
          2,
          2,
        );
      },
    },
  };
}

describe('generateOne — icon-batch count-mismatch gate and retry', () => {
  let root: string;
  let outputRoot: string;
  let preloaded: LoadedBrief;
  let briefPath: string;

  const fixedClock = () => new Date('2026-06-04T12:00:00.000Z');

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'crawler-iconbatch-'));
    mkdirSync(path.join(root, 'data', 'palettes'), { recursive: true });
    mkdirSync(path.join(root, 'docs', 'agent-os'), { recursive: true });
    mkdirSync(path.join(root, 'briefs', 'icons'), { recursive: true });
    writeFileSync(path.join(root, 'data', 'palettes', 'test-palette.json'), PALETTE_JSON);
    writeFileSync(path.join(root, 'docs', 'agent-os', 'sprite-style.md'), STYLE_GUIDE);
    briefPath = path.join(root, 'briefs', 'icons', 'test-icon-batch.yaml');
    writeFileSync(briefPath, ICON_BATCH_BRIEF_YAML);
    outputRoot = path.join(root, 'generated');
    preloaded = loadBrief(briefPath, { projectRoot: root });
  }, 30_000);

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('retries when first sheet under-slices and succeeds when second sheet has correct count', async () => {
    // Provider returns 1 cell on attempt 1, 4 cells on attempt 2.
    // The icon-batch gate must surface bad-grid on attempt 1 (triggering a
    // retry) and pass on attempt 2, proving the code path at generate-one.ts
    // line 425 is exercised.
    const { provider, callCount } = makeUnderSlicingProvider(1);
    const result = await generateOne({
      briefPath,
      preloaded,
      provider,
      repoRoot: root,
      outputRoot,
      maxAttempts: 3,
      now: fixedClock,
      ...refInjection,
    });
    expect(callCount()).toBe(2);
    expect(result.attempts).toBe(2);
    expect(existsSync(path.join(result.runDir, 'sheet-01.png'))).toBe(true);
  });

  it('exhausts maxAttempts on persistent icon-batch under-slicing and surfaces bad-grid', async () => {
    // Provider always returns 1 cell — the mismatch gate fires on every
    // attempt and the orchestrator exhausts retries, surfacing bad-grid.
    const { provider, callCount } = makeUnderSlicingProvider(999);
    await expect(
      generateOne({
        briefPath,
        preloaded,
        provider,
        repoRoot: root,
        outputRoot,
        maxAttempts: 2,
        now: fixedClock,
        ...refInjection,
      }),
    ).rejects.toMatchObject({ kind: 'bad-grid' });
    expect(callCount()).toBe(2);
  });
});

describe('generateOne — exact-cell slice gate at 16 (Bug B honest happy path)', () => {
  let root: string;
  let outputRoot: string;
  let preloaded: LoadedBrief;
  let briefPath: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'crawler-genone16-'));
    mkdirSync(path.join(root, 'data', 'palettes'), { recursive: true });
    mkdirSync(path.join(root, 'docs', 'agent-os'), { recursive: true });
    mkdirSync(path.join(root, 'briefs', 'weapons'), { recursive: true });
    writeFileSync(path.join(root, 'data', 'palettes', 'test-palette.json'), PALETTE_JSON);
    writeFileSync(path.join(root, 'docs', 'agent-os', 'sprite-style.md'), STYLE_GUIDE);
    briefPath = path.join(root, 'briefs', 'weapons', 'iron-sword-16.yaml');
    writeFileSync(briefPath, BRIEF_YAML_16);
    outputRoot = path.join(root, 'generated');
    preloaded = loadBrief(briefPath, { projectRoot: root });
  }, 30_000);

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('passes the exact-16 gate in one attempt when the sheet has 16 sliceable cells', async () => {
    // 16 good fixtures tiled into a 4×4 sheet — each 1024×1024 cell is a
    // centred sprite on a magenta background, so the content-aware slicer
    // recovers exactly 16 cells and the exact-count gate is satisfied honestly
    // (no gate loosening; the target stays 16).
    const variants = Array.from({ length: 16 }, () => buildGoodSwordFixture());
    const sheet = tileVariantsIntoSheet(variants, 4, 4);
    const result = await generateOne({
      briefPath,
      preloaded,
      provider: makeMockProvider(sheet),
      repoRoot: root,
      outputRoot,
      now: () => new Date('2026-06-04T12:00:00.000Z'),
      ...refInjection,
    });

    expect(result.attempts).toBe(1);
    expect(result.summary.variantCount).toBe(16);
    expect(existsSync(path.join(result.runDir, 'sheet-00.png'))).toBe(true);
    expect(existsSync(result.summaryPath)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Seed-frame prepending
// ─────────────────────────────────────────────────────────────────────────────

const WALK_CYCLE_WITH_SEED_YAML = `
type: character
name: walk-seed-test
size: { width: 64, height: 64 }
palette: { id: test-palette }
anchor: { x: 32, y: 63 }
tags: [character, walk-cycle]
prompt: A test character walking in place.
seedFrames:
  - path: briefs/seeds/frame0.png
    note: Approved frame 0 seed
generation:
  sheet: { rows: 2, cols: 2, emptyCells: [], nativeCanvas: 1024 }
frameSequence:
  enabled: true
  frameCount: 4
  frameRate: 8
  loop: true
sensors:
  anchor:
    mode: center-of-mass
minVariations: 0
postprocessing:
  trimAndFit: false
  minDimension: 64
  paletteMode: strict
`.trim();

const WALK_CYCLE_TRAVERSAL_YAML = `
type: character
name: walk-traversal-test
size: { width: 64, height: 64 }
palette: { id: test-palette }
anchor: { x: 32, y: 63 }
tags: [character, walk-cycle]
prompt: A test character walking in place.
seedFrames:
  - path: ../../outside-repo/secret.png
generation:
  sheet: { rows: 2, cols: 2, emptyCells: [], nativeCanvas: 1024 }
frameSequence:
  enabled: true
  frameCount: 4
  frameRate: 8
  loop: true
sensors:
  anchor:
    mode: center-of-mass
minVariations: 0
postprocessing:
  trimAndFit: false
  minDimension: 64
  paletteMode: strict
`.trim();

describe('generateOne — seed frames are prepended to referencePngs', () => {
  let root: string;
  let outputRoot: string;

  // Valid PNG signature prepended so the magic-byte check passes.
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const SEED_BYTES = Buffer.concat([PNG_MAGIC, Buffer.from('SEED_FRAME_MARKER_BYTES')]);

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'crawler-seedframes-'));
    mkdirSync(path.join(root, 'data', 'palettes'), { recursive: true });
    mkdirSync(path.join(root, 'docs', 'agent-os'), { recursive: true });
    mkdirSync(path.join(root, 'briefs', 'characters'), { recursive: true });
    mkdirSync(path.join(root, 'briefs', 'seeds'), { recursive: true });
    writeFileSync(path.join(root, 'data', 'palettes', 'test-palette.json'), PALETTE_JSON);
    writeFileSync(path.join(root, 'docs', 'agent-os', 'sprite-style.md'), STYLE_GUIDE);
    writeFileSync(path.join(root, 'briefs', 'seeds', 'frame0.png'), SEED_BYTES);
    outputRoot = path.join(root, 'generated');
  }, 30_000);

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('prepends seed frame PNGs before the style reference sprites in referencePngs', async () => {
    const briefPath = path.join(root, 'briefs', 'characters', 'walk-seed-test.yaml');
    writeFileSync(briefPath, WALK_CYCLE_WITH_SEED_YAML);
    const variants = Array.from({ length: 4 }, () => buildGoodSwordFixture());
    const sheet = tileVariantsIntoSheet(variants, 2, 2);

    const readRef = (absolutePath: string): Buffer => {
      if (absolutePath.endsWith('frame0.png')) return SEED_BYTES;
      return Buffer.from(absolutePath);
    };

    const { provider, lastRequest } = makeCapturingProvider(sheet);

    const result = await generateOne({
      briefPath,
      provider,
      repoRoot: root,
      outputRoot,
      now: () => new Date('2026-06-04T12:00:00.000Z'),
      readReference: readRef,
      // Inject identity realpath to avoid macOS /tmp→/private/tmp symlink issues.
      realpath: (p) => p,
      loadReferenceCandidates: () => REFERENCE_CANDIDATES,
      referenceAssetExists: () => true,
    });

    const req = lastRequest();
    expect(req).not.toBeNull();
    // First reference PNG must be the seed frame.
    expect(req!.referencePngs.length).toBeGreaterThan(0);
    expect(req!.referencePngs[0]).toEqual(SEED_BYTES);
    // Remaining entries must NOT be the seed (they're style references).
    const rest = req!.referencePngs.slice(1);
    expect(rest.length).toBeGreaterThan(0);
    expect(rest.every((buf) => !buf.equals(SEED_BYTES))).toBe(true);
    // Seed frames must be recorded in the summary for replay fidelity.
    expect(result.summary.seedFrames).toHaveLength(1);
    expect(result.summary.seedFrames![0]!.path).toBe('briefs/seeds/frame0.png');
    expect(result.summary.seedFrames![0]!.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a seed frame path that escapes the approved briefs/ directory', async () => {
    const briefPath = path.join(root, 'briefs', 'characters', 'walk-traversal-test.yaml');
    writeFileSync(briefPath, WALK_CYCLE_TRAVERSAL_YAML);
    const variants = Array.from({ length: 4 }, () => buildGoodSwordFixture());
    const sheet = tileVariantsIntoSheet(variants, 2, 2);

    await expect(
      generateOne({
        briefPath,
        provider: makeMockProvider(sheet),
        repoRoot: root,
        outputRoot,
        now: () => new Date('2026-06-04T12:00:00.000Z'),
        readReference: () => Buffer.from('bytes'),
        loadReferenceCandidates: () => REFERENCE_CANDIDATES,
        referenceAssetExists: () => true,
      }),
    ).rejects.toThrow(/resolves outside the approved seed directory/);
  });
});
