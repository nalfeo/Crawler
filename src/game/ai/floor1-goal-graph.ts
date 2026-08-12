/**
 * Declarative Floor 1 goal graph.
 *
 * Translates a {@link Floor1RunPlannerSnapshot} into the generic
 * {@link GoalNode} graph consumed by `planObjectiveRoute` (see
 * `objective-route-planner.ts`). This is where Floor-1-specific knowledge
 * (quest ids, NPC errand shapes, the shop/spell-broker chains, the staircase
 * boss gate) lives — the planner itself has none.
 *
 * True dependency shape (verified against the real door-lock configuration in
 * `floorScenario.ts`, not just historical source order): the boss-stair room
 * door requires ALL THREE of the kill-quota quest, the FULL shop errand
 * (meet → fetch → return → buy → equip), and the FULL spell-broker chain
 * (accept → defeat Slime Rat → claim spellbook). The shop chain and the
 * spell-broker chain are otherwise-independent siblings — nothing in the real
 * game requires one to finish before the other starts. Modeling them as
 * siblings (rather than the historical fixed source order that forced the
 * whole shop errand to finish before the spell-broker chain could begin) is
 * exactly what lets the generic planner interleave same-neighborhood visits
 * instead of forcing two separate west↔east round trips.
 *
 * Pure: takes a snapshot, returns data. No world/ECS imports (kept out of
 * `src/core` entirely; this lives in `src/game/ai` alongside the rest of the
 * deterministic runtime AI).
 */

import {
  IN_PLACE_LOCATION,
  type GoalId,
  type GoalNode,
  type LocationId,
  type TravelOracle,
} from './objective-route-planner.js';
import type {
  Floor1RunPlannerSnapshot,
  RunPlannerParams,
  RunPlannerPoint,
  RunPlanSegment,
  RunPlanSegmentPhase,
} from './run-planner.js';

/** Stable location id for the player's current position at plan time. */
export const PLAYER_START_LOCATION: LocationId = '__player_start__';

export interface Floor1GoalMeta {
  readonly label: string;
  readonly kind: RunPlanSegment['kind'];
  readonly phase: RunPlanSegmentPhase;
  readonly detail: string;
}

export interface Floor1GoalGraph {
  readonly goals: readonly GoalNode[];
  readonly locations: ReadonlyMap<LocationId, RunPlannerPoint>;
  readonly meta: ReadonlyMap<GoalId, Floor1GoalMeta>;
  /** Door/feature effects already satisfied by goals completed before this
   * snapshot. Pending goals contribute their effects through GoalNode. */
  readonly initialSatisfiedEffects: ReadonlySet<string>;
}

const EPSILON = 1e-6;

/**
 * Build the Floor 1 goal graph for the current snapshot. Only goals that are
 * NOT yet complete are included (mirrors "completed state satisfies/removes
 * nodes" — a done goal simply disappears from the graph next frame).
 */
