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
      text: 'Your first mission: defeat the floor boss. Find them, fight them, and claim your glory!',
    },
    { text: "Remember: the boss won't go down without a fight. Gear up and stay sharp." },
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

const NPC_REGISTRY: ReadonlyMap<string, NpcDef> = new Map([
  [TUTORIAL_GOON_DEF.id, TUTORIAL_GOON_DEF],
]);

export function getNpcDef(id: string): NpcDef | undefined {
  return NPC_REGISTRY.get(id);
}

export function getAllNpcDefs(): NpcDef[] {
  return [...NPC_REGISTRY.values()];
}
