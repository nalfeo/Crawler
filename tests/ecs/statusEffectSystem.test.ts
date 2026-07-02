import { describe, it, expect } from 'vitest';
import { addComponent, removeEntity, set } from 'bitecs';
import { Health } from '../../src/core/components.js';
import { createEntity } from '../../src/core/helpers.js';
import { clearEntityStores } from '../../src/core/spawners/entity-core.js';
import {
  applyStatusEffect,
  clearStatusEffects,
  getStatusEffects,
  computeEffectiveSpeed,
} from '../../src/core/status-effects.js';
import { statusEffectSystem } from '../../src/core/systems/statusEffectSystem.js';
import {
  canEquip,
  equip,
  unequip,
  initializeBaseStats,
} from '../../src/core/systems/equipmentSystem.js';
import { MERCHANTS_CHARM_DEF } from '../../src/shared/equipmentDefs.js';
import { GAME } from '../../src/shared/constants.js';
import type { StatusEffectSpec } from '../../src/shared/status-effect-types.js';
import type { EquipmentItemDef } from '../../src/shared/equipment-types.js';
import { createTestWorld } from '../helpers/world-factory.js';

const DELTA = GAME.DELTA_MS; // fixed 1000/60 ms per frame

const CHILL: StatusEffectSpec = {
  stat: 'speed',
  op: 'multiply',
  value: 0.5,
  durationMs: 1500,
  sourceType: 'trap',
  sourceId: 'chill',
  stackRule: { mode: 'replace' },
};

function tick(world: ReturnType<typeof createTestWorld>, frames: number): void {
  for (let i = 0; i < frames; i++) statusEffectSystem(world);
}

describe('applyStatusEffect + stack rules', () => {
  it('replace overwrites the same-key effect (idempotent re-apply)', () => {
    const world = createTestWorld();
    const eid = createEntity(world);
    applyStatusEffect(world, eid, CHILL);
    tick(world, 3);
    applyStatusEffect(world, eid, CHILL); // replace resets remaining to full
    const fx = getStatusEffects(world, eid);
    expect(fx).toHaveLength(1);
    expect(fx[0]!.remainingMs).toBe(1500);
  });

  it('refresh extends remaining to the larger lifetime', () => {
    const world = createTestWorld();
    const eid = createEntity(world);
    const refresh: StatusEffectSpec = {
      ...CHILL,
      sourceId: 'r',
      durationMs: 100,
      stackRule: { mode: 'refresh' },
    };
    applyStatusEffect(world, eid, refresh);
    tick(world, 3); // remaining = 100 - 3*DELTA = 50
    applyStatusEffect(world, eid, refresh); // max(50, 100) = 100
    const fx = getStatusEffects(world, eid);
    expect(fx).toHaveLength(1);
    expect(fx[0]!.remainingMs).toBeCloseTo(100, 10);
  });

  it('stack appends up to maxStacks, dropping the oldest beyond the cap', () => {
    const world = createTestWorld();
    const eid = createEntity(world);
    const stackSpec: StatusEffectSpec = {
      ...CHILL,
      sourceId: 's',
      op: 'multiply',
      value: 0.9,
      stackRule: { mode: 'stack', maxStacks: 2 },
    };
    applyStatusEffect(world, eid, stackSpec);
    applyStatusEffect(world, eid, stackSpec);
    applyStatusEffect(world, eid, stackSpec); // over cap → oldest dropped
    const fx = getStatusEffects(world, eid);
    expect(fx).toHaveLength(2);
    // Two 0.9 stacks compose multiplicatively: 100 * 0.9 * 0.9 = 81 (not 0.9^3).
    expect(computeEffectiveSpeed(100, fx)).toBeCloseTo(81, 10);
  });

  it('rejects an invalid spec without mutating state', () => {
    const world = createTestWorld();
    const eid = createEntity(world);
    const bad: StatusEffectSpec = { ...CHILL, op: 'multiply', value: -1 };
    expect(applyStatusEffect(world, eid, bad)).toBe(false);
    expect(getStatusEffects(world, eid)).toHaveLength(0);
  });
});

