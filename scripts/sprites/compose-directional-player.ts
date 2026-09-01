import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { loadBrief } from './load-brief.js';
import { packFrameAtlas } from './pack-frame-atlas.js';
import { scoreCandidate } from './score-candidate.js';

const FRAME_WIDTH = 256;
const FRAME_HEIGHT = 390;
const TARGET_OPAQUE_HEIGHT = 352;
const TARGET_FLOOR_Y = 372;
const FRAMES_PER_DIRECTION = 4;
const RUN_ID = 'directional-v8-accepted-2026-09-01';

const DIRECTIONS = [
  'north',
  'northEast',
  'east',
  'southEast',
  'south',
  'southWest',
  'west',
  'northWest',
] as const;
type Direction = (typeof DIRECTIONS)[number];

interface SourceSpec {
  readonly path: string;
  readonly sourceRun: string;
  readonly variantIndex: number;
}

const SOURCE_SPECS: Readonly<Record<Direction, SourceSpec>> = {
  north: {
    path: 'public/assets/generated/crawler-male-north-neutral-var-0.png',
    sourceRun: 'generated/runs/crawler-male-north-neutral/2026-09-01T03-57-52-850add11',
    variantIndex: 0,
  },
  northEast: {
    path: 'public/assets/generated/crawler-male-north-east-neutral-var-0.png',
    sourceRun: 'generated/runs/crawler-male-north-east-neutral/2026-09-01T04-58-04-65df1199',
    variantIndex: 0,
  },
  east: {
    path: 'public/assets/generated/crawler-male-east-neutral-var-0.png',
    sourceRun: 'generated/runs/crawler-male-east-neutral/2026-09-01T05-05-31-b37e280e',
    variantIndex: 0,
  },
  southEast: {
    path: 'public/assets/generated/crawler-male-south-east-neutral-var-0.png',
    sourceRun: 'generated/runs/crawler-male-south-east-neutral/2026-09-01T05-17-05-0415a115',
    variantIndex: 0,
  },
  south: {
    path: 'public/assets/generated/crawler-male-south-neutral-var-8.png',
    sourceRun: 'generated/runs/crawler-male-south-neutral/external-2026-08-27T06-29-54-7511eaf0',
    variantIndex: 8,
  },
  southWest: {
    path: 'public/assets/generated/crawler-male-south-west-neutral-var-3.png',
    sourceRun: 'generated/runs/crawler-male-south-west-neutral/2026-09-01T05-05-31-5bb9c83c',
    variantIndex: 3,
  },
  west: {
    path: 'public/assets/generated/crawler-male-west-neutral-var-8.png',
    sourceRun: 'generated/runs/crawler-male-west-neutral/2026-09-01T04-12-28-61faa0d0',
    variantIndex: 8,
  },
  northWest: {
    path: 'public/assets/generated/crawler-male-north-west-neutral-var-2.png',
    sourceRun: 'generated/runs/crawler-male-north-west-neutral/2026-09-01T05-25-22-0b6e052a',
    variantIndex: 2,
  },
};

