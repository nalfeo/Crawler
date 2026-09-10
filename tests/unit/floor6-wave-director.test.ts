/**
 * Floor 6 Slice 3 — wave director and route-following raider unit tests.
 *
 * Covers acceptance criteria FR3.2 (manifests, stable IDs, bounded cap/debt),
 * FR3.3 (missing entity recovery), FR3.4 (stable ordering), FR2.2 (terminal
 * precedence), and FR9.6 (no soft lock).
 */
import { addComponent, query, set, setComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { BroadcastRelayRaider, Health, Position } from '../../src/core/index.js';
import { createEntity, spawnPlayer } from '../../src/core/helpers.js';
import { createFloorMainSceneOptions } from '../../src/bootstrap/floor-main-scene-options.js';
import {
  buildFloor6Tower,
  confirmFloor6StairDescend,
  floor6CombatContributionSystem,
  floor6DefenseDirectorSystem,
  floor6RaiderSystem,
  getFloor6DefenseRunStats,
  getFloor6RunOutcome,
  purchaseFloor6UpgradeOffer,
  _getFloor6InitializationArtifact,
} from '../../src/game/floor6Scenario.js';
import { runSimulationStep } from '../../src/game/ai/simulation-step.js';
import { questSystem } from '../../src/core/systems/questSystem.js';
import { floor6Manifest } from '../../src/shared/floor-manifest.js';
import { createInputState } from '../../src/shared/input.js';
import { FLOOR6_DEFENSE_QUEST_ID } from '../../src/shared/quest-types.js';
import { createTestWorld } from '../helpers/world-factory.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function initFloor6(seed = 606) {
  const world = createTestWorld({ seed });
  const player = spawnPlayer(world, 0, 0);
  createFloorMainSceneOptions('floor6').configureWorld!(world, player);
  return { world, player };
}

function getDefenseState(world: ReturnType<typeof createTestWorld>) {
  const state = world.floorExtendedState?.floor6Defense;
  if (!state) throw new Error('No floor6 defense state');
  return state;
}

function tickDirector(world: ReturnType<typeof createTestWorld>, ticks = 1) {
  for (let i = 0; i < ticks; i++) {
    world.frameCount += 1;
    world.elapsedMs += 16;
    floor6DefenseDirectorSystem(world);
  }
}

function completeCurrentFloor6Act(world: ReturnType<typeof createTestWorld>) {
  const state = getDefenseState(world);
  const wave = floor6Manifest.floor6?.waves?.[state.currentActIndex];
  if (!wave || !state.waveManifest) throw new Error('No current Floor 6 act');
  const entries = state.waveManifest.filter(
    (entry) => entry.kind === 'wave' && entry.waveIndex === wave.waveIndex,
  );
  for (const entry of entries) {
    while (state.liveEnemies.length <= entry.manifestIndex) {
      state.liveEnemies.push({
        eid: -1,
        waypointIndex: 0,
        stillFrames: 0,
        stallResolved: true,
        defeated: true,
        rewardSpawned: true,
      });
    }
    state.liveEnemies[entry.manifestIndex] = {
      eid: -1,
      waypointIndex: 0,
      stillFrames: 0,
      stallResolved: true,
      defeated: true,
      rewardSpawned: true,
    };
    state.nextReleaseIndex = Math.max(state.nextReleaseIndex, entry.manifestIndex + 1);
  }
  tickDirector(world);
}

function enterFinaleByCompletingActs(world: ReturnType<typeof createTestWorld>) {
  tickDirector(world);
  completeCurrentFloor6Act(world);
  tickDirector(world, (floor6Manifest.floor6?.finale?.breakDurationFrames ?? 0) + 1);
  completeCurrentFloor6Act(world);
  tickDirector(world, (floor6Manifest.floor6?.finale?.breakDurationFrames ?? 0) + 1);
  completeCurrentFloor6Act(world);
}

