/**
 * Headless observation of achievement-icon wiring over the shipped generated manifest.
 *
 * Validates the runtime path used by AchievementsUI (`getAchievementIconEntry`)
 * without requiring a Phaser renderer.
 */

import { describe, expect, it } from 'vitest';
import { fetchGeneratedSpriteRegistry } from '../../src/engine/generatedAssets/index.js';
import { getAchievementIconEntry } from '../../src/engine/achievement-icon.js';
import { ALL_ACHIEVEMENTS } from '../../src/shared/achievements.js';
import {
  loadShippedManifestRaw,
  shippedManifestShardsExist,
} from '../helpers/generated-manifest.js';

function toAchievementIconId(iconId: string): string {
  return iconId.endsWith('-placeholder') ? iconId.slice(0, -'-placeholder'.length) : iconId;
}

async function loadRealShippedRegistry() {
  const raw = loadShippedManifestRaw();
  const fetcher = (async () =>
    new Response(raw, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
  return fetchGeneratedSpriteRegistry({ url: '/assets/generated/manifest.json', fetcher });
}

describe('achievement-icon real render path over shipped manifest', () => {
  it('resolves generated achievement icons by canonical icon texture key when present', async () => {
    if (!shippedManifestShardsExist()) return;
    const registry = await loadRealShippedRegistry();
    const loadedTextures = new Set(registry.entries().map((e) => e.textureKey));
    const scene = {
      game: { registry: { get: () => registry } },
      textures: { exists: (key: string) => loadedTextures.has(key) },
    };

    const withGeneratedIcon = ALL_ACHIEVEMENTS.filter((achievement) =>
      loadedTextures.has(toAchievementIconId(achievement.iconId)),
    );
    if (withGeneratedIcon.length === 0) return;

    for (const achievement of withGeneratedIcon.slice(0, 20)) {
      const expectedTextureKey = toAchievementIconId(achievement.iconId);
      const entry = getAchievementIconEntry(scene as never, achievement);
      expect(entry, `expected generated entry for achievement "${achievement.id}"`).not.toBeNull();
      expect(entry!.textureKey).toBe(expectedTextureKey);
    }
  });

  it('gracefully returns null when the generated texture is not loaded', async () => {
    if (!shippedManifestShardsExist()) return;
    const registry = await loadRealShippedRegistry();
    const scene = {
      game: { registry: { get: () => registry } },
      textures: { exists: () => false },
    };
    const anyAchievement = ALL_ACHIEVEMENTS[0];
    expect(anyAchievement).toBeDefined();
    const entry = getAchievementIconEntry(scene as never, anyAchievement!);
    expect(entry).toBeNull();
  });
});
