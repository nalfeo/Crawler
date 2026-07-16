import type { GameWorld } from '../../core/world.js';
import { getActiveWeaponDef } from '../../core/active-weapon.js';
import {
  PRIMARY_STATS,
  isAllocatablePrimaryStat,
  type PrimaryStatId,
  type StatId,
} from '../../shared/stats.js';

const ALLOCATABLE_STATS = PRIMARY_STATS.filter(isAllocatablePrimaryStat);
const MINIMUM_TARGET_ORDER = [
  'constitution',
  'strength',
  'dexterity',
  'intelligence',
  'wisdom',
  'luck',
] as const satisfies readonly PrimaryStatId[];

export interface WeaponPersona {
  readonly name: string;
  readonly minimumTargets: Partial<Readonly<Record<PrimaryStatId, number>>>;
  readonly statWeights: Partial<Readonly<Record<StatId, number>>>;
}

export const WEAPON_PERSONAS: Readonly<Partial<Record<string, WeaponPersona>>> = {
  sword: {
    name: 'Vanguard',
    minimumTargets: { constitution: 6, strength: 4 },
    statWeights: { strength: 5, constitution: 4, armor: 4, damagePercent: 3, dexterity: 2 },
  },
  bow: {
    name: 'Kite Archer',
    minimumTargets: { constitution: 7, dexterity: 5 },
    statWeights: {
      dexterity: 5,
      constitution: 4,
      attackSpeed: 4,
      moveSpeed: 4,
      luck: 2,
      critChance: 2,
    },
  },
  'baseball-bat': {
    name: 'Slugger',
    minimumTargets: { constitution: 7, strength: 5 },
    statWeights: { strength: 5, constitution: 5, armor: 4, damageBonus: 4, hpRegen: 2 },
  },
  pistol: {
    name: 'Gunslinger',
    minimumTargets: { constitution: 7, dexterity: 4, luck: 3 },
    statWeights: {
      luck: 5,
      dexterity: 4,
      constitution: 4,
      critChance: 5,
      attackSpeed: 3,
      moveSpeed: 2,
    },
  },
  'throwing-knife': {
    name: 'Skirmisher',
    minimumTargets: { constitution: 7, dexterity: 4 },
    statWeights: {
      dexterity: 5,
      constitution: 4,
      luck: 3,
      moveSpeed: 5,
      dodgeChance: 4,
      attackSpeed: 3,
    },
  },
  fireball: {
    name: 'Arcanist',
    minimumTargets: { constitution: 6, intelligence: 5, wisdom: 4 },
    statWeights: {
      intelligence: 5,
      wisdom: 4,
      constitution: 4,
      cooldownReduction: 4,
    },
  },
};

export function getWeaponPersona(weaponId: string | undefined): WeaponPersona | undefined {
  return weaponId === undefined ? undefined : WEAPON_PERSONAS[weaponId];
}

export function getWeaponPersonaForWorld(world: GameWorld): WeaponPersona | undefined {
  return getWeaponPersona(
    getActiveWeaponDef(world)?.id ?? world.floorScenario?.selectedWeaponId ?? undefined,
  );
}

function currentPrimaryStat(world: GameWorld, playerEid: number, stat: PrimaryStatId): number {
  return world.stores.coreStatPoints[stat][playerEid] ?? 0;
}

function chooseMinimumTarget(
  world: GameWorld,
  playerEid: number,
  persona: WeaponPersona,
  allocation: Partial<Record<PrimaryStatId, number>>,
): PrimaryStatId | undefined {
  for (const stat of MINIMUM_TARGET_ORDER) {
    const target = persona.minimumTargets[stat] ?? 0;
    const current = currentPrimaryStat(world, playerEid, stat) + (allocation[stat] ?? 0);
    if (current < target) return stat;
  }
  return undefined;
}

function chooseWeightedStat(
  world: GameWorld,
  playerEid: number,
  persona: WeaponPersona,
  allocation: Partial<Record<PrimaryStatId, number>>,
): PrimaryStatId {
  const firstAllocatableStat = ALLOCATABLE_STATS[0];
  if (firstAllocatableStat === undefined) {
    throw new Error('No allocatable primary stats configured');
  }
  let best: PrimaryStatId = firstAllocatableStat;
  let bestRatio = Infinity;
  let bestWeight = -Infinity;
  for (const stat of ALLOCATABLE_STATS) {
    const weight = persona.statWeights[stat] ?? 0;
    if (weight <= 0) continue;
    const current = currentPrimaryStat(world, playerEid, stat) + (allocation[stat] ?? 0);
    const ratio = current / weight;
    if (ratio < bestRatio || (ratio === bestRatio && weight > bestWeight)) {
      best = stat;
      bestRatio = ratio;
      bestWeight = weight;
    }
  }
  return best;
}

export function computeWeaponPersonaStatAllocation(
  world: GameWorld,
  playerEid: number,
  available: number,
  persona: WeaponPersona,
): Partial<Record<PrimaryStatId, number>> {
  const allocation: Partial<Record<PrimaryStatId, number>> = {};
  const points = Number.isFinite(available) ? Math.max(0, Math.floor(available)) : 0;
  for (let point = 0; point < points; point += 1) {
    const stat =
      chooseMinimumTarget(world, playerEid, persona, allocation) ??
      chooseWeightedStat(world, playerEid, persona, allocation);
    allocation[stat] = (allocation[stat] ?? 0) + 1;
  }
  return allocation;
}