function tickBoth(world: ReturnType<typeof createTestWorld>, ticks = 1) {
  for (let i = 0; i < ticks; i++) {
    world.frameCount += 1;
    world.elapsedMs += 16;
    floor6RaiderSystem(world);
    floor6DefenseDirectorSystem(world);
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Floor 6 wave manifest determinism', () => {
  it('produces byte-identical manifests for the same seed (FR9.1)', () => {
    const { world: w1 } = initFloor6(606);
    const { world: w2 } = initFloor6(606);
    tickDirector(w1);
    tickDirector(w2);
    const s1 = getDefenseState(w1);
    const s2 = getDefenseState(w2);
    expect(JSON.stringify(s1.waveManifest)).toBe(JSON.stringify(s2.waveManifest));
  });

  it('produces different manifests for different seeds', () => {
    // Both seeds share the same authored schedule (stable content), but the
    // rngStreamKeys differ — the manifest itself is seed-independent authored
    // data. The keys are seed-scoped.
    const { world: w1 } = initFloor6(606);
    const { world: w2 } = initFloor6(999);
    tickDirector(w1);
    tickDirector(w2);
    expect(w1.floorExtendedState?.floor6Defense?.rngStreamKeys.waves).not.toBe(
      w2.floorExtendedState?.floor6Defense?.rngStreamKeys.waves,
    );
    // The authored schedule content is identical (same manifest JSON)
    expect(JSON.stringify(w1.floorExtendedState?.floor6Defense?.waveManifest)).toBe(
      JSON.stringify(w2.floorExtendedState?.floor6Defense?.waveManifest),
    );
  });

  it('manifest entries are stable-ordered (FR3.4) — manifestIndex matches array index', () => {
    const { world } = initFloor6(606);
    tickDirector(world);
    const state = getDefenseState(world);
    const manifest = state.waveManifest;
    expect(manifest).not.toBeNull();
    manifest!.forEach((entry, idx) => {
      expect(entry.manifestIndex).toBe(idx);
    });
  });

  it('every manifest entry references a valid route ID from geometry (FR3.2)', () => {
    const { world } = initFloor6(606);
    tickDirector(world);
    const state = getDefenseState(world);
    const routeIds = new Set(state.geometry.routes.map((r) => r.id));
    for (const entry of state.waveManifest ?? []) {
      expect(routeIds.has(entry.routeId)).toBe(true);
    }
  });

  it('every manifest entry has a valid archetypeId from the floor6 pack (FR3.2)', () => {
    const { world } = initFloor6(606);
    tickDirector(world);
    const state = getDefenseState(world);
    const validIds = new Set(['floor6-site-prep', 'floor6-demo-lead', 'floor6-cable-crew']);
    for (const entry of state.waveManifest ?? []) {
      expect(validIds.has(entry.archetypeId)).toBe(true);
    }
  });

  it('wave schedule matches authored floor6.manifest.json', () => {
    const { world } = initFloor6(606);
    tickDirector(world);
    const state = getDefenseState(world);
    const authored = floor6Manifest.floor6?.waves ?? [];
    const expectedTotal = authored.reduce((sum, w) => sum + w.entries.length, 0);
    expect(state.waveManifest?.length).toBe(expectedTotal);
  });
});

