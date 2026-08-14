import type { GameWorld } from './world.js';

/** Raw item identity recorded at a successful runtime activation choke point. */
export type RunItemSource =
  | `weapon:${string}`
  | `spell:${string}`
  | `generated-equipment-instance:${string}`;

/** One committed weapon or ability activation, with de-duplicated owning sources. */
export interface RunItemActivation {
  readonly activationId: number;
  readonly itemSources: readonly RunItemSource[];
}

/**
 * Optional headless-run collector. Shipping worlds leave this undefined, making
 * all capture helpers allocation-free no-ops.
 */
export interface RunEventCollector {
  nextActivationId: number;
  readonly itemActivations: RunItemActivation[];
}

export function createRunEventCollector(): RunEventCollector {
  return { nextActivationId: 1, itemActivations: [] };
}

export function recordRunItemActivation(
  world: GameWorld,
  itemSources: readonly RunItemSource[],
): void {
  const collector = world.runEvents;
  if (!collector) return;

  const uniqueSources = [...new Set(itemSources)].sort();
  if (uniqueSources.length === 0) return;

  collector.itemActivations.push({
    activationId: collector.nextActivationId,
    itemSources: uniqueSources,
  });
  collector.nextActivationId += 1;
}
