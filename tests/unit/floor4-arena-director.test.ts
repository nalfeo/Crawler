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
import { buildFloor4HudState } from '../../src/shared/floor4-hud.js';
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

  it('opens Green Room stock on intermission entry and retires it on exit', () => {
    const world = setupFloor4();
    const phase = getFloorManifest('floor4')!.floor4!.phase;

    advance(world, phase.countdownMs);
    advance(world, phase.waveWindowMs);
    defeatActiveHeadliner(world);
    advance(world, phase.headlineWindowMs);

    expect(world.floorExtendedState!.floor4Arena!.phase).toEqual({ kind: 'INTERMISSION', act: 1 });
    expect(world.floorExtendedState!.floor4GreenRoom?.currentVisit?.visitIndex).toBe(0);
    const firstVisit = world.floorExtendedState!.floor4GreenRoom!.currentVisit;

    advance(world, phase.intermissionMs);

    expect(world.floorExtendedState!.floor4Arena!.phase).toEqual({ kind: 'WAVES', act: 2 });
    expect(world.floorExtendedState!.floor4GreenRoom?.currentVisit).toBeUndefined();
    expect(world.floorExtendedState!.floor4GreenRoom?.retiredVisitCount).toBe(1);
    expect(world.floorExtendedState!.floor4GreenRoom?.lastOpenedVisitIndex).toBe(0);
    expect(firstVisit).toBeDefined();
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
    expect(world.stores.damage.amount[encounter.bossEid!]).toBe(encounter.contactDamage);
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

  it('records act wave income from drop-ledger delta only (excluding non-drop gold)', () => {
    const world = setupFloor4(404);
    const phase = getFloorManifest('floor4')!.floor4!.phase;
    const dropGoldEarned = 12;
    const lootBoxGold = 6;

    advance(world, phase.countdownMs);
    const goldBeforeMutations = world.playerGold;
    world.goldLedger.earnedFromDrops += dropGoldEarned;
    world.playerGold += dropGoldEarned;
    world.goldLedger.earnedFromLootBoxes += lootBoxGold;
    world.playerGold += lootBoxGold;
    advance(world, phase.waveWindowMs);
    const appearanceFeeGold =
      world.floorExtendedState!.floor4Arena!.activeHeadliner!.appearanceFeeGold;
    defeatActiveHeadliner(world);
    advance(world, phase.headlineWindowMs);
    expect(world.playerGold).toBe(
      goldBeforeMutations + dropGoldEarned + lootBoxGold + appearanceFeeGold,
    );

    const income = world.floorExtendedState!.floor4Arena!.actIncome[0];
    expect(income).toBeDefined();
    expect(income!.waveGold).toBe(dropGoldEarned);
    expect(income!.waveGold).not.toBe(dropGoldEarned + lootBoxGold);
    expect(income!.appearanceFeeGold).toBe(appearanceFeeGold);
    expect(income!.totalGold).toBe(dropGoldEarned + appearanceFeeGold);
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

  it('telegraphs the overtime finisher before applying its lethal resolution', () => {
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

    advance(world, phase.overtimeCapMs - 3_000);
    state = world.floorExtendedState!.floor4Arena!;
    expect(state.phase).toEqual({ kind: 'OVERTIME', act: 1 });
    expect(world.state).toBe('playing');
    expect(world.announcements.at(-1)).toMatchObject({
      eventId: 'floor4-overtime-cap-act-1',
      durationMs: 3000,
    });

    const playerEid = query(world.ecs, [Player])[0]!;
    expect(world.stores.health.current[playerEid]).toBeGreaterThan(0);
    advance(world, 3_000);
    state = world.floorExtendedState!.floor4Arena!;
    expect(state.phase).toEqual({ kind: 'DEFEAT' });
    expect(world.stores.health.current[playerEid]).toBe(0);
    expect(world.state).toBe('game_over');
  });

  it('projects a real, sim-captured per-act delta into the HUD summary (not the run-cumulative total)', () => {
    const world = setupFloor4(7);
    const floor4 = getFloorManifest('floor4')!.floor4!;
    const phase = floor4.phase;
    const waves = floor4.waves;

    function runActWaves(): void {
      // Release every authored wave on its cadence, then close the window so
      // any still-live wave enemies are counted as cut (mirrors the release
      // pattern used in tests/unit/floor4-arena-waves.test.ts).
      for (let released = 1; released < waves.cadence.wavesPerAct; released += 1) {
        advance(world, waves.cadence.intervalMs);
      }
      advance(world, phase.waveWindowMs);
    }

    advance(world, phase.countdownMs);
    runActWaves();
    defeatActiveHeadliner(world);
    // Land exactly on the HEADLINE -> INTERMISSION boundary for act 1 without
    // overshooting into act 2, mirroring the "holds the arena clock" test's
    // ms-exact technique above.
    advance(world, phase.headlineWindowMs - 1);
    expect(world.floorExtendedState!.floor4Arena!.phase).toEqual({ kind: 'INTERMISSION', act: 1 });

    // Advancing through act 2's waves cascades through the rest of act 1's
    // intermission and re-snapshots actBaseline from act 1's real,
    // sim-produced cumulative totals (not a hand-authored fixture) the
    // instant act 2's WAVES phase opens.
    runActWaves();
    defeatActiveHeadliner(world);
    advance(world, phase.headlineWindowMs - 1);

    const arena = world.floorExtendedState!.floor4Arena!;
    expect(arena.phase).toEqual({ kind: 'INTERMISSION', act: 2 });
    const act1Baseline = arena.actBaseline;
    expect(act1Baseline.enemiesSpawned).toBeGreaterThan(0);
    expect(act1Baseline.enemiesCut).toBeGreaterThan(0);
    expect(arena.waveTelemetry.enemiesSpawned).toBeGreaterThan(act1Baseline.enemiesSpawned);

    const hud = buildFloor4HudState({
      arena,
      phaseConfig: {
        actCount: phase.actCount,
        actDurationMs: phase.actDurationMs,
        waveWindowMs: phase.waveWindowMs,
        overtimeCapMs: phase.overtimeCapMs,
        wavesPerAct: waves.cadence.wavesPerAct,
      },
      playerGold: world.playerGold,
    });

    const expectedSpawnedThisAct = arena.waveTelemetry.enemiesSpawned - act1Baseline.enemiesSpawned;
    const expectedCutThisAct = arena.waveTelemetry.enemiesCut - act1Baseline.enemiesCut;
    const expectedGoldEarned = world.playerGold - act1Baseline.playerGold;
    expect(hud.summary).toContain(`Enemies booked: ${expectedSpawnedThisAct}`);
    expect(hud.summary).toContain(`Cuts: ${expectedCutThisAct}`);
    expect(hud.summary).toContain(`Gold earned: ${expectedGoldEarned}`);
    // The run-cumulative totals differ from the act-2-only deltas above,
    // proving the summary is NOT simply echoing the cumulative counters.
    expect(arena.waveTelemetry.enemiesSpawned).not.toBe(expectedSpawnedThisAct);

    // Prove the gold snapshot is genuinely LOCKED against the real sim path
    // (not just a hand-authored fixture): spend gold mid-break, as a sponsor
    // purchase would, and confirm the summary still reports the pre-spend
    // delta instead of re-diffing against the drained live balance.
    const goldBeforeSpend = world.playerGold;
    world.playerGold = Math.max(0, world.playerGold - 5);
    const hudAfterSpend = buildFloor4HudState({
      arena,
      phaseConfig: {
        actCount: phase.actCount,
        actDurationMs: phase.actDurationMs,
        waveWindowMs: phase.waveWindowMs,
        overtimeCapMs: phase.overtimeCapMs,
        wavesPerAct: waves.cadence.wavesPerAct,
      },
      playerGold: world.playerGold,
    });
    expect(world.playerGold).toBeLessThan(goldBeforeSpend);
    expect(hudAfterSpend.summary).toContain(`Gold earned: ${expectedGoldEarned}`);
  });
});
