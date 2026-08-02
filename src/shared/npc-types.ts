/** NPC definitions, quest data, and runtime state types. */

import type { SpriteRef } from './set-piece-types.js';

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
  /** Optional per-instance visual override from authored set-piece data. */
  spriteOverride?: SpriteRef;
  /** Optional per-instance sprite mirror flags. */
  flipX?: boolean;
  flipY?: boolean;
  /** Optional per-instance clockwise sprite rotation in degrees. */
  rotationDeg?: number;
  /** Optional local z-order carried from authored set-piece NPC metadata. */
  z?: number;
  /** Index of the next dialogue line to show. */
  dialogueIndex: number;
  quests: NpcQuestState[];
  /** Optional per-instance dialogue that overrides the static NPC def copy. */
  dialogueOverride?: readonly string[];
  /** Optional fallback appearance key when the preferred one has no generated art. */
  appearanceFallbackKey?: string;
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
      text: "Contestant. Badge up. I'm your Floor 1 instructor — real one, by the way. Came in the same door you did, got far enough that they offered me a desk instead of a grave.",
    },
    {
      text: "XP was switched off until you checked in. Policy, not spite. It's on now — kill things, watch the bar, hit level 2 before anything out there gets ambitious.",
    },
    {
      text: "Nobody clears this floor on reflexes. You clear it on volume. Thin out the rats and slimes and the doors start cooperating. I've watched a lot of people learn that the expensive way.",
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
      text: 'A live one! Come in. Everyone here teaches you to *hit* things. I teach you the part that actually kills contestants — walking down those stairs in the kit you arrived in.',
    },
    {
      text: "Fetch me a tail. A good one, from the deep rooms, still got some *spring* in it. Then we'll talk about what I can put on you.",
    },
    {
      text: "Don't clean it. Don't ask. It's not for the shop. It's for the room.",
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
      text: "I handle the part the other two can't teach you: the moment where hitting harder stops being enough. Kill the Slime Rat, come back, I'll unseal a spellbook.",
    },
    {
      text: "You'll be offered three. Pick fast and *use* it. A spell you're saving for the perfect moment is a spell they find unused on your body. Ask me how I know what unused looks like.",
    },
    {
      text: '...Did he send you for a tail? He did. Of course he did. Take the long way back, contestant. Knock first.',
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
  "Oh, that's a *lovely* one. Look at the length on it. Somebody is going to have a very pleasant off-season.",
  "Yes, yes, hand it over — I'll put it somewhere safe. Now spend your gold. Anything you don't wear down those stairs is just set dressing on your corpse.",
];

/** Lines shown after the prize is returned but before a purchase is made. */
export const SHOPKEEPER_SHOP_DIALOGUE: readonly string[] = [
  "Back for the good stuff? Sensible. Gold only, no refunds, no judgement — I'm in no position to judge anyone.",
];

/** Lines shown once the player owns equipment but has not equipped it yet. */
export const SHOPKEEPER_EQUIP_HINT_DIALOGUE: readonly string[] = [
  "Owning it does nothing, contestant. *Wearing* it does everything. Open your pack, put it on. Humour me — I don't get a lot of visitors and I'd like to see it on someone.",
];

/** Lines shown after the questline is fully complete. */
export const SHOPKEEPER_DONE_DIALOGUE: readonly string[] = [
  "Marvellous. Truly. Off you go — and if the Broker's sulking when you see him, that's not about you.",
  "It's about a scheduling matter. Season-long thing. Pleasure doing business.",
];

/**
 * Lines shown by the merchant before the player has finished the Tutorial
 * Goon's opening quest. The merchant refuses to do business and sends them back.
 */
export const SHOPKEEPER_LOCKED_DIALOGUE: readonly string[] = [
  "Ah — no. No no no. The Goon clears you first. He's very firm about the order of things.",
  "*Very* firm. Go on, get signed off, I'll keep your slot warm.",
];

/**
 * Lines shown by the Spell Broker before the player has finished the Tutorial
 * Goon's opening quest.
 */
export const SPELL_QUEST_GIVER_LOCKED_DIALOGUE: readonly string[] = [
  "Not yet. The Goon clears you, the Merchant dresses you, *then* you're my problem. That's the order.",
  "I didn't write the order. I'd have written it differently. I'd have written a lot of things differently.",
];

// ---- Spell Broker contextual dialogue ----

