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
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ASSET_SURFACE_PATHS } from '../../../scripts/sprites/checkin.js';
import {
  approveVariant,
  ApproveError,
  unapproveVariant,
  UnapproveError,
  MANIFEST_VERSION,
  type Manifest,
} from '../../../scripts/sprites/approve.js';
import {
  composeManifestFromShards,
  shardPathForKey,
  writeShard,
} from '../../../scripts/sprites/generated-shards.js';
import { deriveGeneratedCatalogRow } from '../../../src/shared/generated-catalog.js';
import type { ManifestEntry as GeneratedManifestEntry } from '../../../src/shared/generated-assets.js';

interface FakeRunOptions {
  readonly briefId?: string;
  readonly runId?: string;
  readonly variantIndices?: ReadonlyArray<number>;
  readonly chosenIndex?: number;
  readonly chosenAnchor?: { x: number; y: number; source: 'derived' | 'brief' } | null;
  readonly chosenCenterOfGravityAnchor?: {
    x: number;
    y: number;
    source: 'derived' | 'brief';
  } | null;
  /** Write `processed/NN.anchor.json` for the given indices. */
  readonly derivedAnchorFor?: ReadonlyArray<number>;
  readonly centerOfGravityFor?: ReadonlyArray<number>;
  /** Attach a judge scorecard with this minScore to the listed indices. */
  readonly judgeFor?: ReadonlyArray<{ index: number; minScore: number }>;
  /** Attach a hard-blocked judge scorecard to the listed indices. */
  readonly hardBlockedFor?: ReadonlyArray<number>;
  /** Attach a passed=false (but not hard-blocked) judge scorecard to the listed indices. */
  readonly judgeFailedFor?: ReadonlyArray<number>;
  readonly facingOverride?: {
    variantIndex: number;
    direction: 'left' | 'right';
    applyToAllVariants?: boolean;
  } | null;
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
  const hardBlockedSet = new Set(options.hardBlockedFor ?? []);
  const judgeFailedSet = new Set(options.judgeFailedFor ?? []);
  const derivedSet = new Set(options.derivedAnchorFor ?? []);
  const centerOfGravitySet = new Set(options.centerOfGravityFor ?? []);

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
    if (centerOfGravitySet.has(idx)) {
      writeFileSync(
        path.join(processedDir, `${padded}.anchor.cog.json`),
        JSON.stringify({ x: 7, y: 8, source: 'derived' }),
      );
    }
  }

  const candidates = indices.map((index) => ({
    index,
    score: 7,
    outOf: 7,
    passed: true,
    combinedPassed: true,
    breakdown: [
      { sensor: 'palette', ok: true },
      { sensor: 'silhouette', ok: false, reason: 'too-small' },
    ],
    derivedAnchor: derivedSet.has(index) ? { x: 4 + index, y: 12 } : null,
    derivedAnchors: {
      hold: derivedSet.has(index) ? { x: 4 + index, y: 12 } : null,
      centerOfGravity: centerOfGravitySet.has(index) ? { x: 7, y: 8 } : null,
    },
    judgeScorecard: hardBlockedSet.has(index)
      ? {
          passed: false,
          minScore: 1,
          hardBlockEvaluated: true,
          hardBlocked: true,
          hardBlockInstruction: 'I HATE THIS SO MUCH YOU MAY NOT USE THIS IN GAME',
          hardBlockRationale: 'The sheet is fundamentally unusable at game scale.',
          designLanguage: { score: 1, rationale: 'Rejected' },
          briefMatch: { score: 1, rationale: 'Rejected' },
        }
      : judgeFailedSet.has(index)
        ? {
            passed: false,
            minScore: 2,
            hardBlockEvaluated: true,
            hardBlocked: false,
            hardBlockInstruction: null,
            designLanguage: { score: 2, rationale: 'Below threshold' },
            briefMatch: { score: 3, rationale: 'Marginal' },
          }
        : judgeByIndex.has(index) === false
          ? null
          : {
              passed: true,
              minScore: judgeByIndex.get(index)!,
              designLanguage: { score: 4, rationale: 'Crawler-specific' },
              briefMatch: { score: 5, rationale: 'Matches the brief' },
            },
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
        anchors: {
          hold:
            options.chosenAnchor === undefined
              ? { x: 8, y: 13, source: 'brief' }
              : options.chosenAnchor,
          centerOfGravity:
            options.chosenCenterOfGravityAnchor === undefined
              ? { x: 8, y: 13, source: 'brief' }
              : options.chosenCenterOfGravityAnchor,
        },
        judgeScorecard: null,
      },
      ...(options.facingOverride === undefined
        ? {}
        : {
            postprocessOverrides: {
              facing: options.facingOverride,
            },
          }),
    }),
  );

  return { runDir, briefId };
}

/**
 * Compose the aggregate manifest view from the on-disk per-asset shards. The
 * aggregate `manifest.json` is no longer written by approve/unapprove — the
 * shards under `entries/` are the source of truth — so tests read it back
 * through the same composer the build + engine use.
 */
function readManifest(manifestPath: string): Manifest {
  return composeManifestFromShards(path.dirname(manifestPath)) as Manifest;
}

/** Absolute generated dir (holding `entries/`) for a given aggregate path. */
function generatedDirOf(manifestPath: string): string {
  return path.dirname(manifestPath);
}

/**
 * Derive the composed `generated:` catalog row for a variant directly from its
 * shard — the catalog is no longer written by approve, it is composed at
 * read-time from the manifest, so tests assert the derivation.
 */
