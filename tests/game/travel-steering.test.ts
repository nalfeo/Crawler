/**
 * Unit + property tests for the pure predictive safe-gap travel steering
 * ({@link pickSafeTravelHeading} and its scoring helpers). These pin the
 * invariants the AI relies on when dancing around mobs en route to objectives:
 *  - no threats ⇒ keep the exact objective beeline (throughput-neutral),
 *  - a blocker on the beeline ⇒ arc laterally while still progressing (never
 *    reverse),
 *  - consider the whole pack, not just the closest threat,
 *  - respect (door-aware) walls,
 *  - degrade gracefully in a pincer and never freeze / emit NaN,
 *  - loot/farm biases only ever apply when already safe & progressing,
 *  - full determinism (no hidden state / RNG / clock).
 *
 * Everything is exercised with tiny fakes (a threat list + an ASCII-grid
 * passability predicate) — no FloorMap / createTestWorld needed for a pure fn.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  pickSafeTravelHeading,
  scoreTravelCandidate,
  predictedMinGapFt,
  buildTravelCandidateFan,
  extractKiteTangent,
  type TravelSteeringInput,
  type TravelSteeringParams,
  type TravelThreat,
} from '../../src/game/ai/travel-steering.js';

const DEFAULT_PARAMS: TravelSteeringParams = {
  hardGapFt: 1.5,
  safeGapFt: 3.5,
  comfortGapFt: 7,
  threatRadiusFt: 34,
  horizonFrames: 32,
  candidateOffsetsDeg: [0, 15, 30, 45, 60, 75, 90, 110, 135, 160, 180],
  wallProbeDistancesFt: [3, 6, 9, 12, 15],
  minSafeProgressDot: 0.05,
  wProgress: 4,
  wSafety: 10,
  wContinuity: 0.8,
  wKite: 1.2,
  wLoot: 0,
  wFarm: 0,
  lootLookaheadFt: 12,
  lootCorridorFt: 4,
  // Snap disabled by default so the existing arc/beeline expectations below
  // describe the corridor-bias behaviour; the snap has its own describe block.
  lootSnapFt: 0,
  relSpeedEpsilonSq: 1e-8,
};

const makeParams = (over: Partial<TravelSteeringParams> = {}): TravelSteeringParams => ({
  ...DEFAULT_PARAMS,
  ...over,
});

const alwaysPassable = (): boolean => true;

const baseInput = (over: Partial<TravelSteeringInput> = {}): TravelSteeringInput => ({
  px: 0,
  py: 0,
  objDirX: 1,
  objDirY: 0,
  prevDirX: 1,
  prevDirY: 0,
  playerSpeedFtPerFrame: 3,
  orbitSign: 1,
  panic: false,
  weaponReachFt: 5,
  farmEligible: false,
  threats: [],
  pickups: [],
  probePassable: alwaysPassable,
  ...over,
});

const threat = (over: Partial<TravelThreat> = {}): TravelThreat => ({
  x: 10,
  y: 0,
  vx: 0,
  vy: 0,
  bodyRadiusFt: 3,
  ...over,
});

/** ASCII-grid passability in world feet (`.` passable, `#` wall), 10ft tiles. */
function gridProbe(rows: string[]): (x: number, y: number) => boolean {
  const TILE = 10;
  const grid = rows.map((r) => [...r]);
  const height = grid.length;
  const width = grid[0]?.length ?? 0;
  return (x, y) => {
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    if (ty < 0 || ty >= height || tx < 0 || tx >= width) return false;
    return grid[ty]![tx] === '.';
  };
}

