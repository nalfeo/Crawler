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
 * | Variable                          | Default         | Description                                          |
 * |-----------------------------------|-----------------|------------------------------------------------------|
 * | SPRITES_ASSET_QUEUE               | noop            | `noop` or `azure-queue`                              |
 * | SPRITES_RUN_STORE                 | local           | `local` or `azure-blob`                              |
 * | SPRITES_PROVIDER                  | azure-openai    | Image provider                                       |
 * | SPRITES_WORKER_POLL_MS            | 5000            | Poll interval in ms when queue is empty              |
 * | SPRITES_WORKER_CONCURRENCY         | 1               | Queue requests processed concurrently                |
 * | SPRITES_WORKER_DRAIN              | (unset)         | When truthy, exit after N consecutive empty polls    |
 * | SPRITES_WORKER_MAX_EMPTY_POLLS    | 3               | N for drain-mode (only used when DRAIN is truthy)    |
 * | AZURE_STORAGE_ACCOUNT             | —               | Required for Azure queue / blob                      |
 * | AZURE_STORAGE_KEY                 | —               | Required for Azure queue / blob                      |
 * | AZURE_STORAGE_CONNECTION_STRING   | —               | Alternative to account+key                           |
 *
 * Exit codes:
 *   0 — clean exit (long-running mode on signal; drain mode after N empty polls with no errors).
 *   1 — drain mode observed one or more `error` statuses. Non-drain mode never
 *       returns 1 on message-level errors — those are left visible in the queue
 *       for retry, and the process keeps running.
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
 *
 *   # CI drain-mode: exits with 0 once the queue is empty (used by .github/workflows/asset-request.yml)
 *   SPRITES_WORKER_DRAIN=true \
 *   SPRITES_ASSET_QUEUE=azure-queue SPRITES_RUN_STORE=azure-blob \
 *   ...creds... npm run sprites:worker
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
import {
  createDrainOnStatus,
  isTruthyEnv,
  parsePositiveIntegerEnv,
  resolveDrainExitCode,
} from './worker-cli-lib.js';

const logger = createLogger('infra:sprites:worker');

// This file lives at <repoRoot>/scripts/sprites/worker-cli.ts.
// Two parent traversals resolve to the repository root.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const pollMs = process.env['SPRITES_WORKER_POLL_MS']
  ? Number(process.env['SPRITES_WORKER_POLL_MS'])
  : 5_000;

const drainMode = isTruthyEnv(process.env['SPRITES_WORKER_DRAIN']);
const maxEmptyPolls = process.env['SPRITES_WORKER_MAX_EMPTY_POLLS']
  ? Number(process.env['SPRITES_WORKER_MAX_EMPTY_POLLS'])
  : 3;
const concurrency = parsePositiveIntegerEnv(
  process.env['SPRITES_WORKER_CONCURRENCY'],
  1,
  'SPRITES_WORKER_CONCURRENCY',
);

// Graceful shutdown on SIGINT / SIGTERM.
const abortController = new AbortController();
const shutdown = () => abortController.abort();
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Count `error` statuses so drain mode can fail-loud instead of silently
// exiting 0 when a message errored (Azure Queue would then keep the message
// invisible for its visibility timeout — potentially hiding a broken run).
let errorCount = 0;

function baseOnStatus(status: WorkerStatus): void {
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
      errorCount += 1;
      logger.error(`error processing ${status.briefId}: ${status.error.message}`);
      break;
    case 'stopping':
      logger.info('worker stopping');
      break;
  }
}

const onStatus = drainMode
  ? createDrainOnStatus({
      base: baseOnStatus,
      maxEmptyPolls,
      abort: shutdown,
      onDrain: () => logger.info(`drain mode: queue empty for ${maxEmptyPolls} polls, exiting`),
    })
  : baseOnStatus;

async function main(): Promise<number> {
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

  logger.info(
    `worker started (queue=${queue.backend}, store=${store.backend}, pollMs=${pollMs}, concurrency=${concurrency}${
      drainMode ? `, drain=true, maxEmptyPolls=${maxEmptyPolls}` : ''
    })`,
  );

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
    concurrency,
    signal: abortController.signal,
    onStatus,
  });

  logger.info('worker exited cleanly');
  const exitCode = resolveDrainExitCode({ drainMode, errorCount });
  if (exitCode !== 0) {
    logger.error(
      `drain: ${errorCount} error(s) observed while draining; failing the CI step so the failure isn't hidden by Azure Queue's visibility timeout`,
    );
  }
  return exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(
      `sprites:worker fatal error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