function deriveCatalogRow(manifestPath: string, variantId: string) {
  const manifest = readManifest(manifestPath);
  const entry = manifest.entries[variantId];
  if (!entry) return undefined;
  return deriveGeneratedCatalogRow(variantId, entry as unknown as GeneratedManifestEntry);
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
    catalogPath = path.join(repoRoot, 'src', 'shared', 'data', 'sprite-catalog.json');
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
    expect(entry.spriteName).toBe(`${briefId}-var-1`);
    expect(entry.assetPath).toBe(`generated/${briefId}-var-1.png`);
    expect(entry.variantIndex).toBe(1);
    expect(entry.anchor).toEqual({ x: 5, y: 12, source: 'derived' });
    expect(entry.sensorScore).toBe('7/7');
    expect(entry.judgeScore).toBe('4');
    expect(entry.sensorBreakdown).toEqual([
      { sensor: 'palette', ok: true },
      { sensor: 'silhouette', ok: false, reason: 'too-small' },
    ]);
    expect(entry.judgeScorecard).toMatchObject({
      minScore: 4,
      designLanguage: { score: 4, rationale: 'Crawler-specific' },
      briefMatch: { score: 5, rationale: 'Matches the brief' },
    });
    expect(entry.approvedAt).toBe('2026-06-08T15:30:00.000Z');
    // sourceRun is repo-relative with forward slashes regardless of host OS.
    expect(entry.sourceRun).toBe(`generated/runs/${briefId}/2026-06-08T12-00-00-deadbeef`);
    expect(entry.sourceRun.includes('\\')).toBe(false);

    // The asset PNG was copied with the variant's bytes.
    const assetAbs = path.join(publicAssetsDir, 'generated', `${briefId}-var-1.png`);
    expect(readFileSync(assetAbs).toString()).toBe('PNG-1');

    // Manifest entry is stamped with the SHA-256 of the approved PNG bytes.
    expect(entry.contentHash).toBe(
      createHash('sha256').update(readFileSync(assetAbs)).digest('hex'),
    );

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
          anchors: { hold: null, centerOfGravity: null },
          sensorScore: '7/7',
          judgeScore: null,
          type: 'enemy',
        },
        'cloth-shirt': {
          briefId: 'cloth-shirt',
          spriteName: 'cloth-shirt',
          assetPath: 'generated/cloth-shirt.png',
          approvedAt: '2026-06-01T00:00:00.000Z',
          sourceRun: 'generated/runs/cloth-shirt/old',
          variantIndex: 0,
          anchor: null,
          anchors: { hold: null, centerOfGravity: null },
          sensorScore: '7/7',
          judgeScore: null,
          type: 'item',
        },
      },
    };
    // Seed two unrelated entries as shards (the source of truth).
    for (const [key, entry] of Object.entries(seeded.entries)) {
      writeShard(generatedDirOf(manifestPath), key, entry as unknown as GeneratedManifestEntry);
    }

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

  it('writes facingDirection from postprocess facing override and defaults to right otherwise', () => {
    const targeted = writeFakeRun(repoRoot, {
      runId: '2026-06-08T16-00-00-faceleft',
      variantIndices: [0, 1],
      facingOverride: { variantIndex: 1, direction: 'left' },
    });
    const targetedVariant = approveVariant({
      runDir: targeted.runDir,
      variantIndex: 1,
      manifestPath,
      catalogPath,
      publicAssetsDir,
      repoRoot,
      now: fixedNow,
    });
    const untargetedVariant = approveVariant({
      runDir: targeted.runDir,
      variantIndex: 0,
      manifestPath,
      catalogPath,
      publicAssetsDir,
      repoRoot,
      now: fixedNow,
    });
    expect(targetedVariant.facingDirection).toBe('left');
    expect(untargetedVariant.facingDirection).toBe('right');

    const allVariants = writeFakeRun(repoRoot, {
      runId: '2026-06-08T17-00-00-faceall',
      variantIndices: [2],
      facingOverride: { variantIndex: 0, direction: 'left', applyToAllVariants: true },
    });
    const allVariantsEntry = approveVariant({
      runDir: allVariants.runDir,
      variantIndex: 2,
      manifestPath,
      catalogPath,
      publicAssetsDir,
      repoRoot,
      now: fixedNow,
    });
    expect(allVariantsEntry.facingDirection).toBe('left');
  });

  it('throws already-approved when the exact same variant (identical content) is approved twice', () => {
    const { runDir } = writeFakeRun(repoRoot, { variantIndices: [0, 1] });
    const opts = {
      runDir,
      variantIndex: 1,
      manifestPath,
      catalogPath,
      publicAssetsDir,
      repoRoot,
      now: fixedNow,
    };
    const first = approveVariant(opts);
    expect(first.spriteName).toBe('iron-sword-var-1');

    // Re-approving the EXACT same brief + variant index with identical bytes is refused.
    expect(() => approveVariant(opts)).toThrowError(ApproveError);
    try {
      approveVariant(opts);
    } catch (err) {
      expect((err as ApproveError).kind).toBe('already-approved');
    }

    // The refused approval must not have mutated the manifest: still one entry.
    const manifest = readManifest(manifestPath);
    expect(Object.keys(manifest.entries)).toEqual(['iron-sword-var-1']);
  });

  it('allows re-approval when the variant content changed (e.g. after re-post-processing)', () => {
    const { runDir } = writeFakeRun(repoRoot, { variantIndices: [0, 1] });
    const opts = {
      runDir,
      variantIndex: 1,
      manifestPath,
      catalogPath,
      publicAssetsDir,
      repoRoot,
      now: fixedNow,
    };
    const first = approveVariant(opts);
    const assetAbs = path.join(publicAssetsDir, 'generated', 'iron-sword-var-1.png');
    expect(readFileSync(assetAbs).toString()).toBe('PNG-1');

    // Simulate re-post-processing: the processed PNG now has different bytes.
    writeFileSync(path.join(runDir, 'processed', '01.png'), Buffer.from('PNG-1-REPROCESSED'));

    // Re-approval WITHOUT allowReapprove is permitted because the content differs.
    const second = approveVariant(opts);

    // Single entry, overwritten in place with the new bytes + a new content hash.
    const manifest = readManifest(manifestPath);
    expect(Object.keys(manifest.entries)).toEqual(['iron-sword-var-1']);
    expect(readFileSync(assetAbs).toString()).toBe('PNG-1-REPROCESSED');
    expect(second.contentHash).not.toBe(first.contentHash);
    expect(manifest.entries['iron-sword-var-1']!.contentHash).toBe(second.contentHash);
  });

  it('blocks identical re-approval for a legacy entry lacking contentHash (on-disk asset fallback)', () => {
    const { runDir } = writeFakeRun(repoRoot, { variantIndices: [0, 1] });
    const opts = {
      runDir,
      variantIndex: 1,
      manifestPath,
      catalogPath,
      publicAssetsDir,
      repoRoot,
      now: fixedNow,
    };
    approveVariant(opts);

    // Simulate a pre-existing entry approved before contentHash existed.
    const manifest = readManifest(manifestPath);
    const legacy: Record<string, unknown> = { ...manifest.entries['iron-sword-var-1']! };
    delete legacy.contentHash;
    writeShard(
      generatedDirOf(manifestPath),
      'iron-sword-var-1',
      legacy as unknown as GeneratedManifestEntry,
    );

    // Same bytes still on disk → fallback hash of the asset matches → refused.
    expect(() => approveVariant(opts)).toThrowError(ApproveError);
    try {
      approveVariant(opts);
    } catch (err) {
      expect((err as ApproveError).kind).toBe('already-approved');
    }
  });

  it('allows re-approving the same variant when allowReapprove is set', () => {
    const { runDir } = writeFakeRun(repoRoot, { variantIndices: [0, 1] });
    const base = {
      runDir,
      variantIndex: 1,
      manifestPath,
      catalogPath,
      publicAssetsDir,
      repoRoot,
    };
    approveVariant({ ...base, now: () => new Date('2026-06-08T10:00:00.000Z') });
    const second = approveVariant({
      ...base,
      allowReapprove: true,
      now: () => new Date('2026-06-08T14:00:00.000Z'),
    });

    // Overwrites in place: still a single entry, with the latest timestamp.
    const manifest = readManifest(manifestPath);
    expect(Object.keys(manifest.entries)).toEqual(['iron-sword-var-1']);
    expect(second.approvedAt).toBe('2026-06-08T14:00:00.000Z');
    expect(manifest.entries['iron-sword-var-1']).toEqual(second);
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
    // Shard must NOT have been created when validation failed.
    expect(existsSync(shardPathForKey(generatedDirOf(manifestPath), 'iron-sword-var-9'))).toBe(
      false,
    );
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

  it('ingest weapon anchor sidecar into anchors.weapon when NN.anchor.weapon.json is present', () => {
    const { runDir } = writeFakeRun(repoRoot, { variantIndices: [0] });
    // Write weapon anchor sidecar for variant 0.
    const processedDir = path.join(runDir, 'processed');
    writeFileSync(
      path.join(processedDir, '00.anchor.weapon.json'),
      JSON.stringify({ x: 42, y: 18, source: 'manual', updatedAt: '2026-01-01T00:00:00.000Z' }),
    );
    const entry = approveVariant({
      runDir,
      variantIndex: 0,
      manifestPath,
      catalogPath,
      publicAssetsDir,
      repoRoot,
      now: fixedNow,
    });
    expect(entry.anchors.weapon).toEqual({ x: 42, y: 18, source: 'manual' });
  });

  it('records anchors.weapon as null when weapon sidecar contains { cleared: true }', () => {
    const { runDir } = writeFakeRun(repoRoot, { variantIndices: [0] });
    const processedDir = path.join(runDir, 'processed');
    writeFileSync(
      path.join(processedDir, '00.anchor.weapon.json'),
      JSON.stringify({ cleared: true }),
    );
    const entry = approveVariant({
      runDir,
      variantIndex: 0,
      manifestPath,
      catalogPath,
      publicAssetsDir,
      repoRoot,
      now: fixedNow,
    });
    expect(entry.anchors.weapon).toBeNull();
  });

  it('omits anchors.weapon entirely when no weapon sidecar is present', () => {
    const { runDir } = writeFakeRun(repoRoot, { variantIndices: [0] });
    const entry = approveVariant({
      runDir,
      variantIndex: 0,
      manifestPath,
      catalogPath,
      publicAssetsDir,
      repoRoot,
      now: fixedNow,
    });
    expect('weapon' in entry.anchors).toBe(false);
  });

  it('persists approved sprite to manifest and derives its catalog row', () => {
    const { runDir, briefId } = writeFakeRun(repoRoot, {
      variantIndices: [0, 1],
      chosenIndex: 1,
    });
    approveVariant({
      runDir,
      variantIndex: 1,
      manifestPath,
      catalogPath,
      publicAssetsDir,
      repoRoot,
      now: fixedNow,
    });

    // Verify manifest (composed from shards) has the entry
    const manifest = readManifest(manifestPath);
    const variantId = `${briefId}-var-1`;
    expect(manifest.entries).toHaveProperty(variantId);

    // Verify the catalog row derived from the shard has the correct structure.
    const catalogEntry = deriveCatalogRow(manifestPath, variantId);
    expect(catalogEntry).toBeDefined();
    expect(catalogEntry).toMatchObject({
      kind: 'sprite',
      label: variantId,
      spriteId: variantId,
      sheetKey: 'generated-manifest',
      tags: expect.arrayContaining(['generated', 'pipeline-approved']),
    });
  });

  it('tags the derived catalog row with the brief sprite type when the brief YAML is present', () => {
    const { runDir, briefId } = writeFakeRun(repoRoot, {
      variantIndices: [0, 1],
      chosenIndex: 1,
    });
    // The summary writes briefPath = briefs/weapons/<briefId>.yaml; create it
    // with a declared type so approveVariant can resolve and tag it.
    const briefAbsPath = path.join(repoRoot, 'briefs', 'weapons', `${briefId}.yaml`);
    mkdirSync(path.dirname(briefAbsPath), { recursive: true });
    writeFileSync(briefAbsPath, `type: item\nname: ${briefId}\ndescription: A test sprite.\n`);

    const entry = approveVariant({
      runDir,
      variantIndex: 1,
      manifestPath,
      catalogPath,
      publicAssetsDir,
      repoRoot,
      now: fixedNow,
    });

    const catalogEntry = deriveCatalogRow(manifestPath, `${briefId}-var-1`);
    expect(catalogEntry).toBeDefined();
    expect(catalogEntry!.tags).toEqual(['item', 'generated', 'pipeline-approved']);
    // The resolved type is also stamped on the manifest entry itself.
    expect(entry.type).toBe('item');
  });

  it('falls back to default tags when the brief YAML is missing', () => {
    const { runDir, briefId } = writeFakeRun(repoRoot, {
      variantIndices: [0, 1],
      chosenIndex: 1,
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

    const catalogEntry = deriveCatalogRow(manifestPath, `${briefId}-var-1`);
    expect(catalogEntry!.tags).toEqual(['generated', 'pipeline-approved']);
    // No resolvable brief ⇒ the manifest entry's type is null.
    expect(entry.type).toBeNull();
  });

  describe('item art recurrence guard (ADR 0051)', () => {
    it('ships a versioned weapon-typed item brief BARE (flame-dagger-v2 → flame-dagger)', () => {
      const { runDir } = writeFakeRun(repoRoot, {
        briefId: 'flame-dagger-v2',
        variantIndices: [0, 1],
        chosenIndex: 1,
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

      // The -v2 lineage tag is stripped: the manifest key, briefId, spriteName,
      // and assetPath are all the bare item id so the icon resolves by item id.
      expect(entry.briefId).toBe('flame-dagger');
      expect(entry.spriteName).toBe('flame-dagger-var-1');
      expect(entry.assetPath).toBe('generated/flame-dagger-var-1.png');

      const manifest = readManifest(manifestPath);
      expect(manifest.entries).toHaveProperty('flame-dagger-var-1');
      expect(manifest.entries).not.toHaveProperty('flame-dagger-v2-var-1');

      // The derived catalog id is keyed by the bare manifest key.
      expect(deriveCatalogRow(manifestPath, 'flame-dagger-var-1')).toBeDefined();
      expect(deriveCatalogRow(manifestPath, 'flame-dagger-v2-var-1')).toBeUndefined();
    });

    it('ships character-typed item art BARE (classified-dossier-v1 → classified-dossier)', () => {
      const { runDir } = writeFakeRun(repoRoot, {
        briefId: 'classified-dossier-v1',
        variantIndices: [0],
        chosenIndex: 0,
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

      expect(entry.briefId).toBe('classified-dossier');
      expect(entry.spriteName).toBe('classified-dossier-var-0');
      expect(entry.assetPath).toBe('generated/classified-dossier-var-0.png');
    });

    it('ships a weaponId-alias brief BARE (baseball-bat-v3 → baseball-bat)', () => {
      const { runDir } = writeFakeRun(repoRoot, {
        briefId: 'baseball-bat-v3',
        variantIndices: [0],
        chosenIndex: 0,
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

      expect(entry.briefId).toBe('baseball-bat');
      expect(entry.spriteName).toBe('baseball-bat-var-0');
    });

    it('leaves a genuine non-item versioned brief VERSIONED (angry-roomba-v2)', () => {
      const { runDir } = writeFakeRun(repoRoot, {
        briefId: 'angry-roomba-v2',
        variantIndices: [0],
        chosenIndex: 0,
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

      // Enemy art is not an item identity → the -v2 lineage is preserved.
      expect(entry.briefId).toBe('angry-roomba-v2');
      expect(entry.spriteName).toBe('angry-roomba-v2-var-0');
      expect(entry.assetPath).toBe('generated/angry-roomba-v2-var-0.png');
    });
  });

  describe('hard-block gate', () => {
    it('throws hard-blocked when judgeScorecard.hardBlocked is true', () => {
      const { runDir } = writeFakeRun(repoRoot, {
        variantIndices: [0, 1],
        hardBlockedFor: [1],
      });
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
      ).toThrowError(ApproveError);
      try {
        approveVariant({
          runDir,
          variantIndex: 1,
          manifestPath,
          catalogPath,
          publicAssetsDir,
          repoRoot,
          now: fixedNow,
        });
      } catch (err) {
        expect((err as ApproveError).kind).toBe('hard-blocked');
        expect((err as ApproveError).message).toContain('hard-blocked by the judge');
        expect((err as ApproveError).message).toContain(
          'I HATE THIS SO MUCH YOU MAY NOT USE THIS IN GAME',
        );
      }
      // Shard must NOT have been created — the veto must mutate nothing.
      expect(existsSync(shardPathForKey(generatedDirOf(manifestPath), 'iron-sword-var-1'))).toBe(
        false,
      );
    });

    it('hard-blocked variant can be approved when allowHardBlocked is set', () => {
      const { runDir } = writeFakeRun(repoRoot, {
        variantIndices: [0, 1],
        hardBlockedFor: [1],
      });
      const entry = approveVariant({
        runDir,
        variantIndex: 1,
        manifestPath,
        catalogPath,
        publicAssetsDir,
        repoRoot,
        now: fixedNow,
        allowHardBlocked: true,
      });
      // The entry is written — operator consciously overruled the veto.
      expect(entry.spriteName).toBe('iron-sword-var-1');
      expect(existsSync(shardPathForKey(generatedDirOf(manifestPath), 'iron-sword-var-1'))).toBe(
        true,
      );
      // hardBlocked must be cleared (false) so the CI invariant doesn't reject
      // the manifest, and humanHardBlockOverride must be set as durable evidence.
      expect(entry.judgeScorecard?.hardBlocked).toBe(false);
      expect(entry.judgeScorecard?.humanHardBlockOverride).toBe(true);
    });

    it('non-hard-blocked variant is not affected by the hard-block gate', () => {
      const { runDir } = writeFakeRun(repoRoot, {
        variantIndices: [0, 1],
        hardBlockedFor: [1],
      });
      // Variant 0 is fine and must approve normally.
      const entry = approveVariant({
        runDir,
        variantIndex: 0,
        manifestPath,
        catalogPath,
        publicAssetsDir,
        repoRoot,
        now: fixedNow,
      });
      expect(entry.spriteName).toBe('iron-sword-var-0');
    });
  });
});

describe('unapproveVariant', () => {
  let repoRoot: string;
  let publicAssetsDir: string;
  let manifestPath: string;
  let catalogPath: string;
  const fixedNow = () => new Date('2026-06-08T15:30:00.000Z');

  beforeEach(() => {
    repoRoot = mkdtempSync(path.join(tmpdir(), 'crawler-unapprove-'));
    publicAssetsDir = path.join(repoRoot, 'public', 'assets');
    manifestPath = path.join(publicAssetsDir, 'generated', 'manifest.json');
    catalogPath = path.join(repoRoot, 'src', 'shared', 'data', 'sprite-catalog.json');
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function approveOne(briefId: string = 'iron-sword', variantIndex: number = 1): void {
    const { runDir } = writeFakeRun(repoRoot, {
      briefId,
      variantIndices: [0, 1, 2],
      chosenIndex: variantIndex,
    });
    approveVariant({
      runDir,
      variantIndex,
      manifestPath,
      catalogPath,
      publicAssetsDir,
      repoRoot,
      now: fixedNow,
    });
  }

  it('removes the manifest entry, catalog entry, and PNG on successful unapprove', () => {
    approveOne();
    const variantId = 'iron-sword-var-1';
    const assetAbs = path.join(publicAssetsDir, 'generated', `${variantId}.png`);

    expect(existsSync(assetAbs)).toBe(true);
    const manifest = readManifest(manifestPath);
    expect(manifest.entries[variantId]).toBeDefined();

    const removed = unapproveVariant({
      variantId,
      manifestPath,
      catalogPath,
      publicAssetsDir,
    });

    // Returns the evicted entry.
    expect(removed.briefId).toBe('iron-sword');
    expect(removed.variantIndex).toBe(1);
    expect(removed.spriteName).toBe(variantId);

    // Manifest entry is gone.
    const updatedManifest = readManifest(manifestPath);
    expect(updatedManifest.entries[variantId]).toBeUndefined();
    expect(Object.keys(updatedManifest.entries)).toHaveLength(0);

    // PNG is deleted.
    expect(existsSync(assetAbs)).toBe(false);

    // The shard is gone, so the derived catalog row disappears too.
    expect(deriveCatalogRow(manifestPath, variantId)).toBeUndefined();
  });

  it('preserves other manifest entries when one variant is unapproved', () => {
    approveOne('iron-sword', 0);
    approveOne('iron-sword', 2);
    const manifest0 = readManifest(manifestPath);
    expect(Object.keys(manifest0.entries).sort()).toEqual(['iron-sword-var-0', 'iron-sword-var-2']);

    unapproveVariant({
      variantId: 'iron-sword-var-0',
      manifestPath,
      catalogPath,
      publicAssetsDir,
    });

    const manifest1 = readManifest(manifestPath);
    expect(Object.keys(manifest1.entries)).toEqual(['iron-sword-var-2']);
  });

  it('keeps PNG on disk when deleteAsset is false', () => {
    approveOne();
    const variantId = 'iron-sword-var-1';
    const assetAbs = path.join(publicAssetsDir, 'generated', `${variantId}.png`);

    unapproveVariant({
      variantId,
      manifestPath,
      catalogPath,
      publicAssetsDir,
      deleteAsset: false,
    });

    // Manifest entry gone, but PNG remains.
    const updatedManifest = readManifest(manifestPath);
    expect(updatedManifest.entries[variantId]).toBeUndefined();
    expect(existsSync(assetAbs)).toBe(true);
  });

  it('throws not-found when manifest does not exist', () => {
    expect(() =>
      unapproveVariant({
        variantId: 'iron-sword-var-1',
        manifestPath,
        catalogPath,
        publicAssetsDir,
      }),
    ).toThrowError(UnapproveError);
    try {
      unapproveVariant({
        variantId: 'iron-sword-var-1',
        manifestPath,
        catalogPath,
        publicAssetsDir,
      });
    } catch (err) {
      expect((err as UnapproveError).kind).toBe('not-found');
    }
  });

  it('throws not-found when the variantId is absent from the manifest', () => {
    approveOne();
    expect(() =>
      unapproveVariant({
        variantId: 'nonexistent-var-99',
        manifestPath,
        catalogPath,
        publicAssetsDir,
      }),
    ).toThrowError(UnapproveError);
    try {
      unapproveVariant({
        variantId: 'nonexistent-var-99',
        manifestPath,
        catalogPath,
        publicAssetsDir,
      });
    } catch (err) {
      expect((err as UnapproveError).kind).toBe('not-found');
    }
  });

  it('throws manifest-invalid for a corrupt shard file', () => {
    const shardPath = shardPathForKey(generatedDirOf(manifestPath), 'iron-sword-var-1');
    mkdirSync(path.dirname(shardPath), { recursive: true });
    writeFileSync(shardPath, 'not json {{{{');
    expect(() =>
      unapproveVariant({
        variantId: 'iron-sword-var-1',
        manifestPath,
        catalogPath,
        publicAssetsDir,
      }),
    ).toThrowError(UnapproveError);
    try {
      unapproveVariant({
        variantId: 'iron-sword-var-1',
        manifestPath,
        catalogPath,
        publicAssetsDir,
      });
    } catch (err) {
      expect((err as UnapproveError).kind).toBe('manifest-invalid');
    }
  });

  it('manifest entry is removed even when PNG is already absent', () => {
    approveOne();
    const variantId = 'iron-sword-var-1';
    const assetAbs = path.join(publicAssetsDir, 'generated', `${variantId}.png`);
    // Pre-delete the PNG to simulate a missing-but-approved scenario.
    rmSync(assetAbs);

    // Should not throw.
    const removed = unapproveVariant({
      variantId,
      manifestPath,
      catalogPath,
      publicAssetsDir,
    });
    expect(removed.variantIndex).toBe(1);
    const updatedManifest = readManifest(manifestPath);
    expect(updatedManifest.entries[variantId]).toBeUndefined();
  });

  it('succeeds even when catalog does not exist', () => {
    approveOne();
    // Remove the catalog so unapprove must handle its absence gracefully.
    rmSync(catalogPath, { force: true });

    const removed = unapproveVariant({
      variantId: 'iron-sword-var-1',
      manifestPath,
      catalogPath,
      publicAssetsDir,
    });
    expect(removed.variantIndex).toBe(1);
    // Manifest entry removed regardless.
    const updatedManifest = readManifest(manifestPath);
    expect(updatedManifest.entries['iron-sword-var-1']).toBeUndefined();
  });

  it('__proto__ as variantId throws not-found (no prototype traversal)', () => {
    try {
      unapproveVariant({
        variantId: '__proto__',
        manifestPath,
        catalogPath,
        publicAssetsDir,
      });
      throw new Error('expected to throw');
    } catch (err) {
      expect((err as UnapproveError).kind).toBe('not-found');
    }
  });

  it('does not read or delete files outside entries/ when variantId contains path traversal', () => {
    // A traversal-style variantId must be rejected before any fs read/unlink so
    // it can never escape the entries/ tree. From <generatedDir>/entries,
    // `../../../outside` would resolve to <repoRoot>/outside.json.
    const traversalKey = '../../../outside';
    const outsideShard = path.join(repoRoot, 'outside.json');
    writeFileSync(outsideShard, JSON.stringify({ briefId: 'x' }));

    try {
      unapproveVariant({
        variantId: traversalKey,
        manifestPath,
        catalogPath,
        publicAssetsDir,
      });
      throw new Error('expected to throw');
    } catch (err) {
      expect((err as UnapproveError).kind).toBe('not-found');
    }

    // The outside file is untouched.
    expect(existsSync(outsideShard)).toBe(true);
  });
});

/**
 * The whole point of sharding the manifest: an `approve` of a new asset must
 * produce a git diff of EXACTLY its own PNG + its own `entries/<key>.json`
 * shard, touching no file shared with any other asset. That disjointness is
 * what lets two parallel art PRs never conflict by construction — the measured
 * success gate for this work. This runs a real `git` repo end-to-end (approve
 * writer + `git add` over the real `ASSET_SURFACE_PATHS` the check-in stages)
 * and asserts the staged file set, plus proves the two former mega-files
 * (`src/shared/data/sprite-catalog.json`, the aggregate `manifest.json`) are
 * never touched.
 */
describe('approve → check-in diff shape (success gate)', () => {
  let gitRepo: string;
  let publicAssetsDir: string;
  let generatedDir: string;
  let manifestPath: string;
  let catalogPath: string;
  let catalogBaselineBytes: string;

  const git = (args: ReadonlyArray<string>): string =>
    execFileSync('git', [...args], { cwd: gitRepo, encoding: 'utf8' });

  beforeEach(() => {
    gitRepo = mkdtempSync(path.join(tmpdir(), 'crawler-approve-git-'));
    publicAssetsDir = path.join(gitRepo, 'public', 'assets');
    generatedDir = path.join(publicAssetsDir, 'generated');
    manifestPath = path.join(generatedDir, 'manifest.json');
    catalogPath = path.join(gitRepo, 'src', 'shared', 'data', 'sprite-catalog.json');

    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'commit.gpgsign', 'false']);

    // The aggregate manifest.json is a gitignored build artifact, never committed.
    writeFileSync(path.join(gitRepo, '.gitignore'), 'public/assets/generated/manifest.json\n');

    // Baseline: one pre-existing generated asset (PNG + shard) and a committed
    // sprite-catalog.json that carries NO generated rows (they are derived now).
    mkdirSync(path.join(generatedDir, 'entries'), { recursive: true });
    writeFileSync(path.join(generatedDir, 'old-blade-var-0.png'), 'OLD-PNG');
    writeShard(generatedDir, 'old-blade-var-0', {
      briefId: 'old-blade',
      spriteName: 'old-blade-var-0',
      assetPath: 'generated/old-blade-var-0.png',
      variantIndex: 0,
      approvedAt: '2026-01-01T00:00:00.000Z',
      sourceRun: 'generated/runs/old-blade/x',
      contentHash: 'deadbeef',
    } as unknown as GeneratedManifestEntry);
    mkdirSync(path.dirname(catalogPath), { recursive: true });
    catalogBaselineBytes = `${JSON.stringify({ version: 1, records: [] }, null, 2)}\n`;
    writeFileSync(catalogPath, catalogBaselineBytes);
    // Place a (gitignored) aggregate on disk to prove it stays unstaged even
    // when physically present — exactly the dev/build situation.
    writeFileSync(manifestPath, `${JSON.stringify({ version: 1, entries: {} }, null, 2)}\n`);

    git(['add', '-A']);
    git(['commit', '-qm', 'baseline']);
  });

  afterEach(() => {
    rmSync(gitRepo, { recursive: true, force: true });
  });

  it('approving a new variant stages ONLY its own PNG + shard, never a shared file', () => {
    const { runDir } = writeFakeRun(gitRepo, {
      briefId: 'iron-sword',
      derivedAnchorFor: [1],
      judgeFor: [{ index: 1, minScore: 4 }],
    });

    approveVariant({
      runDir,
      variantIndex: 1,
      manifestPath,
      catalogPath,
      publicAssetsDir,
      repoRoot: gitRepo,
      now: () => new Date('2026-06-08T15:30:00.000Z'),
    });

    // Stage exactly what the real check-in stages (the approved-art surface).
    for (const surface of ASSET_SURFACE_PATHS) {
      git(['add', '--', surface]);
    }

    const staged = git(['diff', '--cached', '--name-only'])
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .sort();

    // The entire diff is the new PNG + its own per-asset shard. Nothing else.
    expect(staged).toEqual(
      [
        'public/assets/generated/entries/iron-sword-var-1.json',
        'public/assets/generated/iron-sword-var-1.png',
      ].sort(),
    );

    // The two former mega-files are provably untouched by the approve:
    // sprite-catalog.json is byte-identical, and the aggregate manifest.json
    // stays unstaged (gitignored) despite existing on disk.
    expect(staged).not.toContain('src/shared/data/sprite-catalog.json');
    expect(staged).not.toContain('public/assets/generated/manifest.json');
    expect(readFileSync(catalogPath, 'utf8')).toBe(catalogBaselineBytes);

    // The pre-existing asset's shard was not rewritten — disjoint from the new one.
    expect(staged).not.toContain('public/assets/generated/entries/old-blade-var-0.json');
  });
});

// ─── approveIconBatch ─────────────────────────────────────────────────────────

import {
  approveIconBatch,
  type ApproveIconBatchOptions,
  type IconBatchEntry,
} from '../../../scripts/sprites/approve.js';

/**
 * Write a synthetic icon-batch run directory under `repoRoot`. Returns the
 * run directory and a minimal `iconBatch` array (one entry per cell).
 */
function writeIconBatchRun(
  repoRoot: string,
  opts: {
    readonly cellCount?: number;
    readonly briefId?: string;
    readonly runId?: string;
    /**
     * Number of candidates the model reports in summary.json (defaults to
     * cellCount). Use to simulate a short or over-run without changing iconBatch.
     */
    readonly candidateCount?: number;
    /** Indices whose processed PNG is present (defaults to all cellCount cells). */
    readonly presentCells?: ReadonlyArray<number>;
    /** Indices that have a hard-blocked judge scorecard. */
    readonly hardBlockedCells?: ReadonlyArray<number>;
  } = {},
): { runDir: string; iconBatch: IconBatchEntry[] } {
  const cellCount = opts.cellCount ?? 3;
  const candidateCount = opts.candidateCount ?? cellCount;
  const briefId = opts.briefId ?? 'achv-icons-batch-01';
  const runId = opts.runId ?? '2026-07-01T00-00-00-cafecafe';
  const presentCells = new Set(
    opts.presentCells ?? Array.from({ length: candidateCount }, (_, i) => i),
  );
  const hardBlockedCells = new Set(opts.hardBlockedCells ?? []);

  const runDir = path.join(repoRoot, 'generated', 'runs', briefId, runId);
  const processedDir = path.join(runDir, 'processed');
  mkdirSync(processedDir, { recursive: true });

  for (let i = 0; i < candidateCount; i++) {
    const padded = String(i).padStart(2, '0');
    if (presentCells.has(i)) {
      writeFileSync(path.join(processedDir, `${padded}.png`), Buffer.from(`ICON-PNG-${i}`));
    }
  }

  // candidateCount candidates are reported in the summary (model returns that many cells).
  // presentCells only controls which PNG files exist on disk.
  const candidates = Array.from({ length: candidateCount }, (_, index) => ({
    index,
    score: 6,
    outOf: 7,
    passed: true,
    combinedPassed: true,
    breakdown: [],
    derivedAnchor: null,
    derivedAnchors: { hold: null, centerOfGravity: null },
    judgeScorecard: hardBlockedCells.has(index)
      ? {
          passed: false,
          minScore: 1,
          hardBlockEvaluated: true,
          hardBlocked: true,
          hardBlockInstruction: 'This icon is unusable',
          hardBlockRationale: 'Terrible quality',
          designLanguage: { score: 1, rationale: 'rejected' },
          briefMatch: { score: 1, rationale: 'rejected' },
        }
      : null,
    judgeSkipReason: null,
  }));

  writeFileSync(
    path.join(runDir, 'summary.json'),
    JSON.stringify({
      brief: briefId,
      briefPath: `briefs/icons/achievements/${briefId}.yaml`,
      runId,
      promptHash: 'abc123',
      attempts: 1,
      variantCount: candidateCount,
      candidates,
      chosen: null,
      grid: { rows: 4, cols: 4, emptyCells: [] },
      createdAt: '2026-07-01T00:00:00.000Z',
    }),
  );

  const iconBatch: IconBatchEntry[] = Array.from({ length: cellCount }, (_, i) => ({
    id: `achv-test-icon-${i}`,
    concept: `Test concept ${i}`,
    description: `Description for icon ${i}`,
  }));

  return { runDir, iconBatch };
}

describe('approveIconBatch', () => {
  let repoRoot: string;
  let publicAssetsDir: string;
  let manifestPath: string;

  const fixedNow = () => new Date('2026-07-01T12:00:00.000Z');

  beforeEach(() => {
    repoRoot = mkdtempSync(path.join(tmpdir(), 'crawler-approve-icon-'));
    publicAssetsDir = path.join(repoRoot, 'public', 'assets');
    manifestPath = path.join(publicAssetsDir, 'generated', 'manifest.json');
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function makeOpts(
    runDir: string,
    iconBatch: IconBatchEntry[],
    extra: Partial<ApproveIconBatchOptions> = {},
  ): ApproveIconBatchOptions {
    return {
      runDir,
      iconBatch,
      manifestPath,
      publicAssetsDir,
      repoRoot,
      now: fixedNow,
      ...extra,
    };
  }

  it('approves all cells and writes a shard per icon', () => {
    const { runDir, iconBatch } = writeIconBatchRun(repoRoot, { cellCount: 3 });
    const entries = approveIconBatch(makeOpts(runDir, iconBatch));

    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      expect(entry.spriteName).toMatch(/^achv-test-icon-/);
      // PNG was copied to generated/<iconId>.png
      const pngPath = path.join(publicAssetsDir, 'generated', `${entry.spriteName}.png`);
      expect(existsSync(pngPath)).toBe(true);
    }
  });

  it('throws icon-batch-count-mismatch when processed count is GREATER than iconBatch length', () => {
    // 3 candidates in summary but only 2 iconBatch entries → too many candidates
    const { runDir } = writeIconBatchRun(repoRoot, { cellCount: 2, candidateCount: 3 });
    const shortBatch: IconBatchEntry[] = [
      { id: 'achv-test-icon-0', concept: 'concept 0' },
      { id: 'achv-test-icon-1', concept: 'concept 1' },
    ];
    let caught: unknown;
    try {
      approveIconBatch(makeOpts(runDir, shortBatch));
    } catch (err) {
      caught = err;
    }
    expect((caught as { kind: string }).kind).toBe('icon-batch-count-mismatch');
  });

  it('throws icon-batch-count-mismatch when processed count is FEWER than iconBatch length (exact match required)', () => {
    // Only 2 candidates in summary but 3 iconBatch entries → too few candidates
    const { runDir } = writeIconBatchRun(repoRoot, { cellCount: 3, candidateCount: 2 });
    const longerBatch: IconBatchEntry[] = [
      { id: 'achv-test-icon-0', concept: 'concept 0' },
      { id: 'achv-test-icon-1', concept: 'concept 1' },
      { id: 'achv-test-icon-2', concept: 'concept 2' },
    ];
    let caught: unknown;
    try {
      approveIconBatch(makeOpts(runDir, longerBatch));
    } catch (err) {
      caught = err;
    }
    expect((caught as { kind: string }).kind).toBe('icon-batch-count-mismatch');
  });

  it('skips a missing individual PNG (non-fatal) after the count guard passes', () => {
    // All 3 cells in candidates but cell 1 PNG is absent from disk
    const { runDir, iconBatch } = writeIconBatchRun(repoRoot, {
      cellCount: 3,
      presentCells: [0, 2], // cell 1 PNG deliberately absent
    });
    // candidates count = 3 (all reported), iconBatch.length = 3 → counts match
    // cell 1 PNG missing → skipped non-fatally
    const entries = approveIconBatch(makeOpts(runDir, iconBatch));
    expect(entries).toHaveLength(2);
    const ids = entries.map((e) => e.spriteName);
    expect(ids).toContain('achv-test-icon-0');
    expect(ids).toContain('achv-test-icon-2');
    expect(ids).not.toContain('achv-test-icon-1');
  });

  it('skips a cell that was already approved with identical content', () => {
    const { runDir, iconBatch } = writeIconBatchRun(repoRoot, { cellCount: 2 });
    // First approval
    approveIconBatch(makeOpts(runDir, iconBatch));
    // Second approval of identical content should be skipped (non-fatal)
    const second = approveIconBatch(makeOpts(runDir, iconBatch));
    // Still returns the existing entries (idempotent re-approval)
    expect(second).toHaveLength(2);
  });

  it('re-approves cells when allowReapprove is true', () => {
    const { runDir, iconBatch } = writeIconBatchRun(repoRoot, { cellCount: 2 });
    approveIconBatch(makeOpts(runDir, iconBatch));
    const second = approveIconBatch(makeOpts(runDir, iconBatch, { allowReapprove: true }));
    expect(second).toHaveLength(2);
  });

  it('throws hard-blocked when a cell has judgeScorecard.hardBlocked === true', () => {
    const { runDir, iconBatch } = writeIconBatchRun(repoRoot, {
      cellCount: 2,
      hardBlockedCells: [1],
    });
    let caught: unknown;
    try {
      approveIconBatch(makeOpts(runDir, iconBatch));
    } catch (err) {
      caught = err;
    }
    expect((caught as { kind: string }).kind).toBe('hard-blocked');
  });

  it('allows a hard-blocked cell when allowHardBlocked is true', () => {
    const { runDir, iconBatch } = writeIconBatchRun(repoRoot, {
      cellCount: 2,
      hardBlockedCells: [1],
    });
    const entries = approveIconBatch(makeOpts(runDir, iconBatch, { allowHardBlocked: true }));
    expect(entries).toHaveLength(2);
  });
});
