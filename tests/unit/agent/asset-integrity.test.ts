import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ASSET_PATH_PREFIX,
  assetPathIdentity,
  assetPathMatchesSpriteName,
  checkAssetIntegrity,
  flattenIdentity,
  type MalformedShard,
  type ShardRecord,
} from '../../../scripts/agent/health/asset-integrity-lib.js';

// ---------------------------------------------------------------------------
// Fixture helpers — a clean record unless a field is deliberately overridden.
// ---------------------------------------------------------------------------

const CLEAN_HASH = 'a'.repeat(64);

function record(overrides: Partial<ShardRecord> = {}): ShardRecord {
  return {
    shardFile: 'public/assets/generated/entries/slime-rat-boss.json',
    spriteName: 'slime-rat-boss',
    assetPath: 'generated/slime-rat-boss.png',
    contentHash: CLEAN_HASH,
    actualHash: CLEAN_HASH,
    fileExists: true,
    ...overrides,
  };
}

/** Findings of a given kind, for terse per-class assertions. */
function kinds(findings: readonly { kind: string }[]): string[] {
  return findings.map((f) => f.kind);
}

// ---------------------------------------------------------------------------
// flattenIdentity / assetPathIdentity
// ---------------------------------------------------------------------------

describe('flattenIdentity', () => {
  it('leaves a flat name untouched', () => {
    expect(flattenIdentity('slime-rat-boss')).toBe('slime-rat-boss');
  });

  it('flattens every path separator to a dash', () => {
    expect(flattenIdentity('equipment/accessory/lucky-feather')).toBe(
      'equipment-accessory-lucky-feather',
    );
  });
});

describe('assetPathIdentity', () => {
  it('strips the generated/ prefix and the .png extension', () => {
    expect(assetPathIdentity('generated/slime-rat-boss.png')).toBe('slime-rat-boss');
  });

  it('strips one trailing -placeholder suffix', () => {
    expect(assetPathIdentity('generated/aether-dust-placeholder.png')).toBe('aether-dust');
  });

  it('flattens a nested path so it compares equal to a flattened sprite name', () => {
    expect(assetPathIdentity('generated/equipment/weapon/bone-saw.png')).toBe(
      'equipment-weapon-bone-saw',
    );
  });

  it('returns null when the path is not under generated/', () => {
    expect(assetPathIdentity('sprites/slime-rat-boss.png')).toBeNull();
  });

  it('returns null when the path is not a .png', () => {
    expect(assetPathIdentity('generated/slime-rat-boss.webp')).toBeNull();
  });

  it('returns null for a path with an empty stem', () => {
    expect(assetPathIdentity('generated/.png')).toBeNull();
    expect(assetPathIdentity('generated/-placeholder.png')).toBeNull();
  });
});

