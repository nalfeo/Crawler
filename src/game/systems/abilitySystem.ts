import { hasComponent, query } from 'bitecs';
import {
  ABILITY_GRANT_OWNERSHIP_SCHEMA_VERSION,
  ACTIVE_ABILITY_SLOT_LIMIT,
  isAbilityGrantSourceId,
  learnedAbilityGrantSourceId,
  legacyAbilityGrantSourceId,
  type AbilityStateLike,
  type AbilityGrantKind,
  type AbilityGrantOwnership,
  type AbilityGrantSourceId,
  type AbilityTriggerCondition,
  type AbilityTriggerEvent,
  type SourceOwnedAbilityState as AbilityState,
} from '../../shared/abilities.js';
import { EffectiveStats, Enemy, Health, Player, Position } from '../../core/components.js';
import type { GameWorld } from '../../core/world.js';
import { applyCooldownReduction } from '../../shared/stats.js';
import { weaponSkillPrerequisiteMatches } from '../../shared/weapon-skills.js';
import { getAbilityDefinition } from '../abilities/registry.js';
import { applyCatalogEffect } from './progressionEffects.js';
import { removeStatModifiers } from './statsSystem.js';
import { getActiveWeaponDef } from '../../core/active-weapon.js';
import { pushVfxEvent } from '../../shared/vfx-events.js';
import { pushAbilityActivationEvent } from '../../shared/ability-activation-events.js';
import { getAbilityPresentation } from '../../shared/ability-presentation.js';
import { getSpellSkillId } from '../../shared/spell-skills.js';
import {
  recordFunTelemetryActivation,
  type FunTelemetryItemSource,
} from '../../core/fun-telemetry.js';

export type AbilityGrantErrorCode =
  | 'invalid-source'
  | 'kind-mismatch'
  | 'source-conflict'
  | 'source-mismatch'
  | 'unsupported-version'
  | 'unknown-ability';

export class AbilityGrantError extends Error {
  constructor(
    readonly code: AbilityGrantErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AbilityGrantError';
  }
}

export interface AbilityGrantRequest {
  readonly kind: AbilityGrantKind;
  readonly abilityId: string;
  readonly sourceId: AbilityGrantSourceId;
}

export interface GrantAbilitySourcesOptions {
  readonly configureActives?: 'none' | 'fill-open-slots' | 'require-slots';
}

function emptyGrantOwnership(): AbilityGrantOwnership {
  return {
    schemaVersion: ABILITY_GRANT_OWNERSHIP_SCHEMA_VERSION,
    activeSourcesByAbilityId: new Map(),
    passiveSourcesByAbilityId: new Map(),
  };
}

export function createAbilityState(): AbilityState {
  return {
    learnedSpellIds: [],
    equippedActiveAbilityIds: [],
    ownedActiveAbilityIds: [],
    passiveAbilityIds: [],
    cooldownByAbilityId: new Map(),
    cooldownFramesByAbilityId: new Map(),
    appliedPassiveAbilityIds: new Set(),
    activeAbilityGrantSources: new Map(),
    passiveAbilityGrantSources: new Map(),
    grantOwnership: emptyGrantOwnership(),
  };
}

function cloneSourceMap(
  source: ReadonlyMap<string, ReadonlySet<AbilityGrantSourceId>>,
): Map<string, Set<AbilityGrantSourceId>> {
  const result = new Map<string, Set<AbilityGrantSourceId>>();
  for (const [abilityId, sources] of source) {
    // Drop entries with empty source sets — they cannot logically own the ability and
    // would cause syncDerivedAbilityLists to treat ghost entries as owned.
    if (sources.size > 0) result.set(abilityId, new Set(sources));
  }
  return result;
}

function validateAbilityKind(abilityId: string, kind: AbilityGrantKind): void {
  const def = getAbilityDefinition(abilityId);
  if (def === undefined) {
    throw new AbilityGrantError('unknown-ability', `Unknown ability id: ${abilityId}`);
  }
  const actualKind: AbilityGrantKind = def.kind === 'passive' ? 'passive' : 'active';
  if (actualKind !== kind) {
    throw new AbilityGrantError(
      'kind-mismatch',
      `Ability ${abilityId} is ${actualKind}, not ${kind}`,
    );
  }
}

