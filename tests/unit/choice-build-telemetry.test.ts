import {
  createActiveWeaponSnapshotV1,
  createGeneratedEquipmentInstance,
  generatedEquipmentInstanceKey,
} from '../../src/core/generated-equipment-registry.js';
import {
  addGeneratedEquipmentToBag,
  equipFromBag,
} from '../../src/core/systems/equipmentSystem.js';
import { FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION } from '../../src/shared/generated-equipment-types.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { describe, expect, it } from 'vitest';
import {
  createChoiceBuildRecorder,
  recordBuildSnapshot,
  recordChoiceOffer,
  recordChoiceSelection,
  finalizeChoiceBuildTelemetry,
  type ChoiceBuildTelemetry,
} from '../../src/game/ai/choice-build-telemetry.js';
import { captureChoiceBuild, readChoiceBuild } from '../../src/game/ai/headless-choice-build.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import {
  memorizeSpell,
  equipActiveAbility,
  unequipActiveAbility,
} from '../../src/game/systems/abilitySystem.js';
import {
  choiceBuildDiagnostics,
  choiceBuildEvidence,
} from '../../scripts/agent/health/choice-build-diagnostics.js';

const option = (catalogKey: string, selectable = true) => ({
  catalogKey,
  selectable,
  constraints: selectable ? [] : ['insufficient-funds'],
});
function example(selected = 'spell:heal') {
  const state = createChoiceBuildRecorder([{ catalogKey: 'weapon:sword', location: 'equipped' }]);
  recordChoiceOffer(state, 'boss-spell', [option('spell:heal'), option('spell:fire')], 100, 80);
  recordChoiceSelection(state, 'boss-spell', selected, 110, 90);
  recordBuildSnapshot(
    state,
    [
      { catalogKey: 'weapon:sword', location: 'equipped' },
      { catalogKey: selected, location: 'learned' },
    ],
    110,
    90,
  );
  return state;
}

