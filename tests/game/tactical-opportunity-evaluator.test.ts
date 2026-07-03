import { describe, expect, it } from 'vitest';
import {
  evaluateTacticalOpportunities,
  scoreTacticalOpportunity,
  type TacticalOpportunityInput,
  type TacticalOpportunityParams,
} from '../../src/game/ai/tactical-opportunity-evaluator.js';

const PARAMS: TacticalOpportunityParams = {
  scanRadiusFt: 24,
  maxDetourFt: 8,
  minDetourMs: 250,
  urgencyPenalty: 0.95,
  dangerPenalty: 1.5,
  acceptScore: 2,
  maxAccepted: 4,
  travelWeightDivisor: 8,
  maxTravelWeight: 2,
};

function input(overrides: Partial<TacticalOpportunityInput> = {}): TacticalOpportunityInput {
  return {
    playerX: 0,
    playerY: 0,
    objectiveX: 100,
    objectiveY: 0,
    urgency: 0,
    speedFtPerMs: 0.12,
    opportunities: [],
    ...overrides,
  };
}

describe('tactical opportunity evaluator', () => {
  it('uses path-relative detour cost instead of raw distance', () => {
    const onRoute = scoreTacticalOpportunity(input(), PARAMS, {
      id: 1,
      kind: 'pickup',
      pickupKind: 'xp',
      x: 20,
      y: 0,
      value: 8,
      danger: 0,
      reachable: true,
    });
    const offRoute = scoreTacticalOpportunity(input(), PARAMS, {
      id: 2,
      kind: 'pickup',
      pickupKind: 'xp',
      x: 10,
      y: 20,
      value: 8,
      danger: 0,
      reachable: true,
    });

    expect(onRoute.detourFt).toBeCloseTo(0);
    expect(onRoute.accepted).toBe(true);
    expect(offRoute.detourFt).toBeGreaterThan(PARAMS.maxDetourFt);
    expect(offRoute.accepted).toBe(false);
    expect(offRoute.reason).toBe('detour too expensive');
  });

  it('tightens optional pickup acceptance as urgency rises', () => {
    const opportunity = {
      id: 1,
      kind: 'pickup' as const,
      pickupKind: 'gold' as const,
      x: 10,
      y: 0,
      value: 5,
      danger: 0,
      reachable: true,
    };

    const relaxed = scoreTacticalOpportunity(input({ urgency: 0 }), PARAMS, opportunity);
    const urgent = scoreTacticalOpportunity(input({ urgency: 1 }), PARAMS, opportunity);

    expect(relaxed.accepted).toBe(true);
    expect(urgent.score).toBeLessThan(relaxed.score);
    expect(urgent.accepted).toBe(false);
    expect(urgent.reason).toBe('score below threshold');
  });

  it('rejects unreachable pickups before scoring can accept them', () => {
    const scored = scoreTacticalOpportunity(input(), PARAMS, {
      id: 1,
      kind: 'pickup',
      pickupKind: 'item',
      x: 4,
      y: 0,
      value: 100,
      danger: 0,
      reachable: false,
    });

    expect(scored.accepted).toBe(false);
    expect(scored.reason).toBe('unreachable');
  });

  it('scores enemy packs for debug but does not accept them in this slice', () => {
    const scored = scoreTacticalOpportunity(input(), PARAMS, {
      id: 99,
      kind: 'enemyPack',
      x: 10,
      y: 0,
      value: 100,
      danger: 0.5,
      reachable: true,
      debugOnly: true,
    });

    expect(scored.score).toBeGreaterThan(0);
    expect(scored.accepted).toBe(false);
    expect(scored.reason).toBe('debug-only');
  });

  it('sorts accepted pickups by score and caps actionable opportunities', () => {
    const result = evaluateTacticalOpportunities(
      input({
        opportunities: [
          {
            id: 1,
            kind: 'pickup',
            pickupKind: 'xp',
            x: 5,
            y: 0,
            value: 3,
            danger: 0,
            reachable: true,
          },
          {
            id: 2,
            kind: 'pickup',
            pickupKind: 'item',
            x: 6,
            y: 0,
            value: 20,
            danger: 0,
            reachable: true,
          },
          {
            id: 3,
            kind: 'pickup',
            pickupKind: 'gold',
            x: 7,
            y: 0,
            value: 4,
            danger: 0,
            reachable: true,
          },
        ],
      }),
      { ...PARAMS, maxAccepted: 2 },
    );

    expect(result.acceptedPickups.map((pickup) => pickup.id)).toEqual([2, 3]);
    expect(result.acceptedPickups).toHaveLength(2);
  });
});
