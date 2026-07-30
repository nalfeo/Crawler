/**
 * Unit tests for `approveFrameSequence` (Slice B walk-cycle approval).
 *
 * Strategy mirrors approve.test.ts: write a synthetic frame-sequence run dir
 * to a tmp directory (with REAL PNG frame bytes, since packFrameStrip/the
 * coherence gate decode them), then call `approveFrameSequence` and assert
 * on the produced strip PNG + manifest `animation` descriptor.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import {
  approveFrameSequence,
  ApproveError,
  type Manifest,
} from '../../../scripts/sprites/approve.js';
import { composeManifestFromShards } from '../../../scripts/sprites/generated-shards.js';

/** A solid-color opaque square, distinct per frame index by a small shape nudge. */
function makeFrame(
  width: number,
  height: number,
  rgb: readonly [number, number, number],
  opaqueCols: number,
): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const opaque = x < opaqueCols;
      png.data[i] = rgb[0];
      png.data[i + 1] = rgb[1];
      png.data[i + 2] = rgb[2];
      png.data[i + 3] = opaque ? 255 : 0;
    }
  }
  return PNG.sync.write(png);
}

interface FakeSequenceRunOptions {
  readonly briefId?: string;
  readonly runId?: string;
  /** RGB + opaque-column-count per frame, in cycle order. */
  readonly frames?: ReadonlyArray<{
    readonly rgb: readonly [number, number, number];
    readonly opaqueCols: number;
  }>;
  readonly frameRate?: number;
  readonly loop?: boolean;
  readonly width?: number;
  readonly height?: number;
  /** Omit the frameSequence field entirely, to test the not-frame-sequence guard. */
  readonly omitFrameSequence?: boolean;
  /**
   * Stamp a stale/bogus absolute `processedPath` onto every candidate, as if
   * the run were generated on a different machine/worktree and rematerialized
   * here — exercises the run-local fallback (round-2 multi-model finding).
   */
  readonly staleProcessedPath?: boolean;
}

const DEFAULT_FRAMES: ReadonlyArray<{
  rgb: readonly [number, number, number];
  opaqueCols: number;
}> = [
  { rgb: [200, 40, 40], opaqueCols: 6 },
  { rgb: [204, 42, 42], opaqueCols: 7 },
  { rgb: [198, 38, 39], opaqueCols: 6 },
];

function writeFakeSequenceRun(
  repoRoot: string,
  options: FakeSequenceRunOptions = {},
): { runDir: string; briefId: string } {
  const briefId = options.briefId ?? 'player-walk';
  const runId = options.runId ?? '2026-06-08T12-00-00-deadbeef';
  const frames = options.frames ?? DEFAULT_FRAMES;
  const width = options.width ?? 8;
  const height = options.height ?? 8;

  const runDir = path.join(repoRoot, 'generated', 'runs', briefId, runId);
  const processedDir = path.join(runDir, 'processed');
  mkdirSync(processedDir, { recursive: true });

  frames.forEach((frame, index) => {
    const padded = String(index).padStart(2, '0');
    writeFileSync(
      path.join(processedDir, `${padded}.png`),
      makeFrame(width, height, frame.rgb, frame.opaqueCols),
    );
  });

  const candidates = frames.map((_, index) => ({
    index,
    score: 7,
    outOf: 7,
    breakdown: [{ sensor: 'palette', ok: true }],
    ...(options.staleProcessedPath
      ? {
          processedPath: path.join(
            tmpdir(),
            'crawler-approve-seq-STALE-DOES-NOT-EXIST',
            'processed',
            `${String(index).padStart(2, '0')}.png`,
          ),
        }
      : {}),
  }));

  writeFileSync(
    path.join(runDir, 'summary.json'),
    JSON.stringify({
      brief: briefId,
      briefPath: `briefs/characters/${briefId}.yaml`,
      runId,
      promptHash: 'deadbeef',
      attempts: 1,
      variantCount: frames.length,
      candidates,
      chosen: { index: 0, anchor: null, anchors: { hold: null, centerOfGravity: null } },
      ...(options.omitFrameSequence
        ? {}
        : {
            frameSequence: {
              enabled: true,
              frameCount: frames.length,
              frameRate: options.frameRate ?? 8,
              loop: options.loop ?? true,
            },
          }),
    }),
  );

  return { runDir, briefId };
}

/**
 * Compose the aggregate manifest view from the on-disk per-asset shards. The
 * aggregate `manifest.json` is no longer written by approve — the shards
 * under `entries/` are the source of truth — so tests read it back through
 * the same composer the build + engine use.
 */
function readManifest(manifestPath: string): Manifest {
  return composeManifestFromShards(path.dirname(manifestPath)) as Manifest;
}

