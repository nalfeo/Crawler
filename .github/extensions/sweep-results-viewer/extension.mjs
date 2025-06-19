import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { CanvasError, createCanvas, joinSession } from '@github/copilot-sdk/extension';
import {
  cloudResultWarning,
  isTerminalRun,
  mergeAggregateOutputs,
  selectDefaultRun,
  shouldPollRun,
} from './lib/cloud-results.mjs';
import { listWeaponSweepRuns, loadCloudRun, resolveProjectContext } from './lib/github-client.mjs';
import { tokensMatch } from './lib/http-security.mjs';
import {
  formatCloudFailure,
  isCurrentLocalSelection,
  stabilizeTerminalSnapshot,
} from './lib/state-helpers.mjs';
import { renderHtml } from './renderer.mjs';

const POLL_INTERVAL_MS = 30_000;
const TERMINAL_SYNC_DELAY_MS = 1_000;
const TERMINAL_SYNC_ATTEMPTS = 3;
const DEFAULT_LOCAL_PATH = '/tmp/weapon-sweep.json';
const servers = new Map();
const states = new Map();
const sseClients = new Map();

function errorMessage(error) {
  if (error?.name === 'AbortError') {
    return 'Refresh cancelled.';
  }
  return error instanceof Error ? error.message : String(error);
}

function compareRunsDesc(left, right) {
  const timeDifference =
    (Date.parse(right.createdAt ?? '') || 0) - (Date.parse(left.createdAt ?? '') || 0);
  return timeDifference || right.id - left.id;
}

function safeRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    conclusion: run.conclusion,
    headBranch: run.headBranch,
    headSha: run.headSha,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    url: run.url,
    event: run.event,
    attempt: run.attempt,
  };
}

function stateSnapshot(state) {
  return {
    source: state.source,
    path: state.path,
    repository: state.context?.repository ?? null,
    branch: state.context?.branch ?? null,
    sessionId: state.sessionId,
    runs: state.runs.map(safeRun),
    selectedRun: safeRun(state.selectedRun),
    selectionReason: state.selectionReason,
    expectedWeapons: state.expectedWeapons,
    availableWeapons: state.availableWeapons,
    expiredArtifactCount: state.expiredArtifactCount,
    pollIntervalMs: POLL_INTERVAL_MS,
    polling: Boolean(state.pollTimer),
    refreshing: state.refreshing,
    error: state.error,
    warning: state.warning,
    loadedAt: state.loadedAt,
    lastRefreshedAt: state.lastRefreshedAt,
    data: state.data,
  };
}

function notifyClients(instanceId) {
  const state = states.get(instanceId);
  const clients = sseClients.get(instanceId);
  if (!state || !clients?.size) return;
  const payload = `data: ${JSON.stringify(stateSnapshot(state))}\n\n`;
  for (const response of clients) {
    try {
      response.write(payload);
    } catch {
      clients.delete(response);
    }
  }
}

function jsonResponse(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 16_384) {
      throw new Error('Request body exceeds 16 KiB.');
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  return body ? JSON.parse(body) : {};
}

function clearPoll(state) {
  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
}

function cancelRefresh(state) {
  state.generation += 1;
  state.refreshController?.abort();
  for (const controller of state.operationControllers) controller.abort();
  state.operationControllers.clear();
  state.refreshController = null;
  state.refreshPromise = null;
  state.refreshing = false;
  state.pendingRunRefresh = false;
  clearPoll(state);
}

async function runCancellableOperation(state, operation) {
  const controller = new AbortController();
  state.operationControllers.add(controller);
  try {
    return await operation(controller.signal);
  } finally {
    state.operationControllers.delete(controller);
  }
}

function schedulePoll(instanceId) {
  const state = states.get(instanceId);
  if (!state || state.closed || state.source !== 'cloud' || !shouldPollRun(state.selectedRun)) {
    return;
  }
  clearPoll(state);
  state.pollTimer = setTimeout(() => {
    state.pollTimer = null;
    void refreshCloudState(instanceId, { refreshRuns: false });
  }, POLL_INTERVAL_MS);
  state.pollTimer.unref?.();
}

