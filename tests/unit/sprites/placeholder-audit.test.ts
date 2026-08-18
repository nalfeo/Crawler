import { describe, expect, it } from 'vitest';
import type { ManifestEntry } from '../../../src/shared/generated-assets.js';
import {
  MOB_PLACEHOLDER_SPRITE_ID,
  buildPlaceholderAudit,
  isPlaceholderManifestEntry,
  isPlaceholderSpriteNote,
  normalizeConcept,
  type PlaceholderAuditInput,
} from '../../../scripts/sprites/placeholder-audit.js';

/**
 * Build a fully-valid {@link ManifestEntry}. Defaults describe a REAL (non
 * placeholder) generated asset; override `sourceRun`/`sensorScore`/`assetPath`
 * to make a placeholder. Tests use plain literals only — never the real
 * manifest.
 */
function manifestEntry(
  over: Partial<ManifestEntry> & Pick<ManifestEntry, 'briefId'>,
): ManifestEntry {
  return {
    spriteName: `${over.briefId}-var-0`,
    assetPath: `generated/${over.briefId}/var-0.png`,
    approvedAt: '2026-01-01T00:00:00.000Z',
    sourceRun: 'run-001',
    variantIndex: 0,
    anchor: null,
    sensorScore: 'pass',
    judgeScore: null,
    ...over,
  };
}

function audit(
  over: Partial<PlaceholderAuditInput> = {},
): ReturnType<typeof buildPlaceholderAudit> {
  return buildPlaceholderAudit({
    manifestEntries: {},
    spriteRegistry: [],
    mobDefs: [],
    ...over,
  });
}

describe('normalizeConcept', () => {
  it('strips a -var-N variant suffix', () => {
    expect(normalizeConcept('iron-sword-var-3')).toBe('iron-sword');
  });

  it('strips a -vN version suffix', () => {
    expect(normalizeConcept('iron-sword-v1')).toBe('iron-sword');
  });

  it('strips a -placeholder suffix', () => {
    expect(normalizeConcept('aether-dust-placeholder')).toBe('aether-dust');
  });

  it('strips a -vN then -var-N suffix together so a variant collapses to its concept', () => {
    expect(normalizeConcept('slime-queen-var-0')).toBe('slime-queen');
  });

  it('drops an enemy. dotted prefix and keeps the last segment', () => {
    expect(normalizeConcept('enemy.slime')).toBe('slime');
  });

  it('drops an npc. dotted prefix', () => {
    expect(normalizeConcept('npc.guide')).toBe('guide');
  });

  it('drops an item. dotted prefix before stripping version suffixes', () => {
    expect(normalizeConcept('item.iron-sword-v2')).toBe('iron-sword');
  });

  it('lowercases and trims', () => {
    expect(normalizeConcept('  Slime-Queen  ')).toBe('slime-queen');
  });

  it('combines a dotted prefix with version and variant suffixes', () => {
    expect(normalizeConcept('enemy.slime-king-v2-var-3')).toBe('slime-king');
  });

  it('leaves a bare concept untouched', () => {
    expect(normalizeConcept('slime')).toBe('slime');
  });
});

describe('isPlaceholderManifestEntry', () => {
  it('is true when sourceRun is "placeholder"', () => {
    expect(
      isPlaceholderManifestEntry(manifestEntry({ briefId: 'slime', sourceRun: 'placeholder' })),
    ).toBe(true);
  });

  it('is true when sensorScore is "placeholder"', () => {
    expect(
      isPlaceholderManifestEntry(manifestEntry({ briefId: 'slime', sensorScore: 'placeholder' })),
    ).toBe(true);
  });

  it('is true when the asset path ends in -placeholder.png (case-insensitive)', () => {
    expect(
      isPlaceholderManifestEntry(
        manifestEntry({ briefId: 'slime', assetPath: 'generated/slime/Slime-PLACEHOLDER.png' }),
      ),
    ).toBe(true);
  });

  it('is false for a real generated asset', () => {
    expect(isPlaceholderManifestEntry(manifestEntry({ briefId: 'slime' }))).toBe(false);
  });
});