describe('approveFrameSequence', () => {
  let repoRoot: string;
  let publicAssetsDir: string;
  let manifestPath: string;
  let catalogPath: string;
  const fixedNow = () => new Date('2026-06-08T15:30:00.000Z');

  beforeEach(() => {
    repoRoot = mkdtempSync(path.join(tmpdir(), 'crawler-approve-seq-'));
    publicAssetsDir = path.join(repoRoot, 'public', 'assets');
    manifestPath = path.join(publicAssetsDir, 'generated', 'manifest.json');
    catalogPath = path.join(repoRoot, 'src', 'shared', 'data', 'sprite-catalog.json');
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('packs a coherent 3-frame run into one strip and writes the animation descriptor', () => {
    const { runDir, briefId } = writeFakeSequenceRun(repoRoot);
    const entry = approveFrameSequence({
      runDir,
      manifestPath,
      catalogPath,
      publicAssetsDir,
      repoRoot,
      now: fixedNow,
    });

    expect(entry.briefId).toBe(briefId);
    expect(entry.spriteName).toBe(briefId);
    expect(entry.assetPath).toBe(`generated/${briefId}.png`);
    expect(entry.approvedAt).toBe('2026-06-08T15:30:00.000Z');
    expect(entry.anchor).toBeNull();
    expect(entry.animation).toEqual({
      frameWidth: 8,
      frameHeight: 8,
      frameCount: 3,
      frameRate: 8,
      loop: true,
    });

    const assetAbs = path.join(publicAssetsDir, 'generated', `${briefId}.png`);
    const strip = PNG.sync.read(readFileSync(assetAbs));
    expect(strip.width).toBe(24);
    expect(strip.height).toBe(8);

    const manifest = readManifest(manifestPath);
    expect(Object.keys(manifest.entries)).toEqual([briefId]);
    expect(manifest.entries[briefId]).toEqual(entry);
  });

  it('throws frame-incoherent and writes nothing when a frame is a different-colored subject', () => {
    const { runDir } = writeFakeSequenceRun(repoRoot, {
      frames: [
        { rgb: [200, 40, 40], opaqueCols: 6 },
        { rgb: [10, 220, 30], opaqueCols: 6 }, // wildly different palette — drift
        { rgb: [198, 38, 39], opaqueCols: 6 },
      ],
    });

    let caught: unknown;
    try {
      approveFrameSequence({
        runDir,
        manifestPath,
        catalogPath,
        publicAssetsDir,
        repoRoot,
        now: fixedNow,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApproveError);
    expect((caught as ApproveError).kind).toBe('frame-incoherent');

    // Nothing should have been written: no manifest shard, no asset.
    const assetAbs = path.join(publicAssetsDir, 'generated');
    expect(Object.keys(readManifest(manifestPath).entries)).toHaveLength(0);
    expect(() => readFileSync(path.join(assetAbs, 'player-walk.png'))).toThrow();
  });

  it('throws not-frame-sequence for a run whose brief did not opt into frameSequence', () => {
    const { runDir } = writeFakeSequenceRun(repoRoot, { omitFrameSequence: true });
    let caught: unknown;
    try {
      approveFrameSequence({
        runDir,
        manifestPath,
        catalogPath,
        publicAssetsDir,
        repoRoot,
        now: fixedNow,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApproveError);
    expect((caught as ApproveError).kind).toBe('not-frame-sequence');
  });

  it('throws frame-missing when a declared frame index has no matching candidate', () => {
    const { runDir } = writeFakeSequenceRun(repoRoot);
    // Bump frameCount beyond what candidates cover by rewriting summary.json.
    const summaryPath = path.join(runDir, 'summary.json');
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as Record<string, unknown>;
    (summary.frameSequence as Record<string, unknown>).frameCount = 5;
    writeFileSync(summaryPath, JSON.stringify(summary));

    let caught: unknown;
    try {
      approveFrameSequence({
        runDir,
        manifestPath,
        catalogPath,
        publicAssetsDir,
        repoRoot,
        now: fixedNow,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApproveError);
    expect((caught as ApproveError).kind).toBe('frame-missing');
  });

  it('is idempotent-safe: re-approving identical content throws already-approved', () => {
    const { runDir } = writeFakeSequenceRun(repoRoot);
    approveFrameSequence({
      runDir,
      manifestPath,
      catalogPath,
      publicAssetsDir,
      repoRoot,
      now: fixedNow,
    });

    let caught: unknown;
    try {
      approveFrameSequence({
        runDir,
        manifestPath,
        catalogPath,
        publicAssetsDir,
        repoRoot,
        now: fixedNow,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApproveError);
    expect((caught as ApproveError).kind).toBe('already-approved');
  });

  it("falls back to the run-local processed PNG when summary.json's stored processedPath is stale (round-2 multi-model finding)", () => {
    // Simulates a run generated on a different machine/worktree and
    // rematerialized here: summary.json's absolute processedPath entries
    // point at a directory that does not exist locally, but the real PNGs
    // are present under runDir/processed. Approval must not fail outright —
    // it must fall back to the run-local path exactly as `approveVariant`
    // always does.
    const { runDir, briefId } = writeFakeSequenceRun(repoRoot, { staleProcessedPath: true });

    const entry = approveFrameSequence({
      runDir,
      manifestPath,
      catalogPath,
      publicAssetsDir,
      repoRoot,
      now: fixedNow,
    });

    expect(entry.briefId).toBe(briefId);
    expect(entry.animation).toEqual({
      frameWidth: 8,
      frameHeight: 8,
      frameCount: 3,
      frameRate: 8,
      loop: true,
    });
    const assetAbs = path.join(publicAssetsDir, 'generated', `${briefId}.png`);
    const strip = PNG.sync.read(readFileSync(assetAbs));
    expect(strip.width).toBe(24);
    expect(strip.height).toBe(8);
  });
});
