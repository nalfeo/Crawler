import { z } from 'zod';
import { ISSUE_STATUS_KEY_PREFIX } from './sidecar/issue-ingester-controller.js';
import type { RunStore } from './store/types.js';

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
}

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
}): IssueCheckpointController {
  return {
    store: options.store,
    key: issueCheckpointKey(options.issueNumber, options.fingerprint),
    issueNumber: options.issueNumber,
    fingerprint: options.fingerprint,
    now: options.now ?? (() => new Date()),
  };
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
  let checkpoint = await loadIssueCheckpoint(controller);
  const prior = checkpoint.stages[stage];
  if (prior?.status === 'completed') {
    const parsed = outputSchema.safeParse(prior.output);
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
    await writeIssueCheckpoint(controller, checkpoint);

    try {
      const output = outputSchema.parse(await operation(attempts));
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
      await writeIssueCheckpoint(controller, checkpoint);
      if (!isTransient(error) || attempts >= maxAttempts) throw error;
    }
  }

  throw new IssuePipelineCheckpointError(`Stage ${stage} did not produce an output`);
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
