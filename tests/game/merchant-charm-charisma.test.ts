import { describe, it, expect, beforeEach } from 'vitest';
import fc from 'fast-check';
import { addEntity } from 'bitecs';
import { createTestWorld } from '../helpers/world-factory.js';
import type { GameWorld } from '../../src/core/world.js';
import {
  initializeBaseStats,
  equip,
  unequip,
  getEffectiveStats,
  getEquipmentState,
} from '../../src/core/systems/equipmentSystem.js';
import { MERCHANTS_CHARM_DEF } from '../../src/shared/equipmentDefs.js';

/**
 * Item-(a) regression: the Merchant's Magic Charm must grant exactly +1 Charisma
 * when worn, through the real equipment system path (the same `equip()` the
 * EquipmentUI "Gear" panel drives). Pure logic — no Phaser, no rendering.
 */
describe("Merchant's charm — +1 Charisma", () => {
  let world: GameWorld;
  let entity: number;

  beforeEach(() => {
    world = createTestWorld();
    world.state = 'safe_room';
    entity = addEntity(world.ecs);
    initializeBaseStats(world, entity);
  });

  it('is a neck-slot item that defines a +1 charisma bonus', () => {
    expect(MERCHANTS_CHARM_DEF.slots).toContain('neck');
    expect(MERCHANTS_CHARM_DEF.statBonuses.charisma).toBe(1);
  });

  it('raises effective Charisma by exactly 1 when equipped', () => {
    const before = getEffectiveStats(world, entity).charisma;

    const result = equip(world, entity, MERCHANTS_CHARM_DEF, { force: true });
    expect(result.ok).toBe(true);

    const after = getEffectiveStats(world, entity).charisma;
    expect(after).toBe(before + 1);

    const state = getEquipmentState(world, entity)!;
    expect(state.equipped['neck']).not.toBeNull();
  });

  it('reverts Charisma when unequipped', () => {
    const before = getEffectiveStats(world, entity).charisma;

    equip(world, entity, MERCHANTS_CHARM_DEF, { force: true });
    expect(getEffectiveStats(world, entity).charisma).toBe(before + 1);

    const result = unequip(world, entity, 'neck');
    expect(result.ok).toBe(true);
    expect(getEffectiveStats(world, entity).charisma).toBe(before);
  });

  it('only affects Charisma, leaving the other primary stats unchanged', () => {
    const before = getEffectiveStats(world, entity);
    equip(world, entity, MERCHANTS_CHARM_DEF, { force: true });
    const after = getEffectiveStats(world, entity);

    expect(after.charisma).toBe(before.charisma + 1);
    expect(after.strength).toBe(before.strength);
    expect(after.dexterity).toBe(before.dexterity);
    expect(after.constitution).toBe(before.constitution);
    expect(after.intelligence).toBe(before.intelligence);
    expect(after.wisdom).toBe(before.wisdom);
    expect(after.luck).toBe(before.luck);
  });

  it('grants base+1 Charisma for any starting Charisma (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 200 }), (baseCharisma) => {
        const w = createTestWorld();
        w.state = 'safe_room';
        const eid = addEntity(w.ecs);
        initializeBaseStats(w, eid, { charisma: baseCharisma });

        expect(getEffectiveStats(w, eid).charisma).toBe(baseCharisma);
        const res = equip(w, eid, MERCHANTS_CHARM_DEF, { force: true });
        expect(res.ok).toBe(true);
        expect(getEffectiveStats(w, eid).charisma).toBe(baseCharisma + 1);
      }),
    );
  });
});
