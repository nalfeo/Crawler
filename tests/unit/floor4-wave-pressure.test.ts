import { entityExists, query, removeEntity } from 'bitecs';
import { describe, expect, it, vi } from 'vitest';
import { Enemy, Player, Position } from '../../src/core/components.js';
import { clearEntityStores, spawnPlayer } from '../../src/core/helpers.js';
import { spawnBehaviorEnemy } from '../../src/core/spawners/combatants.js';
import type { GameWorld } from '../../src/core/world.js';
import {
  arenaDirectorSystem,
  getFloor4LiveWaveEnemyCount,
  initializeFloor4Scenario,
} from '../../src/game/floor4Scenario.js';
import { getFloorManifest } from '../../src/shared/floor-registry.js';
import {
  buildFloor4ActWaveManifests,
  buildFloor4PressureReserve,
} from '../../src/shared/floor4-waves.js';
import { RoomRole } from '../../src/shared/map-types.js';
import { createTestWorld } from '../helpers/world-factory.js';

const config = getFloorManifest('floor4')!.floor4!;
const tuning = config.waves.pressure!;
const leadMs = config.waves.gates.telegraphLeadMs;

function state(world: GameWorld) {
  return world.floorExtendedState!.floor4Arena!;
}

function window(world: GameWorld) {
  return state(world).waves!;
}

function advance(world: GameWorld, ms: number) {
  world.elapsedMs += ms;
  arenaDirectorSystem(world);
}

function moveToRoom(world: GameWorld, role: RoomRole) {
  const room = world.floorMap!.roomGraph.getRoomsByRole(role)[0]!;
  const player = query(world.ecs, [Player, Position])[0]!;
  const point = world.floorMap!.tileToWorld(
    Math.floor(room.bounds.x + room.bounds.width / 2),
    Math.floor(room.bounds.y + room.bounds.height / 2),
  );
  world.stores.position.x[player] = point.x;
  world.stores.position.y[player] = point.y;
  world.playerInSafeRoom = role === RoomRole.SAFE;
}

function setup(seed = 42) {
  const world = createTestWorld({ seed });
  initializeFloor4Scenario(world, spawnPlayer(world, 0, 0));
  moveToRoom(world, RoomRole.SPAWN);
  advance(world, config.phase.countdownMs);
  return world;
}

/** Isolate adaptive release; authored cadence/debt retain their dedicated suite. */
function pressureOnly(world: GameWorld) {
  window(world).releaseCursor = window(world).manifests.length;
  window(world).armedTelegraphs.length = 0;
}

function ownedHostile(world: GameWorld) {
  const eid = spawnBehaviorEnemy(world, 0, 0, 20, 0, 0.16, 60, 0);
  window(world).ownedEnemies.set(eid, world.entityRenderGeneration[eid]!);
  return eid;
}

function markOwnedDead(world: GameWorld) {
  for (const eid of window(world).ownedEnemies.keys()) world.stores.health.current[eid] = 0;
}

