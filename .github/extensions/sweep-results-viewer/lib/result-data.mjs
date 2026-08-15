const VALID_RUN_OUTCOMES = new Set(['victory', 'death', 'timeout', 'stalled', 'error', 'quit']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function normalizeFloors(value) {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0 || !value.every(isPositiveInteger)) {
    throw new Error('floors must be a non-empty array of positive integers');
  }
  return [...new Set(value)].sort((left, right) => left - right);
}

export function normalizeSweepResult(value) {
  if (!isPlainObject(value)) {
    throw new Error('result must be a JSON object');
  }
  if (value.schemaVersion === 'crawler.experiment.v1' && !Array.isArray(value.weapons)) {
    return normalizeGenericExperiment(value);
  }
  if (typeof value.runAt !== 'string' || !Number.isFinite(Date.parse(value.runAt))) {
    throw new Error('runAt must be a valid timestamp');
  }

  function normalizeGenericExperiment(value) {
    if (
      !isPlainObject(value.experiment) ||
      typeof value.experiment.type !== 'string' ||
      typeof value.runAt !== 'string' ||
      !Number.isFinite(Date.parse(value.runAt)) ||
      !Array.isArray(value.records) ||
      !Array.isArray(value.aggregates)
    ) {
      throw new Error('generic experiment requires experiment, runAt, records, and aggregates');
    }
    const dimensions = isPlainObject(value.dimensions) ? value.dimensions : {};
    const dimensionLabels = (...names) => {
      for (const name of names) {
        const labels = Array.isArray(dimensions[name])
          ? dimensions[name].filter((item) => typeof item === 'string')
          : [];
        if (labels.length > 0) return labels;
      }
      return [];
    };
    const weapons = dimensionLabels(
      'weapon',
      'startingWeapon',
      'persona',
      'playerPersona',
      'weaponPersona',
    );
    const seeds = value.records
      .map((record) => record?.seed)
      .filter((seed) => isPositiveInteger(seed));
    const allRecords = value.records.map((record, index) => {
      if (
        !isPlainObject(record) ||
        !isPlainObject(record.dimensions) ||
        !isPlainObject(record.metrics)
      ) {
        throw new Error(`records[${index}] must contain dimensions and metrics objects`);
      }
      const metric = (name, fallback = 0) =>
        isFiniteNumber(record.metrics[name]) ? record.metrics[name] : fallback;
      const weapon =
        typeof record.dimensions.weapon === 'string'
          ? record.dimensions.weapon
          : typeof record.dimensions.startingWeapon === 'string'
            ? record.dimensions.startingWeapon
            : typeof record.dimensions.persona === 'string'
              ? record.dimensions.persona
              : typeof record.dimensions.playerPersona === 'string'
                ? record.dimensions.playerPersona
                : String(record.dimensions.weaponPersona ?? value.experiment.type);
      return {
        weapon,
        seed: isPositiveInteger(record.seed) ? record.seed : index + 1,
        outcome: typeof record.outcome === 'string' ? record.outcome : undefined,
        gameTimeSec: metric('gameTimeSec'),
        finalLevel: metric('finalLevel'),
        totalKills: metric('totalKills'),
        totalXp: metric('totalXp'),
        totalGold: metric('totalGold'),
        score: metric('score'),
        minHealthPct: metric('minHealthPct'),
        closeCallCount: metric('closeCallCount'),
        questsCompleted: metric('questsCompleted'),
        dimensions: record.dimensions,
        metrics: record.metrics,
      };
    });
    const labels =
      weapons.length > 0 ? weapons : [...new Set(allRecords.map((record) => record.weapon))];
    const summaries = labels.map((weapon) => {
      const records = allRecords.filter((record) => record.weapon === weapon);
      const mean = (field) =>
        records.length === 0
          ? 0
          : records.reduce((sum, record) => sum + record[field], 0) / records.length;
      const measuredRecords = records.filter((record) => typeof record.outcome === 'string');
      const victories = measuredRecords.filter((record) => record.outcome === 'victory').length;
      return {
        weapon,
        runs: records.length,
        victories,
        winRate: measuredRecords.length === 0 ? null : victories / measuredRecords.length,
        meanScore: mean('score'),
        meanGameTimeSec: mean('gameTimeSec'),
        meanLevel: mean('finalLevel'),
        meanKills: mean('totalKills'),
        meanXp: mean('totalXp'),
        meanMinHealthPct: mean('minHealthPct'),
        meanCloseCallCount: mean('closeCallCount'),
        meanQuestsCompleted: mean('questsCompleted'),
        records,
      };
    });
    const parameters = value.experiment.parameters;
    return {
      ...value,
      floors: Array.isArray(parameters?.floors) ? parameters.floors : undefined,
      seeds: [...new Set(seeds)].sort((left, right) => left - right),
      weapons: labels,
      maxFrames: isPositiveInteger(parameters?.maxFrames) ? parameters.maxFrames : 1,
      weaponPersonas: Boolean(parameters?.weaponPersonas),
      budgetSec: isFiniteNumber(parameters?.budgetSec) ? parameters.budgetSec : 0,
      summaries,
      allRecords,
    };
  }
  if (!Array.isArray(value.seeds) || !value.seeds.every(isPositiveInteger)) {
    throw new Error('seeds must be an array of positive integers');
  }
  if (
    !Array.isArray(value.weapons) ||
    value.weapons.length === 0 ||
    !value.weapons.every((weapon) => typeof weapon === 'string' && weapon.length > 0)
  ) {
    throw new Error('weapons must be a non-empty array of identifiers');
  }
  if (!isPositiveInteger(value.maxFrames)) {
    throw new Error('maxFrames must be a positive integer');
  }
  if (typeof value.weaponPersonas !== 'boolean') {
    throw new Error('weaponPersonas must be a boolean');
  }
  if (typeof value.budgetSec !== 'number' || !Number.isFinite(value.budgetSec)) {
    throw new Error('budgetSec must be a finite number');
  }
  if (!Array.isArray(value.summaries) || !Array.isArray(value.allRecords)) {
    throw new Error('summaries and allRecords must be arrays');
  }

  const weaponSet = new Set(value.weapons);
  const seedSet = new Set(value.seeds);

  for (let i = 0; i < value.summaries.length; i++) {
    const s = value.summaries[i];
    if (!isPlainObject(s)) {
      throw new Error(`summaries[${i}] must be a plain object`);
    }
    if (typeof s.weapon !== 'string' || s.weapon.length === 0 || !weaponSet.has(s.weapon)) {
      throw new Error(`summaries[${i}].weapon must be a known weapon identifier`);
    }
    if (!isNonNegativeInteger(s.runs)) {
      throw new Error(`summaries[${i}].runs must be a non-negative integer`);
    }
    if (!isNonNegativeInteger(s.victories)) {
      throw new Error(`summaries[${i}].victories must be a non-negative integer`);
    }
    for (const field of [
      'winRate',
      'meanScore',
      'meanGameTimeSec',
      'meanLevel',
      'meanKills',
      'meanMinHealthPct',
      'meanXp',
      'meanCloseCallCount',
      'meanQuestsCompleted',
    ]) {
      if (!isFiniteNumber(s[field])) {
        throw new Error(`summaries[${i}].${field} must be a finite number`);
      }
    }
    if (!Array.isArray(s.records)) {
      throw new Error(`summaries[${i}].records must be an array`);
    }
  }

  for (let i = 0; i < value.allRecords.length; i++) {
    const r = value.allRecords[i];
    if (!isPlainObject(r)) {
      throw new Error(`allRecords[${i}] must be a plain object`);
    }
    if (typeof r.weapon !== 'string' || r.weapon.length === 0 || !weaponSet.has(r.weapon)) {
      throw new Error(`allRecords[${i}].weapon must be a known weapon identifier`);
    }
    if (!isPositiveInteger(r.seed) || !seedSet.has(r.seed)) {
      throw new Error(`allRecords[${i}].seed must be a known seed`);
    }
    if (
      typeof r.outcome !== 'string' ||
      r.outcome.length === 0 ||
      !VALID_RUN_OUTCOMES.has(r.outcome)
    ) {
      throw new Error(
        `allRecords[${i}].outcome must be one of: ${[...VALID_RUN_OUTCOMES].join(', ')}`,
      );
    }
    if (!isNonNegativeInteger(r.finalLevel)) {
      throw new Error(`allRecords[${i}].finalLevel must be a non-negative integer`);
    }
    if (!isNonNegativeInteger(r.totalKills)) {
      throw new Error(`allRecords[${i}].totalKills must be a non-negative integer`);
    }
    for (const field of [
      'gameTimeSec',
      'score',
      'minHealthPct',
      'totalXp',
      'totalGold',
      'closeCallCount',
      'questsCompleted',
    ]) {
      if (!isFiniteNumber(r[field])) {
        throw new Error(`allRecords[${i}].${field} must be a finite number`);
      }
    }
  }

  const floors = normalizeFloors(value.floors);
  return {
    ...value,
    ...(floors === undefined ? {} : { floors }),
  };
}