describe('getStatusEffects / clearStatusEffects', () => {
  it('returns an empty list for an entity with no effects', () => {
    const world = createTestWorld();
    const eid = createEntity(world);
    expect(getStatusEffects(world, eid)).toHaveLength(0);
  });

  it('clears all effects with no predicate', () => {
    const world = createTestWorld();
    const eid = createEntity(world);
    applyStatusEffect(world, eid, CHILL);
    applyStatusEffect(world, eid, { ...CHILL, sourceId: 'other' });
    clearStatusEffects(world, eid);
    expect(getStatusEffects(world, eid)).toHaveLength(0);
  });

  it('clears only effects matching a predicate', () => {
    const world = createTestWorld();
    const eid = createEntity(world);
    applyStatusEffect(world, eid, { ...CHILL, sourceId: 'keep' });
    applyStatusEffect(world, eid, { ...CHILL, sourceId: 'drop' });
    clearStatusEffects(world, eid, (e) => e.sourceId === 'drop');
    const fx = getStatusEffects(world, eid);
    expect(fx).toHaveLength(1);
    expect(fx[0]!.sourceId).toBe('keep');
  });
});

describe('statusEffectSystem — timed expiry (deterministic)', () => {
  it('expires exactly when remaining reaches 0', () => {
    const world = createTestWorld();
    const eid = createEntity(world);
    applyStatusEffect(world, eid, { ...CHILL, durationMs: 100 }); // 6 frames * DELTA = 100
    tick(world, 5);
    expect(getStatusEffects(world, eid)).toHaveLength(1);
    tick(world, 1); // 6th frame: remaining hits 0 → dropped
    expect(getStatusEffects(world, eid)).toHaveLength(0);
  });

  it('produces identical remaining lifetimes for identical worlds + frame counts', () => {
    const remainingAfter = (): number[] => {
      const world = createTestWorld();
      const eid = createEntity(world);
      applyStatusEffect(world, eid, { ...CHILL, durationMs: 100 });
      tick(world, 4);
      return getStatusEffects(world, eid).map((e) => e.remainingMs);
    };
    const a = remainingAfter();
    const b = remainingAfter();
    expect(a).toEqual(b);
    expect(a[0]!).toBeCloseTo(100 - 4 * DELTA, 10);
  });

  it('persistent effects never tick down', () => {
    const world = createTestWorld();
    const eid = createEntity(world);
    applyStatusEffect(world, eid, { ...CHILL, durationMs: null });
    tick(world, 600);
    const fx = getStatusEffects(world, eid);
    expect(fx).toHaveLength(1);
    expect(fx[0]!.remainingMs).toBe(Infinity);
  });
});

describe('statusEffectSystem — heal-over-time (hpRegen)', () => {
  const REGEN: StatusEffectSpec = {
    stat: 'hpRegen',
    op: 'add',
    value: 0.75, // HP/sec
    durationMs: null,
    sourceType: 'equipment',
    sourceId: 'charm',
    stackRule: { mode: 'replace' },
  };

  it('heals current HP by rate * dt, accruing over frames', () => {
    const world = createTestWorld();
    const eid = createEntity(world);
    addComponent(world.ecs, eid, set(Health, { current: 50, max: 100 }));
    applyStatusEffect(world, eid, REGEN);
    tick(world, 60); // 60 * DELTA = 1000ms = 1s → +0.75 HP
    // health.current is a Float32 store, so 60 accumulations of 0.0125 land a few
    // 1e-5 off the ideal 50.75; precision 3 (±5e-4) tolerates that while still
    // catching any real rate/dt error (which would be ≥0.01).
    expect(world.stores.health.current[eid]!).toBeCloseTo(50.75, 3);
  });

  it('clamps healing to max HP', () => {
    const world = createTestWorld();
    const eid = createEntity(world);
    addComponent(world.ecs, eid, set(Health, { current: 99.9, max: 100 }));
    applyStatusEffect(world, eid, REGEN);
    tick(world, 120); // would exceed max
    expect(world.stores.health.current[eid]!).toBe(100);
  });

  it('never heals a dead entity (current <= 0) — no revive', () => {
    const world = createTestWorld();
    const eid = createEntity(world);
    addComponent(world.ecs, eid, set(Health, { current: 0, max: 100 }));
    applyStatusEffect(world, eid, REGEN);
    tick(world, 60);
    expect(world.stores.health.current[eid]!).toBe(0);
  });
});

