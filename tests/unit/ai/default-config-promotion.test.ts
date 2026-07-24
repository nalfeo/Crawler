/**
 * Regression gate for the 2026-07-21 AI Sweep winner promotion.
 *
 * Pins the production `DEFAULT_CONFIG` (src/game/ai/bt-ai-tuning.ts) — the
 * single source of truth merged into every `BehaviorTreeAI` instance that
 * doesn't explicitly override a field — to the EXACT winning parameter set
 * from GitHub Actions recovery run 29893475612 (leaderboard artifact
 * provenance workflowSha=18929bed51edb1979db2650e3329cf4fe63ff418), validated
 * at 294/300 wins (98%) vs the prior legacy+legacy incumbent's 286/300.
 *
 * This test exists to prevent silent drift away from the sweep-validated
 * config. If it fails, do NOT weaken these expected values to make it pass —
 * either the drift is a real regression (fix bt-ai-tuning.ts), or a new
 * sweep has genuinely validated a new winner (update this test AND the
 * handoff/comment provenance together).
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../../src/game/ai/bt-ai-tuning.js';
import { AIDecisionMode, AIPathingMode } from '../../../src/game/ai/types.js';

describe('DEFAULT_CONFIG — 2026-07-21 AI Sweep winner promotion', () => {
  it('resolves exactly to the sweep-validated winning parameters', () => {
    expect(DEFAULT_CONFIG.pathingMode).toBe(AIPathingMode.RISK_REWARD_FUSED);
    expect(DEFAULT_CONFIG.decisionMode).toBe(AIDecisionMode.LEGACY);
    expect(DEFAULT_CONFIG.aggression).toBe(1);
    expect(DEFAULT_CONFIG.retreatThreshold).toBe(0.1);
    expect(DEFAULT_CONFIG.dodgeWeight).toBe(0.25);
    expect(DEFAULT_CONFIG.rangedSafeDistance).toBe(15);
    expect(DEFAULT_CONFIG.collectPullWeight).toBe(0.5);
    expect(DEFAULT_CONFIG.farmPullWeight).toBe(0.12);
    expect(DEFAULT_CONFIG.scanRadius).toBe(50);
    expect(DEFAULT_CONFIG.retreatDangerRadius).toBe(20);
    expect(DEFAULT_CONFIG.opportunisticGrabRadius).toBe(18);
  });
});
