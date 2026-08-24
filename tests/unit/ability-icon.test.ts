import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Phaser from 'phaser';
import { hashStringToSeed } from '../../src/shared/random.js';
import type { AbilityPresentation } from '../../src/shared/ability-presentation.js';
import type { GeneratedSpriteEntry } from '../../src/shared/generated-assets.js';

const resolveGeneratedIconEntry = vi.fn();
const getAbilityPresentation = vi.fn<(id: string) => AbilityPresentation | undefined>();

vi.mock('../../src/engine/generated-icon-resolver.js', () => ({
  resolveGeneratedIconEntry: (...args: unknown[]) => resolveGeneratedIconEntry(...args),
}));
vi.mock('../../src/shared/ability-presentation.js', () => ({
  getAbilityPresentation: (id: string) => getAbilityPresentation(id),
}));

const { getAbilityIconEntry } = await import('../../src/engine/ability-icon.js');

describe('getAbilityIconEntry', () => {
  const scene = {} as Phaser.Scene;
  const stubEntry = { textureKey: 'stub' } as GeneratedSpriteEntry;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the ability-icon-<id> canonical id plus the presentation briefId when present', () => {
    getAbilityPresentation.mockReturnValueOnce({
      iconBriefId: 'ability-icon-battle-focus',
    } as AbilityPresentation);
    resolveGeneratedIconEntry.mockReturnValueOnce(stubEntry);

    const result = getAbilityIconEntry(scene, 'battle-focus');

    expect(result).toBe(stubEntry);
    expect(resolveGeneratedIconEntry).toHaveBeenCalledWith(scene, {
      briefIds: ['ability-icon-battle-focus', 'ability-icon-battle-focus'],
      textureKeys: ['ability-icon-battle-focus', 'ability-icon-battle-focus'],
      seed: hashStringToSeed('battle-focus'),
    });
  });

  it('de-versions a -vN suffixed briefId into an extra fallback candidate', () => {
    getAbilityPresentation.mockReturnValueOnce({
      iconBriefId: 'ability-icon-veteran-instinct-v2',
    } as AbilityPresentation);
    resolveGeneratedIconEntry.mockReturnValueOnce(stubEntry);

    getAbilityIconEntry(scene, 'veteran-instinct');

    expect(resolveGeneratedIconEntry).toHaveBeenCalledWith(scene, {
      briefIds: [
        'ability-icon-veteran-instinct-v2',
        'ability-icon-veteran-instinct',
        'ability-icon-veteran-instinct',
      ],
      textureKeys: ['ability-icon-veteran-instinct', 'ability-icon-veteran-instinct-v2'],
      seed: hashStringToSeed('veteran-instinct'),
    });
  });

  it('falls back to only the canonical id when there is no presentation entry', () => {
    getAbilityPresentation.mockReturnValueOnce(undefined);
    resolveGeneratedIconEntry.mockReturnValueOnce(null);

    const result = getAbilityIconEntry(scene, 'unknown-ability');

    expect(result).toBeNull();
    expect(resolveGeneratedIconEntry).toHaveBeenCalledWith(scene, {
      briefIds: ['ability-icon-unknown-ability'],
      textureKeys: ['ability-icon-unknown-ability'],
      seed: hashStringToSeed('unknown-ability'),
    });
  });
});
