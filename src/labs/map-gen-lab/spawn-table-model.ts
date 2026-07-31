import type { EnemyArchetypeDef, EnemyPackDef } from '../../shared/enemy-packs.js';
import { BiomeType } from '../../shared/map-types.js';
import type { SpawnerArchetype } from '../../game/spawners/types.js';
import floor2ScenarioTestSeams from '../../game/floor2Scenario.test-seams.js';

export interface SpawnTableRow {
  readonly region: string;
  readonly mobs: string;
  readonly quantity: string;
  readonly cadence: string;
  readonly trigger: string;
}

export type SpawnQuadrantId = 'N' | 'S' | 'E' | 'W';

export interface SpawnTableQuadrantEntry {
  readonly quadrant: SpawnQuadrantId;
  readonly archetypeId: string;
  readonly archetypeName: string;
}

export interface SpawnTableSpawnerEntry {
  readonly region: string;
  readonly archetype: SpawnerArchetype;
}

export interface SpawnTableTerritoryEntry {
  readonly region: string;
  readonly familyId?: string;
  readonly familyName: string;
}

export interface SpawnTableBossDenEntry {
  readonly region: string;
  readonly familyId?: string;
  readonly familyName: string;
}

export interface SpawnTableContext {
  readonly biome: BiomeType;
  readonly ambientPack?: EnemyPackDef;
  readonly includeGlobalAmbient: boolean;
  readonly quadrants: readonly SpawnTableQuadrantEntry[];
  readonly spawners: readonly SpawnTableSpawnerEntry[];
  readonly territories: readonly SpawnTableTerritoryEntry[];
  readonly bossDens: readonly SpawnTableBossDenEntry[];
}

function weightedMobSummary(archetypes: readonly EnemyArchetypeDef[]): string {
  const weighted = archetypes.filter((entry) => entry.spawnWeight > 0);
  if (weighted.length === 0) return 'none';
  const total = weighted.reduce((sum, entry) => sum + entry.spawnWeight, 0);
  if (total <= 0) return weighted.map((entry) => entry.name).join(', ');
  return weighted
    .slice()
    .sort((a, b) => b.spawnWeight - a.spawnWeight || a.id.localeCompare(b.id))
    .map((entry) => `${entry.name} (${Math.round((entry.spawnWeight / total) * 100)}%)`)
    .join(', ');
}

function poolSummary(
  pool: readonly {
    readonly weight: number;
    readonly mob: { readonly name: string };
  }[],
): string {
  const total = pool.reduce((sum, entry) => sum + Math.max(0, entry.weight), 0);
  if (pool.length === 0) return 'none';
  if (total <= 0) return pool.map((entry) => entry.mob.name).join(', ');
  return pool
    .map((entry) => `${entry.mob.name} (${Math.round((Math.max(0, entry.weight) / total) * 100)}%)`)
    .join(', ');
}

function summarizeOnDeath(archetype: SpawnerArchetype): string {
  const groups = archetype.onDeath.map((group) => `+${group.count} ${poolSummary(group.pool)}`);
  return groups.length > 0 ? groups.join(' | ') : 'none';
}

function summarizeSpawnerMobs(archetype: SpawnerArchetype): string {
  return [
    `Passive: ${poolSummary(archetype.passive.pool)}`,
    `Defensive: ${poolSummary(archetype.defensive.pool)}`,
    `On death: ${summarizeOnDeath(archetype)}`,
  ].join(' • ');
}

function buildAmbientRows(context: SpawnTableContext): SpawnTableRow[] {
  if (!context.includeGlobalAmbient) return [];
  const pack = context.ambientPack;
  if (!pack) return [];
  return [
    {
      region: 'Global spawn zone (entire map)',
      mobs: weightedMobSummary(pack.archetypes.filter((entry) => entry.isBoss !== true)),
      quantity: `cap ${pack.enemyCap}, wave ${pack.roomWaveMin}-${pack.roomWaveMax}, ≤${pack.maxSpawnsPerTick}/tick`,
      cadence: `every ${pack.spawnIntervalMs}ms`,
      trigger: 'ambient director loop',
    },
  ];
}