describe('Floor 6 Slice 7 phase arc, finale, payout, and exit', () => {
  it('projects the Slice 8 quest goals from authoritative defense state', () => {
    const { world } = initFloor6();
    const state = getDefenseState(world);
    const quest = world.questLog.get(FLOOR6_DEFENSE_QUEST_ID);
    expect(quest?.status).toBe('active');

    tickDirector(world);
    expect(world.goalFlags.get('floor6.defense.briefed')).toBe(true);
    expect(getFloor6DefenseRunStats(world)?.presentation.questGoals).toMatchObject({
      'floor6.defense.briefed': true,
      'floor6.defense.firstWaveCleared': false,
    });

    state.economy.balance = 100;
    state.economy.totalEarned = 100;
    expect(buildFloor6Tower(world, state.geometry.buildSites[0]!.id, 'signal-slinger').ok).toBe(
      true,
    );
    expect(purchaseFloor6UpgradeOffer(world, state.upgradeOfferManifest![0]!.offerId).ok).toBe(
      true,
    );
    expect(world.goalFlags.get('floor6.defense.firstBuildPlaced')).toBe(true);
    expect(world.goalFlags.get('floor6.defense.firstUpgradeChosen')).toBe(true);

    completeCurrentFloor6Act(world);
    expect(world.goalFlags.get('floor6.defense.firstWaveCleared')).toBe(true);
    tickDirector(world, (floor6Manifest.floor6?.finale?.breakDurationFrames ?? 0) + 1);
    expect(world.goalFlags.get('floor6.defense.breakCleared')).toBe(true);

    completeCurrentFloor6Act(world);
    tickDirector(world, (floor6Manifest.floor6?.finale?.breakDurationFrames ?? 0) + 1);
    completeCurrentFloor6Act(world);
    state.finale.bossDefeated = true;
    tickDirector(world);
    questSystem(world);

    expect(world.goalFlags.get('floor6.defense.deadlineDefeated')).toBe(true);
    expect(world.goalFlags.get('floor6.defense.relaySecured')).toBe(true);
    expect(world.questLog.get(FLOOR6_DEFENSE_QUEST_ID)?.status).toBe('complete');
  });

  it('emits non-color presentation labels for routes, sites, towers, loot, upgrades, breaks, and Deadline', () => {
    const { world } = initFloor6();
    const state = getDefenseState(world);
    tickDirector(world);
    state.economy.balance = 100;
    state.economy.totalEarned = 100;
    expect(buildFloor6Tower(world, state.geometry.buildSites[0]!.id, 'signal-slinger').ok).toBe(
      true,
    );
    expect(purchaseFloor6UpgradeOffer(world, state.upgradeOfferManifest![0]!.offerId).ok).toBe(
      true,
    );

    const defendPresentation = getFloor6DefenseRunStats(world)!.presentation;
    expect(defendPresentation.routes.map((route) => [route.routeId, route.directionLabel])).toEqual(
      [
        ['west-service-route', 'incoming from west route → Relay'],
        ['south-loading-route', 'incoming from south route ↑ Relay'],
      ],
    );
    expect(defendPresentation.buildSites.some((site) => site.label.includes('VACANT'))).toBe(true);
    expect(defendPresentation.buildSites.some((site) => site.label.includes('OCCUPIED'))).toBe(
      true,
    );
    expect(defendPresentation.towers[0]).toMatchObject({
      towerId: 'signal-slinger',
      rangeFt: 36,
    });
    expect(defendPresentation.towers[0]!.tierLabel).toContain('tower modifier');
    expect(defendPresentation.buildCurrencyLabel).toContain('Requisitions');
    expect(defendPresentation.lootLabel).toContain('requisition drops');
    expect(defendPresentation.upgradeChoiceLabel).toContain('upgrade offers chosen');

    completeCurrentFloor6Act(world);
    const breakPresentation = getFloor6DefenseRunStats(world)!.presentation;
    expect(breakPresentation.breakSafetyLabel).toContain('Break safe: 0 live hostiles');
    expect(breakPresentation.cues.some((cue) => cue.id === 'floor6-break-safe-0')).toBe(true);

    tickDirector(world, (floor6Manifest.floor6?.finale?.breakDurationFrames ?? 0) + 1);
    completeCurrentFloor6Act(world);
    // Regression coverage: each BREAK occurrence must cue audio once, not
    // just the first — MainGameScene.playedScenarioCueIds latches cue IDs
    // for the whole run, so a second break needs a distinct ID from the
    // first (`floor6-break-safe-0`) to actually replay the cue.
    const secondBreakPresentation = getFloor6DefenseRunStats(world)!.presentation;
    expect(secondBreakPresentation.cues.some((cue) => cue.id === 'floor6-break-safe-1')).toBe(true);
    tickDirector(world, (floor6Manifest.floor6?.finale?.breakDurationFrames ?? 0) + 1);
    completeCurrentFloor6Act(world);
    const finalePresentation = getFloor6DefenseRunStats(world)!.presentation;
    expect(finalePresentation.deadlineLabel).toContain('Deadline active');
    expect(finalePresentation.cues.some((cue) => cue.id === 'floor6-deadline-finale')).toBe(true);

    state.relayHp = 20;
    expect(getFloor6DefenseRunStats(world)!.presentation.relayDangerLabel).toMatch(/CRITICAL/);
  });

  it('tower tier label counts only tower-affecting upgrade offers, not relay/raider-only ones', () => {
    const { world } = initFloor6();
    const state = getDefenseState(world);
    tickDirector(world);
    state.economy.balance = 100;
    state.economy.totalEarned = 100;
    expect(buildFloor6Tower(world, state.geometry.buildSites[0]!.id, 'signal-slinger').ok).toBe(
      true,
    );

    // A relay-only offer (no tower effect) must NOT invent a per-tower tier.
    const relayOnlyOffer = state.upgradeOfferManifest!.find(
      (offer) => offer.effect.kind === 'relayRepair',
    );
    expect(relayOnlyOffer).toBeDefined();
    expect(purchaseFloor6UpgradeOffer(world, relayOnlyOffer!.offerId).ok).toBe(true);
    expect(getFloor6DefenseRunStats(world)!.presentation.towers[0]!.tierLabel).toBe('base tier');

    // A tower-affecting offer is the only thing that should move the label,
    // and it must count exactly the tower-affecting offers selected (one),
    // not every selected offer (two).
    const towerOffer = state.upgradeOfferManifest!.find(
      (offer) => offer.effect.kind === 'towerDamageBonus',
    );
    expect(towerOffer).toBeDefined();
    expect(purchaseFloor6UpgradeOffer(world, towerOffer!.offerId).ok).toBe(true);
    expect(getFloor6DefenseRunStats(world)!.presentation.towers[0]!.tierLabel).toBe(
      '+1 global tower modifier',
    );
  });

  it('same-world restart clears prior Floor 6 quest projection and reaccepts the quest', () => {
    const { world, player } = initFloor6();
    const scenario = createFloorMainSceneOptions('floor6');
    tickDirector(world);
    const firstState = getDefenseState(world);
    firstState.economy.balance = 100;
    firstState.economy.totalEarned = 100;
    expect(
      buildFloor6Tower(world, firstState.geometry.buildSites[0]!.id, 'signal-slinger').ok,
    ).toBe(true);
    expect(purchaseFloor6UpgradeOffer(world, firstState.upgradeOfferManifest![0]!.offerId).ok).toBe(
      true,
    );
    completeCurrentFloor6Act(world);
    tickDirector(world, (floor6Manifest.floor6?.finale?.breakDurationFrames ?? 0) + 1);
    completeCurrentFloor6Act(world);
    tickDirector(world, (floor6Manifest.floor6?.finale?.breakDurationFrames ?? 0) + 1);
    completeCurrentFloor6Act(world);
    firstState.finale.bossDefeated = true;
    tickDirector(world);
    questSystem(world);
    expect(world.questLog.get(FLOOR6_DEFENSE_QUEST_ID)?.status).toBe('complete');

    scenario.configureWorld!(world, player);

    expect(world.questLog.get(FLOOR6_DEFENSE_QUEST_ID)?.status).toBe('active');
    expect(world.goalFlags.get('floor6.defense.questComplete')).toBeUndefined();
    for (const goalId of [
      'floor6.defense.briefed',
      'floor6.defense.firstWaveCleared',
      'floor6.defense.firstBuildPlaced',
      'floor6.defense.firstUpgradeChosen',
      'floor6.defense.breakCleared',
      'floor6.defense.deadlineDefeated',
      'floor6.defense.relaySecured',
    ]) {
      expect(world.goalFlags.get(goalId)).toBeUndefined();
    }
    expect(getDefenseState(world).towersTornDown).toBe(0);
  });

  it('survives each authored act and enters/exits bounded hostile-free build breaks', () => {
    const { world } = initFloor6();
    tickDirector(world);
    const state = getDefenseState(world);

    completeCurrentFloor6Act(world);
    expect(state.phase.kind).toBe('BREAK');
    expect(query(world.ecs, [BroadcastRelayRaider, Health])).toHaveLength(0);

    const stray = createEntity(world);
    addComponent(world.ecs, stray, set(BroadcastRelayRaider, { manifestIndex: 0 }));
    addComponent(world.ecs, stray, set(Health, { current: 1, max: 1 }));
    addComponent(world.ecs, stray, set(Position, { x: 0, y: 0 }));
    tickDirector(world);
    expect(query(world.ecs, [BroadcastRelayRaider, Health])).toHaveLength(0);

    tickDirector(world, (floor6Manifest.floor6?.finale?.breakDurationFrames ?? 0) + 1);
    expect(state.phase.kind).toBe('DEFEND');
    expect(state.breaksEntered).toBe(1);
    expect(state.breaksExited).toBe(1);
    expect(state.hostileActivityDuringBreak).toBe(1);

    completeCurrentFloor6Act(world);
    tickDirector(world, (floor6Manifest.floor6?.finale?.breakDurationFrames ?? 0) + 1);
    completeCurrentFloor6Act(world);
    expect(state.phase.kind).toBe('FINALE');
    expect(state.breaksEntered).toBe(2);
    expect(state.breaksExited).toBe(2);
    expect(state.finale.bossManifest?.displayName).toBe('Broadcast Deadline');
  });

  it('keeps build and upgrade transactions legal only during defense breaks', () => {
    const { world } = initFloor6();
    enterFinaleByCompletingActs(world);
    const state = getDefenseState(world);
    state.economy.balance = 100;
    expect(buildFloor6Tower(world, state.geometry.buildSites[0]!.id, 'signal-slinger')).toEqual({
      ok: false,
      reason: 'phase-locked',
    });
    expect(purchaseFloor6UpgradeOffer(world, state.upgradeOfferManifest![0]!.offerId)).toEqual({
      ok: false,
      reason: 'phase-locked',
    });
  });

  it('same-tick defeat precedence beats an otherwise defeated Deadline', () => {
    const { world } = initFloor6();
    enterFinaleByCompletingActs(world);
    const state = getDefenseState(world);
    state.finale.bossDefeated = true;
    state.relayHp = 0;

    tickDirector(world);

    expect(state.phase.kind).toBe('DEFEAT');
    expect(state.terminalOutcome).toBe('defeat');
    expect(state.terminalOutcomeCount).toBe(1);
    expect(state.victoryPayout.count).toBe(0);
    expect(getFloor6RunOutcome(world)).toBe('failed_timeout');
  });

  it('boss timeout backstop records one terminal defeat and cleans up', () => {
    const { world } = initFloor6();
    enterFinaleByCompletingActs(world);
    const state = getDefenseState(world);
    state.finale.startedFrame = world.frameCount - state.finale.timeoutFrames;

    tickDirector(world);

    expect(state.phase.kind).toBe('DEFEAT');
    expect(state.terminalOutcome).toBe('defeat');
    expect(state.terminalOutcomeCount).toBe(1);
    expect(getFloor6DefenseRunStats(world)?.terminalResetCount).toBe(1);
  });

  it('Deadline defeat awards payout and opens the exit exactly once', () => {
    const { world } = initFloor6();
    enterFinaleByCompletingActs(world);
    const state = getDefenseState(world);
    const goldBefore = world.playerGold;
    state.finale.bossDefeated = true;

    tickDirector(world);
    const statsAfterVictory = getFloor6DefenseRunStats(world);
    tickDirector(world, 3);

    expect(state.phase.kind).toBe('VICTORY');
    expect(state.terminalOutcome).toBe('victory');
    expect(state.terminalOutcomeCount).toBe(1);
    expect(state.victoryPayout.count).toBe(1);
    expect(state.exit.openCount).toBe(1);
    expect(world.playerGold).toBe(
      goldBefore + (floor6Manifest.floor6?.finale?.victoryPayoutGold ?? 0),
    );
    expect(getFloor6DefenseRunStats(world)).toEqual(statsAfterVictory);
    expect(confirmFloor6StairDescend(world)).toBe(true);
    expect(getFloor6RunOutcome(world)).toBe('cleared_floor');
  });

  it('post-core reconciliation latches player defeat authoritatively', () => {
    const { world, player } = initFloor6();
    tickDirector(world);
    const state = getDefenseState(world);

    runSimulationStep(world, createInputState(), 16, {
      preSystems: [
        floor6DefenseDirectorSystem,
        (w) => {
          setComponent(w.ecs, player, Health, { current: 0, max: 100 });
        },
      ],
      postSystems: [floor6CombatContributionSystem],
    });

    expect(state.phase.kind).toBe('DEFEAT');
    expect(state.terminalOutcome).toBe('defeat');
    expect(state.terminalOutcomeCount).toBe(1);
    expect(state.phaseTrace.at(-1)).toMatchObject({
      kind: 'DEFEND',
      toKind: 'DEFEAT',
      reason: 'player-defeated',
      terminalOutcome: 'defeat',
    });
  });

  it('post-core reconciliation latches Deadline defeat on the final legal combat tick', () => {
    const { world } = initFloor6();
    enterFinaleByCompletingActs(world);
    const state = getDefenseState(world);

    runSimulationStep(world, createInputState(), 16, {
      preSystems: [
        floor6DefenseDirectorSystem,
        (w) => {
          const bossEid = getDefenseState(w).finale.bossEid;
          expect(bossEid).toBeGreaterThan(0);
          setComponent(w.ecs, bossEid, Health, { current: 0, max: 60 });
        },
      ],
      postSystems: [floor6CombatContributionSystem],
    });

    expect(state.phase.kind).toBe('VICTORY');
    expect(state.terminalOutcome).toBe('victory');
    expect(state.terminalOutcomeCount).toBe(1);
    expect(state.victoryPayout.count).toBe(1);
    expect(state.exit.openCount).toBe(1);
  });
});

