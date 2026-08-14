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
  if (typeof value.runAt !== 'string' || !Number.isFinite(Date.parse(value.runAt))) {
    throw new Error('runAt must be a valid timestamp');
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
