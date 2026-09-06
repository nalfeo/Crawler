import { hasComponent } from 'bitecs';
import { getActiveWeaponDef } from '../../core/active-weapon.js';
import { BaseStats, type GameWorld } from '../../core/index.js';
import { equip, initializeBaseStats, unequip } from '../../core/systems/equipmentSystem.js';
import { statSystem } from '../../core/systems/statSystem.js';
import type { FloorManifestDef } from '../../shared/floor-manifest.js';
import { getEquipmentDefForItem } from '../../shared/equipmentDefs.js';
import type { EquipFailureReason } from '../../shared/equipment-types.js';
import { hashStringToSeed, SeededRandom } from '../../shared/random.js';
import { getWeaponDef } from '../../shared/weaponDefs.js';
import type { SkillState } from '../../shared/skills.js';
import { getSkillDefinition } from '../skills/registry.js';
import { skillSystem } from '../systems/skillSystem.js';
import { synchronizeAbilityPassives } from '../systems/abilitySystem.js';
import { spendPoints } from '../systems/statsSystem.js';
import { computeAutoStatAllocation } from './playerStatAllocationPolicy.js';
import { applyStartPlayerLevel } from './playerLevelProgression.js';
import { equipStarterOrFallback } from './starterWeaponEquip.js';
import { initializePlayerWeaponSkills } from '../floorScenario.js';

function describeEquipFailureReason(reason: EquipFailureReason): string {
  switch (reason.type) {
    case 'unknownSlot':
      return `unknown slot '${reason.slotId}'`;
    case 'occupiedSlot':
      return `occupied slot '${reason.slotId}'`;
    default:
      return reason.message;
  }
}

function equipDirectStartWeapon(world: GameWorld, manifest: FloorManifestDef): void {
  if (getActiveWeaponDef(world) !== undefined || manifest.starterWeapons.length === 0) {
    return;
  }

  const weaponRng = new SeededRandom(
    hashStringToSeed(`${world.seed}:${manifest.id}-starter-weapon`),
  );
  const pickedId =
    manifest.starterWeapons[weaponRng.nextInt(0, manifest.starterWeapons.length - 1)];
  const weaponDef =
    (pickedId ? getWeaponDef(pickedId) : undefined) ??
    (manifest.starterWeapons[0] ? getWeaponDef(manifest.starterWeapons[0]) : undefined);
  if (weaponDef !== undefined) {
    equipStarterOrFallback(world, weaponDef.id, weaponDef);
  }
}

function raiseSkillLevel(
  world: GameWorld,
  playerEid: number,
  skillId: string,
  targetLevel: number,
): void {
  const level = Math.max(0, Math.floor(targetLevel));
  if (level <= 0) return;

  const def = getSkillDefinition(skillId);
  if (def === undefined) {
    throw new Error(`Unknown floor direct-start skill id: ${skillId}`);
  }
  const threshold = def.usageThresholds[level - 1];
  if (threshold === undefined) {
    throw new Error(`Cannot seed skill "${skillId}" to unsupported level ${level}`);
  }

  const holderSkills = world.skillStatesByEntity.get(playerEid);
  const state: SkillState | undefined =
    holderSkills?.get(skillId) ?? world.playerSkills.get(skillId);
  if (state === undefined || state.level >= level) return;

  const neededUsage = Math.max(0, threshold - state.usage);
  if (neededUsage <= 0) return;
  world.skillUsageEvents.push({
    holderEid: playerEid,
    skillId,
    metric: def.usageMetric,
    amount: neededUsage,
  });
}

export function applyFloorSkipBaseline(
  world: GameWorld,
  playerEid: number,
  manifest: FloorManifestDef,
): void {
  const baseline = manifest.player.directStart;
  if (baseline === undefined) {
    return;
  }

  if (!hasComponent(world.ecs, playerEid, BaseStats)) {
    initializeBaseStats(world, playerEid);
  }
  equipDirectStartWeapon(world, manifest);
  initializePlayerWeaponSkills(world, playerEid);
  applyStartPlayerLevel(world, baseline.level);

  const allocations = computeAutoStatAllocation(world, playerEid, world.playerLevel.unspentPoints);
  if (Object.keys(allocations).length > 0) {
    spendPoints(world, allocations);
  }

  const skillLevels = new Map(Object.entries(baseline.skillLevels));
  const activeWeapon = getActiveWeaponDef(world);
  if (activeWeapon !== undefined && baseline.weaponSkillLevel > 0) {
    skillLevels.set(activeWeapon.weaponClassSkillId, baseline.weaponSkillLevel);
    skillLevels.set(activeWeapon.weaponTypeSkillId, baseline.weaponSkillLevel);
  }
  for (const [skillId, level] of skillLevels) {
    raiseSkillLevel(world, playerEid, skillId, level);
  }
  if (world.skillUsageEvents.length > 0) {
    skillSystem(world);
    synchronizeAbilityPassives(world, playerEid, { suppressActivationVfx: true });
  }

  for (const itemId of baseline.equipmentItemIds) {
    const def = getEquipmentDefForItem(itemId);
    if (def === undefined) {
      throw new Error(`Unknown floor direct-start equipment item id: ${itemId}`);
    }
    for (const slotId of def.slots) {
      unequip(world, playerEid, slotId, { force: true });
    }
    const result = equip(world, playerEid, def, { force: true });
    if (!result.ok) {
      throw new Error(
        `Failed to equip floor direct-start item "${itemId}": ${result.reasons.map(describeEquipFailureReason).join('; ')}`,
      );
    }
  }
  statSystem(world);
}