describe('assetPathMatchesSpriteName', () => {
  it('accepts every shape the real corpus uses', () => {
    expect(assetPathMatchesSpriteName('slime-rat-boss', 'generated/slime-rat-boss.png')).toBe(true);
    expect(assetPathMatchesSpriteName('aether-dust', 'generated/aether-dust-placeholder.png')).toBe(
      true,
    );
    expect(
      assetPathMatchesSpriteName(
        'equipment/accessory/lucky-feather',
        'generated/equipment-accessory-lucky-feather.png',
      ),
    ).toBe(true);
    expect(
      assetPathMatchesSpriteName(
        'equipment/weapon/bone-saw',
        'generated/equipment/weapon/bone-saw.png',
      ),
    ).toBe(true);
  });

  it('rejects a swapped stem (the Slime-Rat-as-panda class)', () => {
    expect(assetPathMatchesSpriteName('slime-rat-boss', 'generated/panda-boss.png')).toBe(false);
  });

  it('rejects a near-miss that only differs by a variant index', () => {
    expect(
      assetPathMatchesSpriteName('batfolk-boss-var-0', 'generated/batfolk-boss-var-1.png'),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkAssetIntegrity — one describe per finding class
// ---------------------------------------------------------------------------

describe('checkAssetIntegrity — clean corpus', () => {
  it('reports no findings when every record is consistent', () => {
    const result = checkAssetIntegrity([
      record(),
      record({
        shardFile: 'public/assets/generated/entries/equipment/weapon/bone-saw.json',
        spriteName: 'equipment/weapon/bone-saw',
        assetPath: 'generated/equipment/weapon/bone-saw.png',
        contentHash: 'b'.repeat(64),
        actualHash: 'b'.repeat(64),
      }),
    ]);
    expect(result.findings).toEqual([]);
    expect(result.summary).toEqual({ shardsChecked: 2, hashesVerified: 2, unhashed: 0 });
  });
});

describe('checkAssetIntegrity — hash-mismatch', () => {
  it('flags a contentHash that disagrees with the bytes on disk', () => {
    const result = checkAssetIntegrity([
      record({ contentHash: 'a'.repeat(64), actualHash: 'c'.repeat(64) }),
    ]);
    expect(kinds(result.findings)).toEqual(['hash-mismatch']);
    expect(result.summary.hashesVerified).toBe(1);
  });

  it('names both hashes and the shard file in the finding', () => {
    const [finding] = checkAssetIntegrity([
      record({ contentHash: 'a'.repeat(64), actualHash: 'c'.repeat(64) }),
    ]).findings;
    expect(finding?.detail).toContain('a'.repeat(64));
    expect(finding?.detail).toContain('c'.repeat(64));
    expect(finding?.shardFile).toBe('public/assets/generated/entries/slime-rat-boss.json');
  });

  it('tells the reader not to update the hash when the PNG is the wrong art', () => {
    const [finding] = checkAssetIntegrity([
      record({ contentHash: 'a'.repeat(64), actualHash: 'c'.repeat(64) }),
    ]).findings;
    expect(finding?.remediation).toContain('do not update the hash');
  });
});

describe('checkAssetIntegrity — missing-file', () => {
  it('flags an assetPath that does not resolve to a file', () => {
    const result = checkAssetIntegrity([record({ fileExists: false, actualHash: undefined })]);
    expect(kinds(result.findings)).toEqual(['missing-file']);
  });

  it('does not additionally report a hash mismatch when there are no bytes to hash', () => {
    const result = checkAssetIntegrity([
      record({ fileExists: false, actualHash: undefined, contentHash: CLEAN_HASH }),
    ]);
    expect(kinds(result.findings)).toEqual(['missing-file']);
    expect(result.summary.hashesVerified).toBe(0);
  });
});

describe('checkAssetIntegrity — name-mismatch', () => {
  it('flags a shard whose file names a different sprite', () => {
    const result = checkAssetIntegrity([record({ assetPath: 'generated/panda-boss.png' })]);
    expect(kinds(result.findings)).toEqual(['name-mismatch']);
  });

  it('flags a path outside the generated/ prefix', () => {
    const result = checkAssetIntegrity([record({ assetPath: 'sprites/slime-rat-boss.png' })]);
    expect(kinds(result.findings)).toEqual(['name-mismatch']);
  });

  it('quotes the expected path in the finding', () => {
    const [finding] = checkAssetIntegrity([
      record({ assetPath: 'generated/panda-boss.png' }),
    ]).findings;
    expect(finding?.detail).toContain(`${ASSET_PATH_PREFIX}slime-rat-boss.png`);
  });

  it('still detects a hash mismatch on the same record', () => {
    const result = checkAssetIntegrity([
      record({ assetPath: 'generated/panda-boss.png', actualHash: 'c'.repeat(64) }),
    ]);
    expect(kinds(result.findings).sort()).toEqual(['hash-mismatch', 'name-mismatch']);
  });
});

describe('checkAssetIntegrity — duplicate-path', () => {
  it('flags two different sprites claiming the same PNG', () => {
    const result = checkAssetIntegrity([
      record({ shardFile: 'entries/a.json', spriteName: 'a', assetPath: 'generated/a.png' }),
      record({ shardFile: 'entries/b.json', spriteName: 'b', assetPath: 'generated/a.png' }),
    ]);
    // 'b' also fails the identity rule against generated/a.png, which is the
    // point: a cyclic path shuffle shows up as both classes.
    expect(kinds(result.findings).filter((k) => k === 'duplicate-path')).toHaveLength(2);
  });

  it('does not flag a path shared by shards with the same sprite name', () => {
    const result = checkAssetIntegrity([
      record({ shardFile: 'entries/a.json', spriteName: 'a', assetPath: 'generated/a.png' }),
      record({ shardFile: 'entries/a-copy.json', spriteName: 'a', assetPath: 'generated/a.png' }),
    ]);
    expect(kinds(result.findings)).not.toContain('duplicate-path');
  });
});

describe('checkAssetIntegrity — duplicate-name', () => {
  it('flags two shards declaring the same sprite name, once per shard', () => {
    const result = checkAssetIntegrity([
      record({ shardFile: 'entries/a.json', spriteName: 'a', assetPath: 'generated/a.png' }),
      record({ shardFile: 'entries/a-copy.json', spriteName: 'a', assetPath: 'generated/a.png' }),
    ]);
    expect(kinds(result.findings)).toEqual(['duplicate-name', 'duplicate-name']);
    expect(result.findings[0]?.detail).toContain('entries/a.json, entries/a-copy.json');
  });
});

describe('checkAssetIntegrity — malformed', () => {
  it('reports a malformed shard as a finding rather than throwing', () => {
    const malformed: MalformedShard[] = [
      { shardFile: 'entries/broken.json', reason: 'invalid JSON — Unexpected end of input' },
    ];
    const result = checkAssetIntegrity([], malformed);
    expect(kinds(result.findings)).toEqual(['malformed']);
    expect(result.findings[0]?.detail).toContain('Unexpected end of input');
  });

  describe('checkAssetIntegrity — unsafe-provenance', () => {
    it('flags machine-local provenance and an escaping source run', () => {
      const result = checkAssetIntegrity([
        record({
          provenanceViolations: [
            'forbidden field "effectivePipelineSnapshotPath"',
            'unsafe sourceRun "../../AppData/Local/Temp/run"',
          ],
        }),
      ]);
      expect(kinds(result.findings)).toEqual(['unsafe-provenance', 'unsafe-provenance']);
    });

    it('flags a Windows drive-qualified source run', () => {
      const result = checkAssetIntegrity([
        record({ provenanceViolations: ['unsafe sourceRun "C:temporary-run"'] }),
      ]);
      expect(kinds(result.findings)).toEqual(['unsafe-provenance']);
    });
  });

  it('lists malformed shards before per-record findings', () => {
    const result = checkAssetIntegrity(
      [record({ actualHash: 'c'.repeat(64) })],
      [{ shardFile: 'entries/broken.json', reason: 'invalid JSON' }],
    );
    expect(kinds(result.findings)).toEqual(['malformed', 'hash-mismatch']);
  });
});

describe('checkAssetIntegrity — unhashed legacy entries', () => {
  it('counts a record with no contentHash without producing a finding', () => {
    const result = checkAssetIntegrity([record({ contentHash: undefined, actualHash: undefined })]);
    expect(result.findings).toEqual([]);
    expect(result.summary).toEqual({ shardsChecked: 1, hashesVerified: 0, unhashed: 1 });
  });

  it('separates hashed from unhashed records in the summary', () => {
    const result = checkAssetIntegrity([
      record(),
      record({
        shardFile: 'entries/legacy.json',
        spriteName: 'legacy',
        assetPath: 'generated/legacy.png',
        contentHash: undefined,
        actualHash: undefined,
      }),
    ]);
    expect(result.summary).toEqual({ shardsChecked: 2, hashesVerified: 1, unhashed: 1 });
  });
});

// ---------------------------------------------------------------------------
// Integration: the real committed corpus.
//
// This is the check the CLI performs, run against the actual shards and PNGs.
// It duplicates only the I/O the CLI does; the verdict comes from the same pure
// lib, so a corpus regression fails here as well as in CI.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ENTRIES_DIR = 'public/assets/generated/entries';
const ASSETS_ROOT = 'public/assets';

/**
 * Orphan shards tolerated by this corpus test.
 *
 * Intentionally EMPTY. The one historical entry
 * (`rhea-vale-var-0-walk`) was deleted rather than tolerated: its PNG was
 * removed by PR #2322 when gender-matched walk-cycle sheets replaced it, and
 * the shard was silently resurrected by a later chore commit (#2663) — exactly
 * the silent-revert class this check exists to catch.
 *
 * Keep this at zero. An orphan shard means a sprite nothing can load, so the
 * correct response is to restore the PNG or delete the shard, never to add an
 * entry here.
 */
const KNOWN_ORPHAN_SHARDS: readonly string[] = [];

function collectShardFiles(absDir: string, relDir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const relPath = path.posix.join(relDir, entry.name);
    if (entry.isDirectory()) out.push(...collectShardFiles(path.join(absDir, entry.name), relPath));
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(relPath);
  }
  return out.sort();
}

function scanRealCorpus(): {
  records: ShardRecord[];
  malformed: MalformedShard[];
  shardFiles: string[];
} {
  const shardFiles = collectShardFiles(path.join(REPO_ROOT, ENTRIES_DIR), ENTRIES_DIR);
  const records: ShardRecord[] = [];
  const malformed: MalformedShard[] = [];

  for (const shardFile of shardFiles) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path.join(REPO_ROOT, shardFile), 'utf8'));
    } catch (e) {
      malformed.push({ shardFile, reason: `invalid JSON — ${(e as Error).message}` });
      continue;
    }
    const shard = parsed as Record<string, unknown>;
    const spriteName = shard['spriteName'];
    const assetPath = shard['assetPath'];
    if (typeof spriteName !== 'string' || typeof assetPath !== 'string') {
      malformed.push({ shardFile, reason: 'missing spriteName or assetPath' });
      continue;
    }
    const raw = shard['contentHash'];
    const contentHash = typeof raw === 'string' ? raw : undefined;
    const absAsset = path.join(REPO_ROOT, ASSETS_ROOT, assetPath);
    let fileExists: boolean;
    try {
      fileExists = statSync(absAsset).isFile();
    } catch {
      fileExists = false;
    }
    const actualHash =
      fileExists && contentHash !== undefined
        ? createHash('sha256').update(readFileSync(absAsset)).digest('hex')
        : undefined;
    records.push({ shardFile, spriteName, assetPath, contentHash, actualHash, fileExists });
  }

  return { records, malformed, shardFiles };
}

