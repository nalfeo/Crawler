/**
 * Strict, door-aware Floor 1 travel oracle for runtime navigation decisions.
 *
 * Unlike the pure ETA estimator's straight-line oracle (`floor1-goal-graph.ts`
 * `makeStraightLineTravelOracle`, which has no world/floor-map access and is
 * only meant for ballpark ETA/slack math), THIS oracle is what
 * `findProgressObjective` must use to decide the actual next goal to walk
 * toward: real tile-space A* through the current floor map, with door
 * passability evaluated under the route's HYPOTHETICAL satisfied-effects set
 * (see `objective-route-planner.ts`'s `TravelOracle` contract) — a door gated
 * on a goal id the planner has already scheduled earlier in the hypothetical
 * route is treated as open even if the player hasn't actually triggered it
 * yet in the live world.
 *
 * STRICT: returns `Infinity` whenever no floor map exists, a named location
 * doesn't resolve to a point, or A* finds no path — NEVER a Euclidean/
 * heuristic distance standing in for "unreachable". This is the one place in
 * the unlock-aware planning stack that is explicitly forbidden from ever
 * calling `estimateObjectiveTravelMs` (whose wall-safety-factor fallback is
 * exactly the kind of masked-unreachability this oracle must not produce).
 *
 * Pure w.r.t. its own return values (deterministic given identical world
 * state + inputs) but reads live `GameWorld`/`FloorMap` state, so — unlike
 * `objective-route-planner.ts` and `floor1-goal-graph.ts` — this module is
 * NOT usable outside `src/game/ai` / from a bare snapshot.
 */

import { buildDoorAwarePassable } from '../../core/door-navigation.js';
import type { GameWorld } from '../../core/world.js';
import type { PathfindingOptions } from '../../core/map/pathfinding.js';
import { findTilePath } from '../../core/map/pathfinding.js';
import type { LocationId, TravelOracle } from './objective-route-planner.js';
import { IN_PLACE_LOCATION } from './objective-route-planner.js';
import type { RunPlannerPoint } from './run-planner.js';

const EPSILON = 1e-6;

/**
 * Opaque effect emitted by `kill-slime-rat` / `finish-slime-rat` in the goal
 * graph.  When present in the hypothetical satisfied-effects set, the travel
 * oracle forces the Slime Rat boss-room door tiles passable — modelling the
 * runtime behaviour that re-opens those doors once the battle ends, allowing
 * the AI to plan a route from inside the room to `spellQuestGiver`.
 */
const SLIME_RAT_ROOM_OPEN_EFFECT = 'floor1-slime-rat-room-open';

export interface Floor1TravelOracleOptions {
  readonly moveSpeedFtPerMs: number;
  /** Ground-movement pathfinding options EXCLUDING `isTilePassable` — this
   * oracle supplies its own hypothetical-effects-aware passability predicate
   * per distinct effect set encountered. */
  readonly pathOptions: Omit<PathfindingOptions, 'isTilePassable'>;
  /**
   * Optional recovery for a true live-player start whose center maps onto an
   * impassable tile while its physical body still overlaps adjacent floor.
   * Other location ids remain strict.
   */
  readonly blockedStartRecovery?: {
    readonly locationId: LocationId;
    readonly bodyRadiusFt: number;
  };
}

function physicallyOverlappedCardinalTiles(
  floorMap: NonNullable<GameWorld['floorMap']>,
  point: RunPlannerPoint,
  blockedTile: { readonly x: number; readonly y: number },
  bodyRadiusFt: number,
): readonly { readonly x: number; readonly y: number }[] {
  if (!(bodyRadiusFt > 0)) return [];

  const tileSize = floorMap.config.tileSizeFt;
  const radiusSquared = bodyRadiusFt * bodyRadiusFt;
  const candidates = [
    { x: blockedTile.x + 1, y: blockedTile.y },
    { x: blockedTile.x - 1, y: blockedTile.y },
    { x: blockedTile.x, y: blockedTile.y + 1 },
    { x: blockedTile.x, y: blockedTile.y - 1 },
  ];

  return candidates.filter((tile) => {
    if (!floorMap.tileMap.inBounds(tile.x, tile.y)) return false;
    const minX = tile.x * tileSize;
    const maxX = minX + tileSize;
    const minY = tile.y * tileSize;
    const maxY = minY + tileSize;
    const closestX = Math.max(minX, Math.min(point.x, maxX));
    const closestY = Math.max(minY, Math.min(point.y, maxY));
    const dx = point.x - closestX;
    const dy = point.y - closestY;
    return dx * dx + dy * dy <= radiusSquared + EPSILON;
  });
}

