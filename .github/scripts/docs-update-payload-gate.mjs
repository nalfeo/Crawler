import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

import { parseMergeTrainPrNumber } from './merge-train/state.mjs';

// Decide whether the docs automation loop should run for a completed
// `Merge Train` workflow run.
//
// Two independent gates, both required:
//   1. Promotion provenance. `merge-train.yml` also runs on every raw `main`
//      push, schedules and wake-ups, so `workflow_run.event == 'push'` alone
//      does NOT mean the train landed anything. The durable
//      `Merge-Train-PR: <n>` trailer that promotion writes into the squash
//      commit (`squashCommitMessage` in merge-train/state.mjs) is the only
//      reliable landing signal, so we require it on the landed commit.
//   2. Payload scope. Docs-only landings must not re-enter the docs
//      automation/release path. Classification mirrors the established
//      `docs_only` rules in scripts/agent/ci/detect-art-only.sh so a
//      `src/**/*.md` file is never treated as docs.

export function isDocsPath(file) {
  if (file.startsWith('src/')) return false;
  if (file.startsWith('docs/')) return true;
  if (file.startsWith('.specify/specs/')) return true;
  if (file === 'AGENTS.md') return true;
  return file.endsWith('.md') || file.endsWith('.txt');
}

export function classifyDocsUpdatePayload({ conclusion, event, commitMessage, changedFiles }) {
  if (conclusion !== 'success') {
    return { run: false, reason: 'merge-train run did not succeed' };
  }
  if (event !== 'push') {
    return { run: false, reason: 'merge-train run was not a push landing' };
  }
  if (parseMergeTrainPrNumber(commitMessage) === null) {
    return { run: false, reason: 'landed commit carries no Merge-Train-PR trailer' };
  }

  const files = (changedFiles ?? []).map((file) => file.trim()).filter((file) => file.length > 0);
  if (files.length === 0) {
    return { run: false, reason: 'landed commit changed no files' };
  }
  if (files.every((file) => isDocsPath(file))) {
    return { run: false, reason: 'landed payload is docs-only' };
  }

  return { run: true, reason: 'merge train landed a non-doc payload' };
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function readLandedCommit(sha) {
  return {
    commitMessage: git(['log', '-1', '--format=%B', sha, '--']),
    // --no-renames matters: a rename such as src/core/foo.ts -> docs/foo.md is
    // otherwise reported only as the docs destination, which would wrongly
    // classify a source-touching payload as docs-only. Same reasoning as
    // scripts/agent/ci/local-scope.sh.
    changedFiles: git(['show', '--no-renames', '--name-only', '--format=', sha, '--']).split('\n'),
  };
}

if (process.argv[1]?.endsWith('docs-update-payload-gate.mjs')) {
  const sha = process.argv[2] ?? process.env.LANDED_SHA ?? '';
  let result;

  try {
    result = classifyDocsUpdatePayload({
      conclusion: process.env.WORKFLOW_RUN_CONCLUSION ?? '',
      event: process.env.WORKFLOW_RUN_EVENT ?? '',
      ...readLandedCommit(sha),
    });
  } catch (error) {
    // Fail closed: an unreadable payload is not evidence of a non-doc landing.
    console.log(`::warning::docs-update payload gate could not read ${sha}: ${error}`);
    result = { run: false, reason: 'landed payload could not be read' };
  }

  console.log(`docs-update payload gate: run=${result.run} (${result.reason})`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `run=${result.run}\n`);
  }
}
