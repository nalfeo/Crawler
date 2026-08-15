import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import {
  aggregateArtifactWeapon,
  expectedWeaponsFromJobs,
  isBaselineArtifact,
  isLeaderboardArtifact,
  normalizeRun,
  parseAiSweepJobPhases,
  sortRunsNewestFirst,
} from './cloud-results.mjs';

const execFileAsync = promisify(execFile);
const MAX_ARTIFACT_CACHE = 32;
const MAX_BUFFER = 50 * 1024 * 1024;

export function createLruCache(maxSize) {
  const map = new Map();
  return {
    get(key) {
      const value = map.get(key);
      if (value === undefined) return undefined;
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      if (map.size > maxSize) {
        map.delete(map.keys().next().value);
      }
    },
    get size() {
      return map.size;
    },
  };
}

const lruArtifactCache = createLruCache(MAX_ARTIFACT_CACHE);

/**
 * Thrown by `getBaselineSweepRun` when the given run id either does not exist
 * (HTTP 404) or resolves to a different workflow (wrong-workflow). Callers
 * that want to silently convert "not a baseline run" into an unresolved state
 * can catch only this type and let operational errors (auth/network/rate-limit)
 * propagate normally.
 */
export class BaselineRunNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BaselineRunNotFoundError';
  }
}

export function parseGitHubRepository(remoteUrl) {
  const remote = String(remoteUrl ?? '')
    .trim()
    .replace(/\.git$/i, '');
  const match =
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/i.exec(remote) ??
    /^git@github\.com:([^/]+)\/([^/]+)$/i.exec(remote) ??
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/i.exec(remote);
  return match ? `${match[1]}/${match[2]}` : null;
}

export function sanitizeErrorText(value, environment = process.env) {
  let text = String(value ?? '');
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    const secret = environment[name];
    if (secret) {
      text = text.replaceAll(secret, '<redacted>');
    }
  }
  return text
    .replace(/\b(?:gh[oprsu]_|github_pat_)[A-Za-z0-9_]+\b/g, '<redacted>')
    .replace(/\s+/g, ' ')
    .trim();
}

async function runCommand(binary, args, options = {}) {
  try {
    const result = await execFileAsync(binary, args, {
      cwd: options.cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: '1',
        GIT_TERMINAL_PROMPT: '0',
        GH_PAGER: 'cat',
        PAGER: 'cat',
      },
      maxBuffer: options.maxBuffer ?? MAX_BUFFER,
      signal: options.signal,
      windowsHide: true,
    });
    return result.stdout.trim();
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw error;
    }
    const detail = sanitizeErrorText(error?.stderr || error?.message || error);
    throw new Error(`${binary} command failed${detail ? `: ${detail}` : ''}`);
  }
}

async function runGhJson(args, options = {}) {
  const output = await runCommand('gh', args, options);
  try {
    return JSON.parse(output);
  } catch {
    throw new Error('GitHub CLI returned invalid JSON.');
  }
}

async function paginate(repo, path, collectionName, signal) {
  const values = [];
  for (let page = 1; ; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const response = await runGhJson(
      ['api', '--method', 'GET', `repos/${repo}/${path}${separator}per_page=100&page=${page}`],
      { signal },
    );
    const pageValues = response?.[collectionName];
    if (!Array.isArray(pageValues)) {
      throw new Error(`GitHub API response did not contain "${collectionName}".`);
    }
    values.push(...pageValues);
    if (pageValues.length < 100) {
      return values;
    }
  }
}

export async function resolveProjectContext(workingDirectory, signal) {
  if (!workingDirectory) {
    throw new Error('Canvas runtime did not provide an active project working directory.');
  }
  const [remoteUrl, branchName] = await Promise.all([
    runCommand('git', ['remote', 'get-url', 'origin'], { cwd: workingDirectory, signal }),
    runCommand('git', ['branch', '--show-current'], { cwd: workingDirectory, signal }),
  ]);
  const repository = parseGitHubRepository(remoteUrl);
  if (!repository) {
    throw new Error('Origin remote is not a supported github.com repository.');
  }
  return {
    workingDirectory,
    repository,
    branch: branchName || null,
  };
}

