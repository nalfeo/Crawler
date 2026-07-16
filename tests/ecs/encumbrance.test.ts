import { describe, it, expect, beforeEach } from 'vitest';
import { addEntity, set, addComponent } from 'bitecs';
import { createTestWorld } from '../helpers/world-factory.js';
import type { GameWorld } from '../../src/core/world.js';
import { Weight } from '../../src/core/components.js';
import { initializeBaseStats, equip, unequip } from '../../src/core/systems/equipmentSystem.js';
import { statSystem } from '../../src/core/systems/statSystem.js';
import {
  getEntityEncumbranceSnapshot,
  getEntityEncumbranceMultiplier,
} from '../../src/core/encumbrance.js';
import { computeMoveSpeed } from '../../src/core/movement-speed.js';
import { applyStatusEffect } from '../../src/core/status-effects.js';
import {
  computeEncumbranceThresholds,
  computeEncumbranceBand,
  computeEncumbranceMultiplier,
  ENCUMBRANCE_THRESHOLD_BASE_LB,
  ENCUMBRANCE_STR_THRESHOLD_BONUS_LB_PER_POINT,
} from '../../src/shared/encumbrance.js';
import type { EquipmentItemDef } from '../../src/shared/equipment-types.js';

function makeItem(overrides: Partial<EquipmentItemDef> = {}): EquipmentItemDef {
  return {
    id: 'test-item',
    name: 'Test Item',
    slots: ['head'],
    statBonuses: {},
    weightLb: 0,
    rarity: 'common',
    ...overrides,
  };
}

describe('encumbrance pure math (shared/encumbrance.ts)', () => {
  it('computes thresholds as body weight + 40/80/120 + 5 per effective Strength point', () => {
    const thresholds = computeEncumbranceThresholds(180, 1);
    expect(thresholds.unburdenedMaxLb).toBe(180 + ENCUMBRANCE_THRESHOLD_BASE_LB.unburdened + 5);
    expect(thresholds.encumberedMaxLb).toBe(180 + ENCUMBRANCE_THRESHOLD_BASE_LB.encumbered + 5);
    expect(thresholds.heavyMaxLb).toBe(180 + ENCUMBRANCE_THRESHOLD_BASE_LB.heavy + 5);
  });

  it('widens every threshold by exactly 5 lb per additional effective Strength point', () => {
    const at1 = computeEncumbranceThresholds(180, 1);
    const at11 = computeEncumbranceThresholds(180, 11);
    const deltaLb = 10 * ENCUMBRANCE_STR_THRESHOLD_BONUS_LB_PER_POINT;
    expect(at11.unburdenedMaxLb - at1.unburdenedMaxLb).toBe(deltaLb);
    expect(at11.encumberedMaxLb - at1.encumberedMaxLb).toBe(deltaLb);
    expect(at11.heavyMaxLb - at1.heavyMaxLb).toBe(deltaLb);
  });

  it('classifies the exact boundary lb into the LOWER (inclusive) band, and one lb over into the next', () => {
    const thresholds = computeEncumbranceThresholds(180, 1); // 225 / 265 / 305
    expect(computeEncumbranceBand(thresholds.unburdenedMaxLb, thresholds)).toBe('unburdened');
    expect(computeEncumbranceBand(thresholds.unburdenedMaxLb + 0.01, thresholds)).toBe(
      'encumbered',
    );
    expect(computeEncumbranceBand(thresholds.encumberedMaxLb, thresholds)).toBe('encumbered');
    expect(computeEncumbranceBand(thresholds.encumberedMaxLb + 0.01, thresholds)).toBe('heavy');
    expect(computeEncumbranceBand(thresholds.heavyMaxLb, thresholds)).toBe('heavy');
    expect(computeEncumbranceBand(thresholds.heavyMaxLb + 0.01, thresholds)).toBe('overloaded');
  });

  it('maps each band to its documented move-speed multiplier (1 / .85 / .7 / .7)', () => {
    expect(computeEncumbranceMultiplier('unburdened')).toBe(1);
    expect(computeEncumbranceMultiplier('encumbered')).toBe(0.85);
    expect(computeEncumbranceMultiplier('heavy')).toBe(0.7);
    expect(computeEncumbranceMultiplier('overloaded')).toBe(0.7);
  });
});

