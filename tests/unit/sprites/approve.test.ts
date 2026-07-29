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
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  approveVariant,
  ApproveError,
  unapproveVariant,
  UnapproveError,
  MANIFEST_VERSION,
  type Manifest,
} from '../../../scripts/sprites/approve.js';

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
    judgeScorecard:
      hardBlockedSet.has(index)
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
    writeFileSync(
      manifestPath,
      JSON.stringify({ version: manifest.version, entries: { 'iron-sword-var-1': legacy } }),
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

  it('persists approved sprite to both manifest and catalog', () => {
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

    // Verify manifest has the entry
    const manifest: Manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const variantId = `${briefId}-var-1`;
    expect(manifest.entries).toHaveProperty(variantId);

    // Verify catalog has the entry with correct structure
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as Array<Record<string, unknown>>;
    const catalogEntry = catalog.find((e) => e.id === `generated:${variantId}`);
    expect(catalogEntry).toBeDefined();
    expect(catalogEntry).toMatchObject({
      kind: 'sprite',
      label: variantId,
      spriteId: variantId,
      sheetKey: 'generated-manifest',
      tags: expect.arrayContaining(['generated', 'pipeline-approved']),
    });
  });

  it('tags the catalog entry with the brief sprite type when the brief YAML is present', () => {
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

    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as Array<Record<string, unknown>>;
    const catalogEntry = catalog.find((e) => e.id === `generated:${briefId}-var-1`);
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

    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as Array<Record<string, unknown>>;
    const catalogEntry = catalog.find((e) => e.id === `generated:${briefId}-var-1`);
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

      const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as Array<
        Record<string, unknown>
      >;
      expect(catalog.find((e) => e.id === 'generated:flame-dagger-var-1')).toBeDefined();
      expect(catalog.find((e) => e.id === 'generated:flame-dagger-v2-var-1')).toBeUndefined();
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
        expect((err as ApproveError).message).toContain('I HATE THIS SO MUCH YOU MAY NOT USE THIS IN GAME');
      }
      // Manifest must NOT have been created — the veto must mutate nothing.
      expect(existsSync(manifestPath)).toBe(false);
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
      expect(existsSync(manifestPath)).toBe(true);
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

    // Catalog entry is gone.
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as ReadonlyArray<{
      id: string;
    }>;
    expect(catalog.find((e) => e.id === `generated:${variantId}`)).toBeUndefined();
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

  it('throws manifest-invalid for a corrupt manifest file', () => {
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, 'not json {{{{');
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

  it('manifest version mismatch throws manifest-invalid', () => {
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(
      manifestPath,
      JSON.stringify({ version: 99, entries: { 'iron-sword-var-1': {} } }),
    );
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

  it('entries: [] (array) throws manifest-invalid, not not-found', () => {
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify({ version: 1, entries: [] }));
    try {
      unapproveVariant({
        variantId: 'iron-sword-var-1',
        manifestPath,
        catalogPath,
        publicAssetsDir,
      });
      throw new Error('expected to throw');
    } catch (err) {
      expect((err as UnapproveError).kind).toBe('manifest-invalid');
    }
  });

  it('entries: null throws manifest-invalid', () => {
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify({ version: 1, entries: null }));
    try {
      unapproveVariant({
        variantId: 'iron-sword-var-1',
        manifestPath,
        catalogPath,
        publicAssetsDir,
      });
      throw new Error('expected to throw');
    } catch (err) {
      expect((err as UnapproveError).kind).toBe('manifest-invalid');
    }
  });

  it('__proto__ as variantId throws not-found (no prototype traversal)', () => {
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify({ version: 1, entries: {} }));
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

  it('does not delete files outside generated/ when variantId contains path traversal', () => {
    // Seed a manifest entry with a traversal-style key to simulate a malformed
    // manifest. unapproveVariant must remove the manifest entry but NOT delete
    // anything outside public/assets/generated/.
    //
    // From publicAssetsDir/generated, `../../../outside` resolves to
    // <repoRoot>/outside.png (3 levels: generated → assets → public → repoRoot).
    // Using only `../../outside` would target <repoRoot>/public/outside.png, which
    // is a different path than where we place the sentinel — the guard would pass
    // the test vacuously even if it were removed.
    const traversalKey = '../../../outside';
    const outsideFile = path.join(repoRoot, 'outside.png');
    writeFileSync(outsideFile, Buffer.from('OUTSIDE'));
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        entries: {
          [traversalKey]: {
            briefId: 'iron-sword',
            spriteName: traversalKey,
            assetPath: `generated/${traversalKey}.png`,
            approvedAt: '2026-01-01T00:00:00.000Z',
            sourceRun: 'generated/runs/iron-sword/run-01',
            variantIndex: 0,
            anchor: null,
            anchors: { hold: null, centerOfGravity: null },
            sensorScore: '7/7',
            judgeScore: null,
            type: null,
          },
        },
      }),
    );

    // Should not throw but must NOT delete the outside file.
    unapproveVariant({
      variantId: traversalKey,
      manifestPath,
      catalogPath,
      publicAssetsDir,
    });

    // The outside file is untouched.
    expect(existsSync(outsideFile)).toBe(true);
    // The manifest entry was removed.
    const updatedManifest = readManifest(manifestPath);
    expect(updatedManifest.entries[traversalKey]).toBeUndefined();
  });
});
