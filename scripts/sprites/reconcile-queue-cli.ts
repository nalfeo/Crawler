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
 *   31 rejected-lifecycle-deletion — unrelated art may have promoted, but a
 *      durable queue inconsistency blocked lifecycle convergence.
 *   32 source-quarantined — one source snapshot was withheld while healthy
 *      independent sources continued.
 *   33 both lifecycle deletion refusal and source quarantine occurred.
 *   1  any other git/gh failure.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ReconcileError,
  runReconcile,
  type ReconcileOptions,
  type ReconcileResult,
} from './reconcile-queue.js';
import { createDefaultReconcileDeps } from './reconcile-queue-runtime.js';

export const REJECTED_LIFECYCLE_DELETION_EXIT_CODE = 31;
export const QUARANTINED_SOURCE_EXIT_CODE = 32;
export const COMBINED_RECONCILE_WARNING_EXIT_CODE = 33;

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

export function reconcileResultExitCode(
  result: Pick<ReconcileResult, 'rejectedLifecycleDeletions' | 'quarantinedSources'>,
): number {
  const hasLifecycleRefusal = (result.rejectedLifecycleDeletions?.length ?? 0) > 0;
  const hasQuarantine = (result.quarantinedSources?.length ?? 0) > 0;
  if (hasLifecycleRefusal && hasQuarantine) return COMBINED_RECONCILE_WARNING_EXIT_CODE;
  if (hasLifecycleRefusal) return REJECTED_LIFECYCLE_DELETION_EXIT_CODE;
  if (hasQuarantine) return QUARANTINED_SOURCE_EXIT_CODE;
  return 0;
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
    // Deterministic, actionable surface for refused lifecycle deletions. The
    // cycle still promoted every unrelated asset, so this would otherwise be
    // buried in the result JSON.
    for (const rejection of result.rejectedLifecycleDeletions ?? []) {
      process.stderr.write(
        `reconcile-queue REFUSED lifecycle deletion "${rejection.annotationKey}": ` +
          `${rejection.reason} Withheld: ${rejection.paths.join(', ') || '(none)'}.\n` +
          `  Unrelated art still promoted, but EVERY lifecycle deletion and ` +
          `public/assets/generated/sprite-editor-annotations.json were withheld this cycle so ` +
          `main cannot gain a tombstone whose art is still present.\n` +
          `  Fix: on assets/queue, either delete both ` +
          `public/assets/generated/entries/${rejection.annotationKey}.json and its PNG together, ` +
          `or drop the "${rejection.annotationKey}" tombstone from the annotations file. Verify ` +
          `with \`npm run sprites:disliked-lifecycle -- --dry-run\`.\n`,
      );
    }
    for (const quarantine of result.quarantinedSources ?? []) {
      process.stderr.write(
        `reconcile-queue QUARANTINED source ${quarantine.sourceRef}: ${quarantine.reason}\n` +
          `  Withheld ${quarantine.paths.length} path(s): ${quarantine.paths.join(', ') || '(none)'}.\n` +
          `  Other independent sources were still reconciled; repair this source snapshot before retrying.\n`,
      );
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return reconcileResultExitCode(result);
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
