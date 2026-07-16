import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  listLocalSweepResults,
  localSweepDirectory,
  readLocalSweepFile,
} from '../lib/local-results.mjs';

function result(runAt, floors) {
  return {
    runAt,
    ...(floors === undefined ? {} : { floors }),
    seeds: [1],
    weapons: ['sword'],
    maxFrames: 60,
    weaponPersonas: false,
    budgetSec: 1,
    summaries: [],
    allRecords: [],
  };
}

async function withWorkspace(callback) {
  const workspace = await mkdtemp(join(tmpdir(), 'crawler-local-sweeps-'));
  try {
    const directory = localSweepDirectory(workspace);
    await mkdir(directory, { recursive: true });
    await callback({ workspace, directory });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

test('discovers valid canonical results newest-first without recursing', async () => {
  await withWorkspace(async ({ workspace, directory }) => {
    await writeFile(
      join(directory, 'older.json'),
      JSON.stringify(result('2026-07-16T10:00:00Z', [2, 1, 2])),
    );
    await writeFile(
      join(directory, 'newer.json'),
      JSON.stringify(result('2026-07-16T11:00:00Z', [3])),
    );
    await mkdir(join(directory, 'nested'));
    await writeFile(
      join(directory, 'nested', 'ignored.json'),
      JSON.stringify(result('2026-07-16T12:00:00Z', [4])),
    );

    const discovered = await listLocalSweepResults(workspace);
    assert.deepEqual(
      discovered.runs.map(({ name }) => name),
      ['newer.json', 'older.json'],
    );
    assert.deepEqual(discovered.runs[1].floors, [1, 2]);
    assert.deepEqual(discovered.errors, []);
  });
});

test('excludes invalid files and reports every parse or shape error explicitly', async () => {
  await withWorkspace(async ({ workspace, directory }) => {
    await writeFile(join(directory, 'broken-json.json'), '{');
    await writeFile(
      join(directory, 'broken-floors.json'),
      JSON.stringify(result('2026-07-16T11:00:00Z', [])),
    );
    await writeFile(
      join(directory, 'valid.json'),
      JSON.stringify(result('2026-07-16T10:00:00Z', undefined)),
    );

    const discovered = await listLocalSweepResults(workspace);
    assert.deepEqual(
      discovered.runs.map(({ name }) => name),
      ['valid.json'],
    );
    assert.deepEqual(
      discovered.errors.map(({ name }) => name),
      ['broken-floors.json', 'broken-json.json'],
    );
    assert.match(discovered.errors[0].message, /floors must be a non-empty array/);
    assert.match(discovered.errors[1].message, /Invalid JSON/);
  });
});

test('explicit file loading shares catalog validation and preserves legacy Unknown', async () => {
  await withWorkspace(async ({ directory }) => {
    const path = join(directory, 'legacy.json');
    await writeFile(path, JSON.stringify(result('2026-07-16T10:00:00Z', undefined)));
    const loaded = await readLocalSweepFile(path);
    assert.equal(Object.hasOwn(loaded.data, 'floors'), false);

    await writeFile(path, JSON.stringify(result('2026-07-16T10:00:00Z', ['1'])));
    await assert.rejects(() => readLocalSweepFile(path), /Invalid sweep result.*floors must/);
  });
});

test('missing canonical directory is an empty catalog, not an error', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'crawler-local-sweeps-missing-'));
  try {
    assert.deepEqual(await listLocalSweepResults(workspace), {
      directory: localSweepDirectory(workspace),
      runs: [],
      errors: [],
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