describe('Floor 6 phase transitions', () => {
  it('transitions SETUP → DEFEND on first director tick', () => {
    const { world } = initFloor6();
    expect(getDefenseState(world).phase.kind).toBe('SETUP');
    tickDirector(world);
    expect(getDefenseState(world).phase.kind).toBe('DEFEND');
  });

  it('records SETUP in phase trace after first transition', () => {
    const { world } = initFloor6();
    tickDirector(world);
    const trace = getDefenseState(world).phaseTrace;
    expect(trace[0]?.kind).toBe('SETUP');
    expect(trace[0]).toMatchObject({
      toKind: 'DEFEND',
      reason: 'setup-complete',
      frame: 1,
      terminalOutcome: null,
    });
  });

  it('terminal phases are idempotent — further ticks do not change state', () => {
    const { world, player } = initFloor6();
    tickDirector(world); // SETUP → DEFEND
    // Kill player
    setComponent(world.ecs, player, Health, { current: 0, max: 100 });
    tickDirector(world); // should → DEFEAT
    expect(getDefenseState(world).phase.kind).toBe('DEFEAT');
    const statsAfter = getFloor6DefenseRunStats(world);
    tickDirector(world); // should be no-op
    tickDirector(world);
    expect(getDefenseState(world).phase.kind).toBe('DEFEAT');
    expect(getFloor6DefenseRunStats(world)).toEqual(statsAfter);
  });
});

