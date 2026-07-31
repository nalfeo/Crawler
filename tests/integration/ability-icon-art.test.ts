/**
 * Headless observation of the REAL ability-icon render path (rule #10).
 *
 * Mirrors the inventory-ui-item-art.test.ts pattern: drives the production
 * `getAbilityIconEntry` function — the exact `ability-icon.ts` branch shipped
 * to players — against the REAL shipped `public/assets/generated/manifest.json`
 * and records which texture each ability icon resolves to.
 *
 * POSITIVE: with the real registry, Fireball, Heal, and Pulse Shield each
 * resolve to a real generated entry (not null) from the expected briefId
 * lineage, and the entry's textureKey is treated as loaded.
 * NEGATIVE CONTROL: with an empty registry, getAbilityIconEntry returns null
 * for every ability — proving the harness exercises the real resolution branch
 * rather than unconditionally succeeding.
 */

import { describe, expect, it } from 'vitest';
import {
  fetchGeneratedSpriteRegistry,
  GENERATED_SPRITE_REGISTRY_KEY,
} from '../../src/engine/generatedAssets/index.js';
import {
  emptyGeneratedSpriteRegistry,
  type GeneratedSpriteRegistry,
} from '../../src/shared/generated-assets.js';
import { getAbilityIconEntry } from '../../src/engine/ability-icon.js';
import {
  loadShippedManifestRaw,
  shippedManifestShardsExist,
} from '../helpers/generated-manifest.js';

/** The three abilities with approved icon brief IDs in ability-presentation.ts. */
const ICON_EXPECTATIONS: ReadonlyArray<{ abilityId: string; briefIdLineage: string }> = [
  { abilityId: 'fireball', briefIdLineage: 'ability-icon-fireball-v1' },
  { abilityId: 'heal', briefIdLineage: 'ability-icon-heal-v1' },
  { abilityId: 'pulse-shield', briefIdLineage: 'ability-icon-pulse-shield-v1' },
];

/**
 * Build a minimal Phaser.Scene stand-in that:
 * - exposes the given registry via `game.registry.get`
 * - models `textures.exists(key)` as "key is a loaded generated texture"
 *   (matching the real preloadGeneratedSprites behaviour)
 */
function makeRecordingScene(registry: GeneratedSpriteRegistry): unknown {
  const loadedTextures = new Set(registry.entries().map((e) => e.textureKey));
  return {
    game: {
      registry: {
        get: (key: string) => (key === GENERATED_SPRITE_REGISTRY_KEY ? registry : undefined),
      },
    },
    textures: { exists: (key: string) => loadedTextures.has(key) },
  };
}

async function loadRealShippedRegistry(): Promise<GeneratedSpriteRegistry> {
  const raw = loadShippedManifestRaw();
  const fetcher = (async () =>
    new Response(raw, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
  return fetchGeneratedSpriteRegistry({ url: '/assets/generated/manifest.json', fetcher });
}

describe('ability-icon real render path over the shipped manifest (observe-before-done)', () => {
  it('resolves Fireball, Heal, and Pulse Shield to real generated entries', async () => {
    if (!shippedManifestShardsExist()) {
      // Fresh checkout with no generated art on disk — nothing to observe.
      return;
    }
    const registry = await loadRealShippedRegistry();
    const scene = makeRecordingScene(registry);

    for (const { abilityId, briefIdLineage } of ICON_EXPECTATIONS) {
      const entry = getAbilityIconEntry(scene as never, abilityId);
      expect(entry, `getAbilityIconEntry returned null for "${abilityId}"`).not.toBeNull();
      expect(entry!.briefId, `"${abilityId}" resolved to wrong briefId`).toBe(briefIdLineage);
      // The resolved textureKey must be among the loaded textures (as in game).
      expect(
        registry.entries().some((e) => e.textureKey === entry!.textureKey),
        `textureKey "${entry!.textureKey}" not found in registry entries`,
      ).toBe(true);
    }
  });

  it('negative control: empty registry returns null for every ability icon', () => {
    const scene = makeRecordingScene(emptyGeneratedSpriteRegistry());

    for (const { abilityId } of ICON_EXPECTATIONS) {
      const entry = getAbilityIconEntry(scene as never, abilityId);
      expect(entry, `expected null for "${abilityId}" with empty registry`).toBeNull();
    }
  });

  it('returns null when the registry is missing (no registry key set)', () => {
    // Simulates a scene where the boot preloader never ran.
    const sceneWithNoRegistry = {
      game: { registry: { get: () => undefined } },
      textures: { exists: () => false },
    };
    for (const { abilityId } of ICON_EXPECTATIONS) {
      const entry = getAbilityIconEntry(sceneWithNoRegistry as never, abilityId);
      expect(entry, `expected null for "${abilityId}" with no registry`).toBeNull();
    }
  });

  it('returns null when the texture is not loaded even if the registry has the entry', async () => {
    if (!shippedManifestShardsExist()) {
      return;
    }
    const registry = await loadRealShippedRegistry();
    // Scene with registry present but textures.exists always false (nothing preloaded).
    const scene = {
      game: {
        registry: {
          get: (key: string) => (key === GENERATED_SPRITE_REGISTRY_KEY ? registry : undefined),
        },
      },
      textures: { exists: () => false },
    };
    for (const { abilityId } of ICON_EXPECTATIONS) {
      const entry = getAbilityIconEntry(scene as never, abilityId);
      expect(entry, `expected null for "${abilityId}" when texture not loaded`).toBeNull();
    }
  });
});