function buildQuadrantRows(context: SpawnTableContext): SpawnTableRow[] {
  if (context.quadrants.length === 0 || context.biome !== BiomeType.CAVE_SYSTEM) return [];
  const quadrants = new Map<SpawnQuadrantId, SpawnTableQuadrantEntry>(
    context.quadrants.map((entry) => [entry.quadrant, entry]),
  );
  const order: readonly SpawnQuadrantId[] = ['N', 'S', 'E', 'W'];
  const orderIndex = new Map<SpawnQuadrantId, number>(order.map((id, index) => [id, index]));
  const cadence = context.ambientPack
    ? `every ${context.ambientPack.spawnIntervalMs}ms`
    : 'ambient cadence';
  return order
    .map((quadrantId) => {
      const primary = quadrants.get(quadrantId);
      if (!primary) return null;
      const weightedArchetypes = [
        ...floor2ScenarioTestSeams.getQuadrantSpawnWeights(quadrantId).entries(),
      ]
        .map((entry) => ({
          quadrant: entry[0] as SpawnQuadrantId,
          weight: Math.round(entry[1] * 100),
        }))
        .filter((weighted) => weighted.weight > 0 && quadrants.has(weighted.quadrant))
        .sort(
          (a, b) =>
            b.weight - a.weight ||
            (orderIndex.get(a.quadrant) ?? 0) - (orderIndex.get(b.quadrant) ?? 0),
        );
      const mobs = weightedArchetypes
        .map((weighted) => `${quadrants.get(weighted.quadrant)!.archetypeName} ${weighted.weight}%`)
        .join(', ');
      return {
        region: `Quadrant ${quadrantId}`,
        mobs,
        quantity: context.ambientPack
          ? `shares cap ${context.ambientPack.enemyCap}`
          : 'shared ambient pool',
        cadence,
        trigger: `quadrant territory weighting (${quadrantId} primary)`,
      } satisfies SpawnTableRow;
    })
    .filter((row): row is SpawnTableRow => row !== null);
}

function buildTerritoryRows(context: SpawnTableContext): SpawnTableRow[] {
  if (context.territories.length === 0) return [];
  const pack = context.ambientPack;
  const rows: SpawnTableRow[] = [];
  for (const territory of context.territories) {
    const familyTrash =
      pack?.archetypes.filter(
        (entry) =>
          entry.isBoss !== true &&
          entry.familyId !== undefined &&
          entry.familyId === territory.familyId,
      ) ?? [];
    rows.push({
      region: territory.region,
      mobs: familyTrash.length > 0 ? weightedMobSummary(familyTrash) : 'family trash (runtime)',
      quantity: pack ? `shares cap ${pack.enemyCap}` : 'shared ambient pool',
      cadence: pack ? `every ${pack.spawnIntervalMs}ms` : 'ambient cadence',
      trigger: `ambient family pressure (${territory.familyName})`,
    });
  }
  return rows;
}

function buildBossDenRows(context: SpawnTableContext): SpawnTableRow[] {
  if (context.bossDens.length === 0) return [];
  const pack = context.ambientPack;
  return context.bossDens.map((den) => {
    const boss = pack?.archetypes.find(
      (entry) =>
        entry.isBoss === true && entry.familyId !== undefined && entry.familyId === den.familyId,
    );
    return {
      region: den.region,
      mobs: boss?.name ?? `${den.familyName} boss`,
      quantity: '1 boss',
      cadence: 'once (floor init)',
      trigger: `den unlock criteria (${den.familyName})`,
    };
  });
}

function buildSpawnerRows(context: SpawnTableContext): SpawnTableRow[] {
  if (context.spawners.length === 0) return [];
  const grouped = new Map<string, { region: string; archetype: SpawnerArchetype; count: number }>();
  for (const spawner of context.spawners) {
    const key = `${spawner.region}|${spawner.archetype.id}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    grouped.set(key, { region: spawner.region, archetype: spawner.archetype, count: 1 });
  }
  return [...grouped.values()]
    .sort(
      (a, b) =>
        a.region.localeCompare(b.region) ||
        a.archetype.name.localeCompare(b.archetype.name) ||
        a.count - b.count,
    )
    .map((entry) => ({
      region: entry.region,
      mobs: summarizeSpawnerMobs(entry.archetype),
      quantity:
        `x${entry.count}; passive ≤${entry.archetype.passive.maxAlive}, ` +
        `defensive ≤${entry.archetype.defensive.maxAlive}`,
      cadence:
        `${entry.archetype.passive.intervalMs}ms passive / ` +
        `${entry.archetype.defensive.intervalMs}ms defensive`,
      trigger: 'idle passive, hit → defensive, death → finale wave',
    }));
}

export function buildSpawnTableRows(context: SpawnTableContext): SpawnTableRow[] {
  const providers = [
    buildAmbientRows,
    buildQuadrantRows,
    buildTerritoryRows,
    buildBossDenRows,
    buildSpawnerRows,
  ] as const;
  return providers.flatMap((provider) => provider(context));
}
