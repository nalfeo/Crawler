#!/usr/bin/env node
/**
 * sprites:enrich-tags — backfill free-form LLM tags on every generated sprite shard.
 *
 * Reads all shards in `public/assets/generated/entries/`, skips placeholders and
 * entries that already have `catalog.tags` set (idempotent by default), calls the
 * Azure OpenAI chat API to generate 5-15 descriptive tags per sprite, then writes
 * them back as `catalog.tags` on the shard JSON.
 *
 * Usage:
 *   npm run sprites:enrich-tags
 *   npm run sprites:enrich-tags -- --dry-run
 *   npm run sprites:enrich-tags -- --force   (re-enrich even if tags already set)
 *   npm run sprites:enrich-tags -- --key anvil-v1-var-0   (single shard)
 *
 * Requires Azure OpenAI chat credentials in env:
 *   AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY,
 *   AZURE_OPENAI_CHAT_DEPLOYMENT (or AZURE_OPENAI_VISION_DEPLOYMENT as fallback)
 */

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  listShardRelPaths,
  readShard,
  writeShard,
  keyFromShardRelPath,
} from './generated-shards.js';
import { formatJsonFiles } from './catalog-io.js';
import { createEnrichTagsProvider, type EnrichTagsRequest } from './enrich-tags.js';
import { isPlaceholderManifestEntry } from '../../src/shared/generated-catalog.js';
import type { ManifestEntry } from '../../src/shared/generated-assets.js';

const DEFAULT_GENERATED_DIR = path.join('public', 'assets', 'generated');
const ENRICH_TIMEOUT_MS = 30_000;
const CONCURRENCY = 5;

interface CliArgs {
  readonly generatedDir: string;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly key: string | null;
}

function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  let generatedDir = DEFAULT_GENERATED_DIR;
  let dryRun = false;
  let force = false;
  let key: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--key' || arg === '-k') {
      const next = argv[++i];
      if (!next) throw new Error('--key requires a value');
      key = next;
    } else if (arg.startsWith('--key=')) {
      key = arg.slice('--key='.length);
    } else if (arg === '--generated-dir') {
      const next = argv[++i];
      if (!next) throw new Error('--generated-dir requires a value');
      generatedDir = next;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
  }

  return { generatedDir, dryRun, force, key };
}

function printHelp(): void {
  process.stdout.write(
    [
      'sprites:enrich-tags — backfill LLM tags on generated sprite shards',
      '',
      'Usage:',
      '  npm run sprites:enrich-tags',
      '  npm run sprites:enrich-tags -- [options]',
      '',
      'Options:',
      '  --dry-run              Show what would be enriched; do not write',
      '  --force                Re-enrich even if catalog.tags already set',
      '  --key <manifestKey>    Enrich a single shard by manifest key',
      '  --generated-dir <dir>  Override generated assets directory',
      '  --help, -h             Show this help',
      '',
    ].join('\n'),
  );
}

function isPlaceholder(entry: ManifestEntry): boolean {
  return isPlaceholderManifestEntry(entry);
}

function hasExistingTags(entry: ManifestEntry): boolean {
  const tags = entry.catalog?.tags;
  return Array.isArray(tags) && tags.length > 0;
}

function buildRequest(key: string, entry: ManifestEntry): EnrichTagsRequest {
  return {
    manifestKey: key,
    type: entry.type ?? null,
    description: entry.catalog?.description ?? '',
    briefId: entry.briefId ?? key.replace(/-var-\d+$/, ''),
  };
}

async function processKeys(
  keys: string[],
  generatedDir: string,
  provider: NonNullable<ReturnType<typeof createEnrichTagsProvider>> | null,
  args: CliArgs,
): Promise<{ enriched: number; skipped: number; failed: number }> {
  let enriched = 0;
  let skipped = 0;
  let failed = 0;
  let done = 0;
  const total = keys.length;

  const printProgress = (): void => {
    const pct = total > 0 ? Math.round((done / total) * 100) : 100;
    process.stdout.write(
      `\r  ${done}/${total} (${pct}%) — enriched:${enriched} skipped:${skipped} failed:${failed}  `,
    );
  };

  // Process in batches for bounded concurrency
  for (let i = 0; i < keys.length; i += CONCURRENCY) {
    const batch = keys.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (key) => {
        const entry = readShard(generatedDir, key);
        if (!entry) {
          done++;
          skipped++;
          printProgress();
          return;
        }

        if (isPlaceholder(entry)) {
          done++;
          skipped++;
          printProgress();
          return;
        }

        if (!args.force && hasExistingTags(entry)) {
          done++;
          skipped++;
          printProgress();
          return;
        }

        if (args.dryRun) {
          process.stdout.write(`\n  [dry-run] would enrich: ${key}`);
          done++;
          enriched++;
          printProgress();
          return;
        }

        try {
          const request = buildRequest(key, entry);
          const tags = await provider!.generateTags(request);
          const updatedEntry: ManifestEntry = {
            ...entry,
            catalog: {
              ...entry.catalog,
              tags,
            },
          };
          const shardPath = writeShard(generatedDir, key, updatedEntry);
          await formatJsonFiles([shardPath]);
          done++;
          enriched++;
        } catch (err) {
          process.stderr.write(`\n  ✗ ${key}: ${err instanceof Error ? err.message : String(err)}`);
          done++;
          failed++;
        }
        printProgress();
      }),
    );
  }

  process.stdout.write('\n');
  return { enriched, skipped, failed };
}

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n`);
    printHelp();
    return 2;
  }

  const repoRoot = process.cwd();
  const generatedDir = path.isAbsolute(args.generatedDir)
    ? args.generatedDir
    : path.join(repoRoot, args.generatedDir);

  // Provider is not needed for dry-run — only require it when actually writing.
  let provider: NonNullable<ReturnType<typeof createEnrichTagsProvider>> | null = null;
  if (!args.dryRun) {
    provider = createEnrichTagsProvider({
      env: process.env as Record<string, string>,
      timeoutMs: ENRICH_TIMEOUT_MS,
    });
    if (!provider) {
      process.stderr.write(
        'enrich-tags: Azure OpenAI chat deployment not configured.\n' +
          'Set AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, and\n' +
          'AZURE_OPENAI_CHAT_DEPLOYMENT (or AZURE_OPENAI_VISION_DEPLOYMENT) in your env.\n',
      );
      return 1;
    }
  }

  let keys: string[];
  if (args.key) {
    keys = [args.key];
  } else {
    const relPaths = listShardRelPaths(generatedDir);
    keys = relPaths.map(keyFromShardRelPath);
  }

  if (keys.length === 0) {
    process.stdout.write('No shards found.\n');
    return 0;
  }

  process.stdout.write(
    `enrich-tags: ${keys.length} shard(s) found` +
      (args.dryRun ? ' [dry-run]' : '') +
      (args.force ? ' [force]' : '') +
      '\n',
  );

  const { enriched, skipped, failed } = await processKeys(keys, generatedDir, provider, args);

  process.stdout.write(
    `\nenrich-tags complete: ${enriched} enriched, ${skipped} skipped, ${failed} failed\n`,
  );

  return failed > 0 ? 1 : 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const thisPath = path.resolve(fileURLToPath(import.meta.url).replace(/^\/([A-Za-z]:)/, '$1'));
if (invokedPath === thisPath) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(
        `fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
      process.exit(1);
    },
  );
}