describe('extractKiteTangent', () => {
  it('returns the perpendicular to the enemy→player axis, sign-flipped', () => {
    // Player east of enemy: enemy→player is +x, so tangent is ±y.
    const t1 = extractKiteTangent(10, 0, 0, 0, 1);
    expect(t1.x).toBeCloseTo(0);
    expect(t1.y).toBeCloseTo(1);
    const t2 = extractKiteTangent(10, 0, 0, 0, -1);
    expect(t2.y).toBeCloseTo(-1);
  });

  it('is a unit vector and orthogonal to the radial', () => {
    const tan = extractKiteTangent(3, 4, 0, 0, 1);
    expect(Math.hypot(tan.x, tan.y)).toBeCloseTo(1);
    // radial (enemy→player) is (3,4)/5; dot with tangent ≈ 0.
    expect((3 / 5) * tan.x + (4 / 5) * tan.y).toBeCloseTo(0);
  });

  it('falls back to a stable axis when the enemy is on top of the player', () => {
    const tan = extractKiteTangent(0, 0, 0, 0, 1);
    expect(Number.isFinite(tan.x)).toBe(true);
    expect(Number.isFinite(tan.y)).toBe(true);
    expect(Math.hypot(tan.x, tan.y)).toBeCloseTo(1);
  });
});

describe('predictedMinGapFt', () => {
  it('predicts contact when steering straight at a stationary enemy on the axis', () => {
    const gap = predictedMinGapFt(0, 0, 1, 0, 3, threat({ x: 10, y: 0 }), 32, 1e-4);
    expect(gap).toBeCloseTo(-3); // centre gap 0 minus bodyRadius 3
  });

  it('increases monotonically as the enemy sits farther off the straight path', () => {
    const near = predictedMinGapFt(0, 0, 1, 0, 3, threat({ x: 10, y: 2 }), 32, 1e-4);
    const far = predictedMinGapFt(0, 0, 1, 0, 3, threat({ x: 10, y: 8 }), 32, 1e-4);
    expect(far).toBeGreaterThan(near);
  });

  it('uses the current gap for a co-moving (near-parallel) threat', () => {
    // Enemy travelling with the same velocity as the player: relative speed ~0.
    const gap = predictedMinGapFt(0, 0, 1, 0, 3, threat({ x: 0, y: 10, vx: 3, vy: 0 }), 32, 1e-4);
    expect(gap).toBeCloseTo(10 - 3);
  });

  it('accounts for a moving threat that intercepts the path', () => {
    // Enemy ahead-left moving right to cut across; gap should be tighter than if parked.
    const moving = predictedMinGapFt(
      0,
      0,
      1,
      0,
      3,
      threat({ x: 15, y: 6, vx: 0, vy: -1 }),
      32,
      1e-4,
    );
    const parked = predictedMinGapFt(
      0,
      0,
      1,
      0,
      3,
      threat({ x: 15, y: 6, vx: 0, vy: 0 }),
      32,
      1e-4,
    );
    expect(moving).toBeLessThan(parked);
  });

  it('subtracts the per-body radius, so a larger body reports a tighter surface gap', () => {
    // Same centre-to-centre geometry, different body sizes: the bigger body must
    // read as closer-to-contact. This is the semantic the provider relies on when
    // it enlarges the radius for physically bigger enemies (e.g. 3x3 spawners).
    const small = predictedMinGapFt(
      0,
      0,
      1,
      0,
      3,
      threat({ x: 10, y: 5, bodyRadiusFt: 1.5 }),
      32,
      1e-8,
    );
    const big = predictedMinGapFt(
      0,
      0,
      1,
      0,
      3,
      threat({ x: 10, y: 5, bodyRadiusFt: 3 }),
      32,
      1e-8,
    );
    expect(big).toBeLessThan(small);
    expect(small - big).toBeCloseTo(1.5); // difference equals the body-radius delta
  });
});

describe('buildTravelCandidateFan', () => {
  it('lists the objective direction first and mirrors offsets', () => {
    const fan = buildTravelCandidateFan(1, 0, [0, 30, 90, 180]);
    expect(fan[0]!.x).toBeCloseTo(1);
    expect(fan[0]!.y).toBeCloseTo(0);
    // +30 and -30 both present, distinct.
    const has = (x: number, y: number) =>
      fan.some((c) => Math.abs(c.x - x) < 1e-6 && Math.abs(c.y - y) < 1e-6);
    expect(has(Math.cos(Math.PI / 6), Math.sin(Math.PI / 6))).toBe(true);
    expect(has(Math.cos(-Math.PI / 6), Math.sin(-Math.PI / 6))).toBe(true);
  });

  it('emits unit vectors', () => {
    const fan = buildTravelCandidateFan(0.6, 0.8, [0, 45, 135]);
    for (const c of fan) expect(Math.hypot(c.x, c.y)).toBeCloseTo(1);
  });
});

