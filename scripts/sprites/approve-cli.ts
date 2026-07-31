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
import {
  approveFrameSequence,
  approveVariant,
  ApproveError,
  loadApprovedEntry,
  loadApprovedFrameSequenceEntry,
  type ManifestEntry,
} from './approve.js';
import { runQueueCommit } from './queue-commit.js';
import { createDefaultQueueCommitDeps } from './queue-commit-runtime.js';

interface ParsedArgs {
  readonly runDir: string;
  /** Absent when `--sequence` is set — a frame-sequence run approves as one unit. */
  readonly variantIndex?: number;
  /**
   * Approve the run as a Slice B frame-sequence (walk-cycle) instead of a
   * single design-candidate variant. Mutually exclusive with `--variant`.
   */
  readonly sequence: boolean;
  readonly allowHardBlocked: boolean;
}

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  if (argv.length === 0) {
    throw new Error(
      'Usage: npm run sprites:approve -- <runDir> --variant N\n' +
        '   or: npm run sprites:approve -- <runDir> --sequence\n' +
        '  <runDir>              Absolute or repo-relative path to a generated/runs/<brief>/<runId>\n' +
        '  --variant N           Variant index (0-based) to approve as a standalone sprite\n' +
        '  --sequence            Approve every ordered frame of a frameSequence run as one\n' +
        '                        walk-cycle animation sheet (mutually exclusive with --variant)\n' +
        '  --allow-hard-blocked  Override the judge hard-block veto (use consciously)',
    );
  }

  let runDir: string | undefined;
  let variantIndex: number | undefined;
  let allowHardBlocked = false;
  let sequence = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--sequence') {
      sequence = true;
    } else if (arg === '--variant' || arg === '-v') {
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
    } else if (arg === '--allow-hard-blocked') {
      allowHardBlocked = true;
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
  if (sequence && variantIndex !== undefined) {
    throw new Error('--sequence and --variant are mutually exclusive');
  }
  if (!sequence && variantIndex === undefined) {
    throw new Error('Missing required --variant N (or pass --sequence for a frame-sequence run)');
  }

  return { runDir, variantIndex, allowHardBlocked, sequence };
}

