/**
 * Quest waypoints — resolves each visible active quest's current objective to a world
 * position so the HUD can render a map marker + off-screen direction arrow.
 *
 * The floor is large enough that surviving is easy but *finding* the next
 * objective is not. This resolver answers "where do I go next?" by mapping each
 * active quest's first incomplete objective onto a known floor location.
 *
 * Deterministic: reads only world state (quest log, goal flags, objective
 * positions, NPC entity positions). No Math.random(), no Date.now(), no
 * rendering imports — consumed by the engine HUD layer.
 */
import type { GameWorld } from '../world.js';
import { getActiveQuests, getQuestObjectiveViews } from './questSystem.js';
import { getQuestDef } from '../../shared/quest-types.js';
import type { FloorObjectiveState } from '../../shared/floor-types.js';
import { pickRoomAnchorCell, resolveFloor2SettlementAnchor } from '../floor2-settlement-anchor.js';

/** Coarse classification used by the HUD to colour the marker/arrow. */
export type QuestWaypointKind = 'npc' | 'item' | 'combat' | 'stairs';

export interface QuestWaypoint {
  /** Stable identity used to retain one HUD arrow per active quest. */
  readonly questId: string;
  /**
   * Precise target position in feet (world space) — the objective's actual
   * NPC/item/tile location. Always exact; never adjusted for shared rooms.
   * Consumers that need the objective's exact location should read this field.
   */
  readonly x: number;
  readonly y: number;
  /**
   * Direction used to compute off-screen arrow angle/distance. Equal to
   * `x`/`y` unless another active quest shares this quest's room with a
   * different precise target, in which case both are normalized to the
   * room's deterministic anchor so co-located quests don't point in
   * conflicting directions. Direction-arrow HUDs should use these fields
   * instead of `x`/`y`.
   */
  readonly dirX: number;
  readonly dirY: number;
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

/** Map a quest goal flag to a known room position. */
function goalFlagPos(
  world: GameWorld,
  objective: FloorObjectiveState | undefined,
  goalId: string,
): Vec2 | null {
  switch (goalId) {
    case 'floor2-settlement-found':
      return resolveFloor2SettlementAnchor(world);
    case 'floor2.objective.staircaseDiscovered':
      return world.floorExtendedState?.familyState?.staircasePos ?? null;
    case 'floor1-shop-quest-complete':
    case 'floor1-shop-prize-returned':
      return objective?.shopRoomPos ?? null;
    case 'floor1-boss-battle-complete':
    case 'floor1-boss-spellbook-claimed':
      return objective?.spellQuestGiverPos ?? null;
    case 'floor1-defeat-boss':
    case 'floor1.objective.staircaseDiscovered':
      return objective?.staircasePos ?? null;
    // Grind-anywhere goals (e.g. reach level 2) have no fixed location.
    default:
      return null;
  }
}

/** Resolve a single objective to a target position + marker kind, if any. */
function objectiveTarget(
  world: GameWorld,
  objective: FloorObjectiveState | undefined,
  objId: string,
  kind: string,
  npcId: string | undefined,
  goalId: string | undefined,
): { pos: Vec2; kind: QuestWaypointKind } | null {
  switch (kind) {
    case 'talk': {
      if (!objective) return null;
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
      if (!objective) return null;
      // The lone collect objective is the merchant's fetch item.
      return {
        pos: entityPos(world, world.floorScenario?.questItemEid ?? null) ?? objective.questItemPos,
        kind: 'item',
      };
    case 'counter':
      if (!objective) return null;
      // Only the single-target boss counter has a fixed location; broad kill
      // quotas (rats/slimes) are satisfied anywhere, so no waypoint.
      return objId === 'kill-slime-rat' ? { pos: objective.slimeRatRoomPos, kind: 'combat' } : null;
    case 'goal': {
      const pos = goalId ? goalFlagPos(world, objective, goalId) : null;
      if (!pos) {
        return null;
      }
      const isStairs =
        goalId === 'floor1-defeat-boss' ||
        goalId === 'floor1.objective.staircaseDiscovered' ||
        goalId === 'floor2.objective.staircaseDiscovered';
      return { pos, kind: isStairs ? 'stairs' : 'npc' };
    }
    case 'haveEquippable':
    case 'equip':
      if (!objective) return null;
      // Buy/equip steps point back to the shop.
      return { pos: objective.shopRoomPos, kind: 'npc' };
    default:
      return null;
  }
}

function normalizeSharedRoomTargets(
  world: GameWorld,
  waypoints: readonly QuestWaypoint[],
): QuestWaypoint[] {
  const floorMap = world.floorMap;
  if (!floorMap || waypoints.length < 2) {
    return [...waypoints];
  }

  const indicesByRoom = new Map<number, number[]>();
  for (const [index, waypoint] of waypoints.entries()) {
    const tile = floorMap.worldToTile(waypoint.x, waypoint.y);
    const roomId = floorMap.roomGraph.getRoomAt(tile.x, tile.y);
    if (roomId < 0) {
      continue;
    }
    const indices = indicesByRoom.get(roomId) ?? [];
    indices.push(index);
    indicesByRoom.set(roomId, indices);
  }

  const normalized = [...waypoints];
  for (const [roomId, indices] of indicesByRoom) {
    const first = waypoints[indices[0]!]!;
    if (
      indices.length < 2 ||
      indices.every((index) => {
        const waypoint = waypoints[index]!;
        return waypoint.x === first.x && waypoint.y === first.y;
      })
    ) {
      continue;
    }
    const room = floorMap.roomGraph.get(roomId);
    if (!room) {
      continue;
    }
    const anchorTile = pickRoomAnchorCell(room) ?? {
      x: Math.floor(room.bounds.x + (room.bounds.width - 1) / 2),
      y: Math.floor(room.bounds.y + (room.bounds.height - 1) / 2),
    };
    const anchor = floorMap.tileToWorld(anchorTile.x, anchorTile.y);
    for (const index of indices) {
      // Only the direction fields move to the shared anchor; `x`/`y` stay
      // precise so single-target consumers (e.g. the minimap tracked dot)
      // still point at the objective's actual tile.
      normalized[index] = { ...waypoints[index]!, dirX: anchor.x, dirY: anchor.y };
    }
  }
  return normalized;
}

/**
 * Waypoints for every visible active quest's current step, in quest-log insertion
 * order. Quests without a fixed location (for example, grind-anywhere objectives)
 * are omitted.
 */
export function getQuestWaypoints(world: GameWorld, playerEid?: number): QuestWaypoint[] {
  const objective = world.floorScenario?.objective;
  const activeQuests = getActiveQuests(world);

  // Build a map from completion-goal-flag → questId for every currently-active
  // quest.  A quest's `goal` objective is "blocked" when another active quest
  // owns the same flag (i.e. that other quest must finish first to set it).
  // Blocked objectives are navigated via the blocker's own arrow, so showing
  // a second arrow for the dependent quest is redundant and confusing.
  const completionFlagOwner = new Map<string, string>();
  for (const q of activeQuests) {
    const d = getQuestDef(q.questId);
    if (d?.onCompleteGoalFlag) {
      completionFlagOwner.set(d.onCompleteGoalFlag, q.questId);
    }
  }

  const waypoints: QuestWaypoint[] = [];
  for (const quest of activeQuests) {
    const def = getQuestDef(quest.questId);
    if (!def || def.hidden) {
      continue;
    }
    const activeView = getQuestObjectiveViews(world, quest, playerEid).find((view) => view.active);
    if (!activeView) {
      continue;
    }
    const { def: objDef } = activeView;

    // Skip quests whose current objective is blocked on another active quest's
    // completion.  The blocker already has its own direction arrow.
    if (
      objDef.kind === 'goal' &&
      objDef.goalId &&
      completionFlagOwner.has(objDef.goalId) &&
      completionFlagOwner.get(objDef.goalId) !== quest.questId
    ) {
      continue;
    }

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
      dirX: target.pos.x,
      dirY: target.pos.y,
      label: objDef.label,
      kind: target.kind,
    });
  }
  return normalizeSharedRoomTargets(world, waypoints);
}
