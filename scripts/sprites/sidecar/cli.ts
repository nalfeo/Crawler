#!/usr/bin/env node
/**
 * sprites:gallery sidecar entry point.
 *
 * Binds the Fastify server from `./server.ts` to **127.0.0.1** only — never
 * 0.0.0.0 — and uses a deterministic per-session port by default.
 * Per the spec's secrets-stay-local rule (§F8), it runs in the
 * foreground; Ctrl-C (SIGINT) or SIGTERM gracefully closes the server and
 * releases the port. An orphaned sidecar process from a prior run would
 * otherwise force operators to hunt PIDs.
 *
 * Backends: the sidecar loads `.env.local` and defaults to the **Azure**
 * run-store + queue (`store=azure-blob`, `queue=azure-queue`) — see
 * `./backend-config.ts`. The local/noop backends are reserved for tests and
 * explicit local runs (`SPRITES_RUN_STORE=local SPRITES_ASSET_QUEUE=noop`);
 * the sidecar never silently falls back to them. When Azure is selected but
 * credentials are missing it exits non-zero with setup guidance.
 *
 * No CLI flags today: the sidecar's location is implicit (`process.cwd()`),
 * the default port is derived from the current worktree, and the routes are
 * static. Add flags here if/when those need to vary.
 */

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAssetQueue } from '../queue/index.js';
import { createRunStore } from '../store/index.js';
import { getSessionServerPorts } from '../../shared/session-server-ports.js';
import {
  resolveSidecarBackends,
  SidecarAzureCredentialsError,
  type SidecarBackendSelection,
} from './backend-config.js';
import { loadEnvLocal } from './env-local.js';
import { buildServer } from './server.js';
import { createWorkerController } from './worker-controller.js';
import { createIssueIngesterController } from './issue-ingester-controller.js';
import { createGhAssetRequestIssueApi } from './asset-request-issue-api.js';
import { releaseSidecarRegistry } from './service-manager.js';
import { SPRITE_SIDECAR_SERVICE_VERSION, type SidecarServiceControl } from './service-contract.js';

const HOST = '127.0.0.1';
function resolvePort(defaultPort: number): number {
  // SPRITES_SIDECAR_PORT lets tests bind to a free port (commonly 0 →
  // "any") so they never race a real instance on the session sidecar port.
  // Production usage (`npm run sprites:gallery`) leaves it unset and gets the
  // deterministic per-session port.
  const raw = process.env['SPRITES_SIDECAR_PORT'];
  if (!raw) return defaultPort;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 65535) {
    process.stderr.write(
      `sprites:gallery sidecar: invalid SPRITES_SIDECAR_PORT=${raw}, using ${defaultPort}\n`,
    );
    return defaultPort;
  }
  return n;
}

