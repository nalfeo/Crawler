import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  aggregateArtifactWeapon,
  expectedWeaponsFromJobs,
  normalizeRun,
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
    .replace(/\b(?:gh[opsu]_|github_pat_)[A-Za-z0-9_]+\b/g, '<redacted>')
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
  return sortRunsNewestFirst(rawRuns.map(normalizeRun));
}

async function getRun(repository, runId, signal) {
  return normalizeRun(
    await runGhJson(['api', '--method', 'GET', `repos/${repository}/actions/runs/${runId}`], {
      signal,
    }),
  );
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
