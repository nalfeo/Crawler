import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('release baseline Pages report', () => {
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
    expect(report).toContain('const history = sortBaselines(index)');
    expect(report).toContain('COMMIT_PATTERN');
    expect(report).toContain('REPO_PATTERN');
    expect(report).toContain('textContent = value');
    expect(report).not.toContain('innerHTML');
  });
});
