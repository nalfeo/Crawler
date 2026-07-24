/**
 * CLI for approving a sprite-pipeline candidate without going through the
 * gallery sidecar. Useful for scripted batch-approval after a `sprites:run`.
 *
 * Usage:
 *   npm run sprites:approve -- <runDir> --variant N
 *
 * The CLI is a thin shell over `approveVariant()`: it resolves repo-relative
 * defaults (manifest path, public assets dir, repo root) and translates
 * `ApproveError` into a non-zero exit with a readable message.
 *
 * Constitutional note (§3): unlike the sidecar, this CLI is operator-driven
 * on a dev box and is NOT a network surface. We do NOT refuse on
 * `process.env.CI` here — the CI gate lives in the sidecar's HTTP layer.
 * If you ever wire this CLI into CI, add the refusal then.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { approveVariant, ApproveError } from './approve.js';
import { runQueueCommit } from './queue-commit.js';
import { createDefaultQueueCommitDeps } from './queue-commit-runtime.js';

interface ParsedArgs {
  readonly runDir: string;
  readonly variantIndex: number;
}

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  if (argv.length === 0) {
    throw new Error(
      'Usage: npm run sprites:approve -- <runDir> --variant N\n' +
        '  <runDir>      Absolute or repo-relative path to a generated/runs/<brief>/<runId>\n' +
        '  --variant N   Variant index (0-based) to approve',
    );
  }

  let runDir: string | undefined;
  let variantIndex: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--variant' || arg === '-v') {
      const next = argv[++i];
      if (next === undefined) {
        throw new Error('--variant requires a numeric argument');
      }
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== next) {
        throw new Error(`--variant must be a non-negative integer, got: ${next}`);
      }
      variantIndex = parsed;
    } else if (arg.startsWith('--variant=')) {
      const value = arg.slice('--variant='.length);
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== value) {
        throw new Error(`--variant must be a non-negative integer, got: ${value}`);
      }
      variantIndex = parsed;
    } else if (!arg.startsWith('-')) {
      if (runDir !== undefined) {
        throw new Error(`Unexpected positional argument: ${arg} (already have ${runDir})`);
      }
      runDir = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (runDir === undefined) {
    throw new Error('Missing required positional argument <runDir>');
  }
  if (variantIndex === undefined) {
    throw new Error('Missing required --variant N');
  }

  return { runDir, variantIndex };
}

function exitCodeForError(kind: ApproveError['kind']): number {
  switch (kind) {
    case 'run-not-found':
    case 'processed-missing':
    case 'variant-not-found':
      return 2;
    case 'summary-invalid':
    case 'manifest-invalid':
      return 3;
    default:
      return 1;
  }
}

export async function main(argv: ReadonlyArray<string>, cwd: string): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const repoRoot = cwd;
  const publicAssetsDir = path.join(repoRoot, 'public', 'assets');
  const manifestPath = path.join(publicAssetsDir, 'generated', 'manifest.json');
  const catalogPath = path.join(repoRoot, 'src', 'shared', 'data', 'sprite-catalog.json');
  const runDir = path.isAbsolute(parsed.runDir)
    ? parsed.runDir
    : path.join(repoRoot, parsed.runDir);

  try {
    const entry = approveVariant({
      runDir,
      variantIndex: parsed.variantIndex,
      manifestPath,
      catalogPath,
      publicAssetsDir,
      repoRoot,
    });
    process.stdout.write(
      `Approved ${entry.briefId} variant ${entry.variantIndex}\n` +
        `  asset: ${entry.assetPath}\n` +
        `  manifest: ${path.relative(repoRoot, manifestPath)}\n` +
        `  source: ${entry.sourceRun}\n` +
        `  sensors: ${entry.sensorScore}${entry.judgeScore !== null ? ` · judge ${entry.judgeScore}` : ''}\n`,
    );

    // Durably persist the approved asset onto the remote assets/queue branch so
    // the approval survives across sessions/worktrees/processes. Skipped on CI:
    // this CLI is operator-driven and (unlike the sidecar) intentionally still
    // approves locally under CI, so we only skip the remote push there. A
    // queue-commit failure is a loud warning, not a hard failure — the local
    // approve already succeeded and the hourly reconciler is the backstop.
    if (process.env.CI === undefined) {
      try {
        const result = await runQueueCommit(
          repoRoot,
          [
            {
              assetPath: entry.assetPath,
              manifestKey: entry.spriteName,
              briefId: entry.briefId,
              variantIndex: entry.variantIndex,
            },
          ],
          createDefaultQueueCommitDeps(repoRoot),
          { message: `chore(assets): approve ${entry.spriteName}` },
        );
        process.stdout.write(
          result.status === 'committed'
            ? `  queued: ${result.branch} @ ${result.commit?.slice(0, 12)}\n`
            : `  queued: no-op (${result.branch} already up to date)\n`,
        );
      } catch (err) {
        process.stderr.write(
          `⚠ queue-commit failed (approval is local-only until reconciled): ` +
            `${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
    return 0;
  } catch (err) {
    if (err instanceof ApproveError) {
      process.stderr.write(`approve failed (${err.kind}): ${err.message}\n`);
      return exitCodeForError(err.kind);
    }
    process.stderr.write(`approve failed: ${err instanceof Error ? err.message : String(err)}\n`);
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