/**
 * Lines shown by the Spell Broker once the player has claimed their spellbook
 * reward (goal flag `floor1-boss-spellbook-claimed`). Closes his beat: the
 * ability is live, and his real grievance is with the other two, not the player.
 */
export const SPELL_BROKER_POST_CLAIM_DIALOGUE: readonly string[] = [
  "It's live. It'll fire itself when the conditions are right — stop babysitting it and go fight.",
  "You know what the worst part is? I *like* them. Both of them. I've liked them for more seasons than he can count, and he used to be able to count. Go on. Kill something.",
];

/** Inputs for {@link selectSpellBrokerDialogue}, derived from world state. */
export interface SpellBrokerDialogueState {
  /** The Spell Broker is still gated behind the Goon's opening quest. */
  readonly locked: boolean;
  /** The player has claimed their spellbook reward. */
  readonly spellbookClaimed: boolean;
}

/**
 * Pick the Spell Broker's contextual dialogue for the current quest progress.
 *
 * Priority (highest first): locked (gated behind the Goon) > post-spellbook
 * claim. Returns `null` when neither applies, signalling the caller to fall back
 * to the Broker's default authored dialogue.
 */
export function selectSpellBrokerDialogue(
  state: SpellBrokerDialogueState,
): readonly string[] | null {
  if (state.locked) {
    return SPELL_QUEST_GIVER_LOCKED_DIALOGUE;
  }
  if (state.spellbookClaimed) {
    return SPELL_BROKER_POST_CLAIM_DIALOGUE;
  }
  return null;
}

// ---- Tutorial Goon contextual dialogue ----

/**
 * Lines shown by the Tutorial Goon once the staircase boss is dead and the
 * stairs to Floor 2 are live.
 */
export const TUTORIAL_GOON_POST_BOSS_DIALOGUE: readonly string[] = [
  'Boss down. Room clear. Stairs are live.',
  "This is the part where I don't come with you. That was the deal I signed — I get the floor, the floor gets me. Best offer anyone's ever made me and I still think about it.",
  "Floor 2 hits harder and the locals hold grudges. Keep moving, keep kiting. Go on — I've got a room to get back to.",
];

/**
 * Lines shown by the Tutorial Goon the moment the boss-room door unlocks and the
 * final "Leave the Floor" quest is auto-accepted (all three gate quests done).
 * Previously this was a silent auto-accept with no goon line.
 */
export const TUTORIAL_GOON_LEAVE_FLOOR_DIALOGUE: readonly string[] = [
  "Hear that? Door's unsealing. All three signed. You're the Director's problem now.",
  'Floor Boss, then the stairs. Everything we drilled, in that order — outlast it, out-gear it, out-burst it.',
  "Don't linger on the threshold. The cameras hate hesitation and so do I.",
];

/**
 * Lines shown by the Tutorial Goon after his kill-grind is done but the boss
 * door is still sealed — nudging the player toward the other two gate-givers so
 * they aren't left wondering why the door won't open.
 */
