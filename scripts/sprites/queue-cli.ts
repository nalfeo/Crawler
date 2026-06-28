#!/usr/bin/env node
/**
 * sprites:enqueue — submit an asset-generation request to the queue.
 *
 * Usage:
 *   npm run sprites:enqueue -- --brief <briefId> --path <briefPath> [options]
 *
 * Options:
 *   --brief  <id>     Brief name / ID slug (e.g. iron-sword)           [required]
 *   --path   <path>   Repo-relative path to the brief YAML             [required]
 *   --by     <name>   Requestor identifier (default: current $USER)
 *   --priority high|normal  Queue priority (default: normal)
 *
 * The queue backend is selected by SPRITES_ASSET_QUEUE (see queue/index.ts).
 * Defaults to 'noop' (prints the request and exits) so local invocations
 * work without Azure credentials.
 *
 * Examples:
 *   # Local dev (noop — just prints):
 *   npm run sprites:enqueue -- --brief iron-sword --path briefs/weapons/iron-sword.yaml
 *
 *   # Real queue (set env vars first):
 *   SPRITES_ASSET_QUEUE=azure-queue \
 *     AZURE_STORAGE_ACCOUNT=crawlersprites \
 *     AZURE_STORAGE_KEY=<key> \
 *     npm run sprites:enqueue -- --brief iron-sword --path briefs/weapons/iron-sword.yaml
 */

import process from 'node:process';
import { createAssetQueue } from './queue/index.js';
import type { AssetRequest } from './queue/index.js';

interface CliArgs {
  readonly briefId: string;
  readonly briefPath: string;
  readonly requestedBy: string;
  readonly priority: 'normal' | 'high';
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args = argv.slice(2);
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : undefined;
  };

  const briefId = get('--brief');
  const briefPath = get('--path');

  if (!briefId) {
    process.stderr.write('Error: --brief <briefId> is required.\n');
    process.exit(1);
  }
  if (!briefPath) {
    process.stderr.write('Error: --path <briefPath> is required.\n');
    process.exit(1);
  }

  const by = get('--by') ?? process.env['USER'] ?? process.env['USERNAME'] ?? 'unknown';
  const rawPriority = get('--priority') ?? 'normal';
  if (rawPriority !== 'normal' && rawPriority !== 'high') {
    process.stderr.write(`Error: --priority must be 'normal' or 'high', got '${rawPriority}'.\n`);
    process.exit(1);
  }

  return { briefId, briefPath, requestedBy: by, priority: rawPriority };
}

async function main(): Promise<void> {
  const { briefId, briefPath, requestedBy, priority } = parseArgs(process.argv);

  const queue = createAssetQueue();

  const request: AssetRequest = {
    kind: 'brief-path',
    briefId,
    briefPath,
    requestedBy,
    priority,
    requestedAt: new Date().toISOString(),
  };

  await queue.enqueue(request);

  if (queue.backend !== 'noop') {
    process.stdout.write(
      `✓ Enqueued: ${briefId} → ${queue.backend} (priority=${priority}, by=${requestedBy})\n`,
    );
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `sprites:enqueue failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
