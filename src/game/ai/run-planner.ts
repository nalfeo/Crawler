/**
 * Pure Floor 1 run planner.
 *
 * The behavior tree remains the source of truth for the current objective. This
 * module only estimates how much time remains on the authoritative Floor 1 quest
 * chain so tactical layers can decide whether optional value is still affordable.
 */

import {
  estimateObjectiveTravelLeg,
  getObjectiveTravelEstimate,
  type Floor1ObjectiveNodeId,
  type ObjectiveTravelEstimate,
  type ObjectiveTravelMatrix,
  type ObjectiveTravelSource,
} from './objective-travel-time.js';

export type RunPlannerShopStage =
  | 'not-met'
  | 'awaiting-prize'
  | 'ready-to-buy'
  | 'awaiting-equip'
  | 'complete';

export interface RunPlannerPoint {
  readonly x: number;
  readonly y: number;
}

export type RunPlannerCurrentTargetKind = 'quest-kills' | 'gold-farm' | 'other';

export interface RunPlannerCurrentTarget extends RunPlannerPoint {
  readonly eid: number | null;
  readonly reason: string;
  readonly kind: RunPlannerCurrentTargetKind;
}

export interface Floor1RunPlannerSnapshot {
  readonly nowMs: number;
  readonly deadlineMs: number;
  readonly player: RunPlannerPoint;
  readonly currentTarget: RunPlannerCurrentTarget | null;
  readonly activeQuestGiverDetour: boolean;
  readonly tutorialAccepted: boolean;
  readonly playerLevel: number;
  readonly questCompleted: boolean;
  readonly ratsKilled: number;
  readonly slimesKilled: number;
  readonly requiredRats: number;
  readonly requiredSlimes: number;
  readonly requiredTotalKills: number;
  readonly shopStage: RunPlannerShopStage;
  readonly playerGold: number;
  readonly shopkeeperEquipmentCost: number;
  readonly hasShopFetchItem: boolean;
  readonly bossBattleAccepted: boolean;
  readonly slimeRatStarted: boolean;
  readonly slimeRatDefeated: boolean;
  readonly spellsUnlocked: boolean;
  readonly staircaseStarted: boolean;
  readonly staircaseDefeated: boolean;
  readonly staircaseUnlocked: boolean;
  readonly staircaseDiscovered: boolean;
  readonly objectiveTravel: ObjectiveTravelMatrix<Floor1ObjectiveNodeId> | null;
  readonly positions: {
    readonly welcomeOffice: RunPlannerPoint;
    readonly shop: RunPlannerPoint;
    readonly questItem: RunPlannerPoint;
    readonly spellQuestGiver: RunPlannerPoint;
    readonly slimeRatRoom: RunPlannerPoint;
    readonly staircaseBossRoom: RunPlannerPoint;
    readonly stairsExit: RunPlannerPoint;
  };
}

export interface RunPlannerParams {
  readonly moveSpeedFtPerMs: number;
  readonly safetyBufferMs: number;
  readonly urgencySlackWindowMs: number;
  readonly interactionMs: number;
  readonly level2GrindMs: number;
  readonly questKillMs: number;
  readonly goldFarmMs: number;
  readonly fetchPickupMs: number;
  readonly minorBossKillMs: number;
  readonly finalBossKillMs: number;
  readonly stairsInteractMs: number;
}

export interface RunPlanSegment {
  readonly id: string;
  readonly label: string;
  readonly kind: 'travel' | 'work' | 'boss' | 'detour';
  readonly fromNodeId: Floor1ObjectiveNodeId | null;
  readonly toNodeId: Floor1ObjectiveNodeId | null;
  readonly from: RunPlannerPoint;
  readonly to: RunPlannerPoint;
  readonly distanceFt: number;
  readonly travelMs: number;
  readonly workMs: number;
  readonly estimatedMs: number;
  readonly reachable: boolean;
  readonly travelSource: ObjectiveTravelSource;
  readonly detail: string;
}

