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
 * Critical-path phase a segment belongs to.
 *
 * The AI uses these tags to reason about *sub-critical-path* budgets — e.g.
 * how much time the Spell Broker → Slime Rat → return-reward chain still has
 * before it eats into the mandatory post-chain work (final boss + stairs).
 *
 * Kept simple on purpose: this is a deterministic classification the planner
 * assigns as it emits segments; downstream layers should not have to re-scan
 * segment ids to figure out which phase they belong to.
 */
export type RunPlanCriticalChain =
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
  readonly criticalChainPhase: RunPlanCriticalChain;
  readonly from: RunPlannerPoint;
  readonly to: RunPlannerPoint;
  readonly travelMs: number;
  readonly workMs: number;
  readonly estimatedMs: number;
  readonly detail: string;
}

/**
 * Chain-scoped time budget for the Spell Broker / Slime Rat critical-path
 * chain (accept Spell Broker quest → reach + kill Slime Rat → claim spell
 * reward → then the mandatory staircase boss + stairs descent).
 *
 * Why include the post-chain work in `remainingRequiredMs`: the chain's
 * "affordability" is not just its own segments — if the AI burns 30s of
 * optional detour before the chain, that 30s also has to fit alongside the
 * final boss + stairs. So the useful slack signal for chain-timing decisions
 * is `remainingMs - (chain + staircase + post-stairs + safetyBuffer)`.
 *
 * `onCriticalPath` is true when the first pending segment is a chain
 * segment (no pre-chain work left). That is the moment the tactical layer
 * must start treating chain urgency as the dominant signal instead of the
 * global-plan urgency.
 */
export interface RunPlanChainStatus {
  readonly requiredMs: number;
  readonly remainingRequiredMs: number;
  readonly slackMs: number;
  readonly urgency: number;
  readonly onCriticalPath: boolean;
  readonly complete: boolean;
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
  readonly spellBrokerChain: RunPlanChainStatus;
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
    criticalChainPhase: RunPlanCriticalChain,
    to: RunPlannerPoint,
    workMs: number,
    detail: string,
  ): void => {
    const travelMs = travelTimeMs(cursor, to, params);
    segments.push({
      id,
      label,
      kind,
      criticalChainPhase,
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
      'other',
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

  const spellBrokerChain = computeSpellBrokerChainStatus(segments, snapshot, {
    remainingMs,
    safetyBufferMs: params.safetyBufferMs,
    urgencySlackWindowMs: params.urgencySlackWindowMs,
  });

  return {
    criticalPathObjective: segments[0]?.label ?? 'Floor clear',
    remainingMs,
    estimatedRequiredMs,
    estimatedTravelMs,
    safetyBufferMs: params.safetyBufferMs,
    slackMs,
    urgency,
    segments,
    spellBrokerChain,
  };
}

/**
 * Signals-only view of the run plan used for chain-timing decisions. The chain
 * budget accounts for the mandatory post-chain segments (final boss, stairs)
 * so the AI treats "chain slack" as "budget left for chain + everything after
 * it, given what's already committed / done."
 */
function computeSpellBrokerChainStatus(
  segments: readonly RunPlanSegment[],
  snapshot: Floor1RunPlannerSnapshot,
  budget: {
    readonly remainingMs: number;
    readonly safetyBufferMs: number;
    readonly urgencySlackWindowMs: number;
  },
): RunPlanChainStatus {
  const chainSegments = segments.filter((seg) => seg.criticalChainPhase === 'spell-broker');
  const requiredMs = chainSegments.reduce((sum, seg) => sum + seg.estimatedMs, 0);

  // "Remaining required" = chain + mandatory post-chain work + safety buffer.
  // If the chain is already complete this collapses to just post-chain work.
  const postChainMs = segments
    .filter(
      (seg) => seg.criticalChainPhase === 'staircase' || seg.criticalChainPhase === 'post-stairs',
    )
    .reduce((sum, seg) => sum + seg.estimatedMs, 0);
  const remainingRequiredMs = requiredMs + postChainMs + budget.safetyBufferMs;
  const slackMs = budget.remainingMs - remainingRequiredMs;
  const urgency = clamp01(1 - slackMs / Math.max(budget.urgencySlackWindowMs, 1));

  // The chain is on the critical path once the first pending segment is a
  // chain segment: no pre-chain (tutorial / level-2 / kill quota) and no shop
  // work remains. A committed quest-giver detour still counts as pre-chain
  // (from the AI's perspective, it must resolve that first), so we treat any
  // 'other' segment ahead of a chain segment as blocking too.
  //
  // NOTE: this means if the AI commits to a quest-giver detour AFTER the chain
  // is already on the critical path, `onCriticalPath` flips back to false and
  // both the tactical `chainBeeline` and the `chainSuppressionOverride` in
  // findProgressObjective silently disarm until the detour clears. That is
  // intentional — the detour is a bounded, deterministic side-trip and the
  // panic system is meant to fire only when the chain is truly next-up — but
  // it does mean the chain-scoped panic can be paused mid-flight by a live
  // detour commitment. Rearming happens automatically as soon as
  // `committedDetourNpcEid` clears (typically within a few frames).
  const firstBlocking = segments.find(
    (seg) =>
      seg.criticalChainPhase !== 'spell-broker' &&
      seg.criticalChainPhase !== 'staircase' &&
      seg.criticalChainPhase !== 'post-stairs',
  );
  const firstChainIdx = segments.findIndex((seg) => seg.criticalChainPhase === 'spell-broker');
  const onCriticalPath = firstChainIdx >= 0 && !firstBlocking;

  const complete =
    snapshot.bossBattleAccepted && snapshot.slimeRatDefeated && snapshot.spellsUnlocked;

  return {
    requiredMs,
    remainingRequiredMs,
    slackMs,
    urgency,
    onCriticalPath,
    complete,
  };
}
