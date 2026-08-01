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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  approveFrameSequence,
  approveIconBatch,
  approveVariant,
  ApproveError,
  loadApprovedEntry,
  loadApprovedFrameSequenceEntry,
  type IconBatchEntry,
  type ManifestEntry,
} from './approve.js';
import { runQueueCommit } from './queue-commit.js';
import { createDefaultQueueCommitDeps } from './queue-commit-runtime.js';
import { createEnrichTagsProvider, type EnrichTagsRequest } from './enrich-tags.js';
import { writeShard } from './generated-shards.js';
import type { ManifestEntry as SharedManifestEntry } from '../../src/shared/generated-assets.js';

interface ParsedArgs {
  readonly runDir: string;
  /** Absent when `--sequence` or `--icon-batch` is set. */
  readonly variantIndex?: number;
  /**
   * Approve the run as a Slice B frame-sequence (walk-cycle) instead of a
   * single design-candidate variant. Mutually exclusive with `--variant` and `--icon-batch`.
   */
  readonly sequence: boolean;
  /**
   * Approve the run as an icon batch — maps each cell index to its declared icon id.
   * Mutually exclusive with `--variant` and `--sequence`.
   */
  readonly iconBatch: boolean;
  readonly allowHardBlocked: boolean;
}

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  if (argv.length === 0) {
    throw new Error(
      'Usage: npm run sprites:approve -- <runDir> --variant N\n' +
        '   or: npm run sprites:approve -- <runDir> --sequence\n' +
        '   or: npm run sprites:approve -- <runDir> --icon-batch\n' +
        '  <runDir>              Absolute or repo-relative path to a generated/runs/<brief>/<runId>\n' +
        '  --variant N           Variant index (0-based) to approve as a standalone sprite\n' +
        '  --sequence            Approve every ordered frame of a frameSequence run as one\n' +
        '                        walk-cycle animation sheet (mutually exclusive with --variant)\n' +
        '  --icon-batch          Approve all cells of an icon batch run (mutually exclusive with\n' +
        '                        --variant and --sequence)\n' +
        '  --allow-hard-blocked  Override the judge hard-block veto (use consciously)',
    );
  }

  let runDir: string | undefined;
  let variantIndex: number | undefined;
  let allowHardBlocked = false;
  let sequence = false;
  let iconBatch = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--sequence') {
      sequence = true;
    } else if (arg === '--icon-batch') {
      iconBatch = true;
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
  if (iconBatch && variantIndex !== undefined) {
    throw new Error('--icon-batch and --variant are mutually exclusive');
  }
  if (iconBatch && sequence) {
    throw new Error('--icon-batch and --sequence are mutually exclusive');
  }
  if (!sequence && !iconBatch && variantIndex === undefined) {
    throw new Error(
      'Missing required --variant N (or pass --sequence for a frame-sequence run, or --icon-batch for an icon batch run)',
    );
  }

  return { runDir, variantIndex, allowHardBlocked, sequence, iconBatch };
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

/**
 * Best-effort LLM tag enrichment after a successful approval.
 * Never throws or blocks the approval result — enrichment is optional.
 */
async function enrichEntryTags(
  entry: ManifestEntry,
  generatedDir: string,
  _repoRoot: string,
): Promise<void> {
  // Skip if tags already present (e.g. from a hand-authored catalog override).
  const existingTags = entry.catalog?.tags;
  if (Array.isArray(existingTags) && existingTags.length > 0) return;

  const provider = createEnrichTagsProvider({ env: process.env as Record<string, string> });
  if (!provider) return;

  const request: EnrichTagsRequest = {
    manifestKey: entry.spriteName ?? '',
    type: entry.type ?? null,
    description: entry.catalog?.description ?? '',
    briefId: entry.briefId ?? '',
  };

  try {
    const tags = await provider.generateTags(request);
    if (tags.length === 0) return;
    const updatedEntry: ManifestEntry = { ...entry, catalog: { ...entry.catalog, tags } };
    const manifestKey = entry.spriteName ?? '';
    if (manifestKey)
      writeShard(generatedDir, manifestKey, updatedEntry as unknown as SharedManifestEntry);
  } catch (err) {
    process.stderr.write(
      `⚠ enrich-tags: ${entry.spriteName ?? '(unknown)'}: ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
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
    // ── Icon-batch path ──────────────────────────────────────────────────────
    if (parsed.iconBatch) {
      // Load the brief to find the iconBatch array. The run's summary.json
      // carries briefPath so we can read the brief YAML and extract the array.
      const summaryPath = path.join(runDir, 'summary.json');
      let briefPath: string | undefined;
      try {
        const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as {
          briefPath?: string;
        };
        briefPath = summary.briefPath;
      } catch {
        process.stderr.write(`approve failed: could not read summary.json at ${summaryPath}\n`);
        return 3;
      }
      if (!briefPath) {
        process.stderr.write(
          `approve failed: summary.json has no briefPath (needed for --icon-batch)\n`,
        );
        return 3;
      }
      const briefAbsPath = path.isAbsolute(briefPath) ? briefPath : path.join(repoRoot, briefPath);
      let iconBatchEntries: IconBatchEntry[] | undefined;
      try {
        const briefRaw = readFileSync(briefAbsPath, 'utf8');
        // Fast YAML extraction: parse iconBatch array from brief YAML.
        // We use a dynamic import of js-yaml which is already a dep of the pipeline.
        const { parse } = await import('yaml');
        const brief = parse(briefRaw) as Record<string, unknown>;
        const raw = brief['iconBatch'];
        if (!Array.isArray(raw) || raw.length === 0) {
          process.stderr.write(`approve failed: brief at ${briefAbsPath} has no iconBatch array\n`);
          return 3;
        }
        iconBatchEntries = raw as IconBatchEntry[];
      } catch (err) {
        process.stderr.write(
          `approve failed: could not read brief at ${briefAbsPath}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return 3;
      }

      const entries = approveIconBatch({
        runDir,
        iconBatch: iconBatchEntries,
        manifestPath,
        publicAssetsDir,
        repoRoot,
      });

      if (entries.length === 0) {
        process.stdout.write(`No icons approved (all cells missing or already up-to-date).\n`);
        return 0;
      }

      process.stdout.write(`Approved ${entries.length} icon(s):\n`);
      for (const e of entries) {
        process.stdout.write(`  ${e.spriteName} → ${e.assetPath}\n`);
      }

      // Queue-commit all approved icons as a batch.
      if (process.env.CI === undefined) {
        try {
          const result = await runQueueCommit(
            repoRoot,
            entries.map((e) => ({
              assetPath: e.assetPath,
              manifestKey: e.spriteName,
              briefId: e.briefId,
              variantIndex: e.variantIndex,
            })),
            createDefaultQueueCommitDeps(repoRoot),
            { message: `chore(assets): approve icon batch (${entries.length} icons)` },
          );
          process.stdout.write(
            result.status === 'committed'
              ? `  queued: ${result.branch} @ ${result.commit?.slice(0, 12)}\n`
              : `  queued: no-op (${result.branch} already up to date)\n`,
          );
        } catch (err) {
          process.stderr.write(
            `⚠ queue-commit failed — approvals are LOCAL-ONLY. Re-run to retry: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
      return 0;
    }

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

    // Best-effort LLM tag enrichment for fresh approvals. Never blocks.
    if (!alreadyApproved) {
      await enrichEntryTags(entry, path.join(publicAssetsDir, 'generated'), repoRoot);
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
