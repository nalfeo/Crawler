import { describe, expect, it } from 'vitest';
import { addComponent, hasComponent, set } from 'bitecs';
import { createTestWorld } from '../helpers/world-factory.js';
import { GAME } from '../../src/shared/constants.js';
import {
  spawnPlayer,
  spawnBehaviorEnemy,
  setEnemyAppearanceKey,
} from '../../src/core/spawners/combatants.js';
import { EffectiveStats, Invincible, Knockback } from '../../src/core/components.js';
import { applyDamage } from '../../src/core/apply-damage.js';
import { getStatusEffects } from '../../src/core/status-effects.js';
import { statusEffectSystem } from '../../src/core/systems/statusEffectSystem.js';
import { knockbackSystem } from '../../src/core/systems/knockbackSystem.js';
import {
  createOmertaHonkDefinition,
  createShellCompanyLockdownDefinition,
} from '../../src/core/mob-abilities/floor2-utility-abilities.js';
import {
  activateMobAbilityEncounter,
  clearMobAbility,
  mobAbilitySystem,
  registerMobAbility,
  setMobAbilitiesEnabled,
} from '../../src/core/mob-abilities/runtime.js';
import type { MobAbilityRuntimeDefinition } from '../../src/core/mob-abilities/types.js';

function setup(definition: MobAbilityRuntimeDefinition) {
  const world = createTestWorld({ floor: 2 });
  const player = spawnPlayer(world, 50, 40);
  world.stores.health.current[player] = 1000;
  world.stores.health.max[player] = 1000;
  const boss = spawnBehaviorEnemy(world, 40, 40, 1000, 0, 0, 0, 0);
  setEnemyAppearanceKey(world, boss, definition.bossArchetypeKey);
  registerMobAbility(world, boss, definition);
  setMobAbilitiesEnabled(world, true);
  activateMobAbilityEncounter(world);
  return { world, player, boss };
}
function advance(world: ReturnType<typeof createTestWorld>, ms: number) {
  for (let i = 0; i < Math.round(ms / GAME.DELTA_MS); i++) {
    world.frameCount++;
    world.elapsedMs += GAME.DELTA_MS;
    statusEffectSystem(world);
    mobAbilitySystem(world);
  }
}
const playerDamage = {
  origin: 'player',
  affinity: 'physical',
  scaleWithPrimary: false,
  canCrit: false,
} as const;

describe('Floor 2 defensive shell and Omerta Honk', () => {
  it('Molt waits for its warning then reduces damage 70% and prevents knockback for exactly 3.5s', () => {
    const definition = createShellCompanyLockdownDefinition();
    const { world, boss } = setup(definition);
    advance(world, 11000);
    expect(world.mobAbilities.cues[0]?.phase).toBe('telegraph');
    expect(world.mobAbilities.activeBuffsByEntity.size).toBe(0);
    advance(world, 1200);
    expect(applyDamage(world, boss, 100, 40, 40, playerDamage)).toBeCloseTo(30);
    addComponent(world.ecs, boss, set(Knockback, { dirX: 1, dirY: 0, remaining: 6, speed: 0.6 }));
    knockbackSystem(world);
    expect(world.stores.position.x[boss]).toBe(40);
    const remaining = world.mobAbilities.activeBuffsByEntity.get(boss)!.remainingMs;
    definition.resolve(world, {
      abilityId: definition.abilityId,
      casterEid: boss,
      targetEid: null,
      sourceId: `mob-ability:${definition.abilityId}:${boss}`,
      geometry: { kind: 'circle', x: 40, y: 40, radiusFt: 8 },
    });
    expect(world.mobAbilities.activeBuffsByEntity.get(boss)!.remainingMs).toBe(remaining);
    advance(world, 3500);
    expect(world.mobAbilities.activeBuffsByEntity.size).toBe(0);
    expect(applyDamage(world, boss, 100, 40, 40, playerDamage)).toBe(100);
  });
  it('Honk locks a cone, damages and knocks back only victims inside, and Rattled reduces actual outgoing damage', () => {
    const { world, player, boss } = setup(createOmertaHonkDefinition());
    advance(world, 9000);
    const cue = world.mobAbilities.cues[0]!;
    expect(cue.geometry.kind).toBe('cone');
    expect(world.stores.health.current[player]).toBe(1000);
    advance(world, 1500);
    expect(world.stores.health.current[player]).toBe(980);
    expect(hasComponent(world.ecs, player, Knockback)).toBe(true);
    knockbackSystem(world);
    expect(world.stores.position.x[player]).toBeGreaterThan(50);
    expect(getStatusEffects(world, player)[0]?.value).toBe(0.8);
    expect(applyDamage(world, boss, 100, 40, 40, playerDamage)).toBe(80);
    advance(world, 3000);
    expect(applyDamage(world, boss, 100, 40, 40, playerDamage)).toBe(100);
  });
  it('leaves the committed direction fixed so moving behind Honkrado completely evades', () => {
    const { world, player } = setup(createOmertaHonkDefinition());
    advance(world, 9000);
    world.stores.position.x[player] = 30;
    advance(world, 1500);
    expect(world.stores.health.current[player]).toBe(1000);
    expect(getStatusEffects(world, player)).toHaveLength(0);
    expect(hasComponent(world.ecs, player, Knockback)).toBe(false);
  });
  it.each(['invincibility', 'guaranteed dodge'])(
    'a Honk negated by %s applies neither knockback nor Rattled',
    (defense) => {
      const { world, player } = setup(createOmertaHonkDefinition());
      if (defense === 'invincibility') addComponent(world.ecs, player, Invincible);
      else {
        addComponent(world.ecs, player, EffectiveStats);
        world.stores.effectiveStats.dodgeChance[player] = 1;
      }
      advance(world, 10500);
      expect(world.stores.health.current[player]).toBe(1000);
      expect(getStatusEffects(world, player)).toHaveLength(0);
      expect(hasComponent(world.ecs, player, Knockback)).toBe(false);
      if (defense === 'guaranteed dodge')
        expect(world.combatEvents.some((event) => event.type === 'dodge')).toBe(true);
    },
  );
  it('caster-local teardown removes Rattled, and lethal hits never apply it', () => {
    const { world, player, boss } = setup(createOmertaHonkDefinition());
    advance(world, 10500);
    clearMobAbility(world, boss);
    expect(getStatusEffects(world, player)).toHaveLength(0);
    const lethal = setup(createOmertaHonkDefinition());
    lethal.world.stores.health.current[lethal.player] = 10;
    advance(lethal.world, 10500);
    expect(getStatusEffects(lethal.world, lethal.player)).toHaveLength(0);
  });
});
