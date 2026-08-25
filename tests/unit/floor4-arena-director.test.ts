import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import {
  arenaDirectorSystem,
  confirmFloor4StairDescend,
  initializeFloor4Scenario,
} from '../../src/game/floor4Scenario.js';
import { getFloorManifest } from '../../src/shared/floor-registry.js';
import { createTestWorld } from '../helpers/world-factory.js';

function setupFloor4(seed = 42) {
  const world = createTestWorld({ seed });
  const player = spawnPlayer(world, 0, 0);
  initializeFloor4Scenario(world, player);
  return world;
}

function advance(world: ReturnType<typeof setupFloor4>, ms: number): void {
  world.elapsedMs += ms;
  arenaDirectorSystem(world);
}

describe('arenaDirectorSystem', () => {
  it('initializes Floor 4 in countdown with a transition timeline', () => {
    const world = setupFloor4();
    const state = world.floorExtendedState?.floor4Arena;

    expect(state?.phase).toEqual({ kind: 'COUNTDOWN' });
    expect(state?.arenaElapsedMs).toBe(0);
    expect(state?.lastWorldElapsedMs).toBe(0);
    expect(state?.timeline).toEqual([
      {
        frame: 0,
        worldElapsedMs: 0,
        arenaElapsedMs: 0,
        phase: { kind: 'COUNTDOWN' },
        reason: 'floor4-initialized',
      },
    ]);
  });

  it('advances the empty-arena rehearsal through five deterministic acts to victory', () => {
    const world = setupFloor4();
    const phase = getFloorManifest('floor4')!.floor4!.phase;

    advance(world, phase.countdownMs);
    for (let act = 1; act <= phase.actCount; act += 1) {
      advance(world, phase.waveWindowMs);
      advance(world, phase.headlineWindowMs);
      advance(world, phase.intermissionMs);
    }

    const state = world.floorExtendedState!.floor4Arena!;
    expect(state.phase).toEqual({ kind: 'VICTORY' });
    expect(state.arenaElapsedMs).toBe(phase.actDurationMs * phase.actCount);
    expect(state.timeline.map((entry) => entry.phase.kind)).toEqual([
      'COUNTDOWN',
      'WAVES',
      'HEADLINE',
      'INTERMISSION',
      'WAVES',
      'HEADLINE',
      'INTERMISSION',
      'WAVES',
      'HEADLINE',
      'INTERMISSION',
      'WAVES',
      'HEADLINE',
      'INTERMISSION',
      'WAVES',
      'HEADLINE',
      'INTERMISSION',
      'VICTORY',
    ]);
  });

  it('holds the arena clock during intermission without leaking held elapsed time', () => {
    const world = setupFloor4();
    const phase = getFloorManifest('floor4')!.floor4!.phase;

    advance(world, phase.countdownMs);
    advance(world, phase.waveWindowMs);
    advance(world, phase.headlineWindowMs);
    const atIntermission = world.floorExtendedState!.floor4Arena!.arenaElapsedMs;

    advance(world, phase.intermissionMs - 1);
    expect(world.floorExtendedState!.floor4Arena!.arenaElapsedMs).toBe(atIntermission);

    advance(world, 1);
    expect(world.floorExtendedState!.floor4Arena!.phase).toEqual({ kind: 'WAVES', act: 2 });
    expect(world.floorExtendedState!.floor4Arena!.arenaElapsedMs).toBe(atIntermission);

    advance(world, 1);
    expect(world.floorExtendedState!.floor4Arena!.arenaElapsedMs).toBe(atIntermission + 1);
  });

  it('allows stair descent only during the final intermission window', () => {
    const world = setupFloor4();
    const phase = getFloorManifest('floor4')!.floor4!.phase;

    expect(confirmFloor4StairDescend(world)).toBe(false);
    advance(world, phase.countdownMs);
    for (let act = 1; act < phase.actCount; act += 1) {
      advance(world, phase.waveWindowMs);
      advance(world, phase.headlineWindowMs);
      advance(world, phase.intermissionMs);
      expect(confirmFloor4StairDescend(world)).toBe(false);
    }
    advance(world, phase.waveWindowMs);
    advance(world, phase.headlineWindowMs);

    expect(world.floorExtendedState!.floor4Arena!.phase).toEqual({ kind: 'INTERMISSION', act: 5 });
    expect(confirmFloor4StairDescend(world)).toBe(true);
  });

  it('replays the same phase timeline for the same seed and step sequence', () => {
    const left = setupFloor4(777);
    const right = setupFloor4(777);
    const phase = getFloorManifest('floor4')!.floor4!.phase;
    const steps = [
      phase.countdownMs,
      phase.waveWindowMs,
      phase.headlineWindowMs,
      phase.intermissionMs,
      phase.waveWindowMs,
      phase.headlineWindowMs,
    ];

    for (const ms of steps) {
      advance(left, ms);
      advance(right, ms);
    }

    expect(left.floorExtendedState!.floor4Arena!.timeline).toEqual(
      right.floorExtendedState!.floor4Arena!.timeline,
    );
  });
});