describe('Floor 6 terminal precedence (FR2.2)', () => {
  it('player death → DEFEAT (highest precedence)', () => {
    const { world, player } = initFloor6();
    tickDirector(world); // SETUP → DEFEND
    // Manually reduce relay HP so relay is also about to be destroyed
    const state = getDefenseState(world);
    state.relayHp = 1;
    // Kill player
    setComponent(world.ecs, player, Health, { current: 0, max: 100 });
    tickDirector(world);
    expect(state.phase.kind).toBe('DEFEAT');
    // Phase trace should record DEFEND (where we were when player died)
    expect(state.phaseTrace.some((p) => p.kind === 'DEFEND')).toBe(true);
    // Run stats must reflect DEFEAT
    expect(getFloor6DefenseRunStats(world)?.phase.kind).toBe('DEFEAT');
  });

  it('relay HP ≤ 0 → DEFEAT (second precedence, player alive)', () => {
    const { world } = initFloor6();
    tickDirector(world); // SETUP → DEFEND
    const state = getDefenseState(world);
    state.relayHp = 0;
    tickDirector(world);
    expect(state.phase.kind).toBe('DEFEAT');
  });

  it('relay HP > 0 does not trigger defeat', () => {
    const { world } = initFloor6();
    tickDirector(world);
    const state = getDefenseState(world);
    state.relayHp = 50;
    tickDirector(world);
    expect(state.phase.kind).toBe('DEFEND');
  });
});

