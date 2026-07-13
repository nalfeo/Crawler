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
  readonly lastReseedCause:
    | 'activation'
    | 'commitment-change'
    | 'nav-epoch-change'
    | 'no-progress'
    | null;
  /** Closest distance (feet) to {@link attemptExitTile} observed since the
   * current egress ATTEMPT began (see `attemptExitKey` — this is now scoped
   * to "trying to reach this specific door", not to a single unbroken
   * `'active'` burst). `Infinity` when no attempt is tracked. Drives the
   * no-progress watchdog — diagnostic-adjacent but DOES influence behavior
   * (unlike the lifetime counters below). */
  readonly bestEndpointDistanceFt: number;
  /** Consecutive MEASURED polls since `bestEndpointDistanceFt` last improved
   * by at least {@link SAFE_ROOM_ROUTE_PROGRESS_EPSILON_FT}. Persists across
   * brief same-room-bypass interludes (e.g. Retreat fleeing to a point
   * inside the room) as long as the attempt itself survives — see
   * `attemptExitKey`/`attemptDormantFrames` — so combat-driven Retreat/
   * Engage/Collect churn near a doorway cannot silently reset this counter
   * to 0 every cycle and mask a genuine multi-second stall (found via the
   * canonical 600-run cloud gate, 2026-07-13: 3 previously-clean seeds
   * regressed to timeouts because each individual burst between rapid
   * same-room interruptions looked locally healthy). */
  readonly noProgressFrames: number;
  /** Stable identity of the door/exit tile the current egress ATTEMPT is
   * measured against: `"${originRoomId}:${tileX},${tileY}"` of the first
   * tile classified outside the origin room (the pre-buffer exit-index
   * tile — topologically stable regardless of which specific external
   * target/state chose this door). `null` when no attempt is tracked. A
   * fresh (re)activation only CONTINUES `bestEndpointDistanceFt`/
   * `noProgressFrames` when its resolved exit tile matches this key;
   * otherwise it starts a brand-new attempt. Scoping to the specific exit
   * (not the whole room) means an unrelated, easily-reachable target
   * through a DIFFERENT door in a multi-door room is never penalized by a
   * stall on this one. */
  readonly attemptExitKey: string | null;
  /** The exit tile itself (see {@link attemptExitKey}), stored so progress
   * can be measured every poll — including same-room-bypass interludes,
   * where there is no `path` to derive it from. `null` when no attempt is
   * tracked. */
  readonly attemptExitTile: TilePoint | null;
  /** Consecutive polls where the CURRENT candidate needed no egress at all
   * (a same-room-bypass poll) while an attempt was still live. A generous
   * decay safety-valve: if this exceeds
   * {@link SAFE_ROOM_ROUTE_ATTEMPT_DORMANT_FRAMES} the attempt is retired
   * (the player has genuinely settled, not just blipped through a transient
   * Retreat-to-safety detour) — chosen far above any realistic single
   * combat-driven interruption so rapid state oscillation cannot exploit it
   * to keep re-arming a fresh budget. Resets to 0 whenever the attempt is
   * actively measured (steady-state active polls). */
  readonly attemptDormantFrames: number;
  /** Commitment key a no-progress release just gave up on, or `null` when
   * nothing is suppressed. While non-null and {@link suppressFramesRemaining}
   * is positive, re-activation is skipped for THIS EXACT commitment (a
   * different commitment always activates immediately — suppression is
   * scoped to "stop immediately re-fighting the same losing battle", never a
   * blanket freeze). Without this, a stall that keeps re-selecting the same
   * external target would thrash active(45 polls)/idle(1 poll) forever,
   * recomputing A* every cycle — confirmed via direct reducer repro during
   * multi-model review (2026-07-13). */
  readonly suppressedCommitmentKey: string | null;
  /** Countdown of polls remaining before {@link suppressedCommitmentKey}
   * becomes eligible to reactivate. `0` when nothing is suppressed. */
  readonly suppressFramesRemaining: number;
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
 * provider's tuning module; instead the literal is exported test-only and a
 * dedicated test in `tests/game/safe-room-route.test.ts` asserts it stays
 * equal to `WAYPOINT_ARRIVE_FT` so the two arrival radii cannot silently
 * diverge. */
