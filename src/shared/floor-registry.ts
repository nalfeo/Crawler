/**
 * Floor Registry — centralized floor manifest loader.
 *
 * This module provides a registry for loading floor manifests by ID,
 * enabling multi-floor support and floor progression.
 */
import { floor1Manifest, floor2Manifest, type FloorManifestDef } from './floor-manifest.js';

/**
 * Registry of available floor manifests.
 */
const FLOOR_REGISTRY = new Map<string, FloorManifestDef>([
  ['floor1', floor1Manifest],
  ['floor2', floor2Manifest],
]);

/**
 * Get a floor manifest by ID.
 * @param floorId - Floor identifier (e.g., "floor1", "floor2").
 * @returns Floor manifest if found, undefined otherwise.
 */
export function getFloorManifest(floorId: string): FloorManifestDef | undefined {
  return FLOOR_REGISTRY.get(floorId);
}

/**
 * Get all available floor IDs.
 */
export function getAvailableFloorIds(): string[] {
  return Array.from(FLOOR_REGISTRY.keys());
}

/**
 * True when a floor is implemented end-to-end with an attainable victory
 * (`implemented.mvp`). This — not a hardcoded floor id — is what decides
 * whether a floor belongs in the sweep set, can be chained into by the floor
 * below it, or is otherwise treated as real content.
 */
export function isFloorImplemented(floorId: string): boolean {
  return getFloorManifest(floorId)?.implemented.mvp === true;
}

/**
 * Floor ids that are implemented E2E with an attainable victory, in registry
 * order. This is the sweep set: the floors a win-rate sweep may legitimately
 * run, because a win on them is actually reachable.
 */
export function getImplementedFloorIds(): string[] {
  return getAvailableFloorIds().filter(isFloorImplemented);
}

/**
 * The ACTIVE-time budget (simulated game ms) an official win on this floor must
 * land under, or `null` when the floor declares no validated budget — in which
 * case a win is raw victory with no time bound.
 *
 * Throws for an unknown floor rather than returning `null`, so a typo'd floor id
 * fails loudly instead of silently degrading every run on it to "unbudgeted".
 */
export function getFloorWinBudgetMs(floorId: string): number | null {
  const manifest = getFloorManifest(floorId);
  if (!manifest) {
    throw new Error(`Unknown floor id: ${floorId}`);
  }
  return manifest.implemented.winBudgetMs ?? null;
}

/**
 * Register a floor manifest (for testing or dynamic loading).
 * @param floorId - Floor identifier.
 * @param manifest - Floor manifest definition.
 */
export function registerFloorManifest(floorId: string, manifest: FloorManifestDef): void {
  FLOOR_REGISTRY.set(floorId, manifest);
}

/**
 * Check if a floor manifest exists.
 * @param floorId - Floor identifier.
 */
export function hasFloorManifest(floorId: string): boolean {
  return FLOOR_REGISTRY.has(floorId);
}

/**
 * Get the next floor ID in sequence, or undefined if this is the last floor.
 * @param currentFloorId - Current floor identifier.
 * @returns Next floor ID, or undefined if no next floor.
 */
export function getNextFloorId(currentFloorId: string): string | undefined {
  const floorIds = getAvailableFloorIds();
  const currentIndex = floorIds.indexOf(currentFloorId);
  if (currentIndex === -1 || currentIndex === floorIds.length - 1) {
    return undefined;
  }
  return floorIds[currentIndex + 1];
}
