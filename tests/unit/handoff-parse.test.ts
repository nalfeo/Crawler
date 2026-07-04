import { describe, expect, it } from 'vitest';
import {
  extractRetrospectiveSubsections,
  findRetrospectiveSubsection,
  isProseLine,
  proseLinesOf,
  subsectionIsEmpty,
} from '../../scripts/agent/docs/handoff-parse.js';

describe('isProseLine', () => {
  it('accepts substantive prose', () => {
    expect(isProseLine('Ran npm ci before verify to fix ENOENT.')).toBe(true);
    expect(isProseLine('- Windows Git Bash is slow; batch commands.')).toBe(true);
  });

  it('rejects blanks and markdown decoration', () => {
    expect(isProseLine('')).toBe(false);
    expect(isProseLine('   ')).toBe(false);
    expect(isProseLine('---')).toBe(false);
    expect(isProseLine('***')).toBe(false);
  });

  it('rejects single-token placeholders, with or without a bullet or punctuation', () => {
    for (const placeholder of ['None', 'n/a', 'N/A', 'TBD', 'todo', '-', '—', 'nothing', '???']) {
      expect(isProseLine(placeholder)).toBe(false);
      expect(isProseLine(`- ${placeholder}`)).toBe(false);
      expect(isProseLine(`${placeholder}.`)).toBe(false);
    }
  });
});

const RETRO_HANDOFF = [
  '# Handoff',
  '',
  '## Summary',
  '',
  'Did some work.',
  '',
  '## Retrospective',
  '',
  '### Lessons Learned',
  '',
  '- Reuse the shared parser.',
  '',
  '### Mistakes Made',
  '',
  '- Forgot to run npm ci first.',
  '',
  '### Opportunities for Future Improvement',
  '',
  'None',
  '',
  '## Next Steps',
  '',
  '- Ship it.',
].join('\n');

describe('extractRetrospectiveSubsections', () => {
  it('returns [] for a handoff with no ## Retrospective section', () => {
    const md = '# Handoff\n\n## Summary\n\n### Mistakes Made\n\n- oops\n';
    expect(extractRetrospectiveSubsections(md)).toEqual([]);
  });

  it('extracts each ### subsection under ## Retrospective and stops at the next ## heading', () => {
    const subs = extractRetrospectiveSubsections(RETRO_HANDOFF);
    expect(subs.map((s) => s.title)).toEqual([
      'Lessons Learned',
      'Mistakes Made',
      'Opportunities for Future Improvement',
    ]);
    // The trailing `## Next Steps` content must not bleed into the last subsection.
    const opportunities = subs[2]!;
    expect(opportunities.lines.join('\n')).not.toContain('Ship it');
  });
});

describe('subsectionIsEmpty / proseLinesOf', () => {
  it('treats placeholder-only and comment-only subsections as empty', () => {
    const subs = extractRetrospectiveSubsections(RETRO_HANDOFF);
    const byTitle = new Map(subs.map((s) => [s.title, s]));
    expect(subsectionIsEmpty(byTitle.get('Opportunities for Future Improvement')!)).toBe(true);
    expect(subsectionIsEmpty(byTitle.get('Lessons Learned')!)).toBe(false);
  });

  it('strips bullets and html comments from prose lines', () => {
    const md = [
      '## Retrospective',
      '### Mistakes Made',
      '<!-- an instructional comment -->',
      '- Forgot the flush step.',
    ].join('\n');
    const sub = findRetrospectiveSubsection(md, 'Mistakes Made')!;
    expect(proseLinesOf(sub)).toEqual(['- Forgot the flush step.']);
  });
});

describe('findRetrospectiveSubsection scoping', () => {
  it('finds a subsection that lives under ## Retrospective', () => {
    const sub = findRetrospectiveSubsection(RETRO_HANDOFF, 'Mistakes Made');
    expect(sub).not.toBeNull();
    expect(proseLinesOf(sub!)).toEqual(['- Forgot to run npm ci first.']);
  });

  it('does NOT match a "### Mistakes Made" heading outside the retrospective block', () => {
    // Regression guard: promote-mistakes previously scanned the whole document,
    // so an unrelated "### Mistakes Made" (e.g. quoted in a Summary) was promoted.
    const md = [
      '# Handoff',
      '',
      '## Summary',
      '',
      '### Mistakes Made',
      '',
      '- This is narrative, not a retrospective entry.',
    ].join('\n');
    expect(findRetrospectiveSubsection(md, 'Mistakes Made')).toBeNull();
  });

  it('is case-insensitive on the subsection title', () => {
    const sub = findRetrospectiveSubsection(RETRO_HANDOFF, 'mistakes made');
    expect(sub?.title).toBe('Mistakes Made');
  });
});
