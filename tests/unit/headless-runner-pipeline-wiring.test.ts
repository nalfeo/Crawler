/**
 * Pipeline-parity contract (issue #663) — source-string guard.
 *
 * The headless runner (`src/game/ai/headless-runner.ts`) must derive its
 * pre/post system ordering from `createFloorMainSceneOptions()`, the single
 * source of truth shared with the visual pipeline.  This test pins that
 * structural wiring so a future refactor cannot accidentally reintroduce
 * a hand-maintained system list in the headless runner.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const HEADLESS_RUNNER_SRC = readFileSync('src/game/ai/headless-runner.ts', 'utf-8');
const HEADLESS_STEP_SRC = readFileSync('src/game/ai/simulation-step.ts', 'utf-8');

describe('headless pipeline wiring — pipeline-parity contract (issue #663)', () => {
  it('headless-runner imports createFloorMainSceneOptions (single source of truth)', () => {
    // The headless runner must import from the canonical bootstrap, not
    // maintain its own system list.
    expect(HEADLESS_RUNNER_SRC).toContain('createFloorMainSceneOptions');
    expect(HEADLESS_RUNNER_SRC).toContain('floor-main-scene-options');
  });

  it('headless-runner builds pre/post systems from createFloorMainSceneOptions', () => {
    // The runner must call createFloorMainSceneOptions and pass the merged
    // canonical arrays directly into runSimulationStep.
    expect(HEADLESS_RUNNER_SRC).toMatch(/createFloorMainSceneOptions\(/);
    expect(HEADLESS_RUNNER_SRC).toContain('preSystems: mergedPreSystems');
    expect(HEADLESS_RUNNER_SRC).toContain('postSystems: mergedPostSystems');
  });

  it('headless simulation-step does NOT hardcode game-layer systems', () => {
    // The headless step must be a pure core ECS pipeline — no hardcoded
    // weaponSystem, floor1EnemyDirectorSystem, statsSystem, etc.  Game-layer
    // systems are injected via preSystems/postSystems by the runner.
    // Check for actual call sites (e.g. "weaponSystem(world)"), not just mentions
    // in comments or JSDoc (those are fine).
    expect(HEADLESS_STEP_SRC).not.toMatch(/\bweaponSystem\(world\)/);
    expect(HEADLESS_STEP_SRC).not.toMatch(/\bfloor1EnemyDirectorSystem\(world\)/);
    expect(HEADLESS_STEP_SRC).not.toMatch(/\bstatsSystem\(world\)/);
    expect(HEADLESS_STEP_SRC).not.toMatch(/\benemyAISystem\(world\)/);
    expect(HEADLESS_STEP_SRC).not.toMatch(/\bstatusEffectSystem\(world\)/);
  });
});
