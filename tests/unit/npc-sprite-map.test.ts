/**
 * Pins the NPC def -> generated sprite map against art that actually exists.
 *
 * WHY THIS EXISTS. The map was duplicated: `sprite-kind.ts` held one copy and the
 * Set Piece Editor extension held another. The Goon and Merchant were regenerated
 * to `-v3-` variants and the game copy was repointed; the editor copy was not. So
 * the editor kept drawing the retired npc-prefixed Goon and Merchant variants
 * — art that had already been replaced — and every screenshot taken from the
 * editor showed the wrong characters while looking entirely plausible.
 *
 * There is now one JSON source imported by the game and served to the editor, so
 * they cannot disagree. These tests cover the failure the duplication caused AND
 * the failure that would survive de-duplication: a single map that points at a
 * sprite nobody ever approved. A dangling pointer silently falls back to the
 * shared Kenney villager at runtime, which reads as "that NPC has no art yet"
 * rather than as a bug.
 */
import { describe, expect, it } from 'vitest';
import npcSpriteMap from '../../src/shared/data/npc-sprite-map.json' with { type: 'json' };
import { isRuntimeEligibleManifestEntry } from '../../src/shared/generated-assets.js';
import { loadShippedManifest } from '../helpers/generated-manifest.js';
import {
  GENERATED_KEY_BY_NPC_DEF,
  pickGeneratedNpcTextureKey,
} from '../../src/engine/phaser-bridge/sprite-kind.js';

describe('NPC generated-sprite map', () => {
  const entries = Object.entries(npcSpriteMap.byNpcDefId);

  it('is non-empty and is what the game actually resolves', () => {
    expect(entries.length).toBeGreaterThan(0);
    expect(GENERATED_KEY_BY_NPC_DEF).toEqual(npcSpriteMap.byNpcDefId);
    for (const [defId, key] of entries) {
      expect(pickGeneratedNpcTextureKey(defId)).toBe(key);
    }
  });

  it('points every NPC at a sprite that is actually approved and shipped', () => {
    // A stale pointer does not throw - the renderer silently falls back to the
    // shared Kenney villager, which looks like "no art yet" instead of a bug.
    const manifest = loadShippedManifest();
    const dangling = entries.filter(([, key]) => {
      const entry = manifest.entries[key];
      return entry === undefined || !isRuntimeEligibleManifestEntry(entry);
    });
    expect(dangling).toEqual([]);
  });

  it('resolves to null for an unknown def id rather than guessing', () => {
    expect(pickGeneratedNpcTextureKey('definitely-not-an-npc')).toBeNull();
    expect(pickGeneratedNpcTextureKey(undefined)).toBeNull();
  });
});
