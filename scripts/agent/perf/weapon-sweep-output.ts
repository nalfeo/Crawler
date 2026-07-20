import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { WeaponSweepOutput } from './weapon-sweep-results.js';

export const WEAPON_SWEEP_ARTIFACT_DIRECTORY = join('artifacts', 'weapon-sweeps');

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
  const serialized = JSON.stringify(output, null, 2);
  if (explicitPath) {
    writeFileSync(explicitPath, serialized);
    return explicitPath;
  }

  const runAt = new Date(output.runAt);
  const directory = dirname(defaultWeaponSweepOutputPath(workingDirectory, runAt));
  mkdirSync(directory, { recursive: true });

  for (let collisionIndex = 1; ; collisionIndex += 1) {
    const candidate = defaultWeaponSweepOutputPath(workingDirectory, runAt, collisionIndex);
    try {
      writeFileSync(candidate, serialized, { flag: 'wx' });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
  }
}
