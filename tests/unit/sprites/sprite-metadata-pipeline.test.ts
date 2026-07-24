import { describe, expect, it } from 'vitest';
import {
  createHeuristicProvider,
  mergeChangedCatalogEntries,
  runMetadataPipeline,
  type MetadataProvider,
} from '../../../scripts/sprites/metadata-pipeline.js';
import { parseSpriteCatalog } from '../../../src/shared/sprite-catalog.js';

describe('sprite metadata pipeline', () => {
  it('heuristic provider generates sentence descriptions and tags', async () => {
    const provider = createHeuristicProvider();
    const catalog = parseSpriteCatalog([
      {
        id: 'sprite:enemy.goblin',
        kind: 'sprite',
        label: 'enemy.goblin',
        description: 'Description pending.',
        tags: [],
        spriteId: 'enemy.goblin',
        sheetKey: 'kenney-roguelike-characters',
        frame: 12,
        col: 0,
        row: 1,
      },
    ]);

    const draft = await provider.generate(catalog[0]!, { catalog });
    expect(draft.description.endsWith('.')).toBe(true);
    expect(draft.tags.length).toBeGreaterThan(0);
  });

  it('applies approved draft metadata updates', async () => {
    const provider: MetadataProvider = {
      name: 'test',
      async generate() {
        return {
          description: 'A generated sentence.',
          tags: ['enemy', 'test'],
          tileConnectsTo: ['sprite:tile.floor-a'],
          animationClips: ['idle'],
          rationale: 'test',
        };
      },
      async judge() {
        return { approved: true, score: 95, issues: [] };
      },
    };

    const catalog = parseSpriteCatalog([
      {
        id: 'sprite:tile.floor-a',
        kind: 'sprite',
        label: 'tile.floor-a',
        description: 'Description pending.',
        tags: [],
        spriteId: 'tile.floor-a',
        sheetKey: 'kenney-tiny-dungeon',
        frame: 10,
        col: 2,
        row: 1,
      },
      {
        id: 'sprite:enemy.goblin',
        kind: 'sprite',
        label: 'enemy.goblin',
        description: 'Description pending.',
        tags: [],
        spriteId: 'enemy.goblin',
        sheetKey: 'kenney-roguelike-characters',
        frame: 12,
        col: 0,
        row: 1,
      },
    ]);

    const result = await runMetadataPipeline(catalog, {
      provider,
      ids: ['sprite:enemy.goblin'],
      force: true,
      minScore: 70,
    });

    expect(result.changedCount).toBe(1);
    // changedIds must name EXACTLY the entry that changed — the metadata route's
    // durable re-queue keys off it, so an unchanged entry leaking in (or the
    // changed one missing) would re-queue the wrong assets (#1 / gemini gap).
    expect(result.changedIds).toEqual(['sprite:enemy.goblin']);
    expect(result.changedIds).not.toContain('sprite:tile.floor-a');
    const updated = result.updated.find((entry) => entry.id === 'sprite:enemy.goblin');
    expect(updated).toBeDefined();
    expect(updated?.description).toBe('A generated sentence.');
    expect(updated?.tags).toEqual(['enemy', 'test']);
    if (updated?.kind !== 'sprite') {
      throw new Error('Expected sprite entry');
    }
    expect(updated.tile).toEqual({ connectsTo: ['sprite:tile.floor-a'] });
    expect(updated.animation).toEqual({ clips: ['idle'] });
  });

  it('skips draft application when judge rejects', async () => {
    const provider: MetadataProvider = {
      name: 'test',
      async generate() {
        return {
          description: 'Should not apply.',
          tags: ['bad'],
          rationale: 'test',
        };
      },
      async judge() {
        return { approved: false, score: 20, issues: ['nope'] };
      },
    };

    const catalog = parseSpriteCatalog([
      {
        id: 'sheet:kenney-tiny-dungeon',
        kind: 'sheet',
        label: 'kenney-tiny-dungeon',
        description: 'Description pending.',
        tags: [],
        sheetKey: 'kenney-tiny-dungeon',
        path: '/assets/kenney/tiny-dungeon/spritesheet.png',
        frameWidth: 16,
        frameHeight: 16,
        margin: 0,
        spacing: 1,
        cols: 12,
      },
    ]);

    const result = await runMetadataPipeline(catalog, {
      provider,
      force: true,
    });
    expect(result.changedCount).toBe(0);
    expect(result.rejectedCount).toBe(1);
    expect(result.updated[0]?.description).toBe('Description pending.');
  });
});

describe('mergeChangedCatalogEntries (metadata RMW-race guard, #1a)', () => {
  const rec = (id: string, description: string) =>
    parseSpriteCatalog([
      {
        id,
        kind: 'sprite',
        label: id.replace('sprite:', ''),
        description,
        tags: [],
        spriteId: id.replace('sprite:', ''),
        sheetKey: 'kenney-tiny-dungeon',
        frame: 1,
        col: 0,
        row: 0,
      },
    ])[0]!;

  it('overlays only changed entries, preserving a concurrently-added row', () => {
    // `fresh` = the catalog re-read under the lock; between the run's pre-lock
    // read and this write, a concurrent /approve added `sprite:c`. `updated` is
    // the run's STALE snapshot (no `sprite:c`) that changed only `sprite:a`.
    const fresh = [
      rec('sprite:a', 'A original.'),
      rec('sprite:b', 'B original.'),
      rec('sprite:c', 'C added concurrently.'),
    ];
    const updated = [rec('sprite:a', 'A tagged.'), rec('sprite:b', 'B original.')];

    const merged = mergeChangedCatalogEntries(fresh, updated, ['sprite:a']);

    // sprite:a takes the run's new value; sprite:b is untouched; sprite:c (the
    // concurrent add) SURVIVES instead of being clobbered by the stale snapshot.
    expect(merged.map((entry) => entry.id)).toEqual(['sprite:a', 'sprite:b', 'sprite:c']);
    expect(merged.find((entry) => entry.id === 'sprite:a')?.description).toBe('A tagged.');
    expect(merged.find((entry) => entry.id === 'sprite:c')?.description).toBe(
      'C added concurrently.',
    );
  });

  it('drops a changed id that no longer exists in the fresh catalog (concurrent delete)', () => {
    // The run tagged sprite:a, but a concurrent delete removed it from disk.
    // Re-adding it would resurrect a deleted sprite, so it must be dropped.
    const fresh = [rec('sprite:b', 'B original.')];
    const updated = [rec('sprite:a', 'A tagged.'), rec('sprite:b', 'B original.')];

    const merged = mergeChangedCatalogEntries(fresh, updated, ['sprite:a']);

    expect(merged.map((entry) => entry.id)).toEqual(['sprite:b']);
  });

  it('is a no-op passthrough of fresh when nothing changed', () => {
    const fresh = [rec('sprite:a', 'A.'), rec('sprite:b', 'B.')];
    const updated = [rec('sprite:a', 'A stale.'), rec('sprite:b', 'B stale.')];

    const merged = mergeChangedCatalogEntries(fresh, updated, []);

    // With no changedIds, the stale `updated` values must NOT leak in.
    expect(merged.map((entry) => entry.description)).toEqual(['A.', 'B.']);
  });
});
