export type SpawnZoneWeights = ReadonlyMap<string, number>;

export interface SpawnZoneMix {
  readonly weights: SpawnZoneWeights;
  readonly share: number;
}

export function mergeSpawnZoneWeights(zones: readonly SpawnZoneWeights[]): Map<string, number> {
  const merged = new Map<string, number>();
  for (const zone of zones) {
    for (const [id, weight] of zone.entries()) {
      if (!(weight > 0) || !Number.isFinite(weight)) continue;
      merged.set(id, (merged.get(id) ?? 0) + weight);
    }
  }
  return merged;
}

export function normalizeSpawnZoneWeights(weights: SpawnZoneWeights): Map<string, number> {
  let total = 0;
  for (const value of weights.values()) {
    if (!(value > 0) || !Number.isFinite(value)) continue;
    total += value;
  }
  if (!(total > 0) || !Number.isFinite(total)) {
    return new Map();
  }
  const normalized = new Map<string, number>();
  for (const [id, value] of weights.entries()) {
    if (!(value > 0) || !Number.isFinite(value)) continue;
    normalized.set(id, value / total);
  }
  return normalized;
}

/**
 * Normalize each category independently, then reserve its requested share of
 * the final probability mass. Empty categories are omitted and the remaining
 * shares are renormalized.
 */
export function mixSpawnZoneWeights(categories: readonly SpawnZoneMix[]): Map<string, number> {
  const active = categories
    .map((category) => ({
      normalized: normalizeSpawnZoneWeights(category.weights),
      share: category.share,
    }))
    .filter(
      (category) =>
        category.normalized.size > 0 && category.share > 0 && Number.isFinite(category.share),
    );
  const totalShare = active.reduce((sum, category) => sum + category.share, 0);
  if (!(totalShare > 0) || !Number.isFinite(totalShare)) {
    return new Map();
  }

  const mixed = new Map<string, number>();
  for (const category of active) {
    const categoryShare = category.share / totalShare;
    for (const [id, probability] of category.normalized) {
      mixed.set(id, (mixed.get(id) ?? 0) + probability * categoryShare);
    }
  }
  return mixed;
}

function pickFromNormalizedSpawnZoneWeights(
  normalized: SpawnZoneWeights,
  random: () => number,
): string | null {
  if (normalized.size === 0) return null;
  const roll = Math.min(0.999999, Math.max(0, random()));
  let cumulative = 0;
  let fallback: string | null = null;
  for (const [id, weight] of normalized.entries()) {
    if (!(weight > 0) || !Number.isFinite(weight)) continue;
    fallback = id;
    cumulative += weight;
    if (roll < cumulative) return id;
  }
  return fallback;
}

export function pickFromSpawnZones(
  zones: readonly SpawnZoneWeights[],
  random: () => number,
): { readonly pickedId: string | null; readonly normalized: ReadonlyMap<string, number> } {
  const merged = mergeSpawnZoneWeights(zones);
  const normalized = normalizeSpawnZoneWeights(merged);
  return {
    pickedId: pickFromNormalizedSpawnZoneWeights(normalized, random),
    normalized,
  };
}