export function buildFloor1GoalGraph(snapshot: Floor1RunPlannerSnapshot): Floor1GoalGraph {
  const goals: GoalNode[] = [];
  const meta = new Map<GoalId, Floor1GoalMeta>();
  const initialSatisfiedEffects = new Set<string>();
  if (snapshot.questCompleted) initialSatisfiedEffects.add('floor1-goon-quest-complete');
  if (snapshot.shopStage === 'complete') initialSatisfiedEffects.add('floor1-shop-quest-complete');
  if (snapshot.bossBattleAccepted || snapshot.slimeRatStarted) {
    initialSatisfiedEffects.add('floor1-slime-rat-quest-accepted');
  }
  if (snapshot.slimeRatDefeated) {
    // Slime Rat defeated: room door can be exited and the active-battle flag
    // is cleared.  `floor1-boss-battle-complete` is NOT added here — that gate
    // requires the spellbook claim (`claim-spell-reward`) as well.
    initialSatisfiedEffects.add('floor1-slime-rat-room-open');
    initialSatisfiedEffects.add('!floor1-boss-battle-active');
  }
  if (snapshot.bossBattleComplete) initialSatisfiedEffects.add('floor1-boss-battle-complete');
  if (snapshot.staircaseDefeated) {
    initialSatisfiedEffects.add('floor1-defeat-boss');
    initialSatisfiedEffects.add('!floor1-boss-active');
  }
  const locations = new Map<LocationId, RunPlannerPoint>([
    [
      PLAYER_START_LOCATION,
      snapshot.activeQuestGiverDetour && snapshot.currentTarget
        ? snapshot.currentTarget
        : snapshot.player,
    ],
    ['welcomeOffice', snapshot.positions.welcomeOffice],
    ['shop', snapshot.positions.shop],
    ['questItem', snapshot.positions.questItem],
    ['spellQuestGiver', snapshot.positions.spellQuestGiver],
    ['slimeRatRoom', snapshot.positions.slimeRatRoom],
    ['staircase', snapshot.positions.staircase],
  ]);

  const add = (goal: GoalNode, metaEntry: Floor1GoalMeta): void => {
    goals.push(goal);
    meta.set(goal.id, metaEntry);
  };

  // --- Pre-chain: tutorial -> level 2 -> kill quota (strictly sequential,
  // exactly as before — these are not independently orderable). ------------
  let preChainTail: GoalId[] = [];

  if (!snapshot.tutorialAccepted) {
    add(
      {
        id: 'meet-tutorial-goon',
        location: 'welcomeOffice',
        workCost: 0,
        prerequisiteIds: [],
        required: true,
      },
      {
        label: 'Meet Tutorial Goon',
        kind: 'travel',
        phase: 'pre-chain',
        detail: 'Accept the opening Floor 1 quest and unlock drops',
      },
    );
    preChainTail = ['meet-tutorial-goon'];
  }

  if (snapshot.playerLevel < 2) {
    add(
      {
        id: 'reach-level-2',
        location: IN_PLACE_LOCATION,
        workCost: 0,
        prerequisiteIds: preChainTail,
        required: true,
      },
      {
        label: 'Reach level 2',
        kind: 'work',
        phase: 'pre-chain',
        detail: 'Farm ambient XP until merchant and spell quests unlock',
      },
    );
    preChainTail = ['reach-level-2'];
  }

  if (!snapshot.questCompleted) {
    const ratsLeft = Math.max(0, snapshot.requiredRats - snapshot.ratsKilled);
    const slimesLeft = Math.max(0, snapshot.requiredSlimes - snapshot.slimesKilled);
    const totalLeft = Math.max(
      0,
      snapshot.requiredTotalKills - (snapshot.ratsKilled + snapshot.slimesKilled),
      ratsLeft + slimesLeft,
    );
    add(
      {
        id: 'complete-goon-kills',
        location: IN_PLACE_LOCATION,
        workCost: 0,
        prerequisiteIds: preChainTail,
        required: true,
        unlockEffects: ['floor1-goon-quest-complete'],
      },
      {
        label: 'Complete Goon kill quota',
        kind: 'work',
        phase: 'pre-chain',
        detail: `${ratsLeft} rats, ${slimesLeft} slimes, ${totalLeft} total kills remaining`,
      },
    );
    preChainTail = ['complete-goon-kills'];
  }

  // Anchor that the shop chain and the spell-broker chain both wait on: the
  // last pre-chain node still pending, or none if the pre-chain is clear.
  const preChainAnchor = preChainTail;

  // --- Shop chain (sequential within itself; independent of spell chain). -
  let shopTail: GoalId[] = preChainAnchor;

  const addShopFetchAndReturn = (): void => {
    if (!snapshot.hasShopFetchItem) {
      add(
        {
          id: 'fetch-shop-prize',
          location: 'questItem',
          workCost: 0,
          prerequisiteIds: shopTail,
          required: true,
        },
        {
          label: 'Fetch merchant prize',
          kind: 'travel',
          phase: 'shop',
          detail: 'Collect the merchant fetch item',
        },
      );
      shopTail = ['fetch-shop-prize'];
    }
    add(
      {
        id: 'return-shop-prize',
        location: 'shop',
        workCost: 0,
        prerequisiteIds: shopTail,
        required: true,
      },
      {
        label: 'Return merchant prize',
        kind: 'travel',
        phase: 'shop',
        detail: 'Return the merchant fetch item',
      },
    );
    shopTail = ['return-shop-prize'];
  };

  const addShopBuy = (): void => {
    const goldOwed = Math.max(0, snapshot.shopkeeperEquipmentCost - snapshot.playerGold);
    if (goldOwed > 0) {
      add(
        {
          id: 'farm-shop-gold',
          location: IN_PLACE_LOCATION,
          workCost: 0,
          prerequisiteIds: shopTail,
          required: true,
        },
        {
          label: 'Farm charm gold',
          kind: 'work',
          phase: 'shop',
          detail: `${goldOwed} gold remaining for the merchant charm`,
        },
      );
      shopTail = ['farm-shop-gold'];
    }
    add(
      {
        id: 'buy-shop-charm',
        location: 'shop',
        workCost: 0,
        prerequisiteIds: shopTail,
        required: true,
      },
      {
        label: 'Buy merchant charm',
        kind: 'travel',
        phase: 'shop',
        detail: 'Buy the merchant reward',
      },
    );
    shopTail = ['buy-shop-charm'];
  };

  const addShopEquip = (): void => {
    add(
      {
        id: 'equip-shop-charm',
        location: IN_PLACE_LOCATION,
        workCost: 0,
        prerequisiteIds: shopTail,
        required: true,
        // Completing the shop errand sets `floor1-shop-quest-complete`,
        // which is one of the THREE goal-flag conditions the real
        // boss-stair-room door requires (see floorScenario.ts's
        // `setDoorLockConfig` for `bossStairRoom`). Without this tag the
        // strict travel oracle has no way to know the staircase door will
        // open once the shop errand finishes, and treats it as permanently
        // unreachable — see the unlock-aware planner review ledger.
        unlockEffects: ['floor1-shop-quest-complete'],
      },
      {
        label: 'Equip merchant charm',
        kind: 'work',
        phase: 'shop',
        detail: 'Equip the purchased merchant reward',
      },
    );
    shopTail = ['equip-shop-charm'];
  };

  switch (snapshot.shopStage) {
    case 'not-met':
      add(
        {
          id: 'meet-shopkeeper',
          location: 'shop',
          workCost: 0,
          prerequisiteIds: shopTail,
          required: true,
        },
        {
          label: 'Meet Shopkeeper',
          kind: 'travel',
          phase: 'shop',
          detail: 'Start the merchant errand',
        },
      );
      shopTail = ['meet-shopkeeper'];
      addShopFetchAndReturn();
      addShopBuy();
      addShopEquip();
      break;
    case 'awaiting-prize':
      addShopFetchAndReturn();
      addShopBuy();
      addShopEquip();
      break;
    case 'ready-to-buy':
      addShopBuy();
      addShopEquip();
      break;
    case 'awaiting-equip':
      addShopEquip();
      break;
    case 'complete':
      break;
  }
  const shopChainTail = shopTail === preChainAnchor ? [] : shopTail;

  // --- Optional post-quest merchant weapon bundle. ----------------------
  // The intent system decides whether the seeded run wants this detour; once
  // active, the generic route planner decides whether the complete farm+buy
  // bundle fits and where it belongs among every required objective.
  const merchantWeaponIntent = snapshot.merchantWeaponIntent;
  if (
    snapshot.shopStage === 'complete' &&
    (merchantWeaponIntent?.status === 'farming' || merchantWeaponIntent?.status === 'returning')
  ) {
    let merchantWeaponTail: GoalId[] = [];
    const weaponGoldOwed = Math.max(0, merchantWeaponIntent.cost - snapshot.playerGold);
    if (merchantWeaponIntent.status === 'farming' && weaponGoldOwed > 0) {
      add(
        {
          id: 'farm-merchant-weapon-gold',
          location: IN_PLACE_LOCATION,
          workCost: 0,
          prerequisiteIds: [],
          required: false,
          optionalBundleId: 'merchant-weapon-purchase',
        },
        {
          label: 'Farm merchant weapon gold',
          kind: 'detour',
          phase: 'detour',
          detail: `${weaponGoldOwed} gold remaining for the selected merchant weapon`,
        },
      );
      merchantWeaponTail = ['farm-merchant-weapon-gold'];
    }
    add(
      {
        id: 'buy-merchant-weapon',
        location: 'shop',
        workCost: 0,
        prerequisiteIds: merchantWeaponTail,
        required: false,
        optionalBundleId: 'merchant-weapon-purchase',
      },
      {
        label: 'Buy selected merchant weapon',
        kind: 'detour',
        phase: 'detour',
        detail: 'Return to the Shopkeeper and buy the selected optional weapon',
      },
    );
  }

  // --- Optional post-spellbook spell broker purchase bundle. -------------
  // When the 25% seeded spell intent is active and spells are unlocked (after
  // the boss battle + spellbook claim), add a farm+buy detour back to the
  // Spell Quest Giver (the broker). The generic route planner decides whether
  // it fits the remaining time budget.
  const spellBrokerIntent = snapshot.spellBrokerIntent;
  if (
    snapshot.spellsUnlocked &&
    (spellBrokerIntent?.status === 'farming' || spellBrokerIntent?.status === 'returning')
  ) {
    let spellBrokerTail: GoalId[] = [];
    const spellGoldOwed = Math.max(0, spellBrokerIntent.cost - snapshot.playerGold);
    if (spellBrokerIntent.status === 'farming' && spellGoldOwed > 0) {
      add(
        {
          id: 'farm-spell-broker-gold',
          location: IN_PLACE_LOCATION,
          workCost: 0,
          prerequisiteIds: [],
          required: false,
          optionalBundleId: 'spell-broker-purchase',
        },
        {
          label: 'Farm spell broker gold',
          kind: 'detour',
          phase: 'detour',
          detail: `${spellGoldOwed} gold remaining to buy a spell from the broker`,
        },
      );
      spellBrokerTail = ['farm-spell-broker-gold'];
    }
    add(
      {
        id: 'buy-broker-spell',
        location: 'spellQuestGiver',
        workCost: 0,
        prerequisiteIds: spellBrokerTail,
        required: false,
        optionalBundleId: 'spell-broker-purchase',
      },
      {
        label: 'Buy spell from broker',
        kind: 'detour',
        phase: 'detour',
        detail: 'Return to the Spell Broker and purchase the offered spell',
      },
    );
  }

  // --- Spell-broker chain (sequential within itself; independent of shop). -
  let spellTail: GoalId[] = preChainAnchor;

  if (!snapshot.bossBattleAccepted) {
    add(
      {
        id: 'accept-spell-quest',
        location: 'spellQuestGiver',
        workCost: 0,
        prerequisiteIds: spellTail,
        required: true,
        unlockEffects: ['floor1-slime-rat-quest-accepted'],
      },
      {
        label: 'Accept Spell Broker quest',
        kind: 'travel',
        phase: 'spell-broker',
        detail: 'Unlock the Slime Rat room objective',
      },
    );
    spellTail = ['accept-spell-quest'];
  }

  if (!snapshot.slimeRatStarted) {
    add(
      {
        id: 'kill-slime-rat',
        location: 'slimeRatRoom',
        workCost: 0,
        prerequisiteIds: spellTail,
        required: true,
        // Defeating the Slime Rat: clears the active-battle relock flag and
        // makes the room exit passable (`floor1-slime-rat-room-open`).
        // `floor1-boss-battle-complete` is intentionally NOT emitted here —
        // that gate also requires the spellbook claim (`claim-spell-reward`).
        unlockEffects: ['floor1-slime-rat-room-open', '!floor1-boss-battle-active'],
      },
      {
        label: 'Reach and kill Slime Rat',
        kind: 'boss',
        phase: 'spell-broker',
        detail: 'Complete the spell-unlock boss battle',
      },
    );
    spellTail = ['kill-slime-rat'];
  } else if (!snapshot.slimeRatDefeated) {
    add(
      {
        id: 'finish-slime-rat',
        location: IN_PLACE_LOCATION,
        workCost: 0,
        prerequisiteIds: spellTail,
        required: true,
        // Same semantics as kill-slime-rat: defeat clears the battle-active
        // flag and opens the room exit; spellbook claim is still required for
        // `floor1-boss-battle-complete`.
        unlockEffects: ['floor1-slime-rat-room-open', '!floor1-boss-battle-active'],
      },
      {
        label: 'Finish Slime Rat',
        kind: 'boss',
        phase: 'spell-broker',
        detail: 'Finish the active spell-unlock boss battle',
      },
    );
    spellTail = ['finish-slime-rat'];
  }

  if (!snapshot.spellsUnlocked) {
    // Included whenever spells aren't unlocked yet — NOT only once the Slime
    // Rat happens to already be defeated. Its prerequisiteIds correctly chain
    // from whatever slime-rat step is present (kill/finish-slime-rat, or
    // accept-spell-quest if not even started), so the DP will never schedule
    // it before its true prerequisite is satisfiable. This must be
    // unconditional so `kill-staircase-boss` (below) always depends on the
    // real `floor1-boss-battle-complete` gate (kill-slime-rat AND
    // claim-spellbook) rather than silently regressing to "just kill the
    // Slime Rat" whenever this frame's snapshot predates the kill.
    add(
      {
        id: 'claim-spell-reward',
        location: 'spellQuestGiver',
        workCost: 0,
        prerequisiteIds: spellTail,
        required: true,
        unlockEffects: ['floor1-boss-battle-complete'],
      },
      {
        label: 'Claim spell reward',
        kind: 'travel',
        phase: 'spell-broker',
        detail: 'Claim the spell reward before the final boss',
      },
    );
    spellTail = ['claim-spell-reward'];
  }
  const spellChainTail = spellTail === preChainAnchor ? [] : spellTail;

  // --- Staircase: real door-lock gate requires BOTH chains complete. ------
  const staircaseGate = [...shopChainTail, ...spellChainTail];

  if (!snapshot.staircaseStarted) {
    add(
      {
        id: 'kill-staircase-boss',
        location: 'staircase',
        workCost: 0,
        prerequisiteIds: staircaseGate,
        required: true,
        unlockEffects: ['floor1-defeat-boss', '!floor1-boss-active'],
      },
      {
        label: 'Reach and kill staircase boss',
        kind: 'boss',
        phase: 'staircase',
        detail: 'Unlock the stairs by defeating the final Floor 1 boss',
      },
    );
  } else if (!snapshot.staircaseDefeated) {
    add(
      {
        id: 'finish-staircase-boss',
        location: IN_PLACE_LOCATION,
        workCost: 0,
        prerequisiteIds: staircaseGate,
        required: true,
        unlockEffects: ['floor1-defeat-boss', '!floor1-boss-active'],
      },
      {
        label: 'Finish staircase boss',
        kind: 'boss',
        phase: 'staircase',
        detail: 'Finish the active final boss battle',
      },
    );
  }

  if (!snapshot.staircaseDiscovered) {
    const stairsPrereq = !snapshot.staircaseStarted
      ? ['kill-staircase-boss']
      : !snapshot.staircaseDefeated
        ? ['finish-staircase-boss']
        : staircaseGate;
    add(
      {
        id: 'take-stairs',
        location: 'staircase',
        workCost: 0,
        prerequisiteIds: stairsPrereq,
        required: true,
      },
      {
        label: 'Take the stairs',
        kind: 'travel',
        phase: 'post-stairs',
        detail: snapshot.staircaseUnlocked
          ? 'Descend the unlocked stairs'
          : 'Descend once the boss unlocks the stairs',
      },
    );
  }

  return { goals, locations, meta, initialSatisfiedEffects };
}

