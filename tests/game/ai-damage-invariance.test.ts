import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { createInputState } from '../../src/shared/input.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { setActiveWeapon } from '../../src/game/weaponSystem.js';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import type { GameWorld } from '../../src/core/world.js';
import { createTestWorld } from '../helpers/world-factory.js';

/**
 * The enemy-damage multiplier (`world.hostileDamageMultiplier`) is a MEASUREMENT
 * LENS only: it lets a headless sweep make "the runner charged through a mob"
 * visible/punishing without changing what the AI decides. The user was explicit —
 * "do not make this scale with damage." So the AI's pathing MUST be damage-agnostic:
 * it may react to its own health, but never to how hard hits happen to hit.
 *
 * These guards encode that invariant two ways:
 *  1. Static: no AI *decision* source file references the multiplier at all (only
 *     the measurement harness that configures the lens is allowed to name it).
 *  2. Behavioral: the same world polled at multiplier 1 vs 20 yields byte-identical
 *     movement, because nothing on the decision path reads the multiplier.
 */
describe('AI damage-invariance (pathing is a measurement-lens, not an input)', () => {
  it('no AI decision module reads the hostile-damage multiplier', () => {
    const aiDir = fileURLToPath(new URL('../../src/game/ai/', import.meta.url));
    // Only the headless measurement harness may name the lens: it *configures*
    // the multiplier onto the world, it does not consult it to steer.
    const HARNESS_ALLOWLIST = new Set(['headless-runner.ts', 'headless-runner-cli.ts']);
    const TOKEN = 'hostileDamageMultiplier';

    const offenders: string[] = [];
    for (const file of readdirSync(aiDir)) {
      if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue;
      if (HARNESS_ALLOWLIST.has(file)) continue;
      const source = readFileSync(
        new URL(file, new URL('../../src/game/ai/', import.meta.url)),
        'utf-8',
      );
      if (source.includes(TOKEN)) offenders.push(file);
    }

    expect(
      offenders,
      `these AI decision modules reference ${TOKEN} — pathing must be damage-agnostic (user: "do not make this scale with damage"): ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('produces identical movement at damage multiplier 1 vs 20 on the same seed/frame', () => {
    const build = (multiplier: number): { moveX: number; moveY: number } => {
      const world: GameWorld = createTestWorld({ seed: 42 });
      world.hostileDamageMultiplier = multiplier;
      const player = spawnPlayer(world, 0, 0);
      // A cluster of nearby threats so steering/dodge decisions are actually
      // exercised (a no-threat frame would be trivially identical).
      spawnEnemy(world, 10, 0, 20);
      spawnEnemy(world, 8, 6, 20);
      spawnEnemy(world, -6, 9, 20);
      setActiveWeapon(world, getWeaponDef('sword')!);
      void player;

      const ai = new BehaviorTreeAI({ seed: 42 });
      const input = createInputState();
      ai.poll(input, world);
      return { moveX: input.moveX, moveY: input.moveY };
    };

    const atOne = build(1);
    const atTwenty = build(20);

    // Exact equality: the decision path never reads the multiplier, so the same
    // seed + same frame + same health must yield the same heading regardless of
    // how much damage a landed hit would deal.
    expect(atTwenty.moveX).toBe(atOne.moveX);
    expect(atTwenty.moveY).toBe(atOne.moveY);
  });
});
