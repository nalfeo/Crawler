import { describe, expect, it } from 'vitest';
import {
  canFarmOptionalMerchantPurchase,
  estimateFloor1RunPlan,
  type Floor1RunPlannerSnapshot,
  type RunPlannerParams,
} from '../../src/game/ai/run-planner.js';

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
    tutorialAccepted: false,
    playerLevel: 1,
    questCompleted: false,
    ratsKilled: 0,
    slimesKilled: 0,
    requiredRats: 6,
    requiredSlimes: 4,
    requiredTotalKills: 10,
    shopStage: 'not-met',
    playerGold: 0,
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
      welcomeOffice: { x: 10, y: 0 },
      shop: { x: 20, y: 0 },
      questItem: { x: 30, y: 0 },
      spellQuestGiver: { x: 40, y: 0 },
      slimeRatRoom: { x: 50, y: 0 },
      staircase: { x: 60, y: 0 },
    },
    ...overrides,
  };
}

describe('estimateFloor1RunPlan', () => {
  it('gates optional merchant farming against existing slack without adding work to the plan', () => {
    const runPlan = estimateFloor1RunPlan(
      snapshot({
        tutorialAccepted: true,
        playerLevel: 2,
        questCompleted: true,
        shopStage: 'complete',
      }),
      PARAMS,
    );

    expect(canFarmOptionalMerchantPurchase(runPlan, 2, PARAMS.goldFarmMs)).toBe(
      runPlan.slackMs >= 2 * PARAMS.goldFarmMs,
    );
    expect(canFarmOptionalMerchantPurchase({ slackMs: 5_999 }, 2, 3_000)).toBe(false);
    expect(canFarmOptionalMerchantPurchase({ slackMs: 6_000 }, 2, 3_000)).toBe(true);
    expect(canFarmOptionalMerchantPurchase({ slackMs: 6_000 }, 2, 0)).toBe(false);
    expect(canFarmOptionalMerchantPurchase(null, 2, 3_000)).toBe(false);
  });

  it('computes a critical path, required time, slack, and urgency', () => {
    const plan = estimateFloor1RunPlan(snapshot(), PARAMS);

    expect(plan.criticalPathObjective).toBe('Meet Tutorial Goon');
    expect(plan.segments.map((segment) => segment.id)).toContain('complete-goon-kills');
    expect(plan.segments.map((segment) => segment.id)).toContain('kill-staircase-boss');
    expect(plan.estimatedRequiredMs).toBeGreaterThan(PARAMS.safetyBufferMs);
    expect(plan.remainingMs).toBe(600_000);
    expect(plan.slackMs).toBe(plan.remainingMs - plan.estimatedRequiredMs);
    expect(plan.urgency).toBeGreaterThanOrEqual(0);
    expect(plan.urgency).toBeLessThanOrEqual(1);
  });

  it('exposes estimatedTravelMs as the sum of every segment travelMs', () => {
    const plan = estimateFloor1RunPlan(snapshot(), PARAMS);
    const expectedTravel = plan.segments.reduce((sum, segment) => sum + segment.travelMs, 0);
    expect(plan.estimatedTravelMs).toBe(expectedTravel);
    // Sanity check: with distinct positions and non-empty segments the total
    // travel-time budget must be strictly positive.
    expect(plan.estimatedTravelMs).toBeGreaterThan(0);
    // Cleared prerequisites shouldn't leak into travel budget.
    expect(plan.estimatedTravelMs).toBeLessThan(plan.estimatedRequiredMs);
  });

  it('reports zero estimatedTravelMs once every objective is cleared', () => {
    const cleared = estimateFloor1RunPlan(
      snapshot({
        tutorialAccepted: true,
        playerLevel: 2,
        questCompleted: true,
        shopStage: 'complete',
        bossBattleAccepted: true,
        slimeRatStarted: true,
        slimeRatDefeated: true,
        spellsUnlocked: true,
        staircaseStarted: true,
        staircaseDefeated: true,
        staircaseUnlocked: true,
        staircaseDiscovered: true,
      }),
      PARAMS,
    );
    expect(cleared.segments).toHaveLength(0);
    expect(cleared.estimatedTravelMs).toBe(0);
  });

  it('increases urgency as remaining time shrinks for the same remaining work', () => {
    const early = estimateFloor1RunPlan(snapshot({ nowMs: 60_000 }), PARAMS);
    const late = estimateFloor1RunPlan(snapshot({ nowMs: 560_000 }), PARAMS);

    expect(late.remainingMs).toBeLessThan(early.remainingMs);
    expect(late.slackMs).toBeLessThan(early.slackMs);
    expect(late.urgency).toBeGreaterThan(early.urgency);
  });

  it('models a committed quest-giver detour as the current first leg', () => {
    const plan = estimateFloor1RunPlan(
      snapshot({
        activeQuestGiverDetour: true,
        currentTarget: { x: 5, y: 0, eid: 42, reason: 'Detouring to Shopkeeper', kind: 'other' },
      }),
      PARAMS,
    );

    expect(plan.criticalPathObjective).toBe('Detouring to Shopkeeper');
    expect(plan.segments[0]?.id).toBe('current-detour');
    expect(plan.segments[0]?.kind).toBe('detour');
    expect(plan.segments[0]?.criticalChainPhase).toBe('detour');
  });

  it('optimizes the remaining route from the committed detour endpoint', () => {
    const plan = estimateFloor1RunPlan(
      snapshot({
        player: { x: 0, y: 0 },
        activeQuestGiverDetour: true,
        currentTarget: {
          x: 100,
          y: 0,
          eid: 42,
          reason: 'Detouring to Spell Broker',
          kind: 'other',
        },
        tutorialAccepted: true,
        playerLevel: 2,
        questCompleted: true,
        positions: {
          welcomeOffice: { x: 0, y: 0 },
          shop: { x: 0, y: 0 },
          questItem: { x: 10, y: 0 },
          spellQuestGiver: { x: 100, y: 0 },
          slimeRatRoom: { x: 110, y: 0 },
          staircase: { x: 50, y: 0 },
        },
      }),
      PARAMS,
    );

    expect(plan.routeHeadId).toBe('accept-spell-quest');
    expect(plan.segments[1]?.id).toBe('accept-spell-quest');
  });

  it('subtracts committed-detour cost from optional-bundle budget (a bundle that fits pre-detour is dropped)', () => {
    // Scenario: the only remaining required work is taking the stairs (at x=0).
    // There is an optional merchant-weapon purchase bundle with a gold-farm step.
    // Budget is set to JUST accommodate the optional bundle if measured from
    // the player position (x=0), but NOT enough if the detour cost is subtracted.
    //
    // Detour: player is at x=0, detour target is x=200 (travel = 200/0.12 ≈ 1667 ms + 1500 work = ~3167 ms).
    // After the detour, the route starts from x=200 back to the stairs at x=60.
    //
    // We set the budget to just over the straight route (without detour deducted)
    // but less than (route + detour cost), so the planner must drop the bundle.
    const detourTarget = { x: 200, y: 0, eid: null, reason: 'Detour', kind: 'other' as const };
    const detourTravelMs = Math.round(200 / PARAMS.moveSpeedFtPerMs);
    const detourCostMs = detourTravelMs + PARAMS.interactionMs;

    const plan = estimateFloor1RunPlan(
      snapshot({
        tutorialAccepted: true,
        playerLevel: 2,
        questCompleted: true,
        shopStage: 'complete',
        bossBattleAccepted: true,
        slimeRatStarted: true,
        slimeRatDefeated: true,
        spellsUnlocked: true,
        bossBattleComplete: true,
        staircaseStarted: true,
        staircaseDefeated: true,
        player: { x: 0, y: 0 },
        activeQuestGiverDetour: true,
        currentTarget: detourTarget,
        playerGold: 0,
        merchantWeaponIntent: { status: 'farming', cost: 5 },
        positions: {
          welcomeOffice: { x: 0, y: 0 },
          shop: { x: 0, y: 0 },
          questItem: { x: 0, y: 0 },
          spellQuestGiver: { x: 0, y: 0 },
          slimeRatRoom: { x: 0, y: 0 },
          staircase: { x: 0, y: 0 }, // staircase at same point as player
        },
        deadlineMs:
          // Budget: detour cost + safety buffer + a tiny margin that fits only
          // take-stairs but NOT the farm+buy bundle.
          detourCostMs + PARAMS.safetyBufferMs + PARAMS.stairsInteractMs + 1,
      }),
      PARAMS,
    );

    // The optional merchant-weapon bundle must be dropped — budget was consumed by detour.
    expect(plan.droppedOptionalBundleIds).toContain('merchant-weapon-purchase');
  });

  it('detour fulfilling a graph goal is not double-charged and its unlock effects are preserved', () => {
    // Scenario: player is on a committed detour TO the spell quest giver
    // (accept-spell-quest), with committedGoalId = 'accept-spell-quest'.
    // The planner must NOT include accept-spell-quest in the route again, and
    // floor1-slime-rat-quest-accepted must be in the effective initial effects
    // so that kill-slime-rat is reachable without replanning the accept step.
    const plan = estimateFloor1RunPlan(
      snapshot({
        player: { x: 0, y: 0 },
        tutorialAccepted: true,
        playerLevel: 2,
        questCompleted: true,
        shopStage: 'complete',
        bossBattleAccepted: false, // accept not yet done — it IS the committed detour
        activeQuestGiverDetour: true,
        currentTarget: {
          x: 40,
          y: 0,
          eid: null,
          reason: 'Detouring to Spell Broker',
          kind: 'other',
          committedGoalId: 'accept-spell-quest',
        },
        positions: {
          welcomeOffice: { x: 0, y: 0 },
          shop: { x: 0, y: 0 },
          questItem: { x: 0, y: 0 },
          spellQuestGiver: { x: 40, y: 0 },
          slimeRatRoom: { x: 50, y: 0 },
          staircase: { x: 60, y: 0 },
        },
      }),
      PARAMS,
    );

    const segmentIds = plan.segments.map((s) => s.id);

    // accept-spell-quest must NOT appear twice (no double charge).
    expect(segmentIds.filter((id) => id === 'accept-spell-quest')).toHaveLength(0);

    // The route must include the steps that depend on accept-spell-quest's
    // effect (floor1-slime-rat-quest-accepted), proving effects are propagated.
    expect(segmentIds).toContain('kill-slime-rat');
  });

  it('tags every segment with a broad critical-chain phase along the canonical path', () => {
    const plan = estimateFloor1RunPlan(snapshot(), PARAMS);

    // Every segment must carry a phase (no undefined leaks).
    for (const segment of plan.segments) {
      expect(segment.criticalChainPhase).toBeDefined();
    }

    // Canonical id → phase mapping. Chain-scoped consumers rely on this.
    const phaseById = new Map(plan.segments.map((s) => [s.id, s.criticalChainPhase]));
    expect(phaseById.get('meet-tutorial-goon')).toBe('pre-chain');
    expect(phaseById.get('reach-level-2')).toBe('pre-chain');
    expect(phaseById.get('complete-goon-kills')).toBe('pre-chain');
    expect(phaseById.get('meet-shopkeeper')).toBe('shop');
    expect(phaseById.get('fetch-shop-prize')).toBe('shop');
    expect(phaseById.get('return-shop-prize')).toBe('shop');
    expect(phaseById.get('buy-shop-charm')).toBe('shop');
    expect(phaseById.get('equip-shop-charm')).toBe('shop');
    expect(phaseById.get('accept-spell-quest')).toBe('spell-broker');
    expect(phaseById.get('kill-slime-rat')).toBe('spell-broker');
    expect(phaseById.get('kill-staircase-boss')).toBe('staircase');
    expect(phaseById.get('take-stairs')).toBe('post-stairs');
  });

  it('tags active-battle finish segments with their originating phase', () => {
    const plan = estimateFloor1RunPlan(
      snapshot({
        tutorialAccepted: true,
        playerLevel: 2,
        questCompleted: true,
        shopStage: 'complete',
        bossBattleAccepted: true,
        slimeRatStarted: true,
        slimeRatDefeated: false,
        staircaseStarted: true,
        staircaseDefeated: false,
      }),
      PARAMS,
    );
    const phaseById = new Map(plan.segments.map((s) => [s.id, s.criticalChainPhase]));
    expect(phaseById.get('finish-slime-rat')).toBe('spell-broker');
    expect(phaseById.get('finish-staircase-boss')).toBe('staircase');
  });

  it('tags the claim-spell-reward segment as spell-broker phase', () => {
    const plan = estimateFloor1RunPlan(
      snapshot({
        tutorialAccepted: true,
        playerLevel: 2,
        questCompleted: true,
        shopStage: 'complete',
        bossBattleAccepted: true,
        slimeRatStarted: true,
        slimeRatDefeated: true,
        spellsUnlocked: false,
      }),
      PARAMS,
    );
    const claim = plan.segments.find((s) => s.id === 'claim-spell-reward');
    expect(claim?.criticalChainPhase).toBe('spell-broker');
  });

  it('drops completed prerequisites from the estimate', () => {
    const almostDone = estimateFloor1RunPlan(
      snapshot({
        tutorialAccepted: true,
        playerLevel: 2,
        questCompleted: true,
        shopStage: 'complete',
        bossBattleAccepted: true,
        slimeRatStarted: true,
        slimeRatDefeated: true,
        spellsUnlocked: true,
        staircaseStarted: true,
        staircaseDefeated: true,
        staircaseUnlocked: true,
        staircaseDiscovered: true,
      }),
      PARAMS,
    );

    expect(almostDone.criticalPathObjective).toBe('Floor clear');
    expect(almostDone.segments).toHaveLength(0);
    expect(almostDone.estimatedRequiredMs).toBe(PARAMS.safetyBufferMs);
  });

  it('counts downstream merchant steps and decreases as shop stages advance', () => {
    const onlyShopRemaining: Partial<Floor1RunPlannerSnapshot> = {
      tutorialAccepted: true,
      playerLevel: 2,
      questCompleted: true,
      bossBattleAccepted: true,
      slimeRatStarted: true,
      slimeRatDefeated: true,
      spellsUnlocked: true,
      staircaseStarted: true,
      staircaseDefeated: true,
      staircaseUnlocked: true,
      staircaseDiscovered: true,
    };

    const notMet = estimateFloor1RunPlan(snapshot(onlyShopRemaining), PARAMS);
    const awaitingPrize = estimateFloor1RunPlan(
      snapshot({
        ...onlyShopRemaining,
        shopStage: 'awaiting-prize',
        player: { x: 20, y: 0 },
      }),
      PARAMS,
    );
    const readyToBuy = estimateFloor1RunPlan(
      snapshot({
        ...onlyShopRemaining,
        shopStage: 'ready-to-buy',
        player: { x: 20, y: 0 },
        hasShopFetchItem: true,
      }),
      PARAMS,
    );
    const awaitingEquip = estimateFloor1RunPlan(
      snapshot({
        ...onlyShopRemaining,
        shopStage: 'awaiting-equip',
        player: { x: 20, y: 0 },
        playerGold: 10,
        hasShopFetchItem: true,
      }),
      PARAMS,
    );

    expect(notMet.segments.map((segment) => segment.id)).toEqual([
      'meet-shopkeeper',
      'fetch-shop-prize',
      'return-shop-prize',
      'farm-shop-gold',
      'buy-shop-charm',
      'equip-shop-charm',
    ]);
    expect(awaitingPrize.segments.map((segment) => segment.id)).toEqual([
      'fetch-shop-prize',
      'return-shop-prize',
      'farm-shop-gold',
      'buy-shop-charm',
      'equip-shop-charm',
    ]);
    expect(readyToBuy.segments.map((segment) => segment.id)).toEqual([
      'farm-shop-gold',
      'buy-shop-charm',
      'equip-shop-charm',
    ]);
    expect(awaitingEquip.segments.map((segment) => segment.id)).toEqual(['equip-shop-charm']);
    expect(notMet.estimatedRequiredMs).toBeGreaterThan(awaitingPrize.estimatedRequiredMs);
    expect(awaitingPrize.estimatedRequiredMs).toBeGreaterThan(readyToBuy.estimatedRequiredMs);
    expect(readyToBuy.estimatedRequiredMs).toBeGreaterThan(awaitingEquip.estimatedRequiredMs);
  });

  it('uses the total kill requirement even when species minimums are satisfied', () => {
    const plan = estimateFloor1RunPlan(
      snapshot({
        tutorialAccepted: true,
        playerLevel: 2,
        ratsKilled: 1,
        slimesKilled: 1,
        requiredRats: 1,
        requiredSlimes: 1,
        requiredTotalKills: 5,
        shopStage: 'complete',
        bossBattleAccepted: true,
        slimeRatStarted: true,
        slimeRatDefeated: true,
        spellsUnlocked: true,
        staircaseStarted: true,
        staircaseDefeated: true,
        staircaseUnlocked: true,
        staircaseDiscovered: true,
      }),
      PARAMS,
    );

    const killSegment = plan.segments.find((segment) => segment.id === 'complete-goon-kills');
    expect(killSegment?.workMs).toBe(3 * PARAMS.questKillMs);
  });
});
