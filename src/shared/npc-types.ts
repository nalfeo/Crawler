/** NPC definitions, quest data, and runtime state types. */

export interface NpcQuestDef {
  questId: string;
  title: string;
  description: string;
}

export interface NpcDialogueLine {
  text: string;
}

export interface NpcDef {
  id: string;
  name: string;
  /** Sequential dialogue lines shown in order; cycles back after the last line. */
  dialogue: NpcDialogueLine[];
  /** Quests offered by this NPC. */
  quests: NpcQuestDef[];
  textureId: number;
  widthFt: number;
  heightFt: number;
}

export type QuestStatus = 'available' | 'active' | 'complete';

export interface NpcQuestState {
  questId: string;
  status: QuestStatus;
}

/** Runtime instance state for a spawned NPC (sidecar, keyed by eid). */
export interface NpcInstance {
  defId: string;
  /** Index of the next dialogue line to show. */
  dialogueIndex: number;
  quests: NpcQuestState[];
  /** True when the player is within NPC_INTERACT_RANGE_FT. */
  nearbyPlayer: boolean;
}

/** Interaction radius in feet within which the player can interact with an NPC. */
export const NPC_INTERACT_RANGE_FT = 10;

// ---- NPC Definitions ----

const TUTORIAL_GOON_DEF: NpcDef = {
  id: 'tutorial-goon',
  name: 'Tutorial Goon',
  dialogue: [
    {
      text: "Hey, contestant! I'm the Tutorial Goon. Welcome to the Welcome Office — enjoy it while it lasts.",
    },
    {
      text: 'No XP drops until you check in with me. Done now — watch the XP bar and hit level 2 first.',
    },
    {
      text: 'After level 2, I unlock your boss-door quest: clear 6 rats + 4 slimes. But the boss door only opens once you have ALSO squared away the merchant and the spell broker.',
    },
  ],
  quests: [
    {
      questId: 'floor1-tutorial',
      title: 'Trial by XP',
      description: 'Unlock XP with the goon and reach level 2.',
    },
  ],
  textureId: 10,
  widthFt: 2.5,
  heightFt: 3.5,
};

const SHOPKEEPER_DEF: NpcDef = {
  id: 'shopkeeper',
  name: 'Sweaty Merchant',
  dialogue: [
    {
      text: "Oh-ho, a new contestant! Come closer, don't be shy. I'm a merchant of... refined tastes.",
    },
    {
      text: "I'll sell you something nice. But first — fetch me a rat tail. They tend to lose them in the deeper, far-flung rooms of this dungeon.",
    },
    {
      text: 'Bring it straight back. No wiping it off. I like them... authentic. Hehe.',
    },
  ],
  quests: [
    {
      questId: 'floor1-shopkeeper-errand',
      title: "The Merchant's Disgusting Little Errand",
      description: 'Fetch the merchant his "special" rat tail, then buy a piece of equipment.',
    },
  ],
  textureId: 10,
  widthFt: 2.5,
  heightFt: 3.5,
};

const SPELL_QUEST_GIVER_DEF: NpcDef = {
  id: 'spell-quest-giver',
  name: 'Spell Broker',
  dialogue: [
    {
      text: 'I handle post-boss rewards. Beat the Slime Rat, then come back to me to claim your spellbook.',
    },
    {
      text: 'When the Learn a Spell modal opens, pick Fireball, Heal, or Pulse Shield. Press [B] to configure your abilities bar.',
    },
    {
      text: 'Your abilities bar supports up to ten spells. In this slice, unlocked spells auto-trigger from their cooldown + combat conditions.',
    },
  ],
  quests: [
    {
      questId: 'floor1-boss-battle',
      title: 'Neighborhood Watch',
      description: 'Defeat the Slime Rat and pick a spellbook reward.',
    },
  ],
  textureId: 10,
  widthFt: 2.5,
  heightFt: 3.5,
};

/** Lines shown when the player has the rat tail and is ready to hand it over. */
export const SHOPKEEPER_RETURN_DIALOGUE: readonly string[] = [
  "Is that... oh, you actually got it. And it's still moist. Good contestant.",
  'Give it here. *sniff* Ahhh. Worth every coin. Now — let me show you my wares.',
];

/** Lines shown after the prize is returned but before a purchase is made. */
export const SHOPKEEPER_SHOP_DIALOGUE: readonly string[] = [
  'Back for the good stuff? Smart. Take a look — gold only, no refunds, no judgement.',
];

/** Lines shown once the player owns equipment but has not equipped it yet. */
export const SHOPKEEPER_EQUIP_HINT_DIALOGUE: readonly string[] = [
  'Put it on, put it on! Open your pack and equip it. I want to see how it looks on you.',
];