describe('recycled-EID guard', () => {
  it('clearEntityStores wipes an entity’s effects (the reuse-path hook)', () => {
    const world = createTestWorld();
    const eid = createEntity(world);
    applyStatusEffect(world, eid, CHILL);
    expect(getStatusEffects(world, eid)).toHaveLength(1);
    clearEntityStores(world, eid);
    expect(getStatusEffects(world, eid)).toHaveLength(0);
  });

  it('a new entity created after a removal never inherits stale effects', () => {
    const world = createTestWorld();
    const first = createEntity(world);
    applyStatusEffect(world, first, CHILL);
    removeEntity(world.ecs, first);
    const second = createEntity(world);
    expect(getStatusEffects(world, second)).toHaveLength(0);
  });
});

describe('equipment integration (Merchant’s Charm HoT)', () => {
  function spawnWearer(): { world: ReturnType<typeof createTestWorld>; eid: number } {
    const world = createTestWorld();
    world.state = 'safe_room';
    const eid = createEntity(world);
    initializeBaseStats(world, eid);
    return { world, eid };
  }

  it('equip grants an instance-scoped persistent hpRegen effect', () => {
    const { world, eid } = spawnWearer();
    const result = equip(world, eid, MERCHANTS_CHARM_DEF, { force: true });
    expect(result.ok).toBe(true);
    const fx = getStatusEffects(world, eid);
    expect(fx).toHaveLength(1);
    expect(fx[0]!.stat).toBe('hpRegen');
    expect(fx[0]!.value).toBe(0.75);
    expect(fx[0]!.remainingMs).toBe(Infinity);
    if (result.ok) {
      expect(fx[0]!.sourceId).toBe(`equipment:${result.instanceId}`);
    }
  });

  it('unequip clears only that instance’s effects', () => {
    const { world, eid } = spawnWearer();
    // An unrelated effect from another source must survive the unequip.
    applyStatusEffect(world, eid, { ...CHILL, sourceId: 'unrelated' });
    equip(world, eid, MERCHANTS_CHARM_DEF, { force: true });
    expect(getStatusEffects(world, eid)).toHaveLength(2);
    unequip(world, eid, 'neck', { force: true });
    const fx = getStatusEffects(world, eid);
    expect(fx).toHaveLength(1);
    expect(fx[0]!.sourceId).toBe('unrelated');
  });

  it('an invalid granted spec fails canEquip and equip mutates nothing (atomic)', () => {
    const { world, eid } = spawnWearer();
    const badCharm: EquipmentItemDef = {
      id: 'bad-charm',
      name: 'Bad Charm',
      slots: ['neck'],
      statBonuses: {},
      rarity: 'common',
      grantsStatusEffects: [
        {
          stat: 'hpRegen',
          op: 'multiply',
          value: -1, // invalid multiply factor
          durationMs: null,
          sourceType: 'equipment',
          sourceId: 'bad',
          stackRule: { mode: 'replace' },
        },
      ],
    };
    expect(canEquip(world, eid, badCharm).allowed).toBe(false);
    expect(equip(world, eid, badCharm, { force: true }).ok).toBe(false);
    expect(getStatusEffects(world, eid)).toHaveLength(0);
    // Slot was not consumed — the valid charm can still be equipped afterwards.
    expect(equip(world, eid, MERCHANTS_CHARM_DEF, { force: true }).ok).toBe(true);
  });
});
