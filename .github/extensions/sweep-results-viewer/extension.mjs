import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { CanvasError, createCanvas, joinSession } from '@github/copilot-sdk/extension';
import {
  cloudResultWarning,
  floorProvenanceWarning,
  isTerminalRun,
  mergeAggregateOutputs,
  selectDefaultRun,
  shouldPollRun,
} from './lib/cloud-results.mjs';
import { listWeaponSweepRuns, loadCloudRun, resolveProjectContext } from './lib/github-client.mjs';
import { tokensMatch } from './lib/http-security.mjs';
import { listLocalSweepResults, readLocalSweepFile } from './lib/local-results.mjs';
import {
  formatCloudFailure,
  isCurrentCloudGeneration,
  isCurrentLocalSelection,
  stabilizeTerminalSnapshot,
} from './lib/state-helpers.mjs';
import { renderHtml } from './renderer.mjs';

const POLL_INTERVAL_MS = 30_000;
const TERMINAL_SYNC_DELAY_MS = 1_000;
const TERMINAL_SYNC_ATTEMPTS = 3;
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

function safeLocalRun(run) {
  if (!run) return null;
  return {
    path: run.path,
    name: run.name,
    runAt: run.runAt,
    modifiedAt: run.modifiedAt,
    floors: run.floors,
  };
}

