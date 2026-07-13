/**
 * Safe-room route constraint — a generic, post-selection navigation overlay.
 *
 * ADR: see `docs/knowledge/adr/2026-07-13-safe-room-route-constraint-layer.md`.
 *
 * Historically, leaving a safe room was owned by a dedicated `LeaveSafeRoom`
 * behavior-tree node (Priority 3.5 in Track A) that seized `decision.state` /
 * `targetEid` / `targetX/Y` and drove the player past the nearest threat via a
 * latched "egress waypoint". That design was rebuilt four times (see the
 * superseded ADR) and still oscillated/deadlocked because it fought the real
 * semantic owner (Progress/Engage/Hunt/etc.) for control of `AIDecision` every
 * frame near the doorway.
 *
 * This module replaces that ownership model entirely. It is a **pure,
 * data-only reducer** consulted *after* the behavior tree has already picked a
 * winning semantic intent. It never sets `decision.state`, `targetEid`, or
 * `targetX/Y` — those remain owned by whichever intent won Track A. It only
 * ever proposes an optional **route override target** for movement execution
 * (`moveTarget`), used solely to prepend a short, legal, door-aware exit
 * segment when the semantic target lies outside the player's current safe
 * room. Once the player has genuinely crossed the doorway, this module hands
 * control back to the raw semantic target unmodified.
 *
 * Design invariants (see the adversarial plan review ledger):
 *  1. **Stable, non-coordinate commitment identity.** The "commitment key" is
 *     derived from the semantic intent (`AIState`) plus the target entity id
 *     when one exists, or a quantized (0.5 ft) fallback position — never raw,
 *     continuously-moving coordinates. This is what lets a wandering hunted
 *     enemy move every frame without re-triggering route computation.
 *  2. **Separate semantic vs routed targets.** Callers pass the already-
 *     resolved semantic target in (never mutated) and receive back an
 *     independent `moveTarget` (or `null` to mean "use the semantic target
 *     directly"). `AIDecision.targetX/Y` stay untouched.
 *  3. **Path-prefix / door-edge completion**, not `world.playerInSafeRoom`
 *     flicker. Once a route is computed, completion is driven by a
 *     monotonically-advancing `segmentIndex` through a precomputed tile path
 *     — never by re-reading the raw in/out boolean every frame (which flickers
 *     at the threshold and was the root cause of the historical deadlock).
 *  4. **Uniform across all external semantic targets** (Progress, Retreat,
 *     Interact, Engage, Collect, Explore/Hunt) — no intent-specific branches.
 *     The only inputs this module reads are the coarse `AIState` value, an
 *     already-resolved anchor position/entity id, and door-aware pathfinding
 *     — never a `state === X` special case.
 *  5. **Reuse, not reinvention.** Callers inject `findPath` (thin wrapper over
 *     the existing door-aware `findTilePath`) and pass the provider's existing
 *     `navEpoch` as the cache-invalidation signal — this module never runs its
 *     own pathfinding library or polls A* every frame; it recomputes only on a
 *     commitment-key change or a `navEpoch` change.
 */

import { AIState, type AIStateValue } from './types.js';
import type { TilePoint } from '../../core/map/pathfinding.js';

/** Lifecycle phase of the route overlay. */
export type SafeRoomRoutePhase = 'idle' | 'active' | 'blocked';

/**
 * A candidate semantic commitment: the coarse AI state plus its already-
 * resolved target identity/position. `targetEid`/`targetX`/`targetY` mirror
 * `AIDecision` naming but represent the ANCHOR used for routing purposes
 * (the live entity position when the semantic target is an entity, so a
 * tactical stand-off point that itself sits inside the safe room can never
 * hide a threat that has genuinely already left it).
 */
export interface SemanticCommitmentCandidate {
  readonly state: AIStateValue;
  readonly targetEid: number | null;
  readonly targetX: number | null;
  readonly targetY: number | null;
}

