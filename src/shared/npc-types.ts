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
      text: 'Quest time: kill 10 rats + slimes total. That unlocks the boss room door.',
    },
    { text: 'Once the boss is dead, stairs spawn in the boss room. Come back if you forget.' },
  ],
  quests: [
    {
      questId: 'floor1-defeat-boss',
      title: 'Defeat the Boss',
      description: 'Defeat the floor boss to prove yourself to the Guild and the audience!',
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
  [SHOPKEEPER_DEF.id, SHOPKEEPER_DEF],
]);

export function getNpcDef(id: string): NpcDef | undefined {
  return NPC_REGISTRY.get(id);
}

export function getAllNpcDefs(): NpcDef[] {
  return [...NPC_REGISTRY.values()];
}
