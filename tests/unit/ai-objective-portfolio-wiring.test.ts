import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/game/ai/bt-ai-tuning.js';
import { PLAYER_PERSONAS, getPersonaConfig } from '../../src/game/ai/personas.js';
import { AIDecisionMode } from '../../src/game/ai/types.js';

const PROVIDER_SOURCE = readFileSync('src/game/ai/bt-ai-provider.ts', 'utf-8');
const LAB_SOURCE = readFileSync('src/labs/ai-runner-lab/index.ts', 'utf-8');
import { helpText, parseArgs } from '../../src/game/ai/headless-runner-cli-lib.js';

const WEIGHT_KEYS = [
  'completion',
  'optimization',
  'safety',
  'exploration',
  'costPerSecond',
] as const;

describe('objectivePortfolio decision-mode wiring', () => {
  it('forwards the persona utility weights into the real planner call, gated on the mode', () => {
    // The runtime planner call site is the ONLY thing that makes the flag
    // observable in the game/headless pipelines; the invariant matrix runs both
    // modes but its scenarios carry no utility-bearing optional objectives, so
    // it would stay green if this forwarding were deleted.
    const start = PROVIDER_SOURCE.indexOf('const route = planObjectiveRoute({');
    expect(start).toBeGreaterThan(-1);
    const end = PROVIDER_SOURCE.indexOf('});', start);
    expect(end).toBeGreaterThan(start);
    const call = PROVIDER_SOURCE.slice(start, end);

    expect(call).toContain('...(portfolioWeights ? { utilityWeights: portfolioWeights } : {})');

    // Legacy must pass NO weights at all — an omitted field, not zeroed
    // weights, is what keeps the pre-existing bundle-count path byte-identical.
    const gate = PROVIDER_SOURCE.slice(
      PROVIDER_SOURCE.indexOf('private strategicUtilityWeights()'),
    ).slice(0, 400);
    expect(gate).toContain('this.config.decisionMode === AIDecisionMode.OBJECTIVE_PORTFOLIO');
    expect(gate).toContain('this.config.strategicUtilityWeights');
    expect(gate).toContain(': undefined');
  });

  it('weights BOTH Floor 1 planner call sites from the same gate', () => {
    // planFloor1ObjectiveRoute builds the same Floor 1 goal graph and its
    // includedOptionalBundleIds drive merchant/Spell-Broker purchase-intent
    // admission. If only the behavior tree's middle-chain route were weighted,
    // the two planners could select different optional bundles under a
    // contended budget and the agent would farm gold for a purchase its own
    // committed route already dropped.
    // The weights ride on RunPlannerParams, so getRunPlannerParams is the
    // second gated entry point and also feeds buildRunPlanCacheKey.
    const paramsFn = PROVIDER_SOURCE.slice(
      PROVIDER_SOURCE.indexOf('private getRunPlannerParams('),
    ).slice(0, 600);
    expect(paramsFn).toContain('const portfolioWeights = this.strategicUtilityWeights();');
    expect(paramsFn).toContain('...(portfolioWeights ? { utilityWeights: portfolioWeights } : {})');
    const callSites = PROVIDER_SOURCE.match(/this\.strategicUtilityWeights\(\)/g) ?? [];
    expect(callSites.length).toBe(2);
    // The weights are read from config in exactly one place — the gate itself.
    const reads = PROVIDER_SOURCE.match(/this\.config\.strategicUtilityWeights/g) ?? [];
    expect(reads.length).toBe(1);
  });

  it('drives the behavior tree from the planner-selected active objective', () => {
    expect(PROVIDER_SOURCE).toContain('nextGoalId = route.activeObjectiveId;');
    expect(PROVIDER_SOURCE).toContain('portfolio: route.portfolio,');
  });

  it('exposes both decision modes in the AI runner lab and the headless CLI', () => {
    expect(LAB_SOURCE).toContain('[AIDecisionMode.LEGACY, AIDecisionMode.OBJECTIVE_PORTFOLIO]');
    // The CLI parses from the enum, so every mode is reachable; the help text
    // must enumerate them too or the flag is discoverable only by reading
    // source (it previously advertised `legacy` alone).
    const help = helpText();
    const decisionLine = help.split('\n').find((line) => line.includes('--decision-mode <mode>'));
    expect(decisionLine).toBeDefined();
    for (const mode of Object.values(AIDecisionMode)) {
      expect(decisionLine, mode).toContain(mode);
      expect(parseArgs(['node', 'cli', '--decision-mode', mode]).decisionMode).toBe(mode);
    }
  });

  it('resolves complete, valid utility weights for every persona', () => {
    // AIConfig is consumed as Required<AIConfig>, and a partially populated
    // weights object is rejected by the planner — so a persona that forgets a
    // dimension must fail here, not at plan time inside a headless run.
    for (const persona of PLAYER_PERSONAS) {
      const weights = { ...DEFAULT_CONFIG, ...getPersonaConfig(persona) }.strategicUtilityWeights;
      expect(weights, persona).toBeDefined();
      for (const key of WEIGHT_KEYS) {
        const value = weights?.[key];
        expect(typeof value, `${persona}.${key}`).toBe('number');
        expect(Number.isFinite(value as number), `${persona}.${key}`).toBe(true);
        expect(value as number, `${persona}.${key}`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('defaults to LEGACY so the production baseline is unchanged', () => {
    expect(DEFAULT_CONFIG.decisionMode).toBe(AIDecisionMode.LEGACY);
  });
});
