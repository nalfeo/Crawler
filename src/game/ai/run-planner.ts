/**
 * Pure Floor 1 run planner.
 *
 * The behavior tree remains the source of truth for the current objective. This
 * module only estimates how much time remains on the authoritative Floor 1 quest
 * chain so tactical layers can decide whether optional value is still affordable.
 */

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
  readonly positions: {
    readonly welcomeOffice: RunPlannerPoint;
    readonly shop: RunPlannerPoint;
    readonly questItem: RunPlannerPoint;
    readonly spellQuestGiver: RunPlannerPoint;
    readonly slimeRatRoom: RunPlannerPoint;
    readonly staircase: RunPlannerPoint;
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
  readonly from: RunPlannerPoint;
  readonly to: RunPlannerPoint;
  readonly travelMs: number;
  readonly workMs: number;
  readonly estimatedMs: number;
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

const EPSILON = 1e-6;

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function distance(a: RunPlannerPoint, b: RunPlannerPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function travelTimeMs(
  from: RunPlannerPoint,
  to: RunPlannerPoint,
  params: RunPlannerParams,
): number {
  return distance(from, to) / Math.max(params.moveSpeedFtPerMs, EPSILON);
}

export function estimateFloor1RunPlan(
  snapshot: Floor1RunPlannerSnapshot,
  params: RunPlannerParams,
): Floor1RunPlan {
  const segments: RunPlanSegment[] = [];
  let cursor: RunPlannerPoint = snapshot.player;

  const addSegment = (
    id: string,
    label: string,
    kind: RunPlanSegment['kind'],
    to: RunPlannerPoint,
    workMs: number,
    detail: string,
  ): void => {
    const travelMs = travelTimeMs(cursor, to, params);
    segments.push({
      id,
      label,
      kind,
      from: cursor,
      to,
      travelMs,
      workMs,
      estimatedMs: travelMs + workMs,
      detail,
    });
    cursor = to;
  };

  if (snapshot.activeQuestGiverDetour && snapshot.currentTarget) {
    addSegment(
      'current-detour',
      snapshot.currentTarget.reason,
      'detour',
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
    addSegment(
      'complete-goon-kills',
      'Complete Goon kill quota',
      'work',
      target,
      totalLeft * params.questKillMs,
      `${ratsLeft} rats, ${slimesLeft} slimes, ${totalLeft} total kills remaining`,
    );
  }

  switch (snapshot.shopStage) {
    case 'not-met':
      addSegment(
        'meet-shopkeeper',
        'Meet Shopkeeper',
        'travel',
        snapshot.positions.shop,
        params.interactionMs,
        'Start the merchant errand',
      );
      break;
    case 'awaiting-prize':
      if (!snapshot.hasShopFetchItem) {
        addSegment(
          'fetch-shop-prize',
          'Fetch merchant prize',
          'travel',
          snapshot.positions.questItem,
          params.fetchPickupMs,
          'Collect the merchant fetch item',
        );
      }
      addSegment(
        'return-shop-prize',
        'Return merchant prize',
        'travel',
        snapshot.positions.shop,
        params.interactionMs,
        'Return the merchant fetch item',
      );
      break;
    case 'ready-to-buy': {
      const goldOwed = Math.max(0, snapshot.shopkeeperEquipmentCost - snapshot.playerGold);
      if (goldOwed > 0) {
        const target =
          !snapshot.activeQuestGiverDetour && snapshot.currentTarget?.kind === 'gold-farm'
            ? snapshot.currentTarget
            : cursor;
        addSegment(
          'farm-shop-gold',
          'Farm charm gold',
          'work',
          target,
          goldOwed * params.goldFarmMs,
          `${goldOwed} gold remaining for the merchant charm`,
        );
      }
      addSegment(
        'buy-shop-charm',
        'Buy merchant charm',
        'travel',
        snapshot.positions.shop,
        params.interactionMs,
        'Buy and equip the merchant reward',
      );
      break;
    }
    case 'awaiting-equip':
      addSegment(
        'equip-shop-charm',
        'Equip merchant charm',
        'work',
        cursor,
        params.interactionMs,
        'Equip the purchased merchant reward',
      );
      break;
    case 'complete':
      break;
  }

  if (!snapshot.bossBattleAccepted) {
    addSegment(
      'accept-spell-quest',
      'Accept Spell Broker quest',
      'travel',
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
      snapshot.positions.slimeRatRoom,
      params.minorBossKillMs,
      'Complete the spell-unlock boss battle',
    );
  } else if (!snapshot.slimeRatDefeated) {
    addSegment(
      'finish-slime-rat',
      'Finish Slime Rat',
      'boss',
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
      snapshot.positions.staircase,
      params.finalBossKillMs,
      'Unlock the stairs by defeating the final Floor 1 boss',
    );
  } else if (!snapshot.staircaseDefeated) {
    addSegment(
      'finish-staircase-boss',
      'Finish staircase boss',
      'boss',
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
      snapshot.positions.staircase,
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
