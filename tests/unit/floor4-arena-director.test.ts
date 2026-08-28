import { entityExists, query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Player } from '../../src/core/components.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { createBossChestId } from '../../src/game/boss-chest-resolver.js';
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

function defeatActiveHeadliner(world: ReturnType<typeof setupFloor4>): void {
  const encounter = world.floorExtendedState!.floor4Arena!.activeHeadliner;
  if (!encounter?.bossEid) {
    throw new Error('expected an active Headliner');
  }
  world.stores.health.current[encounter.bossEid] = 0;
  advance(world, 1);
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
      defeatActiveHeadliner(world);
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
    defeatActiveHeadliner(world);
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
      defeatActiveHeadliner(world);
      advance(world, phase.headlineWindowMs);
      advance(world, phase.intermissionMs);
      expect(confirmFloor4StairDescend(world)).toBe(false);
    }
    advance(world, phase.waveWindowMs);
    defeatActiveHeadliner(world);
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
      1,
      phase.headlineWindowMs,
      phase.intermissionMs,
      phase.waveWindowMs,
      1,
      phase.headlineWindowMs,
    ];

    for (const ms of steps) {
      advance(left, ms);
      advance(right, ms);
      if (left.floorExtendedState!.floor4Arena!.phase.kind === 'HEADLINE') {
        const leftBoss = left.floorExtendedState!.floor4Arena!.activeHeadliner!.bossEid!;
        const rightBoss = right.floorExtendedState!.floor4Arena!.activeHeadliner!.bossEid!;
        left.stores.health.current[leftBoss] = 0;
        right.stores.health.current[rightBoss] = 0;
      }
    }

    expect(left.floorExtendedState!.floor4Arena!.timeline).toEqual(
      right.floorExtendedState!.floor4Arena!.timeline,
    );
  });

  it('builds a deterministic act-slot Headliner card at initialization', () => {
    const left = setupFloor4(1201);
    const right = setupFloor4(1201);
    const different = setupFloor4(1202);

    expect(left.floorExtendedState!.floor4Arena!.headlinerCard).toEqual(
      right.floorExtendedState!.floor4Arena!.headlinerCard,
    );
    expect(
      left.floorExtendedState!.floor4Arena!.headlinerCard.map((entry) => entry.slotId),
    ).toEqual([
      'floor4-headliner-act-1',
      'floor4-headliner-act-2',
      'floor4-headliner-act-3',
      'floor4-headliner-act-4',
      'floor4-headliner-act-5',
    ]);
    expect(left.floorExtendedState!.floor4Arena!.headlinerCard[4]).toMatchObject({
      archetypeId: 'floor4-showrunner',
      fixedFinale: true,
    });
    expect(
      new Set(left.floorExtendedState!.floor4Arena!.headlinerCard.map((entry) => entry.archetypeId))
        .size,
    ).toBe(5);
    expect(different.floorExtendedState!.floor4Arena!.headlinerCard).not.toEqual(
      left.floorExtendedState!.floor4Arena!.headlinerCard,
    );
  });

  it('spawns the act-slot Headliner and grants fee plus boss chest once on defeat', () => {
    const world = setupFloor4(404);
    const phase = getFloorManifest('floor4')!.floor4!.phase;

    advance(world, phase.countdownMs);
    advance(world, phase.waveWindowMs);
    const encounter = world.floorExtendedState!.floor4Arena!.activeHeadliner!;
    const goldBefore = world.playerGold;
    expect(encounter.slotId).toBe('floor4-headliner-act-1');
    expect(world.enemyAppearanceKeys.get(encounter.bossEid!)).toBe(encounter.archetypeId);
    expect(world.announcements.at(-1)?.kind).toBe('bossAbilityCast');

    defeatActiveHeadliner(world);
    arenaDirectorSystem(world);

    const state = world.floorExtendedState!.floor4Arena!;
    expect(state.phase).toEqual({ kind: 'HEADLINE', act: 1, cleared: true });
    expect(world.playerGold).toBe(goldBefore + encounter.appearanceFeeGold);
    expect(world.bossChests.has(createBossChestId('floor4-headliner-act-1'))).toBe(true);
    expect(state.headlinerTelemetry.appearanceFeeGoldGranted).toBe(encounter.appearanceFeeGold);
    expect(state.headlinerTelemetry.chestsSpawned).toBe(1);

    arenaDirectorSystem(world);
    expect(world.playerGold).toBe(goldBefore + encounter.appearanceFeeGold);
    expect(state.headlinerTelemetry.chestsSpawned).toBe(1);
  });

  it('force-resolves an unopened boss chest when the act reaches intermission', () => {
    const world = setupFloor4(404);
    const phase = getFloorManifest('floor4')!.floor4!.phase;

    advance(world, phase.countdownMs);
    advance(world, phase.waveWindowMs);
    defeatActiveHeadliner(world);
    const chestId = createBossChestId('floor4-headliner-act-1');
    const chestEid = world.bossChestEids.get(chestId);
    advance(world, phase.headlineWindowMs);

    expect(world.floorExtendedState!.floor4Arena!.phase).toEqual({ kind: 'INTERMISSION', act: 1 });
    expect(world.bossChests.get(chestId)?.state).toBe('revealed');
    expect(world.bossChestEids.has(chestId)).toBe(false);
    expect(chestEid).toBeDefined();
    expect(entityExists(world.ecs, chestEid!)).toBe(false);
    expect(world.floorExtendedState!.floor4Arena!.headlinerTelemetry.chestsForceResolved).toBe(1);
  });

  it('holds the Headline phase until a failed forced chest grant can retry', () => {
    const world = setupFloor4(404);
    const player = query(world.ecs, [Player])[0]!;
    const phase = getFloorManifest('floor4')!.floor4!.phase;

    advance(world, phase.countdownMs);
    advance(world, phase.waveWindowMs);
    defeatActiveHeadliner(world);
    const inventory = world.inventories.get(player)!;
    world.inventories.delete(player);
    advance(world, phase.headlineWindowMs);

    const state = world.floorExtendedState!.floor4Arena!;
    const chestId = createBossChestId('floor4-headliner-act-1');
    expect(state.phase).toEqual({ kind: 'HEADLINE', act: 1, cleared: true });
    expect(world.bossChests.get(chestId)?.state).toBe('available');
    expect(state.headlinerTelemetry.chestsForceResolved).toBe(0);

    world.inventories.set(player, inventory);
    advance(world, 1);

    expect(state.phase).toEqual({ kind: 'INTERMISSION', act: 1 });
    expect(world.bossChests.get(chestId)?.state).toBe('revealed');
    expect(state.headlinerTelemetry.chestsForceResolved).toBe(1);
  });

  it('holds overtime until a failed forced chest grant can retry', () => {
    const world = setupFloor4(404);
    const player = query(world.ecs, [Player])[0]!;
    const phase = getFloorManifest('floor4')!.floor4!.phase;

    advance(world, phase.countdownMs);
    advance(world, phase.waveWindowMs);
    advance(world, phase.headlineWindowMs);
    expect(world.floorExtendedState!.floor4Arena!.phase).toEqual({ kind: 'OVERTIME', act: 1 });

    const inventory = world.inventories.get(player)!;
    world.inventories.delete(player);
    defeatActiveHeadliner(world);

    const state = world.floorExtendedState!.floor4Arena!;
    expect(state.phase).toEqual({ kind: 'OVERTIME', act: 1 });
    expect(world.state).toBe('playing');

    world.inventories.set(player, inventory);
    advance(world, 1);

    expect(state.phase).toEqual({ kind: 'INTERMISSION', act: 1 });
    expect(state.headlinerTelemetry.chestsForceResolved).toBe(1);
  });

  it('enters overtime at the act mark, applies ramp steps, and caps at defeat', () => {
    const world = setupFloor4(404);
    const phase = getFloorManifest('floor4')!.floor4!.phase;

    advance(world, phase.countdownMs);
    advance(world, phase.waveWindowMs);
    const encounter = world.floorExtendedState!.floor4Arena!.activeHeadliner!;
    const bossEid = encounter.bossEid!;
    const baseSpeed = world.stores.enemyBehavior.speed[bossEid] ?? 0;
    const baseDamage = world.stores.damage.amount[bossEid] ?? 0;
    advance(world, phase.headlineWindowMs);

    let state = world.floorExtendedState!.floor4Arena!;
    expect(state.phase).toEqual({ kind: 'OVERTIME', act: 1 });
    expect(state.arenaElapsedMs).toBe(phase.actDurationMs);
    expect(state.headlinerTelemetry.overtimeStarted).toBe(1);

    advance(world, 1);
    expect(world.stores.enemyBehavior.speed[bossEid]).toBeGreaterThan(baseSpeed);
    expect(world.stores.damage.amount[bossEid]).toBeGreaterThan(baseDamage);
    expect(state.headlinerTelemetry.overtimeStepsApplied).toBe(1);

    advance(world, phase.overtimeCapMs);
    state = world.floorExtendedState!.floor4Arena!;
    expect(state.phase).toEqual({ kind: 'DEFEAT' });
    expect(world.state).toBe('game_over');
  });
});
