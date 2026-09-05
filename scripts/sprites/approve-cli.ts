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
 * Constitutional note (§3): this CLI is the HUMAN acceptance surface (see
 * `tests/unit/sprites/acceptance-lifecycle-routing.test.ts`), so it REFUSES
 * outright under `process.env.CI` — the same refusal the sidecar's `/approve`
 * and `/accept` routes make, and for the same reason. The earlier behaviour was
 * worse than either option: CI skipped the durability gate AND skipped durable
 * publication, yet still mutated checked-in manifest shards, PNGs, and the
 * disliked-asset lifecycle. That is a silent local-only mutation with no
 * recoverable `sourceRun` and no way for anyone else to ever see it.
 *
 * Unattended CI producers are NOT blocked by this: they have their own
 * classified entrypoints (`ci-harvest-approve.ts`, `icon-batch-cli.ts`,
 * `asset-request-publisher.ts`, `theme-equipment-runner.ts`,
 * `reprocess-welcome-room-cli.ts`), which hold no lifecycle deletion authority.
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
  resolveFrameSequenceIdentity,
  resolveVariantIdentity,
  type IconBatchEntry,
  type ManifestEntry,
} from './approve.js';
import { runQueueCommit } from './queue-commit.js';
import {
  ensureRunDurable,
  parseSourceRun,
  resolvePublicationDurableStore,
} from './run-durability.js';
import { createDefaultQueueCommitDeps } from './queue-commit-runtime.js';
import { makeCheckinFileLock } from './checkin-runtime.js';
import { createEnrichTagsProvider, type EnrichTagsRequest } from './enrich-tags.js';
import { writeShard } from './generated-shards.js';
import { formatJsonFilesSync } from './catalog-io.js';
import type { ManifestEntry as SharedManifestEntry } from '../../src/shared/generated-assets.js';
import { loadEnvLocal } from './sidecar/env-local.js';
import { normalizeGeneratedSpriteConceptId } from '../../src/shared/sprite-concepts.js';
import {
  runAcceptedDislikedLifecycleTransaction,
  toQueueCommitAnnotationUpdates,
  type DislikedLifecyclePlan,
  type LifecycleReplacement,
} from './disliked-lifecycle.js';

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
 * Exit code for the Constitutional §3 CI refusal. Distinct from every other
 * code so a caller can tell "this surface is local-only" apart from a genuine
 * approval failure.
 */
const EXIT_CI_REFUSED = 6;

/**
 * FAIL-CLOSED pre-publication durability gate.
 *
 * Backfills anything the durable run store is missing from the local run
 * directory (covering both pre-contract runs and a partially-failed upload),
 * then verifies the required artifact set. Returns `0` to proceed, or a
 * non-zero exit code that must abort the approval BEFORE any manifest entry or
 * queue commit is written. Idempotent: uploads are `has`-gated, so re-running a
 * failed approve converges instead of duplicating anything.
 */
