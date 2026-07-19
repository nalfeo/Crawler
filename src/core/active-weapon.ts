/**
 * Active-weapon state — the single source of truth for which weapon definition
 * (static `WeaponDef` or immutable generated snapshot) the player is wielding.
 *
 * Layer-safe (core → shared): both `equipmentSystem` (core) and `weaponSystem`
 * (game) read/write this state, so it lives in core to avoid a
 * `core → game` cycle. Storage is a per-`GameWorld` `WeakMap` following the
 * same side-map pattern used by `equipmentSystem` and the pre-refactor
 * `weaponSystem`.
 *
 * A monotonically-increasing `generation` counter is bumped on every real
 * switch (static id or generated identity/fingerprint change, or clear).
 * `weaponSystem` watches the counter to know
 * when to reset its per-weapon fire-timer bookkeeping (aim/cooldown), so a
 * mid-run weapon swap doesn't inherit the previous weapon's cooldown state.
 * Live-tuning (labs) that updates a def in place while keeping the same id
 * does NOT bump the generation.
 */

import {
  ACTIVE_WEAPON_SNAPSHOT_SCHEMA_VERSION,
  type ActiveWeaponSnapshotV1,
} from '../shared/generated-equipment-types.js';
import type { WeaponDef } from '../shared/weaponDefs.js';
import {
  GeneratedEquipmentRegistryError,
  requireGeneratedEquipmentActiveWeaponSnapshot,
  validateActiveWeaponSnapshotV1,
} from './generated-equipment-registry.js';
import type { GameWorld } from './world.js';

interface ActiveWeaponState {
  def: WeaponDef | undefined;
  snapshot: ActiveWeaponSnapshotV1 | undefined;
  switchKey: string | undefined;
  generation: number;
}

const stateMap = new WeakMap<GameWorld, ActiveWeaponState>();

function isActiveWeaponSnapshot(def: WeaponDef): def is ActiveWeaponSnapshotV1 {
  return (
    'schemaVersion' in def &&
    (def as Partial<ActiveWeaponSnapshotV1>).schemaVersion === ACTIVE_WEAPON_SNAPSHOT_SCHEMA_VERSION
  );
}

function activeWeaponIdentity(def: WeaponDef | undefined): string | null {
  if (def === undefined) return null;
  if (!isActiveWeaponSnapshot(def)) {
    return `static:${def.id}`;
  }
  return `snapshot:${def.generatedEquipmentInstanceId}:${def.fingerprint}`;
}

function resolveAuthoritativeSnapshot(
  world: GameWorld,
  snapshot: ActiveWeaponSnapshotV1,
): ActiveWeaponSnapshotV1 {
  const validated = validateActiveWeaponSnapshotV1(snapshot, {
    expectedInstanceId: snapshot.generatedEquipmentInstanceId,
    expectedSourceWeaponDefId: snapshot.sourceWeaponDefId,
  });
  const authoritative = requireGeneratedEquipmentActiveWeaponSnapshot(
    world,
    validated.generatedEquipmentInstanceId,
  );
  if (authoritative.fingerprint !== validated.fingerprint) {
    throw new GeneratedEquipmentRegistryError(
      'fingerprint-mismatch',
      `Snapshot fingerprint ${validated.fingerprint} does not match the registry fingerprint ${authoritative.fingerprint}`,
      '$.activeWeaponSnapshot.fingerprint',
    );
  }
  return authoritative;
}

function getOrCreateState(world: GameWorld): ActiveWeaponState {
  let state = stateMap.get(world);
  if (state === undefined) {
    state = { def: undefined, snapshot: undefined, switchKey: undefined, generation: 0 };
    stateMap.set(world, state);
  }
  return state;
}

function setActiveWeaponState(
  world: GameWorld,
  def: WeaponDef,
  snapshot: ActiveWeaponSnapshotV1 | undefined,
  switchKey: string,
): boolean {
  const state = getOrCreateState(world);
  const nextDef = isActiveWeaponSnapshot(def) ? resolveAuthoritativeSnapshot(world, def) : def;
  if (activeWeaponIdentity(state.def) === activeWeaponIdentity(nextDef)) {
    state.def = nextDef;
    return;
  }
  state.def = nextDef;
  state.generation += 1;
  return true;
}

