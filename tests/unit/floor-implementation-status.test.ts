import { describe, expect, it } from 'vitest';
import {
  getAvailableFloorIds,
  getFloorManifest,
  getFloorWinBudgetMs,
  getImplementedFloorIds,
  isFloorImplemented,
} from '../../src/shared/floor-registry.js';
import { floorManifestDefSchema, floor1Manifest } from '../../src/shared/floor-manifest.js';
import {
  getActiveTimeBudgetMs,
  getDefaultMaxFrames,
  requireActiveTimeBudgetMs,
  requireDefaultMaxFrames,
} from '../../src/game/ai/floor-run-budget.js';
import {
  FLOOR1_ACTIVE_TIME_BUDGET_MS,
  FLOOR1_DEFAULT_MAX_FRAMES,
} from '../../src/game/ai/floor1-run-budget.js';

describe('floor implementation status (manifest SSOT)', () => {
  it('marks Floor 1 implemented, released, and budgeted', () => {
    expect(isFloorImplemented('floor1')).toBe(true);
    expect(getFloorManifest('floor1')?.implemented.released).toBe(true);
    expect(getFloorWinBudgetMs('floor1')).toBe(600_000);
  });

  it('includes Floor 2 in the implemented (sweepable) set', () => {
    // Floor 2 is finishable E2E (floor2Scenario victory goal +
    // tests/headless/floor2-completion.test.ts), which is exactly what makes it
    // eligible for the sweep set even though it is not released to players yet.
    expect(isFloorImplemented('floor2')).toBe(true);
    expect(getImplementedFloorIds()).toContain('floor2');
  });

  it('keeps released a strict subset of implemented', () => {
    const implemented = new Set(getImplementedFloorIds());
    for (const floorId of getAvailableFloorIds()) {
      if (getFloorManifest(floorId)?.implemented.released !== true) continue;
      expect(implemented.has(floorId)).toBe(true);
    }
  });

  it('every registered floor resolves an implementation status', () => {
    for (const floorId of getAvailableFloorIds()) {
      expect(typeof isFloorImplemented(floorId)).toBe('boolean');
    }
  });

  it('throws for an unknown floor rather than silently reporting no budget', () => {
    // Silently returning null would degrade every run on a typo'd floor id to
    // "unbudgeted" instead of failing, so this must throw.
    expect(() => getFloorWinBudgetMs('floor-does-not-exist')).toThrow(/Unknown floor id/);
  });

  it('rejects a manifest that claims released without mvp', () => {
    expect(() =>
      floorManifestDefSchema.parse({
        ...floor1Manifest,
        implemented: { mvp: false, released: true },
      }),
    ).toThrow(/implemented.released requires implemented.mvp/);
  });

  it('defaults implemented to false when a manifest omits the block', () => {
    const { implemented: _omitted, ...withoutImplemented } = floor1Manifest;
    const parsed = floorManifestDefSchema.parse(withoutImplemented);
    expect(parsed.implemented).toEqual({ mvp: false, released: false });
  });
});

describe('per-floor run budget', () => {
  it('derives the Floor 1 frame cap from the collapse deadline', () => {
    // 39_600 is the 10-minute collapse horizon plus safe-room slack. The
    // gameplay-neutrality fingerprint is calibrated on. The FP-safe division
    // form matters: Math.ceil(36_000 * 1.1) would yield 39_601 because
    // 36_000 * 1.1 === 39600.00000000001.
    expect(getDefaultMaxFrames('floor1')).toBe(39_600);
    expect(FLOOR1_DEFAULT_MAX_FRAMES).toBe(39_600);
    expect(requireDefaultMaxFrames('floor1')).toBe(39_600);
  });

  it('aligns the Floor 1 active-time budget with its 10-minute collapse deadline', () => {
    expect(FLOOR1_ACTIVE_TIME_BUDGET_MS).toBe(10 * 60 * 1000);
    expect(getActiveTimeBudgetMs('floor1')).toBe(10 * 60 * 1000);
  });

  it('returns null for an implemented floor that declares no budget', () => {
    // Floor 2 has no validated active-time budget yet. Returning null (rather
    // than inheriting Floor 1's) keeps its win definition raw-victory instead
    // of silently failing clears against a budget nobody measured.
    expect(getActiveTimeBudgetMs('floor2')).toBeNull();
    expect(getDefaultMaxFrames('floor2')).toBeNull();
  });

  it('throws from the require* helpers for an unbudgeted floor', () => {
    expect(() => requireActiveTimeBudgetMs('floor2')).toThrow(
      /declares no implemented.winBudgetMs/,
    );
    expect(() => requireDefaultMaxFrames('floor2')).toThrow(/declares no implemented.winBudgetMs/);
  });
});
