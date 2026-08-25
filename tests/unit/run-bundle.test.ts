import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import { createGeneratedEquipmentInstance } from '../../src/core/generated-equipment-registry.js';
import { createRunEventCollector, recordRunItemActivation } from '../../src/core/run-events.js';
import { collectHumanRunStats } from '../../src/game/ai/run-stats-collector.js';
import { forceActivateAbility, memorizeSpell } from '../../src/game/systems/abilitySystem.js';
import {
  FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
  GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
} from '../../src/shared/generated-equipment-types.js';
import { assembleRunStats } from '../../src/shared/run-stats-collector.js';
import { createRunBundle } from '../../src/shared/run-bundle.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('run bundle contracts', () => {
  it('collects a stable human RunStats shape from a test world', () => {
    const world = createTestWorld({ seed: 7 });
    world.combatEvents.push({
      type: 'death',
      x: 0,
      y: 0,
      amount: 1,
      targetType: 'enemy',
      timestamp: 0,
      sourceEid: 0,
    });
    world.combatEvents.push({
      type: 'death',
      x: 0,
      y: 0,
      amount: 1,
      targetType: 'enemy',
      timestamp: 0,
      sourceEid: 999,
    });
    const stats = collectHumanRunStats(world, 0, 'quit', 3, {
      totalEvents: 4,
      totalSamples: 4,
      totalKills: 4,
      durationMs: 0,
      minHealthPercent: 0.1,
      closeCallCount: 2,
      lowHealthCount: 3,
      controller: 'MANUAL',
    });

    expect(stats.outcome).toBe('quit');
    expect(stats.combat.totalKills).toBe(1);
    expect(stats.health.minHealthPercent).toBe(0.1);
    expect(stats.health.closeCallCount).toBe(2);
    expect(stats.health.lowHealthCount).toBe(3);
    expect(stats.runStartXp).toBe(3);
    expect(stats.startingWeapon).toBe('unknown');
  });

  it('reports human learned-spell activations in item interactions', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    world.runEvents = createRunEventCollector();
    world.featureUnlocks.spells = true;
    memorizeSpell(world, player, 'stoneskin');

    expect(forceActivateAbility(world, player, 'stoneskin')).toBe(true);

    const stats = collectHumanRunStats(world, player, 'quit');
    expect(stats.itemInteractions?.items).toContainEqual({
      catalogKey: 'spell:stoneskin',
      kind: 'spell',
      offeredCount: 0,
      selectableExposureCount: 0,
      selectionCount: 1,
      activationCount: 1,
      activeTimeMs: 0,
    });
    expect(stats.itemInteractions?.uniqueActivationCount).toBe(1);
    expect(stats.itemInteractions?.dominantActivationCount).toBe(1);
  });

  it('does not report starter weapon selection before the loadout choice is made', () => {
    const world = createTestWorld({ seed: 42 });
    world.floorScenario = {
      starterChoices: ['sword', 'bow'],
      selectedWeaponId: null,
    } as unknown as NonNullable<typeof world.floorScenario>;

    const stats = collectHumanRunStats(world, 0, 'quit');
    expect(stats.itemInteractions?.items.some((item) => item.catalogKey === 'weapon:sword')).toBe(
      false,
    );
  });

  it('reports boss reward spell exposure only after the reward is available', () => {
    const world = createTestWorld({ seed: 42 });
    world.floorScenario = {
      starterChoices: [],
      offeredRewardSpellIds: ['stoneskin'],
      selectedWeaponId: null,
    } as unknown as NonNullable<typeof world.floorScenario>;

    expect(
      collectHumanRunStats(world, 0, 'quit').itemInteractions?.items.some(
        (item) => item.catalogKey === 'spell:stoneskin',
      ),
    ).toBe(false);

    world.goalFlags.set('floor1-boss-battle-complete', true);
    expect(collectHumanRunStats(world, 0, 'quit').itemInteractions?.items).toContainEqual({
      catalogKey: 'spell:stoneskin',
      kind: 'spell',
      offeredCount: 1,
      selectableExposureCount: 1,
      selectionCount: 0,
      activationCount: 0,
      activeTimeMs: 0,
    });
  });

  it('normalizes generated-equipment activation sources to stable catalog keys', () => {
    const createCatalogKey = (runKey: string, value: number) => {
      const world = createTestWorld({ seed: 42, generatedEquipmentRunKey: runKey });
      world.runEvents = createRunEventCollector();
      const instance = createGeneratedEquipmentInstance(world, {
        baseId: 'armor.ceremonial-coat',
        itemLevel: value,
        rarity: 'uncommon',
        enhancementLevel: 0,
        resolvedEffects: [
          {
            schemaVersion: GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
            effectId: `rolled-${value}`,
            effectOrdinal: 0,
            unitCost: 1,
            kind: 'stat',
            stat: 'armor',
            operation: 'add',
            value,
          },
        ],
        frozen: {
          schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
          displayName: 'Rolled Coat',
          artKey: 'armor.ceremonial-coat',
          slots: ['chest'],
          tags: ['armor'],
          weightLb: value,
          statBonuses: { armor: value },
          abilityGrants: [],
          passiveGrants: [],
          activeWeaponSnapshot: null,
        },
      });
      recordRunItemActivation(world, [`generated-equipment-instance:${instance.instanceId}`]);

      const item = collectHumanRunStats(world, 0, 'quit').itemInteractions?.items.find(
        (entry) => entry.kind === 'generated_equipment',
      );
      expect(item).toMatchObject({
        activationCount: 1,
        offeredCount: 0,
        selectionCount: 0,
      });
      expect(item?.catalogKey).not.toContain(runKey);
      expect(item?.catalogKey).not.toContain(instance.instanceId);
      return item?.catalogKey;
    };

    expect(createCatalogKey('run-a', 1)).toBe(createCatalogKey('run-b', 7));
  });

  it('skips unresolved generated-equipment activation sources', () => {
    const world = createTestWorld({ seed: 42, generatedEquipmentRunKey: 'run-a' });
    world.runEvents = createRunEventCollector();
    recordRunItemActivation(world, ['generated-equipment-instance:gei:v1:run-a:0']);

    const stats = collectHumanRunStats(world, 0, 'quit');
    expect(stats.itemInteractions?.uniqueActivationCount).toBe(1);
    expect(stats.itemInteractions?.items).toEqual([]);
  });

  it('preserves the assembled RunStats values without pipeline-specific behavior', () => {
    const stats = {
      outcome: 'victory' as const,
      totalFrames: 12,
      nested: { kills: 3 },
    };
    expect(assembleRunStats(stats)).toEqual(stats);
    expect(assembleRunStats(stats)).not.toBe(stats);
  });

  it('copies recorder and log payloads into a bounded run artifact', () => {
    const logs = ['[info] game started'];
    const bundle = createRunBundle({
      runStats: { outcome: 'death' },
      recorderJsonl: '{"frame":1}\n',
      logs,
      meta: { endReason: 'death', floorId: 'floor1', seed: 7 },
    });
    logs.push('mutated');
    expect(bundle).toEqual({
      runStats: { outcome: 'death' },
      recorderJsonl: '{"frame":1}\n',
      logs: ['[info] game started'],
      meta: { endReason: 'death', floorId: 'floor1', seed: 7 },
    });
  });
});
