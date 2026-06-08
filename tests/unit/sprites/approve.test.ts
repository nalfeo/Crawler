/**
 * Unit tests for approve.ts.
 *
 * Strategy: write a synthetic run dir to a tmp directory, then call
 * `approveVariant` against it and assert on the produced asset PNG +
 * manifest. Keeps tests against real fs (no mocks) so behaviour is
 * exercised end-to-end at the file level.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  approveVariant,
  ApproveError,
  MANIFEST_VERSION,
  type Manifest,
} from '../../../scripts/sprites/approve.js';

interface FakeRunOptions {
  readonly briefId?: string;
  readonly runId?: string;
  readonly variantIndices?: ReadonlyArray<number>;
  readonly chosenIndex?: number;
  readonly chosenAnchor?: { x: number; y: number; source: 'derived' | 'brief' } | null;
  /** Write `processed/NN.anchor.json` for the given indices. */
  readonly derivedAnchorFor?: ReadonlyArray<number>;
  /** Attach a judge scorecard with this minScore to the listed indices. */
  readonly judgeFor?: ReadonlyArray<{ index: number; minScore: number }>;
}

function writeFakeRun(
  repoRoot: string,
  options: FakeRunOptions = {},
): { runDir: string; briefId: string } {
  const briefId = options.briefId ?? 'iron-sword';
  const runId = options.runId ?? '2026-06-08T12-00-00-deadbeef';
  const indices = options.variantIndices ?? [0, 1, 2];
  const chosenIndex = options.chosenIndex ?? indices[0]!;
  const judgeByIndex = new Map((options.judgeFor ?? []).map((j) => [j.index, j.minScore]));
  const derivedSet = new Set(options.derivedAnchorFor ?? []);

  const runDir = path.join(repoRoot, 'generated', 'runs', briefId, runId);
  const processedDir = path.join(runDir, 'processed');
  mkdirSync(processedDir, { recursive: true });

  // Distinct fake PNG bodies per variant so we can prove the copy picked the right one.
  for (const idx of indices) {
    const padded = String(idx).padStart(2, '0');
    writeFileSync(path.join(processedDir, `${padded}.png`), Buffer.from(`PNG-${idx}`));
    writeFileSync(
      path.join(processedDir, `${padded}.scorecard.json`),
      JSON.stringify({ score: 7, outOf: 7, passed: true, breakdown: [], derivedAnchor: null }),
    );
    if (derivedSet.has(idx)) {
      writeFileSync(
        path.join(processedDir, `${padded}.anchor.json`),
        JSON.stringify({ x: 4 + idx, y: 12, source: 'derived' }),
      );
    }
  }

  const candidates = indices.map((index) => ({
    index,
    score: 7,
    outOf: 7,
    passed: true,
    combinedPassed: true,
    derivedAnchor: derivedSet.has(index) ? { x: 4 + index, y: 12 } : null,
    judgeScorecard:
      judgeByIndex.has(index) === false
        ? null
        : { passed: true, minScore: judgeByIndex.get(index)! },
    judgeSkipReason: null,
  }));

  writeFileSync(
    path.join(runDir, 'summary.json'),
    JSON.stringify({
      brief: briefId,
      briefPath: `briefs/weapons/${briefId}.yaml`,
      runId,
      promptHash: 'deadbeef',
      attempts: 1,
      variantCount: indices.length,
      candidates,
      chosen: {
        index: chosenIndex,
        score: 7,
        outOf: 7,
        passed: true,
        combinedPassed: true,
        anchor:
          options.chosenAnchor === undefined
            ? { x: 8, y: 13, source: 'brief' }
            : options.chosenAnchor,
        judgeScorecard: null,
      },
    }),
  );

  return { runDir, briefId };
}

function readManifest(manifestPath: string): Manifest {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
}

