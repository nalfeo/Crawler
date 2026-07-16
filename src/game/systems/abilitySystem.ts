import { hasComponent, query } from 'bitecs';
import {
  ACTIVE_ABILITY_SLOT_LIMIT,
  type AbilityState,
  type AbilityTriggerCondition,
  type AbilityTriggerEvent,
} from '../abilities/types.js';
import { EffectiveStats, Enemy, Health, Player, Position } from '../../core/components.js';
import type { GameWorld } from '../../core/world.js';
import { applyCooldownReduction } from '../../shared/stats.js';
import { getAbilityDefinition } from '../abilities/registry.js';
import { applyCatalogEffect } from './progressionEffects.js';
import { removeStatModifiers } from './statsSystem.js';
import { getActiveWeaponDef } from '../../core/active-weapon.js';
import { pushVfxEvent } from '../../shared/vfx-events.js';

export function createAbilityState(): AbilityState {
  return {
    learnedSpellIds: [],
    equippedActiveAbilityIds: [],
    passiveAbilityIds: [],
    cooldownByAbilityId: new Map(),
    cooldownFramesByAbilityId: new Map(),
    appliedPassiveAbilityIds: new Set(),
  };
}

export function getOrCreateAbilityState(world: GameWorld, holderEid: number): AbilityState {
  const existing = world.abilityStatesByEntity.get(holderEid);
  if (existing !== undefined) return existing;
  const created = createAbilityState();
  world.abilityStatesByEntity.set(holderEid, created);
  return created;
}

export function equipActiveAbility(world: GameWorld, holderEid: number, abilityId: string): void {
  const def = getAbilityDefinition(abilityId);
  if (def === undefined) {
    throw new Error(`Unknown ability id: ${abilityId}`);
  }
  if (def.kind === 'passive') {
    throw new Error(`Cannot equip passive ability ${abilityId} in an active slot`);
  }

  const state = getOrCreateAbilityState(world, holderEid);
  if (state.equippedActiveAbilityIds.includes(abilityId)) {
    return;
  }
  if (state.equippedActiveAbilityIds.length >= ACTIVE_ABILITY_SLOT_LIMIT) {
    throw new Error(`Active ability slot cap reached (${ACTIVE_ABILITY_SLOT_LIMIT})`);
  }
  state.equippedActiveAbilityIds.push(abilityId);
}

export function unequipActiveAbility(world: GameWorld, holderEid: number, abilityId: string): void {
  const state = getOrCreateAbilityState(world, holderEid);
  const idx = state.equippedActiveAbilityIds.indexOf(abilityId);
  if (idx >= 0) {
    state.equippedActiveAbilityIds.splice(idx, 1);
  }
}

export function memorizeSpell(world: GameWorld, holderEid: number, abilityId: string): void {
  const def = getAbilityDefinition(abilityId);
  if (def === undefined) {
    throw new Error(`Unknown ability id: ${abilityId}`);
  }
  if (def.kind !== 'spell') {
    throw new Error(`Ability ${abilityId} is not a spell`);
  }
  const state = getOrCreateAbilityState(world, holderEid);
  if (!state.learnedSpellIds.includes(abilityId)) {
    state.learnedSpellIds.push(abilityId);
  }
  equipActiveAbility(world, holderEid, abilityId);
}

export function grantPassiveAbility(world: GameWorld, holderEid: number, abilityId: string): void {
  const def = getAbilityDefinition(abilityId);
  if (def === undefined) {
    throw new Error(`Unknown ability id: ${abilityId}`);
  }
  if (def.kind !== 'passive') {
    throw new Error(`Ability ${abilityId} is not passive`);
  }

  const state = getOrCreateAbilityState(world, holderEid);
  if (!state.passiveAbilityIds.includes(abilityId)) {
    state.passiveAbilityIds.push(abilityId);
  }
}

export function queueAbilityTrigger(world: GameWorld, trigger: AbilityTriggerEvent): void {
  world.abilityTriggerEvents.push(trigger);
}

