/**
 * Quest waypoints — resolves each visible active quest's current objective to a world
 * position so the HUD can render a map marker + off-screen direction arrow.
 *
 * The floor is large enough that surviving is easy but *finding* the next
 * objective is not. This resolver answers "where do I go next?" by mapping each
 * active quest's first incomplete objective onto a known Floor 1 location
 * (an NPC, the fetch item, a boss room, or the stairs).
 *
 * Deterministic: reads only world state (quest log, goal flags, objective
 * positions, NPC entity positions). No Math.random(), no Date.now(), no
 * rendering imports — consumed by the engine HUD layer.
 */
import type { GameWorld } from '../world.js';
import { getActiveQuests, getQuestObjectiveViews } from './questSystem.js';
import { getQuestDef } from '../../shared/quest-types.js';
import type { FloorObjectiveState } from '../../shared/floor-types.js';

/** Coarse classification used by the HUD to colour the marker/arrow. */
export type QuestWaypointKind = 'npc' | 'item' | 'combat' | 'stairs';

export interface QuestWaypoint {
  /** Stable identity used to retain one HUD arrow per active quest. */
  readonly questId: string;
  /** Target position in feet (world space). */
  readonly x: number;
  readonly y: number;
  /** Human-readable label, mirrors the active objective's label. */
  readonly label: string;
  readonly kind: QuestWaypointKind;
}

interface Vec2 {
  x: number;
  y: number;
}

/** Live position of an NPC/item entity in feet, or null if not spawned. */
function entityPos(world: GameWorld, eid: number | null): Vec2 | null {
  if (eid === null || eid < 0) {
    return null;
  }
  const x = world.stores.position.x[eid];
  const y = world.stores.position.y[eid];
  if (x === undefined || y === undefined) {
    return null;
  }
  return { x, y };
}

/** Map a Floor 1 quest goal flag to a known room position. */
function goalFlagPos(objective: FloorObjectiveState, goalId: string): Vec2 | null {
  switch (goalId) {
    case 'floor1-shop-quest-complete':
    case 'floor1-shop-prize-returned':
      return objective.shopRoomPos;
    case 'floor1-boss-battle-complete':
    case 'floor1-boss-spellbook-claimed':
      return objective.spellQuestGiverPos;
    case 'floor1-defeat-boss':
    case 'floor1.objective.staircaseDiscovered':
      return objective.staircasePos;
    // Grind-anywhere goals (e.g. reach level 2) have no fixed location.
    default:
      return null;
  }
}

/** Resolve a single objective to a target position + marker kind, if any. */
function objectiveTarget(
  world: GameWorld,
  objective: FloorObjectiveState,
  objId: string,
  kind: string,
  npcId: string | undefined,
  goalId: string | undefined,
): { pos: Vec2; kind: QuestWaypointKind } | null {
  switch (kind) {
    case 'talk': {
      const f = world.floorScenario;
      const eid =
        npcId === 'tutorial-goon'
          ? f?.guideNpcEid
          : npcId === 'shopkeeper'
            ? f?.shopkeeperNpcEid
            : npcId === 'spell-quest-giver'
              ? f?.spellQuestGiverNpcEid
              : null;
      const pos =
        entityPos(world, eid ?? null) ??
        (npcId === 'tutorial-goon' ? objective.welcomeOfficePos : null) ??
        (npcId === 'shopkeeper' ? objective.shopRoomPos : null) ??
        (npcId === 'spell-quest-giver' ? objective.spellQuestGiverPos : null);
      return pos ? { pos, kind: 'npc' } : null;
    }
    case 'collect':
      // The lone collect objective is the merchant's fetch item.
      return {
        pos: entityPos(world, world.floorScenario?.questItemEid ?? null) ?? objective.questItemPos,
        kind: 'item',
      };
    case 'counter':
      // Only the single-target boss counter has a fixed location; broad kill
      // quotas (rats/slimes) are satisfied anywhere, so no waypoint.
      return objId === 'kill-slime-rat' ? { pos: objective.slimeRatRoomPos, kind: 'combat' } : null;
    case 'goal': {
      const pos = goalId ? goalFlagPos(objective, goalId) : null;
      if (!pos) {
        return null;
      }
      const isStairs =
        goalId === 'floor1-defeat-boss' || goalId === 'floor1.objective.staircaseDiscovered';
      return { pos, kind: isStairs ? 'stairs' : 'npc' };
    }
    case 'haveEquippable':
    case 'equip':
      // Buy/equip steps point back to the shop.
      return { pos: objective.shopRoomPos, kind: 'npc' };
    default:
      return null;
  }
}

/**
 * Waypoints for every visible active quest's current step. The tracked quest is
 * first so single-waypoint consumers retain their focused objective; remaining
 * quests preserve quest-log insertion order. Quests without a fixed location
 * (for example, grind-anywhere objectives) are omitted.
 */
export function getQuestWaypoints(world: GameWorld, playerEid?: number): QuestWaypoint[] {
  const objective = world.floorScenario?.objective;
  if (!objective) {
    return [];
  }

  const activeQuests = getActiveQuests(world);
  const trackedQuest = activeQuests.find((quest) => quest.tracked);
  const orderedQuests = trackedQuest
    ? [trackedQuest, ...activeQuests.filter((quest) => quest !== trackedQuest)]
    : activeQuests;
  const waypoints: QuestWaypoint[] = [];
  for (const quest of orderedQuests) {
    const def = getQuestDef(quest.questId);
    if (!def || def.hidden) {
      continue;
    }
    const activeView = getQuestObjectiveViews(world, quest, playerEid).find((view) => view.active);
    if (!activeView) {
      continue;
    }
    const { def: objDef } = activeView;
    const target = objectiveTarget(
      world,
      objective,
      objDef.id,
      objDef.kind,
      objDef.npcId,
      objDef.goalId,
    );
    if (!target) {
      continue;
    }
    waypoints.push({
      questId: quest.questId,
      x: target.pos.x,
      y: target.pos.y,
      label: objDef.label,
      kind: target.kind,
    });
  }
  return waypoints;
}