export interface Floor1RunPlan {
  readonly criticalPathObjective: string;
  readonly remainingMs: number;
  readonly estimatedRequiredMs: number;
  readonly safetyBufferMs: number;
  readonly slackMs: number;
  readonly urgency: number;
  readonly segments: readonly RunPlanSegment[];
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function straightLineTravelEstimate(
  fromId: Floor1ObjectiveNodeId | null,
  toId: Floor1ObjectiveNodeId | null,
  from: RunPlannerPoint,
  to: RunPlannerPoint,
  params: RunPlannerParams,
): ObjectiveTravelEstimate<Floor1ObjectiveNodeId> {
  return estimateObjectiveTravelLeg(
    { id: fromId ?? 'current-target', point: from },
    { id: toId ?? 'current-target', point: to },
    { moveSpeedFtPerMs: params.moveSpeedFtPerMs },
  );
}

export function estimateFloor1RunPlan(
  snapshot: Floor1RunPlannerSnapshot,
  params: RunPlannerParams,
): Floor1RunPlan {
  const segments: RunPlanSegment[] = [];
  let cursor: RunPlannerPoint = snapshot.player;
  let cursorNodeId: Floor1ObjectiveNodeId = 'player';

  const addSegment = (
    id: string,
    label: string,
    kind: RunPlanSegment['kind'],
    toNodeId: Floor1ObjectiveNodeId,
    to: RunPlannerPoint,
    workMs: number,
    detail: string,
  ): void => {
    const travelEstimate =
      snapshot.objectiveTravel !== null
        ? (getObjectiveTravelEstimate(snapshot.objectiveTravel, cursorNodeId, toNodeId) ??
          straightLineTravelEstimate(cursorNodeId, toNodeId, cursor, to, params))
        : straightLineTravelEstimate(cursorNodeId, toNodeId, cursor, to, params);
    const travelMs = travelEstimate.travelMs;
    segments.push({
      id,
      label,
      kind,
      fromNodeId: cursorNodeId,
      toNodeId,
      from: cursor,
      to,
      distanceFt: travelEstimate.distanceFt,
      travelMs,
      workMs,
      estimatedMs: travelMs + workMs,
      reachable: travelEstimate.reachable,
      travelSource: travelEstimate.source,
      detail,
    });
    cursor = to;
    cursorNodeId = toNodeId;
  };

  if (snapshot.activeQuestGiverDetour && snapshot.currentTarget) {
    addSegment(
      'current-detour',
      snapshot.currentTarget.reason,
      'detour',
      'current-target',
      snapshot.currentTarget,
      params.interactionMs,
      'Committed quest-giver detour before resuming the critical path',
    );
  }

  if (!snapshot.tutorialAccepted) {
    addSegment(
      'meet-tutorial-goon',
      'Meet Tutorial Goon',
      'travel',
      'welcome-office',
      snapshot.positions.welcomeOffice,
      params.interactionMs,
      'Accept the opening Floor 1 quest and unlock drops',
    );
  }

  if (snapshot.playerLevel < 2) {
    addSegment(
      'reach-level-2',
      'Reach level 2',
      'work',
      cursorNodeId,
      cursor,
      params.level2GrindMs,
      'Farm ambient XP until merchant and spell quests unlock',
    );
  }

  if (!snapshot.questCompleted) {
    const ratsLeft = Math.max(0, snapshot.requiredRats - snapshot.ratsKilled);
    const slimesLeft = Math.max(0, snapshot.requiredSlimes - snapshot.slimesKilled);
    const totalLeft = Math.max(
      0,
      snapshot.requiredTotalKills - (snapshot.ratsKilled + snapshot.slimesKilled),
      ratsLeft + slimesLeft,
    );
    const target =
      !snapshot.activeQuestGiverDetour && snapshot.currentTarget?.kind === 'quest-kills'
        ? snapshot.currentTarget
        : cursor;
    const targetNodeId =
      !snapshot.activeQuestGiverDetour && snapshot.currentTarget?.kind === 'quest-kills'
        ? 'current-target'
        : cursorNodeId;
    addSegment(
      'complete-goon-kills',
      'Complete Goon kill quota',
      'work',
      targetNodeId,
      target,
      totalLeft * params.questKillMs,
      `${ratsLeft} rats, ${slimesLeft} slimes, ${totalLeft} total kills remaining`,
    );
  }

  const addShopFetchAndReturnSegments = (): void => {
    if (!snapshot.hasShopFetchItem) {
      addSegment(
        'fetch-shop-prize',
        'Fetch merchant prize',
        'travel',
        'merchant-fetch',
        snapshot.positions.questItem,
        params.fetchPickupMs,
        'Collect the merchant fetch item',
      );
    }
    addSegment(
      'return-shop-prize',
      'Return merchant prize',
      'travel',
      'shopkeeper',
      snapshot.positions.shop,
      params.interactionMs,
      'Return the merchant fetch item',
    );
  };

  const addShopBuySegment = (): void => {
    const goldOwed = Math.max(0, snapshot.shopkeeperEquipmentCost - snapshot.playerGold);
    if (goldOwed > 0) {
      const target =
        !snapshot.activeQuestGiverDetour && snapshot.currentTarget?.kind === 'gold-farm'
          ? snapshot.currentTarget
          : cursor;
      const targetNodeId =
        !snapshot.activeQuestGiverDetour && snapshot.currentTarget?.kind === 'gold-farm'
          ? 'current-target'
          : cursorNodeId;
      addSegment(
        'farm-shop-gold',
        'Farm charm gold',
        'work',
        targetNodeId,
        target,
        goldOwed * params.goldFarmMs,
        `${goldOwed} gold remaining for the merchant charm`,
      );
    }
    addSegment(
      'buy-shop-charm',
      'Buy merchant charm',
      'travel',
      'shopkeeper',
      snapshot.positions.shop,
      params.interactionMs,
      'Buy the merchant reward',
    );
  };

  const addShopEquipSegment = (): void => {
    addSegment(
      'equip-shop-charm',
      'Equip merchant charm',
      'work',
      cursorNodeId,
      cursor,
      params.interactionMs,
      'Equip the purchased merchant reward',
    );
  };

  switch (snapshot.shopStage) {
    case 'not-met':
      addSegment(
        'meet-shopkeeper',
        'Meet Shopkeeper',
        'travel',
        'shopkeeper',
        snapshot.positions.shop,
        params.interactionMs,
        'Start the merchant errand',
      );
      addShopFetchAndReturnSegments();
      addShopBuySegment();
      addShopEquipSegment();
      break;
    case 'awaiting-prize':
      addShopFetchAndReturnSegments();
      addShopBuySegment();
      addShopEquipSegment();
      break;
    case 'ready-to-buy':
      addShopBuySegment();
      addShopEquipSegment();
      break;
    case 'awaiting-equip':
      addShopEquipSegment();
      break;
    case 'complete':
      break;
  }

  if (!snapshot.bossBattleAccepted) {
    addSegment(
      'accept-spell-quest',
      'Accept Spell Broker quest',
      'travel',
      'spell-broker',
      snapshot.positions.spellQuestGiver,
      params.interactionMs,
      'Unlock the Slime Rat room objective',
    );
  }

  if (!snapshot.slimeRatStarted) {
    addSegment(
      'kill-slime-rat',
      'Reach and kill Slime Rat',
      'boss',
      'slime-rat-room',
      snapshot.positions.slimeRatRoom,
      params.minorBossKillMs,
      'Complete the spell-unlock boss battle',
    );
  } else if (!snapshot.slimeRatDefeated) {
    addSegment(
      'finish-slime-rat',
      'Finish Slime Rat',
      'boss',
      cursorNodeId,
      cursor,
      params.minorBossKillMs,
      'Finish the active spell-unlock boss battle',
    );
  }

  if (snapshot.slimeRatDefeated && !snapshot.spellsUnlocked) {
    addSegment(
      'claim-spell-reward',
      'Claim spell reward',
      'travel',
      'spell-broker',
      snapshot.positions.spellQuestGiver,
      params.interactionMs,
      'Claim the spell reward before the final boss',
    );
  }

  if (!snapshot.staircaseStarted) {
    addSegment(
      'kill-staircase-boss',
      'Reach and kill staircase boss',
      'boss',
      'staircase-boss-room',
      snapshot.positions.staircaseBossRoom,
      params.finalBossKillMs,
      'Unlock the stairs by defeating the final Floor 1 boss',
    );
  } else if (!snapshot.staircaseDefeated) {
    addSegment(
      'finish-staircase-boss',
      'Finish staircase boss',
      'boss',
      cursorNodeId,
      cursor,
      params.finalBossKillMs,
      'Finish the active final boss battle',
    );
  }

  if (!snapshot.staircaseDiscovered) {
    addSegment(
      'take-stairs',
      'Take the stairs',
      'travel',
      'stairs-exit',
      snapshot.positions.stairsExit,
      params.stairsInteractMs,
      snapshot.staircaseUnlocked
        ? 'Descend the unlocked stairs'
        : 'Descend once the boss unlocks the stairs',
    );
  }

  const estimatedBeforeBuffer = segments.reduce((sum, segment) => sum + segment.estimatedMs, 0);
  const estimatedRequiredMs = estimatedBeforeBuffer + params.safetyBufferMs;
  const remainingMs = Math.max(0, snapshot.deadlineMs - snapshot.nowMs);
  const slackMs = remainingMs - estimatedRequiredMs;
  const urgency = clamp01(1 - slackMs / Math.max(params.urgencySlackWindowMs, 1));

  return {
    criticalPathObjective: segments[0]?.label ?? 'Floor clear',
    remainingMs,
    estimatedRequiredMs,
    safetyBufferMs: params.safetyBufferMs,
    slackMs,
    urgency,
    segments,
  };
}