/** Durable, data-only route state carried across polls. */
export interface SafeRoomRouteState {
  readonly phase: SafeRoomRoutePhase;
  /** Room id (per the injected room graph) the route started from. `null`
   * while idle. */
  readonly originRoomId: number | null;
  /** `navEpoch` snapshotted at the last (re)compute. `null` while idle. */
  readonly navEpoch: number | null;
  /** Stable commitment identity snapshotted at the last (re)compute. `null`
   * while idle. */
  readonly commitmentKey: string | null;
  /** Canonical tile path (start-inclusive), already truncated to a short
   * legal exit prefix — never the full trip to a distant/moving anchor. */
  readonly path: readonly TilePoint[];
  /** Index of the next path tile the player has not yet reached. */
  readonly segmentIndex: number;
  /** Reseed cause of the last recompute, for diagnostics only. */
  readonly lastReseedCause: 'activation' | 'commitment-change' | 'nav-epoch-change' | null;
  // Durable lifetime counters (diagnostics only; never influence behavior).
  readonly totalActivations: number;
  readonly totalCompletions: number;
  readonly totalBlocked: number;
  readonly totalReseeds: number;
}

/** Per-poll inputs the reducer needs, already resolved by the caller. */
export interface SafeRoomRouteInput {
  readonly playerX: number;
  readonly playerY: number;
  /** Existing `world.playerInSafeRoom` signal — reused verbatim as the
   * activation gate (not as the completion signal; see module doc). */
  readonly playerInSafeRoom: boolean;
  /** Existing provider `navEpoch` — reused verbatim as the cache-invalidation
   * signal for door/topology changes. */
  readonly navEpoch: number;
  readonly candidate: SemanticCommitmentCandidate;
}

/** Pure closures the caller injects so this module never touches ECS/Phaser
 * directly and stays fully unit-testable without a `GameWorld`. */
export interface SafeRoomRouteDeps {
  readonly worldToTile: (x: number, y: number) => TilePoint;
  readonly tileToWorld: (tx: number, ty: number) => { x: number; y: number };
  /** Room id containing a tile, or a negative number when the tile is not
   * part of any registered room's interior (door/wall tiles always fall in
   * this bucket — see `RoomGraph.getRoomAt`). */
  readonly getRoomAt: (tileX: number, tileY: number) => number;
  readonly isSafeRoomId: (roomId: number) => boolean;
  /** Door-aware A* (existing `findTilePath` + `groundPathOptions()`), start-
   * inclusive/goal-inclusive, empty when unreachable. */
  readonly findPath: (start: TilePoint, goal: TilePoint) => readonly TilePoint[];
}

export interface SafeRoomRouteUpdateResult {
  readonly state: SafeRoomRouteState;
  /** Movement override target, or `null` to mean "use the semantic target
   * directly" (no-op / same-safe-space bypass / route just completed). */
  readonly moveTarget: { x: number; y: number } | null;
  /** True when no legal route exists; caller should zero out movement while
   * preserving the semantic owner/decision untouched. */
  readonly blocked: boolean;
}

/** Fixed, order-independent priority used only to make `pickCanonicalCommitment`
 * deterministic under any input ordering. The live behavior tree's Track A
 * selector already guarantees at most one candidate per poll, so this never
 * changes observed runtime behavior — it exists so the tie-break contract is
 * provable/testable (permutation tests) per the adversarial plan review. */
const COMMITMENT_STATE_PRIORITY: readonly AIStateValue[] = [
  AIState.RETREAT,
  AIState.INTERACT,
  AIState.ENGAGE,
  AIState.COLLECT,
  AIState.EXPLORE,
];

/** Quantization step (feet) for coordinate-based commitment identity. Absorbs
 * float jitter while still changing on a genuine re-target. */
const COMMITMENT_QUANTIZE_FT = 0.5;

/** Tiles to hold the route active past the first tile outside the origin
 * room, so arrival lands solidly past the doorway/mouth instead of exactly on
 * the threshold (avoids re-triggering on hair's-width position noise). */
const SAFE_ROOM_ROUTE_EXIT_BUFFER_TILES = 1;

/** Same arrival radius `moveToward` itself uses for waypoint-follow, reused
 * here so route-segment completion agrees with the AI's own local-navigation
 * arrival semantics. This module intentionally does not import
 * `WAYPOINT_ARRIVE_FT` from `bt-ai-tuning.ts` to keep zero coupling to the
 * provider's tuning module; the literal (1 ft) is kept in sync by the
 * provider-level tests in `tests/game/behavior-tree-ai.test.ts`. */
const SAFE_ROOM_ROUTE_ARRIVE_FT = 1;

function quantize(value: number): number {
  return Math.round(value / COMMITMENT_QUANTIZE_FT) * COMMITMENT_QUANTIZE_FT;
}

