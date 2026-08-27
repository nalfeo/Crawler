import { z } from 'zod';
import { performance } from 'node:perf_hooks';
import { ISSUE_STATUS_KEY_PREFIX } from './sidecar/issue-status-key.js';
import type { RunStore } from './store/types.js';
import type { MonotonicNow } from './pipeline-timing.js';

export const ISSUE_PIPELINE_CHECKPOINT_VERSION = 1;
export const ISSUE_PIPELINE_MAX_STAGE_ATTEMPTS = 3;

export const ISSUE_PIPELINE_STAGES = [
  'synthesize',
  'select-brief',
  'promote',
  'generate',
  'postprocess',
  'judge',
  'select-variants',
  'publish',
] as const;

export type IssuePipelineStage = (typeof ISSUE_PIPELINE_STAGES)[number];

const stageRecordSchema = z
  .object({
    status: z.enum(['running', 'completed', 'failed']),
    attempts: z.number().int().min(0),
    updatedAt: z.string().min(1),
    output: z.unknown().optional(),
    error: z
      .object({
        kind: z.string().nullable(),
        message: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const issuePipelineCheckpointSchema = z
  .object({
    version: z.literal(ISSUE_PIPELINE_CHECKPOINT_VERSION),
    issueNumber: z.number().int().positive(),
    fingerprint: z.string().min(1),
    stage: z.string().min(1),
    updatedAt: z.string().min(1),
    details: z.record(z.string(), z.unknown()).optional(),
    stages: z.record(z.string(), stageRecordSchema),
  })
  .strict();

export type IssuePipelineCheckpoint = z.infer<typeof issuePipelineCheckpointSchema>;

export class IssuePipelineCheckpointError extends Error {
  readonly kind = 'checkpoint-invalid';

  constructor(message: string) {
    super(message);
    this.name = 'IssuePipelineCheckpointError';
  }
}

export interface IssueCheckpointController {
  readonly store: RunStore;
  readonly key: string;
  readonly issueNumber: number;
  readonly fingerprint: string;
  readonly now: () => Date;
  readonly monotonicNow: MonotonicNow;
}

export interface IssueCheckpointStageTiming {
  readonly operationMs: number;
  /** Wrapper work up to, but excluding, the terminal write that persists this timing. */
  readonly orchestrationMs: number;
  readonly totalMs: number;
}

export interface IssueCheckpointTiming {
  readonly totalMs: number;
  readonly stages: Partial<Record<IssuePipelineStage, IssueCheckpointStageTiming>>;
  readonly invalidSamples: number;
}

const CHECKPOINT_TIMING_DETAILS_KEY = 'checkpointTiming';
const checkpointStageTimingSchema = z
  .object({
    operationMs: z.number().finite().nonnegative(),
    orchestrationMs: z.number().finite().nonnegative(),
    totalMs: z.number().finite().nonnegative(),
  })
  .strict()
  .superRefine((timing, context) => {
    if (timing.totalMs !== timing.operationMs + timing.orchestrationMs) {
      context.addIssue({
        code: 'custom',
        path: ['totalMs'],
        message: 'totalMs must equal operationMs + orchestrationMs',
      });
    }
  });
const issueCheckpointStageShape = {
  synthesize: checkpointStageTimingSchema.optional(),
  'select-brief': checkpointStageTimingSchema.optional(),
  promote: checkpointStageTimingSchema.optional(),
  generate: checkpointStageTimingSchema.optional(),
  postprocess: checkpointStageTimingSchema.optional(),
  judge: checkpointStageTimingSchema.optional(),
  'select-variants': checkpointStageTimingSchema.optional(),
  publish: checkpointStageTimingSchema.optional(),
} satisfies Record<IssuePipelineStage, z.ZodOptional<typeof checkpointStageTimingSchema>>;

export const issueCheckpointTimingSchema = z
  .object({
    totalMs: z.number().finite().nonnegative(),
    stages: z.object(issueCheckpointStageShape).strict(),
    invalidSamples: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((timing, context) => {
    const stageTotal = Object.values(timing.stages).reduce(
      (total, entry) => total + (entry?.totalMs ?? 0),
      0,
    );
    if (timing.totalMs !== stageTotal) {
      context.addIssue({
        code: 'custom',
        path: ['totalMs'],
        message: `totalMs must equal checkpoint stage total ${stageTotal}`,
      });
    }
  });

export interface RunCheckpointStageResult<T> {
  readonly output: T;
  readonly resumed: boolean;
}

export function issueCheckpointKey(issueNumber: number, fingerprint: string): string {
  return `${ISSUE_STATUS_KEY_PREFIX}/${issueNumber}-${fingerprint}.json`;
}

export function createIssueCheckpointController(options: {
  readonly store: RunStore;
  readonly issueNumber: number;
  readonly fingerprint: string;
  readonly now?: () => Date;
  readonly monotonicNow?: MonotonicNow;
}): IssueCheckpointController {
  return {
    store: options.store,
    key: issueCheckpointKey(options.issueNumber, options.fingerprint),
    issueNumber: options.issueNumber,
    fingerprint: options.fingerprint,
    now: options.now ?? (() => new Date()),
    monotonicNow: options.monotonicNow ?? (() => performance.now()),
  };
}

/**
 * Structural shape of the flat status doc written by the pre-checkpoint
 * pipeline (see `IssueRunStatus` in `issue-pipeline.ts` prior to commit
 * 49d133cea, which introduced this v1 checkpoint schema). That legacy doc has
 * no `version`/`stages` fields at all — those are new in v1 — so their
 * absence, combined with the presence of the legacy doc's own required
 * fields, is the discriminator used to recognize it.
 *
 * NOTE (documented tradeoff, per review): a genuinely corrupt *current-schema*
 * checkpoint that happens to be missing exactly `version` and `stages` while
 * otherwise retaining valid `issueNumber`/`fingerprint`/`stage`/`updatedAt`
 * values is structurally indistinguishable from a legacy doc and will be
 * treated as one (silently reinitialized rather than raising
 * `checkpoint-invalid`). This is accepted as reasonable: every current-schema
 * writer always includes both `version` and `stages`, so hitting this case in
 * practice would itself indicate storage-level corruption shaped exactly like
 * the retired pipeline's doc — vanishingly unlikely, and no worse than
 * treating it as a fresh re-run.
 */
export function isLegacyIssueRunStatusShape(raw: unknown): raw is {
  readonly issueNumber: number;
  readonly fingerprint: string;
  readonly stage: string;
  readonly updatedAt: string;
} {
  if (raw === null || typeof raw !== 'object') return false;
  const obj = raw as Record<string, unknown>;
  if ('version' in obj || 'stages' in obj) return false;
  if (
    typeof obj.issueNumber !== 'number' ||
    !Number.isInteger(obj.issueNumber) ||
    obj.issueNumber <= 0
  ) {
    return false;
  }
  if (typeof obj.fingerprint !== 'string' || obj.fingerprint.trim() === '') return false;
  if (typeof obj.stage !== 'string' || obj.stage.trim() === '') return false;
  if (typeof obj.updatedAt !== 'string' || Number.isNaN(Date.parse(obj.updatedAt))) return false;
  return true;
}

export async function loadIssueCheckpoint(
  controller: IssueCheckpointController,
): Promise<IssuePipelineCheckpoint> {
  if (!(await controller.store.has(controller.key))) {
    return {
      version: ISSUE_PIPELINE_CHECKPOINT_VERSION,
      issueNumber: controller.issueNumber,
      fingerprint: controller.fingerprint,
      stage: 'queued',
      updatedAt: controller.now().toISOString(),
      stages: {},
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse((await controller.store.get(controller.key)).toString('utf8'));
  } catch (error) {
    throw new IssuePipelineCheckpointError(
      `Checkpoint ${controller.key} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const parsed = issuePipelineCheckpointSchema.safeParse(raw);
  if (!parsed.success) {
    if (isLegacyIssueRunStatusShape(raw)) {
      if (
        raw.issueNumber !== controller.issueNumber ||
        raw.fingerprint !== controller.fingerprint
      ) {
        // Matches the identity-mismatch behavior below for valid-but-foreign
        // checkpoints: a legacy doc for a different issue/fingerprint is
        // never safe to reinitialize over.
        throw new IssuePipelineCheckpointError(
          `Checkpoint ${controller.key} belongs to a different issue request`,
        );
      }
      // Pre-checkpoint legacy status doc for THIS issue/fingerprint. Its own
      // completion state — even `stage: 'completed'` — is not a publishable
      // v1 result: the retired pipeline never wrote the per-stage artifact
      // references the new pipeline resumes from, and its output was never
      // published under the new schema. Discard it and reinitialize a fresh
      // v1 checkpoint so the request gets a full, safe re-run instead of
      // permanently deadlocking on `checkpoint-invalid`. This return value is
      // NOT persisted here — the caller's first `runCheckpointStage` call
      // durably overwrites the legacy blob at `controller.key`.
      return {
        version: ISSUE_PIPELINE_CHECKPOINT_VERSION,
        issueNumber: controller.issueNumber,
        fingerprint: controller.fingerprint,
        stage: 'queued',
        updatedAt: controller.now().toISOString(),
        stages: {},
      };
    }
    // Genuinely malformed/corrupt current-schema JSON (missing/renamed
    // fields, wrong `version`, wrong types, etc.) — fail closed exactly as
    // before. Do not weaken this path; only recognized legacy shapes above
    // are auto-recovered.
    throw new IssuePipelineCheckpointError(
      `Checkpoint ${controller.key} failed validation: ${parsed.error.message}`,
    );
  }
  if (
    parsed.data.issueNumber !== controller.issueNumber ||
    parsed.data.fingerprint !== controller.fingerprint
  ) {
    throw new IssuePipelineCheckpointError(
      `Checkpoint ${controller.key} belongs to a different issue request`,
    );
  }
  return parsed.data;
}

export async function writeIssueCheckpoint(
  controller: IssueCheckpointController,
  checkpoint: IssuePipelineCheckpoint,
): Promise<void> {
  await controller.store.put(
    controller.key,
    Buffer.from(`${JSON.stringify(issuePipelineCheckpointSchema.parse(checkpoint), null, 2)}\n`),
  );
}

export async function runCheckpointStage<T>(
  controller: IssueCheckpointController,
  stage: IssuePipelineStage,
  outputSchema: z.ZodType<T>,
  operation: (attempt: number) => Promise<T>,
  options: {
    readonly isTransient?: (error: unknown) => boolean;
    readonly maxAttempts?: number;
  } = {},
): Promise<RunCheckpointStageResult<T>> {
  let operationMs = 0;
  let orchestrationMs = 0;
  let invalidSamples = 0;
  const sample = (): number | null => {
    try {
      const value = controller.monotonicNow();
      if (Number.isFinite(value)) return value;
    } catch {
      // Timing is observational and must never change checkpoint behavior.
    }
    invalidSamples++;
    return null;
  };
  const addElapsed = (kind: 'operation' | 'orchestration', startedAt: number | null): void => {
    if (startedAt === null) return;
    let completedAt: number;
    try {
      completedAt = controller.monotonicNow();
    } catch {
      invalidSamples++;
      return;
    }
    const elapsed = completedAt - startedAt;
    if (!Number.isFinite(elapsed) || elapsed < 0) {
      invalidSamples++;
      return;
    }
    if (kind === 'operation') operationMs += elapsed;
    else orchestrationMs += elapsed;
  };

  const loadStartedAt = sample();
  let checkpoint = await loadIssueCheckpoint(controller);
  addElapsed('orchestration', loadStartedAt);
  const baseTiming = readCheckpointTiming(checkpoint);
  const prior = checkpoint.stages[stage];
  if (prior?.status === 'completed') {
    const parseStartedAt = sample();
    let parsed: ReturnType<typeof outputSchema.safeParse>;
    try {
      parsed = outputSchema.safeParse(prior.output);
    } finally {
      addElapsed('orchestration', parseStartedAt);
    }
    if (!parsed.success) {
      throw new IssuePipelineCheckpointError(
        `Completed stage ${stage} has invalid output: ${parsed.error.message}`,
      );
    }
    return { output: parsed.data, resumed: true };
  }

  const maxAttempts = options.maxAttempts ?? ISSUE_PIPELINE_MAX_STAGE_ATTEMPTS;
  const isTransient = options.isTransient ?? isTransientPipelineError;
  let attempts = prior?.attempts ?? 0;
  if (attempts >= maxAttempts) {
    throw new IssuePipelineCheckpointError(
      `Stage ${stage} already exhausted its ${maxAttempts} attempts`,
    );
  }

  while (attempts < maxAttempts) {
    attempts++;
    const startedAt = controller.now().toISOString();
    checkpoint = {
      ...checkpoint,
      stage,
      updatedAt: startedAt,
      stages: {
        ...checkpoint.stages,
        [stage]: {
          status: 'running',
          attempts,
          updatedAt: startedAt,
        },
      },
    };
    const runningWriteStartedAt = sample();
    await writeIssueCheckpoint(controller, checkpoint);
    addElapsed('orchestration', runningWriteStartedAt);

    try {
      const operationStartedAt = sample();
      let rawOutput: unknown;
      try {
        rawOutput = await operation(attempts);
      } finally {
        addElapsed('operation', operationStartedAt);
      }
      const parseStartedAt = sample();
      let output: T;
      try {
        output = outputSchema.parse(rawOutput);
      } finally {
        addElapsed('orchestration', parseStartedAt);
      }
      const completedAt = controller.now().toISOString();
      checkpoint = {
        ...checkpoint,
        stage,
        updatedAt: completedAt,
        stages: {
          ...checkpoint.stages,
          [stage]: {
            status: 'completed',
            attempts,
            updatedAt: completedAt,
            output,
          },
        },
      };
      checkpoint = withCheckpointTiming(checkpoint);
      await writeIssueCheckpoint(controller, checkpoint);
      return { output, resumed: false };
    } catch (error) {
      const failedAt = controller.now().toISOString();
      checkpoint = {
        ...checkpoint,
        stage,
        updatedAt: failedAt,
        stages: {
          ...checkpoint.stages,
          [stage]: {
            status: 'failed',
            attempts,
            updatedAt: failedAt,
            error: {
              kind: errorKind(error),
              message: error instanceof Error ? error.message : String(error),
            },
          },
        },
      };
      checkpoint = withCheckpointTiming(checkpoint);
      await writeIssueCheckpoint(controller, checkpoint);
      if (!isTransient(error) || attempts >= maxAttempts) throw error;
    }
  }

  throw new IssuePipelineCheckpointError(`Stage ${stage} did not produce an output`);

  function withCheckpointTiming(value: IssuePipelineCheckpoint): IssuePipelineCheckpoint {
    const priorStage = baseTiming.stages[stage];
    const stageOperationMs = (priorStage?.operationMs ?? 0) + operationMs;
    const stageOrchestrationMs = (priorStage?.orchestrationMs ?? 0) + orchestrationMs;
    const stages = {
      ...baseTiming.stages,
      [stage]: {
        operationMs: stageOperationMs,
        orchestrationMs: stageOrchestrationMs,
        totalMs: stageOperationMs + stageOrchestrationMs,
      },
    };
    const timing: IssueCheckpointTiming = {
      stages,
      totalMs: Object.values(stages).reduce((total, entry) => total + (entry?.totalMs ?? 0), 0),
      invalidSamples: baseTiming.invalidSamples + invalidSamples,
    };
    return {
      ...value,
      details: {
        ...value.details,
        [CHECKPOINT_TIMING_DETAILS_KEY]: timing,
      },
    };
  }
}

export function readCheckpointTiming(checkpoint: IssuePipelineCheckpoint): IssueCheckpointTiming {
  const empty: IssueCheckpointTiming = { totalMs: 0, stages: {}, invalidSamples: 0 };
  const raw = checkpoint.details?.[CHECKPOINT_TIMING_DETAILS_KEY];
  const parsed = issueCheckpointTimingSchema.safeParse(raw);
  return parsed.success ? parsed.data : empty;
}

/**
 * Error kinds that are safe to auto-reset after an infrastructure fix.
 *
 * Only a strict subset of transient kinds qualify — kinds that are EXCLUSIVELY
 * the result of infrastructure failures (push loop exhausted) rather than
 * operational failures (auth, permissions, network) that share the same kind
 * string. Specifically:
 *
 * - `push-retries-exhausted` — the push retry loop was exhausted due to a
 *   non-fast-forward rejection; unambiguously an infrastructure issue.
 *
 * `null` (unknown/unclassified) is intentionally excluded: `runCheckpointStage`
 * records `null` for ANY untyped exception, including JSON/Zod/invariant
 * failures from `reconcileCanonicalPr`. Auto-resetting a `null`-kind failure
 * would cause a deterministic bug to be retried forever.
 *
 * `git-failed` is intentionally excluded: `QueueCommitError('git-failed')` is
 * also thrown for authentication, permission, and network failures that should
 * NOT be silently reset on every workflow run.
 */
const INFRA_RESETTABLE_KINDS = new Set<string>(['push-retries-exhausted']);

/**
 * If `stage` is exhausted (attempts ≥ maxAttempts) **and** its last recorded
 * error was transient (not in PERMANENT_ERROR_KINDS), this removes the stage
 * entry from the checkpoint so the next `runCheckpointStage` call can retry
 * from a clean control-flow slate. Historical timing remains cumulative across
 * resets so operators can see the full cost of the logical stage.
 *
 * Returns `true` when a reset was performed, `false` when no reset was needed
 * (stage not present, still in-flight, succeeded, or failed permanently).
 *
 * Recovery path for stages that hit their retry ceiling due to infrastructure
 * bugs that have since been fixed — e.g. queue-commit push failures (bugs #1–3)
 * that caused the `publish` stage to exhaust all three attempts before the
 * underlying git defect was repaired. Calling this for a stage whose failure
 * was permanent (auth, destination-conflict, etc.) is safe: it is a no-op.
 */
export async function resetExhaustedTransientStage(
  controller: IssueCheckpointController,
  stage: IssuePipelineStage,
  maxAttempts = ISSUE_PIPELINE_MAX_STAGE_ATTEMPTS,
): Promise<boolean> {
  const checkpoint = await loadIssueCheckpoint(controller);
  const prior = checkpoint.stages[stage];
  const errorKind = prior?.error?.kind ?? null;
  if (
    prior === undefined ||
    prior.status !== 'failed' ||
    prior.attempts < maxAttempts ||
    errorKind === null ||
    !INFRA_RESETTABLE_KINDS.has(errorKind)
  ) {
    return false;
  }
  // Build a new stages map without the exhausted entry.
  const remainingStages = Object.fromEntries(
    Object.entries(checkpoint.stages).filter(([k]) => k !== stage),
  ) as IssuePipelineCheckpoint['stages'];
  await writeIssueCheckpoint(controller, { ...checkpoint, stages: remainingStages });
  return true;
}

export async function markIssuePipelineTerminal(
  controller: IssueCheckpointController,
  outcome: 'selected-pending-publish' | 'quality-stopped' | 'published',
  details: Record<string, unknown>,
): Promise<void> {
  const checkpoint = await loadIssueCheckpoint(controller);
  const updatedAt = controller.now().toISOString();
  await writeIssueCheckpoint(controller, {
    ...checkpoint,
    stage: 'completed',
    updatedAt,
    details: {
      ...checkpoint.details,
      outcome,
      ...details,
    },
  });
}

const PERMANENT_ERROR_KINDS = new Set([
  'auth',
  'request-error',
  'brief-not-found',
  'checkpoint-invalid',
  'ci-refused',
  'destination-conflict',
  'invalid-asset-path',
  'invalid-brief-path',
  'run-not-found',
  'summary-invalid',
  'variant-count-mismatch',
]);

export function isTransientPipelineError(error: unknown): boolean {
  const kind = errorKind(error);
  return kind === null || !PERMANENT_ERROR_KINDS.has(kind);
}

function errorKind(error: unknown): string | null {
  const kind = (error as { readonly kind?: unknown } | null | undefined)?.kind;
  return typeof kind === 'string' ? kind : null;
}
