/**
 * Predictive safe-gap travel steering — a pure, deterministic heading selector
 * that lets the AI runner *dance around* mobs while travelling to objectives
 * instead of charging straight through them.
 *
 * WHY THIS EXISTS
 * ---------------
 * The behaviour tree's ENGAGE state has an excellent close-range spacing
 * controller ({@link BehaviorTreeAI.computeMeleeKiteTarget}): it holds a desired
 * orbit radius and arcs laterally around the enemy, so the player weaves between
 * hits. Travel (EXPLORE / long-range COLLECT), by contrast, historically only
 * had an *additive* single-closest-threat "dodge nudge" bolted onto a beeline.
 * That nudge oscillates (wasting path length) yet still eats contact hits, and
 * widening it trades win-rate for damage (proven by bisecting commit f4f538d7,
 * which widened the additive dodge and flipped winning seeds to deadline
 * timeouts). See `docs/knowledge/review-ledgers/2026-07-02-...`.
 *
 * The fix is to replace the additive nudge with a proper *steering* controller:
 * each frame we fan out candidate headings around the objective direction, score
 * each on predicted safety (analytic closest-approach), forward progress, path
 * continuity (smooth arcs), and an optional kite/loot/farm bias, then pick the
 * best. Because we choose one coherent heading (rather than summing vectors) the
 * result is a smooth arc that adds far less path length than the old weave — so
 * it can cut contact damage while staying throughput-neutral (never pushing a
 * near-deadline seed over the floor-collapse budget).
 *
 * DESIGN CONSTRAINTS (enforced by tests + code review):
 * - **Pure & deterministic**: no `this`, no module state, no RNG, no wall clock.
 *   Output is fully determined by (input, params). Mirrors `bt-ai-geometry.ts`.
 * - **Damage-agnostic**: nothing here reads a hostile-damage multiplier. The
 *   AI behaves identically at 1x and 10x damage; the multiplier is only a
 *   measurement lens.
 * - **Progress-dominant**: safety only overrides progress when a real predicted
 *   contact is imminent, so detours stay small.
 * - **Never freezes**: even boxed in a hallway pincer it returns a non-zero,
 *   least-bad heading (never a zero vector).
 */

/** A perceived hostile the steering should keep spacing from. */
export interface TravelThreat {
  /** Enemy centre, world feet. */
  x: number;
  y: number;
  /** Enemy velocity, feet/frame (its *actual* current velocity — we never
   * synthesize pursuit for idle enemies; a parked enemy simply has ~0 here). */
  vx: number;
  vy: number;
  /**
   * Combined contact radius (player half-extent + this enemy's half-extent),
   * world feet. Predicted centre-to-centre distances are reduced by this so the
   * "gap" the scorer reasons about is a true surface (edge-to-edge) clearance,
   * correctly sizing big slimes vs. small rats (review concern #5).
   */
  bodyRadiusFt: number;
}

/** A pickup the steering may lightly bend toward — only when already safe. */
export interface TravelPickup {
  /** Stable entity id for debug / single-channel assertions. */
  eid?: number;
  kind?: 'xp' | 'gold' | 'item';
  x: number;
  y: number;
  /** Caller-precomputed desirability (item > xp > gold). */
  weight: number;
}

/** Everything the pure selector needs for one frame. All coords are world feet. */
export interface TravelSteeringInput {
  px: number;
  py: number;
  /** Unit direction toward the next A* waypoint / objective (Track A output). */
  objDirX: number;
  objDirY: number;
  /** Last frame's chosen unit heading (for continuity / anti-jitter). May be 0. */
  prevDirX: number;
  prevDirY: number;
  /** Player top speed, feet/frame (used for closest-approach prediction). */
  playerSpeedFtPerFrame: number;
  /** Persistent orbit direction (+1/-1) shared with the engage kite. */
  orbitSign: 1 | -1;
  /** When true, suppress loot/farm bias and bias hard toward safety+progress. */
  panic: boolean;
  /** Active weapon reach, world feet (for the farm strike-band bias). */
  weaponReachFt: number;
  /** Caller-precomputed gate: health high enough & not panicking to farm. */
  farmEligible: boolean;
  threats: readonly TravelThreat[];
  pickups: readonly TravelPickup[];
  /**
   * Door-aware passability predicate in **world** coordinates. The wrapper wraps
   * {@link buildDoorAwarePassable} (which is tile-space) so the steering never
   * refuses a quest-critical closed-but-openable door (review concern #2).
   */
  probePassable: (worldX: number, worldY: number) => boolean;
}