async function ensureApprovalDurable(repoRoot: string, runDir: string): Promise<number> {
  try {
    const coords = parseSourceRun(runDir);
    if (!coords) {
      process.stderr.write(
        `approve failed (not durable): cannot derive <briefId>/<runId> from run dir '${runDir}'. ` +
          `Expected a path ending in runs/<briefId>/<runId>.\n`,
      );
      return 5;
    }
    const durable = resolvePublicationDurableStore({ repoRoot });
    const result = await ensureRunDurable({ ...coords, durable, localRunDir: runDir });
    process.stdout.write(
      result.backfilled.length > 0
        ? `  durability: backfilled ${result.backfilled.length} artifact(s) to the durable run store\n`
        : `  durability: run already persisted (${result.verified.length} artifacts)\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(
      `approve failed (not durable): ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 5;
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
    if (manifestKey) {
      const shardPath = writeShard(
        generatedDir,
        manifestKey,
        updatedEntry as unknown as SharedManifestEntry,
      );
      formatJsonFilesSync([shardPath]);
    }
  } catch (err) {
    process.stderr.write(
      `⚠ enrich-tags: ${entry.spriteName ?? '(unknown)'}: ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

/**
 * Publish an approval (plus any lifecycle deletions it authorized) to the
 * durable `assets/queue` branch.
 *
 * Shared by `--variant`, `--sequence`, and `--icon-batch` so all three carry
 * the SAME removal + annotation payload. A publish failure is fatal whenever
 * the plan changed durable lifecycle state — a deletion or an annotation write
 * (tombstone, dislike clear) is already applied locally, and re-running would
 * compute an EMPTY delta, so the advertised "re-run to retry" would silently
 * never republish it. Failing makes the transaction roll back so the retry is
 * real. With no lifecycle change, the local approval survives and the operator
 * is told to re-run (the hourly reconciler cannot recover an unpushed commit).
 *
 * An EMPTY `entries` array is only a no-op when the plan ALSO removed nothing
 * and rewrote no annotation. An icon batch where every cell was already
 * up-to-date still legitimately retires the art it replaced and writes the
 * tombstones that record it; skipping publication there would apply that
 * lifecycle state locally and never push it, and the retry would compute an
 * empty delta — the exact stranding this whole publish path exists to prevent.
 * `runQueueCommit` already accepts an annotation/removal-only payload.
 */
async function publishApprovedAssets(
  repoRoot: string,
  entries: readonly ManifestEntry[],
  plan: DislikedLifecyclePlan,
  message: string,
  queueDeps: ReturnType<typeof createDefaultQueueCommitDeps>,
): Promise<void> {
  const changesLifecycleState = plan.removed.length > 0 || plan.annotationUpdates.length > 0;
  if (entries.length === 0 && !changesLifecycleState) return;
  try {
    const result = await runQueueCommit(
      repoRoot,
      entries.map((entry) => ({
        assetPath: entry.assetPath,
        manifestKey: entry.spriteName,
        briefId: entry.briefId,
        variantIndex: entry.variantIndex,
      })),
      { ...queueDeps, withCrossProcessLock: (run) => run() },
      {
        message,
        removals: plan.removed.map((removal) => ({
          assetPath: removal.assetPath,
          manifestKey: removal.manifestKey,
          sourceRun: removal.sourceRun,
          variantIndex: removal.variantIndex,
        })),
        annotations: toQueueCommitAnnotationUpdates(plan.annotationUpdates),
      },
    );
    process.stdout.write(
      result.status === 'committed'
        ? `  queued: ${result.branch} @ ${result.commit?.slice(0, 12)}\n`
        : `  queued: no-op (${result.branch} already up to date)\n`,
    );
  } catch (error) {
    if (plan.removed.length > 0 || plan.annotationUpdates.length > 0) throw error;
    process.stderr.write(
      `⚠ queue-commit failed — this approval is LOCAL-ONLY and is NOT yet safe across ` +
        `worktrees/sessions. The hourly reconciler only sees commits already on ` +
        `assets/queue, so it CANNOT recover a push that never reached the branch. Re-run ` +
        `the approve (which retries queue-commit) before discarding this worktree: ` +
        `${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

export async function main(argv: ReadonlyArray<string>, cwd: string): Promise<number> {
  // Constitutional §3 FAIL-CLOSED gate, checked BEFORE argument parsing and
  // therefore before any approval, lifecycle, or enrichment mutation can run.
  // See the module docstring: unattended producers use their own classified
  // entrypoints, so refusing here strands nothing.
  if (process.env.CI !== undefined) {
    process.stderr.write(
      `approve failed (ci-refused): npm run sprites:approve is the HUMAN acceptance ` +
        `surface and is local-only per Constitutional §3.\n` +
        `  It mutates checked-in manifest shards, public/assets/generated/**, and the ` +
        `disliked-asset lifecycle, and it publishes to the remote assets/queue branch — ` +
        `none of which CI may do.\n` +
        `  Run it on a dev box (unset CI), or use the unattended producer for your ` +
        `pipeline: sprites:icon-batch, sprites:asset-request, or ci-harvest-approve.\n`,
    );
    return EXIT_CI_REFUSED;
  }

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const repoRoot = cwd;
  loadEnvLocal(repoRoot);
  const publicAssetsDir = path.join(repoRoot, 'public', 'assets');
  const manifestPath = path.join(publicAssetsDir, 'generated', 'manifest.json');
  const catalogPath = path.join(repoRoot, 'src', 'shared', 'data', 'sprite-catalog.json');
  const runDir = path.isAbsolute(parsed.runDir)
    ? parsed.runDir
    : path.join(repoRoot, parsed.runDir);

  // FAIL-CLOSED durability gate (see run-durability.ts). Approving writes a
  // manifest entry whose `sourceRun` pointer — and a commit on the assets/queue
  // branch — both promise that the generating run still exists somewhere
  // recoverable. Before this gate they could promise a run that lived only
  // inside one gitignored worktree directory, which is exactly how seven
  // finished directional runs were lost. Unconditional: the CI escape hatch
  // that used to skip it is gone, because CI now cannot reach this line at all.
  const durabilityExit = await ensureApprovalDurable(repoRoot, runDir);
  if (durabilityExit !== 0) return durabilityExit;

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

      // Explicit human acceptance: route through the disliked-asset lifecycle
      // transaction so approving replacement icon art also retires the disliked
      // art it replaces (scoped to these icon concepts), validates closure, and
      // rolls back atomically when durable publication fails.
      const transaction = await makeCheckinFileLock(repoRoot)(async () => {
        const queueDeps = createDefaultQueueCommitDeps(repoRoot);
        return runAcceptedDislikedLifecycleTransaction({
          repoRoot,
          replacements: iconBatchEntries.map(
            (icon): LifecycleReplacement => ({
              manifestKey: icon.id,
              conceptId: normalizeGeneratedSpriteConceptId(icon.id),
              assetPath: `generated/${icon.id}.png`,
            }),
          ),
          approve: () =>
            approveIconBatch({
              runDir,
              iconBatch: iconBatchEntries,
              manifestPath,
              publicAssetsDir,
              repoRoot,
              allowHardBlocked: parsed.allowHardBlocked,
            }),
          approvedReplacementKeys: (entries) => entries.map((entry) => entry.spriteName),
          publish: async (entries, plan) => {
            // Best-effort LLM tag enrichment for each approved icon. Never blocks.
            await Promise.all(
              entries.map((e) =>
                enrichEntryTags(e, path.join(publicAssetsDir, 'generated'), repoRoot),
              ),
            );
            await publishApprovedAssets(
              repoRoot,
              entries,
              plan,
              entries.length === 0
                ? `chore(assets): retire disliked icon art (${plan.removed.length} removed)`
                : `chore(assets): approve icon batch (${entries.length} icons)`,
              queueDeps,
            );
          },
        });
      });
      const entries = transaction.approved;

      if (entries.length === 0) {
        process.stdout.write(
          `No icons approved (all cells missing or already up-to-date).\n` +
            `  lifecycle: removed ${transaction.plan.removed.length}, retained ` +
            `${transaction.plan.retainedGroups.length} all-disliked group(s), deferred ` +
            `${transaction.plan.deferredGroups.length} out-of-scope group(s)\n`,
        );
        return 0;
      }

      process.stdout.write(`Approved ${entries.length} icon(s):\n`);
      for (const e of entries) {
        process.stdout.write(`  ${e.spriteName} → ${e.assetPath}\n`);
      }
      process.stdout.write(
        `  lifecycle: removed ${transaction.plan.removed.length}, retained ` +
          `${transaction.plan.retainedGroups.length} all-disliked group(s), deferred ` +
          `${transaction.plan.deferredGroups.length} out-of-scope group(s)\n`,
      );
      return 0;
    }

    if (!parsed.sequence) {
      const variantIndex = parsed.variantIndex!;
      const identity = resolveVariantIdentity(runDir, variantIndex);
      let alreadyApproved = false;
      const transaction = await makeCheckinFileLock(repoRoot)(async () => {
        const queueDeps = createDefaultQueueCommitDeps(repoRoot);
        return runAcceptedDislikedLifecycleTransaction({
          repoRoot,
          replacements: [
            {
              manifestKey: identity.variantId,
              conceptId: normalizeGeneratedSpriteConceptId(identity.briefId),
              assetPath: identity.assetPath,
            },
          ],
          approve: () => {
            try {
              return approveVariant({
                runDir,
                variantIndex,
                manifestPath,
                catalogPath,
                publicAssetsDir,
                repoRoot,
                allowHardBlocked: parsed.allowHardBlocked,
              });
            } catch (err) {
              if (!(err instanceof ApproveError) || err.kind !== 'already-approved') throw err;
              const existing = loadApprovedEntry({ runDir, variantIndex, manifestPath });
              if (existing === null) throw err;
              alreadyApproved = true;
              return existing;
            }
          },
          publish: async (entry, plan) => {
            if (!alreadyApproved) {
              await enrichEntryTags(entry, path.join(publicAssetsDir, 'generated'), repoRoot);
            }
            await publishApprovedAssets(
              repoRoot,
              [entry],
              plan,
              `chore(assets): approve ${entry.spriteName}`,
              queueDeps,
            );
          },
        });
      });
      const entry = transaction.approved;
      process.stdout.write(
        `${alreadyApproved ? 'Already approved' : 'Approved'} ${entry.briefId} variant ${entry.variantIndex}\n` +
          `  asset: ${entry.assetPath}\n` +
          `  manifest: ${path.relative(repoRoot, manifestPath)}\n` +
          `  source: ${entry.sourceRun}\n` +
          `  lifecycle: removed ${transaction.plan.removed.length}, retained ` +
          `${transaction.plan.retainedGroups.length} all-disliked group(s), deferred ` +
          `${transaction.plan.deferredGroups.length} out-of-scope group(s)\n`,
      );
      return 0;
    }

    // Explicit human acceptance of a walk-cycle sheet replaces the art for a
    // whole concept, so it routes through the SAME lifecycle transaction as
    // `--variant`: scoped cleanup, closure validation, and rollback when the
    // durable publish fails. The identity is resolved BEFORE any mutation so an
    // exact-pin conflict aborts without having approved anything.
    const identity = resolveFrameSequenceIdentity(runDir);
    let alreadyApproved = false;
    const transaction = await makeCheckinFileLock(repoRoot)(async () => {
      const queueDeps = createDefaultQueueCommitDeps(repoRoot);
      return runAcceptedDislikedLifecycleTransaction({
        repoRoot,
        replacements: [
          {
            manifestKey: identity.variantId,
            conceptId: normalizeGeneratedSpriteConceptId(identity.briefId),
            assetPath: identity.assetPath,
          },
        ],
        approve: () => {
          try {
            return approveFrameSequence({
              runDir,
              manifestPath,
              catalogPath,
              publicAssetsDir,
              repoRoot,
            });
          } catch (err) {
            // An exact-duplicate re-approve is NOT terminal for durability: the
            // manifest entry already exists, but its earlier best-effort
            // queue-commit may never have landed on assets/queue. Load the
            // stored entry so publication genuinely RETRIES the durable push —
            // exactly what the failure warning tells the operator to do.
            if (!(err instanceof ApproveError) || err.kind !== 'already-approved') throw err;
            const existing = loadApprovedFrameSequenceEntry({ runDir, manifestPath, repoRoot });
            if (existing === null) throw err;
            alreadyApproved = true;
            return existing;
          }
        },
        publish: async (approvedEntry, plan) => {
          // Best-effort LLM tag enrichment for fresh approvals. Never blocks.
          if (!alreadyApproved) {
            await enrichEntryTags(approvedEntry, path.join(publicAssetsDir, 'generated'), repoRoot);
          }
          await publishApprovedAssets(
            repoRoot,
            [approvedEntry],
            plan,
            `chore(assets): approve ${approvedEntry.spriteName}`,
            queueDeps,
          );
        },
      });
    });
    const entry = transaction.approved;
    process.stdout.write(
      alreadyApproved
        ? `Already approved ${entry.briefId} frame sequence \u2014 retrying durable queue-commit\n` +
            `  asset: ${entry.assetPath}\n`
        : `Approved ${entry.briefId} frame sequence\n` +
            `  asset: ${entry.assetPath}\n` +
            `  manifest: ${path.relative(repoRoot, manifestPath)}\n` +
            `  source: ${entry.sourceRun}\n` +
            `  animation: ${entry.animation ? JSON.stringify(entry.animation) : '(none)'}\n`,
    );
    process.stdout.write(
      `  lifecycle: removed ${transaction.plan.removed.length}, retained ` +
        `${transaction.plan.retainedGroups.length} all-disliked group(s), deferred ` +
        `${transaction.plan.deferredGroups.length} out-of-scope group(s)\n`,
    );
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
