import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Regression test for the docs-update CI incident (issue #1743).
 *
 * Before the fix, `aggregate-report.ts` would emit an unbounded Markdown body
 * when `build-system-index.ts` emitted hundreds of per-handoff warnings.
 * GitHub's issue body limit is 65 536 characters; exceeding it causes the
 * `github.rest.issues.create` call to fail with HTTP 422.
 *
 * This test verifies that:
 *  1. The script caps its stdout at MAX_BODY_CHARS (65 136) characters.
 *  2. The truncation notice is appended with the total finding count.
 *  3. The script still exits non-zero (triggering issue creation) for a report
 *     that contains `warn`-severity findings.
 */

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../scripts/agent/shared/aggregate-report.ts',
);

/** Mirror of the constants in aggregate-report.ts */
const GITHUB_BODY_LIMIT = 65_536;
const METADATA_OVERHEAD = 400;
const MAX_BODY_CHARS = GITHUB_BODY_LIMIT - METADATA_OVERHEAD;

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'aggregate-report-test-'));

  // Build a report summary whose findings, when rendered to Markdown, will
  // produce a body that exceeds GITHUB_BODY_LIMIT characters.
  const manyFindings = Array.from({ length: 1_000 }, (_, i) => ({
    severity: 'warn',
    message: `Handoff declares unknown system slug 'slug-${i}'; not in docs/systems/README.md.`,
    file: `docs/knowledge/handoffs/2026-07-20-handoff-${i}.md`,
    remediation: "Add `## Systems touched: <slug1>, <slug2>` to the handoff.",
  }));

  const summary = {
    script: 'docs-build-system-index',
    startedAt: '2026-07-20T00:00:00.000Z',
    finishedAt: '2026-07-20T00:00:01.000Z',
    findings: manyFindings,
    blocking: 0,
  };

  writeFileSync(path.join(tmpDir, 'docs-build-system-index.json'), JSON.stringify(summary));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('aggregate-report.ts body-limit truncation', () => {
  it('caps stdout at MAX_BODY_CHARS characters when findings overflow', () => {
    const result = spawnSync('npx', ['tsx', SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        AUTOMATION_REPORT_DIR: tmpDir,
        AUTOMATION_TITLE: 'docs-update: scheduled report',
        GITHUB_WORKFLOW: 'Docs Update Loop',
      },
    });

    const body = result.stdout;

    // Body must not exceed the cap.
    expect(body.length).toBeLessThanOrEqual(MAX_BODY_CHARS);

    // A truncation notice must be appended.
    expect(body).toContain('Report truncated');
    expect(body).toContain('findings total');

    // Exit code must be non-zero — findings exist so an issue should be filed.
    expect(result.status).toBe(1);
  });

  it('does not truncate a short report', () => {
    const shortTmpDir = mkdtempSync(path.join(os.tmpdir(), 'aggregate-report-short-'));
    try {
      const summary = {
        script: 'docs-check-paths',
        startedAt: '2026-07-20T00:00:00.000Z',
        finishedAt: '2026-07-20T00:00:01.000Z',
        findings: [{ severity: 'info', message: 'All paths OK.' }],
        blocking: 0,
      };
      writeFileSync(path.join(shortTmpDir, 'docs-check-paths.json'), JSON.stringify(summary));

      const result = spawnSync('npx', ['tsx', SCRIPT], {
        encoding: 'utf8',
        env: {
          ...process.env,
          AUTOMATION_REPORT_DIR: shortTmpDir,
          AUTOMATION_TITLE: 'docs-update: scheduled report',
          GITHUB_WORKFLOW: 'Docs Update Loop',
        },
      });

      expect(result.stdout).not.toContain('Report truncated');
      expect(result.stdout.length).toBeLessThan(MAX_BODY_CHARS);
      // info-only → exit 0 (no issue needed).
      expect(result.status).toBe(0);
    } finally {
      rmSync(shortTmpDir, { recursive: true, force: true });
    }
  });
});
