import {
  ACTIVE_ABILITY_SLOT_LIMIT,
  type AbilityState,
  type AbilityTriggerCondition,
  type AbilityTriggerEvent,
} from '../abilities/types.js';
import type { GameWorld } from '../../core/world.js';
import { getAbilityDefinition } from '../abilities/registry.js';
import { applyCatalogEffect } from './progressionEffects.js';
import { removeStatModifiers } from './statsSystem.js';

export function createAbilityState(): AbilityState {
  return {
    equippedActiveAbilityIds: [],
    passiveAbilityIds: [],
    cooldownByAbilityId: new Map(),
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

export function memorizeSpell(world: GameWorld, holderEid: number, abilityId: string): void {
  const def = getAbilityDefinition(abilityId);
  if (def === undefined) {
    throw new Error(`Unknown ability id: ${abilityId}`);
  }
  if (def.kind !== 'spell') {
    throw new Error(`Ability ${abilityId} is not a spell`);
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

  if (condition.kind === 'skill_usage') {
    if (condition.metric !== undefined && event.metric !== condition.metric) return false;
    if (condition.skillId !== undefined && event.skillId !== condition.skillId) return false;
    if ((event.amount ?? 0) < (condition.minAmount ?? 0)) return false;
  }

  return true;
}

export function abilitySystem(world: GameWorld): void {
  for (const [holderEid, state] of world.abilityStatesByEntity.entries()) {
    for (const passiveId of state.passiveAbilityIds) {
      if (state.appliedPassiveAbilityIds.has(passiveId)) continue;
      const def = getAbilityDefinition(passiveId);
      if (def === undefined || def.kind !== 'passive') continue;

      // Include effect index so multi-effect passives keep distinct modifier source ids.
      def.effects.forEach((effect, i) => {
        applyCatalogEffect(world, {
          sourceType: 'ability',
          sourceId: `${passiveId}:passive:${holderEid}:${i}`,
          effect,
        });
      });

      state.appliedPassiveAbilityIds.add(passiveId);
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
      if (!triggerMatches(def.trigger, event)) continue;

      const lastTriggerFrame = state.cooldownByAbilityId.get(abilityId) ?? Number.NEGATIVE_INFINITY;
      if (world.frameCount - lastTriggerFrame < def.cooldownFrames) {
        continue;
      }

      removeStatModifiers(world, 'ability', `${abilityId}:active:${holderEid}`);
      for (const effect of def.effects) {
        applyCatalogEffect(world, {
          sourceType: 'ability',
          sourceId: `${abilityId}:active:${holderEid}`,
          effect,
        });
      }
      state.cooldownByAbilityId.set(abilityId, world.frameCount);
    }
  }

  world.abilityTriggerEvents.length = 0;
}
