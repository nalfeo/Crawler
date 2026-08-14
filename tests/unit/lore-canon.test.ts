import { describe, expect, it } from 'vitest';
import { validateLoreCanon } from '../../scripts/agent/docs/check-lore-canon';

describe('lore canon validation', () => {
  it('requires the canonical sections and rejects unresolved escalation records', () => {
    const result = validateLoreCanon(
      '## Canon maintenance contract\n## Official source register\n## The Gradient',
      '### conflict\nStatus: unresolved',
    );

    expect(result.missingSections).toContain('## The Director');
    expect(result.unresolvedContradictions).toBe(true);
  });

  it('accepts a fully structured canon without unresolved records', () => {
    const sections = [
      '## Canon maintenance contract',
      '## Official source register',
      ...[
        'The Gradient',
        'The Director',
        'The Dungeon',
        'Season Quirks (Procedural Personality Modifiers)',
        'Sponsor Companies (Procedural)',
        'Timeline',
        'Tone Guide',
      ].map(
        (section) =>
          `## ${section}\n**Sources:** [game-design-document.md](game-design-document.md)`,
      ),
    ].join('\n');

    expect(validateLoreCanon(sections, 'There are currently no unresolved records.')).toEqual({
      missingSections: [],
      missingSources: [],
      missingSourceDeclarations: [],
      unresolvedContradictions: false,
    });
  });

  it('requires source declarations for every canon group', () => {
    const result = validateLoreCanon(
      '## Canon maintenance contract\n## Official source register\n## The Gradient',
      'There are currently no unresolved records.',
    );

    expect(result.missingSourceDeclarations).toContain('## The Gradient');
  });
});