function validatePersistedAbilityKind(abilityId: string, kind: AbilityGrantKind): void {
  const def = getAbilityDefinition(abilityId);
  if (def === undefined) return;
  const actualKind: AbilityGrantKind = def.kind === 'passive' ? 'passive' : 'active';
  if (actualKind !== kind) {
    throw new AbilityGrantError(
      'kind-mismatch',
      `Ability ${abilityId} is ${actualKind}, not ${kind}`,
    );
  }
}

function validateSourceForKind(
  sourceId: string,
  kind: AbilityGrantKind,
  abilityId: string,
): AbilityGrantSourceId {
  if (!isAbilityGrantSourceId(sourceId)) {
    throw new AbilityGrantError('invalid-source', `Invalid ability grant source: ${sourceId}`);
  }
  if (sourceId.startsWith('learned:')) {
    const embeddedAbilityId = sourceId.slice('learned:'.length);
    if (embeddedAbilityId !== abilityId) {
      throw new AbilityGrantError(
        'source-mismatch',
        `Learned source ${sourceId} does not match ability ${abilityId}`,
      );
    }
  }
  if (sourceId.startsWith('legacy:')) {
    const kindPrefix = `legacy:${kind}:`;
    if (!sourceId.startsWith(kindPrefix)) {
      throw new AbilityGrantError(
        'kind-mismatch',
        `Legacy source ${sourceId} does not match ${kind} grant`,
      );
    }
    const embeddedAbilityId = sourceId.slice(kindPrefix.length);
    if (embeddedAbilityId !== abilityId) {
      throw new AbilityGrantError(
        'source-mismatch',
        `Legacy source ${sourceId} does not match ability ${abilityId}`,
      );
    }
  }
  return sourceId;
}

function sourceOwnerMap(ownership: AbilityGrantOwnership): Map<AbilityGrantSourceId, string> {
  const owners = new Map<AbilityGrantSourceId, string>();
  for (const [abilityId, sources] of ownership.activeSourcesByAbilityId) {
    for (const sourceId of sources) {
      const owner = `active:${abilityId}`;
      const existing = owners.get(sourceId);
      if (existing !== undefined && existing !== owner) {
        throw new AbilityGrantError(
          'source-conflict',
          `Ability grant source ${sourceId} is owned by both ${existing} and ${owner}`,
        );
      }
      owners.set(sourceId, owner);
    }
  }
  for (const [abilityId, sources] of ownership.passiveSourcesByAbilityId) {
    for (const sourceId of sources) {
      const owner = `passive:${abilityId}`;
      const existing = owners.get(sourceId);
      if (existing !== undefined && existing !== owner) {
        throw new AbilityGrantError(
          'source-conflict',
          `Ability grant source ${sourceId} is owned by both ${existing} and ${owner}`,
        );
      }
      owners.set(sourceId, owner);
    }
  }
  return owners;
}

function syncDerivedAbilityLists(state: AbilityState): void {
  const activeIds = new Set(
    [...state.grantOwnership.activeSourcesByAbilityId.keys()].filter(
      (abilityId) => getAbilityDefinition(abilityId) !== undefined,
    ),
  );
  state.equippedActiveAbilityIds = state.equippedActiveAbilityIds.filter((id) => activeIds.has(id));

  // All catalog-backed owned actives, preserving existing order and appending new ones.
  const ownedSet = activeIds;
  state.ownedActiveAbilityIds = [
    ...(state.ownedActiveAbilityIds ?? []).filter((id) => ownedSet.has(id)),
    ...[...ownedSet].filter((id) => !(state.ownedActiveAbilityIds ?? []).includes(id)),
  ];

  const learnedIds = [...state.grantOwnership.activeSourcesByAbilityId]
    .filter(([abilityId, sources]) => {
      const def = getAbilityDefinition(abilityId);
      return (
        activeIds.has(abilityId) &&
        sources.has(learnedAbilityGrantSourceId(abilityId)) &&
        def?.kind === 'spell'
      );
    })
    .map(([abilityId]) => abilityId);
  const learnedSet = new Set(learnedIds);
  state.learnedSpellIds = [
    ...state.learnedSpellIds.filter((id) => learnedSet.has(id)),
    ...learnedIds.filter((id) => !state.learnedSpellIds.includes(id)),
  ];

  const passiveIds = [...state.grantOwnership.passiveSourcesByAbilityId.keys()].filter(
    (abilityId) => getAbilityDefinition(abilityId) !== undefined,
  );
  const passiveSet = new Set(passiveIds);
  state.passiveAbilityIds = [
    ...state.passiveAbilityIds.filter((id) => passiveSet.has(id)),
    ...passiveIds.filter((id) => !state.passiveAbilityIds.includes(id)),
  ];
}

