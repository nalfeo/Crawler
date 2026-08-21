import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/game/ai/bt-ai-tuning.js';
import { AIPathingMode, AIDecisionMode } from '../../src/game/ai/types.js';

describe('AI runner lab default config wiring', () => {
  it('imports DEFAULT_CONFIG from bt-ai-tuning', () => {
    const source = readFileSync('src/labs/ai-runner-lab/index.ts', 'utf-8');
    expect(source).toContain("import { DEFAULT_CONFIG } from '../../game/ai/bt-ai-tuning.js';");
  });

  it('falls back to DEFAULT_CONFIG.pathingMode for unpersisted pathingMode', () => {
    const source = readFileSync('src/labs/ai-runner-lab/index.ts', 'utf-8');
    expect(source).toContain('persisted?.pathingMode ?? DEFAULT_CONFIG.pathingMode');
    // Must NOT fall back to the LEGACY literal
    expect(source).not.toContain('persisted?.pathingMode ?? AIPathingMode.LEGACY');
  });

  it('falls back to DEFAULT_CONFIG.decisionMode for unpersisted decisionMode', () => {
    const source = readFileSync('src/labs/ai-runner-lab/index.ts', 'utf-8');
    expect(source).toContain('persisted?.decisionMode ?? DEFAULT_CONFIG.decisionMode');
    // Must NOT fall back to the LEGACY literal
    expect(source).not.toContain('persisted?.decisionMode ?? AIDecisionMode.LEGACY');
  });

  it('builds every BehaviorTreeAI from the selected persona preset, never from literals', () => {
    const source = readFileSync('src/labs/ai-runner-lab/index.ts', 'utf-8');
    // Tuning knobs come from the persona preset (see personas.ts), never from
    // literals or a partial hand-copied subset of DEFAULT_CONFIG.
    expect(source).toContain('...getPersonaConfig(aiConfig.playerPersona)');
    expect(source).not.toContain('retreatThreshold: 0.15');
    expect(source).not.toContain('farmPullWeight: 0.07');
    expect(source).not.toContain('farmPullWeight: 0.12');
    expect(source).not.toContain('aggression: 1,');
    // Single construction point, reused by the initial build, rebuildAiBrain and reseed.
    const constructorCalls = source.split('new BehaviorTreeAI(').length - 1;
    expect(constructorCalls).toBe(1);
    const brainUses = source.split('createAiBrain()').length - 1;
    expect(brainUses).toBe(3); // initial build + rebuildAiBrain + reseed
  });

  it('DEFAULT_CONFIG.pathingMode is riskRewardFused (production-promoted value)', () => {
    // Guards that the value the lab now defaults to is the production winner,
    // not the pre-promotion LEGACY arm. If this fails, the promotion constant
    // changed and needs a deliberate update here too.
    expect(DEFAULT_CONFIG.pathingMode).toBe(AIPathingMode.RISK_REWARD_FUSED);
  });

  it('DEFAULT_CONFIG.decisionMode is legacy (production-promoted value)', () => {
    expect(DEFAULT_CONFIG.decisionMode).toBe(AIDecisionMode.LEGACY);
  });

  it('DEFAULT_CONFIG.retreatThreshold is the promoted value (0.1, not the pre-promotion 0.15)', () => {
    expect(DEFAULT_CONFIG.retreatThreshold).toBe(0.1);
  });

  it('DEFAULT_CONFIG.farmPullWeight is the promoted value (0.12, not the pre-promotion 0.07)', () => {
    expect(DEFAULT_CONFIG.farmPullWeight).toBe(0.12);
  });
});
