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
  widthPx: number;
  heightPx: number;
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
  /** True when the player is within NPC_INTERACT_RANGE_PX. */
  nearbyPlayer: boolean;
}

/** Pixel radius within which the player can interact with an NPC. */
export const NPC_INTERACT_RANGE_PX = 80;

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
  widthPx: 20,
  heightPx: 28,
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
  widthPx: 20,
  heightPx: 28,
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
  widthPx: 20,
  heightPx: 28,
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
