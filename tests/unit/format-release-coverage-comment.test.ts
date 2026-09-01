import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/agent/ci/format-release-coverage-comment.mjs');
const RUN_URL = 'https://github.example.test/nalfeo/Crawler/actions/runs/12345';

function runFormatter(summaryPath?: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GITHUB_SERVER_URL: 'https://github.example.test',
    GITHUB_REPOSITORY: 'nalfeo/Crawler',
    GITHUB_RUN_ID: '12345',
  };
  if (summaryPath !== undefined) {
    env.COVERAGE_SUMMARY_JSON = summaryPath;
  } else {
    delete env.COVERAGE_SUMMARY_JSON;
  }
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
  });
}

describe('format-release-coverage-comment', () => {
  it('formats valid coverage totals on stdout only', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'release-coverage-'));
    try {
      const summaryPath = path.join(dir, 'coverage-summary.json');
      writeFileSync(
        summaryPath,
        JSON.stringify({
          total: {
            lines: { pct: 88.123 },
            branches: { pct: 77 },
            functions: { pct: 66.5 },
            statements: { pct: 55.678 },
          },
        }),
      );

      const result = runFormatter(summaryPath);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe(
        `\n📊 Coverage: lines 88.12%, branches 77.00%, functions 66.50%, statements 55.68% ([summary artifact](${RUN_URL}))`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renders the fallback line without diagnostics when the summary is missing', () => {
    const result = runFormatter(path.join(tmpdir(), 'crawler-missing-coverage-summary.json'));

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(`\n📊 Coverage: unavailable ([deploy artifact](${RUN_URL}))`);
  });

  it('keeps malformed-summary diagnostics on stderr and stdout as the fallback comment fragment', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'release-coverage-'));
    try {
      const summaryPath = path.join(dir, 'coverage-summary.json');
      writeFileSync(summaryPath, '{ not json');

      const result = runFormatter(summaryPath);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`\n📊 Coverage: unavailable ([deploy artifact](${RUN_URL}))`);
      expect(result.stderr).toContain('::warning::Failed to format coverage summary:');
      expect(result.stderr).toContain('JSON');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
