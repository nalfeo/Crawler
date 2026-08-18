import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  FLOOR1_TIME_BUDGET_MS,
  GATE_MAX_FRAMES,
  GATE_SEEDS,
  GATE_WEAPONS,
} from '../../scripts/agent/perf/floor1-gate-sample.js';
import { GAME } from '../../src/shared/constants.js';
import {
  FLOOR1_ACTIVE_TIME_BUDGET_MS,
  FLOOR1_DEFAULT_MAX_FRAMES,
} from '../../src/game/ai/floor1-run-budget.js';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

describe('floor1 gate sample', () => {
  it('is a contiguous seed prefix so it cannot be gamed by cherry-picking', () => {
    expect(GATE_SEEDS).toEqual(GATE_SEEDS.map((_, i) => i + 1));
    expect(GATE_SEEDS.length).toBeGreaterThanOrEqual(8);
  });

  it('covers the three Floor 1 starter weapons', () => {
    expect([...GATE_WEAPONS].sort()).toEqual(['baseball-bat', 'bow', 'sword']);
  });

  it('caps frames just past the AI time budget', () => {
    expect(FLOOR1_TIME_BUDGET_MS).toBe(FLOOR1_ACTIVE_TIME_BUDGET_MS);
    expect(GATE_MAX_FRAMES).toBe(FLOOR1_DEFAULT_MAX_FRAMES);
    expect(GATE_MAX_FRAMES).toBe(Math.ceil((FLOOR1_TIME_BUDGET_MS * 1.1) / GAME.DELTA_MS));
  });

  it('is the single source both the CI gate and the fingerprint import', () => {
    // The fingerprint's whole value is that it covers the runs CI already
    // gates on. If either file re-declares the constants locally they can drift
    // apart silently and the fingerprint starts certifying a sample nobody
    // enforces — so assert the import, not just the values.
    for (const file of [
      'tests/headless/floor1-completion.test.ts',
      'scripts/agent/perf/sim-fingerprint.ts',
    ]) {
      const source = readFileSync(path.join(repoRoot, file), 'utf8');
      expect(source, `${file} must import the shared gate sample`).toMatch(
        /from '[^']*floor1-gate-sample\.js'/,
      );
    }
  });
});
