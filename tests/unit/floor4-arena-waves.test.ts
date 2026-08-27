import { query, hasComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Enemy, DeathTimer } from '../../src/core/index.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { arenaDirectorSystem, initializeFloor4Scenario } from '../../src/game/floor4Scenario.js';
import { getFloorManifest } from '../../src/shared/floor-registry.js';
import type { GameWorld } from '../../src/core/world.js';
import type { Floor4WaveWindowState } from '../../src/shared/floor-types.js';
import { createTestWorld } from '../helpers/world-factory.js';

const floor4 = getFloorManifest('floor4')!.floor4!;
const phase = floor4.phase;
const waves = floor4.waves;

function setupFloor4(seed = 42): GameWorld {
  const world = createTestWorld({ seed });
  const player = spawnPlayer(world, 0, 0);
  initializeFloor4Scenario(world, player);
  return world;
}

function advance(world: GameWorld, ms: number): void {
  world.elapsedMs += ms;
  arenaDirectorSystem(world);
}

function arena(world: GameWorld) {
  return world.floorExtendedState!.floor4Arena!;
}

function waveWindow(world: GameWorld): Floor4WaveWindowState {
  const window = arena(world).waves;
  if (!window) {
    throw new Error('expected an armed wave window');
  }
  return window;
}

/** Enemies actually standing in the arena (corpses excluded). */
function liveEnemies(world: GameWorld): number[] {
  return [...query(world.ecs, [Enemy])].filter((eid) => !hasComponent(world.ecs, eid, DeathTimer));
}

/** Open the act-1 wave window and release exactly wave 0. */
function openWaveWindow(world: GameWorld): void {
  advance(world, phase.countdownMs);
  advance(world, 1);
}

describe('floor4 wave release', () => {
  it('arms an act of manifests when the wave window opens and releases none early', () => {
    const world = setupFloor4(2024);

    advance(world, phase.countdownMs);

    expect(arena(world).phase).toEqual({ kind: 'WAVES', act: 1 });
    expect(waveWindow(world).manifests).toHaveLength(waves.cadence.wavesPerAct);
    expect(waveWindow(world).releaseCursor).toBe(0);
    expect(liveEnemies(world)).toHaveLength(0);
  });

  it('spawns a released wave at its authored gates, in manifest order', () => {
    const world = setupFloor4(2024);
    openWaveWindow(world);

    const window = waveWindow(world);
    const manifest = window.manifests[0]!;
    const spawned = [...window.ownedEnemies.keys()];

    expect(window.releaseCursor).toBe(1);
    expect(spawned).toHaveLength(manifest.entries.length);
    expect(spawned.map((eid) => world.enemyAppearanceKeys.get(eid))).toEqual(
      manifest.entries.map((entry) => entry.archetypeId),
    );

    // Wave enemies enter through the venue's fixed feed gates (FR3.4) — the
    // deterministic stagger keeps them within a tile of the authored gate.
    const gates = world.floorMap!.feedGates;
    const tileSizeFt = world.floorMap!.config.tileSizeFt;
    spawned.forEach((eid, index) => {
      const gate = gates[manifest.entries[index]!.gateIndex]!;
      const center = world.floorMap!.tileToWorld(gate.x, gate.y);
      const distance = Math.hypot(
        (world.stores.position.x[eid] ?? 0) - center.x,
        (world.stores.position.y[eid] ?? 0) - center.y,
      );
      expect(distance).toBeLessThanOrEqual(tileSizeFt * 1.01);
    });
    expect(arena(world).waveTelemetry.enemiesSpawned).toBe(manifest.entries.length);
    expect(arena(world).waveTelemetry.wavesReleased).toBe(1);
  });

  it('releases the rest of the act on the authored cadence', () => {
    const world = setupFloor4(2024);
    openWaveWindow(world);

    for (let released = 2; released <= waves.cadence.wavesPerAct; released += 1) {
      advance(world, waves.cadence.intervalMs);
      expect(waveWindow(world).releaseCursor).toBe(released);
      expect(arena(world).waveTelemetry.wavesReleased).toBe(released);
    }
  });

  it('never consumes world.rng (FR7.4)', () => {
    const world = setupFloor4(7);
    // Patch AFTER setup: map generation legitimately uses the world stream; the
    // wave machinery must not touch it once the arena is running, or a player's
    // pace would shift every later draw in the seed.
    let worldRngCalls = 0;
    const rng = world.rng;
    const realNext = rng.next.bind(rng);
    const realNextInt = rng.nextInt.bind(rng);
    rng.next = () => {
      worldRngCalls += 1;
      return realNext();
    };
    rng.nextInt = (min: number, max: number) => {
      worldRngCalls += 1;
      return realNextInt(min, max);
    };

    openWaveWindow(world);
    for (let wave = 1; wave < waves.cadence.wavesPerAct; wave += 1) {
      advance(world, waves.cadence.intervalMs);
    }
    // ...and through the cut at the wave-window boundary.
    advance(world, phase.waveWindowMs);

    expect(worldRngCalls).toBe(0);
    expect(arena(world).waveTelemetry.enemiesSpawned).toBeGreaterThan(0);
    expect(arena(world).waveTelemetry.enemiesCut).toBeGreaterThan(0);
  });

  it('produces the same wave state for the same seed', () => {
    const left = setupFloor4(777);
    const right = setupFloor4(777);

    for (const world of [left, right]) {
      openWaveWindow(world);
      advance(world, waves.cadence.intervalMs);
    }

    expect(waveWindow(left).manifests).toEqual(waveWindow(right).manifests);
    expect(arena(left).waveTelemetry).toEqual(arena(right).waveTelemetry);
    expect([...waveWindow(left).ownedEnemies.values()]).toEqual([
      ...waveWindow(right).ownedEnemies.values(),
    ]);
  });
});