describe('encumbrance ECS snapshot (core/encumbrance.ts) — dedupe + boundaries', () => {
  let world: GameWorld;
  let entity: number;

  beforeEach(() => {
    world = createTestWorld();
    world.state = 'safe_room';
    entity = addEntity(world.ecs);
    initializeBaseStats(world, entity);
    addComponent(world.ecs, entity, set(Weight, { value: 180 }));
    statSystem(world);
  });

  it('is unburdened with no equipment (body weight only, well under the 225 lb floor)', () => {
    const snapshot = getEntityEncumbranceSnapshot(world, entity);
    expect(snapshot.bodyWeightLb).toBe(180);
    expect(snapshot.equippedWeightLb).toBe(0);
    expect(snapshot.totalMassLb).toBe(180);
    expect(snapshot.band).toBe('unburdened');
    expect(snapshot.moveSpeedMultiplier).toBe(1);
  });

  it('counts a two-handed item´s weightLb ONCE, not once per occupied slot', () => {
    const twoHanded = makeItem({
      id: 'greatsword',
      slots: ['mainHand', 'offHand'],
      weightLb: 30,
    });
    equip(world, entity, twoHanded, { force: true });
    statSystem(world);
    const snapshot = getEntityEncumbranceSnapshot(world, entity);
    expect(snapshot.equippedWeightLb).toBe(30);
    expect(snapshot.totalMassLb).toBe(210);
  });

  it('sums distinct single-slot items without double-counting', () => {
    equip(world, entity, makeItem({ id: 'helm', slots: ['head'], weightLb: 10 }), {
      force: true,
    });
    equip(world, entity, makeItem({ id: 'boots', slots: ['feet'], weightLb: 5 }), {
      force: true,
    });
    statSystem(world);
    const snapshot = getEntityEncumbranceSnapshot(world, entity);
    expect(snapshot.equippedWeightLb).toBe(15);
    expect(snapshot.totalMassLb).toBe(195);
  });

  it('crosses unburdened → encumbered → heavy → overloaded as equipped weight rises (STR=1 body=180)', () => {
    // Thresholds at STR 1, body 180: unburdened<=225, encumbered<=265, heavy<=305.
    const bandForWeight = (weightLb: number): string => {
      const result = equip(world, entity, makeItem({ id: 'w', slots: ['head'], weightLb }), {
        force: true,
      });
      expect(result.ok).toBe(true);
      statSystem(world);
      const band = getEntityEncumbranceSnapshot(world, entity).band;
      unequip(world, entity, 'head', { force: true });
      return band;
    };
    expect(bandForWeight(45)).toBe('unburdened'); // 180+45=225 exactly
    expect(bandForWeight(46)).toBe('encumbered'); // 226
    expect(bandForWeight(85)).toBe('encumbered'); // 265 exactly
    expect(bandForWeight(86)).toBe('heavy'); // 266
    expect(bandForWeight(125)).toBe('heavy'); // 305 exactly
    expect(bandForWeight(126)).toBe('overloaded'); // 306
  });

  it('getEntityEncumbranceMultiplier matches the snapshot multiplier', () => {
    equip(world, entity, makeItem({ id: 'anvil-hat', slots: ['head'], weightLb: 200 }), {
      force: true,
    });
    statSystem(world);
    const snapshot = getEntityEncumbranceSnapshot(world, entity);
    expect(snapshot.band).toBe('overloaded');
    expect(getEntityEncumbranceMultiplier(world, entity)).toBe(snapshot.moveSpeedMultiplier);
    expect(getEntityEncumbranceMultiplier(world, entity)).toBe(0.7);
  });

  it('is inert (unburdened) against the real shipped equipment catalog, whose weightLb is all zero', () => {
    // Sanity: the game's actual catalog explicitly sets weightLb:0 on every def
    // (contract requirement), so encumbrance is currently always a 1.0
    // multiplier in real play despite being fully wired — this pins that
    // intentional invariant against an accidental catalog-wide nonzero edit.
    const snapshot = getEntityEncumbranceSnapshot(world, entity);
    expect(snapshot.moveSpeedMultiplier).toBe(1);
  });
});

describe('movement-speed order of operations (core/movement-speed.ts)', () => {
  let world: GameWorld;
  let entity: number;

  beforeEach(() => {
    world = createTestWorld();
    world.state = 'safe_room';
    entity = addEntity(world.ecs);
    initializeBaseStats(world, entity);
    addComponent(world.ecs, entity, set(Weight, { value: 180 }));
    statSystem(world);
  });

  it('applies moveSpeedBonus, then status multiplier, then encumbrance LAST', () => {
    const baseSpeed = 100;
    // A real modifier (not a raw store write, which the next statSystem
    // recompute would clobber) — folds additively into moveSpeed alongside
    // the baseline Dexterity contribution (base DEX 1 * 0.0025, always-on).
    world.statModifiers.push({
      sourceType: 'buff',
      sourceId: 'test-moveSpeed',
      stat: 'moveSpeed',
      op: 'add',
      value: 0.5,
    });
    applyStatusEffect(world, entity, {
      stat: 'speed',
      op: 'multiply',
      value: 2, // haste doubles speed
      durationMs: null,
      sourceType: 'debug',
      sourceId: 'test-haste',
      stackRule: { mode: 'replace' },
    });
    // Push into the 'overloaded' band (x0.7) via a heavy equipped item.
    equip(world, entity, makeItem({ id: 'boulder-helm', slots: ['head'], weightLb: 300 }), {
      force: true,
    });
    statSystem(world);

    // statSystem was called in beforeEach after initializeBaseStats, so the
    // store slot is guaranteed populated; non-null assertion is safe here.
    const baselineDexMoveSpeed = world.stores.effectiveStats.dexterity[entity]! * 0.0025;
    const moveSpeedBonus = baselineDexMoveSpeed + 0.5;
    expect(world.stores.effectiveStats.moveSpeed[entity]).toBeCloseTo(moveSpeedBonus, 5);

    const result = computeMoveSpeed(world, entity, baseSpeed);
    // baseSpeed * (1 + moveSpeedBonus) * statusMultiplier * encumbranceMultiplier
    // — encumbrance is the LAST factor applied to the already-boosted
    // (DEX/gear/modifier AND status) speed, never to raw base.
    expect(result).toBeCloseTo(baseSpeed * (1 + moveSpeedBonus) * 2 * 0.7, 4);
  });

  it('encumbrance alone (no extra bonus/status) scales the DEX-baseline speed by exactly its band multiplier', () => {
    equip(world, entity, makeItem({ id: 'boulder-helm-2', slots: ['head'], weightLb: 300 }), {
      force: true,
    });
    statSystem(world);
    const baselineDexMoveSpeed = world.stores.effectiveStats.dexterity[entity]! * 0.0025;
    expect(computeMoveSpeed(world, entity, 100)).toBeCloseTo(
      100 * (1 + baselineDexMoveSpeed) * 0.7,
      4,
    );
  });
});
