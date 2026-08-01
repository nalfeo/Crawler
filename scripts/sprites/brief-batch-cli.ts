/**
 * CLI for the brief-batch consolidation.
 *
 * Usage:
 *   npm run sprites:brief-batch [-- --base main --remote origin]
 *
 * Scans every open PR in the repo, identifies those where all changed files are
 * under `briefs/` (brief-only PRs), unions their brief files into one
 * `batch/briefs-<stamp>` branch, pushes it, and opens ONE PR. Prints the PR URL.
 * Exits 0 (with a notice) when there are no brief-only PRs to consolidate.
 *
 * After the batch PR merges, close the individual source PRs manually (the batch
 * PR body lists them with instructions).
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBriefBatchConsolidation, type BriefBatchDeps, type BriefBatchOptions } from './brief-batch.js';
import type { Exec, ExecResult } from './checkin.js';

const realExec: Exec = (command, args, options) =>
  new Promise<ExecResult>((resolve) => {
    execFile(
      command,
      [...args],
      { cwd: options?.cwd, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? ((error as { code: number }).code ?? 1)
            : error
              ? 1
              : 0;
        resolve({ stdout: String(stdout), stderr: String(stderr), code });
      },
    );
  });

function parseArgs(argv: ReadonlyArray<string>): BriefBatchOptions {
  const options: { baseBranch?: string; remote?: string; slug?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--base') options.baseBranch = argv[++i];
    else if (arg.startsWith('--base=')) options.baseBranch = arg.slice('--base='.length);
    else if (arg === '--remote') options.remote = argv[++i];
    else if (arg.startsWith('--remote=')) options.remote = arg.slice('--remote='.length);
    else if (arg === '--slug') options.slug = argv[++i];
    else if (arg.startsWith('--slug=')) options.slug = arg.slice('--slug='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function makeDeps(): BriefBatchDeps {
  return {
    exec: realExec,
    makeTempDir: () => Promise.resolve(mkdtempSync(path.join(tmpdir(), 'brief-batch-'))),
    removeDir: (dir) => {
      rmSync(dir, { recursive: true, force: true });
      return Promise.resolve();
    },
  };
}

export async function main(argv: ReadonlyArray<string>, cwd: string): Promise<number> {
  let options: BriefBatchOptions;
  try {
    options = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  try {
    const result = await runBriefBatchConsolidation(cwd, makeDeps(), options);
    if (result === null) {
      process.stdout.write('No open brief-only PRs — nothing to consolidate.\n');
      return 0;
    }
    process.stdout.write(
      `Opened consolidation PR for ${result.plan.allBriefPaths.length} brief(s) ` +
        `from ${result.plan.sourcePRs.length} PR(s).\n` +
        `  branch: ${result.plan.batchBranch}\n` +
        `  PR:     ${result.prUrl}\n` +
        `\nNext steps:\n` +
        `  1. Verify the PR contains only brief YAML files and merge it.\n` +
        `  2. After merge, close the source PRs:\n` +
        result.plan.sourcePRs.map((pr) => `     gh pr close ${pr.number} --comment "Batched into ${result.prUrl}"`).join('\n') +
        '\n',
    );
    return 0;
  } catch (err) {
    process.stderr.write(
      `brief-batch failed: ${err instanceof Error ? err.message : String(err)}\n`,
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
  void main(process.argv.slice(2), process.cwd()).then((code) => {
    process.exit(code);
  });
}
