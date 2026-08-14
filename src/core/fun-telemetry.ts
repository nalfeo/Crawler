import type { GameWorld } from './world.js';

/** Raw item identity recorded at a successful runtime activation choke point. */
export type FunTelemetryItemSource =
  | `weapon:${string}`
  | `spell:${string}`
  | `generated-equipment-instance:${string}`;

/** One committed weapon or ability activation, with de-duplicated owning sources. */
export interface FunTelemetryActivation {
  readonly activationId: number;
  readonly itemSources: readonly FunTelemetryItemSource[];
}

/**
 * Optional headless-run collector. Shipping worlds leave this undefined, making
 * all capture helpers allocation-free no-ops.
 */
export interface FunTelemetryCollector {
  nextActivationId: number;
  readonly activations: FunTelemetryActivation[];
}

export function createFunTelemetryCollector(): FunTelemetryCollector {
  return { nextActivationId: 1, activations: [] };
}

export function recordFunTelemetryActivation(
  world: GameWorld,
  itemSources: readonly FunTelemetryItemSource[],
): void {
  const collector = world.funTelemetry;
  if (!collector) return;

  const uniqueSources = [...new Set(itemSources)].sort();
  if (uniqueSources.length === 0) return;

  collector.activations.push({
    activationId: collector.nextActivationId,
    itemSources: uniqueSources,
  });
  collector.nextActivationId += 1;
}