describe('isPlaceholderSpriteNote', () => {
  it('matches a "temp CC0 art" note with flexible whitespace', () => {
    expect(isPlaceholderSpriteNote('temp  CC0   art')).toBe(true);
  });

  it('matches a note that mentions placeholder', () => {
    expect(isPlaceholderSpriteNote('placeholder frame until real art lands')).toBe(true);
  });

  it('is false for undefined', () => {
    expect(isPlaceholderSpriteNote(undefined)).toBe(false);
  });

  it('is false for an empty string', () => {
    expect(isPlaceholderSpriteNote('')).toBe(false);
  });

  it('is false for a note about real art', () => {
    expect(isPlaceholderSpriteNote('hand-authored final art')).toBe(false);
  });
});

describe('buildPlaceholderAudit — bucketing', () => {
  it('separates replaceable, new-content, and placeholder-only concepts', () => {
    const report = audit({
      manifestEntries: {
        'slime-queen-placeholder': manifestEntry({
          briefId: 'slime-queen',
          sourceRun: 'placeholder',
          assetPath: 'generated/slime-queen/slime-queen-placeholder.png',
        }),
        'slime-queen-var-0': manifestEntry({ briefId: 'slime-queen' }),
        'iron-sword-v1-var-0': manifestEntry({ briefId: 'iron-sword-v1' }),
      },
      spriteRegistry: [{ id: 'enemy.rat', note: 'temp CC0 art' }],
    });

    expect(report.replaceable.map((c) => c.concept)).toEqual(['slime-queen']);
    expect(report.newContent.map((c) => c.concept)).toEqual(['iron-sword']);
    expect(report.placeholderOnly.map((c) => c.concept)).toEqual(['rat']);
    expect(report.counts).toMatchObject({
      concepts: 3,
      replaceable: 1,
      placeholderOnly: 1,
    });
  });

  it('collapses a bare-concept placeholder and a -v1 real asset onto one concept (version asymmetry gap)', () => {
    const report = audit({
      manifestEntries: {
        'slime-king': manifestEntry({
          briefId: 'slime-king',
          sourceRun: 'placeholder',
        }),
        'slime-king-var-0': manifestEntry({ briefId: 'slime-king' }),
      },
    });

    expect(report.concepts).toHaveLength(1);
    const concept = report.concepts[0];
    expect(concept?.concept).toBe('slime-king');
    expect(concept?.placeholders).toHaveLength(1);
    expect(concept?.realAssets).toHaveLength(1);
    expect(report.replaceable.map((c) => c.concept)).toEqual(['slime-king']);
  });

  it('records mob defs on the generic placeholder spriteId and skips real-sprited mobs', () => {
    const report = audit({
      mobDefs: [
        { id: 'goblin', spriteId: MOB_PLACEHOLDER_SPRITE_ID },
        { id: 'dragon', spriteId: 'dragon-sprite' },
      ],
    });

    expect(report.placeholderOnly.map((c) => c.concept)).toEqual(['goblin']);
    const goblin = report.placeholderOnly[0];
    expect(goblin?.placeholders[0]).toMatchObject({ kind: 'mob-def', id: 'goblin' });
  });

  it('records enemy-pack archetypes with no dedicated real generated art as placeholders', () => {
    const report = audit({
      manifestEntries: {
        'goblin-grunt-v1-var-0': manifestEntry({ briefId: 'goblin-grunt-v1' }),
      },
      enemyArchetypeIds: ['goblin-grunt', 'goblin-elite-joyrider'],
    });

    expect(report.newContent.map((c) => c.concept)).toEqual(['goblin-grunt']);
    expect(report.placeholderOnly.map((c) => c.concept)).toEqual(['goblin-elite-joyrider']);
    const elite = report.placeholderOnly[0];
    expect(elite?.placeholders).toEqual([
      { kind: 'enemy-pack', id: 'goblin-elite-joyrider', detail: 'missing-generated-art' },
    ]);
  });
});

