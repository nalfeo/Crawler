/**
 * One-off cleanup for the `assets/queue` branch's stale naming-lineage split
 * (see docs/knowledge/handoffs for the asset-ingest-churn investigation).
 *
 * `main`'s manifest was migrated from `<brief>-v1-var-N` to bare
 * `<brief>-var-N` naming by PR #3050 (`normalize-sprite-names.ts` /
 * `sprite-name-taxonomy.ts`), but `assets/queue` was never rebased through
 * that migration. It still holds hundreds of `-v1-var-N`-named entries whose
 * PIXEL CONTENT is often already approved on `main` under a bare-named slot.
 * Each hourly reconcile treated these as "new" (the `-v1-` path never
 * existed on `main`'s history) and re-promoted them, minting fresh duplicate
 * `-var-N` slots on `main` forever — the churn this script and the
 * `approveVariant` cross-variant dedup fix (scripts/sprites/approve.ts)
 * jointly close off.
 *
 * This script is meant to be run ONCE, checked out on `assets/queue` (or a
 * worktree of it), against a `--main-generated-dir` checkout of `main`'s
 * `public/assets/generated`:
 *
 *   1. For every `assets/queue` entry whose `contentHash` already exists
 *      under ANY entry in `main`'s manifest, delete the shard + PNG from the
 *      `assets/queue` tree (pure duplicate — `main` already has this pixel
 *      content approved).
 *   2. Run the existing `normalizeSpriteNames` migration (identical to what
 *      PR #3050 ran against `main`) over whatever remains, so any entry that
 *      is NOT a duplicate of `main` content still loses its stale lineage tag
 *      and becomes representable as a normal bare-name variant.
 *
 * Usage:
 *   tsx scripts/sprites/prune-stale-queue-duplicates.ts --dry-run \
 *     --queue-generated-dir <path-to-queue-checkout>/public/assets/generated \
 *     --main-generated-dir <path-to-main-checkout>/public/assets/generated
 *   tsx scripts/sprites/prune-stale-queue-duplicates.ts --apply ... (same flags) \
 *     --source-sha <exact-queue-tip> --removal-manifest <reviewed-json-file>
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { deleteShard, readAllShards } from './generated-shards.js';
import { normalizeSpriteNames } from './normalize-sprite-names.js';
import { bareConcept, buildTaxonomyPlan, type TaxonomyEntry } from './sprite-name-taxonomy.js';

export interface PruneOptions {
  readonly queueGeneratedDir: string;
  readonly mainGeneratedDir: string;
  readonly apply: boolean;
}

export interface PruneResult {
  readonly duplicatesPruned: readonly string[];
  readonly renamesApplied: number;
}

/**
 * Destructive maintenance is deliberately two-party: the planned deletion and a
 * checked, source-bound manifest.  This file is not a queue publisher itself,
 * but making the CLI reject an unmanifested prune prevents a later `git add &&
 * push` from turning a broad local cleanup into an unreviewable queue rewrite.
 */
interface RemovalManifest {
  readonly version: 1;
  readonly sourceSha: string;
  readonly normalization: 'bare-concept-v1';
  readonly removals: readonly {
    readonly key: string;
    readonly duplicateOf: string;
    readonly contentHash: string;
  }[];
}

function assetAbsPath(generatedDir: string, assetPath: string): string {
  return path.join(generatedDir, path.basename(assetPath));
}

