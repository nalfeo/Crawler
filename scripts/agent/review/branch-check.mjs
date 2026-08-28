#!/usr/bin/env node
/* global console */
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { findReviewLedgerPaths, formatLedgerResult, validateLedgerFile } from './ledger.mjs';

function lines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function validateAddedBranchLedgers({ cwd, baseSha, headSha, git = execFileSync }) {
  if (!baseSha || !headSha) return { ok: true, results: [], skipped: true };
  const addedFiles = lines(
    git('git', ['diff', '--name-only', '--diff-filter=A', `${baseSha}...${headSha}`], {
      cwd,
      encoding: 'utf8',
    }),
  );
  const results = findReviewLedgerPaths(addedFiles).map((path) => ({
    path,
    result: validateLedgerFile(path, cwd, { requireCurrentSchema: true }),
  }));
  return { ok: results.every(({ result }) => result.ok), results, skipped: false };
}

function main() {
  const result = validateAddedBranchLedgers({
    cwd: process.cwd(),
    baseSha: process.env.GITHUB_BASE_SHA,
    headSha: process.env.GITHUB_HEAD_SHA,
  });
  if (result.skipped) {
    console.log('review-ledger branch validation skipped outside a pull request.');
    return;
  }
  if (result.results.length === 0) {
    console.log('No review ledger was added; nothing to validate.');
    return;
  }
  for (const { path, result: validation } of result.results) {
    console.log(formatLedgerResult(validation, path));
  }
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
