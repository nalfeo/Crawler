import type { GameWorld } from '../../core/world.js';
import { findGeneratedPhysicalOwners } from '../../core/systems/equipmentSystem.js';
import { getGeneratedEquipmentInstance } from '../../core/generated-equipment-registry.js';
import type {
  GeneratedEquipmentInstanceId,
  GeneratedEquipmentInstanceV1,
} from '../../shared/generated-equipment-types.js';
import { canPurchaseSpellBrokerSpell, getSpellBrokerOffers } from '../floorScenario.js';
import type {
  ItemInteractionEntry,
  ItemInteractionKind,
  ItemInteractionSummary,
  RewardEventKind,
  RewardEventSummary,
  RunPerformanceMetrics,
} from './types.js';

interface MutableItemInteraction {
  readonly catalogKey: string;
  readonly kind: ItemInteractionKind;
  offeredCount: number;
  selectableExposureCount: number;
  selectionCount: number;
  activationCount: number;
  activeTimeMs: number;
}

export interface HeadlessRunDataState {
  readonly items: Map<string, MutableItemInteraction>;
  readonly opportunityKeys: Set<string>;
  readonly selectableOpportunityKeys: Set<string>;
  readonly selectedKeys: Set<string>;
  readonly generatedCatalogKeyByInstanceId: Map<GeneratedEquipmentInstanceId, string>;
  readonly rewardEvents: RewardEventSummary['events'][number][];
  activationCursor: number;
  uniqueActivationCount: number;
}

function ensureItem(
  state: HeadlessRunDataState,
  catalogKey: string,
  kind: ItemInteractionKind,
): MutableItemInteraction {
  const existing = state.items.get(catalogKey);
  if (existing) return existing;
  const created: MutableItemInteraction = {
    catalogKey,
    kind,
    offeredCount: 0,
    selectableExposureCount: 0,
    selectionCount: 0,
    activationCount: 0,
    activeTimeMs: 0,
  };
  state.items.set(catalogKey, created);
  return created;
}

function recordOpportunity(
  state: HeadlessRunDataState,
  opportunityKey: string,
  catalogKey: string,
  kind: ItemInteractionKind,
  selectable: boolean,
): void {
  const item = ensureItem(state, catalogKey, kind);
  if (!state.opportunityKeys.has(opportunityKey)) {
    state.opportunityKeys.add(opportunityKey);
    item.offeredCount += 1;
  }
  if (selectable && !state.selectableOpportunityKeys.has(opportunityKey)) {
    state.selectableOpportunityKeys.add(opportunityKey);
    item.selectableExposureCount += 1;
  }
}

function recordSelection(
  state: HeadlessRunDataState,
  selectionKey: string,
  catalogKey: string,
  kind: ItemInteractionKind,
): boolean {
  if (state.selectedKeys.has(selectionKey)) return false;
  state.selectedKeys.add(selectionKey);
  ensureItem(state, catalogKey, kind).selectionCount += 1;
  return true;
}

/** Cross-run generated-item identity excluding run IDs, ordinals, fingerprints, and rolled values. */
export function generatedEquipmentCatalogKey(instance: GeneratedEquipmentInstanceV1): string {
  const slots = [...instance.frozen.slots].sort().join(',');
  const effects = instance.resolvedEffects
    .map((effect) => {
      if (!('kind' in effect)) return `legacy:${effect.effectId}`;
      if (effect.kind === 'stat') return `stat:${effect.stat}:${effect.operation}`;
      return `${effect.kind}:${effect.grantId}`;
    })
    .sort()
    .join(',');
  const weapon = instance.frozen.activeWeaponSnapshot?.sourceWeaponDefId ?? 'none';
  return `generated:${instance.baseId}:${instance.rarity}:slots=${slots}:effects=${effects}:weapon=${weapon}`;
}

export function createHeadlessRunData(
  starterChoices: readonly string[],
  selectedStarter: string,
): HeadlessRunDataState {
  const state: HeadlessRunDataState = {
    items: new Map(),
    opportunityKeys: new Set(),
    selectableOpportunityKeys: new Set(),
    selectedKeys: new Set(),
    generatedCatalogKeyByInstanceId: new Map(),
    rewardEvents: [],
    activationCursor: 0,
    uniqueActivationCount: 0,
  };
  for (const weaponId of starterChoices) {
    recordOpportunity(
      state,
      `starter-choice:${weaponId}`,
      `weapon:${weaponId}`,
      'starter_weapon',
      true,
    );
  }
  recordSelection(
    state,
    `starter:${selectedStarter}`,
    `weapon:${selectedStarter}`,
    'starter_weapon',
  );
  return state;
}

export function recordRewardEvent(
  state: HeadlessRunDataState,
  kind: RewardEventKind,
  sourceId: string,
  gameTimeMs: number,
  activeTimeMs: number,
): void {
  state.rewardEvents.push({ kind, sourceId, gameTimeMs, activeTimeMs });
}

function captureSpellInteractions(
  state: HeadlessRunDataState,
  world: GameWorld,
  playerEid: number,
): void {
  const bossRewardAvailable =
    world.goalFlags.get('floor1-boss-battle-complete') === true ||
    world.goalFlags.get('floor1-boss-spellbook-claimed') === true;
  if (bossRewardAvailable) {
    for (const spellId of world.floorScenario?.offeredRewardSpellIds ?? []) {
      recordOpportunity(state, `boss-spell-choice:${spellId}`, `spell:${spellId}`, 'spell', true);
    }
  }

  if (world.featureUnlocks.spells && bossRewardAvailable) {
    for (const offer of getSpellBrokerOffers(world)) {
      recordOpportunity(
        state,
        `spell-broker:${offer.spellId}`,
        `spell:${offer.spellId}`,
        'spell',
        canPurchaseSpellBrokerSpell(world, playerEid, offer.spellId),
      );
    }
  }

  const abilityState = world.abilityStatesByEntity.get(playerEid);
  for (const spellId of abilityState?.learnedSpellIds ?? []) {
    recordSelection(state, `spell:${spellId}`, `spell:${spellId}`, 'spell');
  }
}

