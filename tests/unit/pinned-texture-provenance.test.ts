/**
 * Pinned-texture-key provenance guard.
 *
 * A pinned `textureKey` / `floorSpriteId` names an EXACT manifest entry, so it
 * silently changes meaning whenever a migration renumbers variant indices. The
 * bare-concept taxonomy migration (ADR 0086) did exactly that: the codemod that
 * repointed references stripped the lineage tag but PRESERVED the `-var-N`
 * index, so `tile-stone-floor-v2-var-2` became `tile-stone-floor-var-2` — which
 * after collision renumbering is the ORIGINAL v1 art, the one that shipped a
 * magenta chroma-key matte and tiled a hot-pink lattice across every stone room.
 * The key still resolved, the guard still passed, and the floor of the entire
 * game quietly regressed to the defect a purpose-built replacement had fixed.
 *
 * `check:tile-mattes` could not catch it: that guard scans PNGs for a baked
 * matte, and the offending PNG was already known/tolerated — the bug was not a
 * bad pixel, it was a reference pointing at the wrong art.
 *
 * This test pins the *content*, not just the existence, of the small set of
 * exact keys that shipped surfaces depend on. It fails if a future rename,
 * renumber, or re-approval repoints one of them at different pixels.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { TILE_SPRITES } from '../../src/engine/sprites/tile-visuals.js';
import { TerrainType } from '../../src/shared/map-types.js';
import substrate from '../../src/shared/data/set-piece-substrate.json' with { type: 'json' };

const ENTRIES_DIR = path.resolve('public/assets/generated/entries');

interface ShardEntry {
  readonly briefId: string;
  readonly assetPath: string;
  readonly contentHash?: string;
  readonly sourceRun?: string;
}

function loadEntry(key: string): ShardEntry | undefined {
  const file = path.join(ENTRIES_DIR, `${key}.json`);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8')) as ShardEntry;
}

describe('pinned texture-key provenance', () => {
  it('STONE_FLOOR is pinned to the cool-grey replacement, NOT the magenta-matte original', () => {
    const pinned = TILE_SPRITES[TerrainType.STONE_FLOOR]?.textureKey;
    expect(pinned).toBe('tile-stone-floor-var-0');

    const entry = loadEntry(pinned!);
    expect(entry, `pinned key "${pinned}" has no manifest entry`).toBeDefined();
    // The replacement came from the 2026-07-26 regeneration run; the original
    // magenta-matte art is the 2026-07-07 run. Asserting the run makes a
    // repoint-to-old-art fail loudly instead of silently rendering the defect.
    expect(entry!.sourceRun).toContain('2026-07-26');
  });

  it('the set-piece substrate floor matches the terrain renderer pin exactly', () => {
    // These two must agree, or a set piece renders a different floor than the
    // dungeon around it.
    const pinned = TILE_SPRITES[TerrainType.STONE_FLOOR]?.textureKey;
    expect((substrate as { default: { floorSpriteId: string } }).default.floorSpriteId).toBe(
      pinned,
    );
  });

  it('every pinned tile textureKey resolves to a real manifest entry', () => {
    for (const [terrain, def] of Object.entries(TILE_SPRITES)) {
      const key = def?.textureKey;
      if (key === undefined) continue;
      expect(loadEntry(key), `terrain ${terrain} pins missing key "${key}"`).toBeDefined();
    }
  });

  it('no pinned tile textureKey carries a generation-lineage tag (ADR 0086)', () => {
    for (const [terrain, def] of Object.entries(TILE_SPRITES)) {
      const key = def?.textureKey;
      if (key === undefined) continue;
      expect(/-v\d+(-var-\d+)?$/.test(key), `terrain ${terrain} pins versioned "${key}"`).toBe(
        false,
      );
    }
  });
});
