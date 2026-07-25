/**
 * Shared types for the velocity lab — the A/B harness that measures how much
 * effort an agent needs to deliver a feature under different environments.
 *
 * Vocabulary:
 * - **Task**  — one replayed merged PR: a start commit, a prompt, a frozen verifier.
 * - **Arm**   — one configuration under test (environment change OR model change).
 * - **Trial** — one agent session: (task × arm × repetition).
 */

export const TASK_PACK_SCHEMA = 'crawler-velocity-task-pack/v1';
export const EXPERIMENT_SCHEMA = 'crawler-velocity-experiment/v1';
export const REPORT_SCHEMA = 'crawler-velocity-report/v1';

/** A verifier file restored into the trial worktree before the agent starts. */
export interface VerifierFile {
  path: string;
  contents: string;
}

export interface TaskSpec {
  /** Stable slug, e.g. `pr1930-caching-run-store`. */
  id: string;
  prNumber: number;
  title: string;
  /** Commit the trial worktree starts from (the PR's merge base). */
  baseCommit: string;
  /**
   * The merged commit containing the solution. Recorded ONLY so the leak audit
   * can detect it in a transcript. It is never given to a trial.
   */
  solutionCommit: string;
  /** Task statement handed to the agent. Must not contain the solution. */
  prompt: string;
  /** Verifier command run in the trial worktree to decide pass/fail. */
  verifierCommand: string;
  /** Test files from the PR, restored before the agent starts. */
  verifierFiles: VerifierFile[];
  /** sha256 over the verifier payload, frozen at pack-build time. */
  verifierHash: string;
  /** Non-test files the PR touched. Leak-audit signal + difficulty estimate. */
  solutionFiles: string[];
}

export interface TaskPack {
  schema: typeof TASK_PACK_SCHEMA;
  id: string;
  createdAt: string;
  repo: string;
  tasks: TaskSpec[];
}

/** Which single factor an experiment varies. Enforced by the one-factor rule. */
export type ExperimentFactor = 'environment' | 'model';

export interface ArmSpec {
  id: string;
  description: string;
  /** Model for trial sessions. Omit to inherit the experiment default. */
  model?: string;
  reasoningEffort?: string;
  contextTier?: string;
  /** Custom agent to run trials as (e.g. to A/B an agent definition). */
  agent?: string;
  /**
   * Shell commands run inside the trial worktree before the agent starts.
   * This is how an `environment` arm mutates skills/instructions/contracts.
   */
  setup?: string[];
}

export interface ExperimentSpec {
  schema: typeof EXPERIMENT_SCHEMA;
  id: string;
  /** What you expect to happen, written before the run. */
  hypothesis: string;
  /** Which factor varies. Verified against the arms by `assertOneFactor`. */
  factor: ExperimentFactor;
  /** Path to the task pack JSON, relative to repo root. */
  pack: string;
  arms: ArmSpec[];
  /** Repetitions per (task × arm). */
  trials: number;
  /** Hard cost ceiling per trial. */
  maxAiCredits?: number;
  /** Hard wall-clock ceiling per trial. */
  timeoutMs?: number;
  /** Base model applied to arms that do not override it. */
  defaultModel?: string;
}

/**
 * Context-efficiency metrics, read from the session event log.
 *
 * These exist because turns and output tokens measure production, not
 * consumption. An arm that reaches green in fewer turns while tripling context
 * burn is not obviously better: context burn forces compaction, and compaction
 * is both expensive and lossy.
 */
export interface ContextMetrics {
  /**
   * False when the session event log could not be read at all.
   *
   * Distinguishes "this session used no context" from "we never measured this
   * session". Without it, a missing log scores as a perfect zero and an
   * unmeasured arm wins every context comparison.
   */
  available: boolean;
  /** Number of context compactions. Each is paid for twice: tokens and lost detail. */
  compactions: number;
  /**
   * Highest observed context size, in tokens. Only observable at compaction
   * boundaries (`preCompactionTokens`), so it is 0 for sessions that never
   * compacted — which is the good case, not missing data.
   */
  peakContextTokens: number;
  /** Tokens spent *performing* compaction — the direct, billable cost of overflow. */
  compactionTokensUsed: number;
  /** Total bytes of tool output pulled into context — the main thing that fills it. */
  toolResultBytes: number;
  largestToolResultBytes: number;
  /** Which tool produced the single biggest result, for targeted optimisation. */
  largestToolResultName: string | null;
}