export async function listWeaponSweepRuns(repository, signal) {
  const rawRuns = await paginate(
    repository,
    'actions/workflows/weapon-sweep.yml/runs',
    'workflow_runs',
    signal,
  );
  return sortRunsNewestFirst(
    rawRuns.map((raw) => ({ ...normalizeRun(raw), workflowType: 'weapon-sweep' })),
  );
}

/**
 * Lists all AI Sweep Eval (`ai-sweep.yml`) workflow runs, newest first.
 * Each run is tagged with `workflowType: 'ai-sweep'`.
 */
export async function listAiSweepRuns(repository, signal) {
  const rawRuns = await paginate(
    repository,
    'actions/workflows/ai-sweep.yml/runs',
    'workflow_runs',
    signal,
  );
  return sortRunsNewestFirst(
    rawRuns.map((raw) => ({ ...normalizeRun(raw), workflowType: 'ai-sweep' })),
  );
}

/**
 * Lists all sweep runs (weapon-sweep + AI Sweep Eval) combined, newest first.
 * Each run carries a `workflowType` field indicating its source workflow.
 * Any rejection from either workflow request is propagated immediately.
 */
export async function listAllSweepRuns(repository, signal) {
  const [weaponRuns, aiRuns] = await Promise.all([
    listWeaponSweepRuns(repository, signal),
    listAiSweepRuns(repository, signal),
  ]);
  return sortRunsNewestFirst([...weaponRuns, ...aiRuns]);
}

/**
 * Creates bound list functions that use the provided `runGhJsonFn` as the
 * GitHub API boundary. Exported for unit tests that need to inject a mock.
 */
export function _createListClient(runGhJsonFn) {
  async function paginateWith(repo, path, collectionName, signal) {
    const values = [];
    for (let page = 1; ; page += 1) {
      const separator = path.includes('?') ? '&' : '?';
      const response = await runGhJsonFn(
        ['api', '--method', 'GET', `repos/${repo}/${path}${separator}per_page=100&page=${page}`],
        { signal },
      );
      const pageValues = response?.[collectionName];
      if (!Array.isArray(pageValues)) {
        throw new Error(`GitHub API response did not contain "${collectionName}".`);
      }
      values.push(...pageValues);
      if (pageValues.length < 100) {
        return values;
      }
    }
  }

  async function clientListWeaponSweepRuns(repository, signal) {
    const rawRuns = await paginateWith(
      repository,
      'actions/workflows/weapon-sweep.yml/runs',
      'workflow_runs',
      signal,
    );
    return sortRunsNewestFirst(
      rawRuns.map((raw) => ({ ...normalizeRun(raw), workflowType: 'weapon-sweep' })),
    );
  }

  async function clientListAiSweepRuns(repository, signal) {
    const rawRuns = await paginateWith(
      repository,
      'actions/workflows/ai-sweep.yml/runs',
      'workflow_runs',
      signal,
    );
    return sortRunsNewestFirst(
      rawRuns.map((raw) => ({ ...normalizeRun(raw), workflowType: 'ai-sweep' })),
    );
  }

  async function clientListAllSweepRuns(repository, signal) {
    const [weaponRuns, aiRuns] = await Promise.all([
      clientListWeaponSweepRuns(repository, signal),
      clientListAiSweepRuns(repository, signal),
    ]);
    return sortRunsNewestFirst([...weaponRuns, ...aiRuns]);
  }

  async function clientGetBaselineSweepRun(repository, runId, signal) {
    let raw;
    try {
      raw = await runGhJsonFn(
        ['api', '--method', 'GET', `repos/${repository}/actions/runs/${runId}`],
        { signal },
      );
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      if (/HTTP 404/i.test(error?.message ?? '')) {
        throw new BaselineRunNotFoundError(`Run ${runId} not found in ${repository}.`);
      }
      throw error;
    }
    if (raw?.path !== DEPLOY_WORKFLOW_PATH) {
      throw new BaselineRunNotFoundError(
        `Run ${runId} is not a "Deploy to GitHub Pages" workflow run in ${repository}.`,
      );
    }
    return { ...normalizeRun(raw), workflowType: 'baseline-sweep' };
  }

  return {
    listWeaponSweepRuns: clientListWeaponSweepRuns,
    listAiSweepRuns: clientListAiSweepRuns,
    listAllSweepRuns: clientListAllSweepRuns,
    getBaselineSweepRun: clientGetBaselineSweepRun,
  };
}