export function normalizeAbilityState(state: AbilityStateLike): AbilityState {
  const normalized: AbilityState = {
    learnedSpellIds: [...state.learnedSpellIds],
    equippedActiveAbilityIds: [...state.equippedActiveAbilityIds],
    ownedActiveAbilityIds: [],
    passiveAbilityIds: [...state.passiveAbilityIds],
    cooldownByAbilityId: new Map(state.cooldownByAbilityId),
    cooldownFramesByAbilityId: new Map(state.cooldownFramesByAbilityId),
    appliedPassiveAbilityIds: new Set(state.appliedPassiveAbilityIds),
    activeAbilityGrantSources: new Map(
      [...(state.activeAbilityGrantSources ?? new Map())].map(([abilityId, sources]) => [
        abilityId,
        [...sources],
      ]),
    ),
    passiveAbilityGrantSources: new Map(
      [...(state.passiveAbilityGrantSources ?? new Map())].map(([abilityId, sources]) => [
        abilityId,
        [...sources],
      ]),
    ),
    grantOwnership: emptyGrantOwnership(),
  };

  if (state.grantOwnership === undefined) {
    for (const abilityId of state.learnedSpellIds) {
      validatePersistedAbilityKind(abilityId, 'active');
      normalized.grantOwnership.activeSourcesByAbilityId.set(
        abilityId,
        new Set([learnedAbilityGrantSourceId(abilityId)]),
      );
    }
    for (const abilityId of state.equippedActiveAbilityIds) {
      validatePersistedAbilityKind(abilityId, 'active');
      const sources =
        normalized.grantOwnership.activeSourcesByAbilityId.get(abilityId) ?? new Set();
      if (sources.size === 0) sources.add(legacyAbilityGrantSourceId('active', abilityId));
      normalized.grantOwnership.activeSourcesByAbilityId.set(abilityId, sources);
    }
    for (const abilityId of state.passiveAbilityIds) {
      validatePersistedAbilityKind(abilityId, 'passive');
      normalized.grantOwnership.passiveSourcesByAbilityId.set(
        abilityId,
        new Set([legacyAbilityGrantSourceId('passive', abilityId)]),
      );
    }
  } else {
    if (state.grantOwnership.schemaVersion !== ABILITY_GRANT_OWNERSHIP_SCHEMA_VERSION) {
      throw new AbilityGrantError(
        'unsupported-version',
        `Unsupported ability grant ownership version: ${String(state.grantOwnership.schemaVersion)}`,
      );
    }
    normalized.grantOwnership = {
      schemaVersion: ABILITY_GRANT_OWNERSHIP_SCHEMA_VERSION,
      activeSourcesByAbilityId: cloneSourceMap(state.grantOwnership.activeSourcesByAbilityId),
      passiveSourcesByAbilityId: cloneSourceMap(state.grantOwnership.passiveSourcesByAbilityId),
    };
    for (const [abilityId, sources] of normalized.grantOwnership.activeSourcesByAbilityId) {
      validatePersistedAbilityKind(abilityId, 'active');
      for (const sourceId of sources) validateSourceForKind(sourceId, 'active', abilityId);
    }
    for (const [abilityId, sources] of normalized.grantOwnership.passiveSourcesByAbilityId) {
      validatePersistedAbilityKind(abilityId, 'passive');
      for (const sourceId of sources) validateSourceForKind(sourceId, 'passive', abilityId);
    }
  }

  sourceOwnerMap(normalized.grantOwnership);
  syncDerivedAbilityLists(normalized);
  // Canonicalize configured actives: deduplicate and enforce the authoritative slot
  // limit so legacy/migrated snapshots with over-cap or repeated IDs never bypass the
  // ten-slot contract enforced by the grant/configure paths.
  normalized.equippedActiveAbilityIds = [...new Set(normalized.equippedActiveAbilityIds)].slice(
    0,
    ACTIVE_ABILITY_SLOT_LIMIT,
  );
  return normalized;
}

function cloneNormalizedAbilityState(state: AbilityStateLike): AbilityState {
  return normalizeAbilityState(state);
}

