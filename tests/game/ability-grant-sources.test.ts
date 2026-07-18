/**
 * Tests for C2: source-owned ability grant tracking.
 *
 * Covers:
 * - Grant source recording for learned, skill, and equipment sources
 * - Isolation: removing one equipment source never removes another source
 * - Multiple equipment sources for the same ability
 * - Revoke is idempotent
 * - Active slot-cap still enforced with source tracking
 * - Backward-compat migration (abilities without source entries)
 * - Playercarryover snapshot round-trip preserves source maps
 */
import { addComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { SkillHolder } from '../../src/core/components.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { initializeBaseStats } from '../../src/core/systems/equipmentSystem.js';
import { statSystem } from '../../src/core/systems/statSystem.js';
import { makeWalledMap } from '../helpers/map-fixtures.js';
import {
  abilitySystem,
  createAbilityState,
  equipActiveAbility,
  getOrCreateAbilityState,
  grantEquipmentActiveAbility,
  grantEquipmentPassiveAbility,
  grantPassiveAbility,
  memorizeSpell,
  migrateAbilityStateToSourceTracking,
  revokeEquipmentAbilityGrants,
  unequipActiveAbility,
} from '../../src/game/systems/abilitySystem.js';
import { ACTIVE_ABILITY_SLOT_LIMIT } from '../../src/game/abilities/types.js';
import { capturePlayerCarryover, restorePlayerCarryover } from '../../src/game/playerCarryover.js';
import { createTestWorld } from '../helpers/world-factory.js';

function setupPlayer() {
  const world = createTestWorld();
  makeWalledMap(world, 10, 10);
  const player = spawnPlayer(world, 0, 0);
  initializeBaseStats(world, player);
  addComponent(world.ecs, player, SkillHolder);
  statSystem(world);
  getOrCreateAbilityState(world, player);
  return { world, player };
}

// ─── createAbilityState ───────────────────────────────────────────────────────

describe('createAbilityState', () => {
  it('initializes empty grant-source maps', () => {
    const state = createAbilityState();
    expect(state.activeAbilityGrantSources.size).toBe(0);
    expect(state.passiveAbilityGrantSources.size).toBe(0);
  });
});

// ─── Source recording on grant ─────────────────────────────────────────────

describe('source recording', () => {
  it('equipActiveAbility records learned source by default', () => {
    const { world, player } = setupPlayer();
    equipActiveAbility(world, player, 'battle-focus');
    const state = world.abilityStatesByEntity.get(player)!;
    expect(state.activeAbilityGrantSources.get('battle-focus')).toEqual([{ kind: 'learned' }]);
  });

  it('equipActiveAbility records explicit source', () => {
    const { world, player } = setupPlayer();
    equipActiveAbility(world, player, 'battle-focus', { kind: 'skill', skillId: 'swordsmanship' });
    const state = world.abilityStatesByEntity.get(player)!;
    expect(state.activeAbilityGrantSources.get('battle-focus')).toEqual([
      { kind: 'skill', skillId: 'swordsmanship' },
    ]);
  });

  it('grantPassiveAbility records learned source by default', () => {
    const { world, player } = setupPlayer();
    grantPassiveAbility(world, player, 'veteran-instinct');
    const state = world.abilityStatesByEntity.get(player)!;
    expect(state.passiveAbilityGrantSources.get('veteran-instinct')).toEqual([{ kind: 'learned' }]);
  });

  it('grantPassiveAbility records skill source', () => {
    const { world, player } = setupPlayer();
    grantPassiveAbility(world, player, 'veteran-instinct', {
      kind: 'skill',
      skillId: 'iron-skin',
    });
    const state = world.abilityStatesByEntity.get(player)!;
    expect(state.passiveAbilityGrantSources.get('veteran-instinct')).toEqual([
      { kind: 'skill', skillId: 'iron-skin' },
    ]);
  });

  it('memorizeSpell records learned source', () => {
    const { world, player } = setupPlayer();
    memorizeSpell(world, player, 'fireball');
    const state = world.abilityStatesByEntity.get(player)!;
    expect(state.activeAbilityGrantSources.get('fireball')).toEqual([{ kind: 'learned' }]);
  });

  it('grantEquipmentActiveAbility records equipment source with static id', () => {
    const { world, player } = setupPlayer();
    grantEquipmentActiveAbility(world, player, 'battle-focus', 42);
    const state = world.abilityStatesByEntity.get(player)!;
    expect(state.activeAbilityGrantSources.get('battle-focus')).toEqual([
      { kind: 'equipment', instanceId: 42 },
    ]);
  });

  it('grantEquipmentPassiveAbility records equipment source with generated id', () => {
    const { world, player } = setupPlayer();
    const genId = 'gei:v1:run1:1' as const;
    grantEquipmentPassiveAbility(world, player, 'veteran-instinct', genId);
    const state = world.abilityStatesByEntity.get(player)!;
    expect(state.passiveAbilityGrantSources.get('veteran-instinct')).toEqual([
      { kind: 'equipment', instanceId: genId },
    ]);
  });
});

// ─── Multiple sources for the same ability ────────────────────────────────

describe('multiple sources per ability', () => {
  it('duplicate grant from same source still records two source entries', () => {
    const { world, player } = setupPlayer();
    grantEquipmentPassiveAbility(world, player, 'veteran-instinct', 1);
    grantEquipmentPassiveAbility(world, player, 'veteran-instinct', 1);
    const state = world.abilityStatesByEntity.get(player)!;
    // Only one copy in the passive list
    expect(state.passiveAbilityIds.filter((id) => id === 'veteran-instinct')).toHaveLength(1);
    // But both source records exist
    expect(state.passiveAbilityGrantSources.get('veteran-instinct')).toHaveLength(2);
  });

  it('ability with equipment + skill sources keeps both', () => {
    const { world, player } = setupPlayer();
    grantEquipmentPassiveAbility(world, player, 'veteran-instinct', 7);
    grantPassiveAbility(world, player, 'veteran-instinct', { kind: 'skill', skillId: 'iron-skin' });
    const state = world.abilityStatesByEntity.get(player)!;
    expect(state.passiveAbilityIds).toContain('veteran-instinct');
    const sources = state.passiveAbilityGrantSources.get('veteran-instinct')!;
    expect(sources).toHaveLength(2);
    expect(sources.some((s) => s.kind === 'equipment')).toBe(true);
    expect(sources.some((s) => s.kind === 'skill')).toBe(true);
  });

  it('active ability with two equipment sources accumulates both', () => {
    const { world, player } = setupPlayer();
    grantEquipmentActiveAbility(world, player, 'battle-focus', 1);
    grantEquipmentActiveAbility(world, player, 'battle-focus', 2);
    const state = world.abilityStatesByEntity.get(player)!;
    expect(state.equippedActiveAbilityIds.filter((id) => id === 'battle-focus')).toHaveLength(1);
    expect(state.activeAbilityGrantSources.get('battle-focus')).toHaveLength(2);
  });
});

// ─── revokeEquipmentAbilityGrants isolation ──────────────────────────────

describe('revokeEquipmentAbilityGrants', () => {
  it('removing one equipment source with remaining skill source keeps ability', () => {
    const { world, player } = setupPlayer();
    grantEquipmentPassiveAbility(world, player, 'veteran-instinct', 5);
    grantPassiveAbility(world, player, 'veteran-instinct', { kind: 'skill', skillId: 'iron-skin' });

    revokeEquipmentAbilityGrants(world, player, 5);

    const state = world.abilityStatesByEntity.get(player)!;
    expect(state.passiveAbilityIds).toContain('veteran-instinct');
    const sources = state.passiveAbilityGrantSources.get('veteran-instinct')!;
    expect(sources).toHaveLength(1);
    expect(sources[0]).toEqual({ kind: 'skill', skillId: 'iron-skin' });
  });

  it('removing equipment source with learned source keeps ability', () => {
    const { world, player } = setupPlayer();
    grantEquipmentPassiveAbility(world, player, 'veteran-instinct', 5);
    grantPassiveAbility(world, player, 'veteran-instinct', { kind: 'learned' });

    revokeEquipmentAbilityGrants(world, player, 5);

    const state = world.abilityStatesByEntity.get(player)!;
    expect(state.passiveAbilityIds).toContain('veteran-instinct');
  });

  it('removing the only equipment source removes the passive ability', () => {
    const { world, player } = setupPlayer();
    grantEquipmentPassiveAbility(world, player, 'veteran-instinct', 5);

    revokeEquipmentAbilityGrants(world, player, 5);

    const state = world.abilityStatesByEntity.get(player)!;
    expect(state.passiveAbilityIds).not.toContain('veteran-instinct');
    expect(state.passiveAbilityGrantSources.has('veteran-instinct')).toBe(false);
  });

  it('removing one equipment source from two equipment sources leaves one', () => {
    const { world, player } = setupPlayer();
    grantEquipmentPassiveAbility(world, player, 'veteran-instinct', 3);
    grantEquipmentPassiveAbility(world, player, 'veteran-instinct', 4);

    revokeEquipmentAbilityGrants(world, player, 3);

    const state = world.abilityStatesByEntity.get(player)!;
    expect(state.passiveAbilityIds).toContain('veteran-instinct');
    const sources = state.passiveAbilityGrantSources.get('veteran-instinct')!;
    expect(sources).toHaveLength(1);
    expect(sources[0]).toEqual({ kind: 'equipment', instanceId: 4 });
  });

  it('does not remove active ability until all equipment sources are revoked', () => {
    const { world, player } = setupPlayer();
    grantEquipmentActiveAbility(world, player, 'battle-focus', 10);
    grantEquipmentActiveAbility(world, player, 'battle-focus', 11);

    revokeEquipmentAbilityGrants(world, player, 10);
    expect(world.abilityStatesByEntity.get(player)!.equippedActiveAbilityIds).toContain(
      'battle-focus',
    );

    revokeEquipmentAbilityGrants(world, player, 11);
    expect(world.abilityStatesByEntity.get(player)!.equippedActiveAbilityIds).not.toContain(
      'battle-focus',
    );
  });

  it('is idempotent — revoking a non-existent equipment source is a no-op', () => {
    const { world, player } = setupPlayer();
    grantPassiveAbility(world, player, 'veteran-instinct');
    const before = [...world.abilityStatesByEntity.get(player)!.passiveAbilityIds];

    revokeEquipmentAbilityGrants(world, player, 999);

    expect(world.abilityStatesByEntity.get(player)!.passiveAbilityIds).toEqual(before);
  });

  it('is a no-op when entity has no ability state', () => {
    const { world } = setupPlayer();
    // No ability state on entity 9999.
    expect(() => revokeEquipmentAbilityGrants(world, 9999, 1)).not.toThrow();
  });

  it('revokes applied passive stat modifiers when the last source is removed', () => {
    const { world, player } = setupPlayer();
    grantEquipmentPassiveAbility(world, player, 'veteran-instinct', 5);
    abilitySystem(world); // apply the passive

    const state = world.abilityStatesByEntity.get(player)!;
    expect(state.appliedPassiveAbilityIds.has('veteran-instinct')).toBe(true);
    const beforeLen = world.statModifiers.length;

    revokeEquipmentAbilityGrants(world, player, 5);

    expect(state.appliedPassiveAbilityIds.has('veteran-instinct')).toBe(false);
    // The two stat modifiers for veteran-instinct should have been removed.
    expect(world.statModifiers.length).toBeLessThan(beforeLen);
  });

  it('does NOT revoke applied stat modifiers when another source remains', () => {
    const { world, player } = setupPlayer();
    grantEquipmentPassiveAbility(world, player, 'veteran-instinct', 5);
    grantPassiveAbility(world, player, 'veteran-instinct', { kind: 'learned' });
    abilitySystem(world);

    const beforeLen = world.statModifiers.length;
    revokeEquipmentAbilityGrants(world, player, 5);

    // Passive still active, modifiers untouched.
    expect(
      world.abilityStatesByEntity.get(player)!.appliedPassiveAbilityIds.has('veteran-instinct'),
    ).toBe(true);
    expect(world.statModifiers.length).toBe(beforeLen);
  });

  it('leaves other equipment sources untouched when revoking instance A', () => {
    const { world, player } = setupPlayer();
    grantEquipmentPassiveAbility(world, player, 'veteran-instinct', 1);
    grantEquipmentPassiveAbility(world, player, 'combat-flow', 2);

    revokeEquipmentAbilityGrants(world, player, 1);

    const state = world.abilityStatesByEntity.get(player)!;
    expect(state.passiveAbilityIds).not.toContain('veteran-instinct');
    expect(state.passiveAbilityIds).toContain('combat-flow');
    expect(state.passiveAbilityGrantSources.get('combat-flow')).toEqual([
      { kind: 'equipment', instanceId: 2 },
    ]);
  });

  it('works with generated equipment instance ids (string)', () => {
    const { world, player } = setupPlayer();
    const genId = 'gei:v1:run1:5' as const;
    grantEquipmentPassiveAbility(world, player, 'veteran-instinct', genId);
    revokeEquipmentAbilityGrants(world, player, genId);

    const state = world.abilityStatesByEntity.get(player)!;
    expect(state.passiveAbilityIds).not.toContain('veteran-instinct');
  });
});

// ─── Active-slot-cap still enforced ──────────────────────────────────────

describe('slot cap', () => {
  it('slot cap applies even for equipment grants', () => {
    const { world, player } = setupPlayer();
    const state = getOrCreateAbilityState(world, player);
    // Fill up to cap with fake ids (bypass ability registry check)
    state.equippedActiveAbilityIds = Array.from({ length: ACTIVE_ABILITY_SLOT_LIMIT }, (_, i) =>
      i < ACTIVE_ABILITY_SLOT_LIMIT - 1 ? `ability-${i}` : 'battle-focus',
    );
    expect(() => grantEquipmentActiveAbility(world, player, 'fireball', 1)).toThrow(/slot cap/i);
  });

  it('slot cap not exceeded by duplicate equipment grant for same ability', () => {
    const { world, player } = setupPlayer();
    const state = getOrCreateAbilityState(world, player);
    state.equippedActiveAbilityIds = Array.from({ length: ACTIVE_ABILITY_SLOT_LIMIT }, (_, i) =>
      i === 0 ? 'battle-focus' : `ability-${i}`,
    );
    state.activeAbilityGrantSources.set('battle-focus', [{ kind: 'equipment', instanceId: 1 }]);

    // Second grant of the already-equipped ability should NOT throw.
    expect(() => grantEquipmentActiveAbility(world, player, 'battle-focus', 2)).not.toThrow();
    // Source list grows to 2.
    expect(state.activeAbilityGrantSources.get('battle-focus')).toHaveLength(2);
  });
});

// ─── unequipActiveAbility clears grant sources ────────────────────────────

describe('unequipActiveAbility', () => {
  it('clears the grant-source entry when an ability is force-unequipped', () => {
    const { world, player } = setupPlayer();
    grantEquipmentActiveAbility(world, player, 'battle-focus', 1);
    unequipActiveAbility(world, player, 'battle-focus');

    const state = world.abilityStatesByEntity.get(player)!;
    expect(state.equippedActiveAbilityIds).not.toContain('battle-focus');
    expect(state.activeAbilityGrantSources.has('battle-focus')).toBe(false);
  });
});

// ─── Backward-compat migration ────────────────────────────────────────────

describe('migrateAbilityStateToSourceTracking', () => {
  it('back-fills learned source for abilities without grant-source entries', () => {
    const state = createAbilityState();
    // Simulate pre-C2 state: abilities in lists, no source maps.
    state.equippedActiveAbilityIds.push('battle-focus');
    state.passiveAbilityIds.push('veteran-instinct');
    // Source maps are empty (as they would be in an old snapshot).

    migrateAbilityStateToSourceTracking(state);

    expect(state.activeAbilityGrantSources.get('battle-focus')).toEqual([{ kind: 'learned' }]);
    expect(state.passiveAbilityGrantSources.get('veteran-instinct')).toEqual([{ kind: 'learned' }]);
  });

  it('does not overwrite existing entries', () => {
    const state = createAbilityState();
    state.equippedActiveAbilityIds.push('battle-focus');
    state.activeAbilityGrantSources.set('battle-focus', [
      { kind: 'skill', skillId: 'swordsmanship' },
    ]);

    migrateAbilityStateToSourceTracking(state);

    // Still the skill source, not overwritten with learned.
    expect(state.activeAbilityGrantSources.get('battle-focus')).toEqual([
      { kind: 'skill', skillId: 'swordsmanship' },
    ]);
  });

  it('is idempotent', () => {
    const state = createAbilityState();
    state.passiveAbilityIds.push('veteran-instinct');

    migrateAbilityStateToSourceTracking(state);
    migrateAbilityStateToSourceTracking(state);

    expect(state.passiveAbilityGrantSources.get('veteran-instinct')).toHaveLength(1);
  });
});

// ─── Playercarryover snapshot round-trip ─────────────────────────────────

describe('playerCarryover snapshot round-trip', () => {
  it('strips equipment sources from ability grants during carryover (stale instanceId prevention)', () => {
    const { world: source, player: sourcePlayer } = setupPlayer();
    // Grant veteran-instinct from both equipment and skill.
    grantEquipmentPassiveAbility(source, sourcePlayer, 'veteran-instinct', 7);
    grantPassiveAbility(source, sourcePlayer, 'veteran-instinct', {
      kind: 'skill',
      skillId: 'iron-skin',
    });
    memorizeSpell(source, sourcePlayer, 'fireball');

    const snapshot = capturePlayerCarryover(source, sourcePlayer);

    const { world: dest, player: destPlayer } = setupPlayer();
    restorePlayerCarryover(dest, destPlayer, snapshot);

    const state = dest.abilityStatesByEntity.get(destPlayer)!;
    // Mixed-source ability (equipment + skill) survives with non-equipment sources only.
    expect(state.passiveAbilityIds).toContain('veteran-instinct');
    const passiveSources = state.passiveAbilityGrantSources.get('veteran-instinct')!;
    expect(passiveSources.some((s) => s.kind === 'equipment')).toBe(false);
    expect(passiveSources.some((s) => s.kind === 'skill' && s.skillId === 'iron-skin')).toBe(true);
    // Learned spell survives intact.
    expect(state.activeAbilityGrantSources.get('fireball')).toEqual([{ kind: 'learned' }]);
  });

  it('drops equipment-only granted abilities from carryover snapshot', () => {
    const { world: source, player: sourcePlayer } = setupPlayer();
    // Grant an active ability ONLY via equipment (no learned/skill source).
    grantEquipmentActiveAbility(source, sourcePlayer, 'battle-focus', 42);

    const snapshot = capturePlayerCarryover(source, sourcePlayer);

    const { world: dest, player: destPlayer } = setupPlayer();
    restorePlayerCarryover(dest, destPlayer, snapshot);

    const state = dest.abilityStatesByEntity.get(destPlayer)!;
    // Equipment-only ability should NOT survive carryover; it must be re-granted
    // when the equipment is re-equipped on the new floor.
    expect(state.equippedActiveAbilityIds).not.toContain('battle-focus');
    expect(state.activeAbilityGrantSources.has('battle-focus')).toBe(false);
  });

  it('restores from old snapshot without grant-source fields using migration', () => {
    const { world: source, player: sourcePlayer } = setupPlayer();
    memorizeSpell(source, sourcePlayer, 'fireball');
    grantPassiveAbility(source, sourcePlayer, 'veteran-instinct');

    const snapshot = capturePlayerCarryover(source, sourcePlayer);
    // Simulate an old snapshot by stripping the new fields.
    const oldSnapshot = {
      ...snapshot,
      abilityState: snapshot.abilityState
        ? {
            ...snapshot.abilityState,
            activeAbilityGrantSources: undefined,
            passiveAbilityGrantSources: undefined,
          }
        : undefined,
    };

    const { world: dest, player: destPlayer } = setupPlayer();
    restorePlayerCarryover(
      dest,
      destPlayer,
      oldSnapshot as Parameters<typeof restorePlayerCarryover>[2],
    );

    const state = dest.abilityStatesByEntity.get(destPlayer)!;
    // Migration should have back-filled learned sources.
    expect(state.activeAbilityGrantSources.get('fireball')).toEqual([{ kind: 'learned' }]);
    expect(state.passiveAbilityGrantSources.get('veteran-instinct')).toEqual([{ kind: 'learned' }]);
  });
});
