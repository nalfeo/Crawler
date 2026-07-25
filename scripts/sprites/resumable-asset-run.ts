import { z } from 'zod';
import { autoSelectVariants, type AutoSelectionRejectedDiagnostic } from './auto-selection.js';
import { loadStyleGuide } from './build-prompt.js';
import { generateOne } from './generate-one.js';
import type { IssueCheckpointController } from './issue-pipeline-checkpoint.js';
import { runCheckpointStage } from './issue-pipeline-checkpoint.js';
import type { LoadedBrief } from './load-brief.js';
import { loadRecordedReferencePngs } from './load-reference-pngs.js';
import type { ImageProvider } from './provider/types.js';
import type { TextProvider } from './provider/text-types.js';
import type { VisionProvider } from './provider/vision-types.js';
import { loadRunSummary, rejudgeRun, repostprocessRun } from './rerun.js';
import type { RunSummary } from './run-artifacts.js';
import type { RunStore } from './store/types.js';

const runStageOutputSchema = z
  .object({
    briefId: z.string(),
    runId: z.string(),
    summaryPath: z.string(),
  })
  .strict();

const selectionOutputSchema = z
  .object({
    briefId: z.string(),
    runId: z.string(),
    selectedIndexes: z.array(z.number().int().nonnegative()).max(3),
    selectedAt: z.string(),
    rejected: z.array(
      z
        .object({
          entryIndex: z.number().int().nonnegative(),
          reason: z.enum([
            'missing-judge-scorecard',
            'hard-block-not-evaluated',
            'sensor-failures-exceeded',
            'hard-blocked',
          ]),
          sensorFailures: z.number().int().nonnegative(),
          judgeMinScore: z.number().nullable(),
          judgeConfidence: z.number().nullable(),
          hardBlockEvaluated: z.boolean(),
          hardBlocked: z.boolean(),
          hardBlockInstruction: z.string().nullable(),
          hardBlockRationale: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export interface ResumableAssetRunOptions {
  readonly checkpoint: IssueCheckpointController;
  readonly briefPath: string;
  readonly loaded: LoadedBrief;
  readonly repoRoot: string;
  readonly store: RunStore;
  readonly imageProvider: ImageProvider;
  readonly textProvider: TextProvider | null;
  readonly visionProvider: VisionProvider | null;
  readonly env: NodeJS.ProcessEnv;
  readonly now?: () => Date;
}

export interface ResumableAssetRunResult {
  readonly briefId: string;
  readonly runId: string;
  readonly summaryPath: string;
  readonly summary: RunSummary;
  readonly selectedIndexes: readonly number[];
  readonly selectedAt: string;
  readonly rejected: readonly AutoSelectionRejectedDiagnostic[];
}

export async function runResumableAssetRun(
  options: ResumableAssetRunOptions,
): Promise<ResumableAssetRunResult> {
  const now = options.now ?? (() => new Date());
  const generated = await runCheckpointStage(
    options.checkpoint,
    'generate',
    runStageOutputSchema,
    async () => {
      const result = await generateOne({
        briefPath: options.briefPath,
        provider: options.imageProvider,
        textProvider: options.textProvider,
        repoRoot: options.repoRoot,
        store: options.store,
        maxAttempts: 1,
      });
      return {
        briefId: result.summary.brief,
        runId: result.summary.runId,
        summaryPath: result.summaryPath,
      };
    },
  );

  const postprocessed = await runCheckpointStage(
    options.checkpoint,
    'postprocess',
    runStageOutputSchema,
    async () => {
      const summary = await loadRunSummary(
        options.store,
        generated.output.briefId,
        generated.output.runId,
      );
      const result = await repostprocessRun({
        store: options.store,
        briefId: generated.output.briefId,
        runId: generated.output.runId,
        summary,
        brief: options.loaded.brief,
        palette: options.loaded.palette,
      });
      return {
        briefId: generated.output.briefId,
        runId: generated.output.runId,
        summaryPath: result.summaryPath,
      };
    },
  );

  const judged = await runCheckpointStage(
    options.checkpoint,
    'judge',
    runStageOutputSchema,
    async () => {
      if (!options.visionProvider) {
        throw new Error('Asset-request auto-selection requires a configured vision provider');
      }
      const summary = await loadRunSummary(
        options.store,
        postprocessed.output.briefId,
        postprocessed.output.runId,
      );
      const result = await rejudgeRun({
        store: options.store,
        briefId: postprocessed.output.briefId,
        runId: postprocessed.output.runId,
        summary,
        brief: options.loaded.brief,
        referencePngs: loadRecordedReferencePngs({
          summary,
          repoRoot: options.repoRoot,
        }),
        styleGuide: loadStyleGuide(options.repoRoot),
        visionProvider: options.visionProvider,
        force: true,
        env: options.env,
      });
      return {
        briefId: postprocessed.output.briefId,
        runId: postprocessed.output.runId,
        summaryPath: result.summaryPath,
      };
    },
  );

  const selected = await runCheckpointStage(
    options.checkpoint,
    'select-variants',
    selectionOutputSchema,
    async () => {
      const summary = await loadRunSummary(
        options.store,
        judged.output.briefId,
        judged.output.runId,
      );
      const selection = autoSelectVariants(summary.candidates);
      return {
        briefId: judged.output.briefId,
        runId: judged.output.runId,
        selectedIndexes: selection.selected.map((entry) => entry.index),
        selectedAt: now().toISOString(),
        rejected: selection.rejected,
      };
    },
  );

  return {
    briefId: judged.output.briefId,
    runId: judged.output.runId,
    summaryPath: judged.output.summaryPath,
    summary: await loadRunSummary(options.store, judged.output.briefId, judged.output.runId),
    selectedIndexes: selected.output.selectedIndexes,
    selectedAt: selected.output.selectedAt,
    rejected: selected.output.rejected,
  };
}