/** Lines shown after the questline is fully complete. */
export const SHOPKEEPER_DONE_DIALOGUE: readonly string[] = [
  'Looks marvellous on you. Pleasure doing business, contestant. Bring me more tails sometime.',
];

/**
 * Lines shown by the merchant before the player has finished the Tutorial
 * Goon's opening quest. The merchant refuses to do business and sends them back.
 */
export const SHOPKEEPER_LOCKED_DIALOGUE: readonly string[] = [
  "Whoa — I don't deal with fresh meat. Go check in with the Tutorial Goon first.",
  'Finish his warm-up, then come back and we can talk business.',
];

/**
 * Lines shown by the Spell Broker before the player has finished the Tutorial
 * Goon's opening quest.
 */
export const SPELL_QUEST_GIVER_LOCKED_DIALOGUE: readonly string[] = [
  'Not yet, contestant. Go see the Tutorial Goon and finish his warm-up first.',
  "Once the Goon clears you, come back and we'll talk spellbooks.",
];

// ---- Tutorial Goon contextual dialogue ----

/**
 * Lines shown by the Tutorial Goon once the staircase boss is dead and the
 * stairs to Floor 2 are live.
 */
export const TUTORIAL_GOON_POST_BOSS_DIALOGUE: readonly string[] = [
  'You did it! Boss dropped, room cleared.',
  'Stairs are live. Descend when you are ready.',
  'Floor 2 will hit harder. Keep moving and kite smart.',
];

/**
 * Lines shown by the Tutorial Goon the moment the boss-room door unlocks and the
 * final "Leave the Floor" quest is auto-accepted (all three gate quests done).
 * Previously this was a silent auto-accept with no goon line.
 */
export const TUTORIAL_GOON_LEAVE_FLOOR_DIALOGUE: readonly string[] = [
  "There it is — that's the boss door unsealing. The Director's cleared you for the main event.",
  'Last gig on this floor: drop the Floor Boss, then sprint for the stairs down to Floor 2.',
  "Don't dawdle. The cameras love a clean exit, and the show waits for nobody.",
];

/**
 * Lines shown by the Tutorial Goon after his kill-grind is done but the boss
 * door is still sealed — nudging the player toward the other two gate-givers so
 * they aren't left wondering why the door won't open.
 */
export const TUTORIAL_GOON_NUDGE_DIALOGUE: readonly string[] = [
  "Pest quota? Filled. But that boss door's still bolted shut, hotshot.",
  'House rules: no boss until the Sweaty Merchant and the Spell Broker both sign off on you.',
  'Go find them, run their errands, then come back and we talk stairs.',
];

/** Inputs for {@link selectTutorialGoonDialogue}, derived from world state. */
export interface TutorialGoonDialogueState {
  /** The staircase boss has been defeated (stairs are live). */
  readonly bossDefeated: boolean;
  /** The final "Leave the Floor" quest has been accepted. */
  readonly leaveFloorAccepted: boolean;
  /** The Goon's kill-grind quest is complete (boss-door gate #1). */
  readonly goonGrindComplete: boolean;
  /** The Merchant's errand is complete (boss-door gate #2). */
  readonly merchantErrandComplete: boolean;
  /** The Spell Broker's Slime Rat quest is complete (boss-door gate #3). */
  readonly spellBrokerComplete: boolean;
}

/**
 * Pick the Tutorial Goon's contextual dialogue for the current quest progress.
 *
 * Priority (highest first): post-boss > leave-the-floor accepted > nudge toward
 * the other gate-givers. Returns `null` when none apply, signalling the caller
 * to fall back to the Goon's default authored dialogue.
 */
export function selectTutorialGoonDialogue(
  state: TutorialGoonDialogueState,
): readonly string[] | null {
  if (state.bossDefeated) {
    return TUTORIAL_GOON_POST_BOSS_DIALOGUE;
  }
  if (state.leaveFloorAccepted) {
    return TUTORIAL_GOON_LEAVE_FLOOR_DIALOGUE;
  }
  if (state.goonGrindComplete && !(state.merchantErrandComplete && state.spellBrokerComplete)) {
    return TUTORIAL_GOON_NUDGE_DIALOGUE;
  }
  return null;
}

const NPC_REGISTRY: ReadonlyMap<string, NpcDef> = new Map([
  [TUTORIAL_GOON_DEF.id, TUTORIAL_GOON_DEF],
  [SPELL_QUEST_GIVER_DEF.id, SPELL_QUEST_GIVER_DEF],
  [SHOPKEEPER_DEF.id, SHOPKEEPER_DEF],
]);

export function getNpcDef(id: string): NpcDef | undefined {
  return NPC_REGISTRY.get(id);
}

export function getAllNpcDefs(): NpcDef[] {
  return [...NPC_REGISTRY.values()];
}