describe('pickSafeTravelHeading', () => {
  it('keeps the exact beeline when there are no threats', () => {
    const r = pickSafeTravelHeading(baseInput({ objDirX: 0, objDirY: 2 }), makeParams());
    expect(r.moveX).toBeCloseTo(0);
    expect(r.moveY).toBeCloseTo(1);
    expect(r.emergency).toBe(false);
  });

  it('can bend clear travel toward an accepted tactical pickup', () => {
    const r = pickSafeTravelHeading(
      baseInput({ pickups: [{ eid: 7, x: 10, y: 3, weight: 8 }] }),
      makeParams({ wLoot: 5 }),
    );

    expect(r.moveX).toBeGreaterThan(0);
    expect(r.moveY).toBeGreaterThan(0);
    expect(r.selectedPickupEid).toBe(7);
    expect(r.lootBonus).toBeGreaterThan(0);
    expect(r.reason).toBe('safe tactical arc');
  });

  it('returns zero when there is no objective direction', () => {
    const r = pickSafeTravelHeading(baseInput({ objDirX: 0, objDirY: 0 }), makeParams());
    expect(r.moveX).toBe(0);
    expect(r.moveY).toBe(0);
  });

  it('arcs laterally around a stationary blocker on the beeline (never reverses)', () => {
    const r = pickSafeTravelHeading(
      baseInput({ threats: [threat({ x: 12, y: 0 })] }),
      makeParams(),
    );
    expect(r.moveX).toBeGreaterThan(0); // still heading forward
    expect(Math.abs(r.moveY)).toBeGreaterThan(0.2); // arced to the side
    expect(r.progressDot).toBeGreaterThan(0);
    expect(r.minPredictedGapFt).toBeGreaterThanOrEqual(DEFAULT_PARAMS.safeGapFt);
  });

  it('picks the open side of a pack instead of dodging the single closest', () => {
    // A cluster to the north of the beeline; the south lane is open.
    const pack = [threat({ x: 8, y: 5 }), threat({ x: 11, y: 6 }), threat({ x: 14, y: 5 })];
    const r = pickSafeTravelHeading(baseInput({ threats: pack }), makeParams());
    expect(r.moveX).toBeGreaterThan(0);
    expect(r.moveY).toBeLessThan(0); // arced south, away from the northern pack
    expect(r.minPredictedGapFt).toBeGreaterThanOrEqual(DEFAULT_PARAMS.safeGapFt);
  });

  it('steers toward the passable side when a wall blocks one arc', () => {
    // Player at tile (2,2) world ~ (25,25); wall row to the north (tile y=1),
    // floor to the south. Enemy on the beeline forces a dodge.
    const probe = gridProbe(['#####', '#####', '.....', '.....', '.....']);
    const r = pickSafeTravelHeading(
      baseInput({
        px: 25,
        py: 25,
        objDirX: 1,
        objDirY: 0,
        prevDirX: 1,
        prevDirY: 0,
        threats: [threat({ x: 37, y: 25 })],
        probePassable: probe,
      }),
      makeParams(),
    );
    // The chosen heading's near step must land on passable ground, and it must
    // not steer north into the wall.
    expect(probe(25 + r.moveX * 3, 25 + r.moveY * 3)).toBe(true);
    expect(r.moveY).toBeGreaterThanOrEqual(-0.01);
  });

  it('never freezes in a hallway pincer and flags emergency', () => {
    // Narrow 1-tile hallway (walls north & south), enemy dead ahead.
    const probe = gridProbe(['###', '...', '###']);
    const r = pickSafeTravelHeading(
      baseInput({
        px: 15,
        py: 15,
        objDirX: 1,
        objDirY: 0,
        prevDirX: 1,
        prevDirY: 0,
        threats: [threat({ x: 20, y: 15, bodyRadiusFt: 3 })],
        probePassable: probe,
      }),
      makeParams(),
    );
    expect(Math.hypot(r.moveX, r.moveY)).toBeGreaterThan(0.1);
    expect(Number.isFinite(r.moveX)).toBe(true);
    expect(Number.isFinite(r.moveY)).toBe(true);
  });

  it('commits forward through a blocked chokepoint instead of wedging against the wall', () => {
    // A 1-tile-wide vertical doorway (only the middle column is passable); the
    // objective is due north and an enemy blocks the corridor ahead. There is no
    // safe *and* progressing lane (north breaches the gap; east/west/south are
    // walls), so Pass 2 fires. It must drive the runner FORWARD through the gap
    // toward the objective — not arc laterally into the wall and oscillate (the
    // 165 s doorway wedge). This encodes the user's "unavoidable hallway pincer"
    // carve-out: accept the graze, keep completing the level.
    const probe = gridProbe(['#.#', '#.#', '#.#', '#.#', '#.#']);
    const r = pickSafeTravelHeading(
      baseInput({
        px: 15,
        py: 45,
        objDirX: 0,
        objDirY: -1,
        prevDirX: 0,
        prevDirY: -1,
        threats: [threat({ x: 15, y: 40, bodyRadiusFt: 3 })],
        probePassable: probe,
      }),
      makeParams(),
    );
    expect(r.moveY).toBeLessThan(-0.8); // committed north through the doorway
    expect(Math.abs(r.moveX)).toBeLessThan(0.3); // not wedged laterally into a wall
    expect(r.progressDot).toBeGreaterThan(0.9);
    expect(r.emergency).toBe(true); // accepted graze while pushing through
  });

  it('is deterministic for identical inputs', () => {
    const input = baseInput({ threats: [threat({ x: 9, y: 3 }), threat({ x: 12, y: -4 })] });
    const a = pickSafeTravelHeading(input, makeParams());
    const b = pickSafeTravelHeading(input, makeParams());
    expect(a).toEqual(b);
  });
});