async function getRun(repository, runId, signal) {
  return normalizeRun(
    await runGhJson(['api', '--method', 'GET', `repos/${repository}/actions/runs/${runId}`], {
      signal,
    }),
  );
}

const DEPLOY_WORKFLOW_PATH = '.github/workflows/deploy.yml';

/**
 * Fetches a single `deploy.yml` workflow run by id, tagged
 * `workflowType: 'baseline-sweep'`. Unlike weapon-sweep/AI Sweep Eval,
 * `deploy.yml` runs continuously (every push to main) and is deliberately
 * NOT enumerated in `listAllSweepRuns` -- that would make an automatic,
 * mostly-non-sweep workflow dominate the manually-dispatched sweep picker.
 * A specific run id (e.g. from a release-baseline PR comment's sweep-run
 * link, or `meta.runId` in a published baseline) is still directly
 * selectable through this lookup.
 */
export async function getBaselineSweepRun(repository, runId, signal) {
  let raw;
  try {
    raw = await runGhJson(['api', '--method', 'GET', `repos/${repository}/actions/runs/${runId}`], {
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    if (/HTTP 404/i.test(error?.message ?? '')) {
      throw new BaselineRunNotFoundError(`Run ${runId} not found in ${repository}.`);
    }
    throw error;
  }
  if (raw?.path !== DEPLOY_WORKFLOW_PATH) {
    throw new BaselineRunNotFoundError(
      `Run ${runId} is not a "Deploy to GitHub Pages" workflow run in ${repository}.`,
    );
  }
  return { ...normalizeRun(raw), workflowType: 'baseline-sweep' };
}

async function listArtifacts(repository, runId, signal) {
  return paginate(repository, `actions/runs/${runId}/artifacts`, 'artifacts', signal);
}

async function listJobs(repository, runId, signal) {
  return paginate(repository, `actions/runs/${runId}/jobs`, 'jobs', signal);
}

async function findJsonFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findJsonFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(path);
    }
  }
  return files;
}

