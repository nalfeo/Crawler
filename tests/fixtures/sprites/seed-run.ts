/**
 * Seed a complete, on-disk sprite run via the REAL `runFull` pipeline so
 * the re-run tests (`rerun.ts`, the sidecar re-run endpoints) operate on the
 * exact artifacts a fresh full run produces — no hand-rolled summary stubs.
 *
 * The brief/sheet recipe mirrors `tests/integration/judge-pipeline.test.ts`:
 * a 2x2 sheet of 1024x1024 fixtures that content-aware slicing (ADR 0018)
 * recovers as four variants. Callers choose the four cells (good vs empty) to
 * control which variants pass their sensors.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { runFull } from '../../../scripts/sprites/run-full.js';
import { loadBrief, type LoadedBrief } from '../../../scripts/sprites/load-brief.js';
import type { Brief, PaletteColors } from '../../../scripts/sprites/brief-schema.js';
import type {
  GenerateSheetRequest,
  ImageProvider,
} from '../../../scripts/sprites/provider/types.js';
import type {
  EvaluateRequest,
  EvaluateResponse,
  VisionProvider,
} from '../../../scripts/sprites/provider/vision-types.js';
import { LocalRunStore } from '../../../scripts/sprites/store/local-store.js';
import type { RunStore } from '../../../scripts/sprites/store/types.js';
import { buildGoodSwordFixture } from './builders.js';
import { seedGeneratedReference } from './seed-generated-reference.js';

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

/** Brief YAML with a tweakable `judge:` block (mirrors the judge integration test). */
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

/** Tile four 1024x1024 cells into a single 2048x2048 sheet PNG. */
function tileVariantsIntoSheet(variants: Buffer[], rows = 2, cols = 2): Buffer {
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

export interface MockVision {
  readonly provider: VisionProvider;
  /** One entry per `evaluate` call, in call order. */
  readonly calls: Array<{ imageLabels: readonly string[] }>;
}

/** Vision provider that replays canned scorecards in call order. */
export function mockVisionProvider(responses: EvaluateResponse[]): MockVision {
  const calls: Array<{ imageLabels: readonly string[] }> = [];
  let i = 0;
  const provider: VisionProvider = {
    modelDeployment: 'mock-vision-deployment',
    async evaluate(req: EvaluateRequest): Promise<EvaluateResponse> {
      calls.push({ imageLabels: req.images.map((img) => img.label) });
      const res = responses[i++];
      if (!res) {
        throw new Error(`mockVisionProvider: no response staged for call ${i}`);
      }
      return res;
    },
  };
  return { provider, calls };
}

/** Build a canned judge scorecard response with uniform sub-scores. */
export function scorecard(scores: {
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

export interface SeedRunOptions {
  /** Temp repo root (palette/style/brief/refs live here). */
  readonly repoRoot: string;
  /** Store root; defaults to `<repoRoot>/runs` (matches the sidecar default). */
  readonly runsDir?: string;
  /** `judge:` YAML block. Defaults to disabled. */
  readonly judgeBlock?: string;
  /** Four sheet cells. Defaults to four good-sword fixtures (all sensor-pass). */
  readonly variants?: Buffer[];
  /** Vision provider (only needed when the judge block is enabled). */
  readonly visionProvider?: VisionProvider | null;
  /** Deterministic clock. */
  readonly now?: () => Date;
}

export interface SeededRun {
  readonly root: string;
  readonly runsDir: string;
  readonly store: RunStore;
  readonly briefId: string;
  readonly runId: string;
  readonly brief: Brief;
  readonly palette: PaletteColors;
  readonly briefPath: string;
  readonly preloaded: LoadedBrief;
  readonly referencePngs: Buffer[];
  readonly styleGuide: string;
}

/**
 * Materialise a repo (palette, style guide, brief, references) and run
 * `runFull` into a `LocalRunStore`, returning everything a re-run needs.
 */
export async function seedRun(options: SeedRunOptions): Promise<SeededRun> {
  const root = options.repoRoot;
  const runsDir = options.runsDir ?? path.join(root, 'runs');
  mkdirSync(path.join(root, 'data', 'palettes'), { recursive: true });
  mkdirSync(path.join(root, 'docs', 'agent-os'), { recursive: true });
  mkdirSync(path.join(root, 'briefs', 'weapons'), { recursive: true });
  mkdirSync(path.join(root, 'refs'), { recursive: true });
  writeFileSync(path.join(root, 'data', 'palettes', 'test-palette.json'), PALETTE_JSON);
  writeFileSync(path.join(root, 'docs', 'agent-os', 'sprite-style.md'), STYLE_GUIDE);
  const briefPath = path.join(root, 'briefs', 'weapons', 'iron-sword.yaml');
  writeFileSync(briefPath, briefYaml(options.judgeBlock ?? '  enabled: false'));
  writeFileSync(path.join(root, 'refs', 'a.png'), buildGoodSwordFixture());
  writeFileSync(path.join(root, 'refs', 'b.png'), buildGoodSwordFixture());
  // Generation sends our own approved sprites as references now, so seed one
  // eligible weapon-typed generated entry for the selector to pick.
  seedGeneratedReference(root);

  const preloaded = loadBrief(briefPath, { projectRoot: root });
  const variants = options.variants ?? Array.from({ length: 4 }, () => buildGoodSwordFixture());
  const sheet = tileVariantsIntoSheet(variants);
  const store = new LocalRunStore(runsDir);

  const result = await runFull({
    briefPath,
    preloaded,
    provider: makeMockProvider(sheet),
    ...(options.visionProvider ? { visionProvider: options.visionProvider } : {}),
    repoRoot: root,
    store,
    now: options.now ?? (() => new Date('2026-06-05T12:00:00.000Z')),
    env: {},
  });

  return {
    root,
    runsDir,
    store,
    briefId: preloaded.brief.name,
    runId: result.summary.runId,
    brief: preloaded.brief,
    palette: preloaded.palette,
    briefPath,
    preloaded,
    referencePngs: [buildGoodSwordFixture(), buildGoodSwordFixture()],
    styleGuide: STYLE_GUIDE,
  };
}
