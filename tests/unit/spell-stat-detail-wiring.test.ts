import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Guards the cross-layer wiring that puts a spell's real damage/range numbers on
 * every surface where the player picks or inspects a spell. The formatting
 * itself is covered by `spell-effect-summary.test.ts`; this protects the
 * integration points, because `src/engine/` cannot import the game-layer
 * ability catalog and must receive the summary through scene options — a
 * regression there would silently restore prose-only spell copy.
 */
describe('spell stat detail wiring', () => {
  it('MainGameScene reads the summary through an injected game-layer callback', () => {
    const source = readFileSync('src/engine/scenes/MainGameScene.ts', 'utf-8');
    expect(source).toContain(
      'getAbilityEffectSummary?: (world: GameWorld, abilityId: string) => string | undefined;',
    );
    expect(source).toContain('private describeAbilityStats(abilityId: string): string | undefined');
    expect(source).toContain('this.options.getAbilityEffectSummary?.(this.world, abilityId)');
    // Engine must never reach into the game layer directly for this.
    expect(source).not.toContain("from '../../game/abilities/");
  });

  it('MainGameScene shows the stat line in the Spell Broker stock and abilities descriptions', () => {
    const source = readFileSync('src/engine/scenes/MainGameScene.ts', 'utf-8');
    expect(source).toContain(
      "detail: this.describeAbilityStats(offer.spellId) ?? 'A permanent spell for this run.',",
    );
    expect(source).toContain('const effectSummary = this.describeAbilityStats(abilityId);');
    expect(source).toContain(
      'description: effectSummary ? `${description}\\n${effectSummary}` : description,',
    );
  });

  it('the floor bootstrap supplies the summary from the ability registry', () => {
    const source = readFileSync('src/bootstrap/floor-main-scene-options.ts', 'utf-8');
    expect(source).toContain(
      "import { getAbilityEffectSummary } from '../game/abilities/effect-summary.js';",
    );
    expect(source).toMatch(
      /getAbilityEffectSummary: \(world: GameWorld, abilityId: string\) =>\s*getAbilityEffectSummary\(abilityId, world\.floorMap\?\.config\.tileSizeFt\)/,
    );
  });
});
