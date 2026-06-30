import { describe, expect, it } from 'vitest';
import {
  applyRunnerPersonaToConfig,
  getRunnerPersonaProfile,
  parseRunnerPersona,
  shouldDescendAtStairs,
} from '../../src/game/ai/personas.js';
import { RUNNER_PERSONA } from '../../src/game/ai/types.js';

describe('runner personas', () => {
  it('parses supported persona ids case-insensitively', () => {
    expect(parseRunnerPersona('speedy')).toBe(RUNNER_PERSONA.SPEEDY);
    expect(parseRunnerPersona('BALANCED')).toBe(RUNNER_PERSONA.BALANCED);
    expect(parseRunnerPersona('Greedy')).toBe(RUNNER_PERSONA.GREEDY);
    expect(parseRunnerPersona('unknown')).toBeNull();
  });

  it('applies persona defaults while preserving explicit overrides', () => {
    const config = applyRunnerPersonaToConfig({
      runnerPersona: RUNNER_PERSONA.GREEDY,
      retreatThreshold: 0.22,
    });
    expect(config.runnerPersona).toBe(RUNNER_PERSONA.GREEDY);
    expect(config.collectPullWeight).toBeGreaterThan(0.5);
    expect(config.farmPullWeight).toBeGreaterThan(0.1);
    expect(config.retreatThreshold).toBe(0.22);
  });

  it('uses stair descent windows to gate post-unlock farming behavior', () => {
    expect(shouldDescendAtStairs(RUNNER_PERSONA.SPEEDY, 200_000)).toBe(true);
    expect(shouldDescendAtStairs(RUNNER_PERSONA.BALANCED, 70_000)).toBe(false);
    expect(shouldDescendAtStairs(RUNNER_PERSONA.BALANCED, 40_000)).toBe(true);
    expect(shouldDescendAtStairs(RUNNER_PERSONA.GREEDY, 30_000)).toBe(false);
    expect(shouldDescendAtStairs(RUNNER_PERSONA.GREEDY, 10_000)).toBe(true);
  });

  it('marks balanced and greedy as post-unlock farming personas', () => {
    expect(getRunnerPersonaProfile(RUNNER_PERSONA.SPEEDY).farmAfterStairUnlock).toBe(false);
    expect(getRunnerPersonaProfile(RUNNER_PERSONA.BALANCED).farmAfterStairUnlock).toBe(true);
    expect(getRunnerPersonaProfile(RUNNER_PERSONA.GREEDY).farmAfterStairUnlock).toBe(true);
  });
});