describe('Floor 4 bounded wave pressure', () => {
  it('builds an immutable seed-stable reserve without changing scheduled rosters', () => {
    const manifests = buildFloor4ActWaveManifests(config.waves, 42, 5, 4);
    const reserve = buildFloor4PressureReserve(config.waves, 42, 5);
    expect(reserve).toEqual(buildFloor4PressureReserve(config.waves, 42, 5));
    expect(reserve).not.toEqual(buildFloor4PressureReserve(config.waves, 43, 5));
    expect(reserve).toHaveLength(tuning.reservePerAct);
    expect(Object.isFrozen(reserve)).toBe(true);
    expect(reserve.every(Object.isFrozen)).toBe(true);
    expect(buildFloor4ActWaveManifests(config.waves, 42, 5, 4)).toEqual(manifests);
  });

  it('arms and releases pressure without drawing from the combat RNG', () => {
    const world = createTestWorld({ seed: 42 });
    initializeFloor4Scenario(world, spawnPlayer(world, 0, 0));
    moveToRoom(world, RoomRole.SPAWN);
    const next = vi.spyOn(world.rng, 'next');
    const nextInt = vi.spyOn(world.rng, 'nextInt');
    advance(world, config.phase.countdownMs);
    pressureOnly(world);
    advance(world, 1);
    expect(window(world).pressure!.pending).toBeDefined();
    advance(world, leadMs);
    expect(getFloor4LiveWaveEnemyCount(world)).toBeGreaterThan(0);
    expect(next).not.toHaveBeenCalled();
    expect(nextInt).not.toHaveBeenCalled();
  });

  it('warns at the two nearest gates and preserves their alternating spread after player movement', () => {
    const world = setup();
    pressureOnly(world);
    const gates = world.floorMap!.feedGates;
    const north = gates.find((gate) => gate.direction === 'north')!;
    const south = gates.find((gate) => gate.direction === 'south')!;
    const northPoint = world.floorMap!.tileToWorld(north.x, north.y);
    const southPoint = world.floorMap!.tileToWorld(south.x, south.y);
    const player = query(world.ecs, [Player, Position])[0]!;
    // The arena is wider than it is tall: its north/south midpoint gives an
    // exact distance tie for the closest gates, resolved by their stable index.
    world.stores.position.x[player] = (northPoint.x + southPoint.x) / 2;
    world.stores.position.y[player] = (northPoint.y + southPoint.y) / 2;
    advance(world, 1);
    const pending = window(world).pressure!.pending!;
    const expectedGates = [north.index, south.index].sort((left, right) => left - right);
    expect(pending.entries.length).toBeGreaterThanOrEqual(2);
    expect(pending.entries.map((entry) => entry.gateIndex)).toEqual(
      pending.entries.map((_, slot) => expectedGates[slot % expectedGates.length]),
    );
    expect(leadMs).toBeGreaterThanOrEqual(1000);
    expect(
      window(world).armedTelegraphs.filter((entry) => entry.waveIndex === pending.waveIndex),
    ).toEqual(
      expectedGates.map((gateIndex) => ({
        gateIndex,
        waveIndex: pending.waveIndex,
        firesAtArenaMs: pending.releaseAtActMs,
      })),
    );
    advance(world, leadMs - 1);
    expect(getFloor4LiveWaveEnemyCount(world)).toBe(0);
    const otherGate = gates.find((gate) => gate.direction === 'east')!;
    const otherPoint = world.floorMap!.tileToWorld(otherGate.x, otherGate.y);
    world.stores.position.x[player] = otherPoint.x;
    world.stores.position.y[player] = otherPoint.y;
    advance(world, 1);
    expect(getFloor4LiveWaveEnemyCount(world)).toBe(pending.entries.length);
    for (const [slot, eid] of [...window(world).ownedEnemies.keys()].entries()) {
      const committedGate = gates[pending.entries[slot]!.gateIndex]!;
      const gatePoint = world.floorMap!.tileToWorld(committedGate.x, committedGate.y);
      expect(
        Math.hypot(
          world.stores.position.x[eid]! - gatePoint.x,
          world.stores.position.y[eid]! - gatePoint.y,
        ),
      ).toBeLessThanOrEqual(world.floorMap!.config.tileSizeFt);
    }
    expect(window(world).pressure!.pending).toBeUndefined();
    expect(window(world).armedTelegraphs.some((t) => t.waveIndex === pending.waveIndex)).toBe(
      false,
    );
  });

  it('cancels pending pressure and its warnings when the run ends', () => {
    const world = setup();
    pressureOnly(world);
    advance(world, 1);
    const pending = window(world).pressure!.pending!;
    expect(pending).toBeDefined();
    world.state = 'game_over';
    advance(world, leadMs);
    expect(window(world).pressure!.pending).toBeUndefined();
    expect(
      window(world).armedTelegraphs.some((entry) => entry.waveIndex === pending.waveIndex),
    ).toBe(false);
    advance(world, tuning.intervalMs + leadMs);
    expect(getFloor4LiveWaveEnemyCount(world)).toBe(0);
    expect(state(world).waveTelemetry.enemiesSpawned).toBe(0);
    expect(window(world).pressure!.pending).toBeUndefined();
  });

  it.each(['safe-room', 'outside-arena', 'dead-player'] as const)(
    'cancels pending pressure and prevents new batches for %s',
    (reason) => {
      const world = setup();
      pressureOnly(world);
      advance(world, 1);
      const pending = window(world).pressure!.pending!;
      const player = query(world.ecs, [Player, Position])[0]!;
      if (reason === 'safe-room') moveToRoom(world, RoomRole.SAFE);
      if (reason === 'outside-arena') {
        world.stores.position.x[player] = -10;
        world.stores.position.y[player] = -10;
      }
      if (reason === 'dead-player') world.stores.health.current[player] = 0;
      advance(world, leadMs);
      advance(world, tuning.intervalMs + leadMs);
      expect(getFloor4LiveWaveEnemyCount(world)).toBe(0);
      expect(window(world).pressure!.pending).toBeUndefined();
      expect(window(world).armedTelegraphs.some((t) => t.waveIndex === pending.waveIndex)).toBe(
        false,
      );
      expect(window(world).debt).toHaveLength(0);
    },
  );

  it('rechecks capacity at release and never turns adaptive entries into debt', () => {
    const world = setup();
    pressureOnly(world);
    advance(world, 1);
    expect(window(world).pressure!.pending).toBeDefined();
    // Unowned hostiles still count against the hard entity budget.
    for (let index = 0; index < 24; index++) spawnBehaviorEnemy(world, 0, 0, 20, 0, 0.16, 60, 0);
    advance(world, leadMs);
    expect(query(world.ecs, [Enemy])).toHaveLength(24);
    expect(getFloor4LiveWaveEnemyCount(world)).toBe(0);
    expect(window(world).debt).toHaveLength(0);
    expect(window(world).pressure!.pending).toBeUndefined();
  });

  it('backs off after sustained nearby pressure and resumes with a warning after recovery', () => {
    const world = setup();
    pressureOnly(world);
    const player = query(world.ecs, [Player, Position])[0]!;
    const px = world.stores.position.x[player]!;
    const py = world.stores.position.y[player]!;
    const enemies = Array.from({ length: tuning.nearbyTarget }, () => ownedHostile(world));
    for (const eid of enemies) {
      world.stores.position.x[eid] = px;
      world.stores.position.y[eid] = py;
    }
    advance(world, tuning.responseMs);
    expect(window(world).pressure!.pending).toBeUndefined();

    // Instantaneous density falls below the refill target and live capacity
    // remains available, but the recent crowd must still suppress admission.
    for (const eid of enemies.slice(tuning.averageTarget)) {
      world.stores.position.x[eid] = px + tuning.radiusFt + 1;
    }
    expect(enemies.length).toBeLessThan(tuning.incomingCap);
    expect(tuning.averageTarget).toBeLessThan(tuning.nearbyTarget);
    advance(world, Math.min(tuning.intervalMs, tuning.responseMs / 10));
    expect(window(world).pressure!.pending).toBeUndefined();
    expect(state(world).waveTelemetry.enemiesSpawned).toBe(0);

    // A quiet neighborhood clears the backoff; replenishment still needs its
    // full public warning, even though the admission interval already elapsed.
    for (const eid of enemies) world.stores.position.x[eid] = px + tuning.radiusFt + 1;
    advance(world, tuning.responseMs);
    const pending = window(world).pressure!.pending;
    expect(pending).toBeDefined();
    expect(pending!.releaseAtActMs).toBe(state(world).arenaElapsedMs + leadMs);
    expect(
      window(world).armedTelegraphs.some((entry) => entry.waveIndex === pending!.waveIndex),
    ).toBe(true);
    expect(state(world).waveTelemetry.enemiesSpawned).toBe(0);
    advance(world, leadMs - 1);
    expect(state(world).waveTelemetry.enemiesSpawned).toBe(0);
    advance(world, 1);
    expect(state(world).waveTelemetry.enemiesSpawned).toBeGreaterThan(0);
    expect(getFloor4LiveWaveEnemyCount(world)).toBeLessThanOrEqual(
      config.waves.concurrency.liveCap,
    );
  });

  it('drains authored debt first when only one hard-cap slot opens', () => {
    const world = setup();
    pressureOnly(world);
    advance(world, 1);
    const owned = Array.from({ length: 24 }, () => ownedHostile(world));
    const entry = window(world).manifests[0]!.entries[0]!;
    window(world).debt = Array.from({ length: 18 }, (_, slot) => ({ waveIndex: 0, slot, entry }));
    world.stores.health.current[owned[0]!] = 0;
    advance(world, leadMs);
    expect(getFloor4LiveWaveEnemyCount(world)).toBe(24);
    expect(window(world).debt).toHaveLength(17);
    expect(state(world).waveTelemetry.enemiesSpawned).toBe(1);
    expect(window(world).pressure!.pending).toBeUndefined();
  });

  it.each(['arm', 'release'] as const)(
    'does not bypass waiting authored debt during adaptive %s',
    (stage) => {
      const world = setup();
      pressureOnly(world);
      if (stage === 'release') {
        advance(world, 1);
        expect(window(world).pressure!.pending).toBeDefined();
      }
      const pressure = window(world).pressure!;
      const pendingIndex = pressure.pending?.waveIndex;
      const cursor = pressure.cursor;
      const entry = window(world).manifests[0]!.entries[0]!;
      const debt = { waveIndex: 0, slot: 0, entry };
      window(world).debt.push(debt);
      // Persisted recent pressure holds authored debt, while an empty nearby
      // neighborhood and unused live capacity would otherwise admit reserves.
      pressure.averageNearby = tuning.averageTarget + 1;
      expect(getFloor4LiveWaveEnemyCount(world)).toBe(0);
      advance(world, stage === 'release' ? leadMs : 1);
      expect(window(world).debt).toEqual([debt]);
      expect(state(world).waveTelemetry.enemiesSpawned).toBe(0);
      expect(pressure.cursor).toBe(cursor);
      expect(pressure.pending).toBeUndefined();
      if (pendingIndex !== undefined) {
        expect(window(world).armedTelegraphs.some((item) => item.waveIndex === pendingIndex)).toBe(
          false,
        );
      }
    },
  );

  it('banks scheduled waves under sustained pressure and resumes bounded debt in FIFO order', () => {
    const world = setup();
    pressureOnly(world);
    const player = query(world.ecs, [Player, Position])[0]!;
    for (let index = 0; index < tuning.nearbyTarget; index++) {
      const eid = ownedHostile(world);
      world.stores.position.x[eid] = world.stores.position.x[player]!;
      world.stores.position.y[eid] = world.stores.position.y[player]!;
    }
    advance(world, tuning.responseMs);
    const manifests = window(world).manifests;
    // Re-enable the authored schedule after establishing real sustained pressure.
    window(world).releaseCursor = 0;
    for (const manifest of manifests) {
      advance(world, Math.max(1, manifest.releaseAtActMs - state(world).arenaElapsedMs));
      expect(state(world).waveTelemetry.enemiesSpawned).toBe(0);
      expect(window(world).debt.length).toBeLessThanOrEqual(18);
    }
    const released = manifests.flatMap((manifest) =>
      manifest.entries.map((entry, slot) => ({
        waveIndex: manifest.waveIndex,
        slot,
        entry,
      })),
    );
    const expectedDebt = released.slice(0, config.waves.concurrency.debtCap);
    expect(window(world).debt).toEqual(expectedDebt);
    expect(window(world).debt).toHaveLength(18);
    expect(state(world).waveTelemetry.debtDiscarded).toBe(released.length - expectedDebt.length);

    markOwnedDead(world);
    // A pressure observation refresh precedes the following tick's debt drain.
    advance(world, tuning.responseMs);
    expect(window(world).pressure!.averageNearby).toBeLessThanOrEqual(tuning.averageTarget);
    // Leave two physical slots to expose ordering, rather than drain the entire
    // queue at once and merely assert an identical final population count.
    for (let index = 0; index < config.waves.concurrency.liveCap - 2; index++) ownedHostile(world);
    const before = new Set(window(world).ownedEnemies.keys());
    advance(world, 1);
    expect(window(world).debt).toEqual(expectedDebt.slice(2));
    const admitted = [...window(world).ownedEnemies.keys()].filter((eid) => !before.has(eid));
    expect(admitted).toHaveLength(2);
    for (const [index, eid] of admitted.entries()) {
      const entry = expectedDebt[index]!.entry;
      const gate = world.floorMap!.feedGates[entry.gateIndex]!;
      const point = world.floorMap!.tileToWorld(gate.x, gate.y);
      expect(world.enemyAppearanceKeys.get(eid)).toBe(entry.archetypeId);
      expect(
        Math.hypot(
          world.stores.position.x[eid]! - point.x,
          world.stores.position.y[eid]! - point.y,
        ),
      ).toBeLessThanOrEqual(world.floorMap!.config.tileSizeFt);
    }
    expect(getFloor4LiveWaveEnemyCount(world)).toBe(24);
    markOwnedDead(world);
    advance(world, 1);
    expect(window(world).debt).toHaveLength(0);
    expect(state(world).waveTelemetry.enemiesSpawned).toBe(expectedDebt.length);
  });

  it('releases only the pending batch after a large clock jump and warns before another', () => {
    const world = setup();
    pressureOnly(world);
    advance(world, 1);
    const batch = window(world).pressure!.pending!;
    advance(world, 20_000);
    expect(state(world).waveTelemetry.enemiesSpawned).toBe(batch.entries.length);
    expect(window(world).pressure!.pending).toBeUndefined();
    markOwnedDead(world);
    advance(world, 1);
    expect(window(world).pressure!.pending!.releaseAtActMs).toBe(
      state(world).arenaElapsedMs + leadMs,
    );
    expect(state(world).waveTelemetry.enemiesSpawned).toBe(batch.entries.length);
  });

  it('exhausts a finite reserve even when every released enemy is killed', () => {
    const world = setup();
    pressureOnly(world);
    const reserve = window(world).pressure!.reserve.slice(0, 3);
    window(world).pressure = { ...window(world).pressure!, reserve };
    for (let step = 0; step < 10; step++) {
      advance(world, Math.max(leadMs, tuning.intervalMs));
      markOwnedDead(world);
    }
    expect(window(world).pressure!.cursor).toBe(reserve.length);
    expect(state(world).waveTelemetry.enemiesSpawned).toBe(reserve.length);
    expect(window(world).pressure!.pending).toBeUndefined();
    expect(window(world).debt).toHaveLength(0);
  });

  it('cuts adaptive enemies and drops pending warnings at the boss boundary', () => {
    const world = setup();
    pressureOnly(world);
    advance(world, 1);
    advance(world, leadMs);
    const survivors = [...window(world).ownedEnemies.entries()];
    expect(survivors.length).toBeGreaterThan(0);
    advance(world, tuning.intervalMs);
    expect(window(world).pressure!.pending).toBeDefined();
    advance(world, config.phase.waveWindowMs);
    expect(state(world).phase.kind).toBe('HEADLINE');
    expect(state(world).waves).toBeUndefined();
    expect(
      survivors.every(
        ([eid, generation]) =>
          !entityExists(world.ecs, eid) || world.entityRenderGeneration[eid] !== generation,
      ),
    ).toBe(true);
    expect(state(world).waveTelemetry.enemiesCut).toBe(survivors.length);
    const spawned = state(world).waveTelemetry.enemiesSpawned;
    advance(world, leadMs + tuning.intervalMs);
    expect(state(world).waveTelemetry.enemiesSpawned).toBe(spawned);
  });

  it('does not count or cut an enemy whose recycled id has another generation', () => {
    const world = setup();
    pressureOnly(world);
    const oldEid = ownedHostile(world);
    const generation = world.entityRenderGeneration[oldEid];
    clearEntityStores(world, oldEid);
    removeEntity(world.ecs, oldEid);
    const eid = spawnBehaviorEnemy(world, 0, 0, 20, 0, 0.16, 60, 0);
    expect(eid).toBe(oldEid);
    expect(world.entityRenderGeneration[eid]).not.toBe(generation);
    expect(getFloor4LiveWaveEnemyCount(world)).toBe(0);
    // Transition directly so the cut cannot rely on a prior pruning tick.
    advance(world, config.phase.waveWindowMs);
    expect(entityExists(world.ecs, eid)).toBe(true);
    expect(world.stores.health.current[eid]).toBe(20);
    expect(state(world).waveTelemetry.enemiesCut).toBe(0);
  });
});
