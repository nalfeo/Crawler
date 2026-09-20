import { formForLevel, type PetSpeciesDef } from './species.js';

/** Authored form growth; distances and visual size use its linear (square-root) scale. */
export function companionGrowthScales(species: PetSpeciesDef, level: number) {
  const statScale = formForLevel(species, level).statScale;
  const linearScale = Math.sqrt(statScale);
  return {
    statScale,
    speedScale: linearScale,
    rangeScale: linearScale,
    visualScale: linearScale,
  };
}