describe('scoreTravelCandidate — loot & farm biases', () => {
  const lootParams = makeParams({ wLoot: 1 });

  it('rewards a safe candidate that heads toward on-path loot', () => {
    const input = baseInput({ pickups: [{ x: 10, y: 1, weight: 1 }] });
    const toward = scoreTravelCandidate(1, 0, input, lootParams);
    expect(toward.lootBonus).toBeGreaterThan(0);
  });

  it('ignores loot that is behind or off the corridor', () => {
    const behind = scoreTravelCandidate(
      1,
      0,
      baseInput({ pickups: [{ x: -10, y: 0, weight: 1 }] }),
      lootParams,
    );
    expect(behind.lootBonus).toBe(0);
    const offCorridor = scoreTravelCandidate(
      1,
      0,
      baseInput({ pickups: [{ x: 6, y: 20, weight: 1 }] }),
      lootParams,
    );
    expect(offCorridor.lootBonus).toBe(0);
  });

  it('suppresses loot bias under panic', () => {
    const input = baseInput({ panic: true, pickups: [{ x: 10, y: 1, weight: 1 }] });
    expect(scoreTravelCandidate(1, 0, input, lootParams).lootBonus).toBe(0);
  });

  it('rewards keeping an enemy in the strike band only when farm-eligible and not panicking', () => {
    const farmParams = makeParams({ wFarm: 1 });
    const near = threat({ x: 2, y: 7 }); // centre ~7.3 ≤ reach(5)+safe(3.5); straight arc stays ≥ safe
    const eligible = scoreTravelCandidate(
      1,
      0,
      baseInput({ farmEligible: true, threats: [near] }),
      farmParams,
    );
    const notEligible = scoreTravelCandidate(
      1,
      0,
      baseInput({ farmEligible: false, threats: [near] }),
      farmParams,
    );
    const panicking = scoreTravelCandidate(
      1,
      0,
      baseInput({ farmEligible: true, panic: true, threats: [near] }),
      farmParams,
    );
    expect(eligible.minGapFt).toBeGreaterThanOrEqual(farmParams.safeGapFt);
    expect(eligible.farmBonus).toBe(1);
    expect(notEligible.farmBonus).toBe(0);
    expect(panicking.farmBonus).toBe(0);
  });

  it('penalizes a physically larger body more (tighter gap, higher threat cost)', () => {
    // Identical off-beeline geometry, different body radii. The bigger body must
    // read as closer to contact (smaller minGap) and cost strictly more, so the
    // selector arcs wider around it. Pins the size→cost semantic the provider's
    // per-body radius (enlarged for 3x3 spawners) depends on.
    const small = scoreTravelCandidate(
      1,
      0,
      baseInput({ threats: [threat({ x: 10, y: 3, bodyRadiusFt: 1.5 })] }),
      makeParams(),
    );
    const big = scoreTravelCandidate(
      1,
      0,
      baseInput({ threats: [threat({ x: 10, y: 3, bodyRadiusFt: 4.5 })] }),
      makeParams(),
    );
    expect(big.minGapFt).toBeLessThan(small.minGapFt);
    expect(big.threatCost).toBeGreaterThan(small.threatCost);
  });

  it('flags a candidate as impassable when a wall sits within the first probe step', () => {
    // Blocked at/after 3ft east — i.e. the nearest probe step hits a wall.
    const s = scoreTravelCandidate(
      1,
      0,
      baseInput({ px: 0, py: 0, probePassable: (x) => x < 3 }),
      makeParams(),
    );
    expect(s.passable).toBe(false);
  });
});

