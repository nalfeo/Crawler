import { describe, expect, it } from 'vitest';
import {
  _captureFloor3PartyProgress,
  diffFloor3PartyProgress,
  _milestonesCrossed,
  snapshotFromRows,
} from '../../src/engine/floor3-level-up-notice-state.js';
import { resolveFloor3PartyRows } from '../../src/engine/floor3-party-state.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { spawnTestCompanion } from '../helpers/floor3-party.js';

function floor3World() {
  const world = createTestWorld();
  world.floor = 3;
  world.floorId = 'floor3';
  return world;
}

describe('_milestonesCrossed', () => {
  it('reports every milestone a multi-level jump crosses, in level order', () => {
    expect(_milestonesCrossed(1, 7)).toEqual([]);
    expect(_milestonesCrossed(7, 8)).toEqual([8]);
    expect(_milestonesCrossed(1, 26)).toEqual([8, 16, 25]);
    expect(_milestonesCrossed(25, 34)).toEqual([34]);
  });
});

describe('diffFloor3PartyProgress', () => {
  it('emits nothing when nothing changed', () => {
    const world = floor3World();
    spawnTestCompanion(world, { speciesId: 'ember-charger' });
    const before = _captureFloor3PartyProgress(world);
    expect(diffFloor3PartyProgress(before, _captureFloor3PartyProgress(world))).toEqual([]);
  });

  it('emits level, evolve, and learn notices for one level jump, in that order', () => {
    const world = floor3World();
    const eid = spawnTestCompanion(world, { speciesId: 'ember-charger', level: 7 });
    const before = _captureFloor3PartyProgress(world);

    world.stores.companion.level[eid] = 10;
    const notices = diffFloor3PartyProgress(before, _captureFloor3PartyProgress(world));

    expect(notices.map((notice) => notice.kind)).toEqual(['level', 'evolve', 'learn']);
    expect(notices[1]!.form).toBe(1);
    expect(notices[0]!.level).toBe(10);
    expect(notices[2]!.text).toContain('learned');
  });

  it('emits one learn notice per crossed milestone on a multi-level jump', () => {
    const world = floor3World();
    const eid = spawnTestCompanion(world, { speciesId: 'ember-charger', level: 1 });
    const before = _captureFloor3PartyProgress(world);

    world.stores.companion.level[eid] = 26;
    const notices = diffFloor3PartyProgress(before, _captureFloor3PartyProgress(world));

    const learns = notices.filter((notice) => notice.kind === 'learn');
    expect(learns.map((notice) => notice.abilityId)).toEqual([
      'f3.ember-charger.l8',
      'f3.ember-charger.l16',
      'f3.ember-charger.l25',
    ]);
  });

  it('emits notices in party-slot order', () => {
    const world = floor3World();
    const second = spawnTestCompanion(world, { speciesId: 'ember-charger', slot: 1, level: 1 });
    const first = spawnTestCompanion(world, { speciesId: 'bloom-warden', slot: 0, level: 1 });
    const before = _captureFloor3PartyProgress(world);

    world.stores.companion.level[second] = 2;
    world.stores.companion.level[first] = 2;
    const notices = diffFloor3PartyProgress(before, _captureFloor3PartyProgress(world));

    expect(notices.map((notice) => notice.slot)).toEqual([0, 1]);
  });

  it('baselines a newly recruited Companion silently', () => {
    const world = floor3World();
    spawnTestCompanion(world, { speciesId: 'ember-charger', slot: 0 });
    const before = _captureFloor3PartyProgress(world);

    spawnTestCompanion(world, { speciesId: 'bloom-warden', slot: 1, level: 30 });
    expect(diffFloor3PartyProgress(before, _captureFloor3PartyProgress(world))).toEqual([]);
  });

  it('never attributes a notice across a recycled entity id', () => {
    const world = floor3World();
    const eid = spawnTestCompanion(world, { speciesId: 'ember-charger', slot: 0, level: 20 });
    const before = _captureFloor3PartyProgress(world);

    // Same eid, different species token: a recycled entity, not a level-up.
    const recycled = snapshotFromRows(
      resolveFloor3PartyRows(world).map((row) => ({ ...row, key: `0:${row.eid + 999}` as const })),
    );
    expect(diffFloor3PartyProgress(before, recycled)).toEqual([]);
    expect(world.stores.companion.level[eid]).toBe(20);
  });

  it('ignores a level regression', () => {
    const world = floor3World();
    const eid = spawnTestCompanion(world, { speciesId: 'ember-charger', level: 12 });
    const before = _captureFloor3PartyProgress(world);

    world.stores.companion.level[eid] = 5;
    expect(diffFloor3PartyProgress(before, _captureFloor3PartyProgress(world))).toEqual([]);
  });
});
