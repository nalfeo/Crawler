import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  defaultWeaponSweepOutputPath,
  writeWeaponSweepOutput,
} from '../../scripts/agent/perf/weapon-sweep-output';
import type { WeaponSweepOutput } from '../../scripts/agent/perf/weapon-sweep-results';

const temporaryDirectories: string[] = [];

function output(runAt = '2026-07-16T16:31:44.116Z'): WeaponSweepOutput {
  return {
    runAt,
    floors: [1],
    seeds: [1],
    weapons: ['sword'],
    maxFrames: 60,
    weaponPersonas: false,
    budgetSec: 1,
    summaries: [],
    allRecords: [],
  };
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'crawler-weapon-sweep-output-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('weapon sweep output paths', () => {
  it('uses a Windows-safe stable UTC filename in the worktree artifact directory', () => {
    const workingDirectory = temporaryDirectory();
    const path = writeWeaponSweepOutput(output(), undefined, workingDirectory);

    expect(path).toBe(
      defaultWeaponSweepOutputPath(workingDirectory, new Date('2026-07-16T16:31:44.116Z')),
    );
    expect(basename(path)).toBe('weapon-sweep-2026-07-16T16-31-44.116Z.json');
    expect(JSON.parse(readFileSync(path, 'utf8')).floors).toEqual([1]);
  });

  it('adds deterministic numeric suffixes when the stable filename already exists', () => {
    const workingDirectory = temporaryDirectory();
    const first = writeWeaponSweepOutput(output(), undefined, workingDirectory);
    const second = writeWeaponSweepOutput(output(), undefined, workingDirectory);

    expect(basename(first)).toBe('weapon-sweep-2026-07-16T16-31-44.116Z.json');
    expect(basename(second)).toBe('weapon-sweep-2026-07-16T16-31-44.116Z-2.json');
  });

  it('preserves explicit output-path overwrite compatibility', () => {
    const workingDirectory = temporaryDirectory();
    const explicitPath = join(workingDirectory, 'explicit.json');

    writeWeaponSweepOutput(output('2026-07-16T16:00:00.000Z'), explicitPath, workingDirectory);
    writeWeaponSweepOutput(output('2026-07-16T17:00:00.000Z'), explicitPath, workingDirectory);

    expect(JSON.parse(readFileSync(explicitPath, 'utf8')).runAt).toBe('2026-07-16T17:00:00.000Z');
  });
});