function triggerMatches(condition: AbilityTriggerCondition, event: AbilityTriggerEvent): boolean {
  if (condition.kind !== event.kind) return false;

  if (condition.metric !== undefined && event.metric !== condition.metric) return false;
  if (condition.skillId !== undefined && event.skillId !== condition.skillId) return false;
  if ((event.amount ?? 0) < (condition.minAmount ?? 0)) return false;

  return true;
}

function getHealthRatio(world: GameWorld, holderEid: number): number {
  const max = world.stores.health.max[holderEid] ?? 0;
  if (max <= 0) return 1;
  const current = world.stores.health.current[holderEid] ?? 0;
  return current / max;
}

function countEnemiesWithin(world: GameWorld, x: number, y: number, radiusFt: number): number {
  const enemies = query(world.ecs, [Enemy, Position, Health]);
  const radiusSq = radiusFt * radiusFt;
  let count = 0;
  for (const enemyEid of enemies) {
    if ((world.stores.health.current[enemyEid] ?? 0) <= 0) continue;
    const ex = world.stores.position.x[enemyEid] ?? 0;
    const ey = world.stores.position.y[enemyEid] ?? 0;
    const dx = ex - x;
    const dy = ey - y;
    if (dx * dx + dy * dy <= radiusSq) {
      count += 1;
    }
  }
  return count;
}

function countEnemiesNearCaster(world: GameWorld, casterEid: number, radiusFt: number): number {
  const casterX = world.stores.position.x[casterEid] ?? 0;
  const casterY = world.stores.position.y[casterEid] ?? 0;
  const enemies = [...query(world.ecs, [Enemy, Position, Health])];
  const radiusSq = radiusFt * radiusFt;
  let clusterSize = 0;

  for (const enemy of enemies) {
    if ((world.stores.health.current[enemy] ?? 0) <= 0) continue;
    const ex = world.stores.position.x[enemy] ?? 0;
    const ey = world.stores.position.y[enemy] ?? 0;
    const dx = ex - casterX;
    const dy = ey - casterY;
    if (dx * dx + dy * dy <= radiusSq) {
      clusterSize += 1;
    }
  }

  return clusterSize;
}

function shouldAutoTriggerAbility(
  world: GameWorld,
  holderEid: number,
  trigger: Exclude<AbilityTriggerCondition, { kind: 'skill_usage' }>,
): boolean {
  switch (trigger.kind) {
    case 'enemy_cluster': {
      const clusterSize = countEnemiesNearCaster(world, holderEid, trigger.withinFeet);
      return clusterSize >= trigger.minEnemies;
    }
    case 'low_health':
      return getHealthRatio(world, holderEid) < trigger.healthBelowRatio;
    case 'low_health_crowded': {
      if (getHealthRatio(world, holderEid) >= trigger.healthBelowRatio) {
        return false;
      }
      const holderX = world.stores.position.x[holderEid] ?? 0;
      const holderY = world.stores.position.y[holderEid] ?? 0;
      return countEnemiesWithin(world, holderX, holderY, trigger.withinFeet) >= trigger.minEnemies;
    }
    case 'health_deficit_at_least': {
      const max = world.stores.health.max[holderEid] ?? 0;
      const current = world.stores.health.current[holderEid] ?? 0;
      return max - current >= trigger.deficitAmount;
    }
  }
}

function getEffectiveAbilityCooldownFrames(
  world: GameWorld,
  holderEid: number,
  baseCooldownFrames: number,
): number {
  if (!hasComponent(world.ecs, holderEid, EffectiveStats)) {
    return baseCooldownFrames;
  }
  const reduction = world.stores.effectiveStats.cooldownReduction[holderEid] ?? 0;
  return applyCooldownReduction(baseCooldownFrames, reduction);
}