export const TUTORIAL_GOON_NUDGE_DIALOGUE: readonly string[] = [
  "Pest quota, filled. Boss door, still bolted. Three signatures on that door and I'm only one of them.",
  "The Merchant has to gear you. The Broker has to arm you. And no, they will not take my word for it — the Merchant *would*, but the Broker's made a whole thing of it this season, and the Merchant's not allowed to agree with me in front of him.",
  "It's a room, contestant. Long time, three people, one room. Go get signed off.",
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

// ---- Floor 2 · Slice 6 : The Broker + settlement shopkeepers ----

/**
 * The Broker — Floor 2 settlement quest-giver. Dispenses the "family favor"
 * meta-quest that introduces the emergent-event mechanic (spec FR19).
 */
const THE_BROKER_DEF: NpcDef = {
  id: 'the-broker',
  name: 'The Broker',
  dialogue: [
    {
      text: 'Contestant, sit. The families are watching the tape — every gesture, every double-cross. I broker the favors that keep this floor turning.',
    },
    {
      text: "Pick a family, take a job, keep your promises. Or don't. Turns out the audience loves a snake — and so do I, if the numbers are right.",
    },
    {
      text: 'Watch the ledger over my shoulder. Every deal moves someone up, someone down. Play the whole board, not just the friendliest face.',
    },
  ],
  quests: [
    {
      questId: 'floor2-broker-family-favor',
      title: 'A Family Favor',
      description:
        'Meet The Broker in the settlement, hear her pitch, and complete a single emergent-event favor to see the ledger shift.',
    },
  ],
  textureId: 10,
  widthFt: 2.5,
  heightFt: 3.5,
};

export const FLOOR2_DEFECTOR_NPC_ID = 'floor2-defector';

function formatFloor2FamilyName(familyId: string): string {
  return familyId
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function buildFloor2DefectorDialogue(familyId: string): readonly string[] {
  const familyName = formatFloor2FamilyName(familyId);
  return [
    `Keep your voice down. I used to run with the ${familyName}, right up until they started feeding their own to the cameras.`,
    `You want to stay breathing, watch how the ${familyName} move when the settlement ledger tilts against them. They get mean before they get sloppy.`,
    `I am done bleeding for the ${familyName}. You? You can still decide who gets your favor.`,
  ];
}

const FLOOR2_DEFECTOR_DEF: NpcDef = makeShopNpcDef(
  FLOOR2_DEFECTOR_NPC_ID,
  'Defected Family Member',
  ['Keep your head down. The families remember every face on this floor.'],
);

/** Helper: build a boilerplate shopkeeper NPC def for Floor 2 shop archetypes. */
function makeShopNpcDef(id: string, name: string, dialogue: readonly string[]): NpcDef {
  return {
    id,
    name,
    dialogue: dialogue.map((text) => ({ text })),
    quests: [],
    textureId: 10,
    widthFt: 2.5,
    heightFt: 3.5,
  };
}

const SHOP_THE_FENCE_DEF: NpcDef = makeShopNpcDef('shop-the-fence', 'The Fence', [
  "Everything's fenced, contestant. No receipts, no questions, no refunds.",
  "Whatever the last family lost, I've got. Whatever this one's about to lose, I'm buying.",
  'You want cheap and hot? Pick your poison off the rack. Cash on the barrel.',
]);

const SHOP_THE_APOTHECARY_DEF: NpcDef = makeShopNpcDef('shop-the-apothecary', 'The Apothecary', [
  'Powders, philters, and the occasional charm — all guaranteed to do *something*, sweetheart.',
  "The stained charm? House specialty. Don't sniff it. Don't lick it. Don't ask.",
  'Pay in gold. My credit line closed three floors ago.',
]);

const SHOP_THE_QUARTERMASTER_DEF: NpcDef = makeShopNpcDef(
  'shop-the-quartermaster',
  'The Quartermaster',
  [
    "Real gear. Real prices. No family markup — I sell to whoever's still upright.",
    'Hammer for the up-close, crossbow for the polite distance, mine for the exit.',
    'Bring the coin, take the kit, remember who armed you.',
  ],
);

const SHOP_THE_RESOURCE_BROKER_DEF: NpcDef = makeShopNpcDef(
  'shop-the-resource-broker',
  'The Resource Broker',
  [
    'You wanted volume? Wholesale? Off-inventory? This is the counter, friend.',
    'Prices are steep because the resource wars mean I bought steep. Blame the families.',
    "Big-ticket items only. I don't do trinkets. Well — one charm. Fine, two.",
  ],
);

const NPC_REGISTRY: ReadonlyMap<string, NpcDef> = new Map([
  [TUTORIAL_GOON_DEF.id, TUTORIAL_GOON_DEF],
  [SPELL_QUEST_GIVER_DEF.id, SPELL_QUEST_GIVER_DEF],
  [SHOPKEEPER_DEF.id, SHOPKEEPER_DEF],
  [THE_BROKER_DEF.id, THE_BROKER_DEF],
  [FLOOR2_DEFECTOR_DEF.id, FLOOR2_DEFECTOR_DEF],
  [SHOP_THE_FENCE_DEF.id, SHOP_THE_FENCE_DEF],
  [SHOP_THE_APOTHECARY_DEF.id, SHOP_THE_APOTHECARY_DEF],
  [SHOP_THE_QUARTERMASTER_DEF.id, SHOP_THE_QUARTERMASTER_DEF],
  [SHOP_THE_RESOURCE_BROKER_DEF.id, SHOP_THE_RESOURCE_BROKER_DEF],
]);

export function getNpcDef(id: string): NpcDef | undefined {
  return NPC_REGISTRY.get(id);
}

export function getAllNpcDefs(): NpcDef[] {
  return [...NPC_REGISTRY.values()];
}
