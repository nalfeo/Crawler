#!/usr/bin/env tsx
/**
 * epic-status.ts — CLI entry point for the epic status tool.
 *
 * Usage:
 *   npm run epic:status -- <epic-id> [--github --reconcile] [--materialization-plan]
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
import { join, resolve } from 'node:path';
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

const SUPPORTED_FLAGS = new Set(['--github', '--reconcile', '--materialization-plan']);

export function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);

  const first = args[0];
  if (args.length === 0 || first === undefined || first.startsWith('-')) {
    throw new Error(
      'Usage: npm run epic:status -- <epic-id> [--github --reconcile] [--materialization-plan]',
    );
  }

  const epicId: string = first;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(epicId)) {
    throw new Error(`epic-id must be a kebab-case slug (e.g. "floor-2-equipment"), got: ${epicId}`);
  }

  const flags = args.slice(1);
  const unknownFlags = flags.filter((flag) => !SUPPORTED_FLAGS.has(flag));
  if (unknownFlags.length > 0) {
    throw new Error(`Unknown argument(s): ${unknownFlags.join(', ')}`);
  }

  const github = flags.includes('--github');
  const reconcile = flags.includes('--reconcile');
  const materializationPlan = flags.includes('--materialization-plan');

  if (github && !reconcile) {
    throw new Error('--github requires --reconcile');
  }

  if (reconcile && !github) {
    throw new Error('--reconcile requires --github');
  }

  if (materializationPlan && (github || reconcile)) {
    throw new Error('--materialization-plan cannot be combined with --github/--reconcile');
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
interface TextWriter {
  write(chunk: string): void;
}

interface GitHubReconcileOptions {
  fetchImpl?: typeof fetch;
  stdout?: TextWriter;
  stderr?: TextWriter;
  repo?: string;
  token?: string;
}

export async function runGitHubReconcile(
  state: EpicState,
  options: GitHubReconcileOptions = {},
): Promise<number> {
  // Dynamic import so the GitHub client is only loaded when --github is passed.
  // Uses the GITHUB_TOKEN env var (or CRAWLER_CI_PAT fallback).
  const token = options.token ?? process.env['GITHUB_TOKEN'] ?? process.env['CRAWLER_CI_PAT'];
  if (!token) {
    throw new Error(
      'GitHub reconciliation requires GITHUB_TOKEN or CRAWLER_CI_PAT environment variable.',
    );
  }

  const repo = options.repo ?? 'nalfeo/Crawler';
  const fetchImpl = options.fetchImpl ?? fetch;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const headers: Record<string, string> = {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'crawler-epic-status/1.0',
  };

  let discrepancies = 0;

  for (const slice of state.slices) {
    if (slice.github_issue != null) {
      const url = `https://api.github.com/repos/${repo}/issues/${slice.github_issue}`;
      let issueState: string | undefined;
      let issueCheckFailed = false;
      try {
        const resp = await fetchImpl(url, { headers });
        if (!resp.ok) {
          stderr.write(`  ⚠️  ${slice.id}: HTTP ${resp.status} for issue #${slice.github_issue}\n`);
          discrepancies++;
          issueCheckFailed = true;
        }
        if (!issueCheckFailed) {
          const data = (await resp.json()) as { state: string };
          issueState = data.state;
        }
      } catch (err) {
        stderr.write(`  ⚠️  ${slice.id}: fetch failed — ${String(err)}\n`);
        discrepancies++;
        issueCheckFailed = true;
      }

      if (!issueCheckFailed) {
        // Flag if the GitHub issue is closed but the slice isn't validated/merged.
        if (issueState === 'closed' && slice.status !== 'validated' && slice.status !== 'merged') {
          stdout.write(
            `  ⚠️  ${slice.id} (${slice.status}): issue #${slice.github_issue} is closed on GitHub but slice is not validated/merged\n`,
          );
          discrepancies++;
        } else if (
          issueState === 'open' &&
          (slice.status === 'validated' || slice.status === 'merged')
        ) {
          stdout.write(
            `  ℹ️  ${slice.id} (${slice.status}): issue #${slice.github_issue} is still open on GitHub\n`,
          );
        } else if (issueState !== undefined) {
          stdout.write(`  ✓  ${slice.id}: issue #${slice.github_issue} (${issueState})\n`);
        }
      }
    }

    if (slice.pr != null) {
      const prUrl = `https://api.github.com/repos/${repo}/pulls/${slice.pr}`;
      try {
        const resp = await fetchImpl(prUrl, { headers });
        if (!resp.ok) {
          stderr.write(`  ⚠️  ${slice.id}: HTTP ${resp.status} for PR #${slice.pr}\n`);
          discrepancies++;
          continue;
        }
        const data = (await resp.json()) as { merged: boolean; state: string };
        if (data.merged && slice.status !== 'validated' && slice.status !== 'merged') {
          stdout.write(
            `  ⚠️  ${slice.id} (${slice.status}): PR #${slice.pr} is merged on GitHub but slice is not validated/merged\n`,
          );
          discrepancies++;
        } else if (!data.merged && (slice.status === 'validated' || slice.status === 'merged')) {
          stdout.write(
            `  ⚠️  ${slice.id} (${slice.status}): PR #${slice.pr} is not merged on GitHub\n`,
          );
          discrepancies++;
        } else {
          const prState = data.merged ? 'merged' : data.state;
          stdout.write(`  ✓  ${slice.id}: PR #${slice.pr} (${prState})\n`);
        }
      } catch (err) {
        stderr.write(`  ⚠️  ${slice.id}: PR fetch failed — ${String(err)}\n`);
        discrepancies++;
      }
    }
  }

  stdout.write(
    `\nReconciliation complete. ${discrepancies} discrepanc${discrepancies === 1 ? 'y' : 'ies'} found.\n`,
  );
  return discrepancies;
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

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
const thisPath = resolve(fileURLToPath(import.meta.url));
if (invokedPath === thisPath) {
  main().catch((err: unknown) => {
    process.stderr.write(`Unhandled error: ${String(err)}\n`);
    process.exit(1);
  });
}
