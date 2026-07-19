import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import {
  abilitySystem,
  AbilityGrantError,
  configureOwnedActiveAbility,
  equipActiveAbility,
  getOrCreateAbilityState,
  grantAbilitySources,
  normalizeAbilityState,
  revokeAbilitySources,
} from '../../src/game/systems/abilitySystem.js';
import {
  equipmentAbilityGrantSourceId,
  learnedAbilityGrantSourceId,
  skillAbilityGrantSourceId,
  type AbilityGrantSourceId,
  type AbilityState,
} from '../../src/shared/abilities.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('source-owned ability grants', () => {
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

    revokeAbilitySources(world, player, [equipment]);
    let state = getOrCreateAbilityState(world, player);
    expect(state.grantOwnership.activeSourcesByAbilityId.get('fireball')).toEqual(
      new Set([learned]),
    );
    expect(state.equippedActiveAbilityIds).toEqual(['fireball']);

    revokeAbilitySources(world, player, [learned]);
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

    revokeAbilitySources(world, player, [requests[1].sourceId]);
    expect(getOrCreateAbilityState(world, player).passiveAbilityIds).toEqual(['veteran-instinct']);
    expect(
      world.statModifiers.filter((modifier) =>
        modifier.sourceId.startsWith('veteran-instinct:passive'),
      ),
    ).toHaveLength(2);

    revokeAbilitySources(world, player, [requests[0].sourceId]);
    expect(getOrCreateAbilityState(world, player).passiveAbilityIds).toEqual([]);
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
    try {
      grantAbilitySources(world, player, [
        {
          kind: 'active',
          abilityId: 'fireball',
          sourceId: validSource,
        },
        {
          kind: 'active',
          abilityId: 'heal',
          sourceId: validSource,
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

  it('migrates plain ids once without guessing skill or equipment provenance', () => {
    const legacy: AbilityState = {
      learnedSpellIds: ['fireball'],
      equippedActiveAbilityIds: ['fireball', 'battle-focus'],
      passiveAbilityIds: ['veteran-instinct'],
      cooldownByAbilityId: new Map(),
      cooldownFramesByAbilityId: new Map(),
      appliedPassiveAbilityIds: new Set(),
      activeAbilityGrantSources: new Map(),
      passiveAbilityGrantSources: new Map(),
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
      activeAbilityGrantSources: new Map(),
      passiveAbilityGrantSources: new Map(),
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
        activeAbilityGrantSources: new Map(),
        passiveAbilityGrantSources: new Map(),
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
});
