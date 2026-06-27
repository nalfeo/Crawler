/**
 * Pure, deterministic decision kernels for the Behavior-Tree AI's four
 * exploration directives. These were previously private methods buried inside
 * the ~150 KB {@link BehaviorTreeAI} class, which made them impossible to unit
 * test in isolation. Each kernel here is a pure function (or a small
 * deterministic state machine) of its explicit inputs — no `Math.random`, no
 * `Date.now`, no hidden world state — so it can be exhaustively unit tested and
 * visualised in a lab. {@link BehaviorTreeAI} delegates to these so the tests
 * cover the real production code path, not a parallel re-implementation.
 *
 * Directive map:
 *  - C1 UNEXPLORED-tile preference  -> {@link findNearestFrontierTile}
 *  - C2 minimap / POI seeking       -> {@link pickNearestPoi}
 *  - C3 locked-door memory          -> {@link updateLockedDoorMemory} / {@link isDoorKnownLocked}
 *  - C4 stuck / wiggle reduction    -> {@link nextStuckFrames} / {@link DwellTracker}
 */

import type { DoorUnlockRequirement } from '../../core/door-navigation.js';

// ---------------------------------------------------------------------------
// C1 — UNEXPLORED-TILE PREFERENCE (fog-of-war frontier search)
// ---------------------------------------------------------------------------

/**
 * Read-only view of the floor a frontier search runs over. Supplied by the
 * caller so the BFS stays a pure function of grid shape + predicates, with no
 * dependency on {@link FloorMap} or feet geometry.
 */
export interface FrontierGrid {
  readonly width: number;
  readonly height: number;
  /** Flat tile index for (tileX, tileY), or -1 when out of bounds. */
  index(tileX: number, tileY: number): number;
  /** True when the tile at this flat index has ever been seen (fog cleared). */
  isSeen(index: number): boolean;
  /** True when the AI may walk onto this tile (door-aware passability). */
  isPassable(tileX: number, tileY: number): boolean;
  /** Distance in feet from the reference point (the player) to this tile's centre. */
  tileDistanceFt(tileX: number, tileY: number): number;
}

export interface FrontierTile {
  readonly tileX: number;
  readonly tileY: number;
}

/**
 * Breadth-first search from the player through SEEN, passable ground for the
 * nearest "frontier" tile — a seen tile with at least one unseen in-bounds
 * neighbour — that lies at least {@link minDistanceFt} away. Because BFS expands
 * nearest-first by step count, the first qualifying frontier is effectively the
 * closest useful one. Expansion is capped at {@link maxTiles} so a fully-open
 * floor cannot make the search unbounded.
 *
 * The minimum-distance gate guarantees every returned target forces real
 * travel, which always changes the fog (and therefore the frontier set) — this
 * structurally prevents the AI from locking onto a zero-movement target.
 *
 * Deterministic: fixed neighbour order [+x, -x, +y, -y], BFS by insertion. The
 * caller passes a reusable `visited` scratch buffer (length >= width*height)
 * which is zero-filled here.
 *
 * @returns the nearest qualifying frontier tile, or `null` when none remains
 *          reachable (near-complete exploration) so the caller can fall back to
 *          random sampling.
 */