describe('floor4 gate telegraphs', () => {
  it('lights the gates ahead of a release and disarms them when it fires', () => {
    const world = setupFloor4(2024);
    openWaveWindow(world);
    const window = waveWindow(world);
    const nextManifest = window.manifests[1]!;
    const expectedGates = [...new Set(nextManifest.entries.map((entry) => entry.gateIndex))].sort(
      (left, right) => left - right,
    );

    // Just before the lead window: dark.
    advance(world, waves.cadence.intervalMs - waves.gates.telegraphLeadMs - 2);
    expect(waveWindow(world).armedTelegraphs.some((armed) => armed.waveIndex === 1)).toBe(false);

    // Inside the lead window: lit, once, at the gates that wave actually uses.
    advance(world, 2);
    const armed = waveWindow(world).armedTelegraphs.filter((entry) => entry.waveIndex === 1);
    expect(armed.map((entry) => entry.gateIndex)).toEqual(expectedGates);
    expect(armed.every((entry) => entry.firesAtArenaMs === nextManifest.releaseAtActMs)).toBe(true);
    expect(world.vfxEvents.filter((event) => event.kind === 'spawnerPulse').length).toBe(
      arena(world).waveTelemetry.gateTelegraphsArmed,
    );

    // Idempotent while it stays armed.
    const armedCount = arena(world).waveTelemetry.gateTelegraphsArmed;
    advance(world, 1);
    expect(arena(world).waveTelemetry.gateTelegraphsArmed).toBe(armedCount);

    // On release the telegraph is spent.
    advance(world, waves.gates.telegraphLeadMs);
    expect(waveWindow(world).releaseCursor).toBe(2);
    expect(waveWindow(world).armedTelegraphs.some((entry) => entry.waveIndex === 1)).toBe(false);
  });
});

