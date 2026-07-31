import { describe, expect, it } from 'vitest';

import {
  frontmatterDescription,
  globParentDir,
  headingSet,
  looksLikePath,
  nextFenceState,
  referencedAgents,
  referencedPersonas,
  resolveLinkTarget,
  routingMatrixPairs,
  routingMatrixRows,
  sectionBody,
  tableRows,
} from '../../../scripts/agent/docs/doc-refs-lib.js';

describe('looksLikePath', () => {
  it('accepts repo-rooted paths and globs', () => {
    expect(looksLikePath('docs/agent-os/personas/README.md')).toBe(true);
    expect(looksLikePath('src/game/ai/**')).toBe(true);
    expect(looksLikePath('.github/agents/reviewer.agent.md')).toBe(true);
  });

  it('rejects prose, commands, and template placeholders', () => {
    expect(looksLikePath('npm run verify:fast')).toBe(false);
    expect(looksLikePath('package.json')).toBe(false);
    expect(looksLikePath('docs/knowledge/handoffs/YYYY-MM-DD-slug.md')).toBe(false);
    expect(looksLikePath('docs/knowledge/handoffs/<slug>.md')).toBe(false);
    expect(looksLikePath('https://example.com/a.md')).toBe(false);
  });
});

describe('globParentDir', () => {
  it('returns the path unchanged when there is no wildcard', () => {
    expect(globParentDir('src/core/world.ts')).toBe('src/core/world.ts');
  });

  it('cuts to the deepest real directory, not the wildcard offset', () => {
    // Regression: `src/shared/data/quests.*.json` used to resolve to the
    // non-existent `src/shared/data/quests.` and fail a valid reference.
    expect(globParentDir('src/shared/data/quests.*.json')).toBe('src/shared/data');
    expect(globParentDir('src/engine/Hud*.ts')).toBe('src/engine');
    expect(globParentDir('src/game/**/*.ts')).toBe('src/game');
    expect(globParentDir('docs/agent-os/personas/*')).toBe('docs/agent-os/personas');
  });

  it('returns null when the glob constrains no directory', () => {
    expect(globParentDir('*.ts')).toBeNull();
    expect(globParentDir('/*')).toBeNull();
  });
});

describe('resolveLinkTarget', () => {
  it('resolves relative targets against the linking document directory', () => {
    expect(
      resolveLinkTarget('docs/agent-os/personas/README.md', '../policies/complexity-policy.md'),
    ).toBe('docs/agent-os/policies/complexity-policy.md');
    expect(
      resolveLinkTarget('docs/agent-os/personas/README.md', '../../../.github/agents/x.agent.md'),
    ).toBe('.github/agents/x.agent.md');
    expect(resolveLinkTarget('.github/agents/producer.agent.md', './reviewer.agent.md')).toBe(
      '.github/agents/reviewer.agent.md',
    );
  });

  it('strips anchors but keeps the file path', () => {
    expect(resolveLinkTarget('docs/a/b.md', './c.md#section-name')).toBe('docs/a/c.md');
  });

  it('ignores non-file targets', () => {
    expect(resolveLinkTarget('docs/a/b.md', '#anchor-only')).toBeNull();
    expect(resolveLinkTarget('docs/a/b.md', 'https://example.com')).toBeNull();
    expect(resolveLinkTarget('docs/a/b.md', 'mailto:x@y.z')).toBeNull();
    expect(resolveLinkTarget('docs/a/b.md', './<slug>.md')).toBeNull();
  });

  it('refuses targets that escape the repo root', () => {
    expect(resolveLinkTarget('docs/a/b.md', '../../../outside.md')).toBeNull();
  });
});

describe('headingSet and sectionBody', () => {
  const doc = [
    '# Title',
    '',
    '## Agent',
    '',
    'See `x.agent.md`.',
    '',
    '## Skills',
    '',
    '- one',
    '',
  ].join('\n');

  it('collects level-2 headings only', () => {
    expect([...headingSet(doc)]).toEqual(['Agent', 'Skills']);
  });

  it('extracts a section body up to the next heading', () => {
    expect(sectionBody(doc, 'Agent')).toContain('x.agent.md');
    expect(sectionBody(doc, 'Agent')).not.toContain('one');
    expect(sectionBody(doc, 'Skills')).toContain('- one');
  });

  it('returns null for a missing section', () => {
    expect(sectionBody(doc, 'Constraints')).toBeNull();
  });

  it('does not treat a section name as a regular expression', () => {
    expect(sectionBody(doc, 'A.ent')).toBeNull();
  });

  it('ignores level-2 headings that appear inside fenced code blocks', () => {
    const fenced = [
      '## Responsibilities',
      '',
      '```md',
      '## Agent',
      '```',
      '',
      '## Agent',
      '',
      'real content',
    ].join('\n');
    expect([...headingSet(fenced)]).toEqual(['Responsibilities', 'Agent']);
    expect(sectionBody(fenced, 'Responsibilities')).toContain('```md');
    expect(sectionBody(fenced, 'Responsibilities')).toContain('## Agent');
    expect(sectionBody(fenced, 'Responsibilities')).not.toContain('real content');
  });
});