export function findNearestFrontierTile(
  grid: FrontierGrid,
  startTileX: number,
  startTileY: number,
  minDistanceFt: number,
  maxTiles: number,
  visited: Uint8Array,
): FrontierTile | null {
  const startIdx = grid.index(startTileX, startTileY);
  if (startIdx === -1) {
    return null;
  }

  visited.fill(0);

  const queueX: number[] = [startTileX];
  const queueY: number[] = [startTileY];
  visited[startIdx] = 1;
  let head = 0;
  let expanded = 0;

  const neighborDx = [1, -1, 0, 0];
  const neighborDy = [0, 0, 1, -1];

  while (head < queueX.length && expanded < maxTiles) {
    const tx = queueX[head] as number;
    const ty = queueY[head] as number;
    head += 1;
    expanded += 1;

    let isFrontier = false;
    for (let d = 0; d < 4; d += 1) {
      const nx = tx + (neighborDx[d] as number);
      const ny = ty + (neighborDy[d] as number);
      const nIdx = grid.index(nx, ny);
      if (nIdx === -1) {
        continue;
      }
      if (!grid.isSeen(nIdx)) {
        // An unseen in-bounds neighbour makes this tile a frontier.
        isFrontier = true;
        continue;
      }
      // Expand BFS only through seen + reachable ground so any frontier we
      // return is guaranteed reachable through known territory.
      if (visited[nIdx] === 0 && grid.isPassable(nx, ny)) {
        visited[nIdx] = 1;
        queueX.push(nx);
        queueY.push(ny);
      }
    }

    if (isFrontier && grid.tileDistanceFt(tx, ty) >= minDistanceFt) {
      // BFS is nearest-first by step count, so the first frontier past the
      // minimum travel distance is effectively the nearest useful one.
      return { tileX: tx, tileY: ty };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// C2 — MINIMAP / POINTS-OF-INTEREST SEEKING
// ---------------------------------------------------------------------------

/**
 * A discovered point of interest the AI may navigate toward (an NPC, shop,
 * quest objective, staircase…). `relevant` is `false` once the POI no longer
 * needs visiting (e.g. an NPC with nothing left to say), so handled targets are
 * skipped — the AI seeks discovered-BUT-unvisited markers, not omnisciently
 * every marker.
 */
export interface PoiCandidate {
  readonly x: number;
  readonly y: number;
  readonly relevant: boolean;
}

/**
 * Pick the nearest still-relevant POI strictly within {@link maxRadiusFt} of
 * the reference point. Mirrors the AI's NPC/objective scan: candidates outside
 * the scan radius are ignored, already-handled ones (relevant === false) are
 * skipped, and ties resolve to the first candidate encountered (caller controls
 * iteration order for determinism).
 *
 * @returns the chosen candidate (preserving its concrete type), or `null` when
 *          none qualifies.
 */
export function pickNearestPoi<T extends PoiCandidate>(
  candidates: Iterable<T>,
  fromX: number,
  fromY: number,
  maxRadiusFt: number,
): T | null {
  let nearest: T | null = null;
  let minDist = maxRadiusFt;
  for (const candidate of candidates) {
    if (!candidate.relevant) {
      continue;
    }
    const dist = Math.hypot(candidate.x - fromX, candidate.y - fromY);
    if (dist < minDist) {
      minDist = dist;
      nearest = candidate;
    }
  }
  return nearest;
}

// ---------------------------------------------------------------------------
// C3 — LOCKED-DOOR MEMORY
// ---------------------------------------------------------------------------

/**
 * A locked door the AI remembers it cannot currently pass, together with what
 * each needs to unlock (goal flags / item ids / timer). Surfaced for debug
 * overlays and to make the "remember locked doors" behaviour observable.
 */
export interface AILockedDoorMemory {
  eid: number;
  tileX: number;
  tileY: number;
  unlockRequirement: DoorUnlockRequirement;
}

/**
 * Reconcile the AI's locked-door memory against the doors that are blocked
 * *this* poll: record every currently-blocked door (so the AI stops blindly
 * re-attempting it) and forget any remembered door that is no longer blocked
 * (its unlock condition is now satisfied, so it is passable again).
 *
 * Mutates `known` in place — a deterministic transformation with no hidden
 * state — and is safe to call every frame.
 */
export function updateLockedDoorMemory(
  known: Map<number, AILockedDoorMemory>,
  blocked: readonly AILockedDoorMemory[],
): void {
  const blockedEids = new Set<number>();
  for (const info of blocked) {
    blockedEids.add(info.eid);
    known.set(info.eid, {
      eid: info.eid,
      tileX: info.tileX,
      tileY: info.tileY,
      unlockRequirement: info.unlockRequirement,
    });
  }
  for (const eid of [...known.keys()]) {
    if (!blockedEids.has(eid)) {
      known.delete(eid);
    }
  }
}

/**
 * Whether the AI currently remembers the given door as locked. Lets navigation
 * skip doors known to be impassable instead of re-pathing into them.
 */
export function isDoorKnownLocked(
  known: ReadonlyMap<number, AILockedDoorMemory>,
  eid: number,
): boolean {
  return known.has(eid);
}

// ---------------------------------------------------------------------------
// C4 — STUCK / WIGGLE REDUCTION
// ---------------------------------------------------------------------------

/**
 * Advance the per-frame stuck counter: increment while the player moves less
 * than {@link epsilonFt} between polls, reset to 0 the moment real travel
 * happens. A weak signal on its own (a slow productive crawl can still climb
 * it), so callers pair it with the net-displacement {@link DwellTracker} below.
 */
export function nextStuckFrames(prevFrames: number, movedFt: number, epsilonFt: number): number {
  return movedFt < epsilonFt ? prevFrames + 1 : 0;
}

export type DwellResult =
  /** First frame in this dwell episode; anchor just placed. */
  | 'armed'
  /** Genuine progress (escaped the dwell circle, or caller-supplied signal); re-anchored. */
  | 'progress'
  /** Parked inside the dwell circle; frame counter advancing toward the limit. */
  | 'accumulating'
  /** Parked for the full window with no progress; the deadlock fired (and auto-reset). */
  | 'fired';

/**
 * Net-displacement dwell watchdog. The per-frame {@link nextStuckFrames} counter
 * is defeated by a wiggle that keeps instantaneous displacement above its
 * epsilon, so this instead anchors a position and only forgives genuine NET
 * travel out of a small circle (or a caller-supplied progress signal, e.g.
 * closing on an enemy). If the player never escapes for {@link frameLimit}
 * polls it reports `'fired'` so the caller can break the deadlock, then
 * auto-resets to re-arm on the next call.
 *
 * Deterministic and self-contained: the only state is the anchor + frame count.
 */
export class DwellTracker {
  private active = false;
  private anchorX = 0;
  private anchorY = 0;
  private frames = 0;

  /**
   * @param escapeFt  net travel from the anchor that counts as escaping the dwell.
   * @param frameLimit polls parked inside the circle before reporting `'fired'`.
   */
  constructor(
    private readonly escapeFt: number,
    private readonly frameLimit: number,
  ) {}

  get isActive(): boolean {
    return this.active;
  }

  get framesParked(): number {
    return this.frames;
  }

  /** Forget the current episode (e.g. when the owning state stops running). */
  reset(): void {
    this.active = false;
    this.anchorX = 0;
    this.anchorY = 0;
    this.frames = 0;
  }

  /**
   * Feed the player's current position (and an optional extra progress signal,
   * such as closing distance on a target). Returns the dwell verdict for this
   * frame. On `'fired'` the tracker resets itself so the next call re-arms.
   */
  update(x: number, y: number, extraProgress: boolean = false): DwellResult {
    if (!this.active) {
      this.active = true;
      this.anchorX = x;
      this.anchorY = y;
      this.frames = 0;
      return 'armed';
    }

    const drift = Math.hypot(x - this.anchorX, y - this.anchorY);
    if (drift > this.escapeFt || extraProgress) {
      this.anchorX = x;
      this.anchorY = y;
      this.frames = 0;
      return 'progress';
    }

    this.frames += 1;
    if (this.frames > this.frameLimit) {
      this.active = false;
      this.frames = 0;
      return 'fired';
    }
    return 'accumulating';
  }
}
