import { describe, expect, it } from 'vitest';
import {
  extractRetrospectiveSubsections,
  findRetrospectiveSubsection,
  hasRetrospectiveSection,
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

// Same handoff as RETRO_HANDOFF but with a lowercase `## retrospective` heading.
const LOWERCASE_RETRO_HANDOFF = RETRO_HANDOFF.replace('## Retrospective', '## retrospective');

describe('hasRetrospectiveSection (shared case-insensitive predicate)', () => {
  it('detects the canonical "## Retrospective" heading', () => {
    expect(hasRetrospectiveSection(RETRO_HANDOFF)).toBe(true);
  });

  it('detects a lowercase "## retrospective" heading', () => {
    // Regression guard: the lint gate's grandfather skip once used a
    // case-SENSITIVE regex, so a lowercase heading was skipped (subsection
    // checks bypassed) while the parser matched it case-insensitively.
    expect(hasRetrospectiveSection(LOWERCASE_RETRO_HANDOFF)).toBe(true);
    // ...and the parser must extract the same subsections it does for the
    // canonical casing, proving both call sites act on the lowercase heading.
    expect(extractRetrospectiveSubsections(LOWERCASE_RETRO_HANDOFF).map((s) => s.title)).toEqual([
      'Lessons Learned',
      'Mistakes Made',
      'Opportunities for Future Improvement',
    ]);
  });

  it('returns false when there is no retrospective heading', () => {
    expect(hasRetrospectiveSection('# Handoff\n\n## Summary\n\nDid some work.\n')).toBe(false);
    // A `### retrospective` (h3, not the section heading) must not count.
    expect(hasRetrospectiveSection('# Handoff\n\n### Retrospective notes\n')).toBe(false);
  });

  it('stays in lock-step with the parser across headings that do and do not exist', () => {
    // The lint gate skips a handoff iff !hasRetrospectiveSection(content); the
    // parser returns [] iff the section is absent. They must ALWAYS agree — the
    // PR #745 mismatch let the lint skip a lowercase-heading file the parser
    // still scanned. Detection is per-line with one shared regex, so agreement
    // holds even when a heading's marker and title are split across lines
    // (which a whole-document `\s+` match would wrongly treat as present).
    const splitHeading = '## \nRetrospective\n\n### Lessons Learned\n\n- x\n';
    const noHeading = '# Handoff\n\n## Summary\n\nNo retrospective here.\n';
    for (const [label, md, present] of [
      ['canonical', RETRO_HANDOFF, true],
      ['lowercase', LOWERCASE_RETRO_HANDOFF, true],
      ['none', noHeading, false],
      ['split across lines', splitHeading, false],
    ] as const) {
      const has = hasRetrospectiveSection(md);
      expect(has, label).toBe(extractRetrospectiveSubsections(md).length > 0);
      expect(has, label).toBe(present);
    }
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
