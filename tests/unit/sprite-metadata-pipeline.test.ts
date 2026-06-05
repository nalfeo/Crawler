import { describe, expect, it } from 'vitest';
import {
  createHeuristicProvider,
  runMetadataPipeline,
  type MetadataProvider,
} from '../../scripts/sprites/metadata-pipeline.js';
import { parseSpriteCatalog } from '../../src/shared/sprite-catalog.js';

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
