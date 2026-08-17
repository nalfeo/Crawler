import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { CanvasError, createCanvas, joinSession } from '@github/copilot-sdk/extension';
import {
  aiSweepWarning,
  baselineSweepWarning,
  cloudResultWarning,
  floorProvenanceWarning,
  isTerminalRun,
  mergeAggregateOutputs,
  selectDefaultRun,
  shouldPollRun,
} from './lib/cloud-results.mjs';
import {
  getBaselineSweepRun,
  listAllSweepRuns,
  loadAiSweepRun,
  loadBaselineSweepRun,
  loadCloudRun,
  resolveProjectContext,
  BaselineRunNotFoundError,
} from './lib/github-client.mjs';
import { tokensMatch } from './lib/http-security.mjs';
import { listLocalSweepResults, readLocalSweepFile } from './lib/local-results.mjs';
import {
  formatCloudFailure,
  isCurrentCloudGeneration,
  isCurrentLocalSelection,
  stabilizeTerminalSnapshot,
} from './lib/state-helpers.mjs';
import { transitionToLocalSource } from './lib/local-source-transition.mjs';
import {
  listBenchmarkBranches,
  listRepositoryResultArtifacts,
  readRepositoryResultArtifact,
} from './lib/repository-results.mjs';
import {
  safeLocalRun,
  safeRepositoryArtifact,
  safeRepositoryBranch,
  safeRun,
  stateSnapshot,
} from './lib/state-snapshot.mjs';
import { dispatchSweep } from './lib/runner.mjs';
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

