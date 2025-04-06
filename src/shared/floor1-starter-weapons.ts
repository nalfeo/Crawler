const FLOOR1_EXPERIMENTAL_STARTER_QUERY_PARAM = 'floor1ExperimentalStarters';

export const FLOOR1_EXPERIMENTAL_STARTER_WEAPON_IDS = ['laser', 'punch', 'landmine'] as const;

const TRUTHY_QUERY_VALUES = new Set(['1', 'true', 'yes', 'on']);

function toSearchParams(
  search: string | URLSearchParams | null | undefined,
): URLSearchParams | null {
  if (search instanceof URLSearchParams) {
    return search;
  }
  if (typeof search === 'string') {
    return new URLSearchParams(search);
  }
  return null;
}

export function isFloor1ExperimentalStarterOptionsEnabled(
  search?: string | URLSearchParams | null,
): boolean {
  const params = toSearchParams(search);
  if (!params) {
    return false;
  }
  const raw = params.get(FLOOR1_EXPERIMENTAL_STARTER_QUERY_PARAM)?.trim().toLowerCase();
  return raw !== undefined && raw !== null && TRUTHY_QUERY_VALUES.has(raw);
}

export function getFloor1StarterWeaponPool(
  starterWeapons: readonly string[],
  options: { enableExperimental?: boolean } = {},
): string[] {
  const enableExperimental = options.enableExperimental ?? false;
  const pool: string[] = [];
  const seen = new Set<string>();

  const appendUnique = (weaponId: string): void => {
    if (seen.has(weaponId)) {
      return;
    }
    seen.add(weaponId);
    pool.push(weaponId);
  };

  for (const weaponId of starterWeapons) {
    appendUnique(weaponId);
  }

  if (enableExperimental) {
    for (const weaponId of FLOOR1_EXPERIMENTAL_STARTER_WEAPON_IDS) {
      appendUnique(weaponId);
    }
  }

  return pool;
}