describe('approveVariant', () => {
  let repoRoot: string;
  let publicAssetsDir: string;
  let manifestPath: string;
  let catalogPath: string;
  const fixedNow = () => new Date('2026-06-08T15:30:00.000Z');

  beforeEach(() => {
    repoRoot = mkdtempSync(path.join(tmpdir(), 'crawler-approve-'));
    publicAssetsDir = path.join(repoRoot, 'public', 'assets');
    manifestPath = path.join(publicAssetsDir, 'generated', 'manifest.json');
    catalogPath = path.join(repoRoot, 'src', 'shared', 'data', 'catalog.json');
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('copies the chosen variant PNG and creates the manifest on first approve', () => {
    const { runDir, briefId } = writeFakeRun(repoRoot, {
      derivedAnchorFor: [1],
      judgeFor: [{ index: 1, minScore: 4 }],
    });
    const entry = approveVariant({
      runDir,
      variantIndex: 1,
      manifestPath,
      catalogPath,
      publicAssetsDir,
      repoRoot,
      now: fixedNow,
    });

    expect(entry.briefId).toBe(briefId);
    expect(entry.spriteName).toBe(briefId);
    expect(entry.assetPath).toBe(`generated/${briefId}-var-1.png`);
    expect(entry.variantIndex).toBe(1);
    expect(entry.anchor).toEqual({ x: 5, y: 12, source: 'derived' });
    expect(entry.sensorScore).toBe('7/7');
    expect(entry.judgeScore).toBe('4');
    expect(entry.approvedAt).toBe('2026-06-08T15:30:00.000Z');
    // sourceRun is repo-relative with forward slashes regardless of host OS.
    expect(entry.sourceRun).toBe(`generated/runs/${briefId}/2026-06-08T12-00-00-deadbeef`);
    expect(entry.sourceRun.includes('\\')).toBe(false);

    // The asset PNG was copied with the variant's bytes.
    const assetAbs = path.join(publicAssetsDir, 'generated', `${briefId}-var-1.png`);
    expect(readFileSync(assetAbs).toString()).toBe('PNG-1');

    const manifest = readManifest(manifestPath);
    expect(manifest.version).toBe(MANIFEST_VERSION);
    const entryKey = `${briefId}-var-1`;
    expect(Object.keys(manifest.entries)).toEqual([entryKey]);
    expect(manifest.entries[entryKey]).toEqual(entry);
  });

  it('upserts an existing manifest without dropping other entries (alphabetical key order)', () => {
    // Seed an existing manifest with two unrelated entries.
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    const seeded: Manifest = {
      version: MANIFEST_VERSION,
      entries: {
        zealot: {
          briefId: 'zealot',
          spriteName: 'zealot',
          assetPath: 'generated/zealot.png',
          approvedAt: '2026-06-01T00:00:00.000Z',
          sourceRun: 'generated/runs/zealot/old',
          variantIndex: 0,
          anchor: null,
          sensorScore: '7/7',
          judgeScore: null,
        },
        'cloth-shirt': {
          briefId: 'cloth-shirt',
          spriteName: 'cloth-shirt',
          assetPath: 'generated/cloth-shirt.png',
          approvedAt: '2026-06-01T00:00:00.000Z',
          sourceRun: 'generated/runs/cloth-shirt/old',
          variantIndex: 0,
          anchor: null,
          sensorScore: '7/7',
          judgeScore: null,
        },
      },
    };
    writeFileSync(manifestPath, JSON.stringify(seeded));

    const { runDir, briefId } = writeFakeRun(repoRoot);
    approveVariant({
      runDir,
      variantIndex: 0,
      manifestPath,
      catalogPath,
      publicAssetsDir,
      repoRoot,
      now: fixedNow,
    });

    const manifest = readManifest(manifestPath);
    // Three entries total: old entries + new variant entry
    const expectedKey = `${briefId}-var-0`;
    expect(Object.keys(manifest.entries)).toEqual(['cloth-shirt', expectedKey, 'zealot']);
    expect(manifest.entries['cloth-shirt']!.sourceRun).toBe('generated/runs/cloth-shirt/old');
    expect(manifest.entries.zealot!.sourceRun).toBe('generated/runs/zealot/old');
  });

  it('approving different variants of the same brief creates separate entries', () => {
    const first = writeFakeRun(repoRoot, {
      runId: '2026-06-08T10-00-00-aaaaaaaa',
      variantIndices: [0],
    });
    const first_entry = approveVariant({
      runDir: first.runDir,
      variantIndex: 0,
      manifestPath,
      catalogPath,
      publicAssetsDir,
      repoRoot,
      now: () => new Date('2026-06-08T10:00:00.000Z'),
    });

    const second = writeFakeRun(repoRoot, {
      runId: '2026-06-08T14-00-00-bbbbbbbb',
      variantIndices: [3],
    });
    const second_entry = approveVariant({
      runDir: second.runDir,
      variantIndex: 3,
      manifestPath,
      catalogPath,
      publicAssetsDir,
      repoRoot,
      now: () => new Date('2026-06-08T14:00:00.000Z'),
    });

    const manifest = readManifest(manifestPath);
    // Two entries now: one for each variant of the same brief
    const entryKeys = Object.keys(manifest.entries).sort();
    expect(entryKeys).toEqual([`iron-sword-var-0`, `iron-sword-var-3`]);
    
    expect(manifest.entries[`iron-sword-var-0`]).toEqual(first_entry);
    expect(manifest.entries[`iron-sword-var-0`]!.sourceRun).toContain('aaaaaaaa');
    expect(manifest.entries[`iron-sword-var-0`]!.variantIndex).toBe(0);
    expect(manifest.entries[`iron-sword-var-0`]!.approvedAt).toBe('2026-06-08T10:00:00.000Z');

    expect(manifest.entries[`iron-sword-var-3`]).toEqual(second_entry);
    expect(manifest.entries[`iron-sword-var-3`]!.sourceRun).toContain('bbbbbbbb');
    expect(manifest.entries[`iron-sword-var-3`]!.variantIndex).toBe(3);
    expect(manifest.entries[`iron-sword-var-3`]!.approvedAt).toBe('2026-06-08T14:00:00.000Z');

    // Both PNGs exist
    const assetAbs0 = path.join(publicAssetsDir, 'generated', 'iron-sword-var-0.png');
    const assetAbs3 = path.join(publicAssetsDir, 'generated', 'iron-sword-var-3.png');
    expect(readFileSync(assetAbs0).toString()).toBe('PNG-0');
    expect(readFileSync(assetAbs3).toString()).toBe('PNG-3');
  });

  it('throws variant-not-found when the requested index is not in summary.candidates', () => {
    const { runDir } = writeFakeRun(repoRoot, { variantIndices: [0, 1] });
    expect(() =>
      approveVariant({
        runDir,
        variantIndex: 9,
        manifestPath,
        catalogPath,
        publicAssetsDir,
        repoRoot,
        now: fixedNow,
      }),
    ).toThrowError(ApproveError);
    try {
      approveVariant({
        runDir,
        variantIndex: 9,
        manifestPath,
        catalogPath,
        publicAssetsDir,
        repoRoot,
        now: fixedNow,
      });
    } catch (err) {
      expect((err as ApproveError).kind).toBe('variant-not-found');
    }
    // Manifest must NOT have been created when validation failed.
    expect(existsSync(manifestPath)).toBe(false);
  });

  it('throws processed-missing when the variant PNG is absent', () => {
    const { runDir } = writeFakeRun(repoRoot, { variantIndices: [0, 1] });
    // Delete the variant 1 PNG to simulate a half-written run.
    rmSync(path.join(runDir, 'processed', '01.png'));
    expect(() =>
      approveVariant({
        runDir,
        variantIndex: 1,
        manifestPath,
        catalogPath,
        publicAssetsDir,
        repoRoot,
        now: fixedNow,
      }),
    ).toThrowError(/Processed PNG not found/);
  });

  it('throws run-not-found when summary.json is missing', () => {
    const empty = path.join(repoRoot, 'empty-run');
    mkdirSync(empty, { recursive: true });
    expect(() =>
      approveVariant({
        runDir: empty,
        variantIndex: 0,
        manifestPath,
        catalogPath,
        publicAssetsDir,
        repoRoot,
        now: fixedNow,
      }),
    ).toThrowError(/summary\.json/);
  });

  it('throws manifest-invalid when manifest.json exists with a wrong version', () => {
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify({ version: 99, entries: {} }));
    const { runDir } = writeFakeRun(repoRoot);
    expect(() =>
      approveVariant({
        runDir,
        variantIndex: 0,
        manifestPath,
        catalogPath,
        publicAssetsDir,
        repoRoot,
        now: fixedNow,
      }),
    ).toThrowError(/Unsupported manifest version/);
  });

  it('falls back to chosen.anchor (brief source) when no derived sidecar exists', () => {
    const { runDir } = writeFakeRun(repoRoot, {
      variantIndices: [0],
      chosenAnchor: { x: 8, y: 13, source: 'brief' },
    });
    const entry = approveVariant({
      runDir,
      variantIndex: 0,
      manifestPath,
      catalogPath,
      publicAssetsDir,
      repoRoot,
      now: fixedNow,
    });
    expect(entry.anchor).toEqual({ x: 8, y: 13, source: 'brief' });
  });

  it('records null anchor when derive-mode failed and no brief fallback applies', () => {
    const { runDir } = writeFakeRun(repoRoot, {
      variantIndices: [0],
      chosenAnchor: null,
    });
    const entry = approveVariant({
      runDir,
      variantIndex: 0,
      manifestPath,
      catalogPath,
      publicAssetsDir,
      repoRoot,
      now: fixedNow,
    });
    expect(entry.anchor).toBeNull();
  });
});