function notifyClients(instanceId) {
  const state = states.get(instanceId);
  const clients = sseClients.get(instanceId);
  if (!state || !clients?.size) return;
  const payload = `data: ${JSON.stringify(stateSnapshot(state, POLL_INTERVAL_MS))}\n\n`;
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
      runs = await listAllSweepRuns(state.context.repository, controller.signal);
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
      throw new Error(
        'No weapon-sweep or AI Sweep Eval workflow runs were found for this repository.',
      );
    }

    const workflowType = state.selectedRun.workflowType ?? 'weapon-sweep';

    if (workflowType === 'ai-sweep') {
      // ── AI Sweep Eval path ─────────────────────────────────────────────────
      let cloud = await loadAiSweepRun(
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
          loadAiSweepRun(state.context.repository, state.selectedRun.id, signal),
        isComplete: (snapshot) =>
          Boolean(snapshot.leaderboardData) || snapshot.expiredArtifactCount > 0,
      });
      if (state.closed || state.generation !== generation || state.source !== 'cloud') {
        return state;
      }

      // Preserve workflowType on the updated run object returned from the API.
      const updatedRun = { ...cloud.run, workflowType: 'ai-sweep' };
      state.runs = runs
        .map((run) => (run.id === updatedRun.id ? updatedRun : run))
        .sort(compareRunsDesc);
      state.selectedRun = updatedRun;
      state.jobPhases = cloud.jobPhases;
      state.expiredArtifactCount = cloud.expiredArtifactCount;
      // Reset weapon-sweep fields that don't apply to AI sweeps.
      state.expectedWeapons = [];
      state.availableWeapons = [];
      state.data = cloud.leaderboardData;
      state.loadedAt = Date.now();
      state.lastRefreshedAt = new Date().toISOString();
      state.warning = aiSweepWarning({
        run: updatedRun,
        jobPhases: cloud.jobPhases,
        hasLeaderboard: Boolean(cloud.leaderboardData),
        expiredArtifactCount: cloud.expiredArtifactCount,
      });
      state.error = null;
    } else if (workflowType === 'baseline-sweep') {
      // ── Post-release baseline-sweep path (deploy.yml) ───────────────────────
      // Diagnostic-only: no job-phase breakdown, and a missing fun-eval report
      // is expected (legacy release, or a scoring failure) rather than an error.
      let cloud = await loadBaselineSweepRun(
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
          loadBaselineSweepRun(state.context.repository, state.selectedRun.id, signal),
        isComplete: (snapshot) => snapshot.hasArtifact || snapshot.expiredArtifactCount > 0,
      });
      if (state.closed || state.generation !== generation || state.source !== 'cloud') {
        return state;
      }

      const updatedRun = { ...cloud.run, workflowType: 'baseline-sweep' };
      state.selectedRun = updatedRun;
      // Reset weapon-sweep/AI-sweep-only fields; they don't apply here.
      state.expectedWeapons = [];
      state.availableWeapons = [];
      state.jobPhases = null;
      state.expiredArtifactCount = cloud.expiredArtifactCount;
      // Keep only what rendering needs -- never store the baseline's full
      // 600-entry `runs: RunStats[]` cohort in client-visible state; it is
      // large and the summary/fun-report fields are all the UI shows.
      state.data = cloud.baseline
        ? {
            meta: cloud.baseline.meta ?? null,
            winRate: cloud.baseline.winRate ?? null,
            totalWins: cloud.baseline.totalWins ?? null,
            totalRuns: cloud.baseline.totalRuns ?? null,
            totalSlowVictories: cloud.baseline.totalSlowVictories ?? null,
            totalTrueLosses: cloud.baseline.totalTrueLosses ?? null,
            perWeapon: cloud.baseline.perWeapon ?? null,
            funReport: cloud.funReport?.report ?? null,
          }
        : null;
      state.loadedAt = Date.now();
      state.lastRefreshedAt = new Date().toISOString();
      state.warning = baselineSweepWarning({
        run: updatedRun,
        hasArtifact: cloud.hasArtifact,
        hasFunReport: Boolean(cloud.funReport),
        expiredArtifactCount: cloud.expiredArtifactCount,
      });
      state.error = null;
    } else {
      // ── Weapon Sweep path (original logic) ─────────────────────────────────
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

      const updatedRun = { ...cloud.run, workflowType: 'weapon-sweep' };
      const merged = mergeAggregateOutputs(cloud.aggregateOutputs, {
        expectedWeapons: cloud.expectedWeapons,
        runCreatedAt: updatedRun.createdAt,
      });
      state.runs = runs
        .map((run) => (run.id === updatedRun.id ? updatedRun : run))
        .sort(compareRunsDesc);
      state.selectedRun = updatedRun;
      state.expectedWeapons = cloud.expectedWeapons;
      state.availableWeapons = merged?.weapons ?? [];
      state.expiredArtifactCount = cloud.expiredArtifactCount;
      state.jobPhases = null;
      state.data = merged;
      state.loadedAt = Date.now();
      state.lastRefreshedAt = new Date().toISOString();
      state.warning =
        [
          cloudResultWarning({
            run: updatedRun,
            expectedWeapons: state.expectedWeapons,
            availableWeapons: state.availableWeapons,
            expiredCount: state.expiredArtifactCount,
          }),
          floorProvenanceWarning(cloud.aggregateOutputs),
        ]
          .filter(Boolean)
          .join(' ') || null;
      state.error = null;
    }
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
  transitionToLocalSource(state);
  state.repositoryArtifactKind = null;
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
  transitionToLocalSource(state);
  state.repositoryArtifactKind = null;
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

/**
 * Resolves an explicit run id against the already-listed weapon-sweep/AI
 * Sweep Eval runs, falling back to a direct `deploy.yml` (baseline-sweep)
 * lookup when not found there. `deploy.yml` runs continuously and is
 * deliberately excluded from `listAllSweepRuns`'s enumerated catalog (see
 * `getBaselineSweepRun`), so a baseline-sweep run is only reachable by id.
 * Returns `undefined` when neither resolves; an in-flight abort/cancellation
 * still propagates so callers keep correct cancellation semantics.
 */