function fileSha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function assertSourceCheckoutState(queueGeneratedDir: string, sourceSha: string): void {
  let repoRoot: string;
  try {
    repoRoot = git(queueGeneratedDir, 'rev-parse', '--show-toplevel');
  } catch (error) {
    throw new Error(
      `Cannot resolve git checkout for --queue-generated-dir ${queueGeneratedDir}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  const generatedRel = path
    .relative(repoRoot, path.resolve(queueGeneratedDir))
    .split(path.sep)
    .join('/');
  if (generatedRel !== 'public/assets/generated') {
    throw new Error(
      `--queue-generated-dir must point to <checkout>/public/assets/generated (got ${generatedRel || '.'}).`,
    );
  }
  const head = git(repoRoot, 'rev-parse', 'HEAD');
  if (head !== sourceSha) {
    throw new Error(
      `Refusing destructive prune: checkout HEAD ${head} does not match --source-sha ${sourceSha}.`,
    );
  }
  const generatedStatus = git(
    repoRoot,
    'status',
    '--porcelain',
    '--untracked-files=all',
    '--',
    'public/assets/generated',
  );
  if (generatedStatus !== '') {
    throw new Error(
      'Refusing destructive prune: queue generated surface is not clean for the bound source SHA.',
    );
  }
}

function assertRemovalManifest(
  manifestPath: string,
  queueGeneratedDir: string,
  mainGeneratedDir: string,
  expectedSourceSha: string,
  queueEntries: Record<string, Record<string, unknown>>,
  mainEntries: Record<string, Record<string, unknown>>,
  duplicatesPruned: readonly string[],
): void {
  let manifest: RemovalManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RemovalManifest;
  } catch (error) {
    throw new Error(
      `Cannot read removal manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (
    manifest.version !== 1 ||
    manifest.sourceSha !== expectedSourceSha ||
    manifest.normalization !== 'bare-concept-v1' ||
    !Array.isArray(manifest.removals)
  ) {
    throw new Error(
      `Removal manifest must be version 1, bound to source SHA ${expectedSourceSha}, and use normalization bare-concept-v1.`,
    );
  }
  const byKey = new Map(manifest.removals.map((removal) => [removal.key, removal]));
  if (byKey.size !== manifest.removals.length || byKey.size !== duplicatesPruned.length) {
    throw new Error(
      'Removal manifest must contain exactly one entry for every planned PNG/shard pair.',
    );
  }
  for (const key of duplicatesPruned) {
    const removal = byKey.get(key);
    const queued = queueEntries[key];
    const duplicate = removal ? mainEntries[removal.duplicateOf] : undefined;
    if (removal === undefined || queued === undefined || duplicate === undefined) {
      throw new Error(
        `Removal manifest cannot prove ${key} is a same-content duplicate under ${manifest.normalization}. Regenerate the dry-run manifest and do not publish this prune.`,
      );
    }
    const queuedAssetPath = typeof queued?.assetPath === 'string' ? queued.assetPath : undefined;
    const duplicateAssetPath =
      typeof duplicate?.assetPath === 'string' ? duplicate.assetPath : undefined;
    const queuedPng = queuedAssetPath
      ? assetAbsPath(queueGeneratedDir, queuedAssetPath)
      : undefined;
    const duplicatePng = duplicateAssetPath
      ? assetAbsPath(mainGeneratedDir, duplicateAssetPath)
      : undefined;
    const queuedPngHash = queuedPng && existsSync(queuedPng) ? fileSha256(queuedPng) : undefined;
    const duplicatePngHash =
      duplicatePng && existsSync(duplicatePng) ? fileSha256(duplicatePng) : undefined;
    if (queuedPngHash === undefined || duplicatePngHash === undefined) {
      throw new Error(
        `Removal manifest requires existing queue/main PNGs for ${key}; regenerate the dry-run manifest and retry.`,
      );
    }
    if (
      queuedPngHash !== removal.contentHash ||
      duplicatePngHash !== removal.contentHash ||
      queued.contentHash !== removal.contentHash ||
      duplicate.contentHash !== removal.contentHash ||
      typeof queued.briefId !== 'string' ||
      typeof duplicate.briefId !== 'string' ||
      bareConcept(queued.briefId) !== bareConcept(duplicate.briefId)
    ) {
      throw new Error(
        `Removal manifest cannot prove ${key} is a same-content duplicate under ${manifest.normalization}. Regenerate the dry-run manifest and do not publish this prune.`,
      );
    }
  }
}

/**
 * Prune every `assets/queue` entry whose contentHash is already present on
 * `main` under the SAME canonical concept (bare `briefId`, lineage tag
 * stripped). Matching by content hash alone is not sufficient: identical
 * pixel content is legitimately reused across different semantic briefs (for
 * example `welcome-sign-left-var-0` and `welcome-room-wall-shelf-var-0` share
 * a hash), so scoping to the concept avoids discarding novel queued art that
 * merely happens to share bytes with an unrelated concept. Returns the pruned
 * manifest keys.
 */
export async function pruneStaleQueueDuplicates(options: PruneOptions): Promise<PruneResult> {
  const queueEntries = readAllShards(options.queueGeneratedDir) as unknown as Record<
    string,
    Record<string, unknown>
  >;
  const mainEntries = readAllShards(options.mainGeneratedDir) as unknown as Record<
    string,
    Record<string, unknown>
  >;

  const mainHashesByConcept = new Map<string, Set<string>>();
  for (const entry of Object.values(mainEntries)) {
    if (typeof entry.contentHash !== 'string' || typeof entry.briefId !== 'string') continue;
    const concept = bareConcept(entry.briefId);
    let hashes = mainHashesByConcept.get(concept);
    if (hashes === undefined) {
      hashes = new Set<string>();
      mainHashesByConcept.set(concept, hashes);
    }

    hashes.add(entry.contentHash);
  }

  const duplicatesPruned: string[] = [];
  for (const [key, entry] of Object.entries(queueEntries)) {
    const contentHash = typeof entry.contentHash === 'string' ? entry.contentHash : undefined;
    const briefId = typeof entry.briefId === 'string' ? entry.briefId : undefined;
    if (contentHash === undefined || briefId === undefined) continue;
    const concept = bareConcept(briefId);
    if (mainHashesByConcept.get(concept)?.has(contentHash) === true) {
      duplicatesPruned.push(key);
    }
  }
  duplicatesPruned.sort((a, b) => a.localeCompare(b));

  if (options.apply) {
    for (const key of duplicatesPruned) {
      const entry = queueEntries[key];
      const assetPath = typeof entry?.assetPath === 'string' ? entry.assetPath : '';
      if (assetPath !== '') {
        const png = assetAbsPath(options.queueGeneratedDir, assetPath);
        if (existsSync(png)) rmSync(png);
      }
      deleteShard(options.queueGeneratedDir, key);
    }

    // Whatever remains may still carry a stale lineage tag that isn't a
    // duplicate of anything on `main` (genuinely un-migrated, novel content).
    // Bare-name it using the same taxonomy migration `main` already went
    // through, so the tree becomes fully canonical either way. Runs AFTER the
    // physical deletion above so it reads the true post-prune tree from disk.
    const normalizeResult = await normalizeSpriteNames({
      generatedDir: options.queueGeneratedDir,
      mode: 'apply',
    });
    return { duplicatesPruned, renamesApplied: normalizeResult.plan.renames.length };
  }

  // Dry-run preview: `normalizeSpriteNames` reads its entries straight off
  // disk, which apply mode's deletion hasn't touched, so calling it here would
  // plan renames (and report conflicts) for entries the apply pass will have
  // already deleted. Compute the plan directly from the POST-PRUNE in-memory
  // entry set instead, so a dry-run preview matches what apply will actually do.
  const postPruneEntries: Record<string, TaxonomyEntry> = {};
  const prunedSet = new Set(duplicatesPruned);
  for (const [key, entry] of Object.entries(queueEntries)) {
    if (prunedSet.has(key)) continue;
    postPruneEntries[key] = entry as unknown as TaxonomyEntry;
  }
  const plan = buildTaxonomyPlan(postPruneEntries);
  return { duplicatesPruned, renamesApplied: plan.renames.length };
}

function parseFlagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

export async function main(argv: readonly string[]): Promise<number> {
  const apply = argv.includes('--apply');
  const queueGeneratedDir = parseFlagValue(argv, '--queue-generated-dir');
  const mainGeneratedDir = parseFlagValue(argv, '--main-generated-dir');
  const removalManifest = parseFlagValue(argv, '--removal-manifest');
  const sourceSha = parseFlagValue(argv, '--source-sha');

  if (queueGeneratedDir === undefined || mainGeneratedDir === undefined) {
    console.error(
      'Usage: prune-stale-queue-duplicates.ts [--dry-run|--apply] --queue-generated-dir <path> --main-generated-dir <path>',
    );
    return 1;
  }

  let result: PruneResult;
  if (apply) {
    if (removalManifest === undefined || sourceSha === undefined) {
      console.error(
        'Refusing destructive prune: --apply requires --source-sha <queue-tip> and --removal-manifest <file>. Run --dry-run, write a source-bound manifest, then retry.',
      );
      return 1;
    }
    // Validate the planned removals BEFORE touching either half of a pair.
    const plan = await pruneStaleQueueDuplicates({
      queueGeneratedDir,
      mainGeneratedDir,
      apply: false,
    });
    const queueEntries = readAllShards(queueGeneratedDir) as unknown as Record<
      string,
      Record<string, unknown>
    >;
    const mainEntries = readAllShards(mainGeneratedDir) as unknown as Record<
      string,
      Record<string, unknown>
    >;
    try {
      assertSourceCheckoutState(queueGeneratedDir, sourceSha);
      assertRemovalManifest(
        removalManifest,
        queueGeneratedDir,
        mainGeneratedDir,
        sourceSha,
        queueEntries,
        mainEntries,
        plan.duplicatesPruned,
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
    result = await pruneStaleQueueDuplicates({ queueGeneratedDir, mainGeneratedDir, apply: true });
  } else {
    result = await pruneStaleQueueDuplicates({ queueGeneratedDir, mainGeneratedDir, apply: false });
  }

  console.log(`mode: ${apply ? 'apply' : 'dry-run'}`);
  console.log(`duplicate entries pruned: ${result.duplicatesPruned.length}`);
  for (const key of result.duplicatesPruned) {
    console.log(`  DUPLICATE ${key}`);
  }
  console.log(`residual lineage renames applied: ${result.renamesApplied}`);

  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
