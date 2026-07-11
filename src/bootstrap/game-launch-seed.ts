export type LaunchSeedGenerator = () => number;

export function generateGameLaunchSeed(): number {
  const values = new Uint32Array(1);
  let seed = 0;
  while (seed === 0) {
    globalThis.crypto.getRandomValues(values);
    seed = values[0]!;
  }
  return seed;
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
