/**
 * Lab Tuning API — client-side helper for saving tuned values back to repo.
 *
 * Labs call `saveTuning()` to POST current slider values to the dev server,
 * which writes them to the JSON data files in src/shared/data/.
 *
 * Usage in a lab:
 *   import { saveTuning } from '../lab-tuning.js';
 *
 *   // Save a single value
 *   saveTuning('tuning.json', 'player.speed', 4.5);
 *
 *   // Save a weapon property
 *   saveTuning('weapons.json', 'baseDamage', 20, 'sword');
 */

export interface SaveResult {
  ok: boolean;
  error?: string;
}

export interface RepoWriteCapability {
  enabled: boolean;
  reason?: string;
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

export function getRepoWriteCapability(): RepoWriteCapability {
  const { hostname } = window.location;
  if (!isLoopbackHostname(hostname)) {
    return {
      enabled: false,
      reason: `repo writes are local-only (current host: ${hostname})`,
    };
  }

  return { enabled: true };
}

/** Save a single tuning value to a data file. */
export async function saveTuning(
  file: string,
  path: string,
  value: unknown,
  id?: string,
): Promise<SaveResult> {
  const capability = getRepoWriteCapability();
  if (!capability.enabled) {
    return { ok: false, error: capability.reason };
  }

  try {
    const body: Record<string, unknown> = { file, path, value };
    if (id) body['id'] = id;

    const res = await fetch('/__save-tuning', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await res.json()) as SaveResult;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' };
  }
}
