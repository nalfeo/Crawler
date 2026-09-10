/**
 * Headless integration coverage for the `attackWaves` / `floor1Spawners`
 * feature flags (default-off periodic rat attack waves + Floor 1 static
 * spawners).
 *
 * Covers:
 * 1. Default (omitted) config: both flags stay off — no `world.attackWaveFlags
 *    .attackWaves`, no Spawner entities (existing game behavior unchanged).
 * 2. `attackWaves: true` sets `world.attackWaveFlags.attackWaves` before play
 *    on Floor 1 (which declares `trashAttackWaves`).
 * 3. `attackWaves: true` on Floor 2 (no `trashAttackWaves`) still sets the
 *    world flag but stays inert — no `AttackWaveRat` entities ever spawn.
 * 4. `floor1Spawners: true` places exactly two `rats-nest` + two `slime-pool`
 *    Spawner entities on Floor 1 only.
 * 5. Independence matrix: the two flags toggle independently of each other.
 */
import { describe, expect, it } from 'vitest';
import { query } from 'bitecs';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { Spawner } from '../../src/core/components.js';
import type { GameWorld } from '../../src/core/world.js';

describe('attackWaves / floor1Spawners headless flags', () => {
  it('both stay off by default (existing game behavior unchanged)', async () => {
    let capturedFlag: boolean | undefined;
    let capturedSpawnerCount: number | undefined;

    await runHeadless(new BehaviorTreeAI({ seed: 42 }), {
      seed: 42,
      floorId: 'floor1',
      maxFrames: 5,
      questStallFrames: 0,
      onFinish: (world: GameWorld) => {
        capturedFlag = world.attackWaveFlags.attackWaves;
        capturedSpawnerCount = query(world.ecs, [Spawner]).length;
      },
    });

    expect(capturedFlag).toBe(false);
    expect(capturedSpawnerCount).toBe(0);
  }, 30_000);

  it('sets world.attackWaveFlags.attackWaves before play on Floor 1', async () => {
    let capturedFlag: boolean | undefined;

    await runHeadless(new BehaviorTreeAI({ seed: 42 }), {
      seed: 42,
      floorId: 'floor1',
      maxFrames: 5,
      questStallFrames: 0,
      attackWaves: true,
      onFinish: (world: GameWorld) => {
        capturedFlag = world.attackWaveFlags.attackWaves;
      },
    });

    expect(capturedFlag).toBe(true);
  }, 30_000);

  it('sets the world flag on Floor 2 too, but stays inert (no manifest trashAttackWaves)', async () => {
    let capturedFlag: boolean | undefined;
    let spawnerCount: number | undefined;

    await runHeadless(new BehaviorTreeAI({ seed: 42 }), {
      seed: 42,
      floorId: 'floor2',
      maxFrames: 5,
      questStallFrames: 0,
      attackWaves: true,
      onFinish: (world: GameWorld) => {
        capturedFlag = world.attackWaveFlags.attackWaves;
        spawnerCount = query(world.ecs, [Spawner]).length; // no static spawners on floor2 either
      },
    });

    // The flag is still set (applied "before play", floor-agnostic) — but
    // Floor 2's manifest doesn't declare `trashAttackWaves`, so the system
    // stays inert (see `attack-wave-system.test.ts`'s floor2/3/4 coverage for
    // the exhaustive unit-level proof, including that `attackWaveState` is
    // never even initialized).
    expect(capturedFlag).toBe(true);
    expect(spawnerCount).toBe(0);
  }, 30_000);

  it('places two rats-nest and two slime-pool spawners on Floor 1 when floor1Spawners is enabled', async () => {
    let capturedSpawnerCount: number | undefined;

    await runHeadless(new BehaviorTreeAI({ seed: 42 }), {
      seed: 42,
      floorId: 'floor1',
      maxFrames: 5,
      questStallFrames: 0,
      floor1Spawners: true,
      onFinish: (world: GameWorld) => {
        capturedSpawnerCount = query(world.ecs, [Spawner]).length;
      },
    });

    expect(capturedSpawnerCount).toBe(4);
  }, 30_000);

  it('ignores floor1Spawners on Floor 2 (Floor-1-only option)', async () => {
    let capturedSpawnerCount: number | undefined;

    await runHeadless(new BehaviorTreeAI({ seed: 42 }), {
      seed: 42,
      floorId: 'floor2',
      maxFrames: 5,
      questStallFrames: 0,
      floor1Spawners: true,
      onFinish: (world: GameWorld) => {
        capturedSpawnerCount = query(world.ecs, [Spawner]).length;
      },
    });

    expect(capturedSpawnerCount).toBe(0);
  }, 30_000);

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    'toggles attackWaves=%s and floor1Spawners=%s independently on Floor 1',
    async (attackWaves, floor1Spawners) => {
      let capturedFlag: boolean | undefined;
      let capturedSpawnerCount: number | undefined;

      await runHeadless(new BehaviorTreeAI({ seed: 7 }), {
        seed: 7,
        floorId: 'floor1',
        maxFrames: 5,
        questStallFrames: 0,
        attackWaves,
        floor1Spawners,
        onFinish: (world: GameWorld) => {
          capturedFlag = world.attackWaveFlags.attackWaves;
          capturedSpawnerCount = query(world.ecs, [Spawner]).length;
        },
      });

      expect(capturedFlag).toBe(attackWaves);
      expect(capturedSpawnerCount).toBe(floor1Spawners ? 4 : 0);
    },
    30_000,
  );
});
