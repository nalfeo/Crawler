import { describe, expect, it } from 'vitest';
import {
  applyFloor1WorkCosts,
  buildFloor1GoalGraph,
  makeStraightLineTravelOracle,
  PLAYER_START_LOCATION,
} from '../../src/game/ai/floor1-goal-graph.js';
import {
  planObjectiveRoute,
  IN_PLACE_LOCATION,
  type TravelOracle,
} from '../../src/game/ai/objective-route-planner.js';
import type { Floor1RunPlannerSnapshot, RunPlannerParams } from '../../src/game/ai/run-planner.js';

const PARAMS: RunPlannerParams = {
  moveSpeedFtPerMs: 0.12,
  safetyBufferMs: 20_000,
  urgencySlackWindowMs: 120_000,
  interactionMs: 1_500,
  level2GrindMs: 35_000,
  questKillMs: 4_500,
  goldFarmMs: 3_000,
  fetchPickupMs: 1_000,
  minorBossKillMs: 25_000,
  finalBossKillMs: 45_000,
  stairsInteractMs: 1_000,
};

function snapshot(overrides: Partial<Floor1RunPlannerSnapshot> = {}): Floor1RunPlannerSnapshot {
  return {
    nowMs: 0,
    deadlineMs: 600_000,
    player: { x: 0, y: 0 },
    currentTarget: null,
    activeQuestGiverDetour: false,
    tutorialAccepted: true,
    playerLevel: 2,
    questCompleted: true,
    ratsKilled: 6,
    slimesKilled: 4,
    requiredRats: 6,
    requiredSlimes: 4,
    requiredTotalKills: 10,
    shopStage: 'not-met',
    playerGold: 10, // no gold-farm node — isolates the shop/spell interleave from an extra required node
    shopkeeperEquipmentCost: 10,
    hasShopFetchItem: false,
    bossBattleAccepted: false,
    slimeRatStarted: false,
    slimeRatDefeated: false,
    spellsUnlocked: false,
    bossBattleComplete: false,
    staircaseStarted: false,
    staircaseDefeated: false,
    staircaseUnlocked: false,
    staircaseDiscovered: false,
    positions: {
      welcomeOffice: { x: 0, y: 0 },
      shop: { x: 0, y: 0 },
      spellQuestGiver: { x: 0, y: 0 },
      questItem: { x: 50, y: 0 },
      slimeRatRoom: { x: 60, y: 0 },
      staircase: { x: -50, y: 0 },
    },
    ...overrides,
  };
}

/**
 * Hub-and-spoke travel oracle matching the real room topology the human's
 * evidence described: a west hub (start/shop/spellQuestGiver, all
 * effectively the same stop) with THREE spokes off it — one to the merchant's
 * fetch item, a SECOND spoke continuing from that same spoke out to the Slime
 * Rat room (10 further than the fetch item — i.e. "on the way"), and a THIRD,
 * unrelated spoke to the staircase boss room. Crucially there is no direct
 * shortcut between the fetch-item/Slime-Rat spoke and the staircase spoke —
 * exactly the property a Euclidean straight-line oracle can't model (it would
 * "see" a diagonal shortcut that doesn't exist through walls), which is why
 * the strict, non-Euclidean generic oracle interface exists.
 */
function makeHubSpokeOracle(): TravelOracle {
  const hubCluster = new Set([PLAYER_START_LOCATION, 'shop', 'spellQuestGiver', 'welcomeOffice']);
  const distFromHub: Record<string, number> = { questItem: 50, slimeRatRoom: 60, staircase: 50 };
  const sameSpoke = new Set(['questItem', 'slimeRatRoom']);

  return {
    travelCost(from, to) {
      if (from === to) return 0;
      if (hubCluster.has(from) && hubCluster.has(to)) return 0;
      if (hubCluster.has(from)) return distFromHub[to] ?? Infinity;
      if (hubCluster.has(to)) return distFromHub[from] ?? Infinity;
      if (sameSpoke.has(from) && sameSpoke.has(to)) {
        return Math.abs((distFromHub[to] ?? Infinity) - (distFromHub[from] ?? Infinity));
      }
      // Different spokes: no direct shortcut — must transit back through the hub.
      const df = distFromHub[from];
      const dt = distFromHub[to];
      if (df === undefined || dt === undefined) return Infinity;
      return df + dt;
    },
  };
}

