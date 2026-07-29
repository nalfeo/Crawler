import { describe, expect, it } from 'vitest';
import { buildGeneratedSpriteRegistry } from '../../src/shared/generated-assets.js';
import {
  enemyVariantFromTextureId,
  generatedBriefIdForEnemy,
} from '../../src/engine/phaser-bridge/sprite-kind.js';
import { floor1EnemyPack, floor2EnemyPack } from '../../src/shared/enemy-packs.js';
import type { EntitySpriteMappings } from '../../src/shared/data/entity-sprite-mappings.js';
import ENTITY_SPRITE_MAPPINGS from '../../src/shared/data/entity-sprite-mappings.json';
import { loadShippedManifest } from '../helpers/generated-manifest.js';

/**
 * Guard A — Floor-2 enemy art WIRING completeness (data surfaces + all-80
 * manifest resolution).
 *
 * ~43 generated Floor-2 enemy sprites shipped on `main` but rendered as
 * Kenney/rat placeholders because none of the three sprite-resolution surfaces
 * (`entity-sprite-mappings.json`, `GENERATED_BRIEF_BY_TYPE`,
 * `GENERATED_BRIEF_BY_APPEARANCE_KEY`) had Floor-2 entries (rule #10 / ADR 0039
 * violation — inert shipped art). This guard asserts every Floor-2 archetype now
 * resolves to a real generated brief with approved art in the SHIPPED manifest,
 * so a future rename/regression on ANY surface is caught deterministically.
 *
 * It reads the real `public/assets/generated/manifest.json` (the same artifact
 * the game fetches at boot) — so it also fails if art is ever removed for a
 * wired archetype, which is the correct signal.
 *
 * This is the pure-data half of "observe before done"; Guard B
 * (`floor2-boss-render-art.test.ts`) proves the bridge RENDER surface end to end.
 */

const MAPPINGS = ENTITY_SPRITE_MAPPINGS as EntitySpriteMappings;

/** Load the shipped generated manifest into a registry (real art, not a stub). */
function loadShippedRegistry(): ReturnType<typeof buildGeneratedSpriteRegistry> {
  return buildGeneratedSpriteRegistry(loadShippedManifest());
}

describe('Floor 2 enemy art wiring — data surfaces', () => {
  it('registers the enemy_family_boss texture id (5) and its LARGE generated renderKind', () => {
    // Texture-map entry: textureId 5 → enemy_family_boss (drives the auto-built
    // textureIdToVariant map behind enemyVariantFromTextureId).
    expect(MAPPINGS.enemies.enemy_family_boss?.textureId).toBe(5);
    expect(enemyVariantFromTextureId(5)).toBe('enemy_family_boss');

    // RenderKind: MUST carry a `generated` block (else resolveGeneratedTexture
    // returns null and the boss falls back to Kenney/procedural), at LARGE
    // scale 1.0 (~2×2 tiles) — NOT enemy_rat's 0.4. proceduralTexture must be a
    // valid token; mirror the F1 boss kinds' `enemy_boss`.
    const kind = MAPPINGS.renderKinds.enemy_family_boss;
    expect(kind).toBeDefined();
    expect(kind?.proceduralTexture).toBe('enemy_boss');
    expect(kind?.generated).toBeDefined();
    expect(kind?.generated?.scale).toBe(1.0);
    // Pinned fallback values are LIVE (used when the per-boss registry lookup
    // misses) — assert they point at a real shipped boss variant.
    expect(kind?.generated?.briefId).toBe('goblin-boss');
    expect(kind?.generated?.pinnedTextureKey).toBe('goblin-boss-var-0');
  });

  it('resolves the pinned boss fallback (goblin-boss-var-0) in the shipped manifest', () => {
    const registry = loadShippedRegistry();
    const kind = MAPPINGS.renderKinds.enemy_family_boss;
    const pinned = kind?.generated?.pinnedTextureKey;
    expect(pinned).toBeDefined();
    // The pinned key must be an actual approved variant of the pinned brief.
    const variants = registry.variants(kind!.generated!.briefId);
    expect(variants.some((v) => v.textureKey === pinned)).toBe(true);
  });
});

describe('Floor 2 enemy art wiring — all archetypes resolve to shipped art', () => {
  const registry = loadShippedRegistry();

  it('every Floor-2 archetype resolves to a real generated brief with >=1 approved variant', () => {
    const unresolved: string[] = [];
    for (const archetype of floor2EnemyPack.archetypes) {
      const visualType = enemyVariantFromTextureId(archetype.spriteTexture);
      // Grunts/cave-ambient AND bosses both resolve by appearanceKey === id
      // (bosses via spawnFamilyBoss's setEnemyAppearanceKey; grunts via the
      // director's setEnemyAppearanceKey). Mirror the bridge's resolution.
      const briefId = generatedBriefIdForEnemy(visualType, archetype.id);
      if (briefId === undefined || registry.variants(briefId).length === 0) {
        unresolved.push(`${archetype.id} (tex ${archetype.spriteTexture} → ${visualType})`);
      }
    }
    expect(unresolved).toEqual([]);
  });

  it('covers the full 80-archetype Floor-2 roster (18 bosses + 54 family mobs + 8 neutral)', () => {
    const bosses = floor2EnemyPack.archetypes.filter((a) => a.isBoss === true);
    expect(floor2EnemyPack.archetypes.length).toBe(80);
    expect(bosses.length).toBe(18);
    // All 18 bosses must now carry the dedicated enemy_family_boss texture id.
    expect(bosses.every((a) => a.spriteTexture === 5)).toBe(true);
    // Non-bosses remain in the ambient texture lanes (rat-slot 1, cave-slime at 2).
    const nonBoss = floor2EnemyPack.archetypes.filter((a) => a.isBoss !== true);
    expect(nonBoss.every((a) => a.spriteTexture === 1 || a.id === 'cave-slime')).toBe(true);
  });
});

describe('Floor 1 enemy art wiring — regression net (already wired)', () => {
  const registry = loadShippedRegistry();

  it('every Floor-1 pack archetype still resolves to shipped generated art', () => {
    const unresolved: string[] = [];
    for (const archetype of floor1EnemyPack.archetypes) {
      const visualType = enemyVariantFromTextureId(archetype.spriteTexture);
      const briefId = generatedBriefIdForEnemy(visualType, archetype.id);
      if (briefId === undefined || registry.variants(briefId).length === 0) {
        unresolved.push(`${archetype.id} (tex ${archetype.spriteTexture} → ${visualType})`);
      }
    }
    expect(unresolved).toEqual([]);
  });
});