async function refreshCloudState(instanceId, options = {}) {
  const state = states.get(instanceId);
  if (!state || state.closed || state.source !== 'cloud') return state;
  if (state.refreshPromise) {
    if (options.refreshRuns) {
      state.pendingRunRefresh = true;
    }
    return state.refreshPromise;
  }

  const generation = state.generation;
  const controller = new AbortController();
  state.refreshController = controller;
  state.refreshing = true;
  state.error = null;
  clearPoll(state);
  notifyClients(instanceId);

  state.refreshPromise = (async () => {
    let runs = state.runs;
    if (options.refreshRuns || runs.length === 0) {
      runs = await listWeaponSweepRuns(state.context.repository, controller.signal);
      if (state.closed || state.generation !== generation || state.source !== 'cloud') {
        return state;
      }
      // Persist the freshly listed runs immediately, decoupled from the artifact
      // load below. A loadCloudRun failure must not discard a successfully fetched
      // run list and leave the selector stale.
      state.runs = [...runs].sort(compareRunsDesc);
    }
    if (!state.selectedRun) {
      const selection = selectDefaultRun(runs, state.context.branch);
      state.selectedRun = selection.run;
      state.selectionReason = selection.reason;
    }
    if (!state.selectedRun) {
      throw new Error('No weapon-sweep workflow runs were found for this repository.');
    }

    let cloud = await loadCloudRun(
      state.context.repository,
      state.selectedRun.id,
      controller.signal,
    );
    cloud = await stabilizeTerminalSnapshot(cloud, {
      attempts: TERMINAL_SYNC_ATTEMPTS,
      delayMs: TERMINAL_SYNC_DELAY_MS,
      signal: controller.signal,
      isTerminalRun,
      loadSnapshot: (signal) =>
        loadCloudRun(state.context.repository, state.selectedRun.id, signal),
    });
    if (state.closed || state.generation !== generation || state.source !== 'cloud') {
      return state;
    }

    const merged = mergeAggregateOutputs(cloud.aggregateOutputs, {
      expectedWeapons: cloud.expectedWeapons,
      runCreatedAt: cloud.run.createdAt,
    });
    state.runs = runs
      .map((run) => (run.id === cloud.run.id ? cloud.run : run))
      .sort(compareRunsDesc);
    state.selectedRun = cloud.run;
    state.expectedWeapons = cloud.expectedWeapons;
    state.availableWeapons = merged?.weapons ?? [];
    state.expiredArtifactCount = cloud.expiredArtifactCount;
    state.data = merged;
    state.loadedAt = Date.now();
    state.lastRefreshedAt = new Date().toISOString();
    state.warning = cloudResultWarning({
      run: cloud.run,
      expectedWeapons: state.expectedWeapons,
      availableWeapons: state.availableWeapons,
      expiredCount: state.expiredArtifactCount,
    });
    state.error = null;
    return state;
  })()
    .catch((error) => {
      if (
        state.closed ||
        state.generation !== generation ||
        controller.signal.aborted ||
        error?.name === 'AbortError'
      ) {
        return state;
      }
      state.error = formatCloudFailure('Cloud refresh failed: ', errorMessage(error));
      state.lastRefreshedAt = new Date().toISOString();
      return state;
    })
    .finally(() => {
      if (state.generation === generation) {
        state.refreshing = false;
        state.refreshController = null;
        state.refreshPromise = null;
        const needsRunRefresh = state.pendingRunRefresh;
        state.pendingRunRefresh = false;
        if (!needsRunRefresh && shouldPollRun(state.selectedRun)) {
          schedulePoll(instanceId);
        }
        notifyClients(instanceId);
        if (needsRunRefresh) {
          void refreshCloudState(instanceId, { refreshRuns: true });
        }
      }
    });

  return state.refreshPromise;
}

async function loadLocalData(path) {
  const stats = await stat(path);
  const data = JSON.parse(await readFile(path, 'utf8'));
  return { data, loadedAt: stats.mtimeMs };
}

