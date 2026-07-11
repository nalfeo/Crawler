/**
 * Unit tests for the cross-run judge cost ceiling (`JudgeBudget`).
 *
 * Coverage:
 *   - `costForUsage` math correctness against Azure-published rates.
 *   - `resolveRates` falls back to the conservative FALLBACK_RATES when
 *     the deployment is unknown, and matches by substring otherwise.
 *   - `Infinity` budget never trips `wouldExceed` (single-brief default).
 *   - Exhaustion: once `recordCall` pushes spend past the ceiling,
 *     `wouldExceed` returns true on the next check.
 *   - Persistence round-trip: a fresh `JudgeBudget` reading the same
 *     state file picks up cumulative spend; `reset: true` clears it.
 *   - `recordSkip` bumps the per-run skipped counter without touching
 *     persistent state.
 *   - Concurrent processes both land their deltas (lock-protected RMW).
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  costForUsage,
  FALLBACK_RATES,
  JudgeBudget,
  PRICING,
  resolveRates,
} from '../../../scripts/sprites/cost-tracker.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function tmpStateFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'judge-budget-'));
  return path.join(dir, 'cost-state.json');
}

describe('costForUsage', () => {
  it('matches Azure gpt-4o rates (input $2.50/M, output $10.00/M)', () => {
    const rates = { inputPerMillion: 2.5, outputPerMillion: 10.0 };
    const usage = { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 };
    // 1M input @ $2.50 + 1M output @ $10.00 = $12.50
    expect(costForUsage(usage, rates)).toBeCloseTo(12.5, 10);
  });

  it('scales linearly with smaller token counts', () => {
    const rates = { inputPerMillion: 10, outputPerMillion: 30 };
    const usage = { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 };
    // 1000 * 10/1M + 500 * 30/1M = 0.01 + 0.015 = 0.025
    expect(costForUsage(usage, rates)).toBeCloseTo(0.025, 10);
  });

  it('returns 0 for zero tokens', () => {
    const rates = { inputPerMillion: 10, outputPerMillion: 30 };
    expect(costForUsage({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }, rates)).toBe(0);
  });
});

describe('resolveRates', () => {
  it('matches known deployment substrings case-insensitively', () => {
    expect(resolveRates('gpt-4o-vision-eastus')).toEqual(
      PRICING.find((p) => p.match === 'gpt-4o')!.rates,
    );
    expect(resolveRates('GPT-4O-MINI')).toEqual(
      PRICING.find((p) => p.match === 'gpt-4o-mini')!.rates,
    );
  });

  it('prefers the more specific mini match over the generic gpt-4o', () => {
    // gpt-4o-mini appears first in PRICING; substring scan returns it
    // before gpt-4o for a name like "gpt-4o-mini-foo".
    expect(resolveRates('gpt-4o-mini-2026-08')).toEqual(
      PRICING.find((p) => p.match === 'gpt-4o-mini')!.rates,
    );
  });

  it('returns FALLBACK_RATES on unknown deployment (conservative)', () => {
    expect(resolveRates('claude-7-omni-mega')).toEqual(FALLBACK_RATES);
  });
});

describe('JudgeBudget.wouldExceed', () => {
  it('returns false for an Infinity budget regardless of spend', async () => {
    const budget = new JudgeBudget({
      budgetUsd: Number.POSITIVE_INFINITY,
      modelDeployment: 'gpt-4o',
      stateFile: tmpStateFile(),
      reset: true,
    });
    // Burn a lot.
    await budget.recordCall({
      promptTokens: 10_000_000,
      completionTokens: 10_000_000,
      totalTokens: 20_000_000,
    });
    expect(budget.wouldExceed()).toBe(false);
    expect(budget.wouldExceed(100_000_000)).toBe(false);
  });

  it('returns true once recorded spend meets/exceeds the ceiling', async () => {
    const budget = new JudgeBudget({
      budgetUsd: 0.01,
      modelDeployment: 'gpt-4o', // $2.50/M in, $10/M out
      stateFile: tmpStateFile(),
      reset: true,
    });
    expect(budget.wouldExceed()).toBe(false);
    // 1000 output tokens = $0.01 — exactly at the ceiling.
    await budget.recordCall({ promptTokens: 0, completionTokens: 1000, totalTokens: 1000 });
    expect(budget.wouldExceed()).toBe(true);
  });

  it('uses the estimatedTokens pre-flight at the output rate (conservative)', () => {
    const budget = new JudgeBudget({
      budgetUsd: 0.01,
      modelDeployment: 'gpt-4o', // output $10/M
      stateFile: tmpStateFile(),
      reset: true,
    });
    // 2000 tokens * $10/M = $0.02, which exceeds $0.01 from a clean
    // slate — the pre-flight must trip.
    expect(budget.wouldExceed(2000)).toBe(true);
    // 500 tokens * $10/M = $0.005 — fits.
    expect(budget.wouldExceed(500)).toBe(false);
  });

  it('rejects negative/NaN budgets', () => {
    expect(() => new JudgeBudget({ budgetUsd: -1, modelDeployment: 'gpt-4o' })).toThrow();
    expect(() => new JudgeBudget({ budgetUsd: Number.NaN, modelDeployment: 'gpt-4o' })).toThrow();
  });
});

describe('JudgeBudget persistence', () => {
  it('round-trips spend across instances pointed at the same state file', async () => {
    const stateFile = tmpStateFile();
    const a = new JudgeBudget({
      budgetUsd: 1.0,
      modelDeployment: 'gpt-4o',
      stateFile,
      reset: true,
    });
    await a.recordCall({ promptTokens: 100_000, completionTokens: 100_000, totalTokens: 200_000 });
    const aSnap = a.snapshot();
    // gpt-4o: 100k * $2.50/M + 100k * $10/M = $0.25 + $1.00 = $1.25
    // but budget is $1 so we're "over"; snapshot still reports it.
    expect(aSnap.spentUsd).toBeCloseTo(1.25, 6);

    const b = new JudgeBudget({
      budgetUsd: 1.0,
      modelDeployment: 'gpt-4o',
      stateFile,
      // No reset — should load existing state.
    });
    const bSnap = b.snapshot();
    expect(bSnap.spentUsd).toBeCloseTo(1.25, 6);
    expect(bSnap.callCount).toBe(1);
    expect(b.wouldExceed()).toBe(true);
  });

  it('reset: true wipes prior state', async () => {
    const stateFile = tmpStateFile();
    const a = new JudgeBudget({
      budgetUsd: 1.0,
      modelDeployment: 'gpt-4o',
      stateFile,
      reset: true,
    });
    await a.recordCall({ promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 });
    expect(a.snapshot().spentUsd).toBeGreaterThan(0);

    const fresh = new JudgeBudget({
      budgetUsd: 1.0,
      modelDeployment: 'gpt-4o',
      stateFile,
      reset: true,
    });
    expect(fresh.snapshot().spentUsd).toBe(0);
    expect(fresh.snapshot().callCount).toBe(0);
  });

  it('writes a valid versioned JSON state file', async () => {
    const stateFile = tmpStateFile();
    const budget = new JudgeBudget({
      budgetUsd: 1.0,
      modelDeployment: 'gpt-4o',
      stateFile,
      reset: true,
    });
    await budget.recordCall({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });
    expect(existsSync(stateFile)).toBe(true);
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
    expect(parsed.version).toBe(1);
    expect(typeof parsed.spentUsd).toBe('number');
    expect(parsed.callCount).toBe(1);
    expect(typeof parsed.lastUpdated).toBe('string');
  });

  it('treats a corrupt state file as empty (no crash)', () => {
    const stateFile = tmpStateFile();
    // Write garbage to a fresh state file via a budget then corrupt it.
    new JudgeBudget({ budgetUsd: 1, modelDeployment: 'gpt-4o', stateFile, reset: true });
    writeFileSync(stateFile, 'not-json-at-all');
    const recovered = new JudgeBudget({ budgetUsd: 1, modelDeployment: 'gpt-4o', stateFile });
    expect(recovered.snapshot().spentUsd).toBe(0);
    expect(recovered.snapshot().callCount).toBe(0);
  });
});

describe('JudgeBudget.recordSkip', () => {
  it('bumps the per-run skipped counter without changing cumulative spend', () => {
    const budget = new JudgeBudget({
      budgetUsd: 1.0,
      modelDeployment: 'gpt-4o',
      stateFile: tmpStateFile(),
      reset: true,
    });
    const before = budget.snapshot();
    budget.recordSkip();
    budget.recordSkip();
    const after = budget.snapshot();
    expect(after.callsSkippedDueToBudget).toBe(2);
    expect(after.spentUsd).toBe(before.spentUsd);
    expect(after.callCount).toBe(before.callCount);
  });
});

describe('JudgeBudget.format', () => {
  it('produces a single-line summary including spend and cap', async () => {
    const budget = new JudgeBudget({
      budgetUsd: 0.5,
      modelDeployment: 'gpt-4o',
      stateFile: tmpStateFile(),
      reset: true,
    });
    await budget.recordCall({ promptTokens: 1000, completionTokens: 500, totalTokens: 1500 });
    const line = budget.format();
    expect(line).toMatch(/judge-budget/);
    expect(line).toMatch(/\$0\.5000/);
    expect(line).not.toMatch(/\n/);
  });

  it('renders "<no cap>" for an Infinity budget', () => {
    const budget = new JudgeBudget({
      budgetUsd: Number.POSITIVE_INFINITY,
      modelDeployment: 'gpt-4o',
      stateFile: tmpStateFile(),
      reset: true,
    });
    expect(budget.format()).toMatch(/<no cap>/);
  });
});

describe('JudgeBudget concurrency', () => {
  it('two concurrent processes both land their deltas (lock-protected RMW)', async () => {
    const stateFile = tmpStateFile();
    // Initialise the file so both workers read a consistent baseline.
    new JudgeBudget({
      budgetUsd: Infinity,
      modelDeployment: 'gpt-4o-mini',
      stateFile,
      reset: true,
    });

    // Each worker records 10 calls: 100 prompt + 50 completion @ gpt-4o-mini rates.
    // $0.15/M in + $0.60/M out → 100 * 0.15/1e6 + 50 * 0.60/1e6 = 0.000015 + 0.000030 = $0.000045 per call.
    // 10 calls × 2 workers = 20 calls total, $0.0009 total.
    const workerScript = path.join(__dirname, '_fixtures', 'judge-budget-worker.ts');
    const tsx = path.resolve(__dirname, '../../../node_modules/.bin/tsx');

    await Promise.all([
      execFileAsync(tsx, [workerScript, stateFile, '10']),
      execFileAsync(tsx, [workerScript, stateFile, '10']),
    ]);

    const parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as {
      callCount: number;
      spentUsd: number;
    };
    expect(parsed.callCount).toBe(20);
    expect(parsed.spentUsd).toBeCloseTo(0.0009, 6);
  }, // Give the two sub-processes generous headroom on a loaded CI runner.
  30_000);
});