/** Tunable weights & thresholds (sourced from bt-ai-tuning by the wrapper). */
export interface TravelSteeringParams {
  /** Surface gaps (edge-to-edge feet). Below hard = contact danger. */
  hardGapFt: number;
  safeGapFt: number;
  comfortGapFt: number;
  /** Only threats within this centre distance (feet) are considered. */
  threatRadiusFt: number;
  /** Prediction horizon, frames. */
  horizonFrames: number;
  /** Candidate heading offsets from objDir, degrees (mirrored ±). */
  candidateOffsetsDeg: readonly number[];
  /** Wall-probe sample distances along a candidate, feet (ascending). */
  wallProbeDistancesFt: readonly number[];
  /** Minimum progress dot for a candidate to count as "progressing". */
  minSafeProgressDot: number;
  wProgress: number;
  wSafety: number;
  wContinuity: number;
  wKite: number;
  wLoot: number;
  wFarm: number;
  /** Loot corridor lookahead & half-width, feet. */
  lootLookaheadFt: number;
  lootCorridorFt: number;
  /**
   * Trivial-pickup snap radius, feet. A pickup this close is grabbed by steering
   * straight at it (rather than merely biasing the arc), because the corridor
   * bias alone curves *near* a gem without ever overlapping it — the "walked
   * right past free XP" behaviour. 0 disables the snap.
   */
  lootSnapFt: number;
  /** |Vrel|² below this ⇒ treat closest-approach as degenerate (near-parallel). */
  relSpeedEpsilonSq: number;
}

/** Per-candidate scoring breakdown (exposed for testability). */
export interface TravelCandidateScore {
  dirX: number;
  dirY: number;
  passable: boolean;
  minGapFt: number;
  progressDot: number;
  threatCost: number;
  wallPenalty: number;
  kiteBonus: number;
  lootBonus: number;
  bestPickupEid: number | null;
  farmBonus: number;
  score: number;
}

export interface TravelSteeringResult {
  moveX: number;
  moveY: number;
  minPredictedGapFt: number;
  progressDot: number;
  threatCost: number;
  lootBonus: number;
  farmBonus: number;
  score: number;
  selectedCandidateX: number | null;
  selectedCandidateY: number | null;
  selectedPickupEid: number | null;
  /** True when contact is imminent / no safe lane exists — caller may bypass
   * heading smoothing so the dodge is not blended away. */
  emergency: boolean;
  reason: string;
}

const EPSILON = 1e-6;

// A wall detected within the probe fan is penalized enough to outweigh the
// kite/continuity biases (so we never arc *toward* a wall when an open lane
// exists), but far below the real threat-contact cost (avoiding an enemy always
// beats avoiding a distant wall). MIN applies at the farthest probe; MAX just
// beyond the (already-impassable) immediate probe.
const WALL_PENALTY_MIN = 2.4;
const WALL_PENALTY_MAX = 6;

/**
 * Lateral orbit tangent around an enemy, matching the engage kite exactly.
 *
 * In {@link BehaviorTreeAI.computeMeleeKiteTarget} the strafe direction is
 * `tx = -uy*sign, ty = ux*sign` where `(ux,uy)` is the unit **enemy→player**
 * vector. Reusing the identical formula here is what makes travel "dance" around
 * a mob the same way ENGAGE orbits it. Duplicated (rather than refactoring the
 * engage method) so the battle-tested kite stays untouched (review concern #9).
 */