function stateSnapshot(state) {
  return {
    source: state.source,
    path: state.source === 'local' ? state.path : null,
    localDirectory: state.localDirectory,
    localRuns: state.localRuns.map(safeLocalRun),
    localErrors: state.localErrors,
    selectedLocalPath: state.selectedLocalPath,
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
    state.warning =
      [
        cloudResultWarning({
          run: cloud.run,
          expectedWeapons: state.expectedWeapons,
          availableWeapons: state.availableWeapons,
          expiredCount: state.expiredArtifactCount,
        }),
        floorProvenanceWarning(cloud.aggregateOutputs),
      ]
        .filter(Boolean)
        .join(' ') || null;
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

function applyLocalCatalog(state, catalog) {
  state.localDirectory = catalog.directory;
  state.localRuns = catalog.runs;
  state.localErrors = catalog.errors;
}

async function loadLocalSelection(instanceId, state, path, selectionReason, selectedLocalPath) {
  state.path = path;
  state.selectedLocalPath = selectedLocalPath;
  state.selectionReason = selectionReason;
  state.expectedWeapons = [];
  state.availableWeapons = [];
  state.expiredArtifactCount = 0;
  state.error = null;
  state.warning = null;
  state.refreshing = true;
  const selection = { generation: state.generation, path };
  notifyClients(instanceId);
  try {
    const loaded = await readLocalSweepFile(path);
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

async function switchToLocal(instanceId, path) {
  const state = states.get(instanceId);
  if (!state) throw new CanvasError('no_state', 'Canvas not open');
  cancelRefresh(state);
  state.source = 'local';
  const catalogMatch = state.localRuns.find((run) => run.path === path);
  return loadLocalSelection(
    instanceId,
    state,
    path,
    'explicit-local-file',
    catalogMatch?.path ?? null,
  );
}

async function switchToLocalCatalog(instanceId, requestedPath) {
  const state = states.get(instanceId);
  if (!state) throw new CanvasError('no_state', 'Canvas not open');
  cancelRefresh(state);
  state.source = 'local';
  state.refreshing = true;
  state.error = null;
  state.warning = null;
  const generation = state.generation;
  notifyClients(instanceId);

  let catalog;
  try {
    catalog = await listLocalSweepResults(state.workingDirectory);
  } catch (error) {
    if (state.closed || state.generation !== generation || state.source !== 'local') {
      return state;
    }
    state.data = null;
    state.loadedAt = null;
    state.refreshing = false;
    state.error = `Local discovery failed: ${errorMessage(error)}`;
    state.lastRefreshedAt = new Date().toISOString();
    notifyClients(instanceId);
    return state;
  }
  if (state.closed || state.generation !== generation || state.source !== 'local') {
    return state;
  }
  applyLocalCatalog(state, catalog);
  const selectedPath =
    requestedPath ??
    (state.selectedLocalPath && catalog.runs.some((run) => run.path === state.selectedLocalPath)
      ? state.selectedLocalPath
      : catalog.runs[0]?.path);

  if (requestedPath && !catalog.runs.some((run) => run.path === requestedPath)) {
    state.path = requestedPath;
    state.selectedLocalPath = null;
    state.data = null;
    state.loadedAt = null;
    state.refreshing = false;
    state.error =
      catalog.errors.find((entry) => entry.path === requestedPath)?.message ??
      `Local sweep result is not available in ${catalog.directory}.`;
    notifyClients(instanceId);
    throw new CanvasError('local_run_not_found', state.error);
  }
  if (!selectedPath) {
    state.path = null;
    state.selectedLocalPath = null;
    state.selectionReason = 'no-local-runs';
    state.data = null;
    state.loadedAt = null;
    state.lastRefreshedAt = new Date().toISOString();
    state.refreshing = false;
    notifyClients(instanceId);
    return state;
  }
  return loadLocalSelection(instanceId, state, selectedPath, 'catalog-local-file', selectedPath);
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

async function switchToCloud(instanceId) {
  const state = states.get(instanceId);
  if (!state) throw new CanvasError('no_state', 'Canvas not open');
  const selectedRunId = state.selectedRun?.id;
  cancelRefresh(state);
  state.source = 'cloud';
  state.data = null;
  state.error = null;
  state.warning = null;
  await initializeCloud(instanceId, selectedRunId);
  return state;
}

async function reloadState(instanceId) {
  const state = states.get(instanceId);
  if (!state) throw new CanvasError('no_state', 'Canvas not open');
  if (state.source === 'local') {
    if (state.selectionReason === 'catalog-local-file') {
      return switchToLocalCatalog(instanceId, state.path);
    }
    if (!state.path) {
      return switchToLocalCatalog(instanceId);
    }
    return switchToLocal(instanceId, state.path);
  }
  await refreshCloudState(instanceId, { refreshRuns: true });
  return state;
}

async function initializeCloud(instanceId, explicitRunId) {
  const state = states.get(instanceId);
  if (!state) throw new CanvasError('no_state', 'Canvas not open');
  const generation = state.generation;
  try {
    await runCancellableOperation(state, async (signal) => {
      const context = await resolveProjectContext(state.workingDirectory, signal);
      const runs = await listWeaponSweepRuns(context.repository, signal);
      if (!isCurrentCloudGeneration(state, generation)) {
        return;
      }
      state.context = context;
      state.runs = runs;
    });
    if (!isCurrentCloudGeneration(state, generation)) {
      return state;
    }
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
    return state;
  } catch (error) {
    if (!isCurrentCloudGeneration(state, generation) || error?.name === 'AbortError') {
      return state;
    }
    state.error = formatCloudFailure('Cloud initialization failed: ', errorMessage(error));
    state.lastRefreshedAt = new Date().toISOString();
    notifyClients(instanceId);
    return state;
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
  if (url.pathname === '/api/select-source' && request.method === 'POST') {
    const body = await readJsonBody(request);
    const state =
      body.source === 'local'
        ? await switchToLocalCatalog(instanceId)
        : body.source === 'cloud'
          ? await switchToCloud(instanceId)
          : null;
    if (!state) {
      jsonResponse(response, 400, { error: `Unsupported source: ${body.source}` });
      return;
    }
    jsonResponse(response, 200, stateSnapshot(state));
    return;
  }
  if (url.pathname === '/api/select-local' && request.method === 'POST') {
    const body = await readJsonBody(request);
    const state = await switchToLocalCatalog(instanceId, body.path);
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
    path: state.source === 'local' ? state.path : null,
    repository: state.context?.repository ?? null,
    run: state.source === 'cloud' ? safeRun(state.selectedRun) : null,
    runAt: state.data.runAt,
    floors: state.data.floors ?? null,
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
            description:
              'Optional explicit local weapon-sweep JSON path. Cloud results remain the default.',
          },
        },
      },
      actions: [
        {
          name: 'select_source',
          description:
            'Switch between the default cloud catalog and attached-session local results.',
          inputSchema: {
            type: 'object',
            properties: { source: { type: 'string', enum: ['cloud', 'local'] } },
            required: ['source'],
          },
          handler: async (ctx) => {
            const state =
              ctx.input.source === 'local'
                ? await switchToLocalCatalog(ctx.instanceId)
                : await switchToCloud(ctx.instanceId);
            if (state.error) throw new CanvasError('source_switch_failed', state.error);
            return stateSnapshot(state);
          },
        },
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
          name: 'list_local_runs',
          description:
            'List valid weapon-sweep results from the attached session worktree, newest first.',
          handler: async (ctx) => {
            const state = states.get(ctx.instanceId);
            if (!state) throw new CanvasError('no_state', 'Canvas not open');
            const catalog = await listLocalSweepResults(state.workingDirectory);
            applyLocalCatalog(state, catalog);
            notifyClients(ctx.instanceId);
            return {
              directory: catalog.directory,
              runs: catalog.runs.map(safeLocalRun),
              errors: catalog.errors,
            };
          },
        },
        {
          name: 'select_local_run',
          description: 'Select a discovered attached-session local weapon-sweep result.',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
          handler: async (ctx) => {
            const state = await switchToLocalCatalog(ctx.instanceId, ctx.input.path);
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
            selectedLocalPath: null,
            localDirectory: null,
            localRuns: [],
            localErrors: [],
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
          status:
            state.source === 'cloud' && state.selectedRun
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
