import { hasComponent, query } from 'bitecs';
import {
  ACTIVE_ABILITY_SLOT_LIMIT,
  type AbilityGrantSource,
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
import type { EquipmentInstanceId } from '../../shared/equipment-types.js';
import type { GeneratedEquipmentInstanceId } from '../../shared/generated-equipment-types.js';
import { pushVfxEvent } from '../../shared/vfx-events.js';

export function createAbilityState(): AbilityState {
  return {
    learnedSpellIds: [],
    equippedActiveAbilityIds: [],
    passiveAbilityIds: [],
    cooldownByAbilityId: new Map(),
    cooldownFramesByAbilityId: new Map(),
    appliedPassiveAbilityIds: new Set(),
    activeAbilityGrantSources: new Map(),
    passiveAbilityGrantSources: new Map(),
  };
}

export function getOrCreateAbilityState(world: GameWorld, holderEid: number): AbilityState {
  const existing = world.abilityStatesByEntity.get(holderEid);
  if (existing !== undefined) return existing;
  const created = createAbilityState();
  world.abilityStatesByEntity.set(holderEid, created);
  return created;
}

/**
 * Normalize an `AbilityState` that may have been created before C2 source
 * tracking landed. Any ability present in `equippedActiveAbilityIds` or
 * `passiveAbilityIds` without a corresponding entry in the grant-source maps
 * is back-filled with a `{ kind: 'learned' }` source so all downstream code
 * can assume the maps are always populated.
 *
 * Idempotent: calling it twice on the same state is safe.
 */
export function migrateAbilityStateToSourceTracking(state: AbilityState): void {
  for (const abilityId of state.equippedActiveAbilityIds) {
    if (!state.activeAbilityGrantSources.has(abilityId)) {
      state.activeAbilityGrantSources.set(abilityId, [{ kind: 'learned' }]);
    }
  }
  for (const abilityId of state.passiveAbilityIds) {
    if (!state.passiveAbilityGrantSources.has(abilityId)) {
      state.passiveAbilityGrantSources.set(abilityId, [{ kind: 'learned' }]);
    }
  }
}

/** @internal Record a source for an active ability without modifying the ID list. */
function _addActiveGrantSource(
  state: AbilityState,
  abilityId: string,
  source: AbilityGrantSource,
): void {
  const sources = state.activeAbilityGrantSources.get(abilityId);
  if (sources === undefined) {
    state.activeAbilityGrantSources.set(abilityId, [source]);
  } else {
    sources.push(source);
  }
}

/** @internal Record a source for a passive ability without modifying the ID list. */
function _addPassiveGrantSource(
  state: AbilityState,
  abilityId: string,
  source: AbilityGrantSource,
): void {
  const sources = state.passiveAbilityGrantSources.get(abilityId);
  if (sources === undefined) {
    state.passiveAbilityGrantSources.set(abilityId, [source]);
  } else {
    sources.push(source);
  }
}

export function equipActiveAbility(
  world: GameWorld,
  holderEid: number,
  abilityId: string,
  source: AbilityGrantSource = { kind: 'learned' },
): void {
  const def = getAbilityDefinition(abilityId);
  if (def === undefined) {
    throw new Error(`Unknown ability id: ${abilityId}`);
  }
  if (def.kind === 'passive') {
    throw new Error(`Cannot equip passive ability ${abilityId} in an active slot`);
  }

  const state = getOrCreateAbilityState(world, holderEid);

  // Slot-cap is enforced per-ability-id: a second grant from a different source
  // does NOT add a second copy to the active list — the ability is already
  // equipped. Still record the new source so revocation is symmetric.
  if (state.equippedActiveAbilityIds.includes(abilityId)) {
    _addActiveGrantSource(state, abilityId, source);
    return;
  }

  if (state.equippedActiveAbilityIds.length >= ACTIVE_ABILITY_SLOT_LIMIT) {
    throw new Error(`Active ability slot cap reached (${ACTIVE_ABILITY_SLOT_LIMIT})`);
  }
  state.equippedActiveAbilityIds.push(abilityId);
  _addActiveGrantSource(state, abilityId, source);
}

export function unequipActiveAbility(world: GameWorld, holderEid: number, abilityId: string): void {
  const state = getOrCreateAbilityState(world, holderEid);
  const idx = state.equippedActiveAbilityIds.indexOf(abilityId);
  if (idx >= 0) {
    state.equippedActiveAbilityIds.splice(idx, 1);
    state.activeAbilityGrantSources.delete(abilityId);
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
  equipActiveAbility(world, holderEid, abilityId, { kind: 'learned' });
}

export function grantPassiveAbility(
  world: GameWorld,
  holderEid: number,
  abilityId: string,
  source: AbilityGrantSource = { kind: 'learned' },
): void {
  const def = getAbilityDefinition(abilityId);
  if (def === undefined) {
    throw new Error(`Unknown ability id: ${abilityId}`);
  }
  if (def.kind !== 'passive') {
    throw new Error(`Ability ${abilityId} is not passive`);
  }

  const state = getOrCreateAbilityState(world, holderEid);

  // Duplicate grants (same ability, same or different source) do NOT add a
  // second copy to the passive list, but DO record the additional source so
  // revocation removes only that specific source.
  if (!state.passiveAbilityIds.includes(abilityId)) {
    state.passiveAbilityIds.push(abilityId);
  }
  _addPassiveGrantSource(state, abilityId, source);
}

/**
 * Grant an active/spell ability from an equipment instance. Records an
 * `equipment` source so the grant can be cleanly revoked when the item is
 * unequipped, without affecting independently-learned or skill-granted copies.
 *
 * Throws if `abilityId` is unknown or is a passive ability.
 * Throws if the active-slot cap would be exceeded and the ability isn't already
 * equipped (same cap semantics as `equipActiveAbility`).
 */
export function grantEquipmentActiveAbility(
  world: GameWorld,
  holderEid: number,
  abilityId: string,
  instanceId: EquipmentInstanceId | GeneratedEquipmentInstanceId,
): void {
  equipActiveAbility(world, holderEid, abilityId, { kind: 'equipment', instanceId });
}

/**
 * Grant a passive ability from an equipment instance. Records an `equipment`
 * source so the grant is revoked only when that specific instance is unequipped.
 *
 * Throws if `abilityId` is unknown or is not a passive ability.
 */
export function grantEquipmentPassiveAbility(
  world: GameWorld,
  holderEid: number,
  abilityId: string,
  instanceId: EquipmentInstanceId | GeneratedEquipmentInstanceId,
): void {
  grantPassiveAbility(world, holderEid, abilityId, { kind: 'equipment', instanceId });
}

/**
 * Grant an active/spell ability from a Floor 2 generated-equipment instance.
 *
 * Unlike `grantEquipmentActiveAbility`, this call is:
 * - **Idempotent**: repeated calls with the same `(instanceId, effectOrdinal)`
 *   pair are no-ops; the `effectOrdinal` distinguishes separate effects from the
 *   same instance so two effects on the same item never collapse to one source.
 * - **Slot-cap safe**: if the active-ability slots are full and the ability is
 *   not already equipped, the ability is recorded as *known-inactive* (the
 *   source is tracked in `activeAbilityGrantSources` but the ability is NOT
 *   added to `equippedActiveAbilityIds`). This satisfies the generated-equipment
 *   contract which requires newly granted abilities to remain known even when no
 *   slot is available.
 *
 * Throws if `abilityId` is unknown or is a passive ability.
 */
export function grantGeneratedEquipmentActiveAbility(
  world: GameWorld,
  holderEid: number,
  abilityId: string,
  instanceId: GeneratedEquipmentInstanceId,
  effectOrdinal: number,
): void {
  const def = getAbilityDefinition(abilityId);
  if (def === undefined) {
    throw new Error(`Unknown ability id: ${abilityId}`);
  }
  if (def.kind === 'passive') {
    throw new Error(`Cannot equip passive ability ${abilityId} in an active slot`);
  }
  const state = getOrCreateAbilityState(world, holderEid);
  const source: AbilityGrantSource = { kind: 'generated-equipment', instanceId, effectOrdinal };
  // Idempotent: skip if this exact (instanceId, effectOrdinal) pair is already recorded.
  const existing = state.activeAbilityGrantSources.get(abilityId);
  if (
    existing?.some(
      (s) =>
        s.kind === 'generated-equipment' &&
        s.instanceId === instanceId &&
        s.effectOrdinal === effectOrdinal,
    )
  ) {
    return;
  }
  if (state.equippedActiveAbilityIds.includes(abilityId)) {
    // Already equipped (from another source) — just track the new source.
    _addActiveGrantSource(state, abilityId, source);
    return;
  }
  if (state.equippedActiveAbilityIds.length >= ACTIVE_ABILITY_SLOT_LIMIT) {
    // Slot cap reached — record as known-inactive: source tracked, not equipped.
    // The ability is available to the character but cannot be used until a slot
    // opens up (e.g. another ability is unequipped).
    _addActiveGrantSource(state, abilityId, source);
    return;
  }
  state.equippedActiveAbilityIds.push(abilityId);
  _addActiveGrantSource(state, abilityId, source);
}

/**
 * Grant a passive ability from a Floor 2 generated-equipment instance.
 *
 * Idempotent: repeated calls with the same `(instanceId, effectOrdinal)` pair
 * are no-ops.
 *
 * Throws if `abilityId` is unknown or is not a passive ability.
 */
export function grantGeneratedEquipmentPassiveAbility(
  world: GameWorld,
  holderEid: number,
  abilityId: string,
  instanceId: GeneratedEquipmentInstanceId,
  effectOrdinal: number,
): void {
  const def = getAbilityDefinition(abilityId);
  if (def === undefined) {
    throw new Error(`Unknown ability id: ${abilityId}`);
  }
  if (def.kind !== 'passive') {
    throw new Error(`Ability ${abilityId} is not passive`);
  }
  const state = getOrCreateAbilityState(world, holderEid);
  const source: AbilityGrantSource = { kind: 'generated-equipment', instanceId, effectOrdinal };
  // Idempotent: skip if this exact (instanceId, effectOrdinal) pair is already recorded.
  const existing = state.passiveAbilityGrantSources.get(abilityId);
  if (
    existing?.some(
      (s) =>
        s.kind === 'generated-equipment' &&
        s.instanceId === instanceId &&
        s.effectOrdinal === effectOrdinal,
    )
  ) {
    return;
  }
  if (!state.passiveAbilityIds.includes(abilityId)) {
    state.passiveAbilityIds.push(abilityId);
  }
  _addPassiveGrantSource(state, abilityId, source);
}

/**
 * Revoke all ability grants (active and passive) from a specific equipment
 * instance. For each ability:
 * - Removes matching `equipment` and `generated-equipment` source entries from
 *   the grant-source lists.
 * - If NO other sources remain, also removes the ability from the equipped/
 *   passive ID lists and clears any applied stat modifiers.
 * - Handles *known-inactive* active abilities (those tracked in
 *   `activeAbilityGrantSources` but not yet in `equippedActiveAbilityIds`
 *   because the active-slot cap was reached at grant time).
 * - Leaves abilities granted by `learned` or `skill` sources untouched.
 *
 * Idempotent: calling with an `instanceId` that has no matching grants is a
 * no-op. Deterministic: operates only on in-memory state, no side-effects
 * beyond stat-modifier cleanup.
 */
export function revokeEquipmentAbilityGrants(
  world: GameWorld,
  holderEid: number,
  instanceId: EquipmentInstanceId | GeneratedEquipmentInstanceId,
): void {
  const state = world.abilityStatesByEntity.get(holderEid);
  if (state === undefined) return;

  const isMatchingSource = (s: AbilityGrantSource): boolean =>
    (s.kind === 'equipment' || s.kind === 'generated-equipment') && s.instanceId === instanceId;

  // --- Active abilities (equipped + known-inactive) ---
  // Iterate all source-tracked IDs so known-inactive abilities (tracked in
  // activeAbilityGrantSources but absent from equippedActiveAbilityIds) are
  // also cleaned up.
  for (const abilityId of [...state.activeAbilityGrantSources.keys()]) {
    const sources = state.activeAbilityGrantSources.get(abilityId);
    if (sources === undefined) continue;
    const remaining = sources.filter((s) => !isMatchingSource(s));
    if (remaining.length === sources.length) continue; // nothing matched
    if (remaining.length > 0) {
      // Other sources still hold the ability — prune matched sources only.
      state.activeAbilityGrantSources.set(abilityId, remaining);
    } else {
      // Last source removed — clean up entirely.
      state.activeAbilityGrantSources.delete(abilityId);
      const idx = state.equippedActiveAbilityIds.indexOf(abilityId);
      if (idx >= 0) state.equippedActiveAbilityIds.splice(idx, 1);
    }
  }

  // --- Passive abilities ---
  for (const abilityId of [...state.passiveAbilityIds]) {
    const sources = state.passiveAbilityGrantSources.get(abilityId);
    if (sources === undefined) continue;
    const remaining = sources.filter((s) => !isMatchingSource(s));
    if (remaining.length === sources.length) continue; // nothing matched
    if (remaining.length > 0) {
      state.passiveAbilityGrantSources.set(abilityId, remaining);
    } else {
      // Remove from passive list and revoke any applied stat modifiers.
      const idx = state.passiveAbilityIds.indexOf(abilityId);
      if (idx >= 0) state.passiveAbilityIds.splice(idx, 1);
      state.passiveAbilityGrantSources.delete(abilityId);
      // Clean up applied modifier if it was active.
      if (state.appliedPassiveAbilityIds.has(abilityId)) {
        const def = getAbilityDefinition(abilityId);
        if (def !== undefined && def.kind === 'passive') {
          def.effects.forEach((_effect, i) => {
            removeStatModifiers(world, 'ability', `${abilityId}:passive:${holderEid}:${i}`);
          });
          state.appliedPassiveAbilityIds.delete(abilityId);
        }
      }
    }
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