/**
 * Debug helper: force an active/spell ability to fire NOW, bypassing cooldown.
 * Intended for the abilities lab's clickable hotbar so any ability can be
 * exercised on demand, independent of its authored trigger (enemy_cluster /
 * low_health / skill_usage). Does NOT bypass the spells feature-unlock gate —
 * call sites unlock `world.featureUnlocks.spells` first if they want to fire
 * spells.
 *
 * Returns true if the ability fired (its effects were applied), false when
 * the ability id / state is unknown or the ability is a passive.
 */
export function forceActivateAbility(
  world: GameWorld,
  holderEid: number,
  abilityId: string,
): boolean {
  const state = world.abilityStatesByEntity.get(holderEid);
  const def = getAbilityDefinition(abilityId);
  if (state === undefined || def === undefined || def.kind === 'passive') return false;

  if (def.kind === 'spell' && !world.featureUnlocks.spells) {
    return false;
  }

  removeStatModifiers(world, 'ability', `${abilityId}:active:${holderEid}`);
  for (const effect of def.effects) {
    applyCatalogEffect(world, {
      sourceType: 'ability',
      sourceId: `${abilityId}:active:${holderEid}`,
      effect,
      holderEid,
    });
  }
  const cooldownFrames = getEffectiveAbilityCooldownFrames(world, holderEid, def.cooldownFrames);
  state.cooldownByAbilityId.set(abilityId, world.frameCount);
  state.cooldownFramesByAbilityId.set(abilityId, cooldownFrames);
  return true;
}

function activateAbility(world: GameWorld, holderEid: number, abilityId: string): void {
  const state = world.abilityStatesByEntity.get(holderEid);
  const def = getAbilityDefinition(abilityId);
  if (state === undefined || def === undefined || def.kind === 'passive') return;

  if (def.kind === 'spell' && !world.featureUnlocks.spells) {
    return;
  }

  const lastTriggerFrame = state.cooldownByAbilityId.get(abilityId) ?? Number.NEGATIVE_INFINITY;
  const cooldownFramesForGate =
    state.cooldownFramesByAbilityId.get(abilityId) ??
    getEffectiveAbilityCooldownFrames(world, holderEid, def.cooldownFrames);
  if (world.frameCount - lastTriggerFrame < cooldownFramesForGate) {
    return;
  }

  removeStatModifiers(world, 'ability', `${abilityId}:active:${holderEid}`);
  for (const effect of def.effects) {
    applyCatalogEffect(world, {
      sourceType: 'ability',
      sourceId: `${abilityId}:active:${holderEid}`,
      effect,
      holderEid,
    });
  }
  const cooldownFramesForNewWindow = getEffectiveAbilityCooldownFrames(
    world,
    holderEid,
    def.cooldownFrames,
  );
  state.cooldownByAbilityId.set(abilityId, world.frameCount);
  state.cooldownFramesByAbilityId.set(abilityId, cooldownFramesForNewWindow);
}

/**
 * Check whether the currently equipped weapon satisfies a passive ability's
 * weapon prerequisite. Returns true when:
 * - The ability has no prerequisite (always active), or
 * - The prerequisite matches the active weapon's class OR type skill id.
 */
export function weaponPrerequisiteMet(
  world: GameWorld,
  holderEid: number,
  passiveId: string,
): boolean {
  const def = getAbilityDefinition(passiveId);
  if (def === undefined || def.kind !== 'passive') return false;
  const prereq = def.weaponPrerequisite;
  if (prereq === undefined) return true;

  // Only player entities can equip weapons via the active-weapon subsystem.
  // Non-player entities (e.g., mobs) return false intentionally — weapon-prereq
  // passives granted to them via the v2 holder-scoped skill path are inert until
  // per-entity weapon state is introduced. Revisit when multi-entity equip lands.
  if (!hasComponent(world.ecs, holderEid, Player)) return false;

  const weaponDef = getActiveWeaponDef(world);
  if (weaponDef === undefined) return false;

  return weaponDef.weaponClassSkillId === prereq || weaponDef.weaponTypeSkillId === prereq;
}

