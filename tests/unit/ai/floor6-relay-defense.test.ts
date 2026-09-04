import { addComponent, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { createFloorMainSceneOptions } from '../../../src/bootstrap/floor-main-scene-options.js';
import {
  BroadcastRelayRaider,
  Enemy,
  Health,
  Position,
  Velocity,
} from '../../../src/core/index.js';
import { createEntity } from '../../../src/core/spawners/entity-core.js';
import { spawnPlayer } from '../../../src/core/spawners/combatants.js';
import { BehaviorTreeAI } from '../../../src/game/ai/bt-ai-provider.js';
import { AIState } from '../../../src/game/ai/types.js';
import { floor6DefenseDirectorSystem } from '../../../src/game/floor6Scenario.js';
import { createInputState } from '../../../src/shared/input.js';
import { createTestWorld } from '../../helpers/world-factory.js';

function makeFloor6DefenseWorld() {
  const world = createTestWorld({ seed: 42, floor: 6 });
  const player = spawnPlayer(world, 0, 0);
  createFloorMainSceneOptions('floor6').configureWorld!(world, player);
  floor6DefenseDirectorSystem(world);
  world.floorMap = null;
  return { world, player };
}

function spawnRelayRaider(world: ReturnType<typeof createTestWorld>, x: number, y: number): number {
  const eid = createEntity(world);
  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(world.ecs, eid, set(Velocity, { x: 0, y: 0 }));
  addComponent(world.ecs, eid, set(Health, { current: 10, max: 10 }));
  addComponent(world.ecs, eid, Enemy);
  addComponent(
    world.ecs,
    eid,
    set(BroadcastRelayRaider, {
      manifestIndex: 0,
      waypointIndex: 0,
      stillFrames: 0,
      lastRelayAttackMs: 0,
    }),
  );
  return eid;
}

describe('BT — Floor 6 relay defense priority', () => {
  it('intercepts live relay raiders without Floor 1 tutorial hunt state', () => {
    const { world } = makeFloor6DefenseWorld();
    const raider = spawnRelayRaider(world, 80, 0);
    const ai = new BehaviorTreeAI({ seed: 42 });

    ai.poll(createInputState(), world);
    const decision = ai.getDecision();

    expect(world.questLog.has('floor1-tutorial')).toBe(false);
    expect(decision.state).toBe(AIState.ENGAGE);
    expect(decision.targetEid).toBe(raider);
    expect(decision.reason).toContain('Defending Floor 6 relay');
  });

  it('prioritizes the raider closest to the relay when multiple threats are live', () => {
    const { world } = makeFloor6DefenseWorld();
    const defense = world.floorExtendedState?.floor6Defense;
    if (!defense) throw new Error('Floor 6 defense state missing');
    const tileSizeFt = world.floorMap?.config.tileSizeFt ?? 4;
    const relay = defense.geometry.broadcastRelay.target;
    const relayX = (relay.x + 0.5) * tileSizeFt;
    const relayY = (relay.y + 0.5) * tileSizeFt;
    spawnRelayRaider(world, 8, 0);
    const relayThreat = spawnRelayRaider(world, relayX + 4, relayY);
    const ai = new BehaviorTreeAI({ seed: 42 });

    ai.poll(createInputState(), world);

    expect(ai.getDecision().state).toBe(AIState.ENGAGE);
    expect(ai.getDecision().targetEid).toBe(relayThreat);
  });
});
