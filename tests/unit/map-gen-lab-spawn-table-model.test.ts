import { describe, expect, it } from 'vitest';
import { BiomeType } from '../../src/shared/map-types.js';
import type { EnemyPackDef } from '../../src/shared/enemy-packs.js';
import type { SpawnerArchetype } from '../../src/game/spawners/types.js';
import { buildSpawnTableRows } from '../../src/labs/map-gen-lab/spawn-table-model.js';

const FLOOR2_PACK: EnemyPackDef = {
  id: 'floor2-families',
  name: 'Floor 2',
  enemyCap: 24,
  spawnIntervalMs: 2400,
  spawnRadiusMin: 20,
  despawnDistanceFt: 180,
  engageRadiusFt: 48,
  engageTarget: 6,
  maxSpawnsPerTick: 3,
  roomWaveChance: 0.25,
  roomWaveMin: 2,
  roomWaveMax: 4,
  archetypes: [
    {
      id: 'rat-trash',
      name: 'Rat Trash',
      hp: 10,
      speed: 0.2,
      detectRange: 40,
      spriteTexture: 1,
      spriteWidth: 2,
      spriteHeight: 2,
      aiType: 'chase',
      spawnWeight: 0.6,
      familyId: 'family-rat',
    },
    {
      id: 'neutral-trash',
      name: 'Neutral Trash',
      hp: 10,
      speed: 0.2,
      detectRange: 40,
      spriteTexture: 1,
      spriteWidth: 2,
      spriteHeight: 2,
      aiType: 'chase',
      spawnWeight: 0.4,
    },
    {
      id: 'rat-boss',
      name: 'Rat Boss',
      hp: 120,
      speed: 0.15,
      detectRange: 60,
      spriteTexture: 1,
      spriteWidth: 3,
      spriteHeight: 3,
      aiType: 'chase',
      spawnWeight: 0,
      familyId: 'family-rat',
      isBoss: true,
    },
  ],
};

const RATS_NEST: SpawnerArchetype = {
  id: 'rats-nest',
  name: 'Rats Nest',
  hp: 100,
  weight: 200,
  bloodColor: 0,
  textureId: 1,
  spriteWidth: 3,
  spriteHeight: 3,
  contactDamage: 4,
  arenaRadiusFt: 6,
  passive: {
    intervalMs: 3600,
    maxAlive: 3,
    perPulse: 1,
    pool: [{ weight: 1, mob: { name: 'Rat' } as never }],
  },
  defensive: {
    intervalMs: 1800,
    maxAlive: 5,
    perPulse: 2,
    pool: [{ weight: 1, mob: { name: 'Rat Brute' } as never }],
  },
  onDeath: [{ count: 2, pool: [{ weight: 1, mob: { name: 'Rat King' } as never }] }],
};

describe('map-gen-lab spawn table model', () => {
  it('builds deterministic rows for ambient, territories, dens, quadrants, and spawners', () => {
    const rows = buildSpawnTableRows({
      biome: BiomeType.CAVE_SYSTEM,
      ambientPack: FLOOR2_PACK,
      includeGlobalAmbient: true,
      quadrants: [
        { quadrant: 'N', archetypeId: 'rat-trash', archetypeName: 'Rat Trash' },
        { quadrant: 'S', archetypeId: 'neutral-trash', archetypeName: 'Neutral Trash' },
        { quadrant: 'E', archetypeId: 'rat-trash', archetypeName: 'Rat Trash' },
        { quadrant: 'W', archetypeId: 'neutral-trash', archetypeName: 'Neutral Trash' },
      ],
      territories: [{ region: 'Territory T0', familyId: 'family-rat', familyName: 'Rats' }],
      bossDens: [{ region: 'Boss den D0', familyId: 'family-rat', familyName: 'Rats' }],
      spawners: [{ region: 'Settlement / bar (room 3)', archetype: RATS_NEST }],
    });

    expect(rows.find((row) => row.region === 'Global spawn zone (entire map)')).toBeTruthy();
    expect(rows.find((row) => row.region === 'Quadrant N')).toBeTruthy();
    expect(rows.find((row) => row.region === 'Territory T0')?.mobs).toContain('Rat Trash');
    expect(rows.find((row) => row.region === 'Boss den D0')?.mobs).toContain('Rat Boss');
    expect(rows.find((row) => row.region === 'Settlement / bar (room 3)')?.cadence).toContain(
      '3600ms',
    );
  });

  it('omits global ambient row when floor uses quadrant-only ambient logic', () => {
    const rows = buildSpawnTableRows({
      biome: BiomeType.CAVE_SYSTEM,
      ambientPack: FLOOR2_PACK,
      includeGlobalAmbient: false,
      quadrants: [
        { quadrant: 'N', archetypeId: 'rat-trash', archetypeName: 'Rat Trash' },
        { quadrant: 'S', archetypeId: 'neutral-trash', archetypeName: 'Neutral Trash' },
        { quadrant: 'E', archetypeId: 'rat-trash', archetypeName: 'Rat Trash' },
        { quadrant: 'W', archetypeId: 'neutral-trash', archetypeName: 'Neutral Trash' },
      ],
      territories: [],
      bossDens: [],
      spawners: [],
    });
    expect(rows.some((row) => row.region === 'Global spawn zone (entire map)')).toBe(false);
    expect(rows.filter((row) => row.region.startsWith('Quadrant '))).toHaveLength(4);
  });
});
