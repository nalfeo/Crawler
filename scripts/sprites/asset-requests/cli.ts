/**
 * CLI for the immutable asset-request workflow (issue #3205).
 *
 * Subcommands:
 *   publish     seal a request from live on-disk art and push its immutable ref
 *   reconcile   materialize a promotion from unresolved request refs at main
 *   archive     archive the requests a proven-merged promotion consumed
 *   migrate     classify the final `assets/queue` tip for cutover approval
 *   snapshot    back up the legacy queue/check-in refs immutably before retirement
 *
 * Every subcommand prints a JSON result to stdout. Exit codes:
 *   0  success (including a clean no-op)
 *   10 usage error
 *   20 at least one request was refused (reconcile) / unclassified paths remain
 *   1  any other failure
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  sha256Bytes,
  type AssetRequestAnnotation,
  type AssetRequestAsset,
  type AssetRequestManifestBody,
  type AssetRequestOperation,
} from './manifest.js';
import { publishAssetRequest } from './publish.js';
import { archiveConsumedRequests, materializeAssetRequests } from './reconcile.js';
import { classifyQueueTip, renderMigrationReport, snapshotLegacyQueue } from './migrate-queue.js';
import { createDefaultMaterializeDeps, createDefaultPublishDeps } from './runtime.js';

export class UsageError extends Error {}

export interface ParsedArgs {
  readonly command: 'publish' | 'reconcile' | 'archive' | 'migrate' | 'snapshot';
  readonly repoRoot: string;
  readonly flags: Readonly<Record<string, string[]>>;
}

/** Parse `--flag value` pairs plus a leading subcommand. Repeats accumulate. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (
    command !== 'publish' &&
    command !== 'reconcile' &&
    command !== 'archive' &&
    command !== 'migrate' &&
    command !== 'snapshot'
  ) {
    throw new UsageError(
      `unknown subcommand "${String(command)}"; expected publish|reconcile|archive|migrate|snapshot`,
    );
  }
  const flags: Record<string, string[]> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === undefined || !token.startsWith('--')) {
      throw new UsageError(`unexpected argument "${String(token)}"`);
    }
    const name = token.slice(2);
    const next = rest[index + 1];
    if (next === undefined || next.startsWith('--')) {
      (flags[name] ??= []).push('true');
      continue;
    }
    (flags[name] ??= []).push(next);
    index += 1;
  }
  const repoRoot = flags['repo-root']?.[0] ?? process.cwd();
  return { command, repoRoot, flags };
}

function single(flags: ParsedArgs['flags'], name: string): string | undefined {
  const values = flags[name];
  if (values === undefined) return undefined;
  if (values.length > 1) throw new UsageError(`--${name} may only be given once`);
  return values[0];
}

function required(flags: ParsedArgs['flags'], name: string): string {
  const value = single(flags, name);
  if (value === undefined) throw new UsageError(`--${name} is required`);
  return value;
}

/**
 * Build a publish body from repeated `--asset`/`--manifest-key` (upsert),
 * `--annotation` (JSON per key), or `--removal` (JSON per removal) flags.
 */
