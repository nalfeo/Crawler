import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OUTPUT_BUDGET,
  renderHandoffResults,
  retrieveHandoffs,
} from '../../../scripts/agent/docs/handoff-retrieval.mjs';

const index = `# Handoff system-impact index

## ai-pathfinding

- [2026-09-03-path-fix](2026-09-03-path-fix.md) — Fixed deterministic route selection.
- [2026-09-01-route-cache](2026-09-01-route-cache.md) — Cached routes for navigation.

## ci-policy

- [2026-09-04-tooling](2026-09-04-tooling.md) — Added a navigation telemetry check.
`;

const contents = new Map([
  [
    'docs/knowledge/handoffs/2026-09-03-path-fix.md',
    'Route selection now uses deterministic tie-breaking.',
  ],
  ['docs/knowledge/handoffs/2026-09-01-route-cache.md', 'Navigation cache avoids repeat searches.'],
  ['docs/knowledge/handoffs/2026-09-04-tooling.md', 'Telemetry records narrow lookup usage.'],
]);

describe('handoff retrieval', () => {
  it('ranks an exact system above a newer topic-only match', () => {
    const results = retrieveHandoffs(index, 'ai-pathfinding', contents);
    expect(results.map((result) => result.path)).toEqual([
      'docs/knowledge/handoffs/2026-09-03-path-fix.md',
      'docs/knowledge/handoffs/2026-09-01-route-cache.md',
    ]);
    expect(results[0]?.excerpt).toContain('deterministic tie-breaking');
  });

  it('matches topics and ranks deterministic ties newest first', () => {
    const results = retrieveHandoffs(index, 'navigation', contents);
    expect(results.map((result) => result.path)).toEqual([
      'docs/knowledge/handoffs/2026-09-04-tooling.md',
      'docs/knowledge/handoffs/2026-09-01-route-cache.md',
    ]);
  });

  it('caps rendered output at the strict default budget without partial entries', () => {
    const results = retrieveHandoffs(index, 'ai-pathfinding', contents).map((result) => ({
      ...result,
      excerpt: 'x'.repeat(500),
    }));
    const output = renderHandoffResults('ai-pathfinding', results, DEFAULT_OUTPUT_BUDGET + 500);
    expect(output.length).toBeLessThanOrEqual(DEFAULT_OUTPUT_BUDGET);
    expect(output).toContain('2026-09-03-path-fix.md');
  });

  it('caps even a header when a caller requests a very small budget', () => {
    const output = renderHandoffResults(
      'ai-pathfinding',
      retrieveHandoffs(index, 'ai-pathfinding', contents),
      20,
    );
    expect(output.length).toBeLessThanOrEqual(20);
  });

  it('reports no match with a narrow fallback search', () => {
    const output = renderHandoffResults(
      'unlisted subsystem',
      retrieveHandoffs(index, 'unlisted subsystem', contents),
    );
    expect(output).toContain('No relevant handoff found');
    expect(output).toContain("rg -n -i --glob '*.md'");
  });
});