describe('referencedAgents', () => {
  it('returns distinct agent filenames in order of appearance', () => {
    const text = [
      'Primary: [`reviewer`](../../../.github/agents/reviewer.agent.md).',
      'Sibling: `.github/agents/ci-review-validator.agent.md`.',
      'Again: reviewer.agent.md',
    ].join('\n');
    expect(referencedAgents(text)).toEqual(['reviewer.agent.md', 'ci-review-validator.agent.md']);
  });

  it('returns an empty list when no agent is named', () => {
    expect(referencedAgents('No agents here, just `docs/x.md`.')).toEqual([]);
  });

  it('requires a real .md boundary so near-miss filenames are not matched', () => {
    expect(referencedAgents('reviewer.agent.mdx')).toEqual([]);
    expect(referencedAgents('reviewer.agent.md.bak')).toEqual([]);
    expect(referencedAgents('(reviewer.agent.md)')).toEqual(['reviewer.agent.md']);
  });
});

describe('referencedPersonas', () => {
  it('finds persona docs in both link targets and backticked paths', () => {
    const text = [
      'Adopt the [Reviewer persona](../../docs/agent-os/personas/reviewer.md).',
      'See also `docs/agent-os/personas/qa-engineer.md`.',
    ].join('\n');
    expect(referencedPersonas(text)).toEqual(['reviewer.md', 'qa-engineer.md']);
  });

  it('ignores the README index and de-duplicates', () => {
    const text =
      'docs/agent-os/personas/README.md and docs/agent-os/personas/reviewer.md twice: docs/agent-os/personas/reviewer.md';
    expect(referencedPersonas(text)).toEqual(['reviewer.md']);
  });

  it('does not match persona-looking paths outside the personas directory', () => {
    expect(referencedPersonas('docs/agent-os/policies/reviewer.md')).toEqual([]);
  });

  it('requires a real .md boundary so near-miss filenames do not satisfy a backlink', () => {
    expect(referencedPersonas('docs/agent-os/personas/reviewer.mdx')).toEqual([]);
    expect(referencedPersonas('docs/agent-os/personas/reviewer.md.bak')).toEqual([]);
    expect(referencedPersonas('(docs/agent-os/personas/reviewer.md)')).toEqual(['reviewer.md']);
  });
});

describe('nextFenceState', () => {
  it('opens and closes on matching markers', () => {
    expect(nextFenceState(null, '```')).toBe('```');
    expect(nextFenceState('```', '```')).toBeNull();
    expect(nextFenceState(null, '~~~')).toBe('~~~');
    expect(nextFenceState('~~~', '~~~')).toBeNull();
  });

  it('keeps an info string on the opening fence', () => {
    expect(nextFenceState(null, '```ts')).toBe('```');
    expect(nextFenceState('```', '```ts')).toBe('```');
  });

  it('does not close a ~~~ fence on a ``` line, or vice versa', () => {
    expect(nextFenceState('~~~', '```')).toBe('~~~');
    expect(nextFenceState('```', '~~~')).toBe('```');
  });

  it('requires the closing run to be at least as long as the opening run', () => {
    expect(nextFenceState('````', '```')).toBe('````');
    expect(nextFenceState('```', '````')).toBeNull();
  });

  it('leaves non-fence lines unchanged', () => {
    expect(nextFenceState(null, 'see `docs/x.md`')).toBeNull();
    expect(nextFenceState('```', 'inside the block')).toBe('```');
  });

  it('keeps a nested ``` inside a ~~~ block from resuming validation', () => {
    const lines = ['~~~', 'text', '```', '`missing/path.md`', '~~~', 'real line'];
    let fence: string | null = null;
    const checked: string[] = [];
    for (const line of lines) {
      const wasInFence = fence !== null;
      fence = nextFenceState(fence, line);
      if (wasInFence || fence !== null) continue;
      checked.push(line);
    }
    expect(checked).toEqual(['real line']);
  });
});

