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

/**
 * Broad phase of the Floor 1 critical chain a {@link RunPlanSegment} belongs
 * to. Chain-scoped panic / prioritization consumers can filter or bucket the
 * remaining plan by phase without having to parse per-segment stable ids —
 * `id` remains available for finer-grained decisions. Phases are ordered
 * roughly along the critical path (`pre-chain → shop → spell-broker →
 * staircase → post-stairs`); `detour` is off-chain optional work that
 * chain-scoped consumers should typically exclude from chain totals. `other`
 * is reserved for future segment kinds that don't yet map to a canonical
 * phase; the current planner never emits it.
 */
export type RunPlanSegmentPhase =
  | 'detour'
  | 'pre-chain'
  | 'shop'
  | 'spell-broker'
  | 'staircase'
  | 'post-stairs'
  | 'other';

export interface RunPlanSegment {
  readonly id: string;
  readonly label: string;
  readonly kind: 'travel' | 'work' | 'boss' | 'detour';
  /**
   * Broad critical-chain phase this segment belongs to. See
   * {@link RunPlanSegmentPhase}. Data-only — behavior is unchanged; downstream
   * consumers may use it to compute chain-scoped remaining-time / slack.
   */
  readonly criticalChainPhase: RunPlanSegmentPhase;
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
  /**
   * Sum of {@link RunPlanSegment.travelMs} across every remaining segment. This
   * is the AI's deterministic straight-line travel-time budget between the
   * player and every remaining Floor 1 objective node — the perfect-world-
   * knowledge chain-travel figure that time-based panic/priority layers feed
   * on top of the raw deadline. Per-segment travel remains accessible on
   * {@link RunPlanSegment.travelMs} for chain-scoped consumers.
   */
  readonly estimatedTravelMs: number;
  readonly safetyBufferMs: number;
  readonly slackMs: number;
  readonly urgency: number;
  readonly segments: readonly RunPlanSegment[];
}

/**
 * Pure predicate: is this run plan time-pressured enough to trip the
 * SLACK_AWARE monotone Track A filters? True when the plan's normalized
 * {@link Floor1RunPlan.urgency} is at/above `urgencyThreshold`, OR slack has
 * already gone negative ({@link Floor1RunPlan.slackMs} `< 0`). A `null` plan
 * (no floor scenario / decision mode not computing one) is never urgent.
 *
 * Extracted as a pure function so the gate can be unit-tested in isolation and
 * shared by any consumer; keeps `bt-ai-provider` free of inline threshold math.
 */
export function isRunPlanUrgent(
  plan: Pick<Floor1RunPlan, 'urgency' | 'slackMs'> | null,
  urgencyThreshold: number,
): boolean {
  if (!plan) {
    return false;
  }

  return plan.urgency >= urgencyThreshold || plan.slackMs < 0;
}

export function canFarmOptionalMerchantPurchase(
  plan: Pick<Floor1RunPlan, 'slackMs'> | null,
  goldDeficit: number,
  goldFarmMs: number,
): boolean {
  if (!plan || goldDeficit <= 0 || goldFarmMs <= 0) {
    return false;
  }
  return plan.slackMs >= goldDeficit * goldFarmMs;
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
    phase: RunPlanSegmentPhase,
    to: RunPlannerPoint,
    workMs: number,
    detail: string,
  ): void => {
    const travelMs = travelTimeMs(cursor, to, params);
    segments.push({
      id,
      label,
      kind,
      criticalChainPhase: phase,
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
      'pre-chain',
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
      'pre-chain',
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
      'pre-chain',
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
        'shop',
        snapshot.positions.questItem,
        params.fetchPickupMs,
        'Collect the merchant fetch item',
      );
    }
    addSegment(
      'return-shop-prize',
      'Return merchant prize',
      'travel',
      'shop',
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
      addSegment(
        'farm-shop-gold',
        'Farm charm gold',
        'work',
        'shop',
        target,
        goldOwed * params.goldFarmMs,
        `${goldOwed} gold remaining for the merchant charm`,
      );
    }
    addSegment(
      'buy-shop-charm',
      'Buy merchant charm',
      'travel',
      'shop',
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
      'shop',
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
        'shop',
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
      'spell-broker',
      snapshot.positions.slimeRatRoom,
      params.minorBossKillMs,
      'Complete the spell-unlock boss battle',
    );
  } else if (!snapshot.slimeRatDefeated) {
    addSegment(
      'finish-slime-rat',
      'Finish Slime Rat',
      'boss',
      'spell-broker',
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
      'staircase',
      snapshot.positions.staircase,
      params.finalBossKillMs,
      'Unlock the stairs by defeating the final Floor 1 boss',
    );
  } else if (!snapshot.staircaseDefeated) {
    addSegment(
      'finish-staircase-boss',
      'Finish staircase boss',
      'boss',
      'staircase',
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
      'post-stairs',
      snapshot.positions.staircase,
      params.stairsInteractMs,
      snapshot.staircaseUnlocked
        ? 'Descend the unlocked stairs'
        : 'Descend once the boss unlocks the stairs',
    );
  }

  const estimatedBeforeBuffer = segments.reduce((sum, segment) => sum + segment.estimatedMs, 0);
  const estimatedTravelMs = segments.reduce((sum, segment) => sum + segment.travelMs, 0);
  const estimatedRequiredMs = estimatedBeforeBuffer + params.safetyBufferMs;
  const remainingMs = Math.max(0, snapshot.deadlineMs - snapshot.nowMs);
  const slackMs = remainingMs - estimatedRequiredMs;
  const urgency = clamp01(1 - slackMs / Math.max(params.urgencySlackWindowMs, 1));

  return {
    criticalPathObjective: segments[0]?.label ?? 'Floor clear',
    remainingMs,
    estimatedRequiredMs,
    estimatedTravelMs,
    safetyBufferMs: params.safetyBufferMs,
    slackMs,
    urgency,
    segments,
  };
}
