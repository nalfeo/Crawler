const FLOOR_SPAWNER_ARENA_QUERY_PARAM = 'floorSpawnerArenas';
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
  return raw !== undefined && raw !== null && TRUTHY_QUERY_VALUES.has(raw);
}