describe('pickSafeTravelHeading — properties', () => {
  const objComp = fc.double({ min: -1, max: 1, noNaN: true });

  it('keeps the normalized beeline whenever there are no threats', () => {
    fc.assert(
      fc.property(objComp, objComp, (ox, oy) => {
        fc.pre(Math.hypot(ox, oy) > 0.1);
        const r = pickSafeTravelHeading(baseInput({ objDirX: ox, objDirY: oy }), makeParams());
        const mag = Math.hypot(ox, oy);
        expect(r.moveX).toBeCloseTo(ox / mag, 5);
        expect(r.moveY).toBeCloseTo(oy / mag, 5);
      }),
    );
  });

  it('never freezes or emits NaN for arbitrary threat layouts in open space', () => {
    const threatArb = fc.record({
      x: fc.double({ min: -30, max: 30, noNaN: true }),
      y: fc.double({ min: -30, max: 30, noNaN: true }),
      vx: fc.double({ min: -2, max: 2, noNaN: true }),
      vy: fc.double({ min: -2, max: 2, noNaN: true }),
      bodyRadiusFt: fc.double({ min: 1, max: 4, noNaN: true }),
    });
    fc.assert(
      fc.property(fc.array(threatArb, { maxLength: 6 }), (threats) => {
        const r = pickSafeTravelHeading(baseInput({ threats }), makeParams());
        expect(Number.isFinite(r.moveX)).toBe(true);
        expect(Number.isFinite(r.moveY)).toBe(true);
        expect(Math.hypot(r.moveX, r.moveY)).toBeGreaterThan(0.1);
      }),
    );
  });

  it('maintains a safe, progressing lane against a distant on-axis threat in open space', () => {
    fc.assert(
      fc.property(fc.double({ min: 16, max: 28, noNaN: true }), (dist) => {
        const r = pickSafeTravelHeading(
          baseInput({ threats: [threat({ x: dist, y: 0, bodyRadiusFt: 3 })] }),
          makeParams(),
        );
        expect(r.minPredictedGapFt).toBeGreaterThanOrEqual(DEFAULT_PARAMS.safeGapFt);
        expect(r.progressDot).toBeGreaterThanOrEqual(DEFAULT_PARAMS.minSafeProgressDot);
      }),
    );
  });

  it('produces identical output for identical randomized inputs (no hidden state)', () => {
    const threatArb = fc.record({
      x: fc.double({ min: -20, max: 20, noNaN: true }),
      y: fc.double({ min: -20, max: 20, noNaN: true }),
      vx: fc.double({ min: -2, max: 2, noNaN: true }),
      vy: fc.double({ min: -2, max: 2, noNaN: true }),
      bodyRadiusFt: fc.constant(3),
    });
    fc.assert(
      fc.property(fc.array(threatArb, { maxLength: 5 }), objComp, objComp, (threats, ox, oy) => {
        fc.pre(Math.hypot(ox, oy) > 0.1);
        const input = baseInput({ threats, objDirX: ox, objDirY: oy });
        expect(pickSafeTravelHeading(input, makeParams())).toEqual(
          pickSafeTravelHeading(input, makeParams()),
        );
      }),
    );
  });
});

