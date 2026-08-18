import { describe, expect, it } from 'vitest';
import type { ManifestEntry } from '../../../src/shared/generated-assets.js';
import {
  backfillManifestTypes,
  canonicalizeEntry,
  resolveManifestEntryType,
  type TypeResolutionSources,
} from '../../../scripts/sprites/backfill-manifest-types.js';

/**
 * Build a valid REAL {@link ManifestEntry}. Override `sourceRun`/`sensorScore`/
 * `assetPath` to make a placeholder. Tests use literals only — never the real
 * manifest.
 */
function manifestEntry(
  over: Partial<ManifestEntry> & Pick<ManifestEntry, 'briefId'>,
): ManifestEntry {
  return {
    spriteName: `${over.briefId}-var-0`,
    assetPath: `generated/${over.briefId}-var-0.png`,
    approvedAt: '2026-01-01T00:00:00.000Z',
    sourceRun: 'run-001',
    variantIndex: 0,
    anchor: null,
    sensorScore: '8/10',
    judgeScore: '4',
    ...over,
  };
}

function sources(over: Partial<TypeResolutionSources> = {}): TypeResolutionSources {
  return {
    catalogTypeBySpriteName: {},
    catalogTypesByConcept: {},
    briefTypeByKey: {},
    overridesByConcept: {},
    ...over,
  };
}

describe('resolveManifestEntryType', () => {
  it('keeps an existing valid type (idempotency, source=existing)', () => {
    const entry = manifestEntry({ briefId: 'iron-sword-v1', type: 'weapon' });
    // Even with a conflicting catalog source, the existing value wins.
    const res = resolveManifestEntryType(
      entry,
      sources({ catalogTypeBySpriteName: { 'iron-sword-v1-var-0': 'item' } }),
    );
    expect(res).toEqual({ type: 'weapon', source: 'existing' });
  });

  it('ignores an invalid existing type and falls through the cascade', () => {
    const entry = manifestEntry({
      briefId: 'iron-sword-v1',
      type: 'bogus' as unknown as ManifestEntry['type'],
    });
    const res = resolveManifestEntryType(
      entry,
      sources({ catalogTypeBySpriteName: { 'iron-sword-v1-var-0': 'weapon' } }),
    );
    expect(res).toEqual({ type: 'weapon', source: 'catalog-sprite' });
  });

  it('resolves via catalog by exact sprite name', () => {
    const entry = manifestEntry({ briefId: 'lamp-v1', spriteName: 'lamp-v1-var-2' });
    const res = resolveManifestEntryType(
      entry,
      sources({ catalogTypeBySpriteName: { 'lamp-v1-var-2': 'item' } }),
    );
    expect(res).toEqual({ type: 'item', source: 'catalog-sprite' });
  });

  it('resolves via catalog concept when a single type is unambiguous', () => {
    const entry = manifestEntry({
      briefId: 'baseball-bat',
      spriteName: 'baseball-bat-var-6',
    });
    const res = resolveManifestEntryType(
      entry,
      sources({ catalogTypesByConcept: { 'baseball-bat': ['weapon'] } }),
    );
    expect(res).toEqual({ type: 'weapon', source: 'catalog-concept' });
  });

  it('does NOT resolve via catalog concept when the concept is ambiguous', () => {
    const entry = manifestEntry({ briefId: 'mystery-v1' });
    const res = resolveManifestEntryType(
      entry,
      sources({ catalogTypesByConcept: { mystery: ['weapon', 'item'] } }),
    );
    expect(res.type).toBeNull();
    expect(res.source).toBe('unresolved');
  });

  it('resolves via brief YAML by briefId', () => {
    const entry = manifestEntry({ briefId: 'health-potion-v1' });
    const res = resolveManifestEntryType(
      entry,
      sources({ briefTypeByKey: { 'health-potion-v1': 'item' } }),
    );
    expect(res).toEqual({ type: 'item', source: 'brief-yaml' });
  });

  it('resolves via the override map by normalized concept', () => {
    const entry = manifestEntry({ briefId: 'prop-torch', spriteName: 'prop-torch-var-10' });
    const res = resolveManifestEntryType(
      entry,
      sources({ overridesByConcept: { 'prop-torch': 'tile' } }),
    );
    expect(res).toEqual({ type: 'tile', source: 'override' });
  });

  it('resolves via the conservative prefix heuristic as a last resort', () => {
    const entry = manifestEntry({ briefId: 'tile-cobblestone-v1' });
    const res = resolveManifestEntryType(entry, sources());
    expect(res).toEqual({ type: 'tile', source: 'heuristic' });
  });

  it('resolves a dash-less concept that is itself a bare type (no truncation)', () => {
    // `concept.indexOf('-')` is -1 here; the old `slice(0, -1)` truncated "tile"
    // to "til" and mis-classified it as unresolved.
    const entry = manifestEntry({ briefId: 'tile' });
    const res = resolveManifestEntryType(entry, sources());
    expect(res).toEqual({ type: 'tile', source: 'heuristic' });
  });

  it('returns null (unresolved) when nothing matches', () => {
    const entry = manifestEntry({ briefId: 'gizmo-v1' });
    const res = resolveManifestEntryType(entry, sources());
    expect(res).toEqual({ type: null, source: 'unresolved' });
  });

  it('honours cascade precedence: catalog-sprite beats brief-yaml and override', () => {
    const entry = manifestEntry({ briefId: 'lamp-v1', spriteName: 'lamp-v1-var-0' });
    const res = resolveManifestEntryType(
      entry,
      sources({
        catalogTypeBySpriteName: { 'lamp-v1-var-0': 'item' },
        briefTypeByKey: { 'lamp-v1': 'tile' },
        overridesByConcept: { lamp: 'weapon' },
      }),
    );
    expect(res).toEqual({ type: 'item', source: 'catalog-sprite' });
  });

  it('honours cascade precedence: brief-yaml beats override', () => {
    const entry = manifestEntry({ briefId: 'lamp-v1' });
    const res = resolveManifestEntryType(
      entry,
      sources({
        briefTypeByKey: { 'lamp-v1': 'item' },
        overridesByConcept: { lamp: 'weapon' },
      }),
    );
    expect(res).toEqual({ type: 'item', source: 'brief-yaml' });
  });
});