async function switchToLocal(instanceId, path) {
  const state = states.get(instanceId);
  if (!state) throw new CanvasError('no_state', 'Canvas not open');
  cancelRefresh(state);
  state.source = 'local';
  state.path = path;
  state.selectedRun = null;
  state.selectionReason = 'explicit-local-file';
  state.expectedWeapons = [];
  state.availableWeapons = [];
  state.expiredArtifactCount = 0;
  state.warning = null;
  state.refreshing = true;
  const selection = { generation: state.generation, path };
  notifyClients(instanceId);
  try {
    const loaded = await loadLocalData(path);
    if (!isCurrentLocalSelection(state, selection)) {
      return state;
    }
    state.data = loaded.data;
    state.loadedAt = loaded.loadedAt;
    state.lastRefreshedAt = new Date().toISOString();
    state.error = null;
  } catch (error) {
    if (!isCurrentLocalSelection(state, selection)) {
      return state;
    }
    state.data = null;
    state.loadedAt = null;
    state.error = `Local file load failed: ${errorMessage(error)}`;
  } finally {
    if (isCurrentLocalSelection(state, selection)) {
      state.refreshing = false;
      notifyClients(instanceId);
    }
  }
  return state;
}

async function switchToCloudRun(instanceId, runId) {
  const state = states.get(instanceId);
  if (!state) throw new CanvasError('no_state', 'Canvas not open');
  const parsedRunId = Number(runId);
  if (!Number.isSafeInteger(parsedRunId) || parsedRunId <= 0) {
    throw new CanvasError('invalid_run', `Invalid workflow run id: ${runId}`);
  }
  if (!state.context || state.runs.length === 0) {
    await runCancellableOperation(state, async (signal) => {
      const context =
        state.context ?? (await resolveProjectContext(state.workingDirectory, signal));
      const runs = await listWeaponSweepRuns(context.repository, signal);
      state.context = context;
      state.runs = runs;
    });
  }
  const selectedRun = state.runs.find((run) => run.id === parsedRunId);
  if (!selectedRun) {
    throw new CanvasError(
      'run_not_found',
      `Run ${parsedRunId} is not a weapon-sweep workflow run in ${state.context.repository}.`,
    );
  }
  cancelRefresh(state);
  state.source = 'cloud';
  state.path = null;
  state.selectedRun = selectedRun;
  state.selectionReason = 'explicit-run';
  state.expectedWeapons = [];
  state.availableWeapons = [];
  state.expiredArtifactCount = 0;
  state.warning = null;
  state.error = null;
  state.data = null;
  await refreshCloudState(instanceId, { refreshRuns: false });
  return state;
}

async function reloadState(instanceId) {
  const state = states.get(instanceId);
  if (!state) throw new CanvasError('no_state', 'Canvas not open');
  if (state.source === 'local') {
    return switchToLocal(instanceId, state.path);
  }
  await refreshCloudState(instanceId, { refreshRuns: true });
  return state;
}