function candidateIdentity(candidate: SemanticCommitmentCandidate): string {
  if (candidate.targetEid !== null) {
    return `eid:${candidate.targetEid}`;
  }
  const qx = quantize(candidate.targetX ?? 0);
  const qy = quantize(candidate.targetY ?? 0);
  return `xy:${qx}:${qy}`;
}

/** Stable, non-coordinate commitment identity: semantic intent + entity
 * identity, or semantic intent + quantized fallback position. */
export function deriveCommitmentKey(candidate: SemanticCommitmentCandidate): string {
  return `${candidate.state}:${candidateIdentity(candidate)}`;
}

/**
 * Pure, order-independent selection among candidate semantic commitments.
 * Lower `COMMITMENT_STATE_PRIORITY` index wins; ties break on the identity
 * string's lexicographic order, so the winner never depends on input array
 * order (verified by permutation tests). Returns `null` for an empty list.
 */
export function pickCanonicalCommitment(
  candidates: readonly SemanticCommitmentCandidate[],
): SemanticCommitmentCandidate | null {
  if (candidates.length === 0) {
    return null;
  }
  let best = candidates[0]!;
  let bestPriority = COMMITMENT_STATE_PRIORITY.indexOf(best.state);
  if (bestPriority === -1) bestPriority = Number.MAX_SAFE_INTEGER;
  let bestKey = deriveCommitmentKey(best);
  for (let i = 1; i < candidates.length; i += 1) {
    const candidate = candidates[i]!;
    let priority = COMMITMENT_STATE_PRIORITY.indexOf(candidate.state);
    if (priority === -1) priority = Number.MAX_SAFE_INTEGER;
    const key = deriveCommitmentKey(candidate);
    if (priority < bestPriority || (priority === bestPriority && key < bestKey)) {
      best = candidate;
      bestPriority = priority;
      bestKey = key;
    }
  }
  return best;
}

export function createInitialSafeRoomRouteState(): SafeRoomRouteState {
  return {
    phase: 'idle',
    originRoomId: null,
    navEpoch: null,
    commitmentKey: null,
    path: [],
    segmentIndex: 0,
    lastReseedCause: null,
    totalActivations: 0,
    totalCompletions: 0,
    totalBlocked: 0,
    totalReseeds: 0,
  };
}

function toIdle(prev: SafeRoomRouteState): SafeRoomRouteState {
  return {
    ...prev,
    phase: 'idle',
    originRoomId: null,
    navEpoch: null,
    commitmentKey: null,
    path: [],
    segmentIndex: 0,
  };
}

/** Initial `segmentIndex` skipping any leading path tiles identical to the
 * player's own current tile — mirrors `moveToward`'s own `pathIndex` init
 * convention exactly, so a same-tile first waypoint never wastes a frame. */
function initialSegmentIndex(path: readonly TilePoint[], playerTile: TilePoint): number {
  const idx = path.findIndex((tile) => tile.x !== playerTile.x || tile.y !== playerTile.y);
  return idx === -1 ? Math.min(1, path.length - 1) : idx;
}

function computeRoute(
  prev: SafeRoomRouteState,
  input: SafeRoomRouteInput,
  deps: SafeRoomRouteDeps,
  originRoomId: number,
  commitmentKey: string,
  playerTile: TilePoint,
  anchorTile: TilePoint,
  cause: 'activation' | 'commitment-change' | 'nav-epoch-change',
): SafeRoomRouteUpdateResult {
  const fullPath = deps.findPath(playerTile, anchorTile);
  if (fullPath.length === 0) {
    const state: SafeRoomRouteState = {
      ...prev,
      phase: 'blocked',
      originRoomId,
      navEpoch: input.navEpoch,
      commitmentKey,
      path: [],
      segmentIndex: 0,
      lastReseedCause: cause,
      totalBlocked: prev.totalBlocked + 1,
    };
    return { state, moveTarget: null, blocked: true };
  }

  // First path index that has genuinely left the origin room. Door/wall tiles
  // are never part of any room's interior mask (`getRoomAt` returns a negative
  // id for them), so this index naturally lands at-or-just-past the doorway.
  // `playerTile` (index 0) is guaranteed to classify as `originRoomId` by the
  // caller's activation gate, so this loop cannot break on i === 0.
  let exitIndex = fullPath.length - 1;
  for (let i = 0; i < fullPath.length; i += 1) {
    const tile = fullPath[i]!;
    if (deps.getRoomAt(tile.x, tile.y) !== originRoomId) {
      exitIndex = i;
      break;
    }
  }
  const truncatedEnd = Math.min(fullPath.length - 1, exitIndex + SAFE_ROOM_ROUTE_EXIT_BUFFER_TILES);
  const path = fullPath.slice(0, truncatedEnd + 1);
  const segmentIndex = initialSegmentIndex(path, playerTile);

  const state: SafeRoomRouteState = {
    ...prev,
    phase: 'active',
    originRoomId,
    navEpoch: input.navEpoch,
    commitmentKey,
    path,
    segmentIndex,
    lastReseedCause: cause,
  };
  if (segmentIndex >= path.length) {
    // Degenerate single-tile path (player already standing on the only exit
    // tile) — treat as immediately complete rather than dereference past the
    // array end.
    return completeRoute(state);
  }
  // Feed the legal prefix ENDPOINT to the existing door-aware movement
  // controller. Passing each intermediate path tile back through a second A*
  // layer can turn a door-center tile into an unreachable local goal for the
  // player's collision body. The full path remains the geometry certificate
  // and progress record; moveToward owns its intermediate waypoint/wedge
  // recovery exactly once.
  const endpoint = path[path.length - 1]!;
  const moveTarget = deps.tileToWorld(endpoint.x, endpoint.y);
  return { state, moveTarget, blocked: false };
}

