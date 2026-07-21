import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import {
  abilitySystem,
  AbilityGrantError,
  configureOwnedActiveAbility,
  equipActiveAbility,
  getOrCreateAbilityState,
  grantAbilitySources,
  grantPassiveAbility,
  normalizeAbilityState,
  revokeAbilitySources,
  unequipActiveAbility,
} from '../../src/game/systems/abilitySystem.js';
import {
  equipmentAbilityGrantSourceId,
  isAbilityGrantSourceId,
  learnedAbilityGrantSourceId,
  skillAbilityGrantSourceId,
  ACTIVE_ABILITY_SLOT_LIMIT,
  type AbilityGrantSourceId,
  type AbilityState,
} from '../../src/shared/abilities.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('source-owned ability grants', () => {
  it('preserves the retained state handle when re-equipping an owned active', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    grantAbilitySources(
      world,
      player,
      [
        {
          kind: 'active',
          abilityId: 'fireball',
          sourceId: learnedAbilityGrantSourceId('fireball'),
        },
      ],
      { configureActives: 'require-slots' },
    );
    const retained = getOrCreateAbilityState(world, player);

    unequipActiveAbility(world, player, 'fireball');
    equipActiveAbility(world, player, 'fireball');

    expect(world.abilityStatesByEntity.get(player)).toBe(retained);
    expect(retained.equippedActiveAbilityIds).toEqual(['fireball']);
  });

  it('records learned provenance for a direct equipActiveAbility grant', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);

    equipActiveAbility(world, player, 'battle-focus');

    const state = getOrCreateAbilityState(world, player);
    expect(state.equippedActiveAbilityIds).toEqual(['battle-focus']);
    expect(state.grantOwnership.activeSourcesByAbilityId.get('battle-focus')).toEqual(
      new Set([learnedAbilityGrantSourceId('battle-focus')]),
    );
  });

  it('drops retired configured actives before enforcing the legacy equip slot cap', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    world.abilityStatesByEntity.set(player, {
      learnedSpellIds: [],
      equippedActiveAbilityIds: [
        'retired-spell',
        'battle-focus',
        'heal',
        'pulse-shield',
        'magic-missile',
        'frost-nova',
        'bless',
        'stoneskin',
        'curse',
        'vampiric-touch',
      ],
      passiveAbilityIds: [],
      cooldownByAbilityId: new Map(),
      cooldownFramesByAbilityId: new Map(),
      appliedPassiveAbilityIds: new Set(),
    });

    equipActiveAbility(world, player, 'fireball');

    expect(getOrCreateAbilityState(world, player).equippedActiveAbilityIds).toEqual([
      'battle-focus',
      'heal',
      'pulse-shield',
      'magic-missile',
      'frost-nova',
      'bless',
      'stoneskin',
      'curse',
      'vampiric-touch',
      'fireball',
    ]);
  });

  it('preserves an active ability until its final independent source is revoked', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    const learned = learnedAbilityGrantSourceId('fireball');
    const equipment = equipmentAbilityGrantSourceId('gei:v1:grant-test:0', 0);

    grantAbilitySources(
      world,
      player,
      [
        { kind: 'active', abilityId: 'fireball', sourceId: learned },
        { kind: 'active', abilityId: 'fireball', sourceId: equipment },
      ],
      { configureActives: 'fill-open-slots' },
    );
    grantAbilitySources(world, player, [
      { kind: 'active', abilityId: 'fireball', sourceId: equipment },
    ]);

    revokeAbilitySources(world, player, [
      { kind: 'active', abilityId: 'fireball', sourceId: equipment },
    ]);
    let state = getOrCreateAbilityState(world, player);
    expect(state.grantOwnership.activeSourcesByAbilityId.get('fireball')).toEqual(
      new Set([learned]),
    );
    expect(state.equippedActiveAbilityIds).toEqual(['fireball']);

    revokeAbilitySources(world, player, [
      { kind: 'active', abilityId: 'fireball', sourceId: learned },
    ]);
    state = getOrCreateAbilityState(world, player);
    expect(state.grantOwnership.activeSourcesByAbilityId.has('fireball')).toBe(false);
    expect(state.equippedActiveAbilityIds).toEqual([]);
  });

  it('removes applied passive modifiers immediately only after the final source', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    const skill = skillAbilityGrantSourceId('iron-skin', 5);
    const equipment = equipmentAbilityGrantSourceId('gei:v1:grant-test:1', 0);
    const requests = [
      { kind: 'passive', abilityId: 'veteran-instinct', sourceId: skill },
      { kind: 'passive', abilityId: 'veteran-instinct', sourceId: equipment },
    ] as const;

    grantAbilitySources(world, player, requests);
    abilitySystem(world);
    expect(
      world.statModifiers.filter((modifier) =>
        modifier.sourceId.startsWith('veteran-instinct:passive'),
      ),
    ).toHaveLength(2);

    revokeAbilitySources(world, player, [requests[1]]);
    expect(getOrCreateAbilityState(world, player).passiveAbilityIds).toEqual(['veteran-instinct']);
    expect(
      world.statModifiers.filter((modifier) =>
        modifier.sourceId.startsWith('veteran-instinct:passive'),
      ),
    ).toHaveLength(2);

    revokeAbilitySources(world, player, [requests[0]]);
    expect(getOrCreateAbilityState(world, player).passiveAbilityIds).toEqual([]);
    expect(
      world.statModifiers.filter((modifier) =>
        modifier.sourceId.startsWith('veteran-instinct:passive'),
      ),
    ).toHaveLength(0);
  });

  it('uses learned passive ownership for direct grant/revoke helpers', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    const learned = learnedAbilityGrantSourceId('veteran-instinct');

    grantPassiveAbility(world, player, 'veteran-instinct');
    abilitySystem(world);

    let state = normalizeAbilityState(getOrCreateAbilityState(world, player));
    expect(state.grantOwnership.passiveSourcesByAbilityId.get('veteran-instinct')).toEqual(
      new Set([learned]),
    );
    expect(state.passiveAbilityIds).toEqual(['veteran-instinct']);
    expect(
      world.statModifiers.filter((modifier) =>
        modifier.sourceId.startsWith('veteran-instinct:passive'),
      ),
    ).toHaveLength(2);

    revokeAbilitySources(world, player, [
      { kind: 'passive', abilityId: 'veteran-instinct', sourceId: learned },
    ]);

    state = normalizeAbilityState(getOrCreateAbilityState(world, player));
    expect(state.grantOwnership.passiveSourcesByAbilityId.has('veteran-instinct')).toBe(false);
    expect(state.passiveAbilityIds).toEqual([]);
    expect(
      world.statModifiers.filter((modifier) =>
        modifier.sourceId.startsWith('veteran-instinct:passive'),
      ),
    ).toHaveLength(0);
  });

  it('keeps a newly equipment-granted active known but inactive at the slot cap', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    const state = getOrCreateAbilityState(world, player);
    const activeIds = [
      'battle-focus',
      'fireball',
      'heal',
      'pulse-shield',
      'magic-missile',
      'frost-nova',
      'bless',
      'stoneskin',
      'curse',
      'vampiric-touch',
    ];
    activeIds.forEach((abilityId, effectOrdinal) => {
      grantAbilitySources(
        world,
        player,
        [
          {
            kind: 'active',
            abilityId,
            sourceId: equipmentAbilityGrantSourceId(
              `gei:v1:cap-test:${effectOrdinal}`,
              effectOrdinal,
            ),
          },
        ],
        { configureActives: 'fill-open-slots' },
      );
    });
    expect(state.equippedActiveAbilityIds).toHaveLength(10);

    const hasteSource = equipmentAbilityGrantSourceId('gei:v1:cap-test:10', 0);
    grantAbilitySources(
      world,
      player,
      [{ kind: 'active', abilityId: 'haste', sourceId: hasteSource }],
      { configureActives: 'fill-open-slots' },
    );
    expect(getOrCreateAbilityState(world, player).equippedActiveAbilityIds).not.toContain('haste');
    expect(
      getOrCreateAbilityState(world, player).grantOwnership.activeSourcesByAbilityId.get('haste'),
    ).toEqual(new Set([hasteSource]));
  });

  it('rejects an invalid mixed batch without creating or mutating state', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    const validSource = learnedAbilityGrantSourceId('fireball');

    try {
      grantAbilitySources(world, player, [
        { kind: 'active', abilityId: 'fireball', sourceId: validSource },
        {
          kind: 'passive',
          abilityId: 'veteran-instinct',
          sourceId: 'equipment:not-an-instance:0' as AbilityGrantSourceId,
        },
      ]);
      throw new Error('Expected invalid ability source to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(AbilityGrantError);
      expect((error as AbilityGrantError).code).toBe('invalid-source');
    }
    expect(world.abilityStatesByEntity.has(player)).toBe(false);

    equipActiveAbility(world, player, 'battle-focus');
    const before = world.abilityStatesByEntity.get(player)!;
    const beforeEquipped = [...before.equippedActiveAbilityIds];
    const sharedSkillSource = skillAbilityGrantSourceId('pyromancy', 1);
    try {
      grantAbilitySources(world, player, [
        {
          kind: 'active',
          abilityId: 'fireball',
          sourceId: sharedSkillSource,
        },
        {
          kind: 'active',
          abilityId: 'heal',
          sourceId: sharedSkillSource,
        },
      ]);
      throw new Error('Expected conflicting ability source to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(AbilityGrantError);
      expect((error as AbilityGrantError).code).toBe('source-conflict');
    }
    expect(world.abilityStatesByEntity.get(player)).toBe(before);
    expect(before.equippedActiveAbilityIds).toEqual(beforeEquipped);
    expect(
      normalizeAbilityState(before).grantOwnership.activeSourcesByAbilityId.has('fireball'),
    ).toBe(false);
  });

  it('rejects equipment sources with unsafe instance or effect ordinals', () => {
    expect(() =>
      equipmentAbilityGrantSourceId(
        'gei:v1:run:9007199254740992' as Parameters<typeof equipmentAbilityGrantSourceId>[0],
        0,
      ),
    ).toThrow(/invalid generated equipment instance id/i);
    expect(() => equipmentAbilityGrantSourceId('gei:v1:run:0', 9_007_199_254_740_992)).toThrow(
      /safe integer/i,
    );
    expect(isAbilityGrantSourceId('equipment:gei:v1:run:9007199254740992:0')).toBe(false);
    expect(isAbilityGrantSourceId('equipment:gei:v1:run:0:9007199254740992')).toBe(false);
    expect(isAbilityGrantSourceId('equipment:gei:v1:run:00:0')).toBe(false);
    expect(isAbilityGrantSourceId('equipment:gei:v1:run:0:00')).toBe(false);

    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    expect(() =>
      grantAbilitySources(world, player, [
        {
          kind: 'active',
          abilityId: 'fireball',
          sourceId: 'equipment:gei:v1:run:9007199254740992:0' as AbilityGrantSourceId,
        },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'invalid-source' }));
    expect(() =>
      normalizeAbilityState({
        learnedSpellIds: [],
        equippedActiveAbilityIds: [],
        passiveAbilityIds: [],
        cooldownByAbilityId: new Map(),
        cooldownFramesByAbilityId: new Map(),
        appliedPassiveAbilityIds: new Set(),
        grantOwnership: {
          schemaVersion: 'ability-grant-ownership/v1',
          activeSourcesByAbilityId: new Map([
            [
              'fireball',
              new Set(['equipment:gei:v1:run:9007199254740992:0' as AbilityGrantSourceId]),
            ],
          ]),
          passiveSourcesByAbilityId: new Map(),
        },
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid-source' }));
  });

  it('rejects skill sources with non-canonical or unsafe milestone levels', () => {
    expect(() => skillAbilityGrantSourceId('iron-skin', 9_007_199_254_740_992)).toThrow(
      /safe integer/i,
    );
    expect(isAbilityGrantSourceId('skill:iron-skin:01')).toBe(false);
    expect(isAbilityGrantSourceId('skill:iron-skin:9007199254740992')).toBe(false);
    expect(() =>
      normalizeAbilityState({
        learnedSpellIds: [],
        equippedActiveAbilityIds: [],
        passiveAbilityIds: [],
        cooldownByAbilityId: new Map(),
        cooldownFramesByAbilityId: new Map(),
        appliedPassiveAbilityIds: new Set(),
        grantOwnership: {
          schemaVersion: 'ability-grant-ownership/v1',
          activeSourcesByAbilityId: new Map(),
          passiveSourcesByAbilityId: new Map([
            ['veteran-instinct', new Set(['skill:iron-skin:01' as AbilityGrantSourceId])],
          ]),
        },
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid-source' }));
  });

  it('rejects learned/legacy sources whose embedded ability id mismatches the request', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);

    // A learned source names the ability it grants; it must not grant a different ability.
    try {
      grantAbilitySources(world, player, [
        {
          kind: 'active',
          abilityId: 'heal',
          sourceId: learnedAbilityGrantSourceId('fireball'),
        },
      ]);
      throw new Error('Expected mismatched learned source to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(AbilityGrantError);
      expect((error as AbilityGrantError).code).toBe('source-mismatch');
    }
    // Rejected batch must not create or mutate state.
    expect(world.abilityStatesByEntity.has(player)).toBe(false);

    // A matching learned source is accepted and reflected in learnedSpellIds.
    grantAbilitySources(world, player, [
      { kind: 'active', abilityId: 'heal', sourceId: learnedAbilityGrantSourceId('heal') },
    ]);
    expect(world.abilityStatesByEntity.get(player)!.learnedSpellIds).toContain('heal');
  });

  it('migrates plain ids once without guessing skill or equipment provenance', () => {
    const legacy: AbilityState = {
      learnedSpellIds: ['fireball'],
      equippedActiveAbilityIds: ['fireball', 'battle-focus'],
      passiveAbilityIds: ['veteran-instinct'],
      cooldownByAbilityId: new Map(),
      cooldownFramesByAbilityId: new Map(),
      appliedPassiveAbilityIds: new Set(),
    };

    const first = normalizeAbilityState(legacy);
    const second = normalizeAbilityState(first);
    expect(second).toEqual(first);
    expect(first.grantOwnership.activeSourcesByAbilityId.get('fireball')).toEqual(
      new Set(['learned:fireball']),
    );
    expect(first.grantOwnership.activeSourcesByAbilityId.get('battle-focus')).toEqual(
      new Set(['legacy:active:battle-focus']),
    );
    expect(first.grantOwnership.passiveSourcesByAbilityId.get('veteran-instinct')).toEqual(
      new Set(['legacy:passive:veteran-instinct']),
    );
  });

  it('round-trips retired persisted ids without mutating the source state', () => {
    const legacy: AbilityState = {
      learnedSpellIds: ['retired-spell'],
      equippedActiveAbilityIds: ['retired-spell'],
      passiveAbilityIds: ['retired-passive'],
      cooldownByAbilityId: new Map(),
      cooldownFramesByAbilityId: new Map(),
      appliedPassiveAbilityIds: new Set(),
    };

    const normalized = normalizeAbilityState(legacy);
    expect(normalized).not.toBe(legacy);
    expect(legacy).not.toHaveProperty('grantOwnership');
    expect(normalized.grantOwnership.activeSourcesByAbilityId.get('retired-spell')).toEqual(
      new Set(['learned:retired-spell']),
    );
    expect(normalized.grantOwnership.passiveSourcesByAbilityId.get('retired-passive')).toEqual(
      new Set(['legacy:passive:retired-passive']),
    );

    expect(normalized.learnedSpellIds).toEqual([]);
    expect(normalized.equippedActiveAbilityIds).toEqual([]);
    expect(normalized.passiveAbilityIds).toEqual([]);
    const resynchronized = normalizeAbilityState(normalized);
    expect(resynchronized.grantOwnership).toEqual(normalized.grantOwnership);
    expect(normalized.passiveAbilityIds).toEqual([]);
  });

  it('revokeAbilitySources removes persisted ownership for a retired (catalog-missing) ability', () => {
    // normalizeAbilityState preserves unknown IDs as inert ownership; the equipment
    // revoker must be able to clear them even after registry teardown.
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    const activeSrc = equipmentAbilityGrantSourceId('gei:v1:retire-test:0', 0);
    const passiveSrc = equipmentAbilityGrantSourceId('gei:v1:retire-test:0', 1);
    // Inject persisted ownership for retired abilities directly.
    world.abilityStatesByEntity.set(player, {
      learnedSpellIds: [],
      equippedActiveAbilityIds: [],
      ownedActiveAbilityIds: [],
      passiveAbilityIds: [],
      cooldownByAbilityId: new Map(),
      cooldownFramesByAbilityId: new Map(),
      appliedPassiveAbilityIds: new Set(),
      grantOwnership: {
        schemaVersion: 'ability-grant-ownership/v1',
        activeSourcesByAbilityId: new Map([['retired-active', new Set([activeSrc])]]),
        passiveSourcesByAbilityId: new Map([['retired-passive-old', new Set([passiveSrc])]]),
      },
    });

    // Revoking retired IDs must not throw 'unknown-ability'.
    expect(() =>
      revokeAbilitySources(world, player, [
        { kind: 'active', abilityId: 'retired-active', sourceId: activeSrc },
        { kind: 'passive', abilityId: 'retired-passive-old', sourceId: passiveSrc },
      ]),
    ).not.toThrow();

    const state = world.abilityStatesByEntity.get(player);
    expect(state?.grantOwnership?.activeSourcesByAbilityId.has('retired-active')).toBe(false);
    expect(state?.grantOwnership?.passiveSourcesByAbilityId.has('retired-passive-old')).toBe(false);
  });

  it('requires ownership for the strict active configuration primitive', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    expect(() => configureOwnedActiveAbility(world, player, 'fireball')).toThrowError(
      AbilityGrantError,
    );
  });

  it('rejects a persisted source that claims multiple active owners', () => {
    const source = equipmentAbilityGrantSourceId('gei:v1:conflict:0', 0);
    expect(() =>
      normalizeAbilityState({
        learnedSpellIds: [],
        equippedActiveAbilityIds: [],
        passiveAbilityIds: [],
        cooldownByAbilityId: new Map(),
        cooldownFramesByAbilityId: new Map(),
        appliedPassiveAbilityIds: new Set(),
        grantOwnership: {
          schemaVersion: 'ability-grant-ownership/v1',
          activeSourcesByAbilityId: new Map([
            ['fireball', new Set([source])],
            ['heal', new Set([source])],
          ]),
          passiveSourcesByAbilityId: new Map(),
        },
      }),
    ).toThrowError(expect.objectContaining({ code: 'source-conflict' }));
  });

  it('drops persisted ownership entries with empty source sets', () => {
    // A serialized snapshot with an empty Set must not be treated as owned —
    // syncDerivedAbilityLists would otherwise include that ability in equipped/learned lists.
    const normalized = normalizeAbilityState({
      learnedSpellIds: [],
      equippedActiveAbilityIds: ['fireball'],
      passiveAbilityIds: ['warded'],
      cooldownByAbilityId: new Map(),
      cooldownFramesByAbilityId: new Map(),
      appliedPassiveAbilityIds: new Set(),
      grantOwnership: {
        schemaVersion: 'ability-grant-ownership/v1',
        activeSourcesByAbilityId: new Map([['fireball', new Set<AbilityGrantSourceId>()]]),
        passiveSourcesByAbilityId: new Map([['warded', new Set<AbilityGrantSourceId>()]]),
      },
    });
    // Empty-source entries must be dropped — neither ability should be considered owned.
    expect(normalized.grantOwnership.activeSourcesByAbilityId.size).toBe(0);
    expect(normalized.grantOwnership.passiveSourcesByAbilityId.size).toBe(0);
    expect(normalized.equippedActiveAbilityIds).toEqual([]);
    expect(normalized.passiveAbilityIds).toEqual([]);
  });

  it('deduplicates and enforces ACTIVE_ABILITY_SLOT_LIMIT on persisted equippedActiveAbilityIds', () => {
    // A legacy/versioned snapshot may have duplicate or over-cap configured actives.
    const ownedActiveIds = [
      'fireball',
      'battle-focus',
      'heal',
      'pulse-shield',
      'magic-missile',
      'frost-nova',
      'bless',
      'stoneskin',
      'curse',
      'vampiric-touch',
      'haste',
    ] as const;
    const expectedConfigured = ownedActiveIds.slice(0, ACTIVE_ABILITY_SLOT_LIMIT);
    const overCap: AbilityState = {
      learnedSpellIds: [...ownedActiveIds],
      // 12 entries: one duplicate and one over the 10-slot cap.
      equippedActiveAbilityIds: [
        'fireball',
        'fireball',
        'battle-focus',
        'heal',
        'pulse-shield',
        'magic-missile',
        'frost-nova',
        'bless',
        'stoneskin',
        'curse',
        'vampiric-touch',
        'haste',
      ],
      passiveAbilityIds: [],
      ownedActiveAbilityIds: [],
      cooldownByAbilityId: new Map(),
      cooldownFramesByAbilityId: new Map(),
      appliedPassiveAbilityIds: new Set(),
      grantOwnership: {
        schemaVersion: 'ability-grant-ownership/v1',
        activeSourcesByAbilityId: new Map(
          ownedActiveIds.map((abilityId) => [
            abilityId,
            new Set<AbilityGrantSourceId>([learnedAbilityGrantSourceId(abilityId)]),
          ]),
        ),
        passiveSourcesByAbilityId: new Map(),
      },
    };
    const normalized = normalizeAbilityState(overCap);
    expect(normalized.equippedActiveAbilityIds).toEqual(expectedConfigured);
  });
});
