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

  it('uses DEFAULT_CONFIG.retreatThreshold in every BehaviorTreeAI constructor call', () => {
    const source = readFileSync('src/labs/ai-runner-lab/index.ts', 'utf-8');
    // Every occurrence of retreatThreshold must use the shared constant, never a literal
    expect(source).not.toContain('retreatThreshold: 0.15');
    // Confirm the replacement is present (there are three call-sites: initial, rebuildAiBrain, reseed)
    const occurrences =
      source.split('retreatThreshold: DEFAULT_CONFIG.retreatThreshold').length - 1;
    expect(occurrences).toBe(3);
  });

  it('uses DEFAULT_CONFIG.farmPullWeight in every BehaviorTreeAI constructor call', () => {
    const source = readFileSync('src/labs/ai-runner-lab/index.ts', 'utf-8');
    // Every occurrence must use shared config, never a literal.
    expect(source).not.toContain('farmPullWeight: 0.07');
    expect(source).not.toContain('farmPullWeight: 0.12');
    const occurrences = source.split('farmPullWeight: DEFAULT_CONFIG.farmPullWeight').length - 1;
    expect(occurrences).toBe(3);
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
