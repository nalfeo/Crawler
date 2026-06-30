#!/usr/bin/env node
/* global console */
import { execFileSync } from 'node:child_process';
import { evaluatePreflightChecks } from '../../../.github/extensions/copilot-guards/guards/pr-preflight.mjs';
import { decideLedger } from '../../../.github/extensions/copilot-guards/guards/pr-review-ledger.mjs';
import { mergeBaseWithMain } from '../../../.github/extensions/copilot-guards/lib/git.mjs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function section(title, body) {
  return `\n[${title}]\n${body.trim()}`;
}

export function summarizePrereqResult(preflightDecision, ledgerDecision) {
  const failures = [];
  const notes = [];

  if (preflightDecision?.decision === 'deny') {
    failures.push(section('pr-preflight', preflightDecision.reason || 'failed'));
  } else if (preflightDecision?.additionalContext) {
    notes.push(section('pr-preflight', preflightDecision.additionalContext));
  }

  if (ledgerDecision?.decision === 'deny') {
    failures.push(section('pr-review-ledger', ledgerDecision.reason || 'failed'));
  } else if (ledgerDecision?.decision === 'skip') {
    notes.push(
      section(
        'pr-review-ledger',
        ledgerDecision.additionalContext ||
          'review ledger not required for docs/art/deps-only change.',
      ),
    );
  } else if (ledgerDecision?.additionalContext) {
    notes.push(section('pr-review-ledger', ledgerDecision.additionalContext));
  }

  return { ok: failures.length === 0, failures, notes };
}

export function evaluatePrereqs(files, addedFiles, cwd, opts = {}) {
  const preflightDecision = evaluatePreflightChecks({
    files,
    addedFiles,
    cwd,
    toolArgs: {},
    skipSemanticTitle: true,
  });
  const ledgerDecision = decideLedger(files, addedFiles, {
    cwd,
    validateFile: opts.validateFile,
  });
  return summarizePrereqResult(preflightDecision, ledgerDecision);
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function lines(text) {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function addedFromNameStatus(text) {
  return lines(text)
    .filter((line) => line.startsWith('A\t'))
    .map((line) => line.slice(2).trim());
}

function gatherCurrentDiff(cwd) {
  const files = new Set();
  const addedFiles = new Set();

  const base = mergeBaseWithMain(cwd);
  if (base) {
    for (const f of lines(
      git(cwd, ['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`]),
    )) {
      files.add(f);
    }
    for (const f of addedFromNameStatus(git(cwd, ['diff', '--name-status', `${base}...HEAD`]))) {
      addedFiles.add(f);
    }
  }

  for (const f of lines(git(cwd, ['diff', '--name-only', '--diff-filter=ACMR']))) {
    files.add(f);
  }
  for (const f of lines(git(cwd, ['diff', '--name-only', '--diff-filter=ACMR', '--cached']))) {
    files.add(f);
  }

  for (const f of addedFromNameStatus(git(cwd, ['diff', '--name-status', '--cached']))) {
    addedFiles.add(f);
  }

  const untracked = lines(git(cwd, ['ls-files', '--others', '--exclude-standard']));
  for (const f of untracked) {
    files.add(f);
    addedFiles.add(f);
  }

  return { files: [...files], addedFiles: [...addedFiles] };
}

function main() {
  const cwd = process.cwd();
  let diff;

  try {
    diff = gatherCurrentDiff(cwd);
  } catch (err) {
    console.error(
      `❌ verify:pr-prereqs could not inspect branch diff: ${err.message}\nResolve git state and retry.`,
    );
    process.exit(1);
  }

  const result = evaluatePrereqs(diff.files, diff.addedFiles, cwd);
  if (!result.ok) {
    console.error(
      `❌ PR prerequisites are incomplete. Run these checks when execution is done, before opening PR.${result.failures.join(
        '',
      )}`,
    );
    if (result.notes.length > 0) {
      console.error(`\n[notes]${result.notes.join('')}`);
    }
    process.exit(1);
  }

  const noteSuffix = result.notes.length > 0 ? `\n[notes]${result.notes.join('')}` : '';
  console.log(`✅ PR prerequisites are satisfied (except final PR-title validation).${noteSuffix}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
