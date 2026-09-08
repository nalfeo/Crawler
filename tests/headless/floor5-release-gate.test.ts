import { describe, expect, it } from 'vitest';
import { applyDamage } from '../../src/core/index.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { AIState, type AIDecision, type AIInputProvider } from '../../src/game/ai/types.js';
import type { GameWorld } from '../../src/core/world.js';
import { floor5Manifest } from '../../src/shared/floor-manifest.js';

const FLOOR5_RELEASE_SMOKE_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
const FINALE_CHIP_INTERVAL_FRAMES = 4;

class IdleFloor5Provider implements AIInputProvider {
  private readonly decision: AIDecision = {
    state: AIState.EXPLORE,
    targetEid: null,
    targetX: null,
    targetY: null,
    reason: 'floor5 release-gate observation',
    npcInteraction: null,
    debug: null,
  };

  poll(): void {}
  getDecision(): AIDecision {
    return this.decision;
  }
  reset(): void {}
}

function chipFinaleActors(world: GameWorld, damage: number): void {
  const state = world.floorExtendedState?.floor5Siege;
  if (!state) return;
  const liveActors = [...state.finale.courtyardActors, ...state.finale.throneActors]
    .filter(
      (actor) =>
        actor.defeatedFrame === null &&
        actor.eid > 0 &&
        (world.stores.health.current[actor.eid] ?? 0) > 0,
    )
    .sort((left, right) => left.eid - right.eid);
  const target = liveActors[0];
  if (!target) return;
  applyDamage(
    world,
    target.eid,
    damage,
    world.stores.position.x[target.eid] ?? 0,
    world.stores.position.y[target.eid] ?? 0,
    { origin: 'environment', affinity: 'physical', scaleWithPrimary: false, canCrit: false },
  );
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

function p95(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index]!;
}