describe('checkAssetIntegrity — committed corpus', () => {
  const { records, malformed, shardFiles } = scanRealCorpus();
  const result = checkAssetIntegrity(records, malformed);

  it('finds a non-trivial number of shards (canary against checking nothing)', () => {
    expect(shardFiles.length).toBeGreaterThan(100);
    expect(records.length).toBe(shardFiles.length);
  });

  it('actually verifies hashes rather than skipping them all', () => {
    expect(result.summary.hashesVerified).toBeGreaterThan(100);
  });

  it('has no shard whose contentHash disagrees with its PNG bytes', () => {
    const mismatches = result.findings.filter((f) => f.kind === 'hash-mismatch');
    expect(mismatches.map((f) => f.shardFile)).toEqual([]);
  });

  it('has no shard whose assetPath contradicts its spriteName', () => {
    const mismatches = result.findings.filter((f) => f.kind === 'name-mismatch');
    expect(mismatches.map((f) => f.shardFile)).toEqual([]);
  });

  it('has no duplicate sprite names or shared asset paths', () => {
    const dupes = result.findings.filter(
      (f) => f.kind === 'duplicate-name' || f.kind === 'duplicate-path',
    );
    expect(dupes.map((f) => f.shardFile)).toEqual([]);
  });

  it('has no malformed shards', () => {
    expect(result.findings.filter((f) => f.kind === 'malformed').map((f) => f.shardFile)).toEqual(
      [],
    );
  });

  it('has no orphan shards beyond the documented known list', () => {
    const orphans = result.findings
      .filter((f) => f.kind === 'missing-file')
      .map((f) => f.shardFile);
    expect(orphans.filter((f) => !KNOWN_ORPHAN_SHARDS.includes(f))).toEqual([]);
  });
});
