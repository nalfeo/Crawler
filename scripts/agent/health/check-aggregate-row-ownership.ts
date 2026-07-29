#!/usr/bin/env node
/**
 * check-aggregate-row-ownership.ts — CI guard against silent data-loss in
 * aggregate files regenerated from a stale base.
 *
 * For each file in REGISTRY, three git versions are compared:
 *   - PR head (PR_HEAD_SHA env var)
 *   - Merge-base (git merge-base of PR head and origin/main)
 *   - origin/main
 *
 * Exits non-zero when any registered file contains:
 *   - A stale row (PR carries the merge-base value while main has advanced)
 *   - A deleted row (row in merge-base + main but absent in PR)
 *   - A deleted field (field in merge-base + main entry but absent in PR entry)
 *
 * Only runs during pull_request CI events; skips gracefully otherwise.
 * In CI, a missing merge-base or zero-row result is a hard failure (not a skip).
 *
 * See check-aggregate-row-ownership-lib.ts for the pure algorithm and
 * registered file list.
 *
 * ## Environment
 *
 *   GITHUB_ACTIONS       — set to "true" by GitHub Actions
 *   GITHUB_EVENT_NAME    — "pull_request" for PR runs
 *   PR_HEAD_SHA          — must be set to ${{ github.event.pull_request.head.sha }}
 *                          by the workflow step
 *
 * ## Required checkout configuration
 *
 * The workflow step must use `fetch-depth: 0` so that `git merge-base` can
 * find the true common ancestor of the PR head and origin/main.
 */

import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { Report } from '../shared/report.js';
import {
  REGISTRY,
  MIN_EXPECTED_ROWS_IN_CI,
  checkRowOwnership,
} from './check-aggregate-row-ownership-lib.js';

const report = new Report('check-aggregate-row-ownership');

const isCI = process.env.GITHUB_ACTIONS === 'true';
const isGitHubPR = process.env.GITHUB_EVENT_NAME === 'pull_request';
const prHeadSha = (process.env.PR_HEAD_SHA ?? '').trim();

// Outside CI or not a PR: skip gracefully (local dev or push-to-main run).
if (!isCI || !isGitHubPR) {
  report.skip(
    'Not running in a CI pull_request context — skipping aggregate row ownership check. ' +
      'Set GITHUB_ACTIONS=true and GITHUB_EVENT_NAME=pull_request to run locally.',
  );
  report.finish();
}

// Validate PR_HEAD_SHA format to avoid shell-injection via git args.
const SHA_RE = /^[0-9a-f]{7,40}$/;
if (!SHA_RE.test(prHeadSha)) {
  report.error(
    `PR_HEAD_SHA is missing or not a valid git SHA (got: ${JSON.stringify(prHeadSha)}). ` +
      'Set PR_HEAD_SHA=${{ github.event.pull_request.head.sha }} in the CI step.',
    { remediation: 'Add env: PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }} to the step.' },
  );
  report.finish();
}

/** Run git with an array of args; return stdout or null on non-zero exit. */
function gitTry(args: readonly string[]): string | null {
  try {
    return execFileSync('git', args as string[], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

/** Run git with an array of args; throw on non-zero exit. */
function gitRequired(args: readonly string[], context: string): string {
  const result = gitTry(args);
  if (result === null) {
    throw new Error(`git ${args.join(' ')} failed: ${context}`);
  }
  return result;
}

// Compute the merge-base. With fetch-depth: 0, git should be able to find it.
// Using a helper function so TypeScript can prove `mergeBaseSha` is always
// initialized (the catch branch terminates via report.finish(): never).
function resolveMergeBase(): string {
  try {
    return gitRequired(
      ['merge-base', prHeadSha, 'origin/main'],
      'ensure fetch-depth: 0 is set on the checkout step',
    ).trim();
  } catch (e) {
    report.error(
      `Failed to compute git merge-base between ${prHeadSha} and origin/main: ${(e as Error).message}`,
      { remediation: 'Add fetch-depth: 0 to the actions/checkout step for this job.' },
    );
    return report.finish();
  }
}

const mergeBaseSha = resolveMergeBase();

/** Get the content of a file at a specific git ref, or null if absent. */
function fileAtRef(ref: string, repoRelPath: string): string | null {
  // Use -- to separate pathspec from ref to avoid ambiguity.
  return gitTry(['show', `${ref}:${repoRelPath}`]);
}

for (const entry of REGISTRY) {
  const { path: relPath, extractRows } = entry;

  const prContent = fileAtRef(prHeadSha, relPath);
  const mergeBaseContent = fileAtRef(mergeBaseSha, relPath);
  const mainContent = fileAtRef('origin/main', relPath);

  // File not present in either merge-base or main: nothing to compare.
  if (mergeBaseContent === null && mainContent === null) {
    report.info(`${relPath}: file absent from both merge-base and origin/main — skipping.`);
    continue;
  }

  // File absent in PR head but present in merge-base or main.
  if (prContent === null) {
    report.error(
      `${relPath}: file is present in the merge-base / origin/main but absent in this PR. ` +
        'If intentional, this must be a dedicated deletion PR, not part of a feature change.',
      { file: relPath },
    );
    continue;
  }

  // File is new (not in merge-base): nothing to compare against.
  if (mergeBaseContent === null) {
    report.info(
      `${relPath}: file not present in merge-base (new file) — skipping staleness check.`,
    );
    continue;
  }

  // File absent from origin/main (deleted there): no authoritative "main" value.
  if (mainContent === null) {
    report.info(`${relPath}: file absent from origin/main — skipping.`);
    continue;
  }

  // PR did not touch this file — no regeneration happened, so no revert risk.
  // A 3-way merge of an untouched file simply takes main's current content.
  if (prContent === mergeBaseContent) {
    report.info(`${relPath}: file unchanged in this PR — skipping staleness check.`);
    continue;
  }

  // Parse rows from all three versions.
  let prRows, mergeBaseRows, mainRows;
  try {
    prRows = extractRows(prContent);
    mergeBaseRows = extractRows(mergeBaseContent);
    mainRows = extractRows(mainContent);
  } catch (e) {
    report.error(`${relPath}: failed to parse rows — ${(e as Error).message}`, {
      file: relPath,
      remediation: 'Check that the file is valid JSON and has the expected structure.',
    });
    continue;
  }

  // Run the ownership check.
  const result = checkRowOwnership(prRows, mergeBaseRows, mainRows);

  for (const finding of result.findings) {
    report.error(finding.detail, { file: relPath });
  }

  const status = result.findings.length === 0 ? 'clean' : `${result.findings.length} finding(s)`;
  report.info(`${relPath}: ${result.rowsChecked} rows checked — ${status}.`);

  // Canary: if this changed file was fully parsed but produced 0 rows, something
  // is broken (wrong file structure, wrong git paths, or fetch failure). Checked
  // per-file so a healthy file cannot mask a broken extractor for another file.
  if (result.rowsChecked < MIN_EXPECTED_ROWS_IN_CI) {
    report.error(
      `${relPath}: parsed and compared but checked 0 rows. ` +
        `This indicates a configuration failure — expected at least ${MIN_EXPECTED_ROWS_IN_CI} row. ` +
        `Check that origin/main is fetched and the registered file paths are correct.`,
      {
        file: relPath,
        remediation:
          'Ensure the CI step checkout uses fetch-depth: 0 and that git fetch origin main succeeds.',
      },
    );
  }
}

report.finish();
