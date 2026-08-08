/**
 * AI module - behavior tree AI player.
 *
 * Exports AI input providers and types for headless/visual runners.
 */
export { BehaviorTreeAI, RISK_REWARD_FIELD_CONSTANTS } from './bt-ai-provider.js';
export type { FusedHeadingDebug, FusedCandidateDebug } from './bt-ai-provider.js';
export type {
  AIInputProvider,
  AIDecision,
  AIConfig,
  RunStats,
  LootEfficiencyMetrics,
  AIPathingModeValue,
  AIDecisionModeValue,
} from './types.js';
export { AIState, AIPathingMode, AIDecisionMode } from './types.js';
export { runHeadless } from './headless-runner.js';
export {
  WEAPON_PERSONAS,
  getWeaponPersona,
  getWeaponPersonaForWorld,
  computeWeaponPersonaStatAllocation,
  type WeaponPersona,
} from './weapon-personas.js';
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
