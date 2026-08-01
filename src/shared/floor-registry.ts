/**
 * Floor Registry — centralized floor manifest loader.
 *
 * This module provides a registry for loading floor manifests by ID,
 * enabling multi-floor support and floor progression.
 */
import { floor1Manifest, floor2Manifest, type FloorManifestDef } from './floor-manifest.js';

const BUILT_IN_FLOOR_MANIFEST_SNAPSHOTS = new Map<string, FloorManifestDef>([
  ['floor1', structuredClone(floor1Manifest)],
  ['floor2', structuredClone(floor2Manifest)],
]);

function cloneBuiltInFloorManifest(floorId: string): FloorManifestDef {
  const manifest = BUILT_IN_FLOOR_MANIFEST_SNAPSHOTS.get(floorId);
  if (!manifest) {
    throw new Error(`Unknown built-in floor manifest "${floorId}"`);
  }
  return structuredClone(manifest);
}

/**
 * Registry of available floor manifests.
 */
const FLOOR_REGISTRY = new Map<string, FloorManifestDef>([
  ['floor1', cloneBuiltInFloorManifest('floor1')],
  ['floor2', cloneBuiltInFloorManifest('floor2')],
]);

function manifestsMatch(left: FloorManifestDef | undefined, right: FloorManifestDef): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

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
 * Register a floor manifest (for testing or dynamic loading).
 *
 * Overriding a built-in floor (`floor1` / `floor2`) mutates process-global state.
 * Call `resetBuiltInFloorManifests()` after the scoped override, or run headless
 * batches in fresh Node processes.
 * @param floorId - Floor identifier.
 * @param manifest - Floor manifest definition.
 */
export function registerFloorManifest(floorId: string, manifest: FloorManifestDef): void {
  FLOOR_REGISTRY.set(floorId, manifest);
}

/**
 * Restore built-in floor manifests to their shipped defaults while preserving any
 * custom floor registrations.
 */
export function resetBuiltInFloorManifests(): void {
  for (const floorId of BUILT_IN_FLOOR_MANIFEST_SNAPSHOTS.keys()) {
    FLOOR_REGISTRY.set(floorId, cloneBuiltInFloorManifest(floorId));
  }
}

/**
 * Return the built-in floor ids whose registry entries no longer match their
 * shipped defaults.
 */
export function getOverriddenBuiltInFloorManifestIds(): string[] {
  const overridden: string[] = [];
  for (const [floorId, manifest] of BUILT_IN_FLOOR_MANIFEST_SNAPSHOTS) {
    if (!manifestsMatch(FLOOR_REGISTRY.get(floorId), manifest)) {
      overridden.push(floorId);
    }
  }
  return overridden;
}

/**
 * Guard headless runners and other measurement harnesses against process-scoped
 * floor-manifest contamination.
 */
export function assertBuiltInFloorManifestsClean(context = 'floor registry consumer'): void {
  const overridden = getOverriddenBuiltInFloorManifestIds();
  if (overridden.length === 0) return;
  throw new Error(
    `${context} requires built-in floor manifests to match their shipped defaults before each run. ` +
      `Detected overridden manifest(s): ${overridden.join(', ')}. ` +
      `Call resetBuiltInFloorManifests() after scoped overrides or run each batch in a fresh Node process.`,
  );
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