describe('buildPlaceholderAudit — --since scoping', () => {
  const input: Partial<PlaceholderAuditInput> = {
    manifestEntries: {
      'slime-king': manifestEntry({ briefId: 'slime-king', sourceRun: 'placeholder' }),
      'slime-king-var-0': manifestEntry({
        briefId: 'slime-king',
        assetPath: 'generated/slime-king/var-0.png',
      }),
      'old-armor-v1-var-0': manifestEntry({
        briefId: 'old-armor-v1',
        assetPath: 'generated/old-armor-v1/var-0.png',
      }),
    },
  };

  it('flags isNew, scopes new-content to new assets, and counts newReplaceable', () => {
    const report = audit({
      ...input,
      newAssetPaths: new Set(['generated/slime-king/var-0.png']),
    });

    expect(report.scopedToNew).toBe(true);
    // slime-king has a placeholder + a NEW real asset -> replaceable & newReplaceable.
    expect(report.replaceable.map((c) => c.concept)).toEqual(['slime-king']);
    const slimeKing = report.replaceable[0];
    expect(slimeKing?.realAssets[0]).toMatchObject({ briefId: 'slime-king', isNew: true });
    // old-armor is real-only but NOT new -> excluded from scoped new-content.
    expect(report.newContent).toHaveLength(0);
    expect(report.counts).toMatchObject({
      newRealAssets: 1,
      newReplaceable: 1,
    });
    // The full concept list still carries the unscoped concept.
    expect(report.concepts.map((c) => c.concept)).toContain('old-armor');
  });

  it('without --since, every real-only concept is new content and isNew stays false', () => {
    const report = audit(input);

    expect(report.scopedToNew).toBe(false);
    expect(report.newContent.map((c) => c.concept)).toEqual(['old-armor']);
    expect(report.replaceable[0]?.realAssets[0]?.isNew).toBe(false);
    expect(report.counts.newReplaceable).toBe(0);
  });
});

describe('buildPlaceholderAudit — related suggestions', () => {
  it('links a placeholder concept to a real concept that shares a hyphen-prefix', () => {
    const report = audit({
      manifestEntries: {
        'slime-queen-var-0': manifestEntry({ briefId: 'slime-queen' }),
      },
      spriteRegistry: [{ id: 'enemy.slime', note: 'temp CC0 art' }],
    });

    expect(report.relatedSuggestions).toHaveLength(1);
    expect(report.relatedSuggestions[0]).toMatchObject({
      placeholderConcept: 'slime',
      realConcept: 'slime-queen',
    });
    // The same-name concept must NOT be a self-suggestion.
    expect(report.relatedSuggestions.every((s) => s.placeholderConcept !== s.realConcept)).toBe(
      true,
    );
  });

  it('does not suggest unrelated names', () => {
    const report = audit({
      manifestEntries: {
        'iron-sword-v1-var-0': manifestEntry({ briefId: 'iron-sword-v1' }),
      },
      spriteRegistry: [{ id: 'enemy.slime', note: 'temp CC0 art' }],
    });

    expect(report.relatedSuggestions).toHaveLength(0);
  });
});

describe('buildPlaceholderAudit — deterministic ordering', () => {
  it('sorts concepts by name and placeholders by kind then id', () => {
    const report = audit({
      manifestEntries: {
        'zebra-placeholder': manifestEntry({ briefId: 'zebra', sourceRun: 'placeholder' }),
        'apple-placeholder': manifestEntry({ briefId: 'apple', sourceRun: 'placeholder' }),
      },
      spriteRegistry: [{ id: 'apple', note: 'temp CC0 art' }],
      mobDefs: [{ id: 'apple', spriteId: MOB_PLACEHOLDER_SPRITE_ID }],
    });

    expect(report.concepts.map((c) => c.concept)).toEqual(['apple', 'zebra']);
    const apple = report.concepts.find((c) => c.concept === 'apple');
    expect(apple?.placeholders.map((p) => p.kind)).toEqual([
      'manifest',
      'mob-def',
      'sprite-registry',
    ]);
  });

  it('sorts real assets within a concept by spriteName', () => {
    const report = audit({
      manifestEntries: {
        'gem-v1-var-1': manifestEntry({ briefId: 'gem-v1', spriteName: 'gem-v1-var-1' }),
        'gem-v1-var-0': manifestEntry({ briefId: 'gem-v1', spriteName: 'gem-v1-var-0' }),
      },
    });

    const gem = report.concepts.find((c) => c.concept === 'gem');
    expect(gem?.realAssets.map((a) => a.spriteName)).toEqual(['gem-v1-var-0', 'gem-v1-var-1']);
  });
});
