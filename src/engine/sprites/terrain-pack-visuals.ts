/**
 * Static terrain-pack preload registry (reviewed-design refinement #1).
 *
 * Every image asset referenced by every registered terrain pack (wall atlas
 * spritesheet + floor/corridor pool variants + door PNGs) is derived straight
 * from the parsed, Zod-validated pack manifests in
 * `src/shared/terrain-pack-registry.ts` — there is no second hand-authored
 * asset list to drift out of sync with the manifests. `preloadTerrainPacks`
 * queues ALL of them at boot, so switching onto a pack-using floor (e.g.
 * Floor 2's `industrial-cave`) never hits a missing-texture transition miss.
 *
 * Kept separate from `generatedAssets/preload.ts` because terrain packs are a
 * STATIC registry (every shipped pack asset is known at build time, sourced
 * from bundled JSON manifests) rather than a runtime-fetched dynamic
 * manifest — no network fetch is needed to discover what to queue.
 */
import { getAllRuntimeTerrainPackIds, getTerrainPack } from '../../shared/terrain-pack-registry.js';
import { resolvePublicAssetUrl } from '../generatedAssets/preload.js';
import { createLogger } from '../../shared/logger.js';

const logger = createLogger('engine:terrain-pack-visuals');

/** One entry in the static terrain-pack preload registry. */
export type TerrainPackPreloadEntry =
  | {
      readonly kind: 'wall-atlas' | 'ground-decals' | 'linework';
      readonly textureKey: string;
      readonly path: string;
      readonly frameWidth: number;
      readonly frameHeight: number;
    }
  | {
      readonly kind: 'pool' | 'door';
      readonly textureKey: string;
      readonly path: string;
    };

/** Minimum subset of `Phaser.Loader.LoaderPlugin` needed to queue these assets. */
export interface TerrainPackLoaderLike {
  image(key: string, url: string): unknown;
  spritesheet(
    key: string,
    url: string,
    config: { frameWidth: number; frameHeight: number },
  ): unknown;
}

/**
 * Walk every registered terrain pack and list every image asset it ships:
 * the wall autotile spritesheet, every floor/corridor pool variant, and all
 * four door textures. Pure — no Phaser, no I/O — so it is trivially
 * unit-testable and reusable by both BootScene and tests.
 */
export function collectTerrainPackPreloadEntries(): readonly TerrainPackPreloadEntry[] {
  const entries: TerrainPackPreloadEntry[] = [];
  for (const id of getAllRuntimeTerrainPackIds()) {
    const pack = getTerrainPack(id);
    entries.push({
      kind: 'wall-atlas',
      textureKey: pack.wallAutotile.textureKey,
      path: pack.wallAutotile.imagePath,
      frameWidth: pack.wallAutotile.cellPx,
      frameHeight: pack.wallAutotile.cellPx,
    });
    // Wall-accent atlases share the wall atlas's grid/cellPx (2026-07-25
    // refinement #3), so they preload as spritesheets too — same 'wall-atlas'
    // preload kind, keyed by their own textureKey/imagePath.
    for (const accent of pack.wallAccents ?? []) {
      entries.push({
        kind: 'wall-atlas',
        textureKey: accent.textureKey,
        path: accent.imagePath,
        frameWidth: pack.wallAutotile.cellPx,
        frameHeight: pack.wallAutotile.cellPx,
      });
    }
    for (const decalSet of pack.groundDecals ?? []) {
      // Its own kind, not 'wall-atlas': it is a spritesheet like the wall
      // atlases but its frames are sized by the DECAL cell, not the wall
      // cellPx, so conflating the two would make "wall-atlas frames use the
      // pack's wall cellPx" silently untrue.
      entries.push({
        kind: 'ground-decals',
        textureKey: decalSet.textureKey,
        path: decalSet.imagePath,
        frameWidth: decalSet.cellPx,
        frameHeight: decalSet.cellPx,
      });
    }
    // Linework atlases (2-edge Wang path tiles) and their prop sheets. Both are
    // spritesheets, but each declares its own cellPx: the Wang atlas is pinned to
    // the pack cell so a frame can never overhang its own tile, while props are a
    // separate sheet that may be sized independently.
    for (const layer of pack.linework ?? []) {
      entries.push({
        kind: 'linework',
        textureKey: layer.textureKey,
        path: layer.imagePath,
        frameWidth: layer.cellPx,
        frameHeight: layer.cellPx,
      });
      if (!layer.props) continue;
      entries.push({
        kind: 'linework',
        textureKey: layer.props.textureKey,
        path: layer.props.imagePath,
        frameWidth: layer.props.cellPx,
        frameHeight: layer.props.cellPx,
      });
    }
    for (const variant of [
      ...pack.floorPool,
      ...pack.corridorPool,
      ...Object.values(pack.specialFloorPools ?? {}).flat(),
    ]) {
      entries.push({ kind: 'pool', textureKey: variant.textureKey, path: variant.imagePath });
    }
  }
  return entries;
}

/**
 * Queue every terrain-pack asset onto a Phaser loader. Returns the queued
 * entries (post de-duplication) so BootScene/tests can introspect what was
 * requested — mirrors `preloadGeneratedSprites`'s return-list pattern.
 */
export function preloadTerrainPacks(
  loader: TerrainPackLoaderLike,
): readonly TerrainPackPreloadEntry[] {
  const entries = collectTerrainPackPreloadEntries();
  const seen = new Set<string>();
  const queued: TerrainPackPreloadEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.textureKey)) {
      logger.warn('Duplicate terrain-pack texture key; skipping later entry', {
        textureKey: entry.textureKey,
      });
      continue;
    }
    seen.add(entry.textureKey);
    const url = resolvePublicAssetUrl(entry.path);
    if (
      entry.kind === 'wall-atlas' ||
      entry.kind === 'ground-decals' ||
      entry.kind === 'linework'
    ) {
      loader.spritesheet(entry.textureKey, url, {
        frameWidth: entry.frameWidth,
        frameHeight: entry.frameHeight,
      });
    } else {
      loader.image(entry.textureKey, url);
    }
    queued.push(entry);
  }
  logger.info('Queued terrain-pack asset loads', { count: queued.length });
  return queued;
}
