import { addComponent, query, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Companion, PartySlot, Player, Team } from '../../src/core/components.js';
import { spawnBehaviorEnemy } from '../../src/core/spawners/combatants.js';
import { recruitPartyCompanion } from '../../src/core/spawners/companions.js';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { _getCompanionAttackState } from '../../src/game/systems/companionCombatSystem.js';
import { companionLearnedAbilityIds } from '../../src/core/systems/companionProgressionSystem.js';
import { AI_TYPE } from '../../src/game/enemyAISystem.js';
import { TeamId } from '../../src/shared/constants.js';
import { speciesTokenForId } from '../../src/shared/data/floor3/species.js';
import { xpRequiredForLevel } from '../../src/shared/xpMath.js';

describe('Floor 3 companion growth in the production headless pipeline', () => {
  it('evolves from an automatic combat kill and replays the same live stats', async () => {
    async function observe() {
      let companion = -1;
      let evolved: number[] = [];
      await runHeadless(new BehaviorTreeAI({ seed: 4445 }), {
        seed: 4445,
        floorId: 'floor3',
        maxFrames: 240,
        questStallFrames: 0,
        simulationOptions: {
          preSystems: [
            (world) => {
              if (companion >= 0) return;
              const player = query(world.ecs, [Player])[0]!;
              // Disable the starting party's damage, leaving its normal roster intact.
              for (const eid of query(world.ecs, [Companion, PartySlot])) {
                world.stores.companion.knockedOut[eid] = 1;
              }
              const x = world.stores.position.x[player]!;
              const y = world.stores.position.y[player]!;
              companion = recruitPartyCompanion(world, {
                x,
                y,
                hp: 160,
                speed: 0.1 * Math.sqrt(1.6),
                aggroRange: 48,
                attackRange: 0,
                aiType: AI_TYPE.CHASE,
                speciesToken: speciesTokenForId('ember-charger'),
                level: 24,
                form: 1,
                xp: xpRequiredForLevel(24) - 1,
                ownerTeam: TeamId.PLAYER,
              })!;
              world.stores.health.current[companion] = 80;
              world.stores.sprite.sizeScale[companion] = Math.sqrt(1.6);
              expect(companionLearnedAbilityIds(world, companion)).toHaveLength(3);
              const target = spawnBehaviorEnemy(world, x + 1, y, 1, AI_TYPE.CHASE, 0, 0, 0);
              addComponent(world.ecs, target, set(Team, { id: TeamId.ENEMY }));
              const nextTarget = spawnBehaviorEnemy(world, x + 2, y, 10000, AI_TYPE.CHASE, 0, 0, 0);
              addComponent(world.ecs, nextTarget, set(Team, { id: TeamId.ENEMY }));
            },
          ],
          postSystems: [
            (world) => {
              if (companion < 0 || world.stores.companion.form[companion] !== 2) return;
              if (
                _getCompanionAttackState(world, companion)?.lastAbilityId !== 'f3.ember-charger.l25'
              )
                return;
              expect(companionLearnedAbilityIds(world, companion)).toHaveLength(4);
              evolved = [
                world.stores.companion.level[companion]!,
                world.stores.health.max[companion]!,
                world.stores.health.current[companion]!,
                world.stores.enemyBehavior.speed[companion]!,
                world.stores.sprite.sizeScale[companion]!,
              ];
            },
          ],
        },
        stopWhen: () => evolved.length > 0,
      });
      return evolved;
    }
    const first = await observe();
    expect(first[0]).toBeGreaterThanOrEqual(25);
    expect(first[1]).toBeCloseTo(240);
    expect(first[2]).toBeCloseTo(120);
    expect(first[3]).toBeCloseTo(0.1 * Math.sqrt(2.4));
    expect(first[4]).toBeCloseTo(Math.sqrt(2.4));
    expect(await observe()).toEqual(first);
  });
});
