/**
 * AI module - behavior tree AI player.
 *
 * Exports AI input providers and types for headless/visual runners.
 */
export { BehaviorTreeAI } from './bt-ai-provider.js';
export type { AIInputProvider, AIDecision, AIConfig, RunStats } from './types.js';
export { AIState } from './types.js';
export { runHeadless } from './headless-runner.js';
export { scoreRun, aggregateScores } from './scoring.js';
export type { ScoreBreakdown } from './scoring.js';
export { runSimulationStep, type SimulationOptions } from './simulation-step.js';
export {
  BehaviorTree,
  BTStatus,
  type BTNode,
  type BTContext,
  sequence,
  selector,
  condition,
  action,
  inverter,
  succeeder,
  repeat,
} from './behavior-tree.js';
