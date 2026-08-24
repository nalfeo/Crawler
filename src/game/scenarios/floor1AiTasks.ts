/**
 * Scenario-owned Floor 1 AI task overlay.
 *
 * This is the single source of truth for Floor 1 AI *progression policy*: which
 * tasks exist, how they order, what they unlock, how long they take, whether
 * they are required, and which generic navigation operation performs each one.
 * The generic interpreter in `src/game/ai/scenario-ai-tasks.ts` and the BT
 * dispatcher in `bt-ai-provider.ts` consume this config without knowing any of
 * the task ids below — moving a task, adding a prerequisite, or changing a door
 * effect is a config edit here, not an AI-code edit.
 *
 * The overlay is keyed to the canonical authored quest source
 * (`src/shared/data/quests.floor1.json`, compiled to QuestDefs); it does not
 * duplicate the quest chain. `questRef` links each task to the canonical
 * quest/objective it derives from (validated at load), while pure runtime steps
 * (gold farming, the level-2 grind, optional purchases) carry `questRef: null`.
 *
 * Determinism: every predicate/detail/cost is a pure function of the snapshot +
 * planner params. No clocks, no RNG, no mutation.
 */

import { AINpcInteractionAction } from '../ai/types.js';
import { IN_PLACE_LOCATION, type LocationId } from '../ai/objective-route-planner.js';
import {
  type ScenarioAiTaskConfig,
  type ScenarioQuestLookup,
  validateScenarioAiTaskConfig,
} from '../ai/scenario-ai-tasks.js';
import type {
  Floor1RunPlannerSnapshot,
  RunPlannerParams,
  RunPlannerPoint,
} from '../ai/run-planner.js';
import {
  getQuestDef,
  UNPAID_SHOPKEEPER_STAGES,
  type ShopkeeperStage,
} from '../../shared/quest-types.js';

/** Stable location id for the player's current position at plan time. */
export const PLAYER_START_LOCATION: LocationId = '__player_start__';

type Floor1Task = ScenarioAiTaskConfig<Floor1RunPlannerSnapshot, RunPlannerParams>['tasks'][number];

/** Shop stages in which the shop errand still has pending AI work. */
const SHOP_PENDING_MEET: readonly ShopkeeperStage[] = ['not-met'];
const SHOP_PENDING_FETCH: readonly ShopkeeperStage[] = ['not-met', 'awaiting-prize'];
const SHOP_PENDING_BUY: readonly ShopkeeperStage[] = ['not-met', 'awaiting-prize', 'ready-to-buy'];

/**
 * Gold the run may put toward an **optional** purchase (merchant weapon, broker
 * spell) — everything except the still-unpaid required shopkeeper charm. Keeps
 * the planner's affordability view identical to the executor's reserve so the
 * graph never emits a `buy-*` detour the purchase code then refuses to fund.
 */
function optionalPurchaseGold(snapshot: Floor1RunPlannerSnapshot): number {
  const reserved = UNPAID_SHOPKEEPER_STAGES.has(snapshot.shopStage)
    ? snapshot.shopkeeperEquipmentCost
    : 0;
  return Math.max(0, snapshot.playerGold - reserved);
}

function shopGoldOwed(snapshot: Floor1RunPlannerSnapshot): number {
  return Math.max(0, snapshot.shopkeeperEquipmentCost - snapshot.playerGold);
}

function questKillsRemaining(snapshot: Floor1RunPlannerSnapshot): {
  ratsLeft: number;
  slimesLeft: number;
  totalLeft: number;
} {
  const ratsLeft = Math.max(0, snapshot.requiredRats - snapshot.ratsKilled);
  const slimesLeft = Math.max(0, snapshot.requiredSlimes - snapshot.slimesKilled);
  const totalLeft = Math.max(
    0,
    snapshot.requiredTotalKills - (snapshot.ratsKilled + snapshot.slimesKilled),
    ratsLeft + slimesLeft,
  );
  return { ratsLeft, slimesLeft, totalLeft };
}

const merchantWeaponGoldOwed = (snapshot: Floor1RunPlannerSnapshot): number =>
  Math.max(0, (snapshot.merchantWeaponIntent?.cost ?? 0) - optionalPurchaseGold(snapshot));

