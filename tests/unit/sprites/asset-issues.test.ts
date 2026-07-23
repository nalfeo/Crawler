/**
 * Unit tests for asset-issues.ts (the consolidation helpers used by the
 * asset-pr skill): parse the embedded issue payload, and union manifests +
 * catalogs across several check-in branches.
 */

import { describe, expect, it } from 'vitest';
import { planAssetCheckin, type CheckinAsset } from '../../../scripts/sprites/checkin.js';
import {
  mergeCatalogs,
  mergeManifests,
  parseAssetIssueBody,
  type CatalogEntry,
  type GeneratedManifest,
} from '../../../scripts/sprites/asset-issues.js';

const NOW = new Date('2026-06-08T19:08:15.000Z');

function asset(over: Partial<CheckinAsset> = {}): CheckinAsset {
  return {
    assetPath: 'generated/skull-mace-var-2.png',
    manifestKey: 'skull-mace-var-2',
    briefId: 'skull-mace',
    variantIndex: 2,
    ...over,
  };
}

describe('parseAssetIssueBody', () => {
  it('round-trips a payload produced by planAssetCheckin', () => {
    const plan = planAssetCheckin({ assets: [asset()], now: NOW, slug: 's' });
    const payload = parseAssetIssueBody(plan.issueBody);
    expect(payload).toEqual({
      version: 1,
      state: 'checked-in',
      filedAt: NOW.toISOString(),
      branch: 'assets/s',
      baseBranch: 'main',
      assets: [asset()],
    });
  });

  it('returns null when no marker is present', () => {
    expect(parseAssetIssueBody('just a normal issue body')).toBeNull();
  });

  it('returns null on malformed JSON inside the marker', () => {
    const body = '<!-- asset-checkin:v1\n{ not json }\n-->';
    expect(parseAssetIssueBody(body)).toBeNull();
  });

  it('returns null when the payload shape is wrong', () => {
    const body = '<!-- asset-checkin:v1\n{"version":2,"branch":"x"}\n-->';
    expect(parseAssetIssueBody(body)).toBeNull();
  });

  it('tolerates surrounding markdown and whitespace', () => {
    const body = [
      '## Asset check-in',
      'blah blah',
      '<!-- machine block -->',
      '<!-- asset-checkin:v1',
      '   {"version":1,"branch":"assets/x","baseBranch":"main","assets":[]}   ',
      '-->',
      'trailing text',
    ].join('\n');
    const payload = parseAssetIssueBody(body);
    expect(payload).not.toBeNull();
    expect(payload!.branch).toBe('assets/x');
    expect(payload!.assets).toEqual([]);
  });
});

describe('mergeManifests', () => {
  it('unions entries by key with later overlays winning', () => {
    const base: GeneratedManifest = {
      version: 1,
      entries: { a: { assetPath: 'generated/a.png', variantIndex: 1 } },
    };
    const overlay: GeneratedManifest = {
      version: 1,
      entries: {
        a: { assetPath: 'generated/a.png', variantIndex: 9 }, // overrides
        b: { assetPath: 'generated/b.png', variantIndex: 1 }, // new
      },
    };
    const merged = mergeManifests(base, overlay);
    expect(Object.keys(merged.entries).sort()).toEqual(['a', 'b']);
    expect(merged.entries.a!.variantIndex).toBe(9);
  });

  it('keeps the highest version seen', () => {
    expect(mergeManifests({ version: 1, entries: {} }, { version: 4, entries: {} }).version).toBe(
      4,
    );
    expect(mergeManifests({ version: 7, entries: {} }, { version: 2, entries: {} }).version).toBe(
      7,
    );
  });

  it('does not mutate the base manifest', () => {
    const base: GeneratedManifest = {
      version: 1,
      entries: { a: { assetPath: 'generated/a.png' } },
    };
    mergeManifests(base, { version: 1, entries: { b: { assetPath: 'generated/b.png' } } });
    expect(Object.keys(base.entries)).toEqual(['a']);
  });
});

describe('mergeCatalogs', () => {
  it('unions by id and returns result in canonical sorted order', () => {
    const base: CatalogEntry[] = [
      { id: 'sheet:custom', kind: 'sheet' },
      { id: 'generated:foo', kind: 'sprite', label: 'foo' },
    ];
    const overlay: CatalogEntry[] = [
      { id: 'generated:foo', kind: 'sprite', label: 'foo-updated' }, // overrides
      { id: 'generated:bar', kind: 'sprite', label: 'bar' }, // new entry
    ];
    const merged = mergeCatalogs(base, overlay);
    // sheet entries come first, then non-sheet sorted by id lexicographically
    expect(merged.map((e) => e.id)).toEqual(['sheet:custom', 'generated:bar', 'generated:foo']);
    expect(merged.find((e) => e.id === 'generated:foo')!.label).toBe('foo-updated');
  });

  it('drops entries without a string id', () => {
    const merged = mergeCatalogs([{ id: 'a' }], [{ label: 'no-id' } as unknown as CatalogEntry]);
    expect(merged.map((e) => e.id)).toEqual(['a']);
  });
});
