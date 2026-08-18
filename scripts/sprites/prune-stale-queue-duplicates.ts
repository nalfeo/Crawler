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
 *   tsx scripts/sprites/prune-stale-queue-duplicates.ts --apply ... (same flags)
 */
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { deleteShard, readAllShards } from './generated-shards.js';
import { normalizeSpriteNames } from './normalize-sprite-names.js';

export interface PruneOptions {
  readonly queueGeneratedDir: string;
  readonly mainGeneratedDir: string;
  readonly apply: boolean;
}

export interface PruneResult {
  readonly duplicatesPruned: readonly string[];
  readonly renamesApplied: number;
}

function assetAbsPath(generatedDir: string, assetPath: string): string {
  return path.join(generatedDir, path.basename(assetPath));
}

/**
 * Prune every `assets/queue` entry whose contentHash is already present
 * anywhere in `main`'s manifest. Returns the pruned manifest keys.
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

  const mainContentHashes = new Set<string>();
  for (const entry of Object.values(mainEntries)) {
    if (typeof entry.contentHash === 'string') {
      mainContentHashes.add(entry.contentHash);
    }
  }

  const duplicatesPruned: string[] = [];
  for (const [key, entry] of Object.entries(queueEntries)) {
    const contentHash = typeof entry.contentHash === 'string' ? entry.contentHash : undefined;
    if (contentHash !== undefined && mainContentHashes.has(contentHash)) {
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
  }

  // Whatever remains may still carry a stale lineage tag that isn't a
  // duplicate of anything on `main` (genuinely un-migrated, novel content).
  // Bare-name it using the same taxonomy migration `main` already went
  // through, so the tree becomes fully canonical either way.
  const normalizeResult = await normalizeSpriteNames({
    generatedDir: options.queueGeneratedDir,
    mode: options.apply ? 'apply' : 'dry-run',
  });

  return { duplicatesPruned, renamesApplied: normalizeResult.plan.renames.length };
}

function parseFlagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

export async function main(argv: readonly string[]): Promise<number> {
  const apply = argv.includes('--apply');
  const queueGeneratedDir = parseFlagValue(argv, '--queue-generated-dir');
  const mainGeneratedDir = parseFlagValue(argv, '--main-generated-dir');

  if (queueGeneratedDir === undefined || mainGeneratedDir === undefined) {
    console.error(
      'Usage: prune-stale-queue-duplicates.ts [--dry-run|--apply] --queue-generated-dir <path> --main-generated-dir <path>',
    );
    return 1;
  }

  const result = await pruneStaleQueueDuplicates({ queueGeneratedDir, mainGeneratedDir, apply });

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
