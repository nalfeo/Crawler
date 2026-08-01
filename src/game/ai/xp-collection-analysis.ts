export interface XpGemSnapshot {
  eid: number;
  x: number;
  y: number;
  value: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface XpRecoveryBudgetResult {
  detourBudgetFt: number;
  recoverableXpUpperBound: number;
  projectedEfficiencyUpperBound: number;
}

export interface XpSpatialAnalysis {
  gemCount: number;
  remainingXp: number;
  clusteredXp: number;
  clusteredXpFraction: number;
  corridorXp: number;
  corridorXpFraction: number;
  recoveryBudgets: XpRecoveryBudgetResult[];
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function distanceToSegment(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return distance(point, start);
  const t = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared),
  );
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function marginalDetourLowerBound(
  start: Point,
  gem: Point,
  exit: Point,
  attractionRadiusFt: number,
): number {
  const direct = distance(start, exit);
  const toGem = Math.max(0, distance(start, gem) - attractionRadiusFt);
  const gemToExit = Math.max(0, distance(gem, exit) - attractionRadiusFt);
  return Math.max(0, toGem + gemToExit - direct);
}

function clusteredXp(gems: readonly XpGemSnapshot[], clusterRadiusFt: number): number {
  const visited = new Set<number>();
  let total = 0;

  for (let i = 0; i < gems.length; i++) {
    if (visited.has(i)) continue;
    const component: number[] = [];
    const pending = [i];
    visited.add(i);
    while (pending.length > 0) {
      const index = pending.pop();
      if (index === undefined) break;
      component.push(index);
      for (let j = 0; j < gems.length; j++) {
        if (visited.has(j) || distance(gems[index]!, gems[j]!) > clusterRadiusFt) continue;
        visited.add(j);
        pending.push(j);
      }
    }
    if (component.length > 1) {
      total += component.reduce((sum, index) => sum + gems[index]!.value, 0);
    }
  }

  return total;
}

export function analyzeXpSpatialDistribution(options: {
  gems: readonly XpGemSnapshot[];
  routeStart: Point;
  exit: Point;
  spawnedXp: number;
  collectedXp: number;
  detourBudgetsFt: readonly number[];
  attractionRadiusFt: number;
  clusterRadiusFt: number;
}): XpSpatialAnalysis {
  const remainingXp = options.gems.reduce((sum, gem) => sum + gem.value, 0);
  const clustered = clusteredXp(options.gems, options.clusterRadiusFt);
  const corridorXp = options.gems
    .filter(
      (gem) =>
        distanceToSegment(gem, options.routeStart, options.exit) <= options.attractionRadiusFt,
    )
    .reduce((sum, gem) => sum + gem.value, 0);

  return {
    gemCount: options.gems.length,
    remainingXp,
    clusteredXp: clustered,
    clusteredXpFraction: remainingXp > 0 ? clustered / remainingXp : 0,
    corridorXp,
    corridorXpFraction: remainingXp > 0 ? corridorXp / remainingXp : 0,
    recoveryBudgets: options.detourBudgetsFt.map((detourBudgetFt) => {
      const recoverableXpUpperBound = options.gems
        .filter(
          (gem) =>
            marginalDetourLowerBound(
              options.routeStart,
              gem,
              options.exit,
              options.attractionRadiusFt,
            ) <= detourBudgetFt,
        )
        .reduce((sum, gem) => sum + gem.value, 0);
      return {
        detourBudgetFt,
        recoverableXpUpperBound,
        projectedEfficiencyUpperBound:
          options.spawnedXp > 0
            ? Math.min(1, (options.collectedXp + recoverableXpUpperBound) / options.spawnedXp)
            : 0,
      };
    }),
  };
}
