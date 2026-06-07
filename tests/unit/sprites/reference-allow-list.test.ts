/**
 * Unit tests for the reference allow-list. The module is the single
 * point that converts an LLM-supplied id into a real repo-relative
 * path, so the tests focus on the safety properties (path traversal
 * rejection, missing-file pruning, empty-catalog refusal) rather than
 * the prompt-formatting niceties.
 */

import { describe, expect, it } from 'vitest';
import {
  buildReferenceCatalog,
  formatCatalogForPrompt,
  resolveReferenceId,
} from '../../../scripts/sprites/reference-allow-list.js';

const REPO_ROOT = '/fake/repo';

describe('buildReferenceCatalog', () => {
  it('builds a catalog from the discovered packs and attaches curated notes', () => {
    const catalog = buildReferenceCatalog({
      repoRoot: REPO_ROOT,
      readPacks: () => ['tiny-dungeon', 'roguelike-rpg-pack'],
      fileExists: () => true,
    });
    expect(catalog).toHaveLength(2);
    const ids = catalog.map((c) => c.id).sort();
    expect(ids).toEqual(['roguelike-rpg-pack', 'tiny-dungeon']);
    const dungeon = catalog.find((c) => c.id === 'tiny-dungeon');
    expect(dungeon?.path).toBe('public/assets/kenney/tiny-dungeon/spritesheet.png');
    expect(dungeon?.note).toMatch(/dungeon items/i);
  });

  it('falls back to a generic note for unknown packs (still listed)', () => {
    const catalog = buildReferenceCatalog({
      repoRoot: REPO_ROOT,
      readPacks: () => ['mystery-pack'],
      fileExists: () => true,
    });
    expect(catalog).toHaveLength(1);
    expect(catalog[0]?.id).toBe('mystery-pack');
    expect(catalog[0]?.note).toMatch(/Kenney pack/);
  });

  it('drops entries whose spritesheet.png is missing on disk', () => {
    const catalog = buildReferenceCatalog({
      repoRoot: REPO_ROOT,
      readPacks: () => ['tiny-dungeon', 'tiny-ski'],
      // Pretend ski's spritesheet was deleted but the dir still exists.
      fileExists: (abs: string) => !abs.includes('tiny-ski'),
    });
    expect(catalog.map((c) => c.id)).toEqual(['tiny-dungeon']);
  });

  it('rejects pack ids that contain unsafe characters (path traversal, etc.)', () => {
    const catalog = buildReferenceCatalog({
      repoRoot: REPO_ROOT,
      readPacks: () => ['..', 'foo/bar', 'Tiny-Dungeon', 'tiny-dungeon'],
      fileExists: () => true,
    });
    // Only the lowercase-kebab-case id survives.
    expect(catalog.map((c) => c.id)).toEqual(['tiny-dungeon']);
  });

  it('throws when no packs are discovered', () => {
    expect(() =>
      buildReferenceCatalog({
        repoRoot: REPO_ROOT,
        readPacks: () => [],
        fileExists: () => true,
      }),
    ).toThrow(/Reference catalog is empty/);
  });

  it('throws when every discovered pack is missing its spritesheet', () => {
    expect(() =>
      buildReferenceCatalog({
        repoRoot: REPO_ROOT,
        readPacks: () => ['tiny-dungeon', 'tiny-ski'],
        fileExists: () => false,
      }),
    ).toThrow(/Reference catalog is empty/);
  });
});

describe('resolveReferenceId', () => {
  const catalog = buildReferenceCatalog({
    repoRoot: REPO_ROOT,
    readPacks: () => ['tiny-dungeon', 'roguelike-rpg-pack'],
    fileExists: () => true,
  });

  it('returns the matching entry by id', () => {
    expect(resolveReferenceId(catalog, 'tiny-dungeon').path).toBe(
      'public/assets/kenney/tiny-dungeon/spritesheet.png',
    );
  });

  it('throws with a helpful message listing known ids when the id is unknown', () => {
    let caught: unknown;
    try {
      resolveReferenceId(catalog, 'made-up-pack');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toMatch(/made-up-pack/);
    expect(msg).toMatch(/tiny-dungeon/);
    expect(msg).toMatch(/refuses to invent/);
  });
});

describe('formatCatalogForPrompt', () => {
  it('produces a stable bullet list', () => {
    const catalog = buildReferenceCatalog({
      repoRoot: REPO_ROOT,
      readPacks: () => ['tiny-dungeon', 'tiny-town'],
      fileExists: () => true,
    });
    const formatted = formatCatalogForPrompt(catalog);
    const lines = formatted.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^- tiny-dungeon: /);
    expect(lines[1]).toMatch(/^- tiny-town: /);
  });
});