function installAbilityState(
  world: GameWorld,
  holderEid: number,
  state: AbilityState,
  existing?: AbilityStateLike,
): AbilityState {
  if (existing === undefined || existing === state) {
    world.abilityStatesByEntity.set(holderEid, state);
    return state;
  }
  existing.learnedSpellIds = state.learnedSpellIds;
  existing.equippedActiveAbilityIds = state.equippedActiveAbilityIds;
  existing.ownedActiveAbilityIds = state.ownedActiveAbilityIds;
  existing.passiveAbilityIds = state.passiveAbilityIds;
  existing.cooldownByAbilityId = state.cooldownByAbilityId;
  existing.cooldownFramesByAbilityId = state.cooldownFramesByAbilityId;
  existing.appliedPassiveAbilityIds = state.appliedPassiveAbilityIds;
  existing.activeAbilityGrantSources = state.activeAbilityGrantSources;
  existing.passiveAbilityGrantSources = state.passiveAbilityGrantSources;
  existing.grantOwnership = state.grantOwnership;
  world.abilityStatesByEntity.set(holderEid, existing);
  return existing as AbilityState;
}

export function getOrCreateAbilityState(world: GameWorld, holderEid: number): AbilityState {
  const existing = world.abilityStatesByEntity.get(holderEid);
  if (existing !== undefined) {
    if (existing.grantOwnership !== undefined) return existing as AbilityState;
    const normalized = normalizeAbilityState(existing);
    return installAbilityState(world, holderEid, normalized, existing);
  }
  const created = createAbilityState();
  world.abilityStatesByEntity.set(holderEid, created);
  return created;
}

function validateGrantRequests(
  ownership: AbilityGrantOwnership,
  requests: readonly AbilityGrantRequest[],
): void {
  const owners = sourceOwnerMap(ownership);
  for (const request of requests) {
    validateAbilityKind(request.abilityId, request.kind);
    const sourceId = validateSourceForKind(request.sourceId, request.kind, request.abilityId);
    const requestedOwner = `${request.kind}:${request.abilityId}`;
    const existingOwner = owners.get(sourceId);
    if (existingOwner !== undefined && existingOwner !== requestedOwner) {
      throw new AbilityGrantError(
        'source-conflict',
        `Ability grant source ${sourceId} already owns ${existingOwner}`,
      );
    }
    owners.set(sourceId, requestedOwner);
  }
}

// Revoke validation relaxes the catalog check: a retired ability that is no longer
// in the catalog may still have persisted ownership that needs to be removed.
// Unlike validateAbilityKind (used for grants), validatePersistedAbilityKind skips
// the unknown-ability check — if the ability is not in the catalog it returns
// silently, so retired IDs pass through instead of throwing 'unknown-ability'.
function validateRevokeRequests(
  ownership: AbilityGrantOwnership,
  requests: readonly AbilityGrantRequest[],
): void {
  const owners = sourceOwnerMap(ownership);
  for (const request of requests) {
    // Allow catalog-missing (retired) ability IDs — normalizeAbilityState preserves
    // them as inert ownership and equipment revokers scan those entries.
    validatePersistedAbilityKind(request.abilityId, request.kind);
    const sourceId = validateSourceForKind(request.sourceId, request.kind, request.abilityId);
    const requestedOwner = `${request.kind}:${request.abilityId}`;
    const existingOwner = owners.get(sourceId);
    if (existingOwner !== undefined && existingOwner !== requestedOwner) {
      throw new AbilityGrantError(
        'source-conflict',
        `Ability grant source ${sourceId} already owns ${existingOwner}`,
      );
    }
  }
}

export function grantAbilitySources(
  world: GameWorld,
  holderEid: number,
  requests: readonly AbilityGrantRequest[],
  options: GrantAbilitySourcesOptions = {},
): void {
  const existing = world.abilityStatesByEntity.get(holderEid);
  const draft =
    existing === undefined ? createAbilityState() : cloneNormalizedAbilityState(existing);
  validateGrantRequests(draft.grantOwnership, requests);

  const configureActives = options.configureActives ?? 'none';
  for (const request of requests) {
    const sourcesByAbilityId =
      request.kind === 'active'
        ? draft.grantOwnership.activeSourcesByAbilityId
        : draft.grantOwnership.passiveSourcesByAbilityId;
    const sources = sourcesByAbilityId.get(request.abilityId) ?? new Set();
    sources.add(request.sourceId);
    sourcesByAbilityId.set(request.abilityId, sources);

    if (
      request.kind === 'active' &&
      !draft.equippedActiveAbilityIds.includes(request.abilityId) &&
      configureActives !== 'none'
    ) {
      if (draft.equippedActiveAbilityIds.length >= ACTIVE_ABILITY_SLOT_LIMIT) {
        if (configureActives === 'require-slots') {
          throw new Error(`Active ability slot cap reached (${ACTIVE_ABILITY_SLOT_LIMIT})`);
        }
      } else {
        draft.equippedActiveAbilityIds.push(request.abilityId);
      }
    }
  }

  syncDerivedAbilityLists(draft);
  installAbilityState(world, holderEid, draft, existing);
}

