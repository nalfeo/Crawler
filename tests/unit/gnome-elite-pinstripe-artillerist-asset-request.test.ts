import { describe, expect, it } from 'vitest';
import { generatedBriefIdForEnemy } from '../../src/engine/phaser-bridge/sprite-kind.js';
import { buildGeneratedSpriteRegistry } from '../../src/shared/generated-assets.js';
import { loadShippedManifest } from '../helpers/generated-manifest.js';

const BRIEF_ID = 'gnome-elite-pinstripe-artillerist';

describe('gnome-elite-pinstripe-artillerist asset request', () => {
  it('maps the appearance key to the dedicated generated brief id', () => {
    expect(generatedBriefIdForEnemy('enemy_rat', BRIEF_ID)).toBe(BRIEF_ID);
  });

  it('ships an approved generated variant for the dedicated brief id', () => {
    const registry = buildGeneratedSpriteRegistry(loadShippedManifest());
    const variants = registry.variants(BRIEF_ID);
    expect(variants.length).toBeGreaterThan(0);
    expect(variants.some((entry) => entry.textureKey === 'gnome-elite-pinstripe-artillerist-var-0')).toBe(
      true,
    );
  });
});