function completeRoute(prev: SafeRoomRouteState): SafeRoomRouteUpdateResult {
  const state: SafeRoomRouteState = {
    ...toIdle(prev),
    totalCompletions: prev.totalCompletions + 1,
  };
  return { state, moveTarget: null, blocked: false };
}

/** Same-room / no-room-data pass-through: leaves `prev` structurally
 * unchanged (returns it by reference) so the common "not routing" case
 * allocates nothing per poll. */
function passThrough(prev: SafeRoomRouteState): SafeRoomRouteUpdateResult {
  return { state: prev, moveTarget: null, blocked: false };
}

function tryActivate(
  prev: SafeRoomRouteState,
  input: SafeRoomRouteInput,
  deps: SafeRoomRouteDeps,
  commitmentKey: string,
  cause: 'activation' | 'commitment-change' | 'nav-epoch-change',
): SafeRoomRouteUpdateResult {
  const playerTile = deps.worldToTile(input.playerX, input.playerY);
  const originRoomId = deps.getRoomAt(playerTile.x, playerTile.y);
  if (originRoomId < 0 || !deps.isSafeRoomId(originRoomId)) {
    // No known origin safe room (no room graph data, or the player is not
    // classified into a registered SAFE room) — nothing to constrain.
    return passThrough(prev.phase === 'idle' ? prev : toIdle(prev));
  }
  const anchorTile = deps.worldToTile(
    input.candidate.targetX ?? input.playerX,
    input.candidate.targetY ?? input.playerY,
  );
  const anchorRoomId = deps.getRoomAt(anchorTile.x, anchorTile.y);
  if (anchorRoomId === originRoomId) {
    // Same-safe-space bypass: the selected target is inside the same origin
    // room, so normal distance gates apply directly — no route needed.
    return passThrough(prev.phase === 'idle' ? prev : toIdle(prev));
  }
  return computeRoute(
    prev,
    input,
    deps,
    originRoomId,
    commitmentKey,
    playerTile,
    anchorTile,
    cause,
  );
}

function candidateRoomId(input: SafeRoomRouteInput, deps: SafeRoomRouteDeps): number {
  const anchorTile = deps.worldToTile(
    input.candidate.targetX ?? input.playerX,
    input.candidate.targetY ?? input.playerY,
  );
  return deps.getRoomAt(anchorTile.x, anchorTile.y);
}

/**
 * Advance the safe-room route overlay by exactly one poll. Pure function: same
 * inputs always produce the same outputs, and neither `input` nor `deps` are
 * mutated. Never touches `AIDecision` — callers apply `moveTarget` only to
 * movement execution.
 */
