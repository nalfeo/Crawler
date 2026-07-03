import { describe, expect, it } from 'vitest';
import {
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