export const SAFE_ROOM_ROUTE_ARRIVE_FT = 1;

/** No-progress watchdog thresholds for an `'active'` route. A route's
 * completion is normally driven purely by proximity to its precomputed exit
 * path (never by re-checking `world.playerInSafeRoom`), which assumes the
 * player is always free to close on the endpoint. That assumption breaks
 * when something ELSE holds the player in place near the doorway — most
 * commonly sustained melee combat with an enemy that follows/roots them —
 * since the route intentionally does not reseed on ordinary external winner
 * changes (see the module doc), so without a bound it can stay `'active'`
 * and keep overriding movement toward a now-unreachable-in-practice endpoint
 * indefinitely, permanently blocking the AI's own combat movement even after
 * the player has already physically crossed the threshold. Discovered via
 * the canonical 600-run cloud gate (2026-07-13): 84/100 of one weapon's
 * stuck runs had an unfinished route with zero measured progress. Mirrors
 * the no-progress release the deleted `LeaveSafeRoom` owner node used to
 * provide (`SAFE_ROOM_EGRESS_NO_PROGRESS_FRAMES`/`_PROGRESS_EPSILON_FT`) —
 * reintroduced here as a bounded stall detector on the ONE thing this module
 * actually owns (its own path-following progress), not as a reseed-on-any-
 * winner-change regression. Exported so tests assert against the real
 * thresholds instead of duplicating magic numbers that could silently drift. */
export const SAFE_ROOM_ROUTE_NO_PROGRESS_FRAMES = 45;
export const SAFE_ROOM_ROUTE_PROGRESS_EPSILON_FT = 3;

/** Cooldown (polls) after a no-progress release before the SAME commitment
 * (same `commitmentKey`) is eligible to reactivate. A different commitment
 * (e.g. the semantic winner genuinely changed) is never subject to this
 * suppression and activates immediately — this only stops the reducer from
 * immediately re-fighting the identical losing battle. Without this, a
 * multi-model review round found the reducer would thrash
 * active(~45 polls)/idle(1 poll) forever under an unchanged stuck input,
 * recomputing A* every cycle. Mirrors the deleted `LeaveSafeRoom` owner
 * node's `SAFE_ROOM_EGRESS_SUPPRESS_FRAMES` (same value, previously
 * calibrated and shipped). */
export const SAFE_ROOM_ROUTE_SUPPRESS_FRAMES = 120;

/** Decay safety-valve (polls) for an egress ATTEMPT (see `attemptExitKey`).
 * A same-room-bypass poll (no egress needed this poll — e.g. Retreat fleeing
 * to a point inside the room) does NOT clear the attempt's stall bookkeeping
 * on its own — that is the entire point of tracking progress at the
 * attempt level instead of per-`'active'`-burst — but an attempt still must
 * not linger forever if the player has genuinely settled (killed the
 * swarm, is calmly shopping/crafting) rather than merely blipped through a
 * transient interruption. `attemptDormantFrames` counts CONSECUTIVE
 * same-room-bypass polls; crossing this threshold fully retires the
 * attempt. Chosen (30s @ 60fps) far above any realistic single combat-
 * driven Retreat/Engage/Collect oscillation period (observed ~10-20 frames
 * in the regression trace) specifically so rapid state churn CANNOT exploit
 * it to keep re-arming a fresh no-progress budget every cycle — a much
 * shorter threshold was rejected in adversarial review for exactly this
 * gameability risk. */
