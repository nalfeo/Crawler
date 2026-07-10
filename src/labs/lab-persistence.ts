/**
 * Lab state persistence via sessionStorage.
 *
 * Saves and restores lab settings across HMR rebuilds so tuning
 * values, weapon selections, and arena config survive agent edits.
 */

const STORAGE_PREFIX = 'crawler-lab:';

/** Save arbitrary lab state to sessionStorage. */
export function saveLabState<T>(labId: string, state: T): void {
  try {
    sessionStorage.setItem(`${STORAGE_PREFIX}${labId}`, JSON.stringify(state));
  } catch {
    // Silently ignore quota/serialization errors
  }
}

/** Load previously saved lab state, or undefined if none exists. */
export function loadLabState<T>(labId: string): T | undefined {
  try {
    const raw = sessionStorage.getItem(`${STORAGE_PREFIX}${labId}`);
    if (raw === null) return undefined;
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}
