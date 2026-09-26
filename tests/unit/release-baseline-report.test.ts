import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function loadPage() {
  class Node {
    textContent = '';
    children: Array<Node | string> = [];
    parentElement?: Node;
    append(...nodes: Array<Node | string>) {
      for (const node of nodes) {
        if (typeof node !== 'string') node.parentElement = this;
        this.children.push(node);
      }
    }
  }
  const report = new Node();
  const source = readFileSync(path.join(REPO_ROOT, 'public/release-baseline-report.html'), 'utf8');
  const script = source.split('<script>')[1]!.split('</script>')[0]!;
  const context = {
    document: {
      getElementById: (id: string) => (id === 'report' ? report : new Node()),
      createElement: () => new Node(),
    },
    window: { location: { search: '?commit=aaaaaaa&repo=owner/repo' } },
    URLSearchParams,
    api: {} as {
      sameFunCohort: (a: unknown, b: unknown) => boolean;
      render: (...args: unknown[]) => void;
    },
  };
  runInNewContext(
    script.slice(0, script.indexOf('        load().catch')) +
      'globalThis.api = { sameFunCohort, render }; })();',
    context,
  );
  const flatten = (node: Node | string): string =>
    typeof node === 'string' ? node : [node.textContent, ...node.children.map(flatten)].join(' ');
  return { ...context.api, text: () => flatten(report) };
}

function diagnostic(identities = ['seed1', 'seed2']) {
  return {
    schema_version: 2,
    runs: identities.length,
    overall_fun_score: 75,
    per_run: identities.map((identity) => ({ source: 'headless', identity })),
    observed_surveys: { enjoyment: { responses: 0, mean: null } },
  };
}

describe('release baseline Pages report', () => {
  it('compares only matching independent v2 headless identities', () => {
    const { sameFunCohort } = loadPage();
    expect(sameFunCohort(diagnostic(), diagnostic(['seed2', 'seed1']))).toBe(true);
    expect(sameFunCohort(diagnostic(), { ...diagnostic(), schema_version: 1 })).toBe(false);
    expect(sameFunCohort(diagnostic(), diagnostic(['seed3', 'seed4']))).toBe(false);
    expect(sameFunCohort(diagnostic(['seed1', 'seed1']), diagnostic(['seed1', 'seed1']))).toBe(
      false,
    );
    expect(
      sameFunCohort(diagnostic(), {
        ...diagnostic(),
        per_run: [
          { source: 'human', identity: 'seed1' },
          { source: 'headless', identity: null },
        ],
      }),
    ).toBe(false);
  });

  it('renders null diagnostics as unmeasured and retains legacy interpretation', () => {
    const baseline = { winRate: 1, totalWins: 2, totalRuns: 2 };
    const page = loadPage();
    page.render(
      baseline,
      null,
      { report: { ...diagnostic(), overall_fun_score: null } },
      null,
      null,
    );
    expect(page.text()).toContain('Heuristic diagnostic unmeasured');
    expect(page.text()).toContain('Human enjoyment unmeasured');
    expect(page.text()).not.toContain('Unavailable for this release');
    const legacy = loadPage();
    legacy.render(
      baseline,
      baseline,
      { report: { runs: 2, overall_fun_score: 75 } },
      { report: diagnostic() },
      null,
    );
    expect(legacy.text()).toContain('Legacy uncalibrated heuristic');
    expect(legacy.text()).toContain('Comparison inconclusive');
    expect(legacy.text()).not.toContain('Δ');
  });

  it('shows direct enjoyment separately from the heuristic', () => {
    const page = loadPage();
    page.render(
      { winRate: 1, totalRuns: 2 },
      null,
      { report: { ...diagnostic(), observed_surveys: { enjoyment: { responses: 3, mean: 4.5 } } } },
      null,
      null,
    );
    expect(page.text()).toContain('Human enjoyment 4.5 / 5 (3 responses)');
  });

  it('loads the requested baselines-branch data without injecting query or report content as HTML', () => {
    const report = readFileSync(
      path.join(REPO_ROOT, 'public/release-baseline-report.html'),
      'utf8',
    );

    expect(report).toContain('<title>Crawler release baseline report</title>');
    expect(report).toContain('raw.githubusercontent.com');
    expect(report).toContain('by-sha/${encodeURIComponent(commit)}.json');
    expect(report).toContain('by-sha/${encodeURIComponent(commit)}.fun-report.json');
    expect(report).toContain("fetchJson(rawUrl('index.json'), false)");
    expect(report).toContain('function sortBaselines(index)');
    expect(report).toContain('function sameLegCohort(current, previous)');
    expect(report).toContain('sameFunCohort(currentFun, previousFun)');
    expect(report).toContain("typeof current.legs[legId].totalRuns === 'number'");
    expect(report).toContain('const history = sortBaselines(index)');
    expect(report).toContain('COMMIT_PATTERN');
    expect(report).toContain('REPO_PATTERN');
    expect(report).toContain('textContent = value');
    expect(report).not.toContain('innerHTML');
  });
});
