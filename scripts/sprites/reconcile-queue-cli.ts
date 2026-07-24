/**
 * CLI shim for `runReconcile`, invoked by the hourly `sprite-queue-reconciler`
 * GitHub Actions workflow. It harvests the durable `assets/queue` art surface
 * onto current `main`, force-updates the sole-writer `assets/promote` branch,
 * opens/updates ONE art-only PR, and arms `--auto --squash` — landing queued
 * sprite edits back into the shipped game on a cadence.
 *
 * Usage:
 *   node <tsx-cli> reconcile-queue-cli.ts \
 *     --repo-root <path> \
 *     [--remote origin] [--queue-branch assets/queue] \
 *     [--promote-branch assets/promote] [--base main] [--repo owner/repo]
 *
 * Prints a JSON result object to stdout on success. Exit codes are meaningful so
 * the workflow can distinguish outcomes:
 *   0  noop or PR opened/armed (success)
 *   10 usage error
 *   30 untrusted-diff — the promotion diff touched a non-art path; the
 *      reconciler REFUSED to push/arm (fail-closed). The workflow must escalate.
 *   1  any other failure (git/gh error)
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReconcileError, runReconcile, type ReconcileOptions } from './reconcile-queue.js';
import { createDefaultReconcileDeps } from './reconcile-queue-runtime.js';

interface ParsedArgs {
  readonly repoRoot: string;
  readonly options: ReconcileOptions;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let repoRoot: string | undefined;
  let remote: string | undefined;
  let queueBranch: string | undefined;
  let promoteBranch: string | undefined;
  let baseBranch: string | undefined;
  let repo: string | undefined;

  const takeValue = (i: number, flag: string): string => {
    const next = argv[i + 1];
    if (next === undefined) throw new Error(`${flag} requires a value`);
    return next;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--repo-root') {
      repoRoot = takeValue(i, arg);
      i++;
    } else if (arg === '--remote') {
      remote = takeValue(i, arg);
      i++;
    } else if (arg === '--queue-branch') {
      queueBranch = takeValue(i, arg);
      i++;
    } else if (arg === '--promote-branch') {
      promoteBranch = takeValue(i, arg);
      i++;
    } else if (arg === '--base') {
      baseBranch = takeValue(i, arg);
      i++;
    } else if (arg === '--repo') {
      repo = takeValue(i, arg);
      i++;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (repoRoot === undefined) throw new Error('Missing required --repo-root');
  return {
    repoRoot,
    options: { remote, queueBranch, promoteBranch, baseBranch, repo },
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 10;
  }

  try {
    const result = await runReconcile(
      parsed.repoRoot,
      createDefaultReconcileDeps(parsed.repoRoot),
      parsed.options,
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (err) {
    if (err instanceof ReconcileError) {
      process.stderr.write(`reconcile-queue failed (${err.kind}): ${err.message}\n`);
      // untrusted-diff is the security fail-closed path: the workflow escalates
      // (opens an issue) on exit 30. Everything else is a generic failure.
      if (err.kind === 'untrusted-diff') return 30;
      return 1;
    }
    process.stderr.write(
      `reconcile-queue failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

const invokedAsScript = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  void main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
