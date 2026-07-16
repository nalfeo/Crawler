function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
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

  const floors = normalizeFloors(value.floors);
  return {
    ...value,
    ...(floors === undefined ? {} : { floors }),
  };
}
