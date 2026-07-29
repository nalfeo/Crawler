/**
 * Unit tests for `checkin-runtime.ts`'s production `copyArtSurface` — the
 * selective worktree projection concern #2 (ADR 0066) fixes. Exercises real
 * fs IO against tmp directories (no mocked fs) so the PNG-copy and
 * manifest/catalog-merge behavior is proven end-to-end, not just wired.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createDefaultCheckinDeps,
  buildQueuedAssetMap,
} from '../../../scripts/sprites/checkin-runtime.js';
import { ASSET_CHECKIN_MARKER, type CheckinAsset } from '../../../scripts/sprites/checkin.js';

function writeJson(filePath: string, data: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function asset(overrides: Partial<CheckinAsset> = {}): CheckinAsset {
  return {
    assetPath: 'generated/unqueued-var-2.png',
    manifestKey: 'unqueued-var-2',
    briefId: 'unqueued',
    variantIndex: 2,
    ...overrides,
  };
}

describe('checkin-runtime copyArtSurface (selective projection)', () => {
  let srcRepoRoot: string;
  let destRepoRoot: string;

  beforeEach(() => {
    srcRepoRoot = mkdtempSync(path.join(tmpdir(), 'checkin-runtime-src-'));
    destRepoRoot = mkdtempSync(path.join(tmpdir(), 'checkin-runtime-dest-'));
  });

  afterEach(() => {
    rmSync(srcRepoRoot, { recursive: true, force: true });
    rmSync(destRepoRoot, { recursive: true, force: true });
  });

  function seedSrc(): void {
    const generatedDir = path.join(srcRepoRoot, 'public', 'assets', 'generated');
    mkdirSync(generatedDir, { recursive: true });
    writeFileSync(path.join(generatedDir, 'queued-var-1.png'), 'QUEUED-PNG');
    writeFileSync(path.join(generatedDir, 'unqueued-var-2.png'), 'UNQUEUED-PNG');

    writeJson(path.join(srcRepoRoot, 'public', 'assets', 'generated', 'manifest.json'), {
      version: 1,
      entries: {
        'queued-var-1': {
          briefId: 'queued',
          spriteName: 'queued-var-1',
          assetPath: 'generated/queued-var-1.png',
          variantIndex: 1,
          contentHash: 'queued-hash',
        },
        'unqueued-var-2': {
          briefId: 'unqueued',
          spriteName: 'unqueued-var-2',
          assetPath: 'generated/unqueued-var-2.png',
          variantIndex: 2,
          contentHash: 'unqueued-hash',
        },
      },
    });

    writeJson(path.join(srcRepoRoot, 'src', 'shared', 'data', 'sprite-catalog.json'), [
      { id: 'generated:queued-var-1', kind: 'sprite', label: 'queued-var-1' },
      { id: 'generated:unqueued-var-2', kind: 'sprite', label: 'unqueued-var-2' },
    ]);
  }

  function seedDestBase(): void {
    // The worktree, freshly checked out from the remote base branch, already
    // has ITS OWN (unrelated, previously-merged) manifest/catalog content.
    writeJson(path.join(destRepoRoot, 'public', 'assets', 'generated', 'manifest.json'), {
      version: 1,
      entries: {
        'preexisting-var-0': {
          briefId: 'preexisting',
          spriteName: 'preexisting-var-0',
          assetPath: 'generated/preexisting-var-0.png',
          variantIndex: 0,
        },
      },
    });
    writeJson(path.join(destRepoRoot, 'src', 'shared', 'data', 'sprite-catalog.json'), [
      { id: 'generated:preexisting-var-0', kind: 'sprite', label: 'preexisting-var-0' },
    ]);
  }

  it('copies ONLY the unqueued PNG, never the queued one', async () => {
    seedSrc();
    seedDestBase();
    const deps = createDefaultCheckinDeps(srcRepoRoot);

    await deps.copyArtSurface(srcRepoRoot, destRepoRoot, [asset()]);

    const destGenerated = path.join(destRepoRoot, 'public', 'assets', 'generated');
    expect(existsSync(path.join(destGenerated, 'unqueued-var-2.png'))).toBe(true);
    expect(readFileSync(path.join(destGenerated, 'unqueued-var-2.png'), 'utf8')).toBe(
      'UNQUEUED-PNG',
    );
    expect(existsSync(path.join(destGenerated, 'queued-var-1.png'))).toBe(false);
  });

  it('merges ONLY the unqueued manifest entry onto the worktree base, preserving its existing entries', async () => {
    seedSrc();
    seedDestBase();
    const deps = createDefaultCheckinDeps(srcRepoRoot);

    await deps.copyArtSurface(srcRepoRoot, destRepoRoot, [asset()]);

    const manifest = JSON.parse(
      readFileSync(
        path.join(destRepoRoot, 'public', 'assets', 'generated', 'manifest.json'),
        'utf8',
      ),
    );
    expect(Object.keys(manifest.entries).sort()).toEqual(['preexisting-var-0', 'unqueued-var-2']);
    expect(manifest.entries['unqueued-var-2'].contentHash).toBe('unqueued-hash');
    // The queued asset's entry must NOT leak onto this branch.
    expect(manifest.entries['queued-var-1']).toBeUndefined();
  });

  it('leaves the sprite catalog untouched, so an art check-in mutates only the manifest', async () => {
    seedSrc();
    seedDestBase();
    const catalogPath = path.join(destRepoRoot, 'src', 'shared', 'data', 'sprite-catalog.json');
    const catalogBefore = readFileSync(catalogPath, 'utf8');
    const deps = createDefaultCheckinDeps(srcRepoRoot);

    await deps.copyArtSurface(srcRepoRoot, destRepoRoot, [asset()]);

    // Writing both the manifest and the catalog made every pair of parallel art
    // check-ins conflict by construction. The catalog's `generated:` rows only
    // restate manifest data, so the projection no longer touches them.
    expect(readFileSync(catalogPath, 'utf8')).toBe(catalogBefore);
  });

  it('leaves manifest/catalog untouched when the asset has no manifestKey (still copies the PNG)', async () => {
    const generatedDir = path.join(srcRepoRoot, 'public', 'assets', 'generated');
    mkdirSync(generatedDir, { recursive: true });
    writeFileSync(path.join(generatedDir, 'untracked-var-0.png'), 'UNTRACKED-PNG');
    seedDestBase();
    const manifestPath = path.join(destRepoRoot, 'public', 'assets', 'generated', 'manifest.json');
    const catalogPath = path.join(destRepoRoot, 'src', 'shared', 'data', 'sprite-catalog.json');
    const manifestBefore = readFileSync(manifestPath, 'utf8');
    const catalogBefore = readFileSync(catalogPath, 'utf8');
    const deps = createDefaultCheckinDeps(srcRepoRoot);

    await deps.copyArtSurface(srcRepoRoot, destRepoRoot, [
      asset({
        assetPath: 'generated/untracked-var-0.png',
        manifestKey: null,
        briefId: null,
        variantIndex: null,
      }),
    ]);

    expect(
      existsSync(path.join(destRepoRoot, 'public', 'assets', 'generated', 'untracked-var-0.png')),
    ).toBe(true);
    // No manifestKey to merge — the manifest/catalog merge step must be
    // skipped entirely rather than touching (or corrupting) the base copy.
    expect(readFileSync(manifestPath, 'utf8')).toBe(manifestBefore);
    expect(readFileSync(catalogPath, 'utf8')).toBe(catalogBefore);
  });
});

describe('overlayCatalogEntries — canonical order after insert', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function writeCatalog(repoRoot: string, entries: unknown[]): void {
    const p = path.join(repoRoot, 'src', 'shared', 'data', 'sprite-catalog.json');
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(entries, null, 2));
  }

  function readCatalog(repoRoot: string): Array<Record<string, unknown>> {
    const p = path.join(repoRoot, 'src', 'shared', 'data', 'sprite-catalog.json');
    return JSON.parse(readFileSync(p, 'utf8')) as Array<Record<string, unknown>>;
  }

  it('inserts a new generated: entry into a catalog that ends with sprite: entries, restoring canonical sort order', async () => {
    // This is the ordering regression described in PR #2248 review:
    // the committed catalog currently ends with `sprite:*` entries; appending
    // a `generated:*` row without sorting leaves it out of order and the
    // mandatory `check:sort-assets` CI step rejects the promotion.
    const src = mkdtempSync(path.join(tmpdir(), 'overlay-src-'));
    const dest = mkdtempSync(path.join(tmpdir(), 'overlay-dest-'));
    roots.push(src, dest);

    // Source has the new generated: entry to be overlaid.
    writeCatalog(src, [{ id: 'generated:zzz-sprite-var-0', kind: 'sprite', label: 'zzz sprite' }]);

    // Destination catalog ends with sprite: entries (kind="sheet" comes first in canonical order).
    writeCatalog(dest, [
      { id: 'sprite:aaa-sheet', kind: 'sheet', label: 'aaa sheet' },
      { id: 'sprite:mmm-sheet', kind: 'sheet', label: 'mmm sheet' },
      { id: 'generated:aaa-sprite-var-0', kind: 'sprite', label: 'aaa sprite' },
    ]);

    const { overlayCatalogEntries } = await import('../../../scripts/sprites/checkin-runtime.js');
    const changed = await overlayCatalogEntries(src, dest, ['generated:zzz-sprite-var-0']);
    expect(changed).toBe(true);

    const result = readCatalog(dest);
    const ids = result.map((e) => e.id as string);
    // Sheets must come first, then sprites sorted by id.
    expect(ids).toEqual([
      'sprite:aaa-sheet',
      'sprite:mmm-sheet',
      'generated:aaa-sprite-var-0',
      'generated:zzz-sprite-var-0',
    ]);
  });

  it('replaces an existing entry and keeps canonical order intact', async () => {
    const src = mkdtempSync(path.join(tmpdir(), 'overlay-src-'));
    const dest = mkdtempSync(path.join(tmpdir(), 'overlay-dest-'));
    roots.push(src, dest);

    writeCatalog(src, [
      { id: 'generated:aaa-sprite-var-0', kind: 'sprite', label: 'updated label', tags: ['new'] },
    ]);
    writeCatalog(dest, [
      { id: 'sprite:aaa-sheet', kind: 'sheet', label: 'aaa sheet' },
      { id: 'generated:aaa-sprite-var-0', kind: 'sprite', label: 'old label' },
      { id: 'generated:zzz-sprite-var-0', kind: 'sprite', label: 'zzz sprite' },
    ]);

    const { overlayCatalogEntries } = await import('../../../scripts/sprites/checkin-runtime.js');
    const changed = await overlayCatalogEntries(src, dest, ['generated:aaa-sprite-var-0']);
    expect(changed).toBe(true);

    const result = readCatalog(dest);
    expect(result.find((e) => e.id === 'generated:aaa-sprite-var-0')?.label).toBe('updated label');
    const ids = result.map((e) => e.id as string);
    expect(ids).toEqual([
      'sprite:aaa-sheet',
      'generated:aaa-sprite-var-0',
      'generated:zzz-sprite-var-0',
    ]);
  });
});

describe('buildQueuedAssetMap (durable queue parsing + dedupe)', () => {
  // Mirrors `renderIssueBody`'s marker-wrapped payload format — the same
  // shape `parseAssetIssueBody` reads from a REAL filed issue body.
  function issuePayload(branch: string, assets: readonly CheckinAsset[]): string {
    const payload = { version: 1, branch, baseBranch: 'main', assets };
    return `<!-- ${ASSET_CHECKIN_MARKER}\n${JSON.stringify(payload)}\n-->`;
  }

  it('parses each open issue payload into a queued-asset map keyed by assetPath', () => {
    const queued = buildQueuedAssetMap([
      {
        issueUrl: 'https://github.com/nalfeo/Crawler/issues/10',
        body: issuePayload('assets/checkin-a', [
          asset({ assetPath: 'generated/foo-var-1.png', manifestKey: 'foo-var-1' }),
        ]),
      },
    ]);

    expect(queued.get('generated/foo-var-1.png')).toMatchObject({
      issueUrl: 'https://github.com/nalfeo/Crawler/issues/10',
      branch: 'assets/checkin-a',
    });
  });

  it('ignores malformed/unparseable issue bodies rather than throwing', () => {
    const queued = buildQueuedAssetMap([
      { issueUrl: 'https://github.com/nalfeo/Crawler/issues/11', body: 'not a payload at all' },
    ]);
    expect(queued.size).toBe(0);
  });

  it('conflicting hashes from two issues for the same path are marked ambiguous (no contentHash), not silently kept as first-seen', () => {
    // Issue #20 claims the path with 'first-hash'; issue #21 claims the SAME
    // path with a DIFFERENT 'second-hash'. The old first-seen-wins behavior
    // kept 'first-hash', which would misclassify the conflict as a benign
    // duplicate whenever the current asset happened to match 'first-hash'.
    // The fix: strip contentHash so reconcileQueuedContent always returns
    // 'ambiguous', failing closed.
    const queued = buildQueuedAssetMap([
      {
        issueUrl: 'https://github.com/nalfeo/Crawler/issues/20',
        body: issuePayload('assets/checkin-first', [
          asset({
            assetPath: 'generated/dup-var-1.png',
            manifestKey: 'dup-var-1',
            contentHash: 'first-hash',
          }),
        ]),
      },
      {
        issueUrl: 'https://github.com/nalfeo/Crawler/issues/21',
        body: issuePayload('assets/checkin-second', [
          asset({
            assetPath: 'generated/dup-var-1.png',
            manifestKey: 'dup-var-1',
            contentHash: 'second-hash',
          }),
        ]),
      },
    ]);

    expect(queued.size).toBe(1);
    // The entry is kept from the first issue (issueUrl, branch) but contentHash
    // is stripped to mark the queue as ambiguous for this path.
    const entry = queued.get('generated/dup-var-1.png');
    expect(entry).toMatchObject({
      issueUrl: 'https://github.com/nalfeo/Crawler/issues/20',
      branch: 'assets/checkin-first',
    });
    expect(entry).not.toHaveProperty('contentHash');
  });

  it('equal hashes from two issues for the same path are a true duplicate: first-seen-wins with hash preserved', () => {
    const queued = buildQueuedAssetMap([
      {
        issueUrl: 'https://github.com/nalfeo/Crawler/issues/50',
        body: issuePayload('assets/checkin-first', [
          asset({
            assetPath: 'generated/dup-var-1.png',
            manifestKey: 'dup-var-1',
            contentHash: 'same-hash',
          }),
        ]),
      },
      {
        issueUrl: 'https://github.com/nalfeo/Crawler/issues/51',
        body: issuePayload('assets/checkin-second', [
          asset({
            assetPath: 'generated/dup-var-1.png',
            manifestKey: 'dup-var-1',
            contentHash: 'same-hash',
          }),
        ]),
      },
    ]);

    expect(queued.size).toBe(1);
    expect(queued.get('generated/dup-var-1.png')).toMatchObject({
      issueUrl: 'https://github.com/nalfeo/Crawler/issues/50',
      branch: 'assets/checkin-first',
      contentHash: 'same-hash',
    });
  });

  it('conflicting hashes within the SAME issue payload are also marked ambiguous', () => {
    // Two entries for the same path in one issue with different hashes:
    // the queue entry is downgraded to ambiguous (no contentHash).
    const queued = buildQueuedAssetMap([
      {
        issueUrl: 'https://github.com/nalfeo/Crawler/issues/30',
        body: issuePayload('assets/checkin-batch', [
          asset({
            assetPath: 'generated/repeat-var-1.png',
            manifestKey: 'repeat-var-1',
            contentHash: 'hash-one',
          }),
          asset({
            assetPath: 'generated/repeat-var-1.png',
            manifestKey: 'repeat-var-1',
            contentHash: 'hash-two',
          }),
        ]),
      },
    ]);

    expect(queued.size).toBe(1);
    const entry = queued.get('generated/repeat-var-1.png');
    expect(entry).toMatchObject({ issueUrl: 'https://github.com/nalfeo/Crawler/issues/30' });
    expect(entry).not.toHaveProperty('contentHash');
  });

  it('still keeps DIFFERENT paths from a later issue even when one path collides', () => {
    const queued = buildQueuedAssetMap([
      {
        issueUrl: 'https://github.com/nalfeo/Crawler/issues/40',
        body: issuePayload('assets/checkin-a', [
          asset({ assetPath: 'generated/shared-var-1.png', manifestKey: 'shared-var-1' }),
        ]),
      },
      {
        issueUrl: 'https://github.com/nalfeo/Crawler/issues/41',
        body: issuePayload('assets/checkin-b', [
          asset({ assetPath: 'generated/shared-var-1.png', manifestKey: 'shared-var-1' }),
          asset({ assetPath: 'generated/unique-var-1.png', manifestKey: 'unique-var-1' }),
        ]),
      },
    ]);

    expect(queued.size).toBe(2);
    expect(queued.get('generated/shared-var-1.png')).toMatchObject({
      issueUrl: 'https://github.com/nalfeo/Crawler/issues/40',
    });
    expect(queued.get('generated/unique-var-1.png')).toMatchObject({
      issueUrl: 'https://github.com/nalfeo/Crawler/issues/41',
    });
  });
});