function applyPassive(
  world: GameWorld,
  holderEid: number,
  passiveId: string,
  state: AbilityState,
): void {
  const def = getAbilityDefinition(passiveId);
  if (def === undefined || def.kind !== 'passive') return;

  def.effects.forEach((effect, i) => {
    applyCatalogEffect(world, {
      sourceType: 'ability',
      sourceId: `${passiveId}:passive:${holderEid}:${i}`,
      effect,
    });
  });

  state.appliedPassiveAbilityIds.add(passiveId);

  // Emit VFX when a weapon-prerequisite passive becomes active so the player
  // sees visual feedback that swapping to the right weapon unlocked a bonus.
  if (def.weaponPrerequisite !== undefined && hasComponent(world.ecs, holderEid, Player)) {
    const px = world.stores.position.x[holderEid] ?? 0;
    const py = world.stores.position.y[holderEid] ?? 0;
    pushVfxEvent(world.vfxEvents, { kind: 'weaponAbilityActivate', x: px, y: py });
  }
}

function revokePassive(
  world: GameWorld,
  holderEid: number,
  passiveId: string,
  state: AbilityState,
): void {
  const def = getAbilityDefinition(passiveId);
  if (def === undefined || def.kind !== 'passive') return;

  def.effects.forEach((_effect, i) => {
    removeStatModifiers(world, 'ability', `${passiveId}:passive:${holderEid}:${i}`);
  });

  // Update tracking only after stat cleanup succeeds so the ability is never
  // considered "not applied" while its stat modifiers are still active.
  state.appliedPassiveAbilityIds.delete(passiveId);
}

export function abilitySystem(world: GameWorld): void {
  for (const [holderEid, state] of world.abilityStatesByEntity.entries()) {
    for (const passiveId of state.passiveAbilityIds) {
      const def = getAbilityDefinition(passiveId);
      if (def === undefined || def.kind !== 'passive') continue;

      if (def.weaponPrerequisite === undefined) {
        // No prerequisite: apply once and never revoke.
        if (!state.appliedPassiveAbilityIds.has(passiveId)) {
          applyPassive(world, holderEid, passiveId, state);
        }
      } else {
        // Weapon-prerequisite passive: evaluate each frame so weapon equip/unequip
        // is reflected immediately without any per-entity generation cache.
        const prereqMet = weaponPrerequisiteMet(world, holderEid, passiveId);
        const alreadyApplied = state.appliedPassiveAbilityIds.has(passiveId);

        if (prereqMet && !alreadyApplied) {
          applyPassive(world, holderEid, passiveId, state);
        } else if (!prereqMet && alreadyApplied) {
          revokePassive(world, holderEid, passiveId, state);
        }
      }
    }
  }

  for (const event of world.abilityTriggerEvents) {
    const holderEid = event.holderEid;
    if (holderEid === undefined) continue;

    const state = world.abilityStatesByEntity.get(holderEid);
    if (state === undefined) continue;

    for (const abilityId of state.equippedActiveAbilityIds) {
      const def = getAbilityDefinition(abilityId);
      if (def === undefined || def.kind === 'passive') continue;
      if (def.trigger.kind !== 'skill_usage') continue;
      if (!triggerMatches(def.trigger, event)) continue;

      activateAbility(world, holderEid, abilityId);
    }
  }

  for (const [holderEid, state] of world.abilityStatesByEntity.entries()) {
    for (const abilityId of state.equippedActiveAbilityIds) {
      const def = getAbilityDefinition(abilityId);
      if (def === undefined || def.kind === 'passive') continue;
      if (def.trigger.kind === 'skill_usage') continue;
      if (!shouldAutoTriggerAbility(world, holderEid, def.trigger)) continue;
      activateAbility(world, holderEid, abilityId);
    }
  }

  world.abilityTriggerEvents.length = 0;
}
