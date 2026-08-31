import { describe, expect, it } from 'vitest';
import { query } from 'bitecs';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { AIState, type AIDecision, type AIInputProvider } from '../../src/game/ai/types.js';
import type { GameWorld } from '../../src/core/world.js';
import {
  Health,
  SiegeHero,
  SiegeMinion,
  SiegeRam,
  SiegeRouteMarker,
} from '../../src/core/components.js';
import { findTilePath } from '../../src/core/map/pathfinding.js';
import type { InputState } from '../../src/shared/input.js';
import type { Floor5RatingsRamState } from '../../src/shared/floor-types.js';

/**
 * Idle provider: the escort must complete under the REAL Floor 5 pipeline
 * without any player help, so the hard gate can never be satisfied by a lucky
 * AI run.
 */
class IdleFloor5Provider implements AIInputProvider {
  private readonly decision: AIDecision = {
    state: AIState.EXPLORE,
    targetEid: null,
    targetX: null,
    targetY: null,
    reason: 'floor5 ratings-ram observation',
    npcInteraction: null,
    debug: null,
  };

  poll(_input: InputState, _world: GameWorld): void {}

  getDecision(): AIDecision {
    return this.decision;
  }

  reset(): void {}
}

/** The exact sequence the feature's hard gate requires. */
const REQUIRED_SEQUENCE: readonly Floor5RatingsRamState[] = [
  'BUILDING',
  'READY',
  'ADVANCING',
  'ATTACKING',
  'DESTROYED',
  'BUILDING',
  'READY',
  'ADVANCING',
  'ATTACKING',
  'BREACHED',
];

describe('Floor 5 Ratings Ram real headless pipeline', () => {
  it('drives the full build → escort → destruction → rebuild → breach cycle with no soft-lock', async () => {
    let liveRams = 0;
    let liveMarkers = 0;
    let liveMinions = 0;
    let liveHeroes = 0;
    let courtyardReachableAfterBreach = false;
    let barrierVersionAtEnd = 0;

    const stats = await runHeadless(new IdleFloor5Provider(), {
      floorId: 'floor5',
      seed: 505,
      maxFrames: 6000,
      questStallFrames: 0,
      onFinish: (world) => {
        liveRams = Array.from(query(world.ecs, [SiegeRam])).length;
        liveMarkers = Array.from(query(world.ecs, [SiegeRouteMarker])).length;
        liveMinions = Array.from(query(world.ecs, [SiegeMinion])).length;
        liveHeroes = Array.from(query(world.ecs, [SiegeHero])).length;
        barrierVersionAtEnd = world.barriers.version;
        // Real passability parity: the pathfinder itself must now route the
        // lane through the breach into the courtyard.
        const floorMap = world.floorMap!;
        const state = world.floorExtendedState!.floor5Siege!;
        const approach = state.ram.route[state.ram.route.length - 1]!;
        const courtyardTile = { x: approach.tileX + 8, y: approach.tileY };
        courtyardReachableAfterBreach =
          findTilePath(floorMap, { x: approach.tileX, y: approach.tileY }, courtyardTile).length >
          1;
      },
    });

    const siege = stats.floor5Siege;
    expect(siege).toBeDefined();

    // --- HARD GATE: the exact observed engine-state sequence ---------------
    expect(siege!.ram.stateSequence).toEqual(REQUIRED_SEQUENCE);
    expect(siege!.engineState).toBe('BREACHED');
    expect(siege!.breachState).toBe('BREACHED');

    // --- One-shot breach latch --------------------------------------------
    expect(siege!.breach.latched).toBe(true);
    expect(siege!.breach.committedFrame).not.toBeNull();
    // Commit was attempted at least once and the latch admitted exactly one.
    expect(siege!.breach.commitAttempts).toBeGreaterThanOrEqual(1);
    expect(siege!.ram.stateSequence.filter((entry) => entry === 'BREACHED')).toHaveLength(1);
    expect(siege!.trace.filter((entry) => entry.phase.kind === 'BREACH')).toHaveLength(1);

    // --- Semantic route was walked in authored order -----------------------
    expect(siege!.ram.routeLandmarks).toEqual([
      'build-site',
      'siege-yard-junction',
      'checkpoint-junction',
      'breach-approach',
    ]);
    expect(siege!.ram.builds).toBe(2);
    expect(siege!.ram.destructions).toBe(1);
    expect(siege!.ram.strikes).toBeGreaterThan(0);
    expect(siege!.ram.advanceFrames).toBeGreaterThan(0);

    // --- FR5.5: only ram strikes ever damaged the outer wall ---------------
    expect(siege!.ram.wallDamageDealt).toBeGreaterThan(0);
    expect(siege!.laneTelemetry.illegalDamageEvents).toBe(0);

    // --- Cleanup + zero wave/spawn debt ------------------------------------
    expect(siege!.breach.frontFrozen).toBe(true);
    expect(siege!.breach.cleanup.wallRetired).toBe(true);
    expect(siege!.breach.barrierSealed).toBe(false);
    expect(siege!.spawnDebt).toEqual({ allied: 0, enemy: 0 });
    expect(siege!.liveMinions).toEqual({ allied: 0, enemy: 0 });
    expect(siege!.structures['outer-wall'].eid).toBe(0);
    expect(liveRams).toBe(0);
    expect(liveMarkers).toBe(0);
    expect(liveMinions).toBe(0);
    expect(liveHeroes).toBe(0);

    // --- Real passability parity + nav invalidation ------------------------
    expect(barrierVersionAtEnd).toBeGreaterThan(0);
    expect(courtyardReachableAfterBreach).toBe(true);

    // --- No stall ----------------------------------------------------------
    expect(siege!.laneTelemetry.pathStalls).toBe(0);
    expect(stats.stallReason).toBeUndefined();
    expect(siege!.phase.kind).not.toBe('DEFEAT');
  }, 120_000);
});

describe('Floor 5 outer-wall seal', () => {
  it('seals the carved breach ingress at init so the courtyard is unreachable before the ram lands', async () => {
    let sealedReachable = true;
    let barrierSealedAtStart = false;
    await runHeadless(new IdleFloor5Provider(), {
      floorId: 'floor5',
      seed: 505,
      maxFrames: 2,
      questStallFrames: 0,
      onFinish: (world) => {
        const floorMap = world.floorMap!;
        const state = world.floorExtendedState!.floor5Siege!;
        barrierSealedAtStart = state.breach.barrierId !== null;
        const approach = state.ram.route[state.ram.route.length - 1]!;
        sealedReachable =
          findTilePath(
            floorMap,
            { x: approach.tileX, y: approach.tileY },
            { x: approach.tileX + 8, y: approach.tileY },
          ).length > 1;
      },
    });
    expect(barrierSealedAtStart).toBe(true);
    expect(sealedReachable).toBe(false);
  }, 60_000);
});