/** Set a static active weapon. Returns whether this was a real switch. */
export function setActiveWeaponDef(world: GameWorld, def: WeaponDef): boolean {
  return setActiveWeaponState(world, def, undefined, `static:${def.id}`);
}

function weaponDefFromSnapshot(snapshot: ActiveWeaponSnapshotV1): WeaponDef {
  return Object.freeze({
    id: snapshot.baseWeaponId,
    name: snapshot.name,
    weaponType: snapshot.weaponType,
    baseDamage: snapshot.baseDamage,
    cooldownMs: snapshot.cooldownMs,
    range: snapshot.range,
    projectileSpeed: snapshot.projectileSpeed,
    aoeRadius: snapshot.aoeRadius,
    durationMs: snapshot.durationMs,
    beamTickMs: snapshot.beamTickMs,
    beamLength: snapshot.beamLength,
    trapArmMs: snapshot.trapArmMs,
    trapTriggerRadius: snapshot.trapTriggerRadius,
    trapExplosionRadius: snapshot.trapExplosionRadius,
    returnSpeed: snapshot.returnSpeed,
    maxRange: snapshot.maxRange,
    swingArcDeg: snapshot.swingArcDeg,
    meleeStyle: snapshot.meleeStyle,
    headRadius: snapshot.headRadius,
    shaftDamageMult: snapshot.shaftDamageMult,
    knockback: snapshot.knockback,
    pierce: snapshot.pierce,
    bounceCount: snapshot.bounceCount,
    goreFactor: snapshot.goreFactor,
    baseAccuracy: snapshot.baseAccuracy,
    weaponClassSkillId: snapshot.weaponClassSkillId,
    weaponTypeSkillId: snapshot.weaponTypeSkillId,
  });
}

/**
 * Resolve and activate a generated weapon by authoritative registry identity.
 * Caller-authored snapshots are intentionally not accepted at this boundary.
 */
export function setActiveWeaponFromGeneratedInstance(
  world: GameWorld,
  instanceId: GeneratedEquipmentInstanceId,
): boolean {
  const instance = requireGeneratedEquipmentInstance(world, instanceId);
  if (instance.frozen.activeWeaponSnapshot === null) {
    throw new GeneratedEquipmentRegistryError(
      'invalid-payload',
      `Generated equipment instance ${instanceId} has no active weapon snapshot`,
      '$.instance.frozen.activeWeaponSnapshot',
    );
  }
  const snapshot = validateActiveWeaponSnapshotV1(
    instance.frozen.activeWeaponSnapshot,
    instance.instanceId,
  );
  return setActiveWeaponState(
    world,
    weaponDefFromSnapshot(snapshot),
    snapshot,
    `generated:${snapshot.generatedEquipmentInstanceId}:${snapshot.fingerprint}`,
  );
}

/** Clear the player's active weapon. No-op when nothing is active. */
export function clearActiveWeaponDef(world: GameWorld): void {
  const state = getOrCreateState(world);
  if (state.def === undefined) return;
  state.def = undefined;
  state.snapshot = undefined;
  state.switchKey = undefined;
  state.generation += 1;
}

/** Get the player's active `WeaponDef`, or undefined when nothing is active. */
export function getActiveWeaponDef(world: GameWorld): WeaponDef | undefined {
  return stateMap.get(world)?.def;
}

export function getActiveWeaponSnapshot(world: GameWorld): ActiveWeaponSnapshotV1 | undefined {
  const def = stateMap.get(world)?.def;
  return def !== undefined && isActiveWeaponSnapshot(def) ? def : undefined;
}

/**
 * Get the current switch generation. Consumers cache this and reset any
 * per-weapon state when the value changes.
 */
export function getActiveWeaponGeneration(world: GameWorld): number {
  return stateMap.get(world)?.generation ?? 0;
}
