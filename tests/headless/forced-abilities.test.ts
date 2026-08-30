import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Player, type GameWorld } from '../../src/core/index.js';
import { forceActivateAbility } from '../../src/game/index.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { AIState, type AIDecision, type AIInputProvider } from '../../src/game/ai/types.js';
import type { InputState } from '../../src/shared/input.js';

class IdleProvider implements AIInputProvider {
  poll(_state: InputState, _world: GameWorld): void {}

  getDecision(): AIDecision {
    return {
      state: AIState.EXPLORE,
      targetEid: null,
      targetX: null,
      targetY: null,
      reason: 'forced ability test',
      npcInteraction: null,
      debug: null,
    };
  }

  reset(): void {}
}

function playerEid(world: GameWorld): number {
  const player = query(world.ecs, [Player])[0];
  if (player === undefined) throw new Error('Expected a player');
  return player;
}

const baseConfig = {
  seed: 42,
  maxWallTimeMs: 30_000,
  forceWeaponId: 'sword',
  optionalPurchases: false,
} as const;

describe('headless runner forced abilities', () => {
  it('grants, orders, unlocks, and applies forced abilities before frame 0', async () => {
    let baselineArmor = 0;
    let baselinePickupRange = 0;
    await runHeadless(new IdleProvider(), {
      ...baseConfig,
      maxFrames: 0,
      onFinish: (world) => {
        const player = playerEid(world);
        baselineArmor = world.stores.effectiveStats.armor[player] ?? 0;
        baselinePickupRange = world.stores.effectiveStats.pickupRange[player] ?? 0;
      },
    });

    let inspected = false;
    const stats = await runHeadless(new IdleProvider(), {
      ...baseConfig,
      maxFrames: 0,
      forceAbilityIds: ['fireball', 'battle-focus', 'veteran-instinct', 'fireball'],
      onFinish: (world) => {
        const player = playerEid(world);
        const state = world.abilityStatesByEntity.get(player);
        expect(state?.equippedActiveAbilityIds.slice(0, 2)).toEqual(['fireball', 'battle-focus']);
        expect(state?.learnedSpellIds).toContain('fireball');
        expect(state?.passiveAbilityIds).toContain('veteran-instinct');
        expect(state?.grantOwnership?.activeSourcesByAbilityId.get('fireball')).toContain(
          'learned:fireball',
        );
        expect(state?.grantOwnership?.passiveSourcesByAbilityId.get('veteran-instinct')).toContain(
          'learned:veteran-instinct',
        );
        expect(world.featureUnlocks.spells).toBe(true);
        expect(world.stores.effectiveStats.armor[player]).toBe(baselineArmor + 2);
        expect(world.stores.effectiveStats.pickupRange[player]).toBe(baselinePickupRange + 0.75);
        inspected = true;
      },
    });

    expect(inspected).toBe(true);
    expect(stats.abilityTelemetry).toEqual({
      forcedAbilityIds: ['fireball', 'battle-focus', 'veteran-instinct'],
      totalActivations: 0,
      activationsByAbilityId: {
        fireball: 0,
        'battle-focus': 0,
        'veteran-instinct': 0,
      },
    });
  });

  it('fires forced active and spell abilities through an injected real-pipeline system', async () => {
    const fired: boolean[] = [];
    const stats = await runHeadless(new IdleProvider(), {
      ...baseConfig,
      maxFrames: 1,
      forceAbilityIds: ['battle-focus', 'fireball'],
      simulationOptions: {
        postSystems: [
          (world) => {
            if (world.frameCount === 1) {
              const player = playerEid(world);
              fired.push(
                forceActivateAbility(world, player, 'battle-focus'),
                forceActivateAbility(world, player, 'fireball'),
              );
            }
          },
        ],
      },
    });

    expect(fired).toEqual([true, true]);
    expect(stats.abilityTelemetry).toEqual({
      forcedAbilityIds: ['battle-focus', 'fireball'],
      totalActivations: 2,
      activationsByAbilityId: { 'battle-focus': 1, fireball: 1 },
    });
  });

  it('retains forced-ability telemetry in crash stats', async () => {
    const stats = await runHeadless(new IdleProvider(), {
      ...baseConfig,
      maxFrames: 1,
      forceAbilityIds: ['fireball'],
      simulationOptions: {
        postSystems: [
          (world) => {
            forceActivateAbility(world, playerEid(world), 'fireball');
            throw new Error('injected crash');
          },
        ],
      },
    });

    expect(stats.outcome).toBe('error');
    expect(stats.error).toBe('injected crash');
    expect(stats.abilityTelemetry).toEqual({
      forcedAbilityIds: ['fireball'],
      totalActivations: 1,
      activationsByAbilityId: { fireball: 1 },
    });
  });

  it('rejects invalid IDs, weapon mismatches, and active-slot overflow before mutation', async () => {
    await expect(
      runHeadless(new IdleProvider(), {
        ...baseConfig,
        maxFrames: 0,
        forceAbilityIds: ['not-an-ability'],
      }),
    ).rejects.toThrow('Unknown forced ability id "not-an-ability"');

    await expect(
      runHeadless(new IdleProvider(), {
        ...baseConfig,
        maxFrames: 0,
        forceWeaponId: 'bow',
        forceAbilityIds: ['keen-swordsman'],
      }),
    ).rejects.toThrow(/requires weapon skill "sword".*selected weapon "bow"/);

    await expect(
      runHeadless(new IdleProvider(), {
        ...baseConfig,
        maxFrames: 0,
        forceAbilityIds: [
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
          'haste',
        ],
      }),
    ).rejects.toThrow(/exceeds active ability slot limit 10/);
  });
});
