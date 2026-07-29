/**
 * Deterministic guard: every `generated` block in `entity-sprite-mappings.json`
 * must resolve against the SHIPPED generated manifest.
 *
 * Why this exists: PR #2296 repointed the player's `generated` block at
 * `player-walk-placeholder-v1` / `player-walk-placeholder-v1-var-0`, but no
 * such manifest shard or PNG was ever committed. `resolveGeneratedTexture`
 * silently returned `null` and the player regressed to the Kenney knight in the
 * real game. Every test in that PR used a synthetic registry, so nothing caught
 * it.
 *
 * This guard reads the real shard directory (the same data the game composes
 * into `manifest.json` at build time) and asserts both resolution keys used by
 * `resolveGeneratedTexture` are live for EVERY render kind — so any future
 * rename, typo, or unshipped-art wiring fails CI instead of silently falling
 * back to placeholder art.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ENTITY_SPRITE_MAPPINGS from '../../src/shared/data/entity-sprite-mappings.json';
import type { EntitySpriteMappings } from '../../src/shared/data/entity-sprite-mappings.js';
import { buildGeneratedSpriteRegistry } from '../../src/shared/generated-assets.js';
import { loadShippedManifest, shippedManifestShardsExist } from '../helpers/generated-manifest.js';

const MAPPINGS = ENTITY_SPRITE_MAPPINGS as EntitySpriteMappings;

const wiredKinds = Object.entries(MAPPINGS.renderKinds).filter(
  ([, kind]) => kind.generated !== undefined,
);

describe('entity-sprite-mappings generated art wiring', () => {
  const manifest = shippedManifestShardsExist() ? loadShippedManifest() : null;
  const registry = manifest !== null ? buildGeneratedSpriteRegistry(manifest) : null;
  const SHIPPED_PUBLIC_ASSETS_DIR = fileURLToPath(new URL('../../public/assets', import.meta.url));

  it.runIf(registry !== null)('wires at least one render kind to generated art', () => {
    expect(wiredKinds.length).toBeGreaterThan(0);
  });

  for (const [kindName, kind] of wiredKinds) {
    const generated = kind.generated;
    if (generated === undefined) continue;

    it.runIf(registry !== null)(
      `${kindName}: briefId "${generated.briefId}" has approved shipped art`,
      () => {
        // `resolveGeneratedTexture` uses briefId both for the registry variant
        // lookup and for its `<briefId>-var-N` texture-key scan.
        expect(registry?.variants(generated.briefId).length ?? 0).toBeGreaterThan(0);
      },
    );

    it.runIf(registry !== null)(
      `${kindName}: pinnedTextureKey "${generated.pinnedTextureKey}" is a shipped manifest key`,
      () => {
        // The pinned key is a manifest ENTRY KEY (= Phaser texture key), which
        // is what `scene.textures.exists()` is gated on at render time.
        const entry = (registry?.entries() ?? []).find(
          (candidate) => candidate.textureKey === generated.pinnedTextureKey,
        );
        expect(entry).toBeDefined();
        const assetPath = entry?.assetPath;
        expect(assetPath).toBeDefined();
        if (assetPath === undefined) return;
        const absoluteAssetPath = path.join(SHIPPED_PUBLIC_ASSETS_DIR, assetPath);
        expect(existsSync(absoluteAssetPath)).toBe(true);

        const declaredHash = manifest?.entries[generated.pinnedTextureKey]?.contentHash;
        if (declaredHash === undefined) return;
        const fileHash = createHash('sha256').update(readFileSync(absoluteAssetPath)).digest('hex');
        expect(fileHash).toBe(declaredHash);
      },
    );
  }

  it.runIf(registry !== null)('keeps the player on the Rhea Vale art, not Kenney', () => {
    // Regression pin for the #2296 revert: the player must resolve to generated
    // Rhea Vale art. A miss here is exactly the bug that shipped the Kenney
    // knight into the running game.
    const player = MAPPINGS.renderKinds.player?.generated;
    expect(player).toBeDefined();
    expect(player?.pinnedTextureKey).toMatch(/^rhea-vale-v1/);
    const entry = (registry?.entries() ?? []).find(
      (candidate) => candidate.textureKey === player?.pinnedTextureKey,
    );
    expect(entry).toBeDefined();
    // The pinned player art is a walk strip: it must carry an animation
    // descriptor, else `preloadGeneratedSprites` loads the 192x64 sheet as a
    // single flat image and the player renders as three squashed copies.
    expect(entry?.animation).toEqual({
      frameWidth: 64,
      frameHeight: 64,
      frameCount: 3,
      frameRate: 8,
      loop: true,
    });
  });
});
