import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { getPersonaConfig } from '../../src/game/ai/personas.js';
import { getActiveWeaponDef } from '../../src/core/active-weapon.js';
import { getEquipmentState } from '../../src/core/systems/equipmentSystem.js';
import type { GameWorld } from '../../src/core/world.js';
import { getFloor4ArenaRunStats } from '../../src/game/floor4Scenario.js';

const SEED = 404;
const MAX_FRAMES = 60_000;

interface PurchaseObservation {
  readonly weaponId: string | null;
  readonly mainHand: string | number | null;
  readonly baseDamage: number | null;
  readonly cooldownMs: number | null;
  readonly sawAct2: boolean;
}

async function runPurchaseBranch(purchase: boolean) {
  let observation: PurchaseObservation | undefined;
  const stats = await runHeadless(
    new BehaviorTreeAI({ ...getPersonaConfig('experienced_player'), seed: SEED }),
    {
      seed: SEED,
      floorId: 'floor4',
      maxFrames: MAX_FRAMES,
      maxWallTimeMs: 180_000,
      playerPersona: 'experienced_player',
      floor4GreenRoomPurchase: purchase,
      onFinish: (world: GameWorld) => {
        const player = [...world.inventories.keys()][0];
        if (player === undefined) return;
        observation = {
          weaponId: getActiveWeaponDef(world)?.id ?? null,
          mainHand: getEquipmentState(world, player)?.equipped.mainHand ?? null,
          baseDamage: getActiveWeaponDef(world)?.baseDamage ?? null,
          cooldownMs: getActiveWeaponDef(world)?.cooldownMs ?? null,
          sawAct2:
            getFloor4ArenaRunStats(world)?.timeline.some(
              (entry) => entry.phase.kind === 'WAVES' && entry.phase.act === 2,
            ) ?? false,
        };
      },
    },
  );
  return { stats, observation };
}

describe('Floor 4 Green Room purchase-to-Act-2 path', () => {
  it('makes one deterministic genuine upgrade purchase that survives into later combat', async () => {
    const bought = await runPurchaseBranch(true);
    const skipped = await runPurchaseBranch(false);

    expect(bought.stats.outcome).toBe('victory');
    expect(skipped.stats.outcome).toBe('victory');
    expect(bought.stats.goldEconomy?.greenRoomPurchases).toBe(1);
    expect(skipped.stats.goldEconomy?.greenRoomPurchases).toBe(0);
    expect(bought.stats.goldEconomy?.spentOnGreenRoom).toBe(
      bought.stats.vendors?.decisions[0]?.cost,
    );
    expect(bought.stats.vendors?.decisions).toHaveLength(1);
    expect(bought.stats.vendors?.decisions[0]).toMatchObject({
      vendorId: 'floor4-green-room',
      outcome: 'purchased',
    });
    expect(bought.observation?.mainHand).not.toBeNull();
    expect(bought.observation?.sawAct2).toBe(true);
    expect(skipped.observation?.sawAct2).toBe(true);
    expect(bought.observation?.weaponId).not.toBe(skipped.observation?.weaponId);
    expect({
      baseDamage: bought.observation?.baseDamage,
      cooldownMs: bought.observation?.cooldownMs,
    }).not.toEqual({
      baseDamage: skipped.observation?.baseDamage,
      cooldownMs: skipped.observation?.cooldownMs,
    });
    expect(bought.stats.combat.damageDealt).not.toBe(skipped.stats.combat.damageDealt);
  }, 180_000);
});
