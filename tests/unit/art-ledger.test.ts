import { describe, expect, it } from 'vitest';
import {
  entryMatchKeys,
  mergeAssetFindingsIntoLedger,
  normalizeAssetKey,
  suppressedAssetKeys,
  type ArtLedger,
  type ArtLedgerEntry,
  type LedgerFindingInput,
} from '../../scripts/agent/review/art-ledger.js';

/**
 * The `--art-review` visual judge persists an art-regen ledger so it does NOT
 * re-critique the same queued asset every run. The vision model labels the SAME
 * defect inconsistently across runs ('welcome-banner' -> 'welcome-sign' ->
 * 'welcome-sign.text'), so both suppression and dedupe MUST be alias-aware or the
 * ledger spawns brittle duplicates and re-flags an already-queued asset. These
 * tests pin that behavior (regression: welcome-sign got a duplicate entry instead
 * of merging into its welcome-banner alias).
 */
const ISO = '2026-07-08T21:00:00.000Z';

function entry(partial: Partial<ArtLedgerEntry> & { asset: string }): ArtLedgerEntry {
  return {
    first_seen: ISO,
    last_seen: ISO,
    seen_count: 1,
    status: 'needs-regen',
    ...partial,
  };
}

function ledgerOf(...assets: ArtLedgerEntry[]): ArtLedger {
  return { updated: '', note: '', assets };
}

describe('normalizeAssetKey', () => {
  it('lowercases and collapses non-alphanumerics to single dashes', () => {
    expect(normalizeAssetKey('Welcome Banner')).toBe('welcome-banner');
    expect(normalizeAssetKey('welcome-sign.text')).toBe('welcome-sign-text');
    expect(normalizeAssetKey('  --Foo__Bar--  ')).toBe('foo-bar');
  });
});

describe('entryMatchKeys', () => {
  it('returns the asset key plus every non-empty alias key', () => {
    const e = entry({ asset: 'welcome-banner', aliases: ['welcome-sign', 'welcome signage', ''] });
    expect(entryMatchKeys(e)).toEqual(['welcome-banner', 'welcome-sign', 'welcome-signage']);
  });

  it('handles an entry with no aliases', () => {
    expect(entryMatchKeys(entry({ asset: 'rug' }))).toEqual(['rug']);
  });
});

describe('suppressedAssetKeys', () => {
  it('includes aliases so an alias-labeled finding is suppressed', () => {
    const ledger = ledgerOf(entry({ asset: 'welcome-banner', aliases: ['welcome-sign'] }));
    const keys = suppressedAssetKeys(ledger);
    expect(keys.has('welcome-banner')).toBe(true);
    expect(keys.has('welcome-sign')).toBe(true);
  });

  it('ignores resolved entries', () => {
    const ledger = ledgerOf(
      entry({ asset: 'welcome-banner', aliases: ['welcome-sign'], status: 'resolved' }),
      entry({ asset: 'rug' }),
    );
    const keys = suppressedAssetKeys(ledger);
    expect(keys.has('welcome-banner')).toBe(false);
    expect(keys.has('welcome-sign')).toBe(false);
    expect(keys.has('rug')).toBe(true);
  });
});

describe('mergeAssetFindingsIntoLedger', () => {
  const finding = (
    partial: Partial<LedgerFindingInput> & { asset: string },
  ): LedgerFindingInput => ({
    needs_regen: true,
    ...partial,
  });

  it('appends a genuinely new needs_regen finding', () => {
    const ledger = ledgerOf();
    const added = mergeAssetFindingsIntoLedger(ledger, [finding({ asset: 'shop-table' })], ISO);
    expect(added).toHaveLength(1);
    expect(ledger.assets).toHaveLength(1);
    expect(ledger.assets[0]?.asset).toBe('shop-table');
    expect(ledger.assets[0]?.seen_count).toBe(1);
  });

  it('bumps (does NOT duplicate) an exact-asset repeat', () => {
    const ledger = ledgerOf(entry({ asset: 'shop-table', seen_count: 2 }));
    const added = mergeAssetFindingsIntoLedger(
      ledger,
      [finding({ asset: 'shop-table' })],
      '2026-07-09T00:00:00.000Z',
    );
    expect(added).toHaveLength(0);
    expect(ledger.assets).toHaveLength(1);
    expect(ledger.assets[0]?.seen_count).toBe(3);
    expect(ledger.assets[0]?.last_seen).toBe('2026-07-09T00:00:00.000Z');
  });

  it('merges an ALIAS-labeled finding into its entry instead of appending (regression)', () => {
    // welcome-banner already lists welcome-sign as an alias; the model returned
    // 'welcome-sign' this run — it must bump welcome-banner, not create a dup.
    const ledger = ledgerOf(
      entry({ asset: 'welcome-banner', aliases: ['welcome-sign', 'welcome-sign.text'] }),
    );
    const added = mergeAssetFindingsIntoLedger(
      ledger,
      [finding({ asset: 'welcome-sign', issue: 'freestanding sign, not a wall banner' })],
      ISO,
    );
    expect(added).toHaveLength(0);
    expect(ledger.assets).toHaveLength(1);
    expect(ledger.assets[0]?.asset).toBe('welcome-banner');
    expect(ledger.assets[0]?.seen_count).toBe(2);
  });

  it('matches aliases regardless of punctuation/case drift', () => {
    const ledger = ledgerOf(entry({ asset: 'welcome-banner', aliases: ['welcome-sign.text'] }));
    const added = mergeAssetFindingsIntoLedger(
      ledger,
      [finding({ asset: 'Welcome Sign Text' })],
      ISO,
    );
    expect(added).toHaveLength(0);
    expect(ledger.assets[0]?.seen_count).toBe(2);
  });

  it('fills missing issue/kind/prop on bump without overwriting existing values', () => {
    const ledger = ledgerOf(entry({ asset: 'rug', issue: 'original issue' }));
    mergeAssetFindingsIntoLedger(
      ledger,
      [finding({ asset: 'rug', issue: 'new issue', kind: 'stretched', prop: 'welcome-rug' })],
      ISO,
    );
    expect(ledger.assets[0]?.issue).toBe('original issue');
    expect(ledger.assets[0]?.kind).toBe('stretched');
    expect(ledger.assets[0]?.prop).toBe('welcome-rug');
  });

  it('ignores findings that are not needs_regen or have an empty asset', () => {
    const ledger = ledgerOf();
    const added = mergeAssetFindingsIntoLedger(
      ledger,
      [
        finding({ asset: 'a', needs_regen: false }),
        { asset: '   ', needs_regen: true },
        { asset: undefined, needs_regen: true },
      ],
      ISO,
    );
    expect(added).toHaveLength(0);
    expect(ledger.assets).toHaveLength(0);
  });
});