async function initializeCloud(instanceId, explicitRunId) {
  const state = states.get(instanceId);
  try {
    await runCancellableOperation(state, async (signal) => {
      const context = await resolveProjectContext(state.workingDirectory, signal);
      const runs = await listWeaponSweepRuns(context.repository, signal);
      state.context = context;
      state.runs = runs;
    });
    if (explicitRunId !== undefined) {
      const selected = state.runs.find((run) => run.id === Number(explicitRunId));
      if (!selected) {
        throw new Error(
          `Run ${explicitRunId} is not a weapon-sweep workflow run in ${state.context.repository}.`,
        );
      }
      state.selectedRun = selected;
      state.selectionReason = 'explicit-run';
    } else {
      const selection = selectDefaultRun(state.runs, state.context.branch);
      state.selectedRun = selection.run;
      state.selectionReason = selection.reason;
    }
    await refreshCloudState(instanceId, { refreshRuns: false });
  } catch (error) {
    state.error = formatCloudFailure('Cloud initialization failed: ', errorMessage(error));
    state.lastRefreshedAt = new Date().toISOString();
    notifyClients(instanceId);
  }
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
    });
    response.end(renderHtml(instanceId));
    return;
  }
  if (url.pathname === '/events' && request.method === 'GET') {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
    });
    if (!sseClients.has(instanceId)) sseClients.set(instanceId, new Set());
    sseClients.get(instanceId).add(response);
    request.on('close', () => sseClients.get(instanceId)?.delete(response));
    const state = states.get(instanceId);
    if (state) response.write(`data: ${JSON.stringify(stateSnapshot(state))}\n\n`);
    return;
  }
  if (url.pathname === '/api/state' && request.method === 'GET') {
    const state = states.get(instanceId);
    jsonResponse(response, state ? 200 : 404, state ? stateSnapshot(state) : { error: 'not_open' });
    return;
  }
  if (url.pathname === '/api/reload' && request.method === 'POST') {
    const state = await reloadState(instanceId);
    jsonResponse(response, 200, stateSnapshot(state));
    return;
  }
  if (url.pathname === '/api/select-run' && request.method === 'POST') {
    const body = await readJsonBody(request);
    const state = await switchToCloudRun(instanceId, body.runId);
    jsonResponse(response, 200, stateSnapshot(state));
    return;
  }
  jsonResponse(response, 404, { error: 'not_found' });
}

