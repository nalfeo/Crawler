/**
 * CLI for evicting (unapproving) a previously-approved sprite variant.
 *
 * Usage:
 *   npm run sprites:unapprove -- <variantId>
 *
 * <variantId> is the manifest key for the variant, e.g. `iron-sword-var-1`.
 *
 * The CLI is a thin shell over `unapproveVariant()`: it resolves repo-relative
 * defaults (manifest path, catalog path, public assets dir) and translates
 * `UnapproveError` into a non-zero exit with a readable message.
 *
 * Effect:
 *   - Removes the entry from `public/assets/generated/manifest.json`
 *   - Removes the `generated:<variantId>` entry from `src/shared/data/sprite-catalog.json`
 *   - Deletes `public/assets/generated/<variantId>.png`
 *
 * After running, commit the changed manifest, catalog, and deleted PNG to
 * evict the sprite from the game.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unapproveVariant, UnapproveError } from './approve.js';
import { createDefaultCheckinDeps } from './checkin-runtime.js';
import type { CheckinRunnerDeps } from './checkin.js';
import { composeManifestFromShards } from './generated-shards.js';

interface ParsedArgs {
  readonly variantId: string;
  readonly keepAsset: boolean;
}

type UnapproveQueueDeps = Pick<
  CheckinRunnerDeps,
  'listQueuedAssets' | 'inspectDurableQueueAsset' | 'withCrossProcessLock'
>;

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  if (argv.length === 0) {
    throw new Error(
      'Usage: npm run sprites:unapprove -- <variantId> [--keep-asset]\n' +
        '  <variantId>    Manifest key to evict, e.g. iron-sword-var-1\n' +
        '  --keep-asset   Skip deleting the PNG from public/assets/generated/ (dry-run-ish)',
    );
  }

  let variantId: string | undefined;
  let keepAsset = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--keep-asset') {
      keepAsset = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown argument: ${arg}`);
    } else {
      if (variantId !== undefined) {
        throw new Error(`Unexpected positional argument: ${arg} (already have ${variantId})`);
      }
      variantId = arg;
    }
  }

  if (variantId === undefined) {
    throw new Error('Missing required positional argument <variantId>');
  }

  return { variantId, keepAsset };
}

export async function main(
  argv: ReadonlyArray<string>,
  cwd: string,
  injectedDeps?: UnapproveQueueDeps,
): Promise<number> {
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

  try {
    const deps = injectedDeps ?? createDefaultCheckinDeps(repoRoot);
    if (deps.withCrossProcessLock === undefined) {
      throw new Error('Cross-process check-in lock is unavailable.');
    }
    const withLock = deps.withCrossProcessLock;
    const entry = await withLock(async () => {
      const manifestEntry = composeManifestFromShards(path.join(publicAssetsDir, 'generated'))
        .entries[parsed.variantId];
      if (manifestEntry === undefined) {
        throw new UnapproveError('not-found', `Manifest entry not found: ${parsed.variantId}`);
      }

      if (deps.listQueuedAssets === undefined) {
        throw new Error('Legacy asset-checkin inspection is unavailable.');
      }
      const queued = await deps.listQueuedAssets();
      const legacy = queued.get(manifestEntry.assetPath);
      if (legacy !== undefined) {
        throw new Error(
          `${manifestEntry.assetPath} is already queued for check-in (${legacy.issueUrl}). ` +
            'Close or retract that issue before unapproving it.',
        );
      }
      if (deps.inspectDurableQueueAsset === undefined) {
        throw new Error('Canonical assets/queue inspection is unavailable.');
      }
      const durable = await deps.inspectDurableQueueAsset({
        manifestKey: parsed.variantId,
        assetPath: manifestEntry.assetPath,
        ...(manifestEntry.contentHash !== undefined
          ? { contentHash: manifestEntry.contentHash }
          : {}),
        manifestEntry,
      });
      if (durable.reconciliation !== 'new') {
        throw new Error(
          `${manifestEntry.assetPath} cannot be unapproved while canonical ${durable.branch} ` +
            `reports ${durable.reconciliation}. Reconcile or remove the queued asset first.`,
        );
      }

      return unapproveVariant({
        variantId: parsed.variantId,
        manifestPath,
        catalogPath,
        publicAssetsDir,
        deleteAsset: !parsed.keepAsset,
      });
    });
    const deleted = !parsed.keepAsset;
    process.stdout.write(
      `Unapproved ${entry.briefId} variant ${entry.variantIndex} (${parsed.variantId})\n` +
        `  manifest: ${path.relative(repoRoot, manifestPath)}\n` +
        `  catalog:  ${path.relative(repoRoot, catalogPath)}\n` +
        (deleted
          ? `  deleted:  public/assets/generated/${parsed.variantId}.png\n`
          : `  asset kept (--keep-asset): public/assets/generated/${parsed.variantId}.png\n`),
    );
    return 0;
  } catch (err) {
    if (err instanceof UnapproveError) {
      process.stderr.write(`unapprove failed (${err.kind}): ${err.message}\n`);
      return err.kind === 'not-found' ? 2 : 3;
    }
    process.stderr.write(`unapprove failed: ${err instanceof Error ? err.message : String(err)}\n`);
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