async function main(): Promise<number> {
  const repoRoot = process.cwd();
  const managedInstanceId = process.env['CRAWLER_SIDECAR_INSTANCE_ID'];
  const managedShutdownToken = process.env['CRAWLER_SIDECAR_SHUTDOWN_TOKEN'];
  const managedStartedAt = process.env['CRAWLER_SIDECAR_STARTED_AT'];
  const managedRegistryPath = process.env['CRAWLER_SIDECAR_REGISTRY_PATH'];
  const managedCodeProvenance = process.env['CRAWLER_SIDECAR_CODE_PROVENANCE'];

  // Pick up Azure credentials + SPRITES_* selectors from .env.local (written by
  // `npm run setup:azure`) without overwriting anything already in the shell.
  loadEnvLocal(repoRoot);
  const sessionPorts = getSessionServerPorts({ cwd: repoRoot, env: process.env });

  // The sidecar defaults to the shared Azure backends; local/noop are opt-in
  // for tests and offline runs. Fail fast (don't silently use local) when Azure
  // is selected but credentials are missing.
  let backends: SidecarBackendSelection;
  try {
    backends = resolveSidecarBackends(process.env);
  } catch (err) {
    if (err instanceof SidecarAzureCredentialsError) {
      process.stderr.write(`sprites:gallery sidecar: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
  // Publish the resolved selectors so the store/queue factories (which read
  // process.env) build the Azure-default backends unless the caller opted into
  // local/noop explicitly.
  process.env['SPRITES_RUN_STORE'] = backends.runStore;
  process.env['SPRITES_ASSET_QUEUE'] = backends.assetQueue;

  const runsDir = path.join(repoRoot, 'generated', 'runs');
  const store = createRunStore({ repoRoot });
  const queue = createAssetQueue();
  const worker = createWorkerController({ queue, store, repoRoot });
  const issueIngester = createIssueIngesterController({
    queue,
    store,
    requestedBy: process.env['COPILOT_AGENT_SESSION'] ?? process.env['USER'] ?? 'sidecar',
    issues: createGhAssetRequestIssueApi(repoRoot),
  });
  let shuttingDown = false;
  const releaseRegistry = (): void => {
    if (managedRegistryPath && managedInstanceId) {
      releaseSidecarRegistry(managedRegistryPath, managedInstanceId);
    }
  };
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`sprites:gallery sidecar: received ${signal}, closing\n`);
    try {
      await app.close();
      releaseRegistry();
      process.exit(0);
    } catch (err) {
      releaseRegistry();
      process.stderr.write(
        `sprites:gallery sidecar: error during close: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      process.exit(1);
    }
  }
  const service: SidecarServiceControl | undefined =
    process.env['CRAWLER_SIDECAR_MANAGED'] === '1' &&
    managedInstanceId &&
    managedShutdownToken &&
    managedStartedAt
      ? {
          identity: {
            managed: true,
            instanceId: managedInstanceId,
            pid: process.pid,
            startedAt: managedStartedAt,
            ...(managedCodeProvenance ? { codeProvenance: managedCodeProvenance } : {}),
          },
          shutdownToken: managedShutdownToken,
          requestShutdown: () => void shutdown('managed shutdown'),
        }
      : undefined;
  const app: ReturnType<typeof buildServer> = buildServer({
    repoRoot,
    runsDir,
    version: SPRITE_SIDECAR_SERVICE_VERSION,
    logger: true,
    store,
    queue,
    worker,
    issueIngester,
    service,
    trustedMutationOrigins: [sessionPorts.labBaseUrl, sessionPorts.devtoolsBaseUrl],
  });
  const port = resolvePort(sessionPorts.sidecarPort);

  // SIGINT / SIGTERM both trigger a clean Fastify close so the port is
  // released even when the parent (e.g. the gallery launcher) is killed.
  // Without this an orphan binding survives in `netstat` for ~30s on
  // Windows and immediately on Linux but keeps the FD open.
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    const url = await app.listen({ host: HOST, port });
    process.stdout.write(`sprites:gallery sidecar listening on ${url}\n`);
    process.stdout.write(`  repoRoot: ${repoRoot}\n`);
    process.stdout.write(`  runsDir : ${runsDir}\n`);
    process.stdout.write(`  store   : ${store.backend}\n`);
    process.stdout.write(`  queue   : ${queue.backend}\n`);
    process.stdout.write(
      `  backend : ${backends.usesAzure ? 'Azure (sidecar default)' : 'local (explicit opt-in)'}\n`,
    );
    process.stdout.write(
      `  routes  : /api/health, /api/runs, /api/runs/:brief/:run, /api/runs/:brief/:run/processed/:file\n`,
    );
    process.stdout.write(
      `            POST /api/runs/:brief/:run/approve, POST /api/workflow/synthesize, POST /api/workflow/promote-brief,\n`,
    );
    process.stdout.write(`            POST /api/workflow/generate, POST /api/workflow/metadata\n`);
    process.stdout.write(`            GET/PUT /api/workflow/state (durable, ETag-guarded)\n`);
    process.stdout.write(
      `            POST /api/workflow/worker/start|stop, GET /api/workflow/worker/status,\n`,
    );
    process.stdout.write(
      `            POST /api/workflow/issues/start|stop, GET /api/workflow/issues/status\n`,
    );

    // Auto-start the in-process worker and issue ingester on the azure-queue backend so a queued
    // generate always has a consumer. On the noop backend the generate route
    // runs inline, so no worker is needed (and starting one would require Azure
    // credentials the local dev box doesn't have).
    if (queue.backend === 'azure-queue') {
      const result = worker.start();
      issueIngester.start();
      if (result.started) {
        process.stdout.write(`  worker  : auto-started (backend=${queue.backend})\n`);
      } else {
        process.stdout.write(
          `  worker  : NOT started (${result.reason})` +
            (result.status.lastError ? ` — ${result.status.lastError}` : '') +
            `\n`,
        );
      }
    } else {
      process.stdout.write(
        `  worker  : idle (backend=${queue.backend}; generate runs inline, no worker needed)\n`,
      );
    }
    return 0;
  } catch (err) {
    releaseRegistry();
    process.stderr.write(`sprites:gallery sidecar: failed to bind ${HOST}:${port}\n`);
    process.stderr.write(`  ${err instanceof Error ? err.message : String(err)}\n`);
    if (err instanceof Error && /EADDRINUSE/.test(err.message)) {
      process.stderr.write(
        `  Hint: another sidecar may already be running. Stop it (Ctrl-C in the other terminal) and retry.\n`,
      );
    }
    return 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = path.resolve(fileURLToPath(import.meta.url));
const normalizedInvokedPath = invokedPath.toLowerCase();
const normalizedModulePath = modulePath.toLowerCase();
const isDirectInvocation =
  invokedPath !== '' &&
  (import.meta.url === pathToFileURL(invokedPath).href ||
    normalizedInvokedPath === normalizedModulePath);
if (isDirectInvocation) {
  main().then(
    (code) => {
      if (code !== 0) process.exit(code);
      // On code 0 we leave the process alive so Fastify can keep serving.
    },
    (err: unknown) => {
      process.stderr.write(
        `fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
      process.exit(1);
    },
  );
}
