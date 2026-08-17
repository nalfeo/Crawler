const FLOOR_SPAWNER_ARENA_QUERY_PARAM = 'floorSpawnerArenas';
const FLOOR_SPAWNER_COUNT_QUERY_PARAM = 'floorSpawnerCount';
const FLOOR_SPAWNER_COUNT_ENV_VAR = 'FLOOR_SPAWNER_COUNT';
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

export function isFloorSpawnerArenaExperimentEnabled(
  search?: string | URLSearchParams | null,
): boolean {
  const params = toSearchParams(search);
  if (!params) {
    return false;
  }
  const raw = params.get(FLOOR_SPAWNER_ARENA_QUERY_PARAM)?.trim().toLowerCase();
  return raw !== undefined && TRUTHY_QUERY_VALUES.has(raw);
}

function parseFloorSpawnerCount(raw: string | null | undefined): number | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const value = Number.parseInt(trimmed, 10);
  return Number.isFinite(value) ? value : null;
}

export function resolveFloorSpawnerCountOverride(
  search?: string | URLSearchParams | null,
  env: Readonly<Record<string, string | undefined>> | undefined = typeof process !== 'undefined'
    ? process.env
    : undefined,
): number | null {
  const params = toSearchParams(search);
  const fromQuery = parseFloorSpawnerCount(params?.get(FLOOR_SPAWNER_COUNT_QUERY_PARAM));
  if (fromQuery !== null) {
    return fromQuery;
  }
  return parseFloorSpawnerCount(env?.[FLOOR_SPAWNER_COUNT_ENV_VAR]);
}

export function getCurrentLocationSearch(): string | undefined {
  return typeof window !== 'undefined' ? window.location.search : undefined;
}
