import { mkdirSync, writeFileSync } from 'node:fs';
import { hasComponent, query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { DeathTimer, Enemy, Health, Player, Projectile, Team } from '../../src/core/components.js';
import type { GameWorld } from '../../src/core/world.js';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { getPersonaConfig } from '../../src/game/ai/personas.js';
import { TeamId } from '../../src/shared/constants.js';
import type { InputState } from '../../src/shared/input.js';

/** Independent observation of ordinary combat: no health, damage, movement, or spawn overrides. */
class PressureObserver extends BehaviorTreeAI {
  readonly nearby = [0, 0, 0, 0, 0];
  readonly frames = [0, 0, 0, 0, 0];
  readonly firstTenMs: (number | null)[] = [null, null, null, null, null];
  maxHostiles = 0;
  maxProjectiles = 0;

  override poll(input: InputState, world: GameWorld): void {
    super.poll(input, world);
    const arena = world.floorExtendedState?.floor4Arena;
    const player = query(world.ecs, [Player])[0];
    if (player === undefined || arena?.phase.kind !== 'WAVES' || world.playerInSafeRoom) return;
    const hostiles = query(world.ecs, [Enemy, Health]).filter(
      (eid) =>
        !hasComponent(world.ecs, eid, DeathTimer) &&
        world.stores.health.current[eid]! > 0 &&
        (!hasComponent(world.ecs, eid, Team) || world.stores.team.id[eid] !== TeamId.PLAYER),
    );
    const nearby = hostiles.filter(
      (eid) =>
        Math.hypot(
          world.stores.position.x[eid]! - world.stores.position.x[player]!,
          world.stores.position.y[eid]! - world.stores.position.y[player]!,
        ) <= 60,
    ).length;
    const index = arena.phase.act - 1;
    this.nearby[index]! += nearby;
    this.frames[index]!++;
    if (nearby >= 10 && this.firstTenMs[index] === null)
      this.firstTenMs[index] = arena.phaseElapsedMs;
    this.maxHostiles = Math.max(this.maxHostiles, hostiles.length);
    this.maxProjectiles = Math.max(this.maxProjectiles, query(world.ecs, [Projectile]).length);
  }
}

async function observe(seed: number) {
  const ai = new PressureObserver({ ...getPersonaConfig('experienced_player'), seed });
  const stats = await runHeadless(ai, {
    seed,
    floorId: 'floor4',
    maxFrames: 60_000,
    playerPersona: 'experienced_player',
  });
  return {
    seed,
    outcome: stats.outcome,
    kills: stats.combat.totalKills,
    mean: ai.nearby.reduce((a, b) => a + b, 0) / ai.frames.reduce((a, b) => a + b, 0),
    acts: ai.nearby.map((sum, index) => sum / ai.frames[index]!),
    frames: ai.frames,
    firstTenMs: ai.firstTenMs,
    maxHostiles: ai.maxHostiles,
    maxProjectiles: ai.maxProjectiles,
    waveTelemetry: stats.floor4Arena?.waveTelemetry,
    timeline: stats.floor4Arena?.timeline,
  };
}

describe('Floor 4 bounded nearby pressure in the production headless pipeline', () => {
  it.each([404, 1, 2])(
    'averages roughly ten meaningful nearby enemies with automatic combat (seed %s)',
    async (seed) => {
      const observation = await observe(seed);
      mkdirSync('tmp/floor4-density', { recursive: true });
      writeFileSync(
        `tmp/floor4-density/headless-${seed}.json`,
        JSON.stringify(observation, null, 2),
      );
      expect(observation.frames.every((frames) => frames > 5000)).toBe(true);
      expect(observation.mean).toBeGreaterThanOrEqual(8);
      expect(observation.mean).toBeLessThanOrEqual(12);
      for (const [act, average] of observation.acts.entries()) {
        expect(average, `seed ${seed} act ${act + 1}`).toBeGreaterThanOrEqual(8);
        expect(average, `seed ${seed} act ${act + 1}`).toBeLessThanOrEqual(12);
      }
      expect(observation.maxHostiles).toBeLessThanOrEqual(24);
      expect(observation.kills).toBeGreaterThan(0);
      expect(observation.waveTelemetry?.wavesReleased).toBe(50);
      if (seed === 404) {
        expect(observation.outcome).toBe('victory');
        expect(await observe(seed)).toEqual(observation);
      }
    },
    180_000,
  );
});