export function extractKiteTangent(
  px: number,
  py: number,
  enemyX: number,
  enemyY: number,
  sign: 1 | -1,
): { x: number; y: number } {
  const rx = px - enemyX;
  const ry = py - enemyY;
  const dist = Math.hypot(rx, ry);
  // Enemy on top of us (dist ≈ 0): fall back to an arbitrary outward axis
  // (ux=1, uy=0) so the tangent is still a valid unit vector (matches the kite
  // fallback); otherwise normalize the enemy→player axis.
  const ux = dist < EPSILON ? 1 : rx / dist;
  const uy = dist < EPSILON ? 0 : ry / dist;
  return { x: -uy * sign, y: ux * sign };
}

/**
 * Predicted minimum *surface* gap (feet) between the player travelling along a
 * unit candidate heading and one threat, over the horizon.
 *
 * Works in the player's reference frame: the threat's relative start is
 * `W0 = E0 - P0` and relative velocity `Wv = Ve - Vp`. The closest approach to
 * the origin occurs at `t* = clamp(-(W0·Wv)/|Wv|², 0, horizon)`; the gap is
 * `|W0 + Wv·t*|` minus the combined body radius. This is exact (no sampling
 * aliasing) and unifies moving and parked threats — a parked enemy simply has
 * `Ve ≈ 0`, so it only penalizes candidates whose path passes near it and never
 * invents pursuit (review concerns #6, #7).
 */
export function predictedMinGapFt(
  px: number,
  py: number,
  candDirX: number,
  candDirY: number,
  playerSpeedFtPerFrame: number,
  threat: TravelThreat,
  horizonFrames: number,
  relSpeedEpsilonSq: number,
): number {
  const vpx = candDirX * playerSpeedFtPerFrame;
  const vpy = candDirY * playerSpeedFtPerFrame;
  const w0x = threat.x - px;
  const w0y = threat.y - py;
  const wvx = threat.vx - vpx;
  const wvy = threat.vy - vpy;
  const relSpeedSq = wvx * wvx + wvy * wvy;

  let tStar: number;
  if (relSpeedSq < relSpeedEpsilonSq) {
    // Near-parallel / co-moving: closest approach is at an endpoint; the current
    // gap is already the min, so t*=0 is correct and cheap.
    tStar = 0;
  } else {
    const raw = -(w0x * wvx + w0y * wvy) / relSpeedSq;
    tStar = raw < 0 ? 0 : raw > horizonFrames ? horizonFrames : raw;
  }
  const cx = w0x + wvx * tStar;
  const cy = w0y + wvy * tStar;
  const centreGap = Math.hypot(cx, cy);
  return centreGap - threat.bodyRadiusFt;
}

/**
 * Tiered gap penalty. Steep near contact so safety only dominates when actually
 * threatened; a gentle comfort term nudges toward extra spacing when otherwise
 * indifferent, without ever forcing a costly detour.
 */
function gapPenalty(gapFt: number, params: TravelSteeringParams): number {
  const { hardGapFt, safeGapFt, comfortGapFt } = params;
  if (gapFt < hardGapFt) {
    const t = (hardGapFt - gapFt) / Math.max(hardGapFt, EPSILON);
    return 100 + t * t * 100;
  }
  if (gapFt < safeGapFt) {
    const t = (safeGapFt - gapFt) / Math.max(safeGapFt - hardGapFt, EPSILON);
    return 1 + t * t * t * t * 9;
  }
  if (gapFt < comfortGapFt) {
    const t = (comfortGapFt - gapFt) / Math.max(comfortGapFt - safeGapFt, EPSILON);
    return t * t * 0.4;
  }
  return 0;
}

/**
 * Build the fan of candidate unit headings by rotating `objDir` by each offset
 * (and its mirror). Fine spacing near objDir (cheap arcs), coarse toward the
 * back (only used in true pincers). Returns objDir first so a no-threat frame
 * trivially keeps the beeline.
 */