describe('Floor 5 release gate headless telemetry', () => {
  it('emits Floor 5 release-gate telemetry on the local 10-seed smoke panel', async () => {
    const gate = floor5Manifest.floor5?.releaseGate;
    if (!gate) throw new Error('Floor 5 release-gate thresholds missing');

    const runs = [];
    for (const seed of FLOOR5_RELEASE_SMOKE_SEEDS) {
      const stats = await runHeadless(new IdleFloor5Provider(), {
        floorId: 'floor5',
        seed,
        maxFrames: gate.maxP95DurationFrames + 1_000,
        maxWallTimeMs: 30_000,
        questStallFrames: gate.stallBackstopFrames,
        simulationOptions: {
          postSystems: [
            (world) => {
              if (world.frameCount % FINALE_CHIP_INTERVAL_FRAMES === 0) {
                chipFinaleActors(world, 12);
              }
            },
          ],
        },
      });
      runs.push({ seed, stats });
    }

    const wins = runs.filter((run) => run.stats.outcome === 'victory');
    expect(wins.length / runs.length).toBeGreaterThanOrEqual(gate.completionRateTarget);
    const ramSurvivalRate =
      runs.filter((run) => run.stats.floor5Siege?.releaseGate.ramSurvivedBreach === true).length /
      runs.length;
    expect(ramSurvivalRate).toBeGreaterThanOrEqual(gate.minimumRamSurvivalRate);

    const victoryFrames = wins.map((run) => run.stats.totalFrames);
    expect(victoryFrames.length).toBeGreaterThan(0);
    expect(median(victoryFrames)).toBeLessThanOrEqual(gate.maxMedianDurationFrames);
    expect(p95(victoryFrames)).toBeLessThanOrEqual(gate.maxP95DurationFrames);

    for (const { seed, stats } of runs) {
      const siege = stats.floor5Siege;
      expect(siege, `seed ${seed} emitted Floor 5 telemetry`).toBeDefined();
      if (!siege) continue;
      expect(siege.releaseGate.terminalIntegrity.terminal).toBe(true);
      expect(siege.releaseGate.terminalIntegrity.terminalOutcomeCount).toBe(1);
      if (stats.outcome !== 'victory') {
        expect(siege.releaseGate.terminalIntegrity.capturedCount).toBe(0);
        expect(siege.releaseGate.terminalIntegrity.defeatCount).toBe(1);
        continue;
      }
      const frameBudget = siege.releaseGate.frameBudget;
      if (frameBudget === null) throw new Error(`seed ${seed} missing Floor 5 frame budget`);
      expect(stats.totalFrames, `seed ${seed} stayed under the frame budget`).toBeLessThanOrEqual(
        frameBudget,
      );
      expect(siege.releaseGate.terminalIntegrity).toEqual({
        terminal: true,
        terminalOutcomeCount: 1,
        capturedCount: 1,
        defeatCount: 0,
      });
      expect(siege.releaseGate.commandPostHealthPct).toBeGreaterThanOrEqual(
        gate.minimumCommandPostHealthPct,
      );
      expect(siege.releaseGate.liveHostilesOnTerminal).toBeLessThanOrEqual(
        gate.maxLiveHostilesOnTerminal,
      );
      expect(siege.laneTelemetry.pathStalls).toBeLessThanOrEqual(gate.maxPathStalls);
      expect(siege.laneTelemetry.activeCap).toBe(4);
      for (const [team, peak] of Object.entries(siege.laneTelemetry.liveMinionPeak)) {
        expect(peak, `seed ${seed} ${team} live peak stayed within cap`).toBeLessThanOrEqual(
          siege.laneTelemetry.activeCap,
        );
      }
      expect(siege.laneTelemetry.waveAccounting).toHaveLength(siege.waveManifest.length);
      for (const [manifestIndex, manifestEntry] of siege.waveManifest.entries()) {
        const accounting = siege.laneTelemetry.waveAccounting[manifestIndex];
        expect(accounting).toMatchObject({
          manifestIndex,
          waveId: manifestEntry.id,
          team: manifestEntry.team,
          scheduled: manifestEntry.count,
        });
        if (!accounting) continue;
        expect(accounting.physicalReleased + accounting.debtCleared).toBe(manifestEntry.count);
        expect(accounting.physicalReleased).toBeLessThanOrEqual(manifestEntry.count);
        expect(accounting.maxReleaseDelayFrames).toBeLessThanOrEqual(gate.maxReleaseDelayFrames);
        if (accounting.firstReleaseFrame !== null) {
          expect(accounting.firstReleaseFrame).toBeGreaterThanOrEqual(manifestEntry.releaseFrame);
        }
        if (accounting.lastReleaseFrame !== null) {
          expect(accounting.lastReleaseFrame).toBeGreaterThanOrEqual(
            accounting.firstReleaseFrame ?? manifestEntry.releaseFrame,
          );
        }
      }
      expect(siege.releaseGate.structuralViolations).toEqual({
        unreachableObjectives: 0,
        phaseOrderViolations: 0,
        invalidTargetAllegianceEvents: 0,
        navigationMismatchCount: 0,
        unboundedSpawnDebt: 0,
        nonTerminalRuns: 0,
      });
      expect(
        siege.releaseGate.observedFrameCostMs ?? Number.POSITIVE_INFINITY,
        `seed ${seed} stayed under frame-cost budget`,
      ).toBeLessThanOrEqual(gate.maxFrameCostMs);
      expect(siege.releaseGate.stallBackstopFrames).toBe(gate.stallBackstopFrames);
    }
  });

  it('keeps the release ledger deterministic for the same seed', async () => {
    const options = {
      floorId: 'floor5' as const,
      seed: 1,
      maxFrames: 120,
      questStallFrames: 0,
    };
    const first = await runHeadless(new IdleFloor5Provider(), options);
    const second = await runHeadless(new IdleFloor5Provider(), options);
    expect(second.floor5Siege?.laneTelemetry).toEqual(first.floor5Siege?.laneTelemetry);
  });
});