function passiveModifierSourcePrefix(passiveId: string, holderEid: number): string {
  return `${passiveId}:passive:${holderEid}:`;
}

export function revokeAbilitySources(
  world: GameWorld,
  holderEid: number,
  requests: readonly AbilityGrantRequest[],
): void {
  const existing = world.abilityStatesByEntity.get(holderEid);
  if (existing === undefined) {
    validateRevokeRequests(emptyGrantOwnership(), requests);
    return;
  }
  const draft = cloneNormalizedAbilityState(existing);
  validateRevokeRequests(draft.grantOwnership, requests);
  const removedPassives = new Set<string>();

  for (const request of requests) {
    const sourcesByAbilityId =
      request.kind === 'active'
        ? draft.grantOwnership.activeSourcesByAbilityId
        : draft.grantOwnership.passiveSourcesByAbilityId;
    const sources = sourcesByAbilityId.get(request.abilityId);
    if (sources === undefined || !sources.delete(request.sourceId)) continue;
    if (sources.size > 0) continue;
    sourcesByAbilityId.delete(request.abilityId);

    if (request.kind === 'active') {
      draft.equippedActiveAbilityIds = draft.equippedActiveAbilityIds.filter(
        (id) => id !== request.abilityId,
      );
      draft.cooldownByAbilityId.delete(request.abilityId);
      draft.cooldownFramesByAbilityId.delete(request.abilityId);
    } else {
      removedPassives.add(request.abilityId);
      draft.appliedPassiveAbilityIds.delete(request.abilityId);
    }
  }

  syncDerivedAbilityLists(draft);
  const nextModifiers =
    removedPassives.size === 0
      ? world.statModifiers
      : world.statModifiers.filter(
          (modifier) =>
            modifier.sourceType !== 'ability' ||
            ![...removedPassives].some((passiveId) =>
              modifier.sourceId.startsWith(passiveModifierSourcePrefix(passiveId, holderEid)),
            ),
        );
  installAbilityState(world, holderEid, draft, existing);
  world.statModifiers = nextModifiers;
}

export function configureOwnedActiveAbility(
  world: GameWorld,
  holderEid: number,
  abilityId: string,
): void {
  validateAbilityKind(abilityId, 'active');
  const state = getOrCreateAbilityState(world, holderEid);
  if (!state.grantOwnership.activeSourcesByAbilityId.has(abilityId)) {
    throw new AbilityGrantError(
      'invalid-source',
      `Active ability ${abilityId} has no grant source`,
    );
  }
  if (state.equippedActiveAbilityIds.includes(abilityId)) return;
  if (state.equippedActiveAbilityIds.length >= ACTIVE_ABILITY_SLOT_LIMIT) {
    throw new Error(`Active ability slot cap reached (${ACTIVE_ABILITY_SLOT_LIMIT})`);
  }
  state.equippedActiveAbilityIds.push(abilityId);
}

/**
 * Backward-compatible configuration entry point. Equips a catalog ability with
 * learned provenance; if the ability already has an owned source, configures it
 * in-place. New callers that require a different provenance should call
 * `grantAbilitySources` directly.
 */
export function equipActiveAbility(world: GameWorld, holderEid: number, abilityId: string): void {
  validateAbilityKind(abilityId, 'active');
  const existing = world.abilityStatesByEntity.get(holderEid);
  const normalized = existing === undefined ? undefined : normalizeAbilityState(existing);
  if (
    normalized !== undefined &&
    !normalized.equippedActiveAbilityIds.includes(abilityId) &&
    normalized.equippedActiveAbilityIds.length >= ACTIVE_ABILITY_SLOT_LIMIT
  ) {
    throw new Error(`Active ability slot cap reached (${ACTIVE_ABILITY_SLOT_LIMIT})`);
  }
  if (normalized?.grantOwnership.activeSourcesByAbilityId.has(abilityId)) {
    installAbilityState(world, holderEid, normalized, existing);
    configureOwnedActiveAbility(world, holderEid, abilityId);
    return;
  }
  grantAbilitySources(
    world,
    holderEid,
    [
      {
        kind: 'active',
        abilityId,
        sourceId: learnedAbilityGrantSourceId(abilityId),
      },
    ],
    { configureActives: 'require-slots' },
  );
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
  grantAbilitySources(
    world,
    holderEid,
    [{ kind: 'active', abilityId, sourceId: learnedAbilityGrantSourceId(abilityId) }],
    { configureActives: 'require-slots' },
  );
}