/**
 * Fill in each goal's `workCost` from {@link RunPlannerParams}. Kept as a
 * separate pass (rather than threading params through `buildFloor1GoalGraph`)
 * so the graph shape itself only depends on the snapshot, while durations are
 * an explicit, easily-testable second step.
 */
export function applyFloor1WorkCosts(
  graph: Floor1GoalGraph,
  snapshot: Floor1RunPlannerSnapshot,
  params: RunPlannerParams,
): Floor1GoalGraph {
  const ratsLeft = Math.max(0, snapshot.requiredRats - snapshot.ratsKilled);
  const slimesLeft = Math.max(0, snapshot.requiredSlimes - snapshot.slimesKilled);
  const totalLeft = Math.max(
    0,
    snapshot.requiredTotalKills - (snapshot.ratsKilled + snapshot.slimesKilled),
    ratsLeft + slimesLeft,
  );
  const goldOwed = Math.max(0, snapshot.shopkeeperEquipmentCost - snapshot.playerGold);
  const merchantWeaponGoldOwed = Math.max(
    0,
    (snapshot.merchantWeaponIntent?.cost ?? 0) - snapshot.playerGold,
  );
  const spellBrokerGoldOwed = Math.max(
    0,
    (snapshot.spellBrokerIntent?.cost ?? 0) - snapshot.playerGold,
  );

  const workCostById: Record<string, number> = {
    'meet-tutorial-goon': params.interactionMs,
    'reach-level-2': params.level2GrindMs,
    'complete-goon-kills': totalLeft * params.questKillMs,
    'meet-shopkeeper': params.interactionMs,
    'fetch-shop-prize': params.fetchPickupMs,
    'return-shop-prize': params.interactionMs,
    'farm-shop-gold': goldOwed * params.goldFarmMs,
    'buy-shop-charm': params.interactionMs,
    'equip-shop-charm': params.interactionMs,
    'farm-merchant-weapon-gold': merchantWeaponGoldOwed * params.goldFarmMs,
    'buy-merchant-weapon': params.interactionMs,
    'farm-spell-broker-gold': spellBrokerGoldOwed * params.goldFarmMs,
    'buy-broker-spell': params.interactionMs,
    'accept-spell-quest': params.interactionMs,
    'kill-slime-rat': params.minorBossKillMs,
    'finish-slime-rat': params.minorBossKillMs,
    'claim-spell-reward': params.interactionMs,
    'kill-staircase-boss': params.finalBossKillMs,
    'finish-staircase-boss': params.finalBossKillMs,
    'take-stairs': params.stairsInteractMs,
  };

  const goals = graph.goals.map((goal) => ({
    ...goal,
    workCost: Math.round(workCostById[goal.id] ?? goal.workCost),
  }));
  return { ...graph, goals };
}

/** Straight-line ("perfect geometric knowledge, no doors") travel oracle used
 * by the pure ETA/slack estimator. NOT used for the runtime navigation
 * decision — see `floor1-travel-oracle.ts` for the strict, door-aware A*
 * oracle real movement decisions must use. Always finite for any two known
 * locations (there is no notion of "unreachable" without a real floor map),
 * which is exactly why this mode must never be used where strict
 * unreachability matters. */
export function makeStraightLineTravelOracle(
  locations: ReadonlyMap<LocationId, RunPlannerPoint>,
  moveSpeedFtPerMs: number,
): TravelOracle {
  const speed = Math.max(moveSpeedFtPerMs, EPSILON);
  return {
    travelCost(from, to) {
      if (to === IN_PLACE_LOCATION) return 0;
      const a = locations.get(to);
      const b = locations.get(from);
      if (!a || !b) return Infinity;
      const distanceFt = Math.hypot(a.x - b.x, a.y - b.y);
      return Math.round(distanceFt / speed);
    },
  };
}
