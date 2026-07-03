#!/usr/bin/env node
/**
 * sprites:ingest-once — run one asset-request-issue ingest poll and exit.
 *
 * Companion to `sprites:worker` for CI: `.github/workflows/asset-request.yml`
 * runs this first to scan open `asset-request`-labeled GitHub issues, enqueue
 * any new ones into the Azure queue (deduped by `issueNumber:fingerprint`),
 * and update the shared blob state file. The worker then drains the queue.
 *
 * Unlike the long-running ingester inside `sprites:gallery`'s sidecar server
 * (see `scripts/sprites/sidecar/issue-ingester-controller.ts`), this CLI does
 * NOT arm a background timer — it awaits a single `pollOnce()` and exits with
 * a JSON status summary. That's exactly the semantic a CI step needs: fully
 * synchronous with respect to enqueue + state save (no `process.exit` race),
 * and safe to re-run because dedupe lives in the state file, not in memory.
 *
 * Usage:
 *   npm run sprites:ingest-once
 *
 * Environment variables (subset — see queue/store/factory modules for the full list)
 * -----------------------------------------------------------------------------------
 * | Variable                          | Description                                     |
 * |-----------------------------------|-------------------------------------------------|
 * | SPRITES_ASSET_QUEUE=azure-queue   | Enqueue destination                             |
 * | SPRITES_RUN_STORE=azure-blob      | Where the ingest state file is persisted        |
 * | SPRITES_INGESTER_ALLOWED_AUTHORS  | Comma-separated GitHub logins allowed to file   |
 * |                                   | asset-request issues. Unset = allow all         |
 * |                                   | (local dev). CI sets this to fail-closed        |
 * |                                   | on drive-by issues in the public repo.          |
 * | AZURE_STORAGE_ACCOUNT             | Required for the Azure queue + blob backend     |
 * | AZURE_STORAGE_KEY                 | ↑                                               |
 * | GITHUB_ACTOR                      | Recorded as `requestedBy` on queued messages    |
 *
 * The `gh` CLI must be authenticated (`GH_TOKEN`/`GITHUB_TOKEN` env var is
 * enough on `ubuntu-latest`) — {@link createGhAssetRequestIssueApi} shells out
 * to `gh issue list`.
 *
 * Exit codes:
 *   0 — poll succeeded (0 or more issues enqueued)
 *   1 — poll failed; the error is included in the JSON summary
 */

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createAssetQueue } from './queue/index.js';
import { createRunStore } from './store/index.js';
import { createLogger } from '../../src/shared/logger.js';
import { createGhAssetRequestIssueApi } from './sidecar/asset-request-issue-api.js';
import { createIssueIngesterController } from './sidecar/issue-ingester-controller.js';
import {
  exitCodeForStatus,
  resolveAllowedAuthorLogins,
  resolveRequestedBy,
  withAuthorAllowList,
} from './ingest-once-cli-lib.js';

const logger = createLogger('infra:sprites:ingest-once');

// This file lives at <repoRoot>/scripts/sprites/ingest-once-cli.ts.
// Two parent traversals resolve to the repository root.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function main(): Promise<number> {
  const queue = createAssetQueue();
  const store = createRunStore({ repoRoot });
  const rawIssues = createGhAssetRequestIssueApi(repoRoot);
  const allowedAuthors = resolveAllowedAuthorLogins(process.env);
  const issues = allowedAuthors ? withAuthorAllowList(rawIssues, allowedAuthors) : rawIssues;
  const requestedBy = resolveRequestedBy(process.env);

  logger.info(
    `ingest-once starting (queue=${queue.backend}, store=${store.backend}, requestedBy=${requestedBy}, allowedAuthors=${allowedAuthors ? [...allowedAuthors].join(',') : 'ALL'})`,
  );

  const controller = createIssueIngesterController({
    queue,
    store,
    issues,
    requestedBy,
    // Kept long so that even if pollOnce internally schedules a follow-up, it
    // would not fire within a realistic CI run. Not strictly required — the
    // public pollOnce() does NOT arm the internal setTimeout loop — but it's a
    // belt-and-suspenders default for anyone who refactors this later.
    pollIntervalMs: 24 * 60 * 60 * 1000,
  });

  const status = await controller.pollOnce();

  logger.info(
    `ingest-once complete: enqueued=${status.enqueued}, skippedDuplicate=${status.skippedDuplicate}, lastError=${status.lastError ?? 'none'}`,
  );
  process.stdout.write(`${JSON.stringify(status)}\n`);
  return exitCodeForStatus(status);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(
      `sprites:ingest-once fatal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });
