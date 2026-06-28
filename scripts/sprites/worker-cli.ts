#!/usr/bin/env node
/**
 * sprites:worker — long-running queue worker for sprite generation.
 *
 * Polls the configured AssetQueue and calls generateOne for each message.
 * Acks on success; leaves the message visible on failure so a fixed worker
 * can retry after the visibility timeout.
 *
 * Usage:
 *   npm run sprites:worker
 *
 * Environment variables
 * ---------------------
 * | Variable                          | Default         | Description                              |
 * |-----------------------------------|-----------------|------------------------------------------|
 * | SPRITES_ASSET_QUEUE               | noop            | `noop` or `azure-queue`                  |
 * | SPRITES_RUN_STORE                 | local           | `local` or `azure-blob`                  |
 * | SPRITES_PROVIDER                  | azure-openai    | Image provider                           |
 * | SPRITES_WORKER_POLL_MS            | 5000            | Poll interval in ms when queue is empty  |
 * | AZURE_STORAGE_ACCOUNT             | —               | Required for Azure queue / blob          |
 * | AZURE_STORAGE_KEY                 | —               | Required for Azure queue / blob          |
 * | AZURE_STORAGE_CONNECTION_STRING   | —               | Alternative to account+key               |
 *
 * See `infra/README.md` for full Azure setup instructions.
 *
 * Examples:
 *   # Local dev (noop queue — idle-loops waiting for work; Ctrl-C to stop):
 *   npm run sprites:worker
 *
 *   # Azure:
 *   SPRITES_ASSET_QUEUE=azure-queue \
 *   SPRITES_RUN_STORE=azure-blob \
 *   AZURE_STORAGE_ACCOUNT=crawlersprites \
 *   AZURE_STORAGE_KEY=<key> \
 *   npm run sprites:worker
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAssetQueue } from './queue/index.js';
import { createRunStore } from './store/index.js';
import {
  createBriefSelectorProvider,
  createImageProvider,
  createSynthProvider,
  createTextProvider,
  createVisionProvider,
} from './provider/factory.js';
import { runWorker } from './worker.js';
import type { WorkerStatus } from './worker.js';
import { createLogger } from '../../src/shared/logger.js';
import { createGhAssetRequestIssueApi } from './sidecar/asset-request-issue-api.js';

const logger = createLogger('infra:sprites:worker');

// This file lives at <repoRoot>/scripts/sprites/worker-cli.ts.
// Two parent traversals resolve to the repository root.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const pollMs = process.env['SPRITES_WORKER_POLL_MS']
  ? Number(process.env['SPRITES_WORKER_POLL_MS'])
  : 5_000;

// Graceful shutdown on SIGINT / SIGTERM.
const abortController = new AbortController();
const shutdown = () => abortController.abort();
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function onStatus(status: WorkerStatus): void {
  switch (status.type) {
    case 'idle':
      // Omit — would flood stdout; debug-level only.
      break;
    case 'processing':
      logger.info(`processing brief: ${status.briefId}`);
      break;
    case 'done':
      logger.info(`done: ${status.briefId} → run ${status.runId} (${status.summaryPath})`);
      break;
    case 'error':
      logger.error(`error processing ${status.briefId}: ${status.error.message}`);
      break;
    case 'stopping':
      logger.info('worker stopping');
      break;
  }
}

async function main(): Promise<void> {
  const queue = createAssetQueue();
  const store = createRunStore({ repoRoot });
  const provider = createImageProvider();
  const textProvider = createTextProvider();
  let synthProvider = null;
  try {
    synthProvider = createSynthProvider();
  } catch {
    // Optional unless processing issue-originated jobs.
  }
  const briefSelectorProvider = createBriefSelectorProvider();
  const visionProvider = createVisionProvider();
  const issueApi = createGhAssetRequestIssueApi(repoRoot);

  logger.info(`worker started (queue=${queue.backend}, store=${store.backend}, pollMs=${pollMs})`);

  await runWorker({
    queue,
    store,
    repoRoot,
    provider,
    textProvider,
    synthProvider,
    briefSelectorProvider,
    visionProvider,
    issueApi,
    pollIntervalMs: pollMs,
    signal: abortController.signal,
    onStatus,
  });

  logger.info('worker exited cleanly');
}

main().catch((err) => {
  process.stderr.write(
    `sprites:worker fatal error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