const spellBrokerGoldOwed = (snapshot: Floor1RunPlannerSnapshot): number =>
  Math.max(0, (snapshot.spellBrokerIntent?.cost ?? 0) - optionalPurchaseGold(snapshot));

// -----------------------------------------------------------------------------
// Tasks — declared in historical emission order for deterministic graph output.
// -----------------------------------------------------------------------------

const TASKS: readonly Floor1Task[] = [
  // --- Pre-chain: tutorial -> level 2 -> kill quota (strictly sequential). ---
  {
    id: 'meet-tutorial-goon',
    chainId: 'pre-chain',
    present: (s) => !s.tutorialAccepted,
    required: true,
    meta: { label: 'Meet Tutorial Goon', kind: 'travel', phase: 'pre-chain' },
    detail: () => 'Accept the opening Floor 1 quest and unlock drops',
    workCost: (_s, p) => p.interactionMs,
    location: () => 'welcomeOffice',
    // Pre-chain steps never reach the middle-chain operation dispatcher (that
    // snapshot forces the pre-chain complete); the operation is ambient.
    operation: { kind: 'ambient' },
    questRef: { questId: 'floor1-tutorial' },
    reverseInteractionAction: AINpcInteractionAction.ACCEPT_TUTORIAL_QUEST,
  },
  {
    id: 'reach-level-2',
    chainId: 'pre-chain',
    present: (s) => s.playerLevel < 2,
    required: true,
    meta: { label: 'Reach level 2', kind: 'work', phase: 'pre-chain' },
    detail: () => 'Farm ambient XP until merchant and spell quests unlock',
    workCost: (_s, p) => p.level2GrindMs,
    location: () => IN_PLACE_LOCATION,
    operation: { kind: 'ambient' },
    questRef: null,
  },
  {
    id: 'complete-goon-kills',
    chainId: 'pre-chain',
    present: (s) => !s.questCompleted,
    satisfiedInitially: (s) => s.questCompleted,
    required: true,
    unlockEffects: ['floor1-goon-quest-complete'],
    meta: { label: 'Complete Goon kill quota', kind: 'work', phase: 'pre-chain' },
    detail: (s) => {
      const { ratsLeft, slimesLeft, totalLeft } = questKillsRemaining(s);
      return `${ratsLeft} rats, ${slimesLeft} slimes, ${totalLeft} total kills remaining`;
    },
    workCost: (s, p) => questKillsRemaining(s).totalLeft * p.questKillMs,
    location: () => IN_PLACE_LOCATION,
    operation: { kind: 'ambient' },
    questRef: { questId: 'floor1-tutorial' },
  },

  // --- Shop chain (sequential within itself; independent of spell chain). ---
  {
    id: 'meet-shopkeeper',
    chainId: 'shop',
    present: (s) => SHOP_PENDING_MEET.includes(s.shopStage),
    required: true,
    meta: { label: 'Meet Shopkeeper', kind: 'travel', phase: 'shop' },
    detail: () => 'Start the merchant errand',
    workCost: (_s, p) => p.interactionMs,
    location: () => 'shop',
    operation: {
      kind: 'interact_npc',
      npc: 'shopkeeper',
      action: AINpcInteractionAction.MEET_SHOPKEEPER,
      reason: 'Seeking Shopkeeper to start the merchant errand',
      phaseTag: 'shop',
    },
    questRef: { questId: 'floor1-shopkeeper-errand' },
    reverseInteractionAction: AINpcInteractionAction.MEET_SHOPKEEPER,
  },
  {
    id: 'fetch-shop-prize',
    chainId: 'shop',
    present: (s) => SHOP_PENDING_FETCH.includes(s.shopStage) && !s.hasShopFetchItem,
    required: true,
    meta: { label: 'Fetch merchant prize', kind: 'travel', phase: 'shop' },
    detail: () => 'Collect the merchant fetch item',
    workCost: (_s, p) => p.fetchPickupMs,
    location: () => 'questItem',
    operation: {
      kind: 'move_to',
      location: 'questItem',
      reason: 'Seeking the merchant fetch item',
      phaseTag: 'shop',
    },
    questRef: { questId: 'floor1-shopkeeper-errand' },
  },
  {
    id: 'return-shop-prize',
    chainId: 'shop',
    present: (s) => SHOP_PENDING_FETCH.includes(s.shopStage),
    required: true,
    meta: { label: 'Return merchant prize', kind: 'travel', phase: 'shop' },
    detail: () => 'Return the merchant fetch item',
    workCost: (_s, p) => p.interactionMs,
    location: () => 'shop',
    operation: {
      kind: 'interact_npc',
      npc: 'shopkeeper',
      action: AINpcInteractionAction.RETURN_SHOPKEEPER_PRIZE,
      reason: 'Returning the merchant prize',
      phaseTag: 'shop',
    },
    questRef: { questId: 'floor1-shopkeeper-errand' },
    reverseInteractionAction: AINpcInteractionAction.RETURN_SHOPKEEPER_PRIZE,
  },
  {
    id: 'farm-shop-gold',
    chainId: 'shop',
    present: (s) => SHOP_PENDING_BUY.includes(s.shopStage) && shopGoldOwed(s) > 0,
    required: true,
    meta: { label: 'Farm charm gold', kind: 'work', phase: 'shop' },
    detail: (s) => `${shopGoldOwed(s)} gold remaining for the merchant charm`,
    workCost: (s, p) => shopGoldOwed(s) * p.goldFarmMs,
    location: () => IN_PLACE_LOCATION,
    operation: { kind: 'farm', strategy: 'shop-charm', label: 'merchant charm' },
    questRef: { questId: 'floor1-shopkeeper-errand' },
  },
  {
    id: 'buy-shop-charm',
    chainId: 'shop',
    present: (s) => SHOP_PENDING_BUY.includes(s.shopStage),
    required: true,
    meta: { label: 'Buy merchant charm', kind: 'travel', phase: 'shop' },
    detail: () => 'Buy the merchant reward',
    workCost: (_s, p) => p.interactionMs,
    location: () => 'shop',
    operation: {
      kind: 'interact_npc',
      npc: 'shopkeeper',
      action: AINpcInteractionAction.BUY_SHOPKEEPER_EQUIPMENT,
      reason: 'Returning to the Shopkeeper to buy the charm',
      phaseTag: 'shop',
    },
    questRef: { questId: 'floor1-shopkeeper-errand' },
    reverseInteractionAction: AINpcInteractionAction.BUY_SHOPKEEPER_EQUIPMENT,
  },
  {
    id: 'equip-shop-charm',
    chainId: 'shop',
    present: (s) => s.shopStage !== 'complete',
    satisfiedInitially: (s) => s.shopStage === 'complete',
    required: true,
    // Completing the shop errand sets `floor1-shop-quest-complete`, one of the
    // THREE goal-flag conditions the real boss-stair-room door requires.
    unlockEffects: ['floor1-shop-quest-complete'],
    meta: { label: 'Equip merchant charm', kind: 'work', phase: 'shop' },
    detail: () => 'Equip the purchased merchant reward',
    workCost: (_s, p) => p.interactionMs,
    location: () => IN_PLACE_LOCATION,
    // Handled ambiently/automatically — no navigation target.
    operation: { kind: 'ambient' },
    questRef: {
      questId: 'floor1-meet-npcs',
      objectiveId: 'complete-merchant-errand',
    },
  },

  // --- Optional post-quest merchant weapon bundle. ---
  {
    id: 'farm-merchant-weapon-gold',
    chainId: 'merchant-weapon',
    present: (s) =>
      s.shopStage === 'complete' &&
      s.merchantWeaponIntent?.status === 'farming' &&
      merchantWeaponGoldOwed(s) > 0,
    required: false,
    optionalBundleId: 'merchant-weapon-purchase',
    meta: { label: 'Farm merchant weapon gold', kind: 'detour', phase: 'detour' },
    detail: (s) => `${merchantWeaponGoldOwed(s)} gold remaining for the selected merchant weapon`,
    workCost: (s, p) => merchantWeaponGoldOwed(s) * p.goldFarmMs,
    location: () => IN_PLACE_LOCATION,
    operation: { kind: 'farm', strategy: 'merchant-weapon', label: 'merchant weapon' },
    questRef: null,
  },
  {
    id: 'buy-merchant-weapon',
    chainId: 'merchant-weapon',
    present: (s) =>
      s.shopStage === 'complete' &&
      (s.merchantWeaponIntent?.status === 'farming' ||
        s.merchantWeaponIntent?.status === 'returning'),
    required: false,
    optionalBundleId: 'merchant-weapon-purchase',
    meta: { label: 'Buy selected merchant weapon', kind: 'detour', phase: 'detour' },
    detail: () => 'Return to the Shopkeeper and buy the selected optional weapon',
    workCost: (_s, p) => p.interactionMs,
    location: () => 'shop',
    operation: {
      kind: 'move_to',
      location: 'shop',
      npc: 'shopkeeper',
      reason: 'Returning to the Shopkeeper to buy the selected weapon',
      phaseTag: 'shop',
    },
    questRef: null,
  },

  // --- Optional post-spellbook spell broker purchase bundle. ---
  {
    id: 'farm-spell-broker-gold',
    chainId: 'spell-broker-purchase',
    present: (s) =>
      s.spellsUnlocked && s.spellBrokerIntent?.status === 'farming' && spellBrokerGoldOwed(s) > 0,
    required: false,
    optionalBundleId: 'spell-broker-purchase',
    meta: { label: 'Farm spell broker gold', kind: 'detour', phase: 'detour' },
    detail: (s) => `${spellBrokerGoldOwed(s)} gold remaining to buy a spell from the broker`,
    workCost: (s, p) => spellBrokerGoldOwed(s) * p.goldFarmMs,
    location: () => IN_PLACE_LOCATION,
    operation: { kind: 'farm', strategy: 'spell-broker', label: 'spell broker' },
    questRef: null,
  },
  {
    id: 'buy-broker-spell',
    chainId: 'spell-broker-purchase',
    present: (s) =>
      s.spellsUnlocked &&
      (s.spellBrokerIntent?.status === 'farming' || s.spellBrokerIntent?.status === 'returning'),
    required: false,
    optionalBundleId: 'spell-broker-purchase',
    meta: { label: 'Buy spell from broker', kind: 'detour', phase: 'detour' },
    detail: () => 'Return to the Spell Broker and purchase the offered spell',
    workCost: (_s, p) => p.interactionMs,
    location: () => 'spellQuestGiver',
    operation: {
      kind: 'move_to',
      location: 'spellQuestGiver',
      npc: 'spellQuestGiver',
      reason: 'Returning to the Spell Broker to purchase the offered spell',
      phaseTag: 'spell-broker',
    },
    questRef: null,
  },

  // --- Spell-broker chain (sequential within itself; independent of shop). ---
  {
    id: 'accept-spell-quest',
    chainId: 'spell',
    present: (s) => !s.bossBattleAccepted,
    satisfiedInitially: (s) => s.bossBattleAccepted || s.slimeRatStarted,
    required: true,
    unlockEffects: ['floor1-slime-rat-quest-accepted'],
    meta: { label: 'Accept Spell Broker quest', kind: 'travel', phase: 'spell-broker' },
    detail: () => 'Unlock the Slime Rat room objective',
    workCost: (_s, p) => p.interactionMs,
    location: () => 'spellQuestGiver',
    operation: {
      kind: 'interact_npc',
      npc: 'spellQuestGiver',
      action: AINpcInteractionAction.ACCEPT_SPELL_QUEST,
      reason: 'Seeking the Spell Broker to start the Slime Rat quest',
      phaseTag: 'spell-broker',
    },
    questRef: { questId: 'floor1-boss-battle' },
    reverseInteractionAction: AINpcInteractionAction.ACCEPT_SPELL_QUEST,
  },
  {
    id: 'kill-slime-rat',
    chainId: 'spell',
    present: (s) => !s.slimeRatStarted,
    satisfiedInitially: (s) => s.slimeRatDefeated,
    required: true,
    // Defeating the Slime Rat clears the active-battle relock flag and opens
    // the room exit; the spellbook claim is still required for the boss gate.
    unlockEffects: ['floor1-slime-rat-room-open', '!floor1-boss-battle-active'],
    meta: { label: 'Reach and kill Slime Rat', kind: 'boss', phase: 'spell-broker' },
    detail: () => 'Complete the spell-unlock boss battle',
    workCost: (_s, p) => p.minorBossKillMs,
    location: () => 'slimeRatRoom',
    operation: {
      kind: 'move_to',
      location: 'slimeRatRoom',
      reason: 'Heading to the Slime Rat room',
      phaseTag: 'spell-broker',
    },
    questRef: { questId: 'floor1-boss-battle', objectiveId: 'kill-slime-rat' },
  },
  {
    id: 'finish-slime-rat',
    chainId: 'spell',
    present: (s) => s.slimeRatStarted && !s.slimeRatDefeated,
    satisfiedInitially: (s) => s.slimeRatDefeated,
    required: true,
    unlockEffects: ['floor1-slime-rat-room-open', '!floor1-boss-battle-active'],
    meta: { label: 'Finish Slime Rat', kind: 'boss', phase: 'spell-broker' },
    detail: () => 'Finish the active spell-unlock boss battle',
    workCost: (_s, p) => p.minorBossKillMs,
    location: () => IN_PLACE_LOCATION,
    // Active battle — let Engage/Hunt fight it.
    operation: { kind: 'ambient' },
    questRef: { questId: 'floor1-boss-battle', objectiveId: 'kill-slime-rat' },
  },
  {
    id: 'claim-spell-reward',
    chainId: 'spell',
    present: (s) => !s.spellsUnlocked,
    satisfiedInitially: (s) => s.bossBattleComplete,
    required: true,
    unlockEffects: ['floor1-boss-battle-complete'],
    meta: { label: 'Claim spell reward', kind: 'travel', phase: 'spell-broker' },
    detail: () => 'Claim the spell reward before the final boss',
    workCost: (_s, p) => p.interactionMs,
    location: () => 'spellQuestGiver',
    operation: {
      kind: 'interact_npc',
      npc: 'spellQuestGiver',
      action: AINpcInteractionAction.CLAIM_SPELL_REWARD,
      reason: 'Returning to the Spell Broker to claim a spell reward',
      phaseTag: 'spell-broker',
    },
    questRef: { questId: 'floor1-boss-battle', objectiveId: 'claim-spellbook' },
    reverseInteractionAction: AINpcInteractionAction.CLAIM_SPELL_REWARD,
  },

  // --- Staircase: real door-lock gate requires BOTH chains complete. ---
  {
    id: 'kill-staircase-boss',
    chainId: 'staircase',
    present: (s) => !s.staircaseStarted,
    satisfiedInitially: (s) => s.staircaseDefeated,
    required: true,
    unlockEffects: ['floor1-defeat-boss', '!floor1-boss-active'],
    meta: { label: 'Reach and kill staircase boss', kind: 'boss', phase: 'staircase' },
    detail: () => 'Unlock the stairs by defeating the final Floor 1 boss',
    workCost: (_s, p) => p.finalBossKillMs,
    location: () => 'staircase',
    operation: {
      kind: 'move_to',
      location: 'staircase',
      reason: 'Heading to the staircase boss room',
      phaseTag: 'staircase',
    },
    questRef: { questId: 'floor1-leave-floor', objectiveId: 'defeat-rat-slime' },
  },
  {
    id: 'finish-staircase-boss',
    chainId: 'staircase',
    present: (s) => s.staircaseStarted && !s.staircaseDefeated,
    satisfiedInitially: (s) => s.staircaseDefeated,
    required: true,
    unlockEffects: ['floor1-defeat-boss', '!floor1-boss-active'],
    meta: { label: 'Finish staircase boss', kind: 'boss', phase: 'staircase' },
    detail: () => 'Finish the active final boss battle',
    workCost: (_s, p) => p.finalBossKillMs,
    location: () => IN_PLACE_LOCATION,
    // Active battle — let Engage/Hunt fight it.
    operation: { kind: 'ambient' },
    questRef: { questId: 'floor1-leave-floor', objectiveId: 'defeat-rat-slime' },
  },
  {
    id: 'take-stairs',
    chainId: 'staircase',
    present: (s) => !s.staircaseDiscovered,
    required: true,
    meta: { label: 'Take the stairs', kind: 'travel', phase: 'post-stairs' },
    detail: (s) =>
      s.staircaseUnlocked
        ? 'Descend the unlocked stairs'
        : 'Descend once the boss unlocks the stairs',
    workCost: (_s, p) => p.stairsInteractMs,
    location: () => 'staircase',
    operation: {
      kind: 'move_to',
      location: 'staircase',
      reason: 'Heading to the stairs to clear the floor',
      phaseTag: 'post-stairs',
    },
    questRef: { questId: 'floor1-leave-floor', objectiveId: 'take-stairs' },
  },
];