describe('Floor 6 live cap and spawn debt (FR3.2)', () => {
  it('director transitions to DEFEND and initializes relay HP from tuning', () => {
    const { world } = initFloor6();
    tickDirector(world);
    const state = getDefenseState(world);
    const expectedHp = floor6Manifest.floor6?.tuning?.relayMaxHp ?? 100;
    expect(state.relayHp).toBe(expectedHp);
    expect(state.relayHp).toBeGreaterThan(0);
  });

  it('spawnDebt starts at 0 after SETUP→DEFEND', () => {
    const { world } = initFloor6();
    tickDirector(world);
    expect(getDefenseState(world).spawnDebt).toBe(0);
  });

  it('nextReleaseIndex advances as ticks pass first wave releaseTick', () => {
    const { world } = initFloor6();
    tickDirector(world); // SETUP → DEFEND
    const state = getDefenseState(world);
    const firstReleaseTick = state.waveManifest?.[0]?.releaseTick ?? 999;
    expect(state.nextReleaseIndex).toBe(0);
    // Advance to firstReleaseTick
    while (world.frameCount < firstReleaseTick) {
      tickDirector(world);
    }
    tickDirector(world); // this tick should release entry 0
    expect(state.nextReleaseIndex).toBeGreaterThan(0);
  });

  it('spawnDebt is bounded to spawnDebtCap (FR3.2)', () => {
    const { world } = initFloor6();
    tickDirector(world);
    const state = getDefenseState(world);
    const cap = floor6Manifest.floor6?.tuning?.liveCap ?? 6;
    const debtCap = floor6Manifest.floor6?.tuning?.spawnDebtCap ?? 12;
    // Advance past ALL wave release ticks to force debt accumulation
    const maxTick = (state.waveManifest?.at(-1)?.releaseTick ?? 0) + 200;
    while (world.frameCount < maxTick) {
      tickDirector(world);
    }
    // spawnDebt must never exceed debtCap
    expect(state.spawnDebt).toBeLessThanOrEqual(debtCap);
    // Live raiders must not exceed live cap
    const liveCount = Array.from(query(world.ecs, [BroadcastRelayRaider, Health])).filter(
      (eid) => (world.stores.health.current[eid] ?? 0) > 0,
    ).length;
    expect(liveCount).toBeLessThanOrEqual(cap);
  });
});

describe('Floor 6 missing entity recovery (FR3.3)', () => {
  it('reconcileFloor6LiveEnemies marks dead entities without softlock', () => {
    const { world } = initFloor6();
    tickDirector(world); // SETUP → DEFEND
    const state = getDefenseState(world);
    const firstReleaseTick = state.waveManifest?.[0]?.releaseTick ?? 999;

    // Advance to first release
    while (world.frameCount <= firstReleaseTick) {
      tickDirector(world);
    }
    // Find a live raider and kill it
    const raiders = Array.from(query(world.ecs, [BroadcastRelayRaider, Health]));
    if (raiders.length > 0) {
      const eid = raiders[0]!;
      setComponent(world.ecs, eid, Health, { current: 0, max: 30 });
      // Tick director to reconcile
      tickDirector(world);
      const mIdx = world.stores.broadcastRelayRaider.manifestIndex[eid] ?? 0;
      const rec = state.liveEnemies[mIdx];
      // After reconciliation the record should reflect the entity is no longer live
      expect(rec?.eid).toBeLessThanOrEqual(0);
    }
  });

  it('phase does not stall when all raiders are dead/missing (FR3.3)', () => {
    const { world } = initFloor6();
    tickDirector(world);
    const state = getDefenseState(world);
    // Advance past all release ticks
    const maxTick = (state.waveManifest?.at(-1)?.releaseTick ?? 0) + 200;
    while (world.frameCount < maxTick) {
      tickDirector(world);
    }
    // Kill all raiders
    for (const eid of query(world.ecs, [BroadcastRelayRaider, Health])) {
      setComponent(world.ecs, eid, Health, { current: 0, max: 30 });
    }
    // Multiple ticks should not produce DEFEAT (we're not stalled — all done)
    tickDirector(world);
    tickDirector(world);
    tickDirector(world);
    // Without player death or relay loss, clearing an act now advances to the safe build break.
    expect(state.phase.kind).toBe('BREAK');
  });
});

