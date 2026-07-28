import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

import { CanvasError, createCanvas, joinSession } from '@github/copilot-sdk/extension';

import {
  loadRepositoryState,
  resolveProjectContext,
  sanitizeErrorText,
} from './lib/github-client.mjs';
import { createDashboardSnapshot } from './lib/model.mjs';
import { createRefreshCoordinator } from './lib/refresh-coordinator.mjs';
import { renderHtml } from './renderer.mjs';

const DEFAULT_RUNNER_CAP = 20;
const REFRESH_INTERVAL_MS = 30_000;
const servers = new Map();
const instances = new Map();
const coordinators = new Map();

function tokensMatch(actual, expected) {
  if (!actual) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.byteLength === expectedBuffer.byteLength &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function errorMessage(error) {
  if (error?.name === 'AbortError') return 'Refresh cancelled.';
  return sanitizeErrorText(error instanceof Error ? error.message : String(error));
}

function jsonResponse(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function statePayload(instanceId) {
  const instance = instances.get(instanceId);
  if (!instance) return null;
  const coordinator = coordinators.get(instance.repository);
  const rawState = coordinator?.snapshot ?? null;
  const error = coordinator?.error ?? null;
  return {
    instanceId,
    repository: instance.repository,
    runnerCap: instance.runnerCap,
    refreshIntervalMs: REFRESH_INTERVAL_MS,
    refreshing: coordinator?.refreshing ?? false,
    error,
    snapshot: rawState ? createDashboardSnapshot(rawState, instance.runnerCap, error) : null,
  };
}

function notifyRepository(repository) {
  for (const [instanceId, instance] of instances) {
    if (instance.repository !== repository) continue;
    const entry = servers.get(instanceId);
    const payload = statePayload(instanceId);
    if (!entry || !payload) continue;
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const response of entry.sseClients) {
      try {
        response.write(data);
      } catch {
        entry.sseClients.delete(response);
      }
    }
  }
}

function getCoordinator(repository, sessionLogger) {
  let coordinator = coordinators.get(repository);
  if (coordinator) return coordinator;
  coordinator = createRefreshCoordinator({
    intervalMs: REFRESH_INTERVAL_MS,
    load: (signal) => loadRepositoryState(repository, signal),
    onUpdate: () => notifyRepository(repository),
    onSettled: () => notifyRepository(repository),
    onError: (message) => {
      notifyRepository(repository);
      void sessionLogger.log(`CI Health refresh failed for ${repository}: ${message}`, {
        level: 'error',
        ephemeral: true,
      });
    },
  });
  coordinators.set(repository, coordinator);
  return coordinator;
}

async function handleRequest(instanceId, token, request, response) {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (!tokensMatch(url.searchParams.get('token'), token)) {
    jsonResponse(response, 403, { error: 'forbidden' });
    return;
  }

  if (url.pathname === '/' && request.method === 'GET') {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; frame-ancestors 'self'",
    });
    response.end(renderHtml({ instanceId, refreshIntervalMs: REFRESH_INTERVAL_MS }));
    return;
  }

  if (url.pathname === '/events' && request.method === 'GET') {
    const entry = servers.get(instanceId);
    if (!entry) {
      jsonResponse(response, 404, { error: 'not_open' });
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
    });
    entry.sseClients.add(response);
    request.on('close', () => entry.sseClients.delete(response));
    const payload = statePayload(instanceId);
    if (payload) response.write(`data: ${JSON.stringify(payload)}\n\n`);
    return;
  }

  if (url.pathname === '/api/state' && request.method === 'GET') {
    const payload = statePayload(instanceId);
    jsonResponse(response, payload ? 200 : 404, payload ?? { error: 'not_open' });
    return;
  }

  if (url.pathname === '/api/refresh' && request.method === 'POST') {
    const instance = instances.get(instanceId);
    if (!instance) {
      jsonResponse(response, 404, { error: 'not_open' });
      return;
    }
    const coordinator = coordinators.get(instance.repository);
    try {
      await coordinator.refresh(true);
    } catch {
      // The state payload carries the sanitized refresh error and any prior snapshot.
    }
    const payload = statePayload(instanceId);
    jsonResponse(response, payload?.snapshot ? 200 : 502, payload ?? { error: 'not_open' });
    return;
  }

  jsonResponse(response, 404, { error: 'not_found' });
}