export const SAFE_ROOM_ROUTE_ATTEMPT_DORMANT_FRAMES = 1800;

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
    bestEndpointDistanceFt: Number.POSITIVE_INFINITY,
    noProgressFrames: 0,
    attemptExitKey: null,
    attemptExitTile: null,
    attemptDormantFrames: 0,
    suppressedCommitmentKey: null,
    suppressFramesRemaining: 0,
    totalActivations: 0,
    totalCompletions: 0,
    totalBlocked: 0,
    totalReseeds: 0,
  };
}

/** Base idle transition. Deliberately does NOT touch the egress-attempt
 * fields (`bestEndpointDistanceFt`/`noProgressFrames`/`attemptExitKey`/
 * `attemptExitTile`/`attemptDormantFrames`) — different callers need
 * different attempt-clearing behavior (a transient same-room-bypass MUST
 * preserve the attempt; a genuine completion/give-up/room-exit MUST clear
 * it), so each call site decides explicitly via `retireAttempt(...)` or by
 * passing already-updated attempt fields through the spread below. */
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

/** Fully retires a live egress attempt: clears `bestEndpointDistanceFt`/
 * `noProgressFrames`/`attemptExitKey`/`attemptExitTile`/`attemptDormantFrames`
 * back to their cold-start values. Used wherever an attempt is genuinely
 * done — success, give-up, the player physically leaving the origin room,
 * or an external abort — as opposed to a transient same-room-bypass
 * interlude, which deliberately preserves the attempt (see
 * `measureAttemptProgress`). */
function retireAttempt(state: SafeRoomRouteState): SafeRoomRouteState {
  return {
    ...state,
    bestEndpointDistanceFt: Number.POSITIVE_INFINITY,
    noProgressFrames: 0,
    attemptExitKey: null,
    attemptExitTile: null,
    attemptDormantFrames: 0,
  };
}

/**
 * Externally-triggered abort (e.g. a hostile encounter invalidating the
 * semantic decision, or the caller losing floor-map data): releases to idle
 * WITHOUT touching the lifetime diagnostic counters. Prefer this over
 * {@link createInitialSafeRoomRouteState} for any mid-run interrupt — the
 * fresh-state constructor is only for true cold-start (provider construction/
 * `reset()`), since it zeroes `totalActivations`/`totalCompletions`/
 * `totalBlocked`/`totalReseeds`, silently discarding lifetime telemetry that
 * sweep artifacts and divergence investigations rely on.
 *
 * ALSO retires any live egress attempt and suppression window: an abort is a
 * genuine "start fresh" moment (e.g. hostile-encounter invalidation just
 * discarded the entire semantic decision and dozens of other transient
 * fields), so leftover stall bookkeeping or a cooldown from an unrelated
 * earlier attempt must not linger or block the next commitment even if it
 * happens to resolve to the same door. This is intentionally a SEPARATE code
 * path from the no-progress release itself and from a transient same-room
 * bypass (both of which manage attempt state directly) — only an external
 * abort forces a full retire.
 */
export function abortSafeRoomRoute(prev: SafeRoomRouteState): SafeRoomRouteState {
  return {
    ...retireAttempt(toIdle(prev)),
    suppressedCommitmentKey: null,
    suppressFramesRemaining: 0,
  };
}

/** Initial `segmentIndex` skipping any leading path tiles identical to the
 * player's own current tile — mirrors `moveToward`'s own `pathIndex` init
 * convention exactly, so a same-tile first waypoint never wastes a frame.
 * Always returns an index `< path.length` for a non-empty path (bounded by
 * `Math.min(1, path.length - 1)` in the degenerate single-tile case), so a
 * freshly-activated route is never "already complete" on its own first poll
 * — the degenerate single-tile-path case (player already standing on the
 * only exit tile) resolves one poll later via the endpoint-distance
 * completion check in {@link updateSafeRoomRouteState}'s steady-state
 * branch, not via an early-completion guard here. */