async function resolveExplicitRun(state, parsedRunId) {
  const found = state.runs.find((run) => run.id === parsedRunId);
  if (found) return found;
  try {
    return await runCancellableOperation(state, (signal) =>
      getBaselineSweepRun(state.context.repository, parsedRunId, signal),
    );
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    if (error instanceof BaselineRunNotFoundError) return undefined;
    // Operational errors (auth/network/rate-limit) propagate so cloud error formatting remains useful.
    throw error;
  }
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
      const runs = await listAllSweepRuns(context.repository, signal);
      state.context = context;
      state.runs = runs;
    });
  }
  const selectedRun = await resolveExplicitRun(state, parsedRunId);
  if (!selectedRun) {
    throw new CanvasError(
      'run_not_found',
      `Run ${parsedRunId} is not a weapon-sweep, AI Sweep Eval, or baseline-sweep workflow run in ${state.context.repository}.`,
    );
  }
  cancelRefresh(state);
  state.source = 'cloud';
  state.repositoryArtifactKind = null;
  state.selectedRun = selectedRun;
  state.selectionReason = 'explicit-run';
  state.expectedWeapons = [];
  state.availableWeapons = [];
  state.expiredArtifactCount = 0;
  state.jobPhases = null;
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
  state.repositoryArtifactKind = null;
  state.data = null;
  state.error = null;
  state.warning = null;
  await initializeCloud(instanceId, selectedRunId);
  return state;
}

function applyRepositoryCatalog(state, catalog) {
  state.selectedRepositoryBranch = catalog.branch;
  state.repositoryArtifacts = catalog.artifacts;
  state.repositoryErrors = catalog.errors;
}

async function loadRepositorySelection(instanceId, state, artifactPath) {
  const generation = state.generation;
  const branch = state.selectedRepositoryBranch;
  state.selectedRepositoryPath = artifactPath;
  state.refreshing = true;
  state.error = null;
  state.warning = null;
  notifyClients(instanceId);
  try {
    const loaded = await runCancellableOperation(state, (signal) =>
      readRepositoryResultArtifact(state.workingDirectory, branch, artifactPath, signal),
    );
    if (
      state.closed ||
      state.generation !== generation ||
      state.source !== 'repository' ||
      state.selectedRepositoryBranch?.ref !== branch.ref ||
      state.selectedRepositoryPath !== artifactPath
    ) {
      return state;
    }
    state.data = loaded.data;
    state.repositoryArtifactKind = loaded.kind;
    state.loadedAt = Date.now();
    state.lastRefreshedAt = new Date().toISOString();
  } catch (error) {
    if (state.generation !== generation || error?.name === 'AbortError') return state;
    state.data = null;
    state.repositoryArtifactKind = null;
    state.loadedAt = null;
    state.error = `Repository artifact load failed: ${errorMessage(error)}`;
  } finally {
    if (state.generation === generation && state.source === 'repository') {
      state.refreshing = false;
      notifyClients(instanceId);
    }
  }
  return state;
}