describe('frontmatterDescription', () => {
  it('reads a quoted description from leading frontmatter', () => {
    const text = "---\nname: Reviewer\ndescription: 'Reviews diffs.'\n---\n\n## Role\n";
    expect(frontmatterDescription(text)).toBe('Reviews diffs.');
  });

  it('reads an unquoted description', () => {
    expect(frontmatterDescription('---\ndescription: Reviews diffs.\n---\n')).toBe(
      'Reviews diffs.',
    );
  });

  it('returns null when frontmatter is missing, unterminated, or empty', () => {
    expect(frontmatterDescription('## Role\n')).toBeNull();
    expect(frontmatterDescription('---\ndescription: x\n')).toBeNull();
    expect(frontmatterDescription('---\nname: X\n---\n')).toBeNull();
    expect(frontmatterDescription("---\ndescription: ''\n---\n")).toBeNull();
  });

  it('returns null for non-string, empty-block, or invalid YAML description values', () => {
    expect(frontmatterDescription('---\ndescription: null\n---\n')).toBeNull();
    expect(frontmatterDescription('---\ndescription: >\n---\n')).toBeNull();
    expect(frontmatterDescription("---\ndescription: 'unterminated\n---\n")).toBeNull();
  });

  it('ignores a description that appears only in the body', () => {
    expect(frontmatterDescription('---\nname: X\n---\n\ndescription: nope\n')).toBeNull();
  });

  it('parses CRLF frontmatter (a lone trailing \\r breaks the YAML parser)', () => {
    const crlf =
      "---\r\nname: Reviewer\r\ndescription: 'Reviews diffs.'\r\ntools: ['read']\r\n---\r\n\r\nBody\r\n";
    expect(frontmatterDescription(crlf)).toBe('Reviews diffs.');
  });
});

describe('tableRows', () => {
  const table = [
    '| Task | Persona | Agent |',
    '| ---- | ------- | ----- |',
    '| Core ECS | **Systems Engineer** | `systems-engineer` |',
    '| Tests | **QA Engineer** | `qa-engineer` |',
  ].join('\n');

  it('returns data rows without the header or separator', () => {
    expect(tableRows(table)).toEqual([
      ['Core ECS', '**Systems Engineer**', '`systems-engineer`'],
      ['Tests', '**QA Engineer**', '`qa-engineer`'],
    ]);
  });

  it('tolerates CRLF and alignment separators', () => {
    const aligned = '| A | B |\r\n| :--- | ---: |\r\n| x | y |\r\n';
    expect(tableRows(aligned)).toEqual([['x', 'y']]);
  });

  it('stops at the first blank line after the table starts', () => {
    expect(tableRows(`${table}\n\n| Later | Table |\n| --- | --- |\n| a | b |`)).toHaveLength(2);
  });

  it('returns an empty array when no table is present', () => {
    expect(tableRows('Just prose.\n\nMore prose.')).toEqual([]);
  });
});

describe('routingMatrixPairs', () => {
  it('maps the bolded persona to the first backticked agent slug', () => {
    const text = [
      '| If your task is mostly… | Adopt persona | Agent | Primary paths |',
      '| --- | --- | --- | --- |',
      '| Core ECS | **Systems Engineer** | `systems-engineer` | `src/core/**` |',
      '| Sprites | **Graphics Designer** | `asset-forge` | `briefs/**` |',
    ].join('\n');
    expect(routingMatrixPairs(text)).toEqual(
      new Map([
        ['Systems Engineer', 'systems-engineer'],
        ['Graphics Designer', 'asset-forge'],
      ]),
    );
  });

  it('ignores backticked cells that precede the persona cell', () => {
    const text = [
      '| Paths | Persona | Agent |',
      '| --- | --- | --- |',
      '| `src/core/**` | **Systems Engineer** | `systems-engineer` |',
    ].join('\n');
    expect(routingMatrixPairs(text).get('Systems Engineer')).toBe('systems-engineer');
  });

  it('skips rows missing a persona or an agent', () => {
    const text = [
      '| Persona | Agent |',
      '| --- | --- |',
      '| **Producer** | _(none)_ |',
      '| plain text | `reviewer` |',
    ].join('\n');
    expect(routingMatrixPairs(text).size).toBe(0);
  });

  it('keeps duplicate persona rows visible via routingMatrixRows', () => {
    const text = [
      '| Persona | Agent |',
      '| --- | --- |',
      '| **Systems Engineer** | `wrong-agent` |',
      '| **Systems Engineer** | `systems-engineer` |',
    ].join('\n');
    // The Map view dedupes (last row wins), which would hide the stale row —
    // callers detecting drift must use the row list.
    expect(routingMatrixPairs(text).size).toBe(1);
    expect(routingMatrixRows(text)).toEqual([
      { persona: 'Systems Engineer', agent: 'wrong-agent' },
      { persona: 'Systems Engineer', agent: 'systems-engineer' },
    ]);
  });
});