function initialSegmentIndex(path: readonly TilePoint[], playerTile: TilePoint): number {
  const idx = path.findIndex((tile) => tile.x !== playerTile.x || tile.y !== playerTile.y);
  return idx === -1 ? Math.min(1, path.length - 1) : idx;
}

/** Stable identity for an egress attempt: room id + the specific door/exit
 * tile. Two (re)activations that resolve the SAME door produce the same
 * key regardless of which external target/state chose it, which is what
 * lets `bestEndpointDistanceFt`/`noProgressFrames` survive brief same-room
 * interludes and rapid semantic-winner churn between them — while a
 * genuinely DIFFERENT door (multi-door room, different target) still gets
 * its own independent, unpenalized attempt. */
function attemptExitKeyFor(originRoomId: number, exitTile: TilePoint): string {
  return `${originRoomId}:${exitTile.x},${exitTile.y}`;
}

/** Measures this poll's progress against the current egress attempt's fixed
 * exit tile (not the per-activation buffered path endpoint, which can shift
 * slightly between reactivations even for "the same door"). Shared by the
 * steady-state `'active'` branch and the same-room-bypass interlude so both
 * update the SAME persistent counters with the SAME epsilon logic — this is
 * what lets stall detection span a burst of Retreat/Engage/Collect churn
 * instead of being wiped every time the semantic winner changes. Returns
 * `prev`'s values unchanged when no attempt is tracked. */
function measureAttemptProgress(
  prev: SafeRoomRouteState,
  deps: SafeRoomRouteDeps,
  playerX: number,
  playerY: number,
): { bestDistanceFt: number; noProgressFrames: number } {
  if (!prev.attemptExitTile) {
    return { bestDistanceFt: prev.bestEndpointDistanceFt, noProgressFrames: prev.noProgressFrames };
  }
  const exitWorld = deps.tileToWorld(prev.attemptExitTile.x, prev.attemptExitTile.y);
  const distFt = Math.hypot(playerX - exitWorld.x, playerY - exitWorld.y);
  const improved = distFt <= prev.bestEndpointDistanceFt - SAFE_ROOM_ROUTE_PROGRESS_EPSILON_FT;
  return {
    bestDistanceFt: improved ? distFt : prev.bestEndpointDistanceFt,
    noProgressFrames: improved ? 0 : prev.noProgressFrames + 1,
  };
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
      // No legal path at all ⇒ no exit tile is resolvable, so there is
      // nothing stable left to measure an attempt against; a subsequent
      // successful (re)activation always re-derives (continuing or fresh)
      // from its own resolved exit tile regardless of what is left here.
      bestEndpointDistanceFt: Number.POSITIVE_INFINITY,
      noProgressFrames: 0,
      suppressedCommitmentKey: null,
      suppressFramesRemaining: 0,
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
  const exitTile = fullPath[exitIndex]!;
  const exitKey = attemptExitKeyFor(originRoomId, exitTile);
  // Continue the SAME egress attempt (carry forward its stall bookkeeping)
  // only when this (re)activation resolves to the identical door as the
  // attempt already in flight; a genuinely different door always starts a
  // fresh, unpenalized attempt.
  const continuingAttempt = prev.attemptExitKey === exitKey;

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
    // Attempt-scoped watchdog baseline: continue if this (re)activation
    // targets the SAME door as the in-flight attempt (see `exitKey` above),
    // otherwise start fresh — a genuinely new door must never inherit a
    // different door's stall history.
    bestEndpointDistanceFt: continuingAttempt
      ? prev.bestEndpointDistanceFt
      : Number.POSITIVE_INFINITY,
    noProgressFrames: continuingAttempt ? prev.noProgressFrames : 0,
    attemptExitKey: exitKey,
    attemptExitTile: exitTile,
    attemptDormantFrames: 0,
    // A successful (re)activation always clears any prior suppression —
    // suppression only exists to stop the idle branch from immediately
    // reattempting the identical commitment; once a route is genuinely
    // active again there is nothing left to suppress.
    suppressedCommitmentKey: null,
    suppressFramesRemaining: 0,
  };
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
    ...retireAttempt(toIdle(prev)),
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