export function updateSafeRoomRouteState(
  prev: SafeRoomRouteState,
  input: SafeRoomRouteInput,
  deps: SafeRoomRouteDeps,
): SafeRoomRouteUpdateResult {
  const commitmentKey = deriveCommitmentKey(input.candidate);

  if (prev.phase === 'idle') {
    if (!input.playerInSafeRoom) {
      return passThrough(prev);
    }
    const activated = tryActivate(prev, input, deps, commitmentKey, 'activation');
    if (activated.state.phase !== 'idle') {
      return {
        ...activated,
        state: { ...activated.state, totalActivations: prev.totalActivations + 1 },
      };
    }
    return activated;
  }

  // A live entity can enter the origin room without changing its stable
  // commitment key. Re-check geometry every poll so same-space interactions
  // release immediately instead of waiting for a topology epoch.
  if (candidateRoomId(input, deps) === prev.originRoomId) {
    return passThrough(toIdle(prev));
  }

  let current = prev;

  // An active path is a geometry segment, not a lease on the semantic target.
  // External-to-external winner changes do not invalidate that already-legal
  // prefix: keep advancing it and only update diagnostic identity. A blocked
  // route is different — a new external target may have a legal path, so it
  // gets one deterministic retry.
  if (commitmentKey !== prev.commitmentKey) {
    if (prev.phase === 'blocked') {
      return tryActivate(
        { ...prev, totalReseeds: prev.totalReseeds + 1 },
        input,
        deps,
        commitmentKey,
        'commitment-change',
      );
    }
    current = { ...prev, commitmentKey };
  }
  if (input.navEpoch !== current.navEpoch) {
    return tryActivate(
      { ...current, totalReseeds: current.totalReseeds + 1 },
      input,
      deps,
      commitmentKey,
      'nav-epoch-change',
    );
  }

  if (current.phase === 'blocked') {
    // Before freezing: if the player has left the origin room (different room
    // id or exterior), the route constraint no longer applies — return idle
    // pass-through so movement resumes freely toward the semantic target. Use
    // room membership (not the raw `playerInSafeRoom` boolean) to avoid
    // mouth-boundary flicker where `playerInSafeRoom` lags one tile behind the
    // actual room transition.
    const playerTile = deps.worldToTile(input.playerX, input.playerY);
    const currentRoomId = deps.getRoomAt(playerTile.x, playerTile.y);
    if (currentRoomId !== current.originRoomId) {
      return passThrough(toIdle(current));
    }
    // Stay frozen — no per-poll A* while blocked and nothing changed.
    return { state: current, moveTarget: null, blocked: true };
  }

  // Steady state: advance the monotonic segment index. Loop so a fast player
  // crossing multiple short segments in one poll (e.g. a low-frame-rate poll
  // interval) still lands on the correct next unreached waypoint.
  const path = current.path;
  if (path.length === 0) {
    return completeRoute(current);
  }
  const endpoint = path[path.length - 1]!;
  const endpointWorld = deps.tileToWorld(endpoint.x, endpoint.y);
  if (
    Math.hypot(input.playerX - endpointWorld.x, input.playerY - endpointWorld.y) <=
    SAFE_ROOM_ROUTE_ARRIVE_FT
  ) {
    return completeRoute({ ...current, segmentIndex: path.length });
  }
  let segmentIndex = current.segmentIndex;
  while (segmentIndex < path.length) {
    const waypoint = path[segmentIndex]!;
    const worldPoint = deps.tileToWorld(waypoint.x, waypoint.y);
    const distFt = Math.hypot(input.playerX - worldPoint.x, input.playerY - worldPoint.y);
    if (distFt > SAFE_ROOM_ROUTE_ARRIVE_FT) {
      break;
    }
    segmentIndex += 1;
  }
  if (segmentIndex >= path.length) {
    return completeRoute({ ...current, segmentIndex });
  }
  return { state: { ...current, segmentIndex }, moveTarget: endpointWorld, blocked: false };
}

/** Compact, durable diagnostics snapshot for provider/telemetry exposure. */
export interface SafeRoomRouteDebugSnapshot {
  readonly phase: SafeRoomRoutePhase;
  readonly originRoomId: number | null;
  readonly segmentIndex: number;
  readonly pathLength: number;
  readonly lastReseedCause: SafeRoomRouteState['lastReseedCause'];
  readonly totalActivations: number;
  readonly totalCompletions: number;
  readonly totalBlocked: number;
  readonly totalReseeds: number;
}

export function toSafeRoomRouteDebugSnapshot(
  state: SafeRoomRouteState,
): SafeRoomRouteDebugSnapshot {
  return {
    phase: state.phase,
    originRoomId: state.originRoomId,
    segmentIndex: state.segmentIndex,
    pathLength: state.path.length,
    lastReseedCause: state.lastReseedCause,
    totalActivations: state.totalActivations,
    totalCompletions: state.totalCompletions,
    totalBlocked: state.totalBlocked,
    totalReseeds: state.totalReseeds,
  };
}