function exitCodeForError(kind: ApproveError['kind']): number {
  switch (kind) {
    case 'run-not-found':
    case 'processed-missing':
    case 'variant-not-found':
    case 'frame-missing':
    case 'not-frame-sequence':
      return 2;
    case 'summary-invalid':
    case 'manifest-invalid':
      return 3;
    case 'hard-blocked':
      return 4;
    case 'frame-incoherent':
      // Distinct exit code: this is the hard coherence gate refusing to ship
      // drifted art, not a plain input/config error. Callers/CI should treat
      // this as "regenerate the sequence", not "fix a path typo".
      return 4;
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
    let entry: ManifestEntry;
    let alreadyApproved = false;
    if (parsed.sequence) {
      try {
        entry = approveFrameSequence({
          runDir,
          manifestPath,
          catalogPath,
          publicAssetsDir,
          repoRoot,
        });
        process.stdout.write(
          `Approved ${entry.briefId} frame sequence\n` +
            `  asset: ${entry.assetPath}\n` +
            `  manifest: ${path.relative(repoRoot, manifestPath)}\n` +
            `  source: ${entry.sourceRun}\n` +
            `  animation: ${entry.animation ? JSON.stringify(entry.animation) : '(none)'}\n`,
        );
      } catch (err) {
        // Mirror the `--variant` retry dance below: an exact-duplicate
        // re-approve is NOT a terminal failure for durability. The manifest
        // entry already exists, but its earlier best-effort queue-commit may
        // never have landed on assets/queue. Load the stored entry and fall
        // through to the SAME queue-commit block below so re-running the
        // approve genuinely RETRIES the durable push — which is exactly what
        // the failure warning tells the operator to do. Before this fix the
        // CLI exited here, never reaching queue-commit, so that advice was
        // false for `--sequence` (round-1 code review finding).
        if (err instanceof ApproveError && err.kind === 'already-approved') {
          const existing = loadApprovedFrameSequenceEntry({ runDir, manifestPath, repoRoot });
          if (!existing) {
            process.stderr.write(`approve failed (${err.kind}): ${err.message}\n`);
            return exitCodeForError(err.kind);
          }
          entry = existing;
          alreadyApproved = true;
          process.stdout.write(
            `Already approved ${entry.briefId} frame sequence \u2014 retrying durable queue-commit\n` +
              `  asset: ${entry.assetPath}\n`,
          );
        } else if (err instanceof ApproveError) {
          process.stderr.write(`approve failed (${err.kind}): ${err.message}\n`);
          return exitCodeForError(err.kind);
        } else {
          throw err;
        }
      }
    } else {
      const variantIndex = parsed.variantIndex!;
      try {
        entry = approveVariant({
          runDir,
          variantIndex,
          manifestPath,
          catalogPath,
          publicAssetsDir,
          repoRoot,
          allowHardBlocked: parsed.allowHardBlocked,
        });
        process.stdout.write(
          `Approved ${entry.briefId} variant ${entry.variantIndex}\n` +
            `  asset: ${entry.assetPath}\n` +
            `  manifest: ${path.relative(repoRoot, manifestPath)}\n` +
            `  source: ${entry.sourceRun}\n` +
            `  sensors: ${entry.sensorScore}${entry.judgeScore !== null ? ` · judge ${entry.judgeScore}` : ''}\n`,
        );
      } catch (err) {
        // An exact-duplicate re-approve is NOT a terminal failure for durability:
        // the entry already exists in the manifest, but its earlier best-effort
        // queue-commit may never have landed on assets/queue. Load the stored
        // entry and fall through to the SAME queue-commit block below so re-running
        // the approve genuinely RETRIES the durable push — which is exactly what the
        // failure warning tells the operator to do. Before this the CLI exited here,
        // never reaching queue-commit, so that advice was false (concern #6).
        if (err instanceof ApproveError && err.kind === 'already-approved') {
          const existing = loadApprovedEntry({
            runDir,
            variantIndex,
            manifestPath,
          });
          if (!existing) {
            // No stored entry to retry against — nothing to make durable; keep the
            // original already-approved error + exit code.
            process.stderr.write(`approve failed (${err.kind}): ${err.message}\n`);
            return exitCodeForError(err.kind);
          }
          entry = existing;
          alreadyApproved = true;
          process.stdout.write(
            `Already approved ${entry.briefId} variant ${entry.variantIndex} \u2014 retrying durable queue-commit\n` +
              `  asset: ${entry.assetPath}\n`,
          );
        } else {
          throw err;
        }
      }
    }

    // Durably persist the approved asset onto the remote assets/queue branch so
    // the approval survives across sessions/worktrees/processes. Skipped on CI:
    // this CLI is operator-driven and (unlike the sidecar) intentionally still
    // approves locally under CI, so we only skip the remote push there. A
    // queue-commit failure is a loud warning, not a hard failure — the local
    // approve already succeeded and the hourly reconciler is the backstop. Runs
    // for both a fresh approve and an already-approved retry so the warning's
    // "re-run the approve (which retries queue-commit)" advice is truthful (#6).
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
          `⚠ queue-commit failed — this approval is LOCAL-ONLY and is NOT yet safe across ` +
            `worktrees/sessions. The hourly reconciler only sees commits already on ` +
            `assets/queue, so it CANNOT recover a push that never reached the branch. Re-run ` +
            `the approve (which retries queue-commit) before discarding this worktree: ` +
            `${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    } else if (alreadyApproved) {
      // On CI we skip the remote push (see above); make the no-op explicit so an
      // already-approved retry does not look like it silently did nothing.
      process.stdout.write(`  queued: skipped on CI (already approved)\n`);
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