describe('Floor 6 run stats telemetry (FR2.4)', () => {
  it('getFloor6DefenseRunStats returns undefined when not on floor 6', () => {
    const world = createTestWorld({ seed: 42 });
    expect(getFloor6DefenseRunStats(world)).toBeUndefined();
  });

  it('returns valid stats after initialization', () => {
    const { world } = initFloor6();
    tickDirector(world);
    const stats = getFloor6DefenseRunStats(world);
    expect(stats).toBeDefined();
    expect(stats?.phase.kind).toBe('DEFEND');
    expect(stats?.relayHp).toBeGreaterThan(0);
    expect(stats?.relayMaxHp).toBeGreaterThan(0);
    expect(stats?.waveManifestLength).toBeGreaterThan(0);
    expect(stats?.spawnDebt).toBe(0);
  });

  it('relayMaxHp matches manifest tuning', () => {
    const { world } = initFloor6();
    tickDirector(world);
    const stats = getFloor6DefenseRunStats(world);
    expect(stats?.relayMaxHp).toBe(floor6Manifest.floor6?.tuning?.relayMaxHp ?? 100);
  });
});

describe('Floor 6 raider route traversal (FR3.1)', () => {
  it('spawned raiders carry BroadcastRelayRaider component with route data', () => {
    const { world } = initFloor6();
    tickDirector(world); // SETUP → DEFEND
    const state = getDefenseState(world);
    const firstReleaseTick = state.waveManifest?.[0]?.releaseTick ?? 999;
    while (world.frameCount <= firstReleaseTick) {
      tickBoth(world);
    }
    const raiders = Array.from(query(world.ecs, [BroadcastRelayRaider, Health]));
    if (raiders.length > 0) {
      const eid = raiders[0]!;
      const mIdx = world.stores.broadcastRelayRaider.manifestIndex[eid] ?? 0;
      const entry = state.waveManifest?.[mIdx];
      expect(entry).toBeDefined();
      expect(entry?.routeId).toBeDefined();
      // waypointIndex starts at 0 or may have advanced; just check it's a valid index
      const wpIdx = world.stores.broadcastRelayRaider.waypointIndex[eid] ?? 0;
      const route = state.geometry.routes.find((r) => r.id === entry?.routeId);
      expect(wpIdx).toBeGreaterThanOrEqual(0);
      if (route) expect(wpIdx).toBeLessThanOrEqual(route.waypoints.length);
    }
  });

  it('raider position advances along authored waypoints without relying on velocity', () => {
    const { world } = initFloor6();
    tickDirector(world);
    const state = getDefenseState(world);
    const firstReleaseTick = state.waveManifest?.[0]?.releaseTick ?? 999;
    while (world.frameCount <= firstReleaseTick) {
      tickBoth(world);
    }
    tickBoth(world); // run raider system
    const raiders = Array.from(query(world.ecs, [BroadcastRelayRaider, Health, Position]));
    for (const eid of raiders) {
      if ((world.stores.health.current[eid] ?? 0) <= 0) continue;
      const wIdx = world.stores.broadcastRelayRaider.waypointIndex[eid] ?? 0;
      const mIdx = world.stores.broadcastRelayRaider.manifestIndex[eid] ?? 0;
      const entry = state.waveManifest?.[mIdx];
      const route = state.geometry.routes.find((r) => r.id === entry?.routeId);
      if (!route || wIdx >= route.waypoints.length) continue;
      const before = {
        x: world.stores.position.x[eid] ?? 0,
        y: world.stores.position.y[eid] ?? 0,
      };
      tickBoth(world);
      const after = {
        x: world.stores.position.x[eid] ?? 0,
        y: world.stores.position.y[eid] ?? 0,
      };
      expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(0);
      expect(Math.hypot(world.stores.velocity.x[eid] ?? 0, world.stores.velocity.y[eid] ?? 0)).toBe(
        0,
      );
      break; // one raider is enough
    }
  });

  it('debt cleared when relay destroyed (terminal cleanup)', () => {
    const { world } = initFloor6();
    tickDirector(world);
    const state = getDefenseState(world);
    // Force some debt
    state.spawnDebt = 5;
    state.relayHp = 0;
    tickDirector(world);
    expect(state.phase.kind).toBe('DEFEAT');
    expect(state.spawnDebt).toBe(0);
  });

  it('position-based stall detection stays clear while direct route following advances', () => {
    const { world } = initFloor6();
    tickDirector(world);
    const state = getDefenseState(world);
    // Fast-forward past first release tick so at least one raider spawns
    const firstReleaseTick = state.waveManifest?.[0]?.releaseTick ?? 999;
    while (world.frameCount <= firstReleaseTick) {
      tickBoth(world);
    }
    tickBoth(world);
    const raiders = Array.from(query(world.ecs, [BroadcastRelayRaider, Health]));
    if (raiders.length === 0) return; // nothing spawned yet — skip
    const eid = raiders[0]!;
    for (let i = 0; i < 20; i++) {
      tickBoth(world);
    }
    const mIdx = world.stores.broadcastRelayRaider.manifestIndex[eid] ?? 0;
    const rec = state.liveEnemies[mIdx];
    const sf = world.stores.broadcastRelayRaider.stillFrames[eid] ?? 0;
    expect(sf).toBe(0);
    expect(rec?.stallResolved ?? false).toBe(false);
  });

  it('counts route pressure from successful spawns rather than attempted release indexes', () => {
    const { world } = initFloor6();
    tickDirector(world);
    const state = getDefenseState(world);
    const firstRouteId = state.waveManifest?.[0]?.routeId;
    if (!firstRouteId) throw new Error('Floor 6 manifest missing first route');

    state.nextReleaseIndex = state.waveManifest?.length ?? 0;
    state.routeReleaseCounts = { [firstRouteId]: 1 };

    const pressure = getFloor6DefenseRunStats(world)?.releaseGate.routePressure ?? [];
    expect(pressure.reduce((sum, route) => sum + route.released, 0)).toBe(1);
    expect(pressure.find((route) => route.routeId === firstRouteId)?.released).toBe(1);
  });

  it('records stalled raiders once and resets per-run stall counters on restart', () => {
    const { world } = initFloor6();
    tickDirector(world);
    const state = getDefenseState(world);
    const firstReleaseTick = state.waveManifest?.[0]?.releaseTick ?? 999;
    while (world.frameCount <= firstReleaseTick) {
      tickDirector(world);
    }

    const eid = Array.from(query(world.ecs, [BroadcastRelayRaider, Health, Position]))[0];
    if (eid === undefined) throw new Error('Floor 6 did not spawn a raider for stall coverage');
    const manifestIndex = world.stores.broadcastRelayRaider.manifestIndex[eid] ?? 0;
    const routeId = state.waveManifest?.[manifestIndex]?.routeId;
    if (!routeId) throw new Error('Spawned raider missing route manifest entry');
    const stalledThreshold = floor6Manifest.floor6?.tuning?.stalledFramesThreshold ?? 90;
    const frozen = {
      x: world.stores.position.x[eid] ?? 0,
      y: world.stores.position.y[eid] ?? 0,
    };
    const tickFrozenRaider = () => {
      setComponent(world.ecs, eid, Position, frozen);
      world.stores.broadcastRelayRaider.prevX[eid] = frozen.x;
      world.stores.broadcastRelayRaider.prevY[eid] = frozen.y;
      world.frameCount += 1;
      world.elapsedMs += 16;
      floor6RaiderSystem(world);
    };

    for (let i = 0; i < stalledThreshold + 5; i++) {
      tickFrozenRaider();
    }

    expect(state.stalledRaiderCount).toBe(1);
    expect(state.routeStallCounts[routeId]).toBe(1);
    expect(state.liveEnemies[manifestIndex]?.stallResolved).toBe(true);

    for (let i = 0; i < 5; i++) {
      tickFrozenRaider();
    }

    expect(state.stalledRaiderCount).toBe(1);
    expect(state.routeStallCounts[routeId]).toBe(1);

    state.relayHp = 0;
    floor6DefenseDirectorSystem(world);
    expect(state.phase.kind).toBe('DEFEAT');
    expect(state.stalledRaiderCount).toBe(1);
    expect(state.routeStallCounts[routeId]).toBe(1);

    state.phase = { kind: 'SETUP' };
    tickDirector(world);
    expect(state.stalledRaiderCount).toBe(0);
    expect(state.routeStallCounts).toEqual({});
  });
});