/** Same-safe-space bypass: the current poll's candidate doesn't need egress
 * at all (its target/anchor is inside the origin room — e.g. Retreat
 * fleeing to a point of safety inside the same room). Normal distance gates
 * apply directly (`moveTarget: null`) EVERY poll this fires, with no delay —
 * a life-critical Retreat-to-safety must never be held up by a stale egress
 * waypoint. Unlike a full `toIdle`, this deliberately PRESERVES the live
 * egress attempt's stall bookkeeping (see `measureAttemptProgress`): a
 * transient interruption must not silently reset the no-progress watchdog,
 * or rapid Retreat/Engage/Collect churn near a doorway could erase it every
 * cycle and mask a genuine multi-second stall (the exact regression found by
 * the canonical 600-run cloud gate, 2026-07-13). The attempt is only fully
 * retired after a GENEROUS sustained run of same-room polls (see
 * `SAFE_ROOM_ROUTE_ATTEMPT_DORMANT_FRAMES`), signaling the player has
 * genuinely settled rather than merely blipped through a detour. */
function sameRoomBypass(
  prev: SafeRoomRouteState,
  input: SafeRoomRouteInput,
  deps: SafeRoomRouteDeps,
): SafeRoomRouteUpdateResult {
  const idled = prev.phase === 'idle' ? prev : toIdle(prev);
  const measured = measureAttemptProgress(prev, deps, input.playerX, input.playerY);
  const dormantFrames = prev.attemptExitTile ? prev.attemptDormantFrames + 1 : 0;
  if (dormantFrames > SAFE_ROOM_ROUTE_ATTEMPT_DORMANT_FRAMES) {
    return passThrough(retireAttempt(idled));
  }
  return passThrough({
    ...idled,
    bestEndpointDistanceFt: measured.bestDistanceFt,
    noProgressFrames: measured.noProgressFrames,
    attemptDormantFrames: dormantFrames,
  });
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
    // classified into a registered SAFE room) — nothing to constrain, and no
    // stable room context to keep an attempt meaningfully scoped to, so
    // retire it fully rather than preserving stale bookkeeping.
    return passThrough(retireAttempt(prev.phase === 'idle' ? prev : toIdle(prev)));
  }
  const anchorTile = deps.worldToTile(
    input.candidate.targetX ?? input.playerX,
    input.candidate.targetY ?? input.playerY,
  );
  const anchorRoomId = deps.getRoomAt(anchorTile.x, anchorTile.y);
  if (anchorRoomId === originRoomId) {
    return sameRoomBypass(prev, input, deps);
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
    if (
      prev.suppressFramesRemaining > 0 &&
      prev.suppressedCommitmentKey !== null &&
      commitmentKey === prev.suppressedCommitmentKey
    ) {
      // Cooling down on the exact commitment a no-progress release just gave
      // up on — count down without re-running A* every poll. A DIFFERENT
      // commitment (the semantic winner genuinely changed) is never subject
      // to this and activates immediately below; suppression only stops
      // immediately re-fighting the identical losing battle.
      const remaining = prev.suppressFramesRemaining - 1;
      return passThrough({
        ...prev,
        suppressFramesRemaining: remaining,
        ...(remaining <= 0 ? { suppressedCommitmentKey: null } : {}),
      });
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
    return sameRoomBypass(prev, input, deps);
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
    // actual room transition. The player has genuinely left, so retire the
    // attempt fully rather than preserving stale stall bookkeeping.
    const playerTile = deps.worldToTile(input.playerX, input.playerY);
    const currentRoomId = deps.getRoomAt(playerTile.x, playerTile.y);
    if (currentRoomId !== current.originRoomId) {
      return passThrough(retireAttempt(toIdle(current)));
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
  const distToEndpointFt = Math.hypot(
    input.playerX - endpointWorld.x,
    input.playerY - endpointWorld.y,
  );
  if (distToEndpointFt <= SAFE_ROOM_ROUTE_ARRIVE_FT) {
    return completeRoute({ ...current, segmentIndex: path.length });
  }

  // No-progress watchdog: this route is the sole authority over movement
  // while active (the final blocked-motion-equivalent clamp substitutes its
  // moveTarget for the semantic target every poll), so if something else —
  // most commonly sustained combat with an enemy that holds/roots the player
  // near the doorway — prevents genuine forward progress toward the
  // endpoint, this module must release control back to the semantic target
  // rather than override movement indefinitely toward a goal the player
  // cannot currently reach. Measured against the STABLE exit-frontier tile
  // (`attemptExitTile`), not the buffered endpoint above, and persists
  // across same-room-bypass interludes via `measureAttemptProgress` — see
  // the constant doc and `sameRoomBypass` for how/why this was found.
  const measured = measureAttemptProgress(current, deps, input.playerX, input.playerY);
  if (measured.noProgressFrames > SAFE_ROOM_ROUTE_NO_PROGRESS_FRAMES) {
    return passThrough(
      retireAttempt(
        toIdle({
          ...current,
          lastReseedCause: 'no-progress',
          totalReseeds: current.totalReseeds + 1,
          // Suppress immediate reactivation of THIS EXACT commitment — without
          // this, an unchanged stuck input reactivates the identical route one
          // poll later and thrashes active/idle forever, recomputing A* every
          // cycle (found via multi-model review). A genuinely different
          // commitment next poll bypasses this immediately (see the idle
          // branch above).
          suppressedCommitmentKey: current.commitmentKey,
          suppressFramesRemaining: SAFE_ROOM_ROUTE_SUPPRESS_FRAMES,
        }),
      ),
    );
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
  const advanced: SafeRoomRouteState = {
    ...current,
    segmentIndex,
    bestEndpointDistanceFt: measured.bestDistanceFt,
    noProgressFrames: measured.noProgressFrames,
    attemptDormantFrames: 0,
  };
  if (segmentIndex >= path.length) {
    return completeRoute(advanced);
  }
  return { state: advanced, moveTarget: endpointWorld, blocked: false };
}

/** Compact, durable diagnostics snapshot for provider/telemetry exposure. */
export interface SafeRoomRouteDebugSnapshot {
  readonly phase: SafeRoomRoutePhase;
  readonly originRoomId: number | null;
  readonly segmentIndex: number;
  readonly pathLength: number;
  readonly lastReseedCause: SafeRoomRouteState['lastReseedCause'];
  /** Consecutive polls since the current EGRESS ATTEMPT last made measurable
   * progress toward its exit tile — persists across same-room-bypass
   * interludes as long as the attempt survives (see `attemptExitKey`). `0`
   * while no attempt is tracked or immediately after improvement. Surfaced
   * so a divergence investigation can see how close an attempt was to
   * tripping the no-progress watchdog even across a burst of semantic
   * churn. */
  readonly noProgressFrames: number;
  /** Whether an egress attempt is currently tracked (`attemptExitKey !==
   * null`) — i.e. stall bookkeeping is live even if `phase` is
   * momentarily `'idle'` via a same-room-bypass interlude. */
  readonly attemptActive: boolean;
  /** Polls remaining before a suppressed commitment (one a no-progress
   * release just gave up on) becomes eligible to reactivate. `0` when
   * nothing is suppressed. */
  readonly suppressFramesRemaining: number;
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
    noProgressFrames: state.noProgressFrames,
    attemptActive: state.attemptExitKey !== null,
    suppressFramesRemaining: state.suppressFramesRemaining,
    totalActivations: state.totalActivations,
    totalCompletions: state.totalCompletions,
    totalBlocked: state.totalBlocked,
    totalReseeds: state.totalReseeds,
  };
}
