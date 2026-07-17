#!/usr/bin/env tsx
/**
 * epic-status.ts — CLI entry point for the epic status tool.
 *
 * Usage:
 *   npm run epic:status -- <epic-id> [--github [--reconcile]] [--materialization-plan]
 *
 * Modes:
 *   (default)                   Offline status table from epic-state.json
 *   --materialization-plan      Markdown materialization plan for child issues
 *   --github --reconcile        Read-only audit against live GitHub issue/PR state
 *
 * The state file is read from:
 *   docs/knowledge/epics/<epic-id>/epic-state.json
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  validateEpicState,
  formatStatusTable,
  formatMaterializationPlan,
  type EpicState,
} from './epic-status-lib.js';

// ---------------------------------------------------------------------------
// Repo root resolution
// ---------------------------------------------------------------------------

/** Resolve path relative to the repository root (two levels above scripts/agent/). */
function fromRepo(...segments: string[]): string {
  const here = fileURLToPath(import.meta.url);
  // scripts/agent/ → repo root is two directories up
  const repoRoot = join(here, '..', '..', '..');
  return join(repoRoot, ...segments);
}

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  epicId: string;
  github: boolean;
  reconcile: boolean;
  materializationPlan: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);

  const first = args[0];
  if (args.length === 0 || first === undefined || first.startsWith('-')) {
    throw new Error(
      'Usage: npm run epic:status -- <epic-id> [--github [--reconcile]] [--materialization-plan]',
    );
  }

  const epicId: string = first;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(epicId)) {
    throw new Error(`epic-id must be a kebab-case slug (e.g. "floor-2-equipment"), got: ${epicId}`);
  }

  const flags = args.slice(1);
  const github = flags.includes('--github');
  const reconcile = flags.includes('--reconcile');
  const materializationPlan = flags.includes('--materialization-plan');

  if (reconcile && !github) {
    throw new Error('--reconcile requires --github');
  }

  return { epicId, github, reconcile, materializationPlan };
}

// ---------------------------------------------------------------------------
// State loading
// ---------------------------------------------------------------------------

export function loadStateFile(epicId: string): EpicState {
  const statePath = fromRepo('docs', 'knowledge', 'epics', epicId, 'epic-state.json');
  if (!existsSync(statePath)) {
    throw new Error(
      `Epic state file not found: ${statePath}\n` +
        `Run 'npm run epic:status -- ${epicId}' from the repo root after creating the file.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(statePath, 'utf-8'));
  } catch (err) {
    throw new Error(`Failed to parse epic-state.json for "${epicId}": ${String(err)}`, {
      cause: err,
    });
  }
  return validateEpicState(raw);
}

// ---------------------------------------------------------------------------
// GitHub reconciliation (read-only audit)
// ---------------------------------------------------------------------------

/**
 * Perform a read-only audit of the epic state against live GitHub issue/PR
 * states. Prints any discrepancies found.
 *
 * This is intentionally a lightweight check — it does not mutate epic-state.json.
 * The Producer (sole state writer) is responsible for updating the file after
 * reconciling discrepancies.
 */
async function runGitHubReconcile(state: EpicState): Promise<void> {
  // Dynamic import so the GitHub client is only loaded when --github is passed.
  // Uses the GITHUB_TOKEN env var (or CRAWLER_CI_PAT fallback).
  const token = process.env['GITHUB_TOKEN'] ?? process.env['CRAWLER_CI_PAT'];
  if (!token) {
    throw new Error(
      'GitHub reconciliation requires GITHUB_TOKEN or CRAWLER_CI_PAT environment variable.',
    );
  }

  const repo = 'nalfeo/Crawler';
  const headers: Record<string, string> = {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'crawler-epic-status/1.0',
  };

  let discrepancies = 0;

  for (const slice of state.slices) {
    if (slice.github_issue == null) continue;
    const url = `https://api.github.com/repos/${repo}/issues/${slice.github_issue}`;
    let issueState: string;
    try {
      const resp = await fetch(url, { headers });
      if (!resp.ok) {
        process.stderr.write(
          `  ⚠️  ${slice.id}: HTTP ${resp.status} for issue #${slice.github_issue}\n`,
        );
        discrepancies++;
        continue;
      }
      const data = (await resp.json()) as { state: string };
      issueState = data.state;
    } catch (err) {
      process.stderr.write(`  ⚠️  ${slice.id}: fetch failed — ${String(err)}\n`);
      discrepancies++;
      continue;
    }

    // Flag if the GitHub issue is closed but the slice isn't validated/merged.
    if (issueState === 'closed' && slice.status !== 'validated' && slice.status !== 'merged') {
      process.stdout.write(
        `  ⚠️  ${slice.id} (${slice.status}): issue #${slice.github_issue} is closed on GitHub but slice is not validated/merged\n`,
      );
      discrepancies++;
    } else if (
      issueState === 'open' &&
      (slice.status === 'validated' || slice.status === 'merged')
    ) {
      process.stdout.write(
        `  ℹ️  ${slice.id} (${slice.status}): issue #${slice.github_issue} is still open on GitHub\n`,
      );
    } else {
      process.stdout.write(`  ✓  ${slice.id}: issue #${slice.github_issue} (${issueState})\n`);
    }
  }

  process.stdout.write(
    `\nReconciliation complete. ${discrepancies} discrepanc${discrepancies === 1 ? 'y' : 'ies'} found.\n`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    process.stderr.write(`Error: ${String(err)}\n`);
    process.exit(1);
  }

  let state: EpicState;
  try {
    state = loadStateFile(args.epicId);
  } catch (err) {
    process.stderr.write(`Error: ${String(err)}\n`);
    process.exit(1);
  }

  if (args.materializationPlan) {
    process.stdout.write(formatMaterializationPlan(state) + '\n');
    return;
  }

  process.stdout.write(formatStatusTable(state) + '\n');

  if (args.github && args.reconcile) {
    process.stdout.write('\nReconciling against GitHub...\n');
    try {
      await runGitHubReconcile(state);
    } catch (err) {
      process.stderr.write(`Reconciliation error: ${String(err)}\n`);
      process.exit(1);
    }
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`Unhandled error: ${String(err)}\n`);
  process.exit(1);
});
