/**
 * Deterministic backstop for mob on-screen size.
 *
 * Mobs used to be sized by a raw pixel multiplier (`generated.scale`) tuned
 * against 64×64 art. When the sprite pipeline's enemy canvas default grew to
 * 256×256 — and to 512×512 for `sizeVariant: large` bosses — nothing tied the
 * renderer to that change, so every mob resolved through the multiplier drew
 * 4–8× oversized (a Floor 2 family boss reached ~60 ft tall) with no failing
 * check anywhere.
 *
 * Mob size is now authored in world FEET (`generated.heightFt`) and fitted to
 * each variant's `opaqueBounds`, which makes canvas growth a non-event. These
 * guards keep it that way:
 *
 *  1. every enemy render kind with generated art declares a `heightFt` inside a
 *     sane band — so a new kind cannot quietly reintroduce pixel-multiplier
 *     sizing;
 *  2. every approved enemy variant's implied drawn footprint stays inside a
 *     feet band — the height is authoritative, so this really guards the OTHER
 *     axis: art whose aspect ratio would make it absurdly wide/narrow on screen
 *     is a data problem that must be seen, not silently squashed.
 *
 * These read the shipped manifest shards and the shipped wiring, so they fail
 * on regenerated art as well as on edited wiring.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import ENTITY_SPRITE_MAPPINGS from '../../src/shared/data/entity-sprite-mappings.json';
import type { EntitySpriteMappings } from '../../src/shared/data/entity-sprite-mappings.js';

const MAPPINGS = ENTITY_SPRITE_MAPPINGS as EntitySpriteMappings;

/** A mob may not be shorter than a crouching critter nor taller than a bus. */
const MIN_MOB_HEIGHT_FT = 1;
const MAX_MOB_HEIGHT_FT = 12;

/**
 * Widest / narrowest a mob may draw once its height is fitted to the authored
 * feet. The measured spread today is ≈1.5 ft (a tall goose gunner) to ≈11.6 ft
 * (a gnome on a car, authored wide on purpose), so this band admits every
 * approved variant while still catching an order-of-magnitude aspect error.
 */
const MIN_MOB_WIDTH_FT = 1;
const MAX_MOB_WIDTH_FT = 14;

/**
 * Height used to evaluate rule (2). Manifest entries do not record a mob role,
 * so every enemy variant is measured against the standard mook footprint —
 * which is also the render kind (`enemy_rat` / `enemy_slime`) that every Floor 2
 * mook and elite actually resolves through at runtime.
 */
const MOOK_HEIGHT_FT = MAPPINGS.renderKinds.enemy_rat?.generated?.heightFt ?? 0;

const ENTRIES_DIR = path.resolve(
  import.meta.dirname,
  '../../public/assets/generated/entries',
);

interface ManifestShard {
  readonly spriteName?: string;
  readonly type?: string;
  readonly opaqueBounds?: {
    readonly width: number;
    readonly height: number;
    readonly canvasWidth: number;
    readonly canvasHeight: number;
  };
}

function enemyShards(): ReadonlyArray<{ name: string; shard: ManifestShard }> {
  return readdirSync(ENTRIES_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => ({
      name: file.replace(/\.json$/, ''),
      shard: JSON.parse(readFileSync(path.join(ENTRIES_DIR, file), 'utf8')) as ManifestShard,
    }))
    .filter(({ shard }) => shard.type === 'enemy');
}

/** Render kinds whose generated art is a mob (i.e. must be sized in feet). */
function generatedEnemyKinds(): ReadonlyArray<[string, { heightFt?: number }]> {
  return Object.entries(MAPPINGS.renderKinds)
    .filter(([kind, config]) => kind.startsWith('enemy') && config.generated !== undefined)
    .map(([kind, config]) => [kind, config.generated!] as [string, { heightFt?: number }]);
}

describe('mob footprint guard', () => {
  it('sizes every generated enemy render kind in world feet', () => {
    const kinds = generatedEnemyKinds();
    expect(kinds.length, 'no generated enemy render kinds found').toBeGreaterThan(0);

    const missing = kinds
      .filter(([, generated]) => typeof generated.heightFt !== 'number')
      .map(([kind]) => kind);
    expect(
      missing,
      `these enemy render kinds still size themselves by the raw pixel multiplier: ${missing.join(
        ', ',
      )}. Add a 'generated.heightFt' (drawn height of the visible art, in feet).`,
    ).toEqual([]);
  });

  it('keeps every authored mob height inside a sane band', () => {
    for (const [kind, generated] of generatedEnemyKinds()) {
      const heightFt = generated.heightFt as number;
      expect(heightFt, `${kind} heightFt too small`).toBeGreaterThanOrEqual(MIN_MOB_HEIGHT_FT);
      expect(heightFt, `${kind} heightFt too large`).toBeLessThanOrEqual(MAX_MOB_HEIGHT_FT);
    }
  });

  it('gives every approved enemy variant opaque bounds to be measured against', () => {
    const shards = enemyShards();
    expect(shards.length, 'no approved enemy variants found').toBeGreaterThan(0);

    for (const { name, shard } of shards) {
      const bounds = shard.opaqueBounds;
      expect(bounds, `${name} has no opaqueBounds; its drawn size cannot be derived`).toBeDefined();
      expect(bounds!.width, `${name} has empty opaque bounds`).toBeGreaterThan(0);
      expect(bounds!.height, `${name} has empty opaque bounds`).toBeGreaterThan(0);
      expect(
        bounds!.width,
        `${name} opaque bounds are wider than its canvas`,
      ).toBeLessThanOrEqual(bounds!.canvasWidth);
      expect(
        bounds!.height,
        `${name} opaque bounds are taller than its canvas`,
      ).toBeLessThanOrEqual(bounds!.canvasHeight);
    }
  });

  it('keeps every approved enemy variant inside the drawn-footprint band', () => {
    expect(MOOK_HEIGHT_FT, 'enemy_rat must author a heightFt').toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const { name, shard } of enemyShards()) {
      const bounds = shard.opaqueBounds;
      if (bounds === undefined || bounds.height <= 0) {
        continue;
      }
      // Height is authoritative, so the drawn height is MOOK_HEIGHT_FT by
      // construction and the art's own aspect decides the width.
      const widthFt = (MOOK_HEIGHT_FT * bounds.width) / bounds.height;
      if (widthFt < MIN_MOB_WIDTH_FT || widthFt > MAX_MOB_WIDTH_FT) {
        offenders.push(`${name} → ${widthFt.toFixed(2)} ft wide at ${MOOK_HEIGHT_FT} ft tall`);
      }
    }

    expect(
      offenders,
      `these approved enemy variants would draw outside [${MIN_MOB_WIDTH_FT}, ${MAX_MOB_WIDTH_FT}] ft wide:\n${offenders.join(
        '\n',
      )}`,
    ).toEqual([]);
  });
});
