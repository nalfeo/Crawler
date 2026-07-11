export type LaunchSeedGenerator = () => number;

export function generateGameLaunchSeed(): number {
  const values = new Uint32Array(1);
  globalThis.crypto.getRandomValues(values);
  return ((values[0] ?? 0) % 1_000_000) + 1;
}

export function resolveGameLaunchSeed(
  search: string | URLSearchParams,
  generateSeed: LaunchSeedGenerator = generateGameLaunchSeed,
): number {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const rawSeed = params.get('seed');

  if (rawSeed !== null && /^-?\d+$/.test(rawSeed.trim())) {
    const seed = Number(rawSeed);
    if (Number.isSafeInteger(seed)) {
      return seed;
    }
  }

  return generateSeed();
}