async function switchToRepository(instanceId, requestedBranchName, requestedPath) {
  const state = states.get(instanceId);
  if (!state) throw new CanvasError('no_state', 'Canvas not open');
  cancelRefresh(state);
  state.source = 'repository';
  state.selectedRun = null;
  state.expectedWeapons = [];
  state.availableWeapons = [];
  state.expiredArtifactCount = 0;
  state.jobPhases = null;
  state.repositoryArtifactKind = null;
  state.data = null;
  state.loadedAt = null;
  state.refreshing = true;
  state.error = null;
  state.warning = null;
  const generation = state.generation;
  notifyClients(instanceId);

  try {
    const { context, branches } = await runCancellableOperation(state, async (signal) => ({
      context: state.context ?? (await resolveProjectContext(state.workingDirectory, signal)),
      branches: await listBenchmarkBranches(state.workingDirectory, signal),
    }));
    if (state.closed || state.generation !== generation || state.source !== 'repository') {
      return state;
    }
    state.context = context;
    state.repositoryBranches = branches;
    const selectedBranch =
      branches.find((branch) => branch.name === requestedBranchName) ??
      branches.find((branch) => branch.name === state.selectedRepositoryBranch?.name) ??
      branches[0];
    if (!selectedBranch) {
      throw new Error('The repository baselines branch was not found locally or under origin.');
    }
    if (requestedBranchName && selectedBranch.name !== requestedBranchName) {
      throw new Error(`Baseline branch "${requestedBranchName}" was not found.`);
    }

    const catalog = await runCancellableOperation(state, (signal) =>
      listRepositoryResultArtifacts(state.workingDirectory, selectedBranch, signal),
    );
    if (state.closed || state.generation !== generation || state.source !== 'repository') {
      return state;
    }
    applyRepositoryCatalog(state, catalog);
    const selectedPath =
      requestedPath ??
      (state.selectedRepositoryPath &&
      catalog.artifacts.some((artifact) => artifact.path === state.selectedRepositoryPath)
        ? state.selectedRepositoryPath
        : catalog.artifacts[0]?.path);
    if (requestedPath && !catalog.artifacts.some((artifact) => artifact.path === requestedPath)) {
      throw new Error(
        `Repository result "${requestedPath}" is not available on ${selectedBranch.name}.`,
      );
    }
    if (!selectedPath) {
      state.selectedRepositoryPath = null;
      state.selectionReason = 'no-repository-artifacts';
      state.lastRefreshedAt = new Date().toISOString();
      state.refreshing = false;
      notifyClients(instanceId);
      return state;
    }
    state.selectionReason = 'repository-branch-artifact';
    return loadRepositorySelection(instanceId, state, selectedPath);
  } catch (error) {
    if (state.generation !== generation || error?.name === 'AbortError') return state;
    state.refreshing = false;
    state.error = `Repository branch load failed: ${errorMessage(error)}`;
    state.lastRefreshedAt = new Date().toISOString();
    notifyClients(instanceId);
    return state;
  }
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
  if (state.source === 'repository') {
    return switchToRepository(
      instanceId,
      state.selectedRepositoryBranch?.name,
      state.selectedRepositoryPath,
    );
  }
  await refreshCloudState(instanceId, { refreshRuns: true });
  return state;
}