export function grantPassiveAbility(world: GameWorld, holderEid: number, abilityId: string): void {
  grantAbilitySources(world, holderEid, [
    {
      kind: 'passive',
      abilityId,
      sourceId: learnedAbilityGrantSourceId(abilityId),
    },
  ]);
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

  emitAbilityActivationAnnouncement(world, holderEid, abilityId);
  emitSpellUsageEvent(world, holderEid, def.kind === 'spell' ? abilityId : undefined);
  recordAbilityFunTelemetry(world, holderEid, abilityId);
  return true;
}

function activateAbility(world: GameWorld, holderEid: number, abilityId: string): boolean {
  const state = world.abilityStatesByEntity.get(holderEid);
  const def = getAbilityDefinition(abilityId);
  if (state === undefined || def === undefined || def.kind === 'passive') return false;

  if (def.kind === 'spell' && !world.featureUnlocks.spells) {
    return false;
  }

  const lastTriggerFrame = state.cooldownByAbilityId.get(abilityId) ?? Number.NEGATIVE_INFINITY;
  const cooldownFramesForGate =
    state.cooldownFramesByAbilityId.get(abilityId) ??
    getEffectiveAbilityCooldownFrames(world, holderEid, def.cooldownFrames);
  if (world.frameCount - lastTriggerFrame < cooldownFramesForGate) {
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
  const cooldownFramesForNewWindow = getEffectiveAbilityCooldownFrames(
    world,
    holderEid,
    def.cooldownFrames,
  );
  state.cooldownByAbilityId.set(abilityId, world.frameCount);
  state.cooldownFramesByAbilityId.set(abilityId, cooldownFramesForNewWindow);

  emitAbilityActivationAnnouncement(world, holderEid, abilityId);
  emitSpellUsageEvent(world, holderEid, def.kind === 'spell' ? abilityId : undefined);
  recordAbilityFunTelemetry(world, holderEid, abilityId);
  return true;
}

function recordAbilityFunTelemetry(world: GameWorld, holderEid: number, abilityId: string): void {
  if (!world.funTelemetry) return;
  const sources = world.abilityStatesByEntity
    .get(holderEid)
    ?.grantOwnership?.activeSourcesByAbilityId.get(abilityId);
  if (!sources) return;

  const itemSources: FunTelemetryItemSource[] = [];
  for (const sourceId of sources) {
    if (sourceId === `learned:${abilityId}`) {
      itemSources.push(`spell:${abilityId}`);
      continue;
    }
    if (!sourceId.startsWith('equipment:')) continue;
    const withoutPrefix = sourceId.slice('equipment:'.length);
    const ordinalSeparator = withoutPrefix.lastIndexOf(':');
    if (ordinalSeparator <= 0) continue;
    itemSources.push(`generated-equipment-instance:${withoutPrefix.slice(0, ordinalSeparator)}`);
  }
  recordFunTelemetryActivation(world, itemSources);
}

/** Spell skills advance only after a gated activation actually succeeded. */
function emitSpellUsageEvent(world: GameWorld, holderEid: number, spellId?: string): void {
  if (spellId === undefined || !hasComponent(world.ecs, holderEid, Player)) return;
  const skillId = getSpellSkillId(spellId);
  if (skillId === undefined) return;
  world.skillUsageEvents.push({
    holderEid,
    skillId,
    metric: 'spell_used',
    amount: 1,
  });
}

/**
 * Announce a *successful* active/spell activation so the player sees which
 * ability just fired as floating text above their character (same read as a
 * damage number). Player-only by design: mob/boss activations would clutter the
 * screen and are already telegraphed by their own VFX. Cosmetic-only — the
 * queue is never read by game logic, so headless/AI runs are unaffected.
 */
function emitAbilityActivationAnnouncement(
  world: GameWorld,
  holderEid: number,
  abilityId: string,
): void {
  if (!hasComponent(world.ecs, holderEid, Player)) return;

  const def = getAbilityDefinition(abilityId);
  if (def === undefined || def.kind === 'passive') return;

  const presentation = getAbilityPresentation(abilityId);

  pushAbilityActivationEvent(world.abilityActivations, {
    abilityId,
    label: presentation?.name ?? def.name,
    kind: def.kind,
    category: presentation?.category ?? def.category,
    holderEid,
    x: world.stores.position.x[holderEid] ?? 0,
    y: world.stores.position.y[holderEid] ?? 0,
    elapsedMs: world.elapsedMs,
  });
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

  return weaponSkillPrerequisiteMatches(
    prereq,
    weaponDef.weaponClassSkillId,
    weaponDef.weaponTypeSkillId,
  );
}

function applyPassive(
  world: GameWorld,
  holderEid: number,
  passiveId: string,
  state: AbilityState,
  suppressActivationVfx = false,
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

  // Emit VFX only for weapon-gated passives becoming active (e.g. swapping to
  // a matching weapon). This intentionally re-fires on every qualifying
  // weapon swap-in — a deliberate repeatable "equip flash", not a bug.
  //
  // General (no-prerequisite) passives deliberately do NOT get VFX here:
  // applyPassive() is re-run on every synchronizeAbilityPassives() pass
  // (including session/floor reload and stat carryover), so an unconditional
  // VFX would misleadingly replay one-time unlock feedback for a passive granted
  // long ago. General passives instead get their one-time milestone VFX (and the
  // skillPassiveUnlocked announcement) from the level-5 skill milestone grant
  // site — see skillSystem.ts.
  if (
    !suppressActivationVfx &&
    def.weaponPrerequisite !== undefined &&
    hasComponent(world.ecs, holderEid, Player)
  ) {
    const px = world.stores.position.x[holderEid] ?? 0;
    const py = world.stores.position.y[holderEid] ?? 0;
    pushVfxEvent(world.vfxEvents, { kind: 'abilityActivateFlash', x: px, y: py });
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

export function synchronizeAbilityPassives(
  world: GameWorld,
  holderEid: number,
  options?: { suppressActivationVfx?: boolean },
): void {
  const state = getOrCreateAbilityState(world, holderEid);
  for (const passiveId of [...state.appliedPassiveAbilityIds]) {
    if (!state.grantOwnership.passiveSourcesByAbilityId.has(passiveId)) {
      revokePassive(world, holderEid, passiveId, state);
    }
  }

  for (const passiveId of state.passiveAbilityIds) {
    const def = getAbilityDefinition(passiveId);
    if (def === undefined || def.kind !== 'passive') continue;

    if (def.weaponPrerequisite === undefined) {
      if (!state.appliedPassiveAbilityIds.has(passiveId)) {
        applyPassive(world, holderEid, passiveId, state);
      }
    } else {
      const prereqMet = weaponPrerequisiteMet(world, holderEid, passiveId);
      const alreadyApplied = state.appliedPassiveAbilityIds.has(passiveId);

      if (prereqMet && !alreadyApplied) {
        applyPassive(world, holderEid, passiveId, state, options?.suppressActivationVfx === true);
      } else if (!prereqMet && alreadyApplied) {
        revokePassive(world, holderEid, passiveId, state);
      }
    }
  }
}

export function abilitySystem(world: GameWorld): void {
  for (const holderEid of world.abilityStatesByEntity.keys()) {
    synchronizeAbilityPassives(world, holderEid);
  }

  for (const event of world.abilityTriggerEvents) {
    const holderEid = event.holderEid;
    if (holderEid === undefined) continue;

    const stateLike = world.abilityStatesByEntity.get(holderEid);
    if (stateLike === undefined) continue;
    const state = getOrCreateAbilityState(world, holderEid);

    for (const abilityId of state.equippedActiveAbilityIds) {
      const def = getAbilityDefinition(abilityId);
      if (def === undefined || def.kind === 'passive') continue;
      if (def.trigger.kind !== 'skill_usage') continue;
      if (!triggerMatches(def.trigger, event)) continue;

      activateAbility(world, holderEid, abilityId);
    }
  }

  for (const holderEid of world.abilityStatesByEntity.keys()) {
    const state = getOrCreateAbilityState(world, holderEid);
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