async function startServer(instanceId, token, sessionLogger) {
  const sseClients = new Set();
  const server = createServer((request, response) => {
    handleRequest(instanceId, token, request, response).catch((error) => {
      const message = errorMessage(error);
      void sessionLogger.log(`CI Health request failed: ${message}`, {
        level: 'error',
        ephemeral: true,
      });
      if (!response.headersSent) jsonResponse(response, 500, { error: message });
      else response.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', (err) => {
      server.removeAllListeners('error');
      reject(err);
    });
    server.listen(0, '127.0.0.1', () => {
      server.removeAllListeners('error');
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    server,
    sseClients,
    token,
    url: `http://127.0.0.1:${port}/`,
  };
}

async function closeServer(entry) {
  for (const response of entry.sseClients) response.end();
  entry.sseClients.clear();
  await new Promise((resolve) => {
    entry.server.close(() => resolve());
    entry.server.closeAllConnections?.();
  });
}

const session = await joinSession({
  canvases: [
    createCanvas({
      id: 'ci-health',
      displayName: 'CI Health',
      description:
        'Show live Merge Train order, Asset Request Pipeline progress, active GitHub Actions jobs, and repository-visible runner pressure.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runnerCap: {
            type: 'integer',
            minimum: 1,
            maximum: 500,
            description:
              'Configured GitHub-hosted concurrency cap used for comparison; defaults to 20.',
          },
        },
      },
      actions: [
        {
          name: 'refresh',
          description: 'Force a fresh Merge Train and GitHub Actions snapshot.',
          handler: async (ctx) => {
            const instance = instances.get(ctx.instanceId);
            if (!instance) throw new CanvasError('no_state', 'CI Health canvas is not open.');
            const coordinator = coordinators.get(instance.repository);
            try {
              await coordinator.refresh(true);
            } catch (error) {
              throw new CanvasError('refresh_failed', errorMessage(error));
            }
            const payload = statePayload(ctx.instanceId);
            if (!payload?.snapshot) {
              throw new CanvasError('no_state', 'CI Health canvas is not open.');
            }
            return payload.snapshot;
          },
        },
        {
          name: 'get_summary',
          description: 'Return the current CI bottleneck, train counts, and runner pressure.',
          handler: (ctx) => {
            const payload = statePayload(ctx.instanceId);
            if (!payload) throw new CanvasError('no_state', 'CI Health canvas is not open.');
            if (!payload.snapshot) {
              throw new CanvasError(
                'no_snapshot',
                payload.error ?? 'No GitHub snapshot is available.',
              );
            }
            return {
              repository: payload.snapshot.repository,
              fetchedAt: payload.snapshot.fetchedAt,
              bottleneck: payload.snapshot.bottleneck,
              train: {
                queueDepth: payload.snapshot.train.queueDepth,
                activeCandidates: payload.snapshot.train.candidates.length,
                blocked: payload.snapshot.train.blocked.length,
                recovery: payload.snapshot.train.recovery.length,
              },
              runners: {
                scope: payload.snapshot.actions.occupancyScope,
                configuredCap: payload.snapshot.actions.runnerCap,
                visibleHostedInProgress: payload.snapshot.actions.visibleHostedInProgress,
                visibleHostedQueued: payload.snapshot.actions.visibleHostedQueued,
              },
              activeRunCount: payload.snapshot.actions.activeRunCount,
              assetPipeline: {
                severity: payload.snapshot.assetPipeline.severity,
                active: payload.snapshot.assetPipeline.active,
                counts: payload.snapshot.assetPipeline.counts,
                latestRun: payload.snapshot.assetPipeline.latestRun,
                stages: payload.snapshot.assetPipeline.stages.map((stage) => ({
                  id: stage.id,
                  label: stage.label,
                  lane: stage.lane,
                  state: stage.state,
                  detail: stage.detail,
                  elapsedMs: stage.elapsedMs,
                  url: stage.url,
                })),
              },
              warnings: payload.snapshot.actions.warnings,
            };
          },
        },
      ],
      open: async (ctx) => {
        const runnerCap = ctx.input?.runnerCap ?? DEFAULT_RUNNER_CAP;
        let instance = instances.get(ctx.instanceId);
        const instanceWasNew = !instance;
        if (instanceWasNew) {
          const contextController = new AbortController();
          let context;
          try {
            context = await resolveProjectContext(
              ctx.session?.workingDirectory ?? process.cwd(),
              contextController.signal,
            );
          } catch (error) {
            throw new CanvasError('repository_context_failed', errorMessage(error));
          }
          instance = { repository: context.repository, runnerCap };
          instances.set(ctx.instanceId, instance);
          getCoordinator(context.repository, session).subscribe();
        } else {
          instance.runnerCap = runnerCap;
        }

        let entry = servers.get(ctx.instanceId);
        if (!entry) {
          const token = randomBytes(24).toString('hex');
          try {
            entry = await startServer(ctx.instanceId, token, session);
          } catch (error) {
            if (instanceWasNew) {
              instances.delete(ctx.instanceId);
              const coordinator = coordinators.get(instance.repository);
              coordinator?.unsubscribe();
              if (coordinator?.subscribers === 0) {
                coordinator.close();
                coordinators.delete(instance.repository);
              }
            }
            throw new CanvasError('server_start_failed', errorMessage(error));
          }
          servers.set(ctx.instanceId, entry);
        }

        const coordinator = coordinators.get(instance.repository);
        try {
          await coordinator.refresh();
        } catch {
          // Keep the canvas open so authentication/API failures are actionable in the UI.
        }
        const payload = statePayload(ctx.instanceId);
        return {
          title: 'CI Health',
          status: payload?.snapshot?.bottleneck?.title ?? payload?.error ?? 'Loading',
          url: `${entry.url}?token=${entry.token}`,
        };
      },
      onClose: async (ctx) => {
        const entry = servers.get(ctx.instanceId);
        if (entry) {
          servers.delete(ctx.instanceId);
          await closeServer(entry);
        }
        const instance = instances.get(ctx.instanceId);
        instances.delete(ctx.instanceId);
        if (!instance) return;
        const coordinator = coordinators.get(instance.repository);
        coordinator?.unsubscribe();
        if (coordinator?.subscribers === 0) {
          coordinator.close();
          coordinators.delete(instance.repository);
        }
      },
    }),
  ],
});
