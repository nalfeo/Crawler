import { describe, expect, it } from 'vitest';
import { analyzeXpSpatialDistribution } from '../../../src/game/ai/xp-collection-analysis.js';

describe('analyzeXpSpatialDistribution', () => {
  it('reports clustered, corridor, and optimistic detour recovery bounds', () => {
    const result = analyzeXpSpatialDistribution({
      gems: [
        { eid: 1, x: 5, y: 0, value: 10 },
        { eid: 2, x: 6, y: 1, value: 5 },
        { eid: 3, x: 5, y: 20, value: 20 },
      ],
      routeStart: { x: 0, y: 0 },
      exit: { x: 10, y: 0 },
      spawnedXp: 100,
      collectedXp: 60,
      detourBudgetsFt: [0, 30],
      attractionRadiusFt: 4,
      clusterRadiusFt: 3,
    });

    expect(result.remainingXp).toBe(35);
    expect(result.clusteredXp).toBe(15);
    expect(result.corridorXp).toBe(15);
    expect(result.recoveryBudgets).toEqual([
      {
        detourBudgetFt: 0,
        recoverableXpUpperBound: 15,
        projectedEfficiencyUpperBound: 0.75,
      },
      {
        detourBudgetFt: 30,
        recoverableXpUpperBound: 35,
        projectedEfficiencyUpperBound: 0.95,
      },
    ]);
  });

  it('uses zero fractions and efficiency when no XP exists', () => {
    expect(
      analyzeXpSpatialDistribution({
        gems: [],
        routeStart: { x: 0, y: 0 },
        exit: { x: 0, y: 0 },
        spawnedXp: 0,
        collectedXp: 0,
        detourBudgetsFt: [25],
        attractionRadiusFt: 4,
        clusterRadiusFt: 12,
      }),
    ).toMatchObject({
      remainingXp: 0,
      clusteredXpFraction: 0,
      corridorXpFraction: 0,
      recoveryBudgets: [{ projectedEfficiencyUpperBound: 0 }],
    });
  });
});
