/**
 * Regression guard: sidecar CLI must never auto-start the queue worker or
 * issue ingester on the `azure-queue` backend.
 *
 * Background (GitHub issue #1879): a stale long-running sidecar silently raced
 * the CI `asset-request.yml` workflow for production queue messages because
 * `cli.ts` called `worker.start()` and `issueIngester.start()` automatically
 * whenever the queue backend was `azure-queue`. This guard prevents that from
 * regressing.
 *
 * The worker and ingester are still available on-demand via the HTTP API routes
 * (`POST /api/workflow/worker/start`, `POST /api/workflow/issues/start`) and
 * the devtools "Launch worker" button, so the fix does not break any UX.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('sidecar CLI no-autostart guard (issue #1879)', () => {
  const source = readFileSync('scripts/sprites/sidecar/cli.ts', 'utf-8');

  it('does not call worker.start() at sidecar startup', () => {
    // worker.start() must only appear in server routes, not in the CLI's
    // post-listen startup sequence, to prevent racing the CI queue consumer.
    expect(source).not.toContain('worker.start()');
  });

  it('does not call issueIngester.start() at sidecar startup', () => {
    // issueIngester.start() must only appear in server routes, not in the CLI's
    // post-listen startup sequence, to prevent the sidecar from scanning/enqueuing
    // GitHub asset-request issues against the production Azure queue.
    expect(source).not.toContain('issueIngester.start()');
  });
});
