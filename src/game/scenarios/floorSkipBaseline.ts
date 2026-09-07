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
  const cappedLevel = Math.min(level, def.usageThresholds.length);
  const threshold = def.usageThresholds[cappedLevel - 1];

  let holderSkills = world.skillStatesByEntity.get(playerEid);
  if (holderSkills === undefined) {
    holderSkills = new Map<string, SkillState>();
    world.skillStatesByEntity.set(playerEid, holderSkills);
  }
  let state: SkillState | undefined = holderSkills.get(skillId) ?? world.playerSkills.get(skillId);
  if (state === undefined) {
    state = { level: 0, usage: 0, itemBonus: 0, triggeredMilestones: new Set() };
    world.playerSkills.set(skillId, state);
  }
  if (!holderSkills.has(skillId)) {
    holderSkills.set(skillId, state);
  }
  if (threshold === undefined || state.level >= cappedLevel) return;

  const neededUsage = Math.max(0, threshold - state.usage);
  if (neededUsage <= 0) return;
  world.skillUsageEvents.push({
    holderEid: playerEid,
    skillId,
    metric: def.usageMetric,
    amount: neededUsage,
  });
}

/**
 * Copy of a transient event queue's current contents, for restoring later via
 * `restoreTransientQueue`. Keeps snapshot/restore paired and DRY across the
 * several transient queues `applyFloorSkipBaseline` must silence.
 */
function snapshotTransientQueue<T>(queue: readonly T[]): T[] {
  return [...queue];
}

/**
 * Restore a transient event queue to a prior snapshot in place, correct even
 * if the queue was spliced/reordered (not just appended to) in the interim.
 */
function restoreTransientQueue<T>(queue: T[], snapshot: readonly T[]): void {
  queue.splice(0, queue.length, ...snapshot);
}

/** Options for {@link applyFloorSkipBaseline}. */
export interface FloorSkipBaselineOptions {
  /**
   * Skip the deterministic starter-weapon fallback entirely. Floor 3's
   * Wrangler is an intentional non-combatant — the starter Companion fights
   * instead, and `floor3NonCombatantSystem` force-clears any *active* weapon
   * every frame. But that clear happens on the first system tick, one frame
   * too late for the behavior-tree AI: its engagement-radius/kiting planning
   * reads `getActiveWeaponDef` on the very first decision, sees an armed
   * player, and mis-plans standoff movement for the rest of the run (the
   * fallback would otherwise arm the Wrangler on every direct-start skip,
   * since Floor 3 never pre-equips a starter weapon the way Floors 4/5/6 do).
   * Pass `true` only from Floor 3's scenario init.
   */
  suppressStarterWeapon?: boolean;
}

/**
 * Apply a manifest-authored direct-start baseline for floor skips with no player
 * carryover. Call only from no-carryover scenario initialization; it is a no-op
 * when the manifest has no `player.directStart`. Floors may equip a starter
 * weapon before calling this, otherwise the helper picks one deterministically
 * unless `options.suppressStarterWeapon` opts out entirely.
 */
export function applyFloorSkipBaseline(
  world: GameWorld,
  playerEid: number,
  manifest: FloorManifestDef,
  options?: FloorSkipBaselineOptions,
): void {
  const baseline = manifest.player.directStart;
  if (baseline === undefined) {
    return;
  }

  if (!hasComponent(world.ecs, playerEid, BaseStats)) {
    initializeBaseStats(world, playerEid);
  }
  if (!options?.suppressStarterWeapon) {
    equipDirectStartWeapon(world, manifest);
  }
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
    // skillSystem is the real per-frame skill-usage processor: it grants
    // skill state, ability sources, and milestone log entries correctly, but
    // it is not a "silent" seeding path — it also unconditionally emits
    // runtime-only presentation events (one level-up floater per seeded
    // level, milestone VFX/announcements) and queues `abilityTriggerEvents`
    // for any newly granted skill-triggered active ability. None of that is
    // appropriate for a synthetic floor-skip baseline seed: a Floor 6 direct
    // start would otherwise show a stack of stale level-up floaters/VFX, and
    // a pistol baseline could auto-fire its newly granted skill-triggered
    // ability on the very first frame. Snapshot the transient queues here
    // and restore them below, after skill state, ability grants, and the
    // milestone log have already been applied for real.
    const floaterEventsBefore = snapshotTransientQueue(world.floaterEvents);
    const vfxEventsBefore = snapshotTransientQueue(world.vfxEvents);
    const announcementsBefore = snapshotTransientQueue(world.announcements);
    const abilityTriggerEventsBefore = snapshotTransientQueue(world.abilityTriggerEvents);

    skillSystem(world);
    synchronizeAbilityPassives(world, playerEid, { suppressActivationVfx: true });

    restoreTransientQueue(world.floaterEvents, floaterEventsBefore);
    restoreTransientQueue(world.vfxEvents, vfxEventsBefore);
    restoreTransientQueue(world.announcements, announcementsBefore);
    restoreTransientQueue(world.abilityTriggerEvents, abilityTriggerEventsBefore);
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