/**
 * Build a set of `"x,y"` tile-key strings for every Slime Rat boss-room door
 * entity.  Returns `null` when the scenario or door EIDs are unavailable.
 * Used by the travel oracle to force those tiles passable when the
 * `floor1-slime-rat-room-open` effect is hypothetically satisfied.
 */
function buildSlimeRatRoomOpenTiles(world: GameWorld): Set<string> | null {
  const doorEids = world.floorScenario?.bossRoomDoorEids.get('slime-rat');
  if (!doorEids || doorEids.length === 0) return null;
  const { doorState } = world.stores;
  const tiles = new Set<string>();
  for (const eid of doorEids) {
    const tx = doorState.tileX[eid];
    const ty = doorState.tileY[eid];
    if (tx !== undefined && ty !== undefined) {
      tiles.add(`${tx},${ty}`);
    }
  }
  return tiles.size > 0 ? tiles : null;
}

/**
 * Build a strict, door-aware {@link TravelOracle} over the current floor map.
 * Returns a fresh oracle instance with its own internal memoization — callers
 * should build one per planning pass (e.g. once per navigation epoch / door
 * revision, per the caching guidance in the unlock-aware planner review
 * ledger) rather than reusing a stale instance across a door-state change.
 */
export function makeFloor1DoorAwareTravelOracle(
  world: GameWorld,
  locations: ReadonlyMap<LocationId, RunPlannerPoint>,
  options: Floor1TravelOracleOptions,
): TravelOracle {
  const floorMap = world.floorMap;
  const speed = Math.max(options.moveSpeedFtPerMs, EPSILON);
  const passableByEffectsKey = new Map<string, (x: number, y: number) => boolean>();
  const costByKey = new Map<string, number>();

  return {
    travelCost(from, to, satisfiedEffects) {
      if (to === IN_PLACE_LOCATION) return 0;
      if (!floorMap) return Infinity;
      if (from === to) return 0;
      const a = locations.get(from);
      const b = locations.get(to);
      if (!a || !b) return Infinity;

      const effectsKey = [...satisfiedEffects].sort().join(',');
      const cacheKey = `${from}|${to}|${effectsKey}`;
      const cachedCost = costByKey.get(cacheKey);
      if (cachedCost !== undefined) return cachedCost;

      let passable = passableByEffectsKey.get(effectsKey);
      if (!passable) {
        const overrides = new Map<string, boolean>();
        for (const tag of satisfiedEffects) {
          // A leading "!" is a floor-graph state effect: completing a boss
          // clears its live battle-active relock flag as well as satisfying
          // the corresponding unlock goal. The generic planner treats effect
          // tags as opaque; only this Floor 1 oracle interprets the negation.
          if (tag.startsWith('!')) {
            overrides.set(tag.slice(1), false);
          } else {
            overrides.set(tag, true);
          }
        }
        // `floor1-slime-rat-room-open` is an opaque effect that signals the
        // Slime Rat fight has ended and the room's doors are passable again
        // (the runtime re-opens them after the battle so the player can exit
        // to claim the spellbook reward).  Force those specific door tiles
        // open so the planner can route from inside the room.
        const slimeRatRoomOpen = satisfiedEffects.has(SLIME_RAT_ROOM_OPEN_EFFECT);
        const slimeRatDoorTiles = slimeRatRoomOpen ? buildSlimeRatRoomOpenTiles(world) : null;

        const basePassable = buildDoorAwarePassable(world, overrides);
        passable =
          slimeRatDoorTiles && slimeRatDoorTiles.size > 0
            ? (x: number, y: number): boolean =>
                slimeRatDoorTiles.has(`${x},${y}`) || basePassable(x, y)
            : basePassable;
        passableByEffectsKey.set(effectsKey, passable);
      }

      const startTile = floorMap.worldToTile(a.x, a.y);
      const goalTile = floorMap.worldToTile(b.x, b.y);
      const recovery = options.blockedStartRecovery;
      const startTiles =
        from === recovery?.locationId && !passable(startTile.x, startTile.y)
          ? physicallyOverlappedCardinalTiles(floorMap, a, startTile, recovery.bodyRadiusFt)
          : [startTile];
      let minPathSteps = Infinity;
      for (const candidate of startTiles) {
        const path = findTilePath(floorMap, candidate, goalTile, {
          ...options.pathOptions,
          isTilePassable: passable,
        });
        if (path.length > 0) {
          minPathSteps = Math.min(minPathSteps, path.length - 1);
        }
      }
      const cost = !Number.isFinite(minPathSteps)
        ? Infinity
        : Math.round((minPathSteps * floorMap.config.tileSizeFt) / speed);
      costByKey.set(cacheKey, cost);
      return cost;
    },
  };
}
