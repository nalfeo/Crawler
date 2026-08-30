import { describe, expect, it } from 'vitest';
import { query } from 'bitecs';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { AIState, type AIDecision, type AIInputProvider } from '../../src/game/ai/types.js';
import type { GameWorld } from '../../src/core/world.js';
import { Health, SiegeMinion, SiegeStructure, Team } from '../../src/core/components.js';
import { TeamId } from '../../src/shared/constants.js';
import type { InputState } from '../../src/shared/input.js';

class IdleFloor5Provider implements AIInputProvider {
  private readonly decision: AIDecision = {
    state: AIState.EXPLORE,
    targetEid: null,
    targetX: null,
    targetY: null,
    reason: 'floor5 lane-war observation',
    npcInteraction: null,
    debug: null,
  };

  poll(_input: InputState, _world: GameWorld): void {}

  getDecision(): AIDecision {
    return this.decision;
  }

  reset(): void {}
}

describe('Floor 5 lane-war real headless pipeline', () => {
  it('completes an opposing-wave cycle, contests a checkpoint, damages legal targets, and records no path stalls', async () => {
    let structureTeams: number[] = [];
    let minionTeams: number[] = [];
    const stats = await runHeadless(new IdleFloor5Provider(), {
      floorId: 'floor5',
      seed: 505,
      maxFrames: 420,
      questStallFrames: 0,
      onFinish: (world) => {
        structureTeams = Array.from(query(world.ecs, [SiegeStructure, Team, Health]))
          .map((eid) => world.stores.team.id[eid] ?? -1)
          .sort((a, b) => a - b);
        minionTeams = Array.from(query(world.ecs, [SiegeMinion, Team]))
          .map((eid) => world.stores.team.id[eid] ?? -1)
          .sort((a, b) => a - b);
      },
    });

    const siege = stats.floor5Siege;
    expect(siege).toBeDefined();
    expect(siege!.waveManifest).toEqual([
      { id: 'wave-0-allied', team: 'allied', releaseFrame: 1, count: 2 },
      { id: 'wave-0-enemy', team: 'enemy', releaseFrame: 1, count: 1 },
    ]);
    expect(siege!.laneTelemetry.waveCyclesCompleted).toBe(1);
    expect(siege!.laneTelemetry.checkpointContests).toBeGreaterThan(0);
    expect(siege!.laneTelemetry.legalDamageEvents).toBeGreaterThan(0);
    expect(siege!.laneTelemetry.illegalDamageEvents).toBe(0);
    expect(siege!.laneTelemetry.pathStalls).toBe(0);
    expect(
      [siege!.structures['enemy-checkpoint'], siege!.structures['outer-wall']].some(
        (structure) => structure.health < structure.maxHealth,
      ),
    ).toBe(true);
    expect(siege!.spawnDebt).toEqual({ allied: 0, enemy: 0 });
    expect(siege!.laneTelemetry.spawnDebtPeak.allied).toBeLessThanOrEqual(4);
    expect(siege!.laneTelemetry.spawnDebtPeak.enemy).toBeLessThanOrEqual(4);
    expect(structureTeams).toEqual([
      TeamId.SIEGE_ALLIED,
      TeamId.SIEGE_ALLIED,
      TeamId.SIEGE_ENEMY,
      TeamId.SIEGE_ENEMY,
    ]);
    expect(minionTeams).toContain(TeamId.SIEGE_ALLIED);
    expect(siege!.laneTelemetry.spawned.enemy).toBeGreaterThan(0);
    expect(stats.stallReason).toBeUndefined();
  });
});