describe('choice/build evidence', () => {
  it.each([true, false])(
    'counts generated weapons once across bag/equip transitions (starter=%s)',
    (starter) => {
      const runKey = 'choice-generated-weapon';
      const world = createTestWorld({ generatedEquipmentRunKey: runKey });
      const player = spawnPlayer(world, 0, 0);
      world.featureUnlocks.equipment = true;
      const snapshot = createActiveWeaponSnapshotV1(
        { instanceId: generatedEquipmentInstanceKey(runKey, 0) },
        getWeaponDef('sword')!,
        {},
      );
      const instance = createGeneratedEquipmentInstance(world, {
        baseId: 'weapon.choice-test',
        itemLevel: 1,
        rarity: 'common',
        enhancementLevel: 0,
        resolvedEffects: [],
        frozen: {
          schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
          displayName: snapshot.name,
          artKey: 'weapon.choice-test',
          slots: ['mainHand'],
          tags: ['weapon'],
          weightLb: 1,
          statBonuses: {},
          abilityGrants: [],
          passiveGrants: [],
          activeWeaponSnapshot: snapshot,
        },
      });
      const before = readChoiceBuild(world, player);
      expect(addGeneratedEquipmentToBag(world, player, instance.instanceId).ok).toBe(true);
      const bag = readChoiceBuild(world, player);
      expect(bag).toHaveLength(1);
      const recorder = createChoiceBuildRecorder(starter ? bag : before);
      recordBuildSnapshot(recorder, bag, 1, 1);
      expect(
        equipFromBag(
          world,
          player,
          { kind: 'generated-instance', instanceKey: instance.instanceId },
          { force: true },
        ).ok,
      ).toBe(true);
      const equipped = readChoiceBuild(world, player);
      expect(equipped).toEqual([{ catalogKey: bag[0]!.catalogKey, location: 'equipped' }]);
      recordBuildSnapshot(recorder, equipped, 2, 2);
      const diagnostic = choiceBuildDiagnostics(finalizeChoiceBuildTelemetry(recorder));
      expect(diagnostic.acquisitions).toBe(starter ? 0 : 1);
      if (starter) expect(diagnostic.acquiredBuildIdentity).toBeNull();
      else expect(JSON.parse(diagnostic.acquiredBuildIdentity!)).toHaveLength(1);
    },
  );

  it.each([
    null,
    {},
    { schemaVersion: 2 },
    { ...finalizeChoiceBuildTelemetry(example()), events: [null] },
    {
      ...finalizeChoiceBuildTelemetry(example()),
      events: [
        { kind: 'build', source: 'x', gameTimeMs: 0, activeTimeMs: 0, build: [null], acquired: [] },
      ],
    },
    {
      ...finalizeChoiceBuildTelemetry(example()),
      events: [
        {
          kind: 'offer',
          source: 'x',
          gameTimeMs: 0,
          activeTimeMs: 0,
          options: [{ catalogKey: 'x', selectable: true, constraints: 4 }],
        },
      ],
    },
  ])('rejects malformed evidence without throwing: %j', (data) => {
    expect(choiceBuildDiagnostics(data as ChoiceBuildTelemetry).availability).toBe('invalid');
  });

  it('ignores duplicate events and canonicalizes offer order', () => {
    const data = finalizeChoiceBuildTelemetry(example());
    const copied = { ...data, events: [...data.events, ...data.events] };
    expect(choiceBuildDiagnostics(copied)).toEqual(choiceBuildDiagnostics(data));
    const reordered = {
      ...data,
      events: data.events.map((event) =>
        event.kind === 'offer' ? { ...event, options: [...event.options!].reverse() } : event,
      ),
    };
    expect(choiceBuildDiagnostics(reordered)).toEqual(choiceBuildDiagnostics(data));
  });

  it('keeps offer revisits in the path without adding unique observations', () => {
    const state = createChoiceBuildRecorder([]);
    recordChoiceOffer(state, 'shop', [option('a')], 1, 1);
    recordChoiceOffer(state, 'shop', [option('b')], 2, 2);
    const before = choiceBuildDiagnostics(finalizeChoiceBuildTelemetry(state));
    recordChoiceOffer(state, 'shop', [option('a')], 3, 3);
    const after = choiceBuildDiagnostics(finalizeChoiceBuildTelemetry(state));
    expect(after.offers).toBe(2);
    expect(after.pathIdentity).not.toBe(before.pathIdentity);
  });

  it('does not let duplicate snapshots reverse the final build at tied timestamps', () => {
    const state = createChoiceBuildRecorder([]);
    recordBuildSnapshot(state, [{ catalogKey: 'spell:heal', location: 'owned' }], 1, 1);
    recordBuildSnapshot(state, [{ catalogKey: 'spell:heal', location: 'active' }], 1, 1);
    const data = finalizeChoiceBuildTelemetry(state);
    expect(choiceBuildDiagnostics({ ...data, events: [...data.events, data.events[0]!] })).toEqual(
      choiceBuildDiagnostics(data),
    );
  });

  it('counts confirmation separately from submitted intent', () => {
    const state = createChoiceBuildRecorder([]);
    recordChoiceSelection(state, 'poach', 'companion:rat', 1, 1, 'submitted');
    expect(choiceBuildDiagnostics(finalizeChoiceBuildTelemetry(state)).confirmedSelections).toBe(0);
    recordChoiceSelection(state, 'poach', 'companion:rat', 2, 2);
    expect(choiceBuildDiagnostics(finalizeChoiceBuildTelemetry(state)).confirmedSelections).toBe(1);
  });

  it('excludes starter reacquisition and tracks acquired removals and revisits', () => {
    const starter = { catalogKey: 'weapon:sword', location: 'equipped' as const };
    const acquired = { catalogKey: 'spell:heal', location: 'active' as const };
    const state = createChoiceBuildRecorder([starter]);
    recordBuildSnapshot(state, [], 1, 1);
    recordBuildSnapshot(state, [starter], 2, 2);
    expect(choiceBuildDiagnostics(finalizeChoiceBuildTelemetry(state))).toMatchObject({
      acquisitions: 0,
      pathIdentity: null,
    });
    recordBuildSnapshot(state, [starter, acquired], 3, 3);
    recordBuildSnapshot(state, [starter], 4, 4);
    const removed = choiceBuildDiagnostics(finalizeChoiceBuildTelemetry(state));
    expect(removed).toMatchObject({ acquisitions: 1, acquiredBuildIdentity: null });
    recordBuildSnapshot(state, [starter, acquired], 5, 5);
    const revisited = choiceBuildDiagnostics(finalizeChoiceBuildTelemetry(state));
    expect(revisited.acquisitions).toBe(1);
    expect(revisited.pathIdentity).not.toBe(removed.pathIdentity);
    const forged = finalizeChoiceBuildTelemetry(state);
    expect(
      choiceBuildDiagnostics({
        ...forged,
        events: forged.events.map((event) => ({ ...event, acquired: ['fake', 'fake'] })),
      }).acquisitions,
    ).toBe(1);
  });

  it('counts a learned and owned spell once and preserves active changes', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    const state = createChoiceBuildRecorder(readChoiceBuild(world, player));
    memorizeSpell(world, player, 'heal');
    equipActiveAbility(world, player, 'heal');
    recordBuildSnapshot(state, readChoiceBuild(world, player), 1, 1);
    expect(
      readChoiceBuild(world, player).filter((item) => item.catalogKey.endsWith(':heal')),
    ).toEqual([{ catalogKey: 'spell:heal', location: 'active' }]);
    const active = choiceBuildDiagnostics(finalizeChoiceBuildTelemetry(state));
    unequipActiveAbility(world, player, 'heal');
    recordBuildSnapshot(state, readChoiceBuild(world, player), 2, 2);
    const owned = choiceBuildDiagnostics(finalizeChoiceBuildTelemetry(state));
    expect(owned.acquisitions).toBe(1);
    expect(owned.acquiredBuildIdentity).not.toBe(active.acquiredBuildIdentity);
  });

  it('excludes carried vendor purchases and samples new purchase time once', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    const purchase = {
      vendorId: 'broker',
      itemId: 'heal',
      cost: 10,
      outcome: 'purchased' as const,
      playerGold: 20,
      gameTimeMs: 5,
      frame: 1,
      reason: 'spell',
    };
    world.vendorLedger.decisions.push(purchase);
    const baseline = world.vendorLedger.decisions.length;
    const state = createChoiceBuildRecorder(readChoiceBuild(world, player));
    captureChoiceBuild(state, world, player, 10, baseline);
    expect(state.events.filter((event) => event.kind === 'selection')).toHaveLength(0);
    world.vendorLedger.decisions.push({ ...purchase, gameTimeMs: 15 });
    captureChoiceBuild(state, world, player, 20, baseline);
    captureChoiceBuild(state, world, player, 30, baseline);
    expect(state.events.filter((event) => event.kind === 'selection')).toMatchObject([
      { gameTimeMs: 15, activeTimeMs: 20, selected: 'spell:heal' },
    ]);
  });
  it('baselines starting and carried-over state without acquired credit', () => {
    const starting = [{ catalogKey: 'spell:heal', location: 'learned' as const }];
    const state = createChoiceBuildRecorder(starting);
    recordBuildSnapshot(state, starting, 20, 10);
    expect(choiceBuildDiagnostics(finalizeChoiceBuildTelemetry(state))).toMatchObject({
      acquisitions: 0,
      pathIdentity: null,
      acquiredBuildIdentity: null,
    });
  });

  it('deduplicates polling and selections but retains constraints changing', () => {
    const state = example();
    recordChoiceOffer(state, 'boss-spell', [option('spell:heal'), option('spell:fire')], 120, 100);
    recordChoiceSelection(state, 'boss-spell', 'spell:heal', 120, 100);
    expect(state.events).toHaveLength(3);
    recordChoiceOffer(state, 'boss-spell', [option('spell:heal', false)], 130, 110);
    expect(state.events.at(-1)).toMatchObject({
      gameTimeMs: 130,
      activeTimeMs: 110,
      options: [option('spell:heal', false)],
    });
  });

  it('distinguishes offered paths, selections, and acquired builds', () => {
    const heal = choiceBuildDiagnostics(finalizeChoiceBuildTelemetry(example()));
    const fire = choiceBuildDiagnostics(finalizeChoiceBuildTelemetry(example('spell:fire')));
    expect(heal.pathIdentity).not.toBe(fire.pathIdentity);
    expect(heal.acquiredBuildIdentity).not.toBe(fire.acquiredBuildIdentity);
    expect(heal.acquiredBuildIdentity).not.toContain('sword');
    const other = example();
    recordChoiceOffer(other, 'extra', [option('spell:ice')], 200, 180);
    expect(choiceBuildDiagnostics(finalizeChoiceBuildTelemetry(other)).pathIdentity).not.toBe(
      heal.pathIdentity,
    );
  });

  it('records equip transitions without calling them acquisitions', () => {
    const state = createChoiceBuildRecorder([{ catalogKey: 'generated:ring', location: 'bag' }]);
    recordBuildSnapshot(state, [{ catalogKey: 'generated:ring', location: 'equipped' }], 100, 70);
    expect(state.events[0]).toMatchObject({ kind: 'build', acquired: [] });
  });

  it('bounds retained events and refuses truncated identities', () => {
    const state = createChoiceBuildRecorder([]);
    for (let i = 0; i < 2050; i++) recordChoiceOffer(state, 'shop', [option(`item:${i}`)], i, i);
    expect(state.events).toHaveLength(2048);
    expect(choiceBuildDiagnostics(finalizeChoiceBuildTelemetry(state))).toMatchObject({
      availability: 'truncated',
      pathIdentity: null,
      acquiredBuildIdentity: null,
    });
    expect(choiceBuildDiagnostics(undefined).availability).toBe('missing');
  });

  it('gives each identified headless scenario one vote and excludes conflicting copies', () => {
    const choice_build = choiceBuildDiagnostics(finalizeChoiceBuildTelemetry(example()));
    const row = { identity: 'seed42', source: 'headless', choice_build };
    expect(choiceBuildEvidence([row, row])).toEqual(choiceBuildEvidence([row]));
    expect(
      choiceBuildEvidence([
        row,
        {
          ...row,
          choice_build: choiceBuildDiagnostics(finalizeChoiceBuildTelemetry(example('spell:fire'))),
        },
      ]),
    ).toMatchObject({ observedScenarios: 0, conflictingScenarios: 1, distinctAcquiredBuilds: 0 });
    expect(
      choiceBuildEvidence([
        { ...row, source: 'human' },
        { ...row, identity: null },
      ]).observedScenarios,
    ).toBe(0);
  });
});
