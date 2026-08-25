import { addComponent, query, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { ArenaWaveEnemy, DeathTimer, Enemy, Health } from '../../src/core/components.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { arenaDirectorSystem, initializeFloor4Scenario } from '../../src/game/floor4Scenario.js';
import { GAME } from '../../src/shared/constants.js';
import { getFloorManifest } from '../../src/shared/floor-registry.js';
import { createTestWorld } from '../helpers/world-factory.js';

const floor4 = getFloorManifest('floor4')!.floor4!;
const phase = floor4.phase;
const waves = floor4.waves!;

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

function arenaState(world: ReturnType<typeof setupFloor4>) {
  return world.floorExtendedState!.floor4Arena!;
}

function waveEnemies(world: ReturnType<typeof setupFloor4>): number[] {
  return [...query(world.ecs, [ArenaWaveEnemy, Enemy])];
}

describe('Floor 4 wave release', () => {
  it('releases act 1 wave 0 the moment the act starts and telegraphs it with the release', () => {
    const world = setupFloor4();
    advance(world, phase.countdownMs);
    expect(arenaState(world).phase).toEqual({ kind: 'WAVES', act: 1 });

    advance(world, 1);
    const state = arenaState(world);
    expect(state.waveStats.wavesReleased).toBe(1);
    expect(state.waveStats.gateTelegraphsFired).toBeGreaterThan(0);
    expect(waveEnemies(world).length).toBeGreaterThan(0);
  });

  it('telegraphs a mid-act wave before it releases', () => {
    const world = setupFloor4();
    advance(world, phase.countdownMs + 1);
    const released = arenaState(world).waveStats.wavesReleased;
    const telegraphs = arenaState(world).waveStats.gateTelegraphsFired;

    advance(world, waves.waveIntervalMs - waves.gateTelegraphMs);
    expect(arenaState(world).waveStats.gateTelegraphsFired).toBeGreaterThan(telegraphs);
    expect(arenaState(world).waveStats.wavesReleased).toBe(released);
    expect(arenaState(world).activeGateTelegraphs.length).toBeGreaterThan(0);

    advance(world, waves.gateTelegraphMs);
    expect(arenaState(world).waveStats.wavesReleased).toBe(released + 1);
    expect(arenaState(world).activeGateTelegraphs).toHaveLength(0);
  });

  it('releases every wave of the act even when a whole window arrives in one tick', () => {
    // Regression: a per-tick switch would swallow the excess delta and skip the
    // waves in between. The director consumes boundaries chronologically.
    const oneStep = setupFloor4(7);
    advance(oneStep, phase.countdownMs);
    advance(oneStep, phase.waveWindowMs - 1);

    const manySteps = setupFloor4(7);
    advance(manySteps, phase.countdownMs);
    const frames = Math.floor((phase.waveWindowMs - 1) / GAME.DELTA_MS);
    for (let i = 0; i < frames; i += 1) {
      advance(manySteps, GAME.DELTA_MS);
    }
    advance(manySteps, phase.waveWindowMs - 1 - frames * GAME.DELTA_MS);

    expect(oneStep.floorExtendedState!.floor4Arena!.waveStats.wavesReleased).toBe(
      waves.wavesPerAct,
    );
    expect(oneStep.floorExtendedState!.floor4Arena!.waveStats).toEqual(
      manySteps.floorExtendedState!.floor4Arena!.waveStats,
    );
  });

  it('replays identical wave manifests for the same seed', () => {
    const left = setupFloor4(777);
    const right = setupFloor4(777);
    for (const world of [left, right]) {
      advance(world, phase.countdownMs);
      advance(world, phase.waveWindowMs - 1);
    }
    expect(arenaState(left).waveManifests).toEqual(arenaState(right).waveManifests);
    expect(arenaState(left).waveManifestFingerprints).toEqual(
      arenaState(right).waveManifestFingerprints,
    );
  });
});

describe('Floor 4 concurrency cap and spawn debt', () => {
  it('never exceeds the live-enemy cap and defers the overflow to debt', () => {
    // Nothing kills these enemies in a director-only world, so the whole act's
    // schedule presses against the cap.
    const world = setupFloor4(11);
    advance(world, phase.countdownMs);
    for (let elapsed = 0; elapsed < phase.waveWindowMs - 1; elapsed += 1_000) {
      advance(world, 1_000);
      expect(query(world.ecs, [Enemy, Health]).length).toBeLessThanOrEqual(waves.concurrencyCap);
    }

    const state = arenaState(world);
    expect(state.waveStats.spawnsDeferred).toBeGreaterThan(0);
    expect(state.spawnDebt.length).toBeLessThanOrEqual(waves.debtCap);
  });

  it('discards debt beyond the debt cap rather than banking it forever', () => {
    const world = setupFloor4(11);
    advance(world, phase.countdownMs);
    advance(world, phase.waveWindowMs - 1);
    const state = arenaState(world);
    expect(state.spawnDebt.length).toBeLessThanOrEqual(waves.debtCap);
    expect(state.waveStats.spawnsDiscarded).toBeGreaterThan(0);
  });

  it('clears unreleased debt on a phase transition', () => {
    const world = setupFloor4(11);
    advance(world, phase.countdownMs);
    advance(world, phase.waveWindowMs - 1);
    expect(arenaState(world).spawnDebt.length).toBeGreaterThan(0);

    advance(world, 1);
    const state = arenaState(world);
    expect(state.phase.kind).toBe('HEADLINE');
    expect(state.spawnDebt).toHaveLength(0);
    expect(state.waveStats.debtCleared).toBeGreaterThan(0);
  });
});

describe('Floor 4 cut', () => {
  it('removes surviving wave enemies with no kill, death event, or reward', () => {
    const world = setupFloor4(3);
    advance(world, phase.countdownMs);
    advance(world, phase.waveWindowMs - 1);
    const alive = waveEnemies(world).length;
    expect(alive).toBeGreaterThan(0);
    world.combatEvents.length = 0;
    world.vfxEvents.length = 0;

    advance(world, 1);

    const state = arenaState(world);
    expect(waveEnemies(world)).toHaveLength(0);
    expect(state.waveStats.enemiesCut).toBe(alive);
    // A combat `death` event would be counted as a kill by the headless runner;
    // the cut is explicitly neither a kill nor a death (spec FR3.6).
    expect(world.combatEvents.filter((event) => event.type === 'death')).toHaveLength(0);
    expect(world.vfxEvents.some((event) => event.kind === 'deathPop')).toBe(true);
  });

  it('leaves an enemy that is already dying this frame to the normal death path', () => {
    const world = setupFloor4(3);
    advance(world, phase.countdownMs);
    advance(world, phase.waveWindowMs - 1);
    const [dying] = waveEnemies(world);
    expect(dying).toBeDefined();
    // The director runs before damage/drop resolution, so a lethal hit landed
    // this frame must still pay out through dropSystem, not be erased.
    world.stores.health.current[dying!] = 0;
    addComponent(world.ecs, dying!, set(DeathTimer, { remaining: 0.5 }));
    const before = arenaState(world).waveStats.enemiesCut;

    advance(world, 1);

    expect(query(world.ecs, [ArenaWaveEnemy]).includes(dying!)).toBe(true);
    expect(arenaState(world).waveStats.enemiesCut).toBeGreaterThan(before);
  });
});