export function buildTravelCandidateFan(
  objDirX: number,
  objDirY: number,
  offsetsDeg: readonly number[],
): { x: number; y: number }[] {
  const fan: { x: number; y: number }[] = [];
  const seen = new Set<number>();
  const push = (deg: number): void => {
    // De-dupe 0 and ±180 mirrors.
    const key = ((deg % 360) + 360) % 360;
    if (seen.has(key)) return;
    seen.add(key);
    const rad = (deg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    fan.push({ x: objDirX * cos - objDirY * sin, y: objDirX * sin + objDirY * cos });
  };
  for (const off of offsetsDeg) {
    push(off);
    if (off !== 0 && off !== 180 && off !== -180) {
      push(-off);
    }
  }
  return fan;
}

/**
 * Score one candidate heading. Exposed for unit tests so each term
 * (progress / safety / continuity / kite / loot / farm / wall) can be asserted
 * independently.
 */
export function scoreTravelCandidate(
  candDirX: number,
  candDirY: number,
  input: TravelSteeringInput,
  params: TravelSteeringParams,
): TravelCandidateScore {
  const { px, py, objDirX, objDirY, prevDirX, prevDirY } = input;

  // --- Wall probing (door-aware, world-space) ---
  let nearestBlocked = Number.POSITIVE_INFINITY;
  for (const d of params.wallProbeDistancesFt) {
    if (!input.probePassable(px + candDirX * d, py + candDirY * d)) {
      nearestBlocked = d;
      break;
    }
  }
  const immediateProbe = params.wallProbeDistancesFt[0] ?? 0;
  // Passable unless we would walk into a wall within the *first* probe step; a
  // wall farther ahead is only penalized (we may turn before reaching it).
  const passable = nearestBlocked > immediateProbe;
  const maxProbe = params.wallProbeDistancesFt[params.wallProbeDistancesFt.length - 1] ?? 1;
  // Any wall detected within the probe fan carries a penalty that outweighs the
  // kite/continuity biases (so the AI never arcs *toward* a wall when an open
  // lane exists), scaling up as the wall gets closer. A floor (WALL_PENALTY_MIN)
  // applies even at the farthest probe so a wall at max range is not free.
  let wallPenalty = 0;
  if (Number.isFinite(nearestBlocked)) {
    const span = Math.max(maxProbe - immediateProbe, EPSILON);
    const closeness = Math.max(0, Math.min(1, (maxProbe - nearestBlocked) / span));
    wallPenalty = WALL_PENALTY_MIN + (WALL_PENALTY_MAX - WALL_PENALTY_MIN) * closeness;
  }

  // --- Predicted safety over all in-radius threats ---
  let minGapFt = Number.POSITIVE_INFINITY;
  let threatCost = 0;
  let nearestThreat: TravelThreat | null = null;
  let nearestThreatCentre = Number.POSITIVE_INFINITY;
  for (const threat of input.threats) {
    const centreDist = Math.hypot(threat.x - px, threat.y - py);
    if (centreDist > params.threatRadiusFt) continue;
    const gap = predictedMinGapFt(
      px,
      py,
      candDirX,
      candDirY,
      input.playerSpeedFtPerFrame,
      threat,
      params.horizonFrames,
      params.relSpeedEpsilonSq,
    );
    if (gap < minGapFt) minGapFt = gap;
    threatCost += gapPenalty(gap, params);
    if (centreDist < nearestThreatCentre) {
      nearestThreatCentre = centreDist;
      nearestThreat = threat;
    }
  }

  const progressDot = candDirX * objDirX + candDirY * objDirY;
  const continuity = candDirX * prevDirX + candDirY * prevDirY;

  // --- Kite bias: arc around the nearest threat exactly like the engage kite ---
  let kiteBonus = 0;
  if (nearestThreat) {
    const tan = extractKiteTangent(px, py, nearestThreat.x, nearestThreat.y, input.orbitSign);
    kiteBonus = candDirX * tan.x + candDirY * tan.y;
  }

  const safe = minGapFt >= params.safeGapFt;
  const progressing = progressDot >= params.minSafeProgressDot;

  // --- Loot bias: only when already safe & progressing & not panicking ---
  let lootBonus = 0;
  let bestPickupEid: number | null = null;
  let bestPickupContribution = 0;
  if (params.wLoot > 0 && safe && progressing && !input.panic) {
    for (const pickup of input.pickups) {
      const rx = pickup.x - px;
      const ry = pickup.y - py;
      const proj = rx * candDirX + ry * candDirY;
      if (proj <= 0 || proj > params.lootLookaheadFt) continue;
      const perp = Math.abs(rx * -candDirY + ry * candDirX);
      const closeness = 1 - perp / Math.max(params.lootCorridorFt, EPSILON);
      if (closeness <= 0) continue;
      const contribution = closeness * pickup.weight;
      lootBonus += contribution;
      if (contribution > bestPickupContribution) {
        bestPickupContribution = contribution;
        bestPickupEid = pickup.eid ?? null;
      }
    }
  }

  // --- Farm bias: keep an enemy in the strike band while staying ≥ safe gap ---
  let farmBonus = 0;
  if (
    params.wFarm > 0 &&
    input.farmEligible &&
    !input.panic &&
    safe &&
    progressDot >= 0.25 &&
    nearestThreat &&
    nearestThreatCentre <= input.weaponReachFt + params.safeGapFt
  ) {
    farmBonus = 1;
  }

  const score =
    params.wProgress * progressDot +
    params.wContinuity * continuity +
    params.wKite * kiteBonus +
    params.wLoot * lootBonus +
    params.wFarm * farmBonus -
    params.wSafety * threatCost -
    wallPenalty;

  return {
    dirX: candDirX,
    dirY: candDirY,
    passable,
    minGapFt,
    progressDot,
    threatCost,
    wallPenalty,
    kiteBonus,
    lootBonus,
    bestPickupEid,
    farmBonus,
    score,
  };
}

/**
 * Pick the safest forward-progressing travel heading.
 *
 * Multi-pass selection guarantees the runner can "always dance" when a lane
 * exists, degrades gracefully in a pincer, and never freezes:
 *  1. Among PASSABLE candidates that are safe (gap ≥ safeGap) AND progressing,
 *     take the tightest such arc (max progressDot). Because the player is faster
 *     than the mobs and their paths are known, such a lane almost always exists.
 *  2. If none, THREAD PAST the block: among genuinely open escape lanes (deeply
 *     clear of walls) that do not reverse AND stay contact-free (gap ≥ hardGap),
 *     take the most-forward (max progressDot), slipping *past* the mob and out the
 *     far side. Maximising progress (not gap) makes the manoeuvre self-terminating
 *     rather than a radial retreat that re-approaches in a limit cycle. At a wall
 *     chokepoint the lateral lanes hit a wall inside the probe fan and drop out,
 *     so this falls through to the commit-through pass.
 *  2b. If no contact-free open lane survives (walls hem in the forward hemisphere,
 *     or a mob fully blocks it): a true pincer — commit forward through the
 *     most-forward passable lane and flag `emergency` when the gap is below hardGap.
 *  3. If nothing is passable (boxed in), take the candidate with the largest
 *     predicted gap (least-bad) and flag `emergency`. Never returns a zero
 *     vector.
 */
/** Sample spacing (feet) for the trivial-pickup snap's short-range wall probe. */
const SNAP_PROBE_STEP_FT = 1;

/**
 * True when every point along the short direct line to a trivial pickup is
 * passable. The candidate wall probe (`wallProbeDistancesFt`, first sample at
 * 3 ft) is too coarse for the snap: a gem on the far side of a wall 2 ft away
 * reads "passable" there, and the runner would grind into the wall instead of
 * resuming its objective. Sampling every foot up to (and including) the pickup
 * keeps the snap honest at that scale.
 */
function isDirectLaneClear(
  input: TravelSteeringInput,
  dirX: number,
  dirY: number,
  distanceFt: number,
): boolean {
  for (let d = SNAP_PROBE_STEP_FT; d < distanceFt; d += SNAP_PROBE_STEP_FT) {
    if (!input.probePassable(input.px + dirX * d, input.py + dirY * d)) return false;
  }
  return input.probePassable(input.px + dirX * distanceFt, input.py + dirY * distanceFt);
}

export function pickSafeTravelHeading(
  input: TravelSteeringInput,
  params: TravelSteeringParams,
): TravelSteeringResult {
  const objMag = Math.hypot(input.objDirX, input.objDirY);
  if (objMag < EPSILON) {
    return {
      moveX: 0,
      moveY: 0,
      minPredictedGapFt: Number.POSITIVE_INFINITY,
      progressDot: 0,
      threatCost: 0,
      lootBonus: 0,
      farmBonus: 0,
      score: 0,
      selectedCandidateX: null,
      selectedCandidateY: null,
      selectedPickupEid: null,
      emergency: false,
      reason: 'no objective direction',
    };
  }
  const objDirX = input.objDirX / objMag;
  const objDirY = input.objDirY / objMag;
  const normInput: TravelSteeringInput = { ...input, objDirX, objDirY };
  const hasLootBias = params.wLoot > 0 && input.pickups.length > 0 && !input.panic;
  const preferCompositeScore =
    hasLootBias || (params.wFarm > 0 && input.farmEligible && !input.panic);

  // Trivial-pickup snap: a pickup only a step away is free value, but the loot
  // corridor bias alone merely *curves* toward it — the runner keeps drifting on
  // its objective heading and passes within a foot of a gem without ever
  // overlapping it (pickups are collected by body overlap). Whenever such a
  // pickup is inside the snap radius, steer straight at it: the deviation costs
  // at most `lootSnapFt` of travel, the pickup is collected within a few frames,
  // and the objective heading resumes immediately afterwards. The snap is only
  // taken when the direct lane is passable and still predicted-safe, so it can
  // never walk the runner into a wall or into contact damage, and it is skipped
  // entirely under a panic beeline.
  if (!input.panic && params.lootSnapFt > 0 && input.pickups.length > 0) {
    let snapDirX = 0;
    let snapDirY = 0;
    let snapDistance = Number.POSITIVE_INFINITY;
    for (const pickup of input.pickups) {
      const rx = pickup.x - input.px;
      const ry = pickup.y - input.py;
      const dist = Math.hypot(rx, ry);
      if (dist <= EPSILON || dist > params.lootSnapFt || dist >= snapDistance) continue;
      snapDistance = dist;
      snapDirX = rx / dist;
      snapDirY = ry / dist;
    }
    if (
      snapDistance < Number.POSITIVE_INFINITY &&
      isDirectLaneClear(input, snapDirX, snapDirY, snapDistance)
    ) {
      const snap = scoreTravelCandidate(snapDirX, snapDirY, normInput, params);
      if (snap.passable && snap.minGapFt >= params.safeGapFt) {
        return toResult(snap, normInput, params, false, 'trivial pickup snap');
      }
    }
  }

  // Fast path: no threats ⇒ steer exactly along the objective (keeps the beeline
  // and the throughput it implies), unless tactical loot is explicitly active.
  // Wall avoidance during clear travel is left to the caller's existing local navigation.
  if (input.threats.length === 0 && !hasLootBias) {
    return {
      moveX: objDirX,
      moveY: objDirY,
      minPredictedGapFt: Number.POSITIVE_INFINITY,
      progressDot: 1,
      threatCost: 0,
      lootBonus: 0,
      farmBonus: 0,
      score: 0,
      selectedCandidateX: input.px + objDirX * params.lootLookaheadFt,
      selectedCandidateY: input.py + objDirY * params.lootLookaheadFt,
      selectedPickupEid: null,
      emergency: false,
      reason: 'clear travel',
    };
  }

  const fan = buildTravelCandidateFan(objDirX, objDirY, params.candidateOffsetsDeg);
  const scored = fan.map((c) => scoreTravelCandidate(c.x, c.y, normInput, params));

  // Prefer the straight beeline whenever it is passable and predicted-safe over
  // the horizon. Paying kite/continuity bias to arc around an enemy we can simply
  // walk past wastes travel time and risks missing the floor-collapse deadline
  // (the whole win condition). We only leave the beeline when it would breach the
  // safe gap. Because we re-plan every frame, a beeline that *becomes* unsafe next
  // frame triggers an arc then — no need to pre-emptively orbit. `scored[0]` is
  // the 0° candidate (buildTravelCandidateFan emits objDir first).
  const beeline = scored[0];
  if (beeline && beeline.passable && beeline.minGapFt >= params.safeGapFt && !hasLootBias) {
    return toResult(beeline, normInput, params, false, 'safe beeline');
  }

  // Pass 1: safe + progressing + passable — take the *tightest* such arc (max
  // progressDot), NOT the max composite score. Because the runner is faster than
  // the mobs and knows their paths, it can slip past a pursuer with the smallest
  // deviation that keeps a safe gap; a wide orbital arc cuts no extra contact
  // damage (anything ≥ safeGap is already contact-free) and only burns travel
  // time, which risks the floor-collapse deadline. Ties between mirror offsets
  // (e.g. +30°/−30°, identical progressDot) break on composite score so the kite
  // tangent still chooses the natural side to curve around. This is the core of
  // "always able to dance": minimal-deviation slips, not time-wasting orbits.
  const safeProgressing = scored.filter(
    (s) =>
      s.passable && s.minGapFt >= params.safeGapFt && s.progressDot >= params.minSafeProgressDot,
  );
  if (safeProgressing.length > 0) {
    const best = safeProgressing.reduce((b, cur) => {
      if (preferCompositeScore) {
        if (cur.score > b.score + EPSILON) return cur;
        if (cur.score >= b.score - EPSILON && cur.progressDot > b.progressDot) return cur;
        return b;
      }
      if (cur.progressDot > b.progressDot + EPSILON) return cur;
      if (cur.progressDot >= b.progressDot - EPSILON && cur.score > b.score) return cur;
      return b;
    });
    return toResult(best, normInput, params, false, hasLootBias ? 'safe tactical arc' : 'safe arc');
  }

  // Pass 2: no safe + progressing lane exists — a mob stands between the runner
  // and the objective, close enough that the objective-ward hemisphere all breaches
  // the safe gap. THREAD PAST it: among passable, wall-clear, non-reversing lanes
  // that stay *contact-free* (minGap ≥ hardGap), take the MOST FORWARD (max
  // progressDot). Because the runner is faster than the mob and re-plans every
  // frame, the tightest contact-free arc slips *past* the body and out the far
  // side — the mob falls behind and Pass 1's safe beeline resumes. Contact-free
  // (≥ hardGap) keeps the pass damage-free; ties break toward the larger gap, then
  // heading continuity so the runner commits to one side instead of flip-flopping.
  //
  // This forward bias is the crux of the redesign. The previous rule took the
  // *largest-gap* lane, which backed radially away from the blocker; that re-opened
  // the gap, re-armed the safe-beeline short-circuit, drove back in, re-breached,
  // and backed off again — a bang-bang limit cycle that parked the runner at a
  // single standoff distance for minutes (measured: seed 4 bow deadlocked ~200 s at
  // (518,140), zero net progress, HP flat — a pure throughput stall, not a survival
  // one, that timed out the run). Maximising progress instead of gap makes the
  // manoeuvre self-terminating (it ends by passing the mob) and mirrors the engage
  // kite, which arcs *around* a body rather than retreating from it. The wall-clear
  // filter (wallPenalty === 0 ⟺ no wall anywhere in the probe fan) still separates a
  // real open sidestep from a shallow wall pocket at a chokepoint; genuine
  // chokepoints (no contact-free open lane) fall through to the commit-through pass.
  const threadLanes = scored.filter(
    (s) =>
      s.passable && s.wallPenalty === 0 && s.progressDot >= 0 && s.minGapFt >= params.hardGapFt,
  );
  if (threadLanes.length > 0) {
    const first = threadLanes[0] as TravelCandidateScore;
    const best = threadLanes.reduce((b, cur) => {
      if (cur.progressDot > b.progressDot + EPSILON) return cur;
      if (cur.progressDot >= b.progressDot - EPSILON) {
        if (cur.minGapFt > b.minGapFt + EPSILON) return cur;
        if (cur.minGapFt >= b.minGapFt - EPSILON) {
          const curCont = cur.dirX * input.prevDirX + cur.dirY * input.prevDirY;
          const bestCont = b.dirX * input.prevDirX + b.dirY * input.prevDirY;
          if (curCont > bestCont) return cur;
        }
      }
      return b;
    }, first);
    return toResult(best, normInput, params, false, 'thread past');
  }

  // Pass 2b: no open escape lane (walls hem in the whole forward hemisphere) — a
  // true chokepoint / hallway pincer, the one case the user explicitly accepts
  // taking a hit for ("totally unavoidable getting pincered inside hallways").
  // COMMIT FORWARD through the most-forward passable lane toward the objective
  // rather than dancing against the wall (which wedges — observed 165 s parked at
  // a doorway). objDir comes from the wall-aware A* route, so the most-forward
  // passable lane drives through the blocking mob and out the far side. Ties break
  // toward the larger gap (graze less), then heading continuity.
  const passableOnly = scored.filter((s) => s.passable);
  if (passableOnly.length > 0) {
    const first = passableOnly[0];
    if (first === undefined) {
      // Unreachable (length checked above) — satisfies the type narrower.
      return toResult(scored[0] as TravelCandidateScore, normInput, params, true, 'pincer escape');
    }
    const best = passableOnly.reduce((b, cur) => {
      if (cur.progressDot > b.progressDot + EPSILON) return cur;
      if (cur.progressDot >= b.progressDot - EPSILON) {
        if (cur.minGapFt > b.minGapFt + EPSILON) return cur;
        if (cur.minGapFt >= b.minGapFt - EPSILON) {
          const curCont = cur.dirX * input.prevDirX + cur.dirY * input.prevDirY;
          const bestCont = b.dirX * input.prevDirX + b.dirY * input.prevDirY;
          if (curCont > bestCont) return cur;
        }
      }
      return b;
    }, first);
    return toResult(best, normInput, params, best.minGapFt < params.hardGapFt, 'commit through');
  }

  // Pass 3: boxed in — least-bad gap, never freeze.
  const best = scored.reduce((b, cur) => (cur.minGapFt > b.minGapFt ? cur : b));
  return toResult(best, normInput, params, true, 'pincer escape');
}

function toResult(
  c: TravelCandidateScore,
  input: TravelSteeringInput,
  params: TravelSteeringParams,
  emergency: boolean,
  reason: string,
): TravelSteeringResult {
  const candidateDistance = Math.max(
    params.lootLookaheadFt,
    params.wallProbeDistancesFt[0] ?? params.lootLookaheadFt,
  );
  return {
    moveX: c.dirX,
    moveY: c.dirY,
    minPredictedGapFt: c.minGapFt,
    progressDot: c.progressDot,
    threatCost: c.threatCost,
    lootBonus: c.lootBonus,
    farmBonus: c.farmBonus,
    score: c.score,
    selectedCandidateX: input.px + c.dirX * candidateDistance,
    selectedCandidateY: input.py + c.dirY * candidateDistance,
    selectedPickupEid: c.bestPickupEid,
    emergency,
    reason,
  };
}