export function buildPublishBody(
  flags: ParsedArgs['flags'],
  observedMainSha: string,
  hashAsset: (assetPath: string) => string,
): AssetRequestManifestBody {
  const assetPaths = flags.asset ?? [];
  const manifestKeys = flags['manifest-key'] ?? [];
  const briefIds = flags['brief-id'] ?? [];
  const variantIndexes = flags['variant-index'] ?? [];
  const sourceRuns = flags['source-run'] ?? [];
  const annotationsRaw = flags.annotation ?? [];
  const removalsRaw = flags.removal ?? [];

  const populated = [
    assetPaths.length > 0 ? 'asset' : null,
    annotationsRaw.length > 0 ? 'annotation' : null,
    removalsRaw.length > 0 ? 'removal' : null,
  ].filter((entry) => entry !== null);
  if (populated.length !== 1) {
    throw new UsageError('pass exactly one of --asset, --annotation or --removal (repeatable)');
  }

  let operation: AssetRequestOperation = 'upsert-asset';
  const assets: AssetRequestAsset[] = [];
  const annotations: AssetRequestAnnotation[] = [];
  const removals: AssetRequestManifestBody['removals'][number][] = [];

  if (assetPaths.length > 0) {
    if (manifestKeys.length !== assetPaths.length) {
      throw new UsageError('each --asset needs a matching --manifest-key');
    }
    for (let index = 0; index < assetPaths.length; index += 1) {
      const assetPath = assetPaths[index] ?? '';
      const variantRaw = variantIndexes[index];
      assets.push({
        assetPath,
        manifestKey: manifestKeys[index] ?? '',
        contentHash: hashAsset(assetPath),
        briefId: briefIds[index] ?? '',
        variantIndex: variantRaw === undefined ? 0 : Number.parseInt(variantRaw, 10),
        sourceRun: sourceRuns[index] ?? null,
      });
    }
  } else if (annotationsRaw.length > 0) {
    operation = 'update-annotations';
    for (const raw of annotationsRaw) {
      annotations.push(JSON.parse(raw) as AssetRequestAnnotation);
    }
  } else {
    operation = 'remove-asset';
    for (const raw of removalsRaw) {
      removals.push(JSON.parse(raw) as AssetRequestManifestBody['removals'][number]);
    }
  }

  const provenance: Record<string, string> = {};
  for (const entry of flags.provenance ?? []) {
    const separator = entry.indexOf('=');
    if (separator <= 0) throw new UsageError(`--provenance expects key=value, got "${entry}"`);
    provenance[entry.slice(0, separator)] = entry.slice(separator + 1);
  }

  return {
    version: 1,
    operation,
    assets,
    annotations,
    removals,
    observedMainSha,
    producer: single(flags, 'producer') ?? 'asset-request-cli',
    provenance,
    supersedes: single(flags, 'supersedes') ?? null,
  };
}

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const { repoRoot, flags } = parsed;

  if (parsed.command === 'publish') {
    const observedMainSha =
      single(flags, 'observed-main') ??
      execFileSync('git', ['rev-parse', 'origin/main'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    const sourceRoot = single(flags, 'source-root') ?? repoRoot;
    const body = buildPublishBody(flags, observedMainSha, (assetPath) =>
      sha256Bytes(readFileSync(path.join(sourceRoot, 'public', 'assets', ...assetPath.split('/')))),
    );
    const result = await publishAssetRequest(repoRoot, body, createDefaultPublishDeps(), {
      remote: single(flags, 'remote'),
      sourceRoot,
      push: single(flags, 'no-push') === undefined,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  if (parsed.command === 'reconcile') {
    const result = await materializeAssetRequests(repoRoot, createDefaultMaterializeDeps(), {
      remote: single(flags, 'remote'),
      baseBranch: single(flags, 'base-branch'),
      promoteBranch: single(flags, 'promote-branch'),
      push: single(flags, 'no-push') === undefined,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.outcomes.some((outcome) => outcome.disposition === 'refused') ? 20 : 0;
  }

  if (parsed.command === 'archive') {
    const result = await archiveConsumedRequests(
      repoRoot,
      required(flags, 'promotion-commit'),
      createDefaultMaterializeDeps(),
      { remote: single(flags, 'remote'), baseBranch: single(flags, 'base-branch') },
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  if (parsed.command === 'snapshot') {
    const result = await snapshotLegacyQueue(repoRoot, createDefaultMaterializeDeps(), {
      remote: single(flags, 'remote'),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  const report = await classifyQueueTip(repoRoot, createDefaultMaterializeDeps(), {
    baseRef: single(flags, 'base-ref'),
    queueRef: single(flags, 'queue-ref'),
  });
  const rendered = renderMigrationReport(report);
  const outputPath = single(flags, 'out');
  if (outputPath === undefined) process.stdout.write(rendered);
  else writeFileSync(path.resolve(repoRoot, outputPath), rendered, 'utf8');
  return report.unclassifiedPaths.length > 0 ? 20 : 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      if (error instanceof UsageError) {
        process.stderr.write(`usage: ${error.message}\n`);
        process.exitCode = 10;
        return;
      }
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