async function downloadArtifactJson(repository, runId, artifact, signal) {
  const signature = `${artifact.id}:${artifact.size_in_bytes}:${artifact.updated_at}`;
  const cached = lruArtifactCache.get(artifact.id);
  if (cached?.signature === signature) {
    return cached.data;
  }

  const directory = await mkdtemp(join(tmpdir(), 'crawler-sweep-artifact-'));
  try {
    await runCommand(
      'gh',
      [
        'run',
        'download',
        String(runId),
        '--repo',
        repository,
        '--name',
        artifact.name,
        '--dir',
        directory,
      ],
      { signal },
    );
    const jsonFiles = await findJsonFiles(directory);
    if (jsonFiles.length !== 1) {
      throw new Error(
        `Artifact "${artifact.name}" contained ${jsonFiles.length} JSON files; expected exactly one.`,
      );
    }
    const data = JSON.parse(await readFile(jsonFiles[0], 'utf8'));
    lruArtifactCache.set(artifact.id, { signature, data });
    return data;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Downloads an artifact that may contain several named JSON files (the
 * baseline-sweep artifact carries both `baseline.json` and an optional
 * sibling `fun-report.json`) and returns a map keyed by requested file name.
 * A requested file that is absent from the artifact resolves to `null`
 * rather than throwing, so a legacy or scoring-failed release still renders
 * its baseline without its (optional) fun-eval report.
 */
async function downloadArtifactJsonMap(repository, runId, artifact, fileNames, signal) {
  const signature = `${artifact.id}:${artifact.size_in_bytes}:${artifact.updated_at}`;
  const cacheKey = `map:${artifact.id}`;
  const cached = lruArtifactCache.get(cacheKey);
  if (cached?.signature === signature) {
    return cached.data;
  }

  const directory = await mkdtemp(join(tmpdir(), 'crawler-sweep-artifact-'));
  try {
    await runCommand(
      'gh',
      [
        'run',
        'download',
        String(runId),
        '--repo',
        repository,
        '--name',
        artifact.name,
        '--dir',
        directory,
      ],
      { signal },
    );
    const jsonFiles = await findJsonFiles(directory);
    const byBaseName = new Map(jsonFiles.map((filePath) => [basename(filePath), filePath]));
    const data = {};
    for (const fileName of fileNames) {
      const filePath = byBaseName.get(fileName);
      data[fileName] = filePath ? JSON.parse(await readFile(filePath, 'utf8')) : null;
    }
    lruArtifactCache.set(cacheKey, { signature, data });
    return data;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function loadCloudRun(repository, runId, signal) {
  const [run, artifacts, jobs] = await Promise.all([
    getRun(repository, runId, signal),
    listArtifacts(repository, runId, signal),
    listJobs(repository, runId, signal),
  ]);
  const aggregateArtifacts = artifacts
    .map((artifact) => ({ artifact, weapon: aggregateArtifactWeapon(artifact) }))
    .filter((entry) => entry.weapon !== null);
  const aggregateOutputs = await Promise.all(
    aggregateArtifacts.map(async ({ artifact, weapon }) => ({
      artifactId: artifact.id,
      weapon,
      data: await downloadArtifactJson(repository, runId, artifact, signal),
    })),
  );
  return {
    run,
    aggregateOutputs,
    aggregateArtifactIds: aggregateArtifacts.map(({ artifact }) => artifact.id).sort(),
    expectedWeapons: expectedWeaponsFromJobs(jobs),
    expiredArtifactCount: artifacts.filter(
      (artifact) => artifact.expired === true && /^weapon-sweep-(?!shard-)/.test(artifact.name),
    ).length,
  };
}

/**
 * Loads metadata, job phases, and leaderboard artifact for an AI Sweep Eval run.
 *
 * @param {string} repository  e.g. "nalfeo/Crawler"
 * @param {number} runId
 * @param {AbortSignal} signal
 * @returns {Promise<{ run: object, jobPhases: object, leaderboardData: object | null, expiredArtifactCount: number }>}
 */
export async function loadAiSweepRun(repository, runId, signal) {
  const [run, artifacts, jobs] = await Promise.all([
    getRun(repository, runId, signal),
    listArtifacts(repository, runId, signal),
    listJobs(repository, runId, signal),
  ]);

  const leaderboardArtifact = artifacts.find(isLeaderboardArtifact) ?? null;
  const leaderboardData = leaderboardArtifact
    ? await downloadArtifactJson(repository, runId, leaderboardArtifact, signal)
    : null;

  const expiredArtifactCount = artifacts.filter(
    (artifact) => artifact.expired === true && artifact.name === 'leaderboard',
  ).length;

  return {
    run,
    jobPhases: parseAiSweepJobPhases(jobs),
    leaderboardData,
    expiredArtifactCount,
  };
}

/**
 * Loads the post-release baseline-sweep artifact (`baseline.json` and its
 * optional sibling `fun-report.json`) for a `deploy.yml` run. There is at
 * most one relevant artifact per run and no job-phase breakdown, so this is
 * intentionally simpler than `loadCloudRun`/`loadAiSweepRun`.
 *
 * @param {string} repository  e.g. "nalfeo/Crawler"
 * @param {number} runId
 * @param {AbortSignal} signal
 * @returns {Promise<{ run: object, hasArtifact: boolean, baseline: object | null, funReport: object | null, expiredArtifactCount: number }>}
 */
export async function loadBaselineSweepRun(repository, runId, signal) {
  const [run, artifacts] = await Promise.all([
    getRun(repository, runId, signal),
    listArtifacts(repository, runId, signal),
  ]);

  const artifact = artifacts.find(isBaselineArtifact) ?? null;
  const files = artifact
    ? await downloadArtifactJsonMap(
        repository,
        runId,
        artifact,
        ['baseline.json', 'fun-report.json'],
        signal,
      )
    : null;

  const expiredArtifactCount = artifacts.filter(
    (candidate) =>
      candidate.expired === true && isBaselineArtifact({ ...candidate, expired: false }),
  ).length;

  return {
    run,
    hasArtifact: artifact !== null,
    baseline: files?.['baseline.json'] ?? null,
    funReport: files?.['fun-report.json'] ?? null,
    expiredArtifactCount,
  };
}