describe('floor4 concurrency cap and spawn debt', () => {
  /** Drive the rehearsal timeline to the start of the heaviest act's window. */
  function openFinalActWaveWindow(world: GameWorld): void {
    advance(world, phase.countdownMs);
    for (let act = 1; act < phase.actCount; act += 1) {
      advance(world, phase.waveWindowMs);
      advance(world, phase.headlineWindowMs);
      advance(world, phase.intermissionMs);
    }
    expect(arena(world).phase).toEqual({ kind: 'WAVES', act: phase.actCount });
    advance(world, 1);
  }

  it('holds the live cap, banks the overflow in manifest order, and drops the excess', () => {
    const world = setupFloor4(31);
    openFinalActWaveWindow(world);

    for (let wave = 1; wave < waves.cadence.wavesPerAct; wave += 1) {
      advance(world, waves.cadence.intervalMs);
      const window = waveWindow(world);

      // Nothing dies in this harness, so pressure only ever accumulates.
      expect(liveEnemies(world).length).toBeLessThanOrEqual(waves.concurrency.liveCap);
      expect(window.debt.length).toBeLessThanOrEqual(waves.concurrency.debtCap);
      // FIFO: banked entries stay in release order, so an old wave never jumps
      // the queue behind a newer one.
      const bankedWaveIndexes = window.debt.map((pending) => pending.waveIndex);
      expect(bankedWaveIndexes).toEqual([...bankedWaveIndexes].sort((a, b) => a - b));
    }

    const telemetry = arena(world).waveTelemetry;
    expect(liveEnemies(world).length).toBe(waves.concurrency.liveCap);
    expect(waveWindow(world).debt.length).toBe(waves.concurrency.debtCap);
    // Debt is bounded, and the overflow is discarded rather than deferred into a
    // lethal post-window burst (FR3.5).
    expect(telemetry.debtDiscarded).toBeGreaterThan(0);
    expect(telemetry.enemiesSpawned).toBe(waves.concurrency.liveCap);
  });

  it('clears banked debt and armed telegraphs at the phase boundary', () => {
    const world = setupFloor4(31);
    openFinalActWaveWindow(world);
    for (let wave = 1; wave < waves.cadence.wavesPerAct; wave += 1) {
      advance(world, waves.cadence.intervalMs);
    }
    expect(waveWindow(world).debt.length).toBeGreaterThan(0);

    advance(world, phase.waveWindowMs);

    expect(arena(world).phase.kind).toBe('HEADLINE');
    expect(arena(world).waves).toBeUndefined();
    expect(liveEnemies(world)).toHaveLength(0);
  });
});

describe('floor4 wave cut', () => {
  it('removes survivors at the wave-window boundary without paying them out (FR3.6)', () => {
    const world = setupFloor4(2024);
    openWaveWindow(world);
    for (let wave = 1; wave < waves.cadence.wavesPerAct; wave += 1) {
      advance(world, waves.cadence.intervalMs);
    }

    const survivors = liveEnemies(world);
    const ownedBefore = waveWindow(world).ownedEnemies.size;
    expect(survivors.length).toBeGreaterThan(0);
    const vfxBefore = world.vfxEvents.filter((event) => event.kind === 'deathPop').length;

    advance(world, phase.waveWindowMs);

    const telemetry = arena(world).waveTelemetry;
    // Everything the wave window owned is gone, and the state that owned it too.
    expect(telemetry.enemiesCut).toBe(ownedBefore);
    expect(liveEnemies(world)).toHaveLength(0);
    expect(query(world.ecs, [Enemy])).toHaveLength(0);
    expect(arena(world).waves).toBeUndefined();

    // The cut is NOT a death: no XP, no gold, no drops, no death event, no kill.
    expect(world.lootLedger.xpSpawned).toBe(0);
    expect(world.lootLedger.goldSpawned).toBe(0);
    expect(world.playerLevel.xp).toBe(0);
    expect(world.playerGold).toBe(0);
    expect(world.combatEvents.filter((event) => event.type === 'death')).toHaveLength(0);

    // It still reads as an intentional exit rather than entities blinking out.
    const vfxAfter = world.vfxEvents.filter((event) => event.kind === 'deathPop').length;
    expect(vfxAfter - vfxBefore).toBe(survivors.length);
  });
});
