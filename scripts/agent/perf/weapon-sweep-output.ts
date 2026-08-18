import { join } from 'node:path';

import type { WeaponSweepOutput } from './weapon-sweep-results.js';
import {
  EXPERIMENT_ARTIFACT_DIRECTORY,
  weaponSweepToExperiment,
  writeExperimentResult,
} from './experiment-result.js';

export const WEAPON_SWEEP_ARTIFACT_DIRECTORY = EXPERIMENT_ARTIFACT_DIRECTORY;

export function formatWeaponSweepTimestamp(date: Date): string {
  if (!Number.isFinite(date.getTime())) {
    throw new Error('Weapon sweep output timestamp must be a valid date');
  }
  return date.toISOString().replaceAll(':', '-');
}

export function defaultWeaponSweepOutputPath(
  workingDirectory: string,
  runAt: Date,
  collisionIndex = 1,
): string {
  const suffix = collisionIndex > 1 ? `-${collisionIndex}` : '';
  return join(
    workingDirectory,
    WEAPON_SWEEP_ARTIFACT_DIRECTORY,
    `weapon-sweep-${formatWeaponSweepTimestamp(runAt)}${suffix}.json`,
  );
}

export function writeWeaponSweepOutput(
  output: WeaponSweepOutput,
  explicitPath: string | undefined,
  workingDirectory = process.cwd(),
): string {
  const result = weaponSweepToExperiment(output);
  return writeExperimentResult(result, explicitPath, workingDirectory);
}