describe('buildFloor1GoalGraph + planObjectiveRoute (Floor 1 integration)', () => {
  it('complete-goon-kills emits floor1-goon-quest-complete unlock effect', () => {
    const snap = snapshot({ questCompleted: false });
    const graph = buildFloor1GoalGraph(snap);
    const byId = new Map(graph.goals.map((g) => [g.id, g]));
    expect(byId.get('complete-goon-kills')?.unlockEffects).toContain('floor1-goon-quest-complete');
  });

  it('kill-slime-rat and finish-slime-rat do NOT emit floor1-boss-battle-complete', () => {
    const snapKill = snapshot({ bossBattleAccepted: true });
    const graphKill = buildFloor1GoalGraph(snapKill);
    const killGoal = graphKill.goals.find((g) => g.id === 'kill-slime-rat');
    expect(killGoal?.unlockEffects).not.toContain('floor1-boss-battle-complete');
    expect(killGoal?.unlockEffects).toContain('floor1-slime-rat-room-open');
    expect(killGoal?.unlockEffects).toContain('!floor1-boss-battle-active');

    const snapFinish = snapshot({ bossBattleAccepted: true, slimeRatStarted: true });
    const graphFinish = buildFloor1GoalGraph(snapFinish);
    const finishGoal = graphFinish.goals.find((g) => g.id === 'finish-slime-rat');
    expect(finishGoal?.unlockEffects).not.toContain('floor1-boss-battle-complete');
    expect(finishGoal?.unlockEffects).toContain('floor1-slime-rat-room-open');
    expect(finishGoal?.unlockEffects).toContain('!floor1-boss-battle-active');
  });

  it('slimeRatDefeated alone does not add floor1-boss-battle-complete to initialSatisfiedEffects', () => {
    const snap = snapshot({
      slimeRatDefeated: true,
      bossBattleComplete: false,
      spellsUnlocked: false,
    });
    const graph = buildFloor1GoalGraph(snap);
    expect(graph.initialSatisfiedEffects).not.toContain('floor1-boss-battle-complete');
    // But it DOES add the room-open and active-battle-clear effects.
    expect(graph.initialSatisfiedEffects).toContain('floor1-slime-rat-room-open');
    expect(graph.initialSatisfiedEffects).toContain('!floor1-boss-battle-active');
  });

  it('bossBattleComplete:true (from goalFlag) adds floor1-boss-battle-complete to initialSatisfiedEffects', () => {
    const snap = snapshot({ bossBattleComplete: true, spellsUnlocked: true });
    const graph = buildFloor1GoalGraph(snap);
    expect(graph.initialSatisfiedEffects).toContain('floor1-boss-battle-complete');
  });

  it('claim-spell-reward is the sole emitter of floor1-boss-battle-complete in the goal graph', () => {
    // The route must include claim-spell-reward before kill-staircase-boss,
    // proving defeat alone never hypothetically opens the final gate.
    const snap = snapshot({
      bossBattleAccepted: true,
      slimeRatStarted: true,
      slimeRatDefeated: true,
      spellsUnlocked: false,
      bossBattleComplete: false,
    });
    const graph = buildFloor1GoalGraph(snap);
    const byId = new Map(graph.goals.map((g) => [g.id, g]));

    // The staircase boss must depend on claim-spell-reward, not on kill/finish.
    const staircaseGoal = byId.get('kill-staircase-boss');
    expect(staircaseGoal?.prerequisiteIds).toContain('claim-spell-reward');

    // claim-spell-reward is the only goal that emits floor1-boss-battle-complete.
    const claimGoal = byId.get('claim-spell-reward');
    expect(claimGoal?.unlockEffects).toContain('floor1-boss-battle-complete');
    for (const goal of graph.goals) {
      if (goal.id !== 'claim-spell-reward') {
        expect(goal.unlockEffects ?? []).not.toContain('floor1-boss-battle-complete');
      }
    }
  });

  it('models the shop chain and spell-broker chain as independent siblings, both gating the staircase', () => {
    const snap = snapshot();
    const graph = buildFloor1GoalGraph(snap);
    const byId = new Map(graph.goals.map((g) => [g.id, g]));

    // Neither chain's first step depends on the other chain.
    expect(byId.get('meet-shopkeeper')?.prerequisiteIds).toEqual([]);
    expect(byId.get('accept-spell-quest')?.prerequisiteIds).toEqual([]);

    // claim-spell-reward is included unconditionally whenever spells aren't
    // unlocked yet (not only once the Slime Rat happens to already be
    // defeated this frame) — otherwise the staircase gate would silently
    // regress to "just kill the Slime Rat" for every frame before the kill,
    // which is NOT the real door-lock gate (floor1-boss-battle-complete
    // requires the kill AND the spellbook claim).
    expect(byId.get('claim-spell-reward')?.prerequisiteIds).toEqual(['kill-slime-rat']);

    // The staircase boss node depends on the LAST step of the shop chain
    // (equip-shop-charm) AND the terminal step of the spell chain
    // (claim-spell-reward) — the true door-lock gate
    // (floor1-goon-quest-complete AND floor1-shop-quest-complete AND
    // floor1-boss-battle-complete), not a single-chain, source-order-only
    // dependency.
    const staircaseGoal = byId.get('kill-staircase-boss');
    expect(staircaseGoal?.prerequisiteIds).toContain('equip-shop-charm');
    expect(staircaseGoal?.prerequisiteIds).toContain('claim-spell-reward');
  });

  it('gates the staircase on claim-spell-reward once the Slime Rat is defeated but the spellbook not yet claimed', () => {
    const snap = snapshot({ slimeRatStarted: true, slimeRatDefeated: true, spellsUnlocked: false });
    const graph = buildFloor1GoalGraph(snap);
    const byId = new Map(graph.goals.map((g) => [g.id, g]));
    expect(byId.get('kill-staircase-boss')?.prerequisiteIds).toContain('claim-spell-reward');
    expect(byId.get('kill-staircase-boss')?.prerequisiteIds).toContain('equip-shop-charm');
  });

  it('interleaves the merchant fetch-item visit with the adjacent Slime Rat spoke instead of paying for two separate round trips', () => {
    const snap = snapshot();
    const rawGraph = buildFloor1GoalGraph(snap);
    const graph = applyFloor1WorkCosts(rawGraph, snap, PARAMS);
    const oracle = makeHubSpokeOracle();
    const route = planObjectiveRoute({
      goals: graph.goals,
      startLocation: PLAYER_START_LOCATION,
      travelOracle: oracle,
    });

    const order = route.steps.map((s) => s.goalId);
    const fetchIdx = order.indexOf('fetch-shop-prize');
    const slimeIdx = order.indexOf('kill-slime-rat');
    expect(fetchIdx).toBeGreaterThanOrEqual(0);
    expect(slimeIdx).toBeGreaterThanOrEqual(0);
    // Nothing that requires a hub round trip may be scheduled between the two
    // same-spoke visits — that wedge is exactly the historical bug.
    const between = order.slice(Math.min(fetchIdx, slimeIdx) + 1, Math.max(fetchIdx, slimeIdx));
    expect(between).toEqual([]);

    // The historical strict-source-order schedule (full shop chain, THEN full
    // spell-broker chain, THEN staircase) on this same hub-and-spoke layout:
    // hub->fetch(50)->hub[return](50)->hub->spell-accept(0)->slime(60)->staircase(60+50=110) = 270.
    const historicalTotal = 50 + 50 + 60 + 110;
    expect(route.totalTravelMs).toBeLessThan(historicalTotal);
    // The exact global optimum interleaves fetch+slime (same spoke, +10) before
    // returning to the hub once, then a single staircase spoke trip:
    // hub->fetch(50)->slime(10)->hub[return](60)->staircase(50) = 170.
    expect(route.totalTravelMs).toBe(170);
  });

  it('exposes a routeHeadId/nextActionableGoalId consistent with the chosen route', () => {
    const snap = snapshot();
    const rawGraph = buildFloor1GoalGraph(snap);
    const graph = applyFloor1WorkCosts(rawGraph, snap, PARAMS);
    const oracle = makeStraightLineTravelOracle(graph.locations, PARAMS.moveSpeedFtPerMs);
    const route = planObjectiveRoute({
      goals: graph.goals,
      startLocation: PLAYER_START_LOCATION,
      travelOracle: oracle,
    });
    expect(route.routeHeadId).toBe(route.steps[0]?.goalId ?? null);
    expect(route.nextActionableGoalId).toBe(route.routeHeadId);
  });

  it('treats missing straight-line oracle endpoints as unreachable while keeping in-place goals free', () => {
    const oracle = makeStraightLineTravelOracle(
      new Map([
        [PLAYER_START_LOCATION, { x: 0, y: 0 }],
        ['known', { x: 12, y: 0 }],
      ]),
      PARAMS.moveSpeedFtPerMs,
    );

    const noEffects = new Set<string>();
    expect(oracle.travelCost(PLAYER_START_LOCATION, 'known', noEffects)).toBeGreaterThan(0);
    expect(oracle.travelCost(PLAYER_START_LOCATION, '__missing__', noEffects)).toBe(Infinity);
    expect(oracle.travelCost('__missing__', '__missing__', noEffects)).toBe(Infinity);
    expect(oracle.travelCost(PLAYER_START_LOCATION, 'known', noEffects)).toBe(
      Math.round(12 / PARAMS.moveSpeedFtPerMs),
    );
    expect(oracle.travelCost(PLAYER_START_LOCATION, IN_PLACE_LOCATION, noEffects)).toBe(0);
  });

  it('drops completed goals from the graph entirely (mirrors "completed state removes nodes")', () => {
    const snap = snapshot({
      shopStage: 'complete',
      bossBattleAccepted: true,
      slimeRatStarted: true,
      slimeRatDefeated: true,
      spellsUnlocked: true,
      bossBattleComplete: true,
    });
    const graph = buildFloor1GoalGraph(snap);
    const ids = graph.goals.map((g) => g.id);
    expect(ids).not.toContain('meet-shopkeeper');
    expect(ids).not.toContain('accept-spell-quest');
    expect(ids).not.toContain('kill-slime-rat');
    // Still pending: the staircase boss and taking the stairs.
    expect(ids).toContain('kill-staircase-boss');
    expect(ids).toContain('take-stairs');
    expect(graph.initialSatisfiedEffects).toEqual(
      new Set([
        'floor1-goon-quest-complete',
        'floor1-shop-quest-complete',
        'floor1-slime-rat-quest-accepted',
        'floor1-slime-rat-room-open',
        '!floor1-boss-battle-active',
        'floor1-boss-battle-complete',
      ]),
    );
  });

  it('plans the enabled merchant weapon as one optional bundle and drops it before required completion', () => {
    const snap = snapshot({
      shopStage: 'complete',
      bossBattleAccepted: true,
      slimeRatStarted: true,
      slimeRatDefeated: true,
      spellsUnlocked: true,
      bossBattleComplete: true,
      staircaseStarted: true,
      staircaseDefeated: true,
      playerGold: 0,
      merchantWeaponIntent: { status: 'farming', cost: 20 },
    });
    const rawGraph = buildFloor1GoalGraph(snap);
    const graph = applyFloor1WorkCosts(rawGraph, snap, PARAMS);
    const oracle = makeStraightLineTravelOracle(graph.locations, PARAMS.moveSpeedFtPerMs);

    const withTime = planObjectiveRoute({
      goals: graph.goals,
      startLocation: PLAYER_START_LOCATION,
      initialSatisfiedEffects: graph.initialSatisfiedEffects,
      budgetMs: 1_000_000,
      travelOracle: oracle,
    });
    expect(withTime.includedOptionalBundleIds).toEqual(['merchant-weapon-purchase']);
    expect(withTime.steps.map((step) => step.goalId)).toEqual([
      'farm-merchant-weapon-gold',
      'buy-merchant-weapon',
      'take-stairs',
    ]);

    const preserveFloorClear = planObjectiveRoute({
      goals: graph.goals,
      startLocation: PLAYER_START_LOCATION,
      initialSatisfiedEffects: graph.initialSatisfiedEffects,
      budgetMs: 1,
      travelOracle: oracle,
    });
    expect(preserveFloorClear.includedOptionalBundleIds).toEqual([]);
    expect(preserveFloorClear.droppedOptionalBundleIds).toEqual(['merchant-weapon-purchase']);
    expect(preserveFloorClear.steps.map((step) => step.goalId)).toEqual(['take-stairs']);
  });

  it('plans the spell broker purchase as one optional bundle when spellsUnlocked and spellBrokerIntent active', () => {
    const snap = snapshot({
      shopStage: 'complete',
      bossBattleAccepted: true,
      slimeRatStarted: true,
      slimeRatDefeated: true,
      spellsUnlocked: true,
      bossBattleComplete: true,
      staircaseStarted: true,
      staircaseDefeated: true,
      playerGold: 0,
      spellBrokerIntent: { status: 'farming', cost: 35 },
    });
    const rawGraph = buildFloor1GoalGraph(snap);
    const graph = applyFloor1WorkCosts(rawGraph, snap, PARAMS);
    const oracle = makeStraightLineTravelOracle(graph.locations, PARAMS.moveSpeedFtPerMs);

    // Ample budget: planner includes the spell broker bundle.
    const withTime = planObjectiveRoute({
      goals: graph.goals,
      startLocation: PLAYER_START_LOCATION,
      initialSatisfiedEffects: graph.initialSatisfiedEffects,
      budgetMs: 1_000_000,
      travelOracle: oracle,
    });
    expect(withTime.includedOptionalBundleIds).toContain('spell-broker-purchase');
    const goalIds = withTime.steps.map((step) => step.goalId);
    expect(goalIds).toContain('farm-spell-broker-gold');
    expect(goalIds).toContain('buy-broker-spell');
    // buy-broker-spell must come after farm-spell-broker-gold
    expect(goalIds.indexOf('buy-broker-spell')).toBeGreaterThan(
      goalIds.indexOf('farm-spell-broker-gold'),
    );

    // Tight budget: planner drops the optional bundle to preserve floor-clear.
    const preserveFloorClear = planObjectiveRoute({
      goals: graph.goals,
      startLocation: PLAYER_START_LOCATION,
      initialSatisfiedEffects: graph.initialSatisfiedEffects,
      budgetMs: 1,
      travelOracle: oracle,
    });
    expect(preserveFloorClear.includedOptionalBundleIds).toEqual([]);
    expect(preserveFloorClear.droppedOptionalBundleIds).toContain('spell-broker-purchase');
    expect(preserveFloorClear.steps.map((step) => step.goalId)).toEqual(['take-stairs']);
  });

  it('omits the spell broker bundle when spellsUnlocked is false (pre-boss-battle)', () => {
    const snap = snapshot({
      spellsUnlocked: false,
      spellBrokerIntent: { status: 'farming', cost: 35 },
    });
    const graph = buildFloor1GoalGraph(snap);
    const ids = graph.goals.map((g) => g.id);
    expect(ids).not.toContain('farm-spell-broker-gold');
    expect(ids).not.toContain('buy-broker-spell');
  });

  it('omits the farm-spell-broker-gold goal when already returning (gold sufficient)', () => {
    const snap = snapshot({
      shopStage: 'complete',
      bossBattleAccepted: true,
      slimeRatStarted: true,
      slimeRatDefeated: true,
      spellsUnlocked: true,
      bossBattleComplete: true,
      staircaseStarted: true,
      staircaseDefeated: true,
      playerGold: 100,
      spellBrokerIntent: { status: 'returning', cost: 35 },
    });
    const rawGraph = buildFloor1GoalGraph(snap);
    const graph = applyFloor1WorkCosts(rawGraph, snap, PARAMS);
    const ids = graph.goals.map((g) => g.id);
    expect(ids).not.toContain('farm-spell-broker-gold');
    expect(ids).toContain('buy-broker-spell');
  });
});