describe('pickSafeTravelHeading — trivial pickup snap', () => {
  const snapParams = makeParams({ wLoot: 1, lootSnapFt: 5 });

  it('steers straight at a pickup that is a step off the beeline', () => {
    // Objective is +x; the gem sits 3 ft away, mostly sideways. The corridor
    // bias alone only curves the arc, which slides past without overlapping.
    const r = pickSafeTravelHeading(
      baseInput({ pickups: [{ eid: 11, x: 1, y: 2.8, weight: 1 }] }),
      snapParams,
    );

    expect(r.reason).toBe('trivial pickup snap');
    expect(r.moveX).toBeCloseTo(1 / Math.hypot(1, 2.8));
    expect(r.moveY).toBeCloseTo(2.8 / Math.hypot(1, 2.8));
    expect(r.emergency).toBe(false);
  });

  it('snaps to the nearest pickup when several are in range', () => {
    const r = pickSafeTravelHeading(
      baseInput({
        pickups: [
          { eid: 1, x: 0, y: 4, weight: 1 },
          { eid: 2, x: 0, y: -1.5, weight: 1 },
        ],
      }),
      snapParams,
    );

    expect(r.reason).toBe('trivial pickup snap');
    expect(r.moveY).toBeCloseTo(-1);
  });

  it('ignores pickups beyond the snap radius (corridor bias still applies)', () => {
    const r = pickSafeTravelHeading(
      baseInput({ pickups: [{ eid: 3, x: 10, y: 3, weight: 8 }] }),
      snapParams,
    );

    expect(r.reason).not.toBe('trivial pickup snap');
  });

  it('does not snap under a panic beeline', () => {
    const r = pickSafeTravelHeading(
      baseInput({ panic: true, pickups: [{ eid: 4, x: 0, y: 2, weight: 1 }] }),
      snapParams,
    );

    expect(r.reason).not.toBe('trivial pickup snap');
  });

  it('does not snap while any threat is perceived (spacing owns the heading)', () => {
    const r = pickSafeTravelHeading(
      baseInput({
        pickups: [{ eid: 5, x: 0, y: 3, weight: 1 }],
        threats: [threat({ x: 0, y: 5 })],
      }),
      snapParams,
    );

    expect(r.reason).not.toBe('trivial pickup snap');
  });

  it('does not snap through a wall', () => {
    // Wall tile immediately north of the player; the gem is beyond it.
    const probe = gridProbe(['.#.', '...', '...']);
    const r = pickSafeTravelHeading(
      baseInput({
        px: 15,
        py: 11,
        pickups: [{ eid: 6, x: 15, y: 8, weight: 1 }],
        probePassable: probe,
      }),
      snapParams,
    );

    expect(r.reason).not.toBe('trivial pickup snap');
  });

  it('is disabled when lootSnapFt is 0', () => {
    const r = pickSafeTravelHeading(
      baseInput({ pickups: [{ eid: 7, x: 0, y: 2, weight: 1 }] }),
      makeParams({ wLoot: 1, lootSnapFt: 0 }),
    );

    expect(r.reason).not.toBe('trivial pickup snap');
  });

  it('breaks equidistant pickups by entity id, not scan order', () => {
    const a = { eid: 9, x: 0, y: 2, weight: 1 };
    const b = { eid: 4, x: 0, y: -2, weight: 1 };

    const forward = pickSafeTravelHeading(baseInput({ pickups: [a, b] }), snapParams);
    const reversed = pickSafeTravelHeading(baseInput({ pickups: [b, a] }), snapParams);

    expect(forward.reason).toBe('trivial pickup snap');
    expect(reversed.reason).toBe('trivial pickup snap');
    expect(forward.moveY).toBeCloseTo(reversed.moveY);
    // Lowest eid (4, at y = -2) wins the tie.
    expect(forward.moveY).toBeCloseTo(-1);
  });
});
