import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { normalizeSweepResult } from './result-data.mjs';

export const LOCAL_SWEEP_DIRECTORY = join('artifacts', 'weapon-sweeps');

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function localSweepDirectory(workingDirectory) {
  if (typeof workingDirectory !== 'string' || workingDirectory.trim().length === 0) {
    throw new Error('Canvas runtime did not provide an active project working directory.');
  }
  return join(workingDirectory, LOCAL_SWEEP_DIRECTORY);
}

export async function readLocalSweepFile(path) {
  let stats;
  let raw;
  try {
    [stats, raw] = await Promise.all([stat(path), readFile(path, 'utf8')]);
  } catch (error) {
    throw new Error(`Unable to read "${path}": ${errorMessage(error)}`);
  }
  if (!stats.isFile()) {
    throw new Error(`Unable to read "${path}": path is not a file`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in "${path}": ${errorMessage(error)}`);
  }
  try {
    return {
      data: normalizeSweepResult(parsed),
      loadedAt: stats.mtimeMs,
    };
  } catch (error) {
    throw new Error(`Invalid sweep result "${path}": ${errorMessage(error)}`);
  }
}

function safeTimestamp(milliseconds) {
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

export async function listLocalSweepResults(workingDirectory) {
  const directory = localSweepDirectory(workingDirectory);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { directory, runs: [], errors: [] };
    }
    return {
      directory,
      runs: [],
      errors: [{ path: directory, name: basename(directory), message: errorMessage(error) }],
    };
  }

  const runs = [];
  const errors = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) {
      continue;
    }
    const path = join(directory, entry.name);
    try {
      const loaded = await readLocalSweepFile(path);
      runs.push({
        path,
        name: entry.name,
        runAt: loaded.data.runAt,
        modifiedAt: safeTimestamp(loaded.loadedAt),
        floors: loaded.data.floors ?? null,
      });
    } catch (error) {
      errors.push({ path, name: entry.name, message: errorMessage(error) });
    }
  }

  runs.sort((left, right) => {
    const runAtDifference = Date.parse(right.runAt) - Date.parse(left.runAt);
    return (
      runAtDifference || right.name.localeCompare(left.name) || right.path.localeCompare(left.path)
    );
  });
  errors.sort((left, right) => left.name.localeCompare(right.name));
  return { directory, runs, errors };
}
