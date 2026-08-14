import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 20 * 1024 * 1024;
const BASELINES_BRANCH = 'baselines';

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function runGit(workingDirectory, args, signal) {
  if (typeof workingDirectory !== 'string' || workingDirectory.trim().length === 0) {
    throw new Error('Canvas runtime did not provide an active project working directory.');
  }
  try {
    const result = await execFileAsync('git', args, {
      cwd: workingDirectory,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      signal,
      windowsHide: true,
    });
    return result.stdout;
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    const detail = String(error?.stderr || error?.message || error)
      .replace(/\s+/g, ' ')
      .trim();
    throw new Error(`git command failed${detail ? `: ${detail}` : ''}`, { cause: error });
  }
}

export async function listBenchmarkBranches(workingDirectory, signal) {
  const output = await runGit(
    workingDirectory,
    [
      'for-each-ref',
      '--format=%(refname)',
      `refs/heads/${BASELINES_BRANCH}`,
      `refs/remotes/origin/${BASELINES_BRANCH}`,
    ],
    signal,
  );
  const refs = output
    .split(/\r?\n/)
    .map((ref) => ref.trim())
    .filter(Boolean);
  const localRef = refs.find((ref) => ref === `refs/heads/${BASELINES_BRANCH}`);
  const remoteRef = refs.find((ref) => ref === `refs/remotes/origin/${BASELINES_BRANCH}`);
  if (!localRef && !remoteRef) return [];
  // Prefer the remote-tracking ref: the local branch can be stale or divergent.
  return [{ name: BASELINES_BRANCH, ref: remoteRef ?? localRef, local: !remoteRef }];
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeRepositoryArtifact(value) {
  if (
    !isPlainObject(value) ||
    !isPlainObject(value.meta) ||
    typeof value.meta.capturedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.meta.capturedAt)) ||
    !Array.isArray(value.perWeapon) ||
    value.perWeapon.length === 0 ||
    !value.perWeapon.every(
      (entry) =>
        isPlainObject(entry) &&
        typeof entry.weapon === 'string' &&
        Number.isInteger(entry.wins) &&
        Number.isInteger(entry.slowVictories) &&
        Number.isInteger(entry.runs),
    ) ||
    !Number.isInteger(value.totalWins) ||
    !Number.isInteger(value.totalRuns) ||
    typeof value.winRate !== 'number' ||
    !Number.isFinite(value.winRate)
  ) {
    throw new Error('result is not a valid baseline sweep artifact');
  }
  return { kind: 'baseline', data: value };
}

async function readArtifact(workingDirectory, ref, path, signal) {
  let parsed;
  try {
    parsed = JSON.parse(await runGit(workingDirectory, ['show', `${ref}:${path}`], signal));
  } catch (error) {
    throw new Error(`Unable to load "${path}" from ${ref}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  try {
    return normalizeRepositoryArtifact(parsed);
  } catch (error) {
    throw new Error(`Invalid baseline result "${path}": ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

export async function listRepositoryResultArtifacts(workingDirectory, branch, signal) {
  if (!branch?.ref || branch.name !== BASELINES_BRANCH) {
    throw new Error('The repository baselines branch is required.');
  }
  let index;
  try {
    index = JSON.parse(
      await runGit(workingDirectory, ['show', `${branch.ref}:index.json`], signal),
    );
  } catch (error) {
    throw new Error(
      `Unable to load the baseline index from ${branch.name}: ${errorMessage(error)}`,
      {
        cause: error,
      },
    );
  }
  if (!Array.isArray(index)) throw new Error('Baseline index.json must be an array.');

  const artifacts = [];
  const errors = [];
  for (const entry of index) {
    if (
      !isPlainObject(entry) ||
      typeof entry.path !== 'string' ||
      !entry.path.startsWith('by-sha/') ||
      typeof entry.capturedAt !== 'string' ||
      !Number.isFinite(Date.parse(entry.capturedAt))
    ) {
      errors.push({
        path: 'index.json',
        name: 'index.json',
        message: 'Skipped malformed baseline index entry.',
      });
      continue;
    }
    artifacts.push({
      path: entry.path,
      name: entry.commitSubject ?? basename(entry.path),
      kind: 'baseline',
      generatedAt: entry.capturedAt,
      commit: entry.commit ?? null,
      winRate: entry.winRate ?? null,
      totalWins: entry.totalWins ?? null,
      totalRuns: entry.totalRuns ?? null,
    });
  }
  return { branch, artifacts, errors };
}

export async function readRepositoryResultArtifact(workingDirectory, branch, path, signal) {
  if (!branch?.ref || typeof path !== 'string' || path.length === 0) {
    throw new Error('A baseline artifact path is required.');
  }
  const catalog = await listRepositoryResultArtifacts(workingDirectory, branch, signal);
  if (!catalog.artifacts.some((artifact) => artifact.path === path)) {
    throw new Error(`Baseline "${path}" is not available on ${branch.name}.`);
  }
  return readArtifact(workingDirectory, branch.ref, path, signal);
}