function hash(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function opaqueBounds(png: PNG): { x: number; y: number; width: number; height: number } {
  let x0 = png.width;
  let y0 = png.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      if ((png.data[(y * png.width + x) * 4 + 3] ?? 0) <= 8) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  if (x1 < 0) throw new Error('Directional anchor contains no opaque pixels.');
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

function normalizeAnchor(source: Buffer, preserveBytes: boolean): Buffer {
  if (preserveBytes) return source;
  const decoded = PNG.sync.read(source);
  if (decoded.width !== FRAME_WIDTH || decoded.height !== FRAME_HEIGHT) {
    throw new Error(`Expected ${FRAME_WIDTH}x${FRAME_HEIGHT} directional anchor.`);
  }
  const bounds = opaqueBounds(decoded);
  const targetWidth = Math.round((bounds.width * TARGET_OPAQUE_HEIGHT) / bounds.height);
  if (targetWidth > FRAME_WIDTH) {
    throw new Error(`Normalized anchor width ${targetWidth} exceeds ${FRAME_WIDTH}px canvas.`);
  }
  const left = Math.floor((FRAME_WIDTH - targetWidth) / 2);
  const top = TARGET_FLOOR_Y - TARGET_OPAQUE_HEIGHT + 1;
  const output = new PNG({ width: FRAME_WIDTH, height: FRAME_HEIGHT });
  for (let y = 0; y < TARGET_OPAQUE_HEIGHT; y += 1) {
    const sourceY = bounds.y + Math.floor((y * bounds.height) / TARGET_OPAQUE_HEIGHT);
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = bounds.x + Math.floor((x * bounds.width) / targetWidth);
      const sourceIndex = (sourceY * FRAME_WIDTH + sourceX) * 4;
      const targetIndex = ((top + y) * FRAME_WIDTH + left + x) * 4;
      decoded.data.copy(output.data, targetIndex, sourceIndex, sourceIndex + 4);
    }
  }
  return PNG.sync.write(output);
}

function sway(buffer: Buffer, lean: -2 | 2): Buffer {
  const source = PNG.sync.read(buffer);
  const output = new PNG({ width: source.width, height: source.height });
  for (let y = 0; y < source.height; y += 1) {
    const normalizedY = Math.min(1, Math.max(0, (y - 21) / TARGET_OPAQUE_HEIGHT));
    const rowShift = Math.round(lean * (1 - normalizedY));
    const targetY = y - 4;
    if (targetY < 0) continue;
    for (let x = 0; x < source.width; x += 1) {
      const targetX = x + rowShift;
      if (targetX < 0 || targetX >= source.width) continue;
      const sourceIndex = (y * source.width + x) * 4;
      const targetIndex = (targetY * source.width + targetX) * 4;
      source.data.copy(output.data, targetIndex, sourceIndex, sourceIndex + 4);
    }
  }
  return PNG.sync.write(output);
}

function main(): void {
  const repoRoot = process.cwd();
  const runDir = path.join(repoRoot, 'generated', 'runs', 'player-walk-cycle-male', RUN_ID);
  const processedDir = path.join(runDir, 'processed');
  mkdirSync(processedDir, { recursive: true });

  const loaded = loadBrief(
    path.join(repoRoot, 'briefs', 'characters', 'player-walk-cycle-male.yaml'),
    {
      projectRoot: repoRoot,
    },
  );
  const normalizedByDirection = new Map<Direction, Buffer>();
  const sourceAssets: Array<Record<string, unknown>> = [];

  for (const direction of DIRECTIONS) {
    const spec = SOURCE_SPECS[direction];
    const original = readFileSync(path.join(repoRoot, spec.path));
    const normalized = normalizeAnchor(original, direction === 'south');
    normalizedByDirection.set(direction, normalized);
    const seedName = direction.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    writeFileSync(
      path.join(repoRoot, 'briefs', 'characters', 'seeds', `crawler-male-${seedName}-neutral.png`),
      normalized,
    );
    sourceAssets.push({
      direction,
      assetPath: spec.path.replaceAll('\\', '/'),
      contentHash: hash(normalized),
      originalContentHash: hash(original),
      sourceRun: spec.sourceRun,
      variantIndex: spec.variantIndex,
      transform: 'identity',
    });
  }

  const candidates: Array<Record<string, unknown>> = [];
  const frameBuffers: Buffer[] = [];
  for (const direction of DIRECTIONS) {
    const neutral = normalizedByDirection.get(direction)!;
    const frames = [neutral, sway(neutral, 2), neutral, sway(neutral, -2)];
    for (const frame of frames) {
      const index = frameBuffers.length;
      const scorecard = scoreCandidate(frame, loaded.brief, loaded.palette);
      if (!scorecard.passed) {
        const failures = scorecard.breakdown
          .filter((result) => !result.ok)
          .map((result) => `${result.sensor}: ${result.reason ?? 'failed'}`)
          .join('; ');
        throw new Error(`${direction} frame ${index % FRAMES_PER_DIRECTION} failed: ${failures}`);
      }
      const fileName = `${String(index).padStart(2, '0')}.png`;
      writeFileSync(path.join(processedDir, fileName), frame);
      writeFileSync(
        path.join(processedDir, `${String(index).padStart(2, '0')}.scorecard.json`),
        `${JSON.stringify(scorecard, null, 2)}\n`,
      );
      candidates.push({
        index,
        score: scorecard.score,
        outOf: scorecard.outOf,
        breakdown: scorecard.breakdown,
        processedPath: `generated/runs/player-walk-cycle-male/${RUN_ID}/processed/${fileName}`,
        derivedAnchor: scorecard.derivedAnchor,
        derivedAnchors: scorecard.derivedAnchors,
        judgeScorecard: null,
        combinedPassed: true,
      });
      frameBuffers.push(frame);
    }
  }

  const directions = Object.fromEntries(
    DIRECTIONS.map((direction, row) => [
      direction,
      {
        start: row * FRAMES_PER_DIRECTION,
        end: row * FRAMES_PER_DIRECTION + FRAMES_PER_DIRECTION - 1,
      },
    ]),
  );
  const atlas = packFrameAtlas(frameBuffers, FRAMES_PER_DIRECTION);
  writeFileSync(path.join(runDir, 'atlas-preview.png'), atlas.buffer);
  writeFileSync(
    path.join(runDir, 'summary.json'),
    `${JSON.stringify(
      {
        brief: 'player-walk-cycle-male',
        briefPath: 'briefs/characters/player-walk-cycle-male.yaml',
        runId: RUN_ID,
        promptHash: 'derived-from-immutable-variant-8',
        attempts: 1,
        variantCount: frameBuffers.length,
        candidates,
        chosen: { index: 0, anchor: null, anchors: { hold: null, centerOfGravity: null } },
        frameSequence: {
          enabled: true,
          frameCount: frameBuffers.length,
          frameRate: 8,
          loop: true,
          layout: { columns: FRAMES_PER_DIRECTION, rows: DIRECTIONS.length },
          directions,
          sourceAssets,
        },
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(
    `Composed ${frameBuffers.length} frames at ${atlas.frameWidth}x${atlas.frameHeight} ` +
      `into ${atlas.columns}x${atlas.rows} atlas run ${RUN_ID}.\n`,
  );
}

main();