describe('canonicalizeEntry', () => {
  it('inserts type between judgeScore and contentHash and preserves other fields', () => {
    const entry = manifestEntry({ briefId: 'iron-sword-v1', contentHash: 'abc123' });
    const out = canonicalizeEntry(entry, 'weapon');
    expect(Object.keys(out)).toEqual([
      'briefId',
      'spriteName',
      'assetPath',
      'approvedAt',
      'sourceRun',
      'variantIndex',
      'anchor',
      'sensorScore',
      'judgeScore',
      'type',
      'contentHash',
    ]);
    expect(out.type).toBe('weapon');
    expect(out.contentHash).toBe('abc123');
  });

  it('writes an explicit null type for unresolved entries', () => {
    const out = canonicalizeEntry(manifestEntry({ briefId: 'gizmo-v1' }), null);
    expect(out.type).toBeNull();
    expect('type' in out).toBe(true);
  });

  it('appends unknown passthrough keys after the known ones', () => {
    const entry = {
      ...manifestEntry({ briefId: 'iron-sword-v1' }),
      futureField: 42,
    } as ManifestEntry & { futureField: number };
    const out = canonicalizeEntry(entry, 'weapon') as ManifestEntry & { futureField: number };
    expect(Object.keys(out).at(-1)).toBe('futureField');
    expect(out.futureField).toBe(42);
  });
});

describe('backfillManifestTypes', () => {
  it('fills types, tracks source counts, and reports changedCount', () => {
    const entries: Record<string, ManifestEntry> = {
      'lamp-v1-var-0': manifestEntry({ briefId: 'lamp-v1', spriteName: 'lamp-v1-var-0' }),
      'prop-torch-var-1': manifestEntry({
        briefId: 'prop-torch',
        spriteName: 'prop-torch-var-1',
      }),
    };
    const result = backfillManifestTypes(
      entries,
      sources({
        catalogTypeBySpriteName: { 'lamp-v1-var-0': 'item' },
        overridesByConcept: { 'prop-torch': 'tile' },
      }),
    );
    expect(result.entries['lamp-v1-var-0']!.type).toBe('item');
    expect(result.entries['prop-torch-var-1']!.type).toBe('tile');
    expect(result.changedCount).toBe(2);
    expect(result.bySource['catalog-sprite']).toBe(1);
    expect(result.bySource.override).toBe(1);
    expect(result.unresolvedReal).toEqual([]);
  });

  it('splits unresolved entries into real vs placeholder buckets', () => {
    const entries: Record<string, ManifestEntry> = {
      'gizmo-v1-var-0': manifestEntry({ briefId: 'gizmo-v1' }),
      'widget-placeholder': manifestEntry({
        briefId: 'widget',
        spriteName: 'widget-placeholder',
        assetPath: 'generated/widget-placeholder.png',
        sourceRun: 'placeholder',
        sensorScore: 'placeholder',
      }),
    };
    const result = backfillManifestTypes(entries, sources());
    expect(result.unresolvedReal).toEqual(['gizmo-v1-var-0']);
    expect(result.unresolvedPlaceholder).toEqual(['widget-placeholder']);
    expect(result.entries['gizmo-v1-var-0']!.type).toBeNull();
    expect(result.entries['widget-placeholder']!.type).toBeNull();
  });

  it('preserves top-level entry order (does not re-sort)', () => {
    const entries: Record<string, ManifestEntry> = {
      'zebra-v1-var-0': manifestEntry({ briefId: 'zebra-v1' }),
      'apple-v1-var-0': manifestEntry({ briefId: 'apple-v1' }),
    };
    const result = backfillManifestTypes(entries, sources({ overridesByConcept: {} }));
    expect(Object.keys(result.entries)).toEqual(['zebra-v1-var-0', 'apple-v1-var-0']);
  });

  it('is idempotent: a second pass reports zero changes', () => {
    const entries: Record<string, ManifestEntry> = {
      'lamp-v1-var-0': manifestEntry({ briefId: 'lamp-v1', spriteName: 'lamp-v1-var-0' }),
    };
    const src = sources({ catalogTypeBySpriteName: { 'lamp-v1-var-0': 'item' } });
    const first = backfillManifestTypes(entries, src);
    const second = backfillManifestTypes(first.entries, src);
    expect(second.changedCount).toBe(0);
    expect(second.bySource.existing).toBe(1);
    expect(second.entries).toEqual(first.entries);
  });
});