async function startServer(instanceId, token, sessionLogger) {
  const server = createServer((request, response) => {
    handleRequest(instanceId, token, request, response).catch((error) => {
      const message = errorMessage(error);
      void sessionLogger.log(`Sweep Results Viewer request failed: ${message}`, {
        level: 'error',
        ephemeral: true,
      });
      if (!response.headersSent) {
        jsonResponse(response, 500, { error: message });
      } else {
        response.end();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, token, url: `http://127.0.0.1:${port}/` };
}

function summaryPayload(state) {
  if (!state.data) {
    throw new CanvasError('no_data', state.error ?? state.warning ?? 'No sweep data loaded');
  }
  return {
    source: state.source,
    path: state.path,
    repository: state.context?.repository ?? null,
    run: safeRun(state.selectedRun),
    runAt: state.data.runAt,
    seeds: state.data.seeds,
    weapons: state.data.weapons,
    summaries: state.data.summaries?.map((summary) => ({
      weapon: summary.weapon,
      runs: summary.runs,
      victories: summary.victories,
      winRate: summary.winRate,
      meanScore: summary.meanScore,
      meanGameTimeSec: summary.meanGameTimeSec,
      meanLevel: summary.meanLevel,
      meanKills: summary.meanKills,
      meanMinHealthPct: summary.meanMinHealthPct,
    })),
  };
}

const session = await joinSession({
  canvases: [
    createCanvas({
      id: 'sweep-results-viewer',
      displayName: 'Sweep Results Viewer',
      description:
        'Browse GitHub Actions weapon-sweep runs with live partial results, or load a local sweep JSON file.',
      inputSchema: {
        type: 'object',
        properties: {
          runId: {
            type: 'integer',
            minimum: 1,
            description: 'Optional GitHub Actions weapon-sweep run id to select.',
          },
          path: {
            type: 'string',
            description: `Optional local weapon-sweep JSON path. Cloud results are the default; legacy default is ${DEFAULT_LOCAL_PATH}.`,
          },
        },
      },
      actions: [
        {
          name: 'load_file',
          description: 'Switch to a local weapon-sweep JSON file.',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
          handler: async (ctx) => {
            const state = await switchToLocal(ctx.instanceId, ctx.input.path);
            if (state.error) throw new CanvasError('local_file_error', state.error);
            return summaryPayload(state);
          },
        },
        {
          name: 'select_cloud_run',
          description: 'Select and load a GitHub Actions weapon-sweep workflow run.',
          inputSchema: {
            type: 'object',
            properties: { runId: { type: 'integer', minimum: 1 } },
            required: ['runId'],
          },
          handler: async (ctx) => {
            const state = await switchToCloudRun(ctx.instanceId, ctx.input.runId);
            if (state.error) throw new CanvasError('cloud_refresh_failed', state.error);
            if (!state.data) {
              return {
                run: safeRun(state.selectedRun),
                selectionReason: state.selectionReason,
                warning: state.warning,
                polling: Boolean(state.pollTimer),
                expectedWeapons: state.expectedWeapons,
                availableWeapons: state.availableWeapons,
              };
            }
            return summaryPayload(state);
          },
        },
        {
          name: 'list_cloud_runs',
          description: 'List every cloud weapon-sweep workflow run, newest first.',
          handler: async (ctx) => {
            const state = states.get(ctx.instanceId);
            if (!state) throw new CanvasError('no_state', 'Canvas not open');
            await runCancellableOperation(state, async (signal) => {
              const context =
                state.context ?? (await resolveProjectContext(state.workingDirectory, signal));
              const runs = await listWeaponSweepRuns(context.repository, signal);
              state.context = context;
              state.runs = runs;
            });
            return {
              repository: state.context.repository,
              branch: state.context.branch,
              runs: state.runs.map(safeRun),
            };
          },
        },
        {
          name: 'reload',
          description: 'Refresh the selected cloud run or reload the current local file.',
          handler: async (ctx) => {
            const state = await reloadState(ctx.instanceId);
            if (state.error) throw new CanvasError('refresh_failed', state.error);
            return summaryPayload(state);
          },
        },
        {
          name: 'get_summary',
          description: 'Get aggregate rows for the currently loaded sweep.',
          handler: async (ctx) => {
            const state = states.get(ctx.instanceId);
            if (!state) throw new CanvasError('no_state', 'Canvas not open');
            return summaryPayload(state);
          },
        },
      ],
      open: async (ctx) => {
        let entry = servers.get(ctx.instanceId);
        if (!entry) {
          const token = randomBytes(24).toString('hex');
          entry = await startServer(ctx.instanceId, token, session);
          servers.set(ctx.instanceId, entry);
        }

        let state = states.get(ctx.instanceId);
        if (!state) {
          state = {
            source: ctx.input?.path ? 'local' : 'cloud',
            path: ctx.input?.path ?? null,
            workingDirectory: ctx.session?.workingDirectory ?? null,
            sessionId: ctx.sessionId,
            context: null,
            runs: [],
            selectedRun: null,
            selectionReason: null,
            expectedWeapons: [],
            availableWeapons: [],
            expiredArtifactCount: 0,
            data: null,
            error: null,
            warning: null,
            loadedAt: null,
            lastRefreshedAt: null,
            refreshing: false,
            generation: 0,
            refreshController: null,
            refreshPromise: null,
            pendingRunRefresh: false,
            operationControllers: new Set(),
            pollTimer: null,
            closed: false,
          };
          states.set(ctx.instanceId, state);
        }

        if (ctx.input?.path) {
          await switchToLocal(ctx.instanceId, ctx.input.path);
        } else {
          cancelRefresh(state);
          state.source = 'cloud';
          await initializeCloud(ctx.instanceId, ctx.input?.runId);
        }
        return {
          title: '🗡️ Sweep Results',
          status: state.selectedRun
            ? `${state.selectedRun.status}${state.selectedRun.conclusion ? ` · ${state.selectedRun.conclusion}` : ''}`
            : state.source,
          url: `${entry.url}?token=${entry.token}`,
        };
      },
      onClose: async (ctx) => {
        const state = states.get(ctx.instanceId);
        if (state) {
          state.closed = true;
          cancelRefresh(state);
        }
        const clients = sseClients.get(ctx.instanceId);
        for (const response of clients ?? []) response.end();
        sseClients.delete(ctx.instanceId);
        states.delete(ctx.instanceId);

        const entry = servers.get(ctx.instanceId);
        if (entry) {
          servers.delete(ctx.instanceId);
          entry.server.closeAllConnections?.();
          await new Promise((resolve) => entry.server.close(resolve));
        }
      },
    }),
  ],
});

void session;