/** Metrics extracted from one trial's JSONL transcript. */
export interface TrialMetrics {
  /** Model calls — the primary "agent turns" measure. */
  modelCalls: number;
  /** Sum of `assistant.message.outputTokens`. */
  outputTokens: number;
  /** Tool invocations requested across the session. */
  toolCalls: number;
  /** Total billed nano-AIU — the truest single cost figure. */
  nanoAiu: number;
  /** Wall-clock for the whole session. */
  sessionDurationMs: number;
  /** Time spent inside model API calls. */
  apiDurationMs: number;
  linesAdded: number;
  linesRemoved: number;
  filesModified: number;
}

export interface TrialResult {
  taskId: string;
  armId: string;
  repetition: number;
  /** Copilot session UUID, for cross-referencing the transcript. */
  sessionId: string | null;
  /** True only if the frozen verifier passed. Everything else is a failure. */
  verifierPassed: boolean;
  /** Exit code of the verifier command. */
  verifierExitCode: number | null;
  /** Set when the trial could not run at all (setup/timeout/crash). */
  error: string | null;
  metrics: TrialMetrics;
  /** Context-efficiency telemetry; zeroed when the event log is unavailable. */
  context: ContextMetrics;
  /** Leak audit: solution identifiers found in the transcript. */
  leakSignals: string[];
  /**
   * The session hit its AI-credit ceiling. Such a trial is censored data — it
   * shows the arm did not finish *within budget*, not that it could not finish.
   */
  budgetExhausted: boolean;
  transcriptPath: string;
  startedAt: string;
  finishedAt: string;
}

export interface MetricSummary {
  n: number;
  median: number;
  mean: number;
  min: number;
  max: number;
}

export interface ArmSummary {
  armId: string;
  description: string;
  trials: number;
  passed: number;
  passRate: number;
  /** Summaries computed over PASSING trials only — failures have no "time to green". */
  modelCalls: MetricSummary;
  outputTokens: MetricSummary;
  nanoAiu: MetricSummary;
  sessionDurationMs: MetricSummary;
  /** Bytes of tool output pulled into context — the context-efficiency outcome. */
  toolResultBytes: MetricSummary;
  compactions: MetricSummary;
}

export type ComparableMetric =
  | 'modelCalls'
  | 'outputTokens'
  | 'nanoAiu'
  | 'sessionDurationMs'
  // Context-efficiency metrics are first-class outcomes, not diagnostics: an
  // arm that wins on turns while burning more context has not obviously won.
  | 'toolResultBytes'
  | 'compactions';

export interface Comparison {
  metric: ComparableMetric;
  baselineArm: string;
  treatmentArm: string;
  baselineMedian: number;
  treatmentMedian: number;
  /** treatment - baseline. Negative = treatment is cheaper/faster. */
  medianDelta: number;
  /** Bootstrap 95% interval on the median delta. */
  ci95: [number, number];
  /** Cliff's delta, a non-parametric effect size in [-1, 1]. */
  cliffsDelta: number;
  effectSizeLabel: 'negligible' | 'small' | 'medium' | 'large';
  /** True only when the CI excludes zero AND both arms have usable samples. */
  conclusive: boolean;
}

export interface ExperimentReport {
  schema: typeof REPORT_SCHEMA;
  experimentId: string;
  hypothesis: string;
  factor: ExperimentFactor;
  packId: string;
  startedAt: string;
  finishedAt: string;
  arms: ArmSummary[];
  comparisons: Comparison[];
  trials: TrialResult[];
  /** Human-readable bottom line, including loud "inconclusive" when warranted. */
  verdict: string;
  /** Non-fatal problems that weaken the result (leaks, low n, arm failures). */
  warnings: string[];
}
