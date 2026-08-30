import { query, hasComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  Companion,
  Enemy,
  DeathTimer,
  PartySlot,
  Player,
  Position,
  Team,
} from '../../src/core/index.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { arenaDirectorSystem, initializeFloor4Scenario } from '../../src/game/floor4Scenario.js';
import {
  capturePlayerCarryover,
  type PlayerCarryoverSnapshot,
} from '../../src/game/playerCarryover.js';
import {
  companionAISystem,
  getCompanionAIDecision,
} from '../../src/game/systems/companionAISystem.js';
import { isEnemyCombatEligible } from '../../src/game/floor2BossEligibility.js';
import { buildKeptCompanionContract } from '../../src/shared/data/floor3/kept-companion-contract.js';
import {
  ABILITY_MILESTONE_LEVELS,
  getPetSpecies,
  speciesTokenForId,
} from '../../src/shared/data/floor3/species.js';
import { TeamId } from '../../src/shared/constants.js';
import { getFloorManifest } from '../../src/shared/floor-registry.js';
import type { GameWorld } from '../../src/core/world.js';
import type { Floor4WaveWindowState } from '../../src/shared/floor-types.js';
import { createTestWorld } from '../helpers/world-factory.js';

const floor4 = getFloorManifest('floor4')!.floor4!;
const phase = floor4.phase;
const waves = floor4.waves;
const FLOOR3_GRADUATE_LEVEL = ABILITY_MILESTONE_LEVELS[ABILITY_MILESTONE_LEVELS.length - 1] ?? 0;

function setupFloor4(seed = 42): GameWorld {
  const world = createTestWorld({ seed });
  const player = spawnPlayer(world, 0, 0);
  initializeFloor4Scenario(world, player);
  return world;
}

function blankCarryoverSnapshot(seed = 42): PlayerCarryoverSnapshot {
  const source = createTestWorld({ seed });
  const sourcePlayer = spawnPlayer(source, 0, 0);
  return capturePlayerCarryover(source, sourcePlayer);
}

function carryoverWithKeptCompanion(
  seed = 42,
  speciesId = 'ember-charger',
): PlayerCarryoverSnapshot {
  const species = getPetSpecies(speciesId);
  if (!species) {
    throw new Error(`Unknown test species ${speciesId}`);
  }
  return {
    ...blankCarryoverSnapshot(seed),
    keptCompanion: buildKeptCompanionContract(species),
  };
}

