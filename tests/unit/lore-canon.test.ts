import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HANDOFFS_DIR, decideHandoff } from '../../scripts/agent/docs/archive-handoffs';
import { fromRepo } from '../../scripts/agent/shared/report';
import { loreCitedPaths, validateLoreCanon } from '../../scripts/agent/docs/check-lore-canon';

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

  it('rejects a demoted heading that only substring-matches the required H2', () => {
    const result = validateLoreCanon(
      '### The Director\n**Sources:** [x](x.md)',
      'There are currently no unresolved records.',
    );

    expect(result.missingSections).toContain('## The Director');
  });

  it('does not treat the fenced record template example as an unresolved record', () => {
    const result = validateLoreCanon(
      '## Canon maintenance contract\n## Official source register',
      [
        'Copy this block for every conflict:',
        '',
        '```text',
        '### [short contradiction id]',
        'Status: unresolved',
        '```',
        '',
        'There are currently no unresolved contradiction records.',
      ].join('\n'),
    );

    expect(result.unresolvedContradictions).toBe(false);
  });

  it('still rejects an unresolved record copied out of the fence', () => {
    const result = validateLoreCanon(
      '## Canon maintenance contract\n## Official source register',
      [
        '```text',
        '### [short contradiction id]',
        'Status: unresolved',
        '```',
        '',
        '### real-conflict',
        'Status: unresolved',
      ].join('\n'),
    );

    expect(result.unresolvedContradictions).toBe(true);
  });
});

describe('lore citation pinning', () => {
  it('resolves cited handoff paths relative to the repository root', () => {
    const cited = loreCitedPaths(
      '**Sources:** [handoff](../handoffs/2026-07-24-example.md), [gdd](game-design-document.md)',
    );

    expect(cited).toContain('docs/knowledge/handoffs/2026-07-24-example.md');
    expect(cited).toContain('docs/knowledge/game-design/game-design-document.md');
  });

  it('keeps the real Lore Bible citations inside the live handoffs directory', () => {
    const cited = loreCitedPaths().filter((source) =>
      source.startsWith('docs/knowledge/handoffs/'),
    );

    expect(cited.length).toBeGreaterThan(0);
    for (const source of cited) {
      expect(existsSync(fromRepo(source))).toBe(true);
      expect(source.startsWith('docs/knowledge/handoffs/archive/')).toBe(false);
    }
  });

  it('archives an aged handoff but pins one the Lore Bible cites', () => {
    const today = new Date('2026-08-31T00:00:00Z');
    const cited = 'docs/knowledge/handoffs/2026-07-24-floor2-environmental-content.md';
    const pinned = new Set([cited]);

    expect(decideHandoff('2026-07-24-floor2-environmental-content.md', today, pinned)).toEqual({
      kind: 'pinned',
      age: 38,
    });
    expect(decideHandoff('2026-07-24-some-other-session.md', today, pinned)).toEqual({
      kind: 'archive',
      age: 38,
    });
    expect(decideHandoff('2026-08-20-recent-session.md', today, pinned)).toEqual({
      kind: 'fresh',
      age: 11,
    });
    expect(decideHandoff('INDEX.md', today, pinned)).toEqual({ kind: 'unnamed' });
  });

  it('pins every real Lore Bible handoff citation against the real archiver policy', () => {
    const pinned = new Set(loreCitedPaths());
    const cited = [...pinned].filter((source) => source.startsWith(`${HANDOFFS_DIR}/`));
    const farFuture = new Date('2099-01-01T00:00:00Z');

    expect(cited.length).toBeGreaterThan(0);
    for (const source of cited) {
      const entry = source.slice(`${HANDOFFS_DIR}/`.length);
      expect(decideHandoff(entry, farFuture, pinned).kind).toBe('pinned');
    }
  });
});
