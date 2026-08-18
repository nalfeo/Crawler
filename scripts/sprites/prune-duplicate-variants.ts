/**
 * Remove same-brief duplicate sprite variants without collapsing legitimate
 * visual variants.
 *
 * For each brief, contentHash is the identity of a visual variant. When the
 * same hash appears in multiple `-var-N` entries, the lowest variant index is
 * retained and the other shard/PNG pairs are removed. Entries without a
 * contentHash are left untouched because their identity cannot be proven.
 *
 * Usage:
 *   tsx scripts/sprites/prune-duplicate-variants.ts --dry-run
 *   tsx scripts/sprites/prune-duplicate-variants.ts --apply
 *   tsx scripts/sprites/prune-duplicate-variants.ts --apply \
 *     --generated-dir path/to/public/assets/generated
 */
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { deleteShard, readAllShards } from './generated-shards.js';

export interface DuplicatePruneOptions {
  readonly generatedDir: string;
  readonly apply: boolean;
}

export interface DuplicatePruneResult {
  readonly retained: Readonly<Record<string, string>>;
  readonly pruned: readonly string[];
}

interface Variant {
  readonly key: string;
  readonly contentHash: string;
  readonly variantIndex: number;
  readonly assetPath: string;
}

const VARIANT_KEY_RE = /^(.+)-var-(\d+)$/;

function assetAbsPath(generatedDir: string, assetPath: string): string {
  return path.join(generatedDir, path.basename(assetPath));
}

function compareVariants(left: Variant, right: Variant): number {
  return left.variantIndex - right.variantIndex || left.key.localeCompare(right.key);
}

export function planDuplicateVariantPruning(generatedDir: string): DuplicatePruneResult {
  const entries = readAllShards(generatedDir) as unknown as Record<string, Record<string, unknown>>;
  const groups = new Map<string, Variant[]>();

  for (const [key, entry] of Object.entries(entries)) {
    const match = VARIANT_KEY_RE.exec(key);
    if (
      match === null ||
      typeof entry.briefId !== 'string' ||
      typeof entry.contentHash !== 'string' ||
      typeof entry.variantIndex !== 'number'
    ) {
      continue;
    }
    const variant: Variant = {
      key,
      contentHash: entry.contentHash,
      variantIndex: entry.variantIndex,
      assetPath: typeof entry.assetPath === 'string' ? entry.assetPath : '',
    };
    const groupKey = `${entry.briefId}\u0000${variant.contentHash}`;
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), variant]);
  }

  const retained: Record<string, string> = {};
  const pruned: string[] = [];
  for (const variants of groups.values()) {
    variants.sort(compareVariants);
    const keeper = variants[0];
    if (keeper === undefined) continue;
    retained[keeper.key] = keeper.contentHash;
    for (const duplicate of variants.slice(1)) {
      pruned.push(duplicate.key);
    }
  }
  pruned.sort((left, right) => left.localeCompare(right));

  return { retained, pruned };
}

export function pruneDuplicateVariants(options: DuplicatePruneOptions): DuplicatePruneResult {
  const result = planDuplicateVariantPruning(options.generatedDir);
  if (!options.apply) return result;

  const entries = readAllShards(options.generatedDir) as unknown as Record<
    string,
    Record<string, unknown>
  >;
  for (const key of result.pruned) {
    const assetPath = typeof entries[key]?.assetPath === 'string' ? entries[key].assetPath : '';
    if (assetPath !== '') {
      const png = assetAbsPath(options.generatedDir, assetPath);
      if (existsSync(png)) rmSync(png);
    }
    deleteShard(options.generatedDir, key);
  }
  return result;
}

function parseFlagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function main(argv: readonly string[]): number {
  const apply = argv.includes('--apply');
  const generatedDir = parseFlagValue(argv, '--generated-dir') ?? 'public/assets/generated';
  const result = pruneDuplicateVariants({ generatedDir, apply });

  console.log(`mode: ${apply ? 'apply' : 'dry-run'}`);
  console.log(`distinct hashes retained: ${Object.keys(result.retained).length}`);
  console.log(`duplicate entries pruned: ${result.pruned.length}`);
  for (const key of result.pruned) console.log(`  DUPLICATE ${key}`);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