async function initializeCloud(instanceId, explicitRunId) {
  const state = states.get(instanceId);
  const generation = state.generation;
  try {
    await runCancellableOperation(state, async (signal) => {
      const context = await resolveProjectContext(state.workingDirectory, signal);
      const runs = await listAllSweepRuns(context.repository, signal);
      if (!isCurrentCloudGeneration(state, generation)) {
        return;
      }
      state.context = context;
      state.runs = runs;
    });
    if (!isCurrentCloudGeneration(state, generation)) {
      return;
    }
    if (explicitRunId !== undefined) {
      const selected = await resolveExplicitRun(state, Number(explicitRunId));
      if (!isCurrentCloudGeneration(state, generation)) {
        return;
      }
      if (!selected) {
        throw new Error(
          `Run ${explicitRunId} is not a weapon-sweep, AI Sweep Eval, or baseline-sweep workflow run in ${state.context.repository}.`,
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
    if (!isCurrentCloudGeneration(state, generation) || error?.name === 'AbortError') {
      return;
    }
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
    if (state)
      response.write(`data: ${JSON.stringify(stateSnapshot(state, POLL_INTERVAL_MS))}\n\n`);
    return;
  }
  if (url.pathname === '/api/state' && request.method === 'GET') {
    const state = states.get(instanceId);
    jsonResponse(
      response,
      state ? 200 : 404,
      state ? stateSnapshot(state, POLL_INTERVAL_MS) : { error: 'not_open' },
    );
    return;
  }
  if (url.pathname === '/api/reload' && request.method === 'POST') {
    const state = await reloadState(instanceId);
    jsonResponse(response, 200, stateSnapshot(state, POLL_INTERVAL_MS));
    return;
  }
  if (url.pathname === '/api/select-run' && request.method === 'POST') {
    const body = await readJsonBody(request);
    const state = await switchToCloudRun(instanceId, body.runId);
    jsonResponse(response, 200, stateSnapshot(state, POLL_INTERVAL_MS));
    return;
  }
  if (url.pathname === '/api/select-source' && request.method === 'POST') {
    const body = await readJsonBody(request);
    const state =
      body.source === 'local'
        ? await switchToLocalCatalog(instanceId)
        : body.source === 'cloud'
          ? await switchToCloud(instanceId)
          : body.source === 'repository'
            ? await switchToRepository(instanceId)
            : null;
    if (!state) {
      jsonResponse(response, 400, { error: `Unsupported source: ${body.source}` });
      return;
    }
    jsonResponse(response, 200, stateSnapshot(state, POLL_INTERVAL_MS));
    return;
  }
  if (url.pathname === '/api/select-repository-branch' && request.method === 'POST') {
    const body = await readJsonBody(request);
    const state = await switchToRepository(instanceId, body.branch);
    jsonResponse(response, 200, stateSnapshot(state, POLL_INTERVAL_MS));
    return;
  }
  if (url.pathname === '/api/select-repository-artifact' && request.method === 'POST') {
    const body = await readJsonBody(request);
    const state = states.get(instanceId);
    if (!state) throw new CanvasError('no_state', 'Canvas not open');
    if (
      state.source !== 'repository' ||
      !state.repositoryArtifacts.some((artifact) => artifact.path === body.path)
    ) {
      throw new CanvasError('repository_artifact_not_found', `Unknown artifact: ${body.path}`);
    }
    await loadRepositorySelection(instanceId, state, body.path);
    jsonResponse(response, 200, stateSnapshot(state, POLL_INTERVAL_MS));
    return;
  }
  if (url.pathname === '/api/select-local' && request.method === 'POST') {
    const body = await readJsonBody(request);
    const state = await switchToLocalCatalog(instanceId, body.path);
    jsonResponse(response, 200, stateSnapshot(state, POLL_INTERVAL_MS));
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
  const workflowType = state.repositoryArtifactKind ?? state.selectedRun?.workflowType ?? null;
  if (workflowType === 'baseline') {
    if (!state.data) {
      throw new CanvasError('no_data', state.error ?? 'No baseline data loaded');
    }
    return {
      source: state.source,
      repository: state.context?.repository ?? null,
      branch: safeRepositoryBranch(state.selectedRepositoryBranch),
      artifact: safeRepositoryArtifact(
        state.repositoryArtifacts.find(
          (artifact) => artifact.path === state.selectedRepositoryPath,
        ),
      ),
      workflowType,
      floorId: state.data.floorId ?? null,
      capturedAt: state.data.meta?.capturedAt ?? null,
      totalWins: state.data.totalWins,
      totalRuns: state.data.totalRuns,
      winRate: state.data.winRate,
      perWeapon: state.data.perWeapon,
    };
  }
  if (workflowType === 'ai-sweep') {
    // For an AI sweep run, return leaderboard data if available, otherwise live phase status.
    if (!state.data && !state.jobPhases) {
      throw new CanvasError('no_data', state.error ?? state.warning ?? 'No AI sweep data loaded');
    }
    return {
      source: state.source,
      repository: state.context?.repository ?? null,
      run: safeRun(state.selectedRun),
      workflowType: 'ai-sweep',
      jobPhases: state.jobPhases,
      warning: state.warning,
      polling: Boolean(state.pollTimer),
      leaderboard: state.data?.byComposite ?? null,
      leaderboardByLexicographic: state.data?.byLexicographic ?? null,
      winnersDiverge: state.data?.winnersDiverge ?? null,
    };
  }

  if (workflowType === 'baseline-sweep') {
    if (!state.data) {
      throw new CanvasError(
        'no_data',
        state.error ?? state.warning ?? 'No baseline-sweep data loaded',
      );
    }
    return {
      source: state.source,
      repository: state.context?.repository ?? null,
      run: safeRun(state.selectedRun),
      workflowType: 'baseline-sweep',
      warning: state.warning,
      commit: state.data.meta?.commit ?? null,
      commitSubject: state.data.meta?.commitSubject ?? null,
      winRate: state.data.winRate ?? null,
      totalWins: state.data.totalWins ?? null,
      totalRuns: state.data.totalRuns ?? null,
      perWeapon: state.data.perWeapon ?? null,
      funReport: state.data.funReport
        ? {
            overallFunScore: state.data.funReport.overall_fun_score ?? null,
            gatePass: state.data.funReport.gate?.pass ?? null,
            dimensions: state.data.funReport.dimensions ?? null,
            criteria: state.data.funReport.criteria ?? null,
          }
        : null,
    };
  }

  if (!state.data) {
    throw new CanvasError('no_data', state.error ?? state.warning ?? 'No sweep data loaded');
  }
  return {
    source: state.source,
    path:
      state.source === 'local'
        ? state.path
        : state.source === 'repository'
          ? state.selectedRepositoryPath
          : null,
    repository: state.context?.repository ?? null,
    run: safeRun(state.selectedRun),
    workflowType: workflowType ?? 'weapon-sweep',
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
  tools: [
    {
      name: 'dispatch_weapon_sweep',
      description:
        'Dispatch the Crawler weapon-sweep.yml workflow and return the GitHub run plus the required app-native Sweep Results Viewer reference.',
      parameters: {
        type: 'object',
        properties: {
          ref: {
            type: 'string',
            description:
              'Branch to run. Tags and bare SHAs are rejected because run-id correlation is branch-scoped.',
          },
          seedCount: { type: 'number', minimum: 1, maximum: 100, default: 100 },
          weapons: {
            type: 'string',
            description: 'Comma-separated weapon ids. Defaults to sword,bow,baseball-bat.',
          },
          maxFrames: { type: 'number', minimum: 1, maximum: 600000, default: 19800 },
          weaponPersonas: { type: 'boolean', default: true },
        },
      },
      handler: (params) =>
        dispatchSweep({ ...params, type: 'weapon-sweep' }, { cwd: process.cwd() }),
    },
    {
      name: 'dispatch_ai_sweep',
      description:
        'Dispatch the Crawler ai-sweep.yml workflow and return the GitHub run plus the required app-native Sweep Results Viewer reference.',
      parameters: {
        type: 'object',
        properties: {
          ref: {
            type: 'string',
            description:
              'Branch to run. Tags and bare SHAs are rejected because run-id correlation is branch-scoped.',
          },
          combos: { type: 'string', default: 'all' },
          trainSeeds: { type: 'string', default: '1-24' },
          validateSeeds: { type: 'string', default: '1-40' },
          weapons: {
            type: 'string',
            description: 'Comma-separated weapon ids. Defaults to sword,bow,baseball-bat.',
          },
          rounds: { type: 'number', minimum: 0, maximum: 3, default: 2 },
          secondary: { type: 'boolean', default: true },
          resumeRunId: { type: 'number', minimum: 1 },
        },
      },
      handler: (params) => dispatchSweep({ ...params, type: 'ai-sweep' }, { cwd: process.cwd() }),
    },
  ],
  canvases: [
    createCanvas({
      id: 'sweep-results-viewer',
      displayName: 'Sweep Results Viewer',
      description:
        'Browse GitHub Actions sweeps, local results, committed baseline snapshots, and post-release baseline-sweep runs by explicit run id.',
      inputSchema: {
        type: 'object',
        properties: {
          runId: {
            type: 'integer',
            minimum: 1,
            description:
              'Optional GitHub Actions run id to select (weapon-sweep, AI Sweep Eval, or a post-release baseline-sweep deploy.yml run).',
          },
          path: {
            type: 'string',
            description:
              'Optional explicit local weapon-sweep JSON path. Cloud results remain the default.',
          },
          branch: {
            type: 'string',
            description:
              'Optional repository baseline branch to load instead of the default cloud source.',
          },
          artifactPath: {
            type: 'string',
            description: 'Optional committed JSON result path on the selected benchmark branch.',
          },
        },
      },
      actions: [
        {
          name: 'select_source',
          description:
            'Switch between cloud, attached-session local, and repository baseline results.',
          inputSchema: {
            type: 'object',
            properties: {
              source: { type: 'string', enum: ['cloud', 'local', 'repository'] },
            },
            required: ['source'],
          },
          handler: async (ctx) => {
            const state =
              ctx.input.source === 'local'
                ? await switchToLocalCatalog(ctx.instanceId)
                : ctx.input.source === 'repository'
                  ? await switchToRepository(ctx.instanceId)
                  : await switchToCloud(ctx.instanceId);
            if (state.error) throw new CanvasError('source_switch_failed', state.error);
            return stateSnapshot(state, POLL_INTERVAL_MS);
          },
        },
        {
          name: 'list_repository_results',
          description: 'List committed baseline snapshots from the repository baselines branch.',
          handler: async (ctx) => {
            const state = await switchToRepository(ctx.instanceId);
            if (state.error) throw new CanvasError('repository_list_failed', state.error);
            return {
              branches: state.repositoryBranches.map(safeRepositoryBranch),
              branch: safeRepositoryBranch(state.selectedRepositoryBranch),
              artifacts: state.repositoryArtifacts.map(safeRepositoryArtifact),
              errors: state.repositoryErrors,
            };
          },
        },
        {
          name: 'select_repository_result',
          description: 'Load a committed baseline snapshot from the repository baselines branch.',
          inputSchema: {
            type: 'object',
            properties: {
              branch: { type: 'string' },
              path: { type: 'string' },
            },
            required: ['branch', 'path'],
          },
          handler: async (ctx) => {
            const state = await switchToRepository(
              ctx.instanceId,
              ctx.input.branch,
              ctx.input.path,
            );
            if (state.error) throw new CanvasError('repository_load_failed', state.error);
            return summaryPayload(state);
          },
        },
        {
          name: 'load_file',
          description: 'Switch to a local experiment JSON file.',
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
            'List valid experiment results from the attached session worktree, newest first.',
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
          description: 'Select a discovered attached-session local experiment result.',
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
          description:
            'Select and load a GitHub Actions workflow run by run id: weapon-sweep, AI Sweep Eval, or a post-release baseline-sweep (deploy.yml) run.',
          inputSchema: {
            type: 'object',
            properties: { runId: { type: 'integer', minimum: 1 } },
            required: ['runId'],
          },
          handler: async (ctx) => {
            const state = await switchToCloudRun(ctx.instanceId, ctx.input.runId);
            if (state.error) throw new CanvasError('cloud_refresh_failed', state.error);
            const workflowType = state.selectedRun?.workflowType ?? null;
            if (!state.data) {
              return {
                run: safeRun(state.selectedRun),
                workflowType,
                selectionReason: state.selectionReason,
                warning: state.warning,
                polling: Boolean(state.pollTimer),
                // weapon-sweep fields
                expectedWeapons: state.expectedWeapons,
                availableWeapons: state.availableWeapons,
                // ai-sweep fields
                jobPhases: state.jobPhases,
              };
            }
            return summaryPayload(state);
          },
        },
        {
          name: 'list_cloud_runs',
          description:
            'List every cloud weapon-sweep and AI Sweep Eval workflow run, newest first.',
          handler: async (ctx) => {
            const state = states.get(ctx.instanceId);
            if (!state) throw new CanvasError('no_state', 'Canvas not open');
            await runCancellableOperation(state, async (signal) => {
              const context =
                state.context ?? (await resolveProjectContext(state.workingDirectory, signal));
              const runs = await listAllSweepRuns(context.repository, signal);
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
            repositoryBranches: [],
            selectedRepositoryBranch: null,
            repositoryArtifacts: [],
            repositoryErrors: [],
            selectedRepositoryPath: null,
            repositoryArtifactKind: null,
            workingDirectory: ctx.session?.workingDirectory ?? null,
            sessionId: ctx.sessionId,
            context: null,
            runs: [],
            selectedRun: null,
            selectionReason: null,
            expectedWeapons: [],
            availableWeapons: [],
            expiredArtifactCount: 0,
            jobPhases: null,
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
        } else if (ctx.input?.branch || ctx.input?.artifactPath) {
          await switchToRepository(ctx.instanceId, ctx.input?.branch, ctx.input?.artifactPath);
        } else {
          cancelRefresh(state);
          state.source = 'cloud';
          await initializeCloud(ctx.instanceId, ctx.input?.runId);
        }
        const workflowType =
          state.repositoryArtifactKind ?? state.selectedRun?.workflowType ?? null;
        return {
          title: workflowType === 'ai-sweep' ? '🤖 AI Sweep Eval' : '🗡️ Sweep Results',
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