function captureGeneratedEquipmentInteractions(
  state: HeadlessRunDataState,
  world: GameWorld,
  activeTimeMs: number,
  frameDeltaMs: number,
): void {
  const stock = world.floorExtendedState?.settlement?.quartermasterStock;
  for (const offer of stock?.offers ?? []) {
    const instance = getGeneratedEquipmentInstance(world, offer.instanceId);
    if (!instance) continue;
    const catalogKey = generatedEquipmentCatalogKey(instance);
    state.generatedCatalogKeyByInstanceId.set(instance.instanceId, catalogKey);
    recordOpportunity(
      state,
      `quartermaster:${stock?.stockId}:${offer.offerId}`,
      catalogKey,
      'generated_equipment',
      offer.quantity > 0 && world.playerGold >= offer.unitPrice,
    );
  }

  for (const [bundleId, bundle] of world.generatedEquipmentRewardBundles) {
    for (const instanceId of bundle.instanceKeys) {
      const instance = getGeneratedEquipmentInstance(world, instanceId);
      if (!instance) continue;
      const catalogKey = generatedEquipmentCatalogKey(instance);
      state.generatedCatalogKeyByInstanceId.set(instance.instanceId, catalogKey);
      recordOpportunity(
        state,
        `reward:${bundleId}:${instanceId}`,
        catalogKey,
        'generated_equipment',
        true,
      );
    }
  }

  for (const instance of state.generatedCatalogKeyByInstanceId.keys()) {
    const owners = findGeneratedPhysicalOwners(world, instance);
    const catalogKey = state.generatedCatalogKeyByInstanceId.get(instance)!;
    if (owners.some((owner) => owner.container === 'bag' || owner.container === 'equipped')) {
      const firstSelection = recordSelection(
        state,
        `generated:${instance}`,
        catalogKey,
        'generated_equipment',
      );
      const generated = getGeneratedEquipmentInstance(world, instance);
      if (firstSelection && generated?.rarity === 'rare') {
        recordRewardEvent(state, 'rare_loot', catalogKey, world.elapsedMs, activeTimeMs);
      }
    }
    if (owners.some((owner) => owner.container === 'equipped')) {
      ensureItem(state, catalogKey, 'generated_equipment').activeTimeMs += frameDeltaMs;
    }
  }
}

function captureActivations(state: HeadlessRunDataState, world: GameWorld): void {
  const activations = world.runEvents?.itemActivations ?? [];
  for (; state.activationCursor < activations.length; state.activationCursor += 1) {
    const activation = activations[state.activationCursor]!;
    state.uniqueActivationCount += 1;
    const creditedKeys = new Set<string>();
    for (const source of activation.itemSources) {
      let catalogKey: string | undefined;
      let kind: ItemInteractionKind;
      if (source.startsWith('weapon:')) {
        catalogKey = source;
        kind = 'starter_weapon';
      } else if (source.startsWith('spell:')) {
        catalogKey = source;
        kind = 'spell';
      } else {
        const instanceId = source.slice(
          'generated-equipment-instance:'.length,
        ) as GeneratedEquipmentInstanceId;
        catalogKey = state.generatedCatalogKeyByInstanceId.get(instanceId);
        kind = 'generated_equipment';
      }
      if (!catalogKey || creditedKeys.has(catalogKey)) continue;
      creditedKeys.add(catalogKey);
      ensureItem(state, catalogKey, kind).activationCount += 1;
    }
  }
}

export function captureHeadlessRunDataFrame(
  state: HeadlessRunDataState,
  world: GameWorld,
  playerEid: number,
  activeTimeMs: number,
  frameDeltaMs: number,
): void {
  captureSpellInteractions(state, world, playerEid);
  captureGeneratedEquipmentInteractions(state, world, activeTimeMs, frameDeltaMs);
  captureActivations(state, world);
}

export function finalizeHeadlessRunData(
  state: HeadlessRunDataState,
  activeDurationMs: number,
  damageDealt: number,
  totalKills: number,
): {
  readonly rewardEvents: RewardEventSummary;
  readonly itemInteractions: ItemInteractionSummary;
  readonly runPerformance: RunPerformanceMetrics;
} {
  const items: ItemInteractionEntry[] = [...state.items.values()]
    .map((item) => ({ ...item }))
    .sort((left, right) => left.catalogKey.localeCompare(right.catalogKey));
  const dominantActivationCount = items.reduce(
    (maximum, item) => Math.max(maximum, item.activationCount),
    0,
  );
  const activeMinutes = activeDurationMs / 60_000;
  return {
    rewardEvents: {
      activeDurationMs,
      events: [...state.rewardEvents].sort(
        (left, right) =>
          left.activeTimeMs - right.activeTimeMs ||
          left.kind.localeCompare(right.kind) ||
          left.sourceId.localeCompare(right.sourceId),
      ),
    },
    itemInteractions: {
      items,
      uniqueActivationCount: state.uniqueActivationCount,
      dominantActivationCount,
    },
    runPerformance: {
      activeClearTimeMs: activeDurationMs,
      damagePerActiveMinute: activeMinutes > 0 ? damageDealt / activeMinutes : 0,
      killsPerActiveMinute: activeMinutes > 0 ? totalKills / activeMinutes : 0,
      dominantItemUsageShare:
        state.uniqueActivationCount > 0 ? dominantActivationCount / state.uniqueActivationCount : 0,
    },
  };
}