function setupFloor4WithCarryover(playerCarryover: PlayerCarryoverSnapshot, seed = 42): GameWorld {
  const world = createTestWorld({ seed });
  const player = spawnPlayer(world, 0, 0);
  initializeFloor4Scenario(world, player, { playerCarryover });
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

function defeatActiveHeadliner(world: GameWorld): void {
  const encounter = arena(world).activeHeadliner;
  if (!encounter?.bossEid) {
    throw new Error('expected an active Headliner');
  }
  world.stores.health.current[encounter.bossEid] = 0;
  advance(world, 1);
}

/** Enemies actually standing in the arena (corpses excluded). */
function liveEnemies(world: GameWorld): number[] {
  return [...query(world.ecs, [Enemy])].filter((eid) => !hasComponent(world.ecs, eid, DeathTimer));
}

function playerTeamCompanions(world: GameWorld): number[] {
  return [...query(world.ecs, [Enemy, Companion, Team])].filter(
    (eid) => (world.stores.team.id[eid] ?? -1) === TeamId.PLAYER,
  );
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

describe('floor4 kept-companion co-star', () => {
  it('keeps carryover-without-kept-companion wave behavior identical to cold Floor 4', () => {
    const cold = setupFloor4(3547);
    const carriedWithoutKept = setupFloor4WithCarryover(blankCarryoverSnapshot(3547), 3547);

    expect(playerTeamCompanions(cold)).toHaveLength(0);
    expect(playerTeamCompanions(carriedWithoutKept)).toHaveLength(0);

    openWaveWindow(cold);
    openWaveWindow(carriedWithoutKept);

    expect(waveWindow(carriedWithoutKept).manifests).toEqual(waveWindow(cold).manifests);
    expect(waveWindow(carriedWithoutKept).releaseCursor).toBe(waveWindow(cold).releaseCursor);
    expect(arena(carriedWithoutKept).waveTelemetry).toEqual(arena(cold).waveTelemetry);
    expect([...waveWindow(carriedWithoutKept).ownedEnemies.values()]).toEqual([
      ...waveWindow(cold).ownedEnemies.values(),
    ]);
  });

  it('re-hosts a valid kept companion as one optional allied non-party co-star', () => {
    const world = setupFloor4WithCarryover(carryoverWithKeptCompanion(3547), 3547);
    const coStars = playerTeamCompanions(world);

    expect(coStars).toHaveLength(1);
    const coStar = coStars[0]!;
    const player = query(world.ecs, [Player, Position])[0];
    expect(hasComponent(world.ecs, coStar, PartySlot)).toBe(false);
    expect(world.stores.companion.speciesToken[coStar]).toBe(speciesTokenForId('ember-charger'));
    expect(world.stores.companion.form[coStar]).toBe(2);
    expect(world.stores.companion.level[coStar]).toBe(FLOOR3_GRADUATE_LEVEL);
    expect(world.stores.companion.ownerTeam[coStar]).toBe(TeamId.PLAYER);
    expect(isEnemyCombatEligible(world, coStar)).toBe(false);

    const floorMap = world.floorMap!;
    const coStarTile = floorMap.worldToTile(
      world.stores.position.x[coStar] ?? 0,
      world.stores.position.y[coStar] ?? 0,
    );
    const playerTile =
      player === undefined
        ? undefined
        : floorMap.worldToTile(
            world.stores.position.x[player] ?? 0,
            world.stores.position.y[player] ?? 0,
          );
    expect(playerTile).toBeDefined();
    expect(coStarTile).not.toEqual(playerTile);
    expect(floorMap.tileMap.isPassable(coStarTile.x, coStarTile.y)).toBe(true);
  });

  it('keeps the co-star out of wave ownership while letting companion AI target wave enemies', () => {
    const world = setupFloor4WithCarryover(carryoverWithKeptCompanion(3548, 'ember-slinger'), 3548);
    const coStar = playerTeamCompanions(world)[0]!;

    openWaveWindow(world);
    const spawnedWaveEnemies = [...waveWindow(world).ownedEnemies.keys()];
    expect(spawnedWaveEnemies).not.toContain(coStar);
    expect(spawnedWaveEnemies.length).toBeGreaterThan(0);
    for (const enemy of spawnedWaveEnemies) {
      expect(world.stores.team.id[enemy]).toBe(TeamId.ENEMY);
    }

    const target = spawnedWaveEnemies[0]!;
    world.stores.position.x[target] = (world.stores.position.x[coStar] ?? 0) + 1;
    world.stores.position.y[target] = world.stores.position.y[coStar] ?? 0;

    companionAISystem(world);
    const decision = getCompanionAIDecision(world, coStar);
    expect(decision?.kind).toBe('rival-primary');
    expect(decision?.targetEid).toBe(target);
  });
});

describe('floor4 gate telegraphs', () => {
  it('pre-arms the opening wave before its act starts (design §4)', () => {
    const world = setupFloor4(2024);

    // Wave 0 releases at act-relative 0ms, so its warning can only exist before
    // the wave window opens: outside the lead window nothing is lit.
    advance(world, phase.countdownMs - waves.gates.telegraphLeadMs - 2);
    expect(arena(world).pendingWaves).toBeUndefined();
    expect(arena(world).waveTelemetry.gateTelegraphsArmed).toBe(0);

    advance(world, 2);
    const pending = arena(world).pendingWaves!;
    const opener = pending.manifests[0]!;
    const openerGates = [...new Set(opener.entries.map((entry) => entry.gateIndex))].sort(
      (left, right) => left - right,
    );
    expect(pending.act).toBe(1);
    expect(pending.armedTelegraphs.map((armed) => armed.gateIndex)).toEqual(openerGates);
    expect(arena(world).waveTelemetry.gateTelegraphsArmed).toBe(openerGates.length);
    expect(world.vfxEvents.filter((event) => event.kind === 'spawnerPulse')).toHaveLength(
      openerGates.length,
    );
    // A telegraph is a warning, not a release.
    expect(liveEnemies(world)).toHaveLength(0);

    // Idempotent while it stays armed.
    advance(world, 1);
    expect(arena(world).waveTelemetry.gateTelegraphsArmed).toBe(openerGates.length);

    // The window inherits the pre-armed state (and its manifests) rather than
    // arming wave 0 a second time.
    advance(world, waves.gates.telegraphLeadMs);
    expect(arena(world).phase).toEqual({ kind: 'WAVES', act: 1 });
    expect(arena(world).pendingWaves).toBeUndefined();
    expect(waveWindow(world).manifests[0]).toEqual(opener);
    expect(
      waveWindow(world)
        .armedTelegraphs.filter((armed) => armed.waveIndex === 0)
        .map((armed) => armed.gateIndex),
    ).toEqual(openerGates);
    expect(arena(world).waveTelemetry.gateTelegraphsArmed).toBe(openerGates.length);

    // Spent on release, exactly like every later wave's telegraph.
    advance(world, 1);
    expect(waveWindow(world).releaseCursor).toBe(1);
    expect(waveWindow(world).armedTelegraphs.some((armed) => armed.waveIndex === 0)).toBe(false);
  });

  it('pre-arms the opening wave of a later act during the intermission', () => {
    const world = setupFloor4(2024);
    advance(world, phase.countdownMs);
    advance(world, phase.waveWindowMs);
    defeatActiveHeadliner(world);
    advance(world, phase.headlineWindowMs);
    expect(arena(world).phase).toEqual({ kind: 'INTERMISSION', act: 1 });

    advance(world, phase.intermissionMs - 1);
    const pending = arena(world).pendingWaves!;
    expect(pending.act).toBe(2);
    expect(pending.armedTelegraphs.every((armed) => armed.waveIndex === 0)).toBe(true);
    expect(pending.armedTelegraphs.length).toBeGreaterThan(0);
    const armedCount = arena(world).waveTelemetry.gateTelegraphsArmed;

    advance(world, 1);
    expect(arena(world).phase).toEqual({ kind: 'WAVES', act: 2 });
    expect(waveWindow(world).armedTelegraphs.some((armed) => armed.waveIndex === 0)).toBe(true);
    expect(arena(world).waveTelemetry.gateTelegraphsArmed).toBe(armedCount);
  });

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
    // `firesAtArenaMs` is arena-ABSOLUTE, not act-relative — a HUD countdown
    // reads it against the arena clock.
    const actStartMs = phase.actDurationMs * (waveWindow(world).act - 1);
    expect(
      armed.every((entry) => entry.firesAtArenaMs === actStartMs + nextManifest.releaseAtActMs),
    ).toBe(true);
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

describe('floor4 multi-act wave hand-off', () => {
  it('arms, telegraphs, releases and cuts every act of the rehearsal', () => {
    const world = setupFloor4(31);
    advance(world, phase.countdownMs);

    for (let act = 1; act <= phase.actCount; act += 1) {
      expect(arena(world).phase).toEqual({ kind: 'WAVES', act });
      const window = waveWindow(world);
      expect(window.act).toBe(act);

      // The opener's telegraph was pre-armed in the preceding phase and handed
      // to this window rather than re-armed (or skipped) here.
      const opener = window.manifests[0]!;
      const openerGates = [...new Set(opener.entries.map((entry) => entry.gateIndex))].sort(
        (left, right) => left - right,
      );
      expect(
        window.armedTelegraphs
          .filter((armed) => armed.waveIndex === 0)
          .map((armed) => armed.gateIndex),
      ).toEqual(openerGates);
      // Telegraph marks are arena-ABSOLUTE, so a later act's opener is not 0.
      const actStartMs = phase.actDurationMs * (act - 1);
      expect(
        window.armedTelegraphs.every(
          (armed) => armed.firesAtArenaMs === actStartMs + opener.releaseAtActMs,
        ),
      ).toBe(true);
      expect(arena(world).pendingWaves).toBeUndefined();

      const releasedBefore = arena(world).waveTelemetry.wavesReleased;
      advance(world, 1);
      for (let wave = 1; wave < waves.cadence.wavesPerAct; wave += 1) {
        advance(world, waves.cadence.intervalMs);
      }
      expect(arena(world).waveTelemetry.wavesReleased).toBe(
        releasedBefore + waves.cadence.wavesPerAct,
      );

      // Boundary: the act's survivors are cut and the window is torn down.
      advance(world, phase.waveWindowMs);
      expect(arena(world).phase).toEqual({ kind: 'HEADLINE', act, cleared: false });
      expect(arena(world).waves).toBeUndefined();
      expect(liveEnemies(world)).toHaveLength(1);

      defeatActiveHeadliner(world);
      advance(world, phase.headlineWindowMs);
      advance(world, phase.intermissionMs);
    }

    expect(arena(world).phase).toEqual({ kind: 'VICTORY' });
    expect(arena(world).pendingWaves).toBeUndefined();
    expect(arena(world).waveTelemetry.wavesReleased).toBe(
      waves.cadence.wavesPerAct * phase.actCount,
    );
    expect(arena(world).waveTelemetry.enemiesCut).toBeGreaterThan(0);
  });
});

describe('floor4 concurrency cap and spawn debt', () => {
  /** Drive the rehearsal timeline to the start of the heaviest act's window. */
  function openFinalActWaveWindow(world: GameWorld): void {
    advance(world, phase.countdownMs);
    for (let act = 1; act < phase.actCount; act += 1) {
      advance(world, phase.waveWindowMs);
      defeatActiveHeadliner(world);
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

  it('spawns into free capacity before banking anything as debt', () => {
    // A tight (or zero) debt cap must throttle the BACKLOG, not delete a wave
    // the arena had room for: with debtCap 0 the opener still spawns in full.
    const concurrency = waves.concurrency as { liveCap: number; debtCap: number };
    const originalDebtCap = concurrency.debtCap;
    concurrency.debtCap = 0;
    try {
      const world = setupFloor4(2024);
      openWaveWindow(world);

      const manifest = waveWindow(world).manifests[0]!;
      expect(manifest.entries.length).toBeGreaterThan(0);
      expect(manifest.entries.length).toBeLessThanOrEqual(concurrency.liveCap);
      expect(arena(world).waveTelemetry.enemiesSpawned).toBe(manifest.entries.length);
      expect(arena(world).waveTelemetry.debtDiscarded).toBe(0);
      expect(waveWindow(world).debt).toHaveLength(0);
    } finally {
      concurrency.debtCap = originalDebtCap;
    }
  });

  it('fails loudly when a released entry references a gate the map lacks', () => {
    // Unreachable while the map and its manifests agree, which is exactly why
    // it must not be absorbed: quietly dropping the entry would delete an enemy
    // and hide the corruption inside the debt-discard counter.
    const world = setupFloor4(2024);
    advance(world, phase.countdownMs);
    (world.floorMap as unknown as { feedGates: unknown[] }).feedGates = [];

    expect(() => advance(world, 1)).toThrow(/feed gate/);
  });

  it('clears banked debt and armed telegraphs at the phase boundary', () => {
    const world = setupFloor4(31);
    openFinalActWaveWindow(world);
    for (let wave = 1; wave < waves.cadence.wavesPerAct; wave += 1) {
      advance(world, waves.cadence.intervalMs);
    }
    const window = waveWindow(world);
    expect(window.debt.length).toBeGreaterThan(0);
    const releasedEntries = window.manifests
      .slice(0, window.releaseCursor)
      .reduce((total, manifest) => total + manifest.entries.length, 0);

    advance(world, phase.waveWindowMs);

    expect(arena(world).phase.kind).toBe('HEADLINE');
    expect(arena(world).waves).toBeUndefined();
    expect(liveEnemies(world)).toHaveLength(1);
    // Every released entry is accounted for: it either stood in the arena
    // (spawned, and then cut) or never reached it (discarded) — banked debt
    // dropped by the cut is discarded, not silently forgotten.
    const telemetry = arena(world).waveTelemetry;
    expect(telemetry.enemiesSpawned + telemetry.debtDiscarded).toBe(releasedEntries);
    expect(telemetry.enemiesCut).toBeLessThanOrEqual(telemetry.enemiesSpawned);
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
    expect(liveEnemies(world)).toHaveLength(1);
    expect(query(world.ecs, [Enemy])).toHaveLength(1);
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
