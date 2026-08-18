/**
 * Canonical RunStats assembly seam.
 *
 * The generic signature is intentional: the concrete RunStats contract is owned
 * by the game layer, while both the headless and engine pipelines can use this
 * pure, pipeline-agnostic copy step without introducing an import cycle.
 */
export function assembleRunStats<TStats extends object>(stats: TStats): TStats {
  return { ...stats };
}
