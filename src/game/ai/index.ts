/**
 * AI module - traditional rule-based AI player.
 *
 * Exports AI input providers and types for headless/visual runners.
 */
export { RuleBasedAI } from './ai-input-provider.js';
export type { AIInputProvider, AIDecision, AIConfig, RunStats } from './types.js';
export { AIState } from './types.js';
export { runHeadless } from './headless-runner.js';
export { runSimulationStep, type SimulationOptions } from './simulation-step.js';
