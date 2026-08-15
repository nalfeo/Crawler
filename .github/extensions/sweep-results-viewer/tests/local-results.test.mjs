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

function genericResult(runAt) {
  return {
    schemaVersion: 'crawler.experiment.v1',
    experiment: { type: 'persona-matrix', id: 'persona-matrix-1', parameters: {} },
    runAt,
    dimensions: { persona: ['experienced_player'] },
    records: [
      {
        id: 'persona-matrix-1:1',
        seed: 1,
        outcome: 'victory',
        dimensions: { persona: 'experienced_player' },
        metrics: { finalLevel: 3, totalXp: 100, totalGold: 20 },
      },
    ],
    aggregates: [],
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

function validRecord(weapon, seed) {
  return {
    weapon,
    seed,
    outcome: 'victory',
    gameTimeSec: 10,
    finalLevel: 2,
    totalKills: 3,
    totalXp: 50,
    totalGold: 10,
    score: 100,
    minHealthPct: 0.5,
    closeCallCount: 0,
    questsCompleted: 1,
  };
}

function validSummary(weapon) {
  return {
    weapon,
    runs: 1,
    victories: 1,
    winRate: 1,
    meanScore: 100,
    meanGameTimeSec: 10,
    meanLevel: 2,
    meanKills: 3,
    meanMinHealthPct: 0.5,
    meanXp: 50,
    meanCloseCallCount: 0,
    meanQuestsCompleted: 1,
    records: [],
  };
}

test('rejects null summary items and surfaces them as catalog errors', async () => {
  await withWorkspace(async ({ workspace, directory }) => {
    const data = { ...result('2026-07-16T10:00:00Z'), summaries: [null], allRecords: [] };
    await writeFile(join(directory, 'bad.json'), JSON.stringify(data));
    const discovered = await listLocalSweepResults(workspace);
    assert.deepEqual(discovered.runs, []);
    assert.equal(discovered.errors.length, 1);
    assert.match(discovered.errors[0].message, /summaries\[0\] must be a plain object/);
  });
});

test('rejects null record items and surfaces them as catalog errors', async () => {
  await withWorkspace(async ({ workspace, directory }) => {
    const data = {
      ...result('2026-07-16T10:00:00Z'),
      summaries: [validSummary('sword')],
      allRecords: [null],
    };
    await writeFile(join(directory, 'bad.json'), JSON.stringify(data));
    const discovered = await listLocalSweepResults(workspace);
    assert.deepEqual(discovered.runs, []);
    assert.equal(discovered.errors.length, 1);
    assert.match(discovered.errors[0].message, /allRecords\[0\] must be a plain object/);
  });
});

test('rejects summaries and records with unknown weapon or seed references', async () => {
  await withWorkspace(async ({ workspace, directory }) => {
    const unknownWeapon = {
      ...result('2026-07-16T10:00:00Z'),
      summaries: [validSummary('axe')],
      allRecords: [],
    };
    await writeFile(join(directory, 'unknown-weapon.json'), JSON.stringify(unknownWeapon));

    const unknownSeed = {
      ...result('2026-07-16T10:00:00Z'),
      summaries: [validSummary('sword')],
      allRecords: [validRecord('sword', 99)],
    };
    await writeFile(join(directory, 'unknown-seed.json'), JSON.stringify(unknownSeed));

    const valid = {
      ...result('2026-07-16T10:00:00Z'),
      summaries: [validSummary('sword')],
      allRecords: [validRecord('sword', 1)],
    };
    await writeFile(join(directory, 'valid.json'), JSON.stringify(valid));

    const discovered = await listLocalSweepResults(workspace);
    assert.deepEqual(
      discovered.runs.map(({ name }) => name),
      ['valid.json'],
    );
    assert.deepEqual(
      discovered.errors.map(({ name }) => name),
      ['unknown-seed.json', 'unknown-weapon.json'],
    );
    assert.match(discovered.errors[0].message, /allRecords\[0\]\.seed must be a known seed/);
    assert.match(discovered.errors[1].message, /summaries\[0\]\.weapon must be a known weapon/);
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

    test('discovers generic experiment envelopes alongside sweep projections', async () => {
      await withWorkspace(async ({ workspace, directory }) => {
        await writeFile(
          join(directory, 'persona.json'),
          JSON.stringify(genericResult('2026-07-16T12:00:00Z')),
        );
        const discovered = await listLocalSweepResults(workspace);
        assert.deepEqual(
          discovered.runs.map(({ name }) => name),
          ['persona.json'],
        );
        const loaded = await readLocalSweepFile(join(directory, 'persona.json'));
        assert.equal(loaded.data.summaries[0].weapon, 'experienced_player');
        assert.equal(loaded.data.allRecords[0].finalLevel, 3);
      });
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('rejects records with invalid outcome and missing required numeric fields', async () => {
  await withWorkspace(async ({ workspace, directory }) => {
    const invalidOutcome = {
      ...result('2026-07-16T10:00:00Z'),
      summaries: [validSummary('sword')],
      allRecords: [{ ...validRecord('sword', 1), outcome: 'exploded' }],
    };
    await writeFile(join(directory, 'bad-outcome.json'), JSON.stringify(invalidOutcome));

    const missingTotalXp = {
      ...result('2026-07-16T10:00:00Z'),
      summaries: [validSummary('sword')],
      allRecords: [{ ...validRecord('sword', 1), totalXp: undefined }],
    };
    await writeFile(join(directory, 'missing-totalxp.json'), JSON.stringify(missingTotalXp));

    const missingCloseCall = {
      ...result('2026-07-16T10:00:00Z'),
      summaries: [validSummary('sword')],
      allRecords: [{ ...validRecord('sword', 1), closeCallCount: undefined }],
    };
    await writeFile(join(directory, 'missing-closecall.json'), JSON.stringify(missingCloseCall));

    const discovered = await listLocalSweepResults(workspace);
    assert.deepEqual(discovered.runs, []);
    assert.equal(discovered.errors.length, 3);
    const names = discovered.errors.map(({ name }) => name).sort();
    assert.deepEqual(names, ['bad-outcome.json', 'missing-closecall.json', 'missing-totalxp.json']);
    assert.match(
      discovered.errors.find(({ name }) => name === 'bad-outcome.json').message,
      /allRecords\[0\]\.outcome must be one of/,
    );
    assert.match(
      discovered.errors.find(({ name }) => name === 'missing-totalxp.json').message,
      /allRecords\[0\]\.totalXp must be a finite number/,
    );
    assert.match(
      discovered.errors.find(({ name }) => name === 'missing-closecall.json').message,
      /allRecords\[0\]\.closeCallCount must be a finite number/,
    );
  });
});

test('rejects summaries missing required fields: records array, meanXp, meanCloseCallCount, meanQuestsCompleted', async () => {
  await withWorkspace(async ({ workspace, directory }) => {
    const missingRecords = {
      ...result('2026-07-16T10:00:00Z'),
      summaries: [{ ...validSummary('sword'), records: undefined }],
      allRecords: [],
    };
    await writeFile(join(directory, 'missing-records.json'), JSON.stringify(missingRecords));

    const missingMeanXp = {
      ...result('2026-07-16T10:00:00Z'),
      summaries: [{ ...validSummary('sword'), meanXp: undefined }],
      allRecords: [],
    };
    await writeFile(join(directory, 'missing-meanxp.json'), JSON.stringify(missingMeanXp));

    const discovered = await listLocalSweepResults(workspace);
    assert.deepEqual(discovered.runs, []);
    assert.equal(discovered.errors.length, 2);
    const names = discovered.errors.map(({ name }) => name).sort();
    assert.deepEqual(names, ['missing-meanxp.json', 'missing-records.json']);
    assert.match(
      discovered.errors.find(({ name }) => name === 'missing-records.json').message,
      /summaries\[0\]\.records must be an array/,
    );
    assert.match(
      discovered.errors.find(({ name }) => name === 'missing-meanxp.json').message,
      /summaries\[0\]\.meanXp must be a finite number/,
    );
  });
});