/**
 * Build the Floor 1 location→point map. Mirrors the historical geometry: the
 * player-start point follows a committed quest-giver detour target when one is
 * active, otherwise the live player position.
 */
function buildFloor1Locations(
  snapshot: Floor1RunPlannerSnapshot,
): ReadonlyMap<LocationId, RunPlannerPoint> {
  return new Map<LocationId, RunPlannerPoint>([
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
}

/** The validated Floor 1 AI task overlay consumed by the generic interpreter. */
export const FLOOR1_AI_TASK_CONFIG: ScenarioAiTaskConfig<
  Floor1RunPlannerSnapshot,
  RunPlannerParams
> = {
  scenarioId: 'floor1',
  tasks: TASKS,
  chains: [
    {
      id: 'pre-chain',
      taskIds: ['meet-tutorial-goon', 'reach-level-2', 'complete-goon-kills'],
      anchorChainIds: [],
    },
    {
      id: 'shop',
      taskIds: [
        'meet-shopkeeper',
        'fetch-shop-prize',
        'return-shop-prize',
        'farm-shop-gold',
        'buy-shop-charm',
        'equip-shop-charm',
      ],
      anchorChainIds: ['pre-chain'],
    },
    {
      id: 'merchant-weapon',
      taskIds: ['farm-merchant-weapon-gold', 'buy-merchant-weapon'],
      anchorChainIds: [],
    },
    {
      id: 'spell-broker-purchase',
      taskIds: ['farm-spell-broker-gold', 'buy-broker-spell'],
      anchorChainIds: [],
    },
    {
      id: 'spell',
      taskIds: ['accept-spell-quest', 'kill-slime-rat', 'finish-slime-rat', 'claim-spell-reward'],
      anchorChainIds: ['pre-chain'],
    },
    {
      id: 'staircase',
      taskIds: ['kill-staircase-boss', 'finish-staircase-boss', 'take-stairs'],
      anchorChainIds: ['shop', 'spell'],
    },
  ],
  locationIds: [
    'welcomeOffice',
    'shop',
    'questItem',
    'spellQuestGiver',
    'slimeRatRoom',
    'staircase',
  ],
  npcIds: ['shopkeeper', 'spellQuestGiver'],
  phaseTagVocabulary: ['shop', 'spell-broker', 'staircase', 'post-stairs'],
  interactionActionVocabulary: Object.values(AINpcInteractionAction),
  farmStrategyVocabulary: ['shop-charm', 'merchant-weapon', 'spell-broker'],
  unlockEffectVocabulary: [
    'floor1-goon-quest-complete',
    'floor1-shop-quest-complete',
    'floor1-slime-rat-quest-accepted',
    'floor1-slime-rat-room-open',
    '!floor1-boss-battle-active',
    'floor1-boss-battle-complete',
    'floor1-defeat-boss',
    '!floor1-boss-active',
  ],
  buildLocations: buildFloor1Locations,
};

/** Quest lookup backed by the compiled canonical quest registry. */
const FLOOR1_QUEST_LOOKUP: ScenarioQuestLookup = {
  hasQuest: (questId) => getQuestDef(questId) !== undefined,
  hasObjective: (questId, objectiveId) =>
    getQuestDef(questId)?.objectives.some((objective) => objective.id === objectiveId) ?? false,
};

// Fail loudly at module load if the overlay is structurally invalid or drifts
// from the canonical quest source.
validateScenarioAiTaskConfig(FLOOR1_AI_TASK_CONFIG, FLOOR1_QUEST_LOOKUP);
