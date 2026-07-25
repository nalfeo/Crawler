import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { SPRITE_TYPES, type Brief } from './brief-schema.js';
import type { GenerateOneResult } from './generate-one.js';
import { synthesizeBrief } from './synthesize-brief.js';
import type { IssueAssetRequest } from './queue/types.js';
import type { ImageProvider } from './provider/types.js';
import type { TextProvider } from './provider/text-types.js';
import type { SynthProvider } from './provider/synth-types.js';
import type { BriefSelectorProvider } from './provider/brief-selector-types.js';
import type { VisionProvider } from './provider/vision-types.js';
import { loadBrief } from './load-brief.js';
import type { RunStore } from './store/types.js';
import { briefDirectoryForType } from './brief-paths.js';
import { mirrorBriefToStore } from './brief-durability.js';
import { resolveAssetRequestSizeVariant, resolveAssetRequestMobRole } from './asset-request.js';
import {
  createIssueCheckpointController,
  markIssuePipelineTerminal,
  runCheckpointStage,
} from './issue-pipeline-checkpoint.js';
import { runResumableAssetRun } from './resumable-asset-run.js';

export interface IssuePipelineIssueApi {
  comment(issueNumber: number, body: string): Promise<void>;
}

export interface RunIssuePipelineOptions {
  readonly request: IssueAssetRequest;
  readonly repoRoot: string;
  readonly store: RunStore;
  readonly imageProvider: ImageProvider;
  readonly textProvider: TextProvider | null;
  readonly synthProvider: SynthProvider;
  readonly briefSelectorProvider: BriefSelectorProvider;
  readonly visionProvider: VisionProvider | null;
  readonly issueApi: IssuePipelineIssueApi;
  /**
   * When false, suppress the intermediate progress comments (synthesize /
   * select / promote) posted during a run. The terminal success summary comment
   * is unaffected, as is the worker's failure comment. The worker sets this
   * false on redeliveries (dequeueCount > 1) so a transient failure that recurs
   * cannot re-post the same progress updates on every retry. Defaults to true.
   */
  readonly postProgressComments?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

const synthesizedCandidateSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    description: z.string(),
    embellishmentSeeds: z.array(z.string()),
    synthesisRationale: z.string(),
    yaml: z.string(),
  })
  .strict();

const synthesisOutputSchema = z
  .object({
    name: z.string(),
    type: z.enum(SPRITE_TYPES),
    sizeVariant: z.string(),
    providerLabel: z.string(),
    promptHash: z.string(),
    candidates: z.array(synthesizedCandidateSchema).min(1),
  })
  .strict();

const briefSelectionOutputSchema = z
  .object({
    selectedIndex: z.number().int().nonnegative(),
    rationale: z.string(),
    modelDeployment: z.string(),
    candidate: synthesizedCandidateSchema,
  })
  .strict();

const promotionOutputSchema = z
  .object({
    briefId: z.string(),
    briefPath: z.string(),
    yaml: z.string(),
    synthModel: z.string(),
    selectorModel: z.string(),
  })
  .strict();

/**
 * Infer sprite type from asset name using common naming patterns.
 * Falls back to 'character' if the pattern is not recognized.
 */
function inferSpriteTypeFromName(name: string): Brief['type'] {
  const lowerName = name.toLowerCase();

  // Explicit type prefixes in the asset name
  for (const type of SPRITE_TYPES) {
    if (lowerName.startsWith(`${type}-`)) {
      return type;
    }
  }

  // Pattern matching for common naming conventions
  if (lowerName.startsWith('ability-') || lowerName.includes('-icon')) {
    return 'item';
  }

  // Default guess based on heuristics
  if (lowerName.includes('lichen') || lowerName.includes('plant') || lowerName.includes('rock')) {
    return 'tile';
  }

  return 'character';
}

export async function runIssuePipeline(options: RunIssuePipelineOptions): Promise<{
  readonly briefId: string;
  readonly runId: string;
  readonly summaryPath: string;
  readonly selectedIndexes: readonly number[];
  readonly outcome: 'selected-pending-publish' | 'quality-stopped';
}> {
  const { request } = options;
  const now = () => new Date();
  const checkpoint = createIssueCheckpointController({
    store: options.store,
    issueNumber: request.issueNumber,
    fingerprint: request.fingerprint,
    now,
  });
  const comment = (text: string) => options.issueApi.comment(request.issueNumber, text);
  // Progress comments show live pipeline status. They are suppressed on
  // redeliveries (see postProgressComments) so a transient failure that recurs
  // does not re-post the same updates on every natural retry; terminal comments
  // (success summary here, failure comment in the worker) always post.
  const postProgress = options.postProgressComments !== false;
  const progressComment = (text: string): Promise<void> =>
    postProgress ? comment(text) : Promise.resolve();

  const sizeVariant = resolveAssetRequestSizeVariant(request);
  const mobRole = resolveAssetRequestMobRole(request);
  // Resolve mobRole first: a type-omitted boss request (e.g. "countess-boss")
  // must synthesize as 'enemy', not 'character', so the boss prompt and
  // boss_presence judge axis are activated.
  const spriteType =
    request.type || (mobRole === 'boss' ? 'enemy' : inferSpriteTypeFromName(request.name));
  const synthesis = await runCheckpointStage(
    checkpoint,
    'synthesize',
    synthesisOutputSchema,
    async () => {
      await progressComment(
        `🧪 Started asset-request pipeline for \`${request.name}\`.\n\nStage: synthesize`,
      );
      const result = await synthesizeBrief({
        name: request.name,
        briefHint: request.briefSentence,
        type: spriteType as Brief['type'],
        floor: request.floor ?? 1,
        sizeVariant,
        ...(mobRole ? { mobRole } : {}),
        candidates: 3,
        partial: true,
        provider: options.synthProvider,
        repoRoot: options.repoRoot,
        env: options.env ?? process.env,
      });
      if (result.written.length === 0) {
        throw new Error(`No synthesized candidates were written for issue #${request.issueNumber}`);
      }
      return {
        name: result.name,
        type: result.type,
        sizeVariant: result.sizeVariant,
        providerLabel: result.providerLabel,
        promptHash: result.promptHash,
        candidates: result.written.map((candidate) => ({
          id: candidate.id,
          type: candidate.type,
          description: candidate.description,
          embellishmentSeeds: [...candidate.embellishmentSeeds],
          synthesisRationale: candidate.synthesisRationale,
          yaml: readFileSync(candidate.yamlPath, 'utf8'),
        })),
      };
    },
  );

  const briefSelection = await runCheckpointStage(
    checkpoint,
    'select-brief',
    briefSelectionOutputSchema,
    async () => {
      const selected = await options.briefSelectorProvider.selectBrief({
        name: request.name,
        briefSentence: request.briefSentence,
        floor: request.floor ?? 1,
        candidates: synthesis.output.candidates.map((candidate, index) => ({
          index,
          description: candidate.description,
        })),
      });
      const candidate = synthesis.output.candidates[selected.index];
      if (!candidate) {
        throw new Error(`Brief selector picked out-of-range index ${selected.index}`);
      }
      await progressComment(
        `🧠 Selected candidate ${selected.index + 1}/${synthesis.output.candidates.length} ` +
          `using \`${selected.modelDeployment}\`: ${selected.rationale}`,
      );
      return {
        selectedIndex: selected.index,
        rationale: selected.rationale,
        modelDeployment: selected.modelDeployment,
        candidate,
      };
    },
  );

  const promotion = await runCheckpointStage(
    checkpoint,
    'promote',
    promotionOutputSchema,
    async () => {
      const promotedRel = path
        .join(
          'briefs',
          'draft',
          briefDirectoryForType(synthesis.output.type),
          `${synthesis.output.name}.yaml`,
        )
        .replace(/\\/g, '/');
      const promotedAbs = path.resolve(options.repoRoot, promotedRel);
      mkdirSync(path.dirname(promotedAbs), { recursive: true });
      writeFileSync(promotedAbs, briefSelection.output.candidate.yaml, 'utf8');
      enableJudge(promotedAbs, options.repoRoot, options.visionProvider !== null);
      await mirrorBriefToStore(options.store, options.repoRoot, promotedAbs);
      await progressComment(
        `📌 Promoted brief to \`${promotedRel}\`.\n\nStage: generate → postprocess → judge`,
      );
      return {
        briefId: synthesis.output.name,
        briefPath: promotedRel,
        yaml: readFileSync(promotedAbs, 'utf8'),
        synthModel: synthesis.output.providerLabel,
        selectorModel: briefSelection.output.modelDeployment,
      };
    },
  );

  const promotedAbs = path.resolve(options.repoRoot, promotion.output.briefPath);
  mkdirSync(path.dirname(promotedAbs), { recursive: true });
  writeFileSync(promotedAbs, promotion.output.yaml, 'utf8');
  const loaded = loadBrief(promotedAbs, { projectRoot: options.repoRoot });

  const completedRun = await runResumableAssetRun({
    checkpoint,
    briefPath: promotedAbs,
    loaded,
    repoRoot: options.repoRoot,
    store: options.store,
    imageProvider: options.imageProvider,
    textProvider: options.textProvider,
    visionProvider: options.visionProvider,
    env: options.env ?? process.env,
    now,
  });

  await attachIssueMetadata(options.store, completedRun.briefId, completedRun.runId, {
    issueNumber: request.issueNumber,
    issueFingerprint: request.fingerprint,
    synthModel: promotion.output.synthModel,
    briefSelectorModel: promotion.output.selectorModel,
  });

  const finalResult: Pick<GenerateOneResult, 'summary' | 'summaryPath'> = {
    summary: completedRun.summary,
    summaryPath: completedRun.summaryPath,
  };
  const outcome =
    completedRun.selectedIndexes.length > 0 ? 'selected-pending-publish' : 'quality-stopped';
  await markIssuePipelineTerminal(checkpoint, outcome, {
    briefId: completedRun.briefId,
    runId: completedRun.runId,
    selectedIndexes: completedRun.selectedIndexes,
    selectedAt: completedRun.selectedAt,
    promotedBriefPath: promotion.output.briefPath,
    promotedBriefYaml: promotion.output.yaml,
  });

  await comment(
    buildCompletionComment(finalResult, options.store, completedRun.selectedIndexes, outcome),
  );
  return {
    briefId: completedRun.briefId,
    runId: completedRun.runId,
    summaryPath: completedRun.summaryPath,
    selectedIndexes: completedRun.selectedIndexes,
    outcome,
  };
}

function enableJudge(briefPath: string, repoRoot: string, enabled: boolean): void {
  const doc = parseYaml(readFileSync(briefPath, 'utf8')) as Record<string, unknown>;
  const judge = (doc['judge'] as Record<string, unknown> | undefined) ?? {};
  judge['enabled'] = enabled;
  if (typeof judge['maxVariants'] !== 'number') judge['maxVariants'] = 16;
  doc['judge'] = judge;
  writeFileSync(briefPath, stringifyYaml(doc), 'utf8');
  // Validate normalized brief after mutation.
  loadBrief(briefPath, { projectRoot: repoRoot });
}

async function attachIssueMetadata(
  store: RunStore,
  briefId: string,
  runId: string,
  metadata: {
    readonly issueNumber: number;
    readonly issueFingerprint: string;
    readonly synthModel: string;
    readonly briefSelectorModel: string;
  },
): Promise<void> {
  const key = `${briefId}/${runId}/issue-metadata.json`;
  await store.put(key, Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`));
  const summaryKey = `${briefId}/${runId}/summary.json`;
  if (await store.has(summaryKey)) {
    try {
      const summary = JSON.parse((await store.get(summaryKey)).toString('utf8')) as Record<
        string,
        unknown
      >;
      summary['modelDeployments'] = {
        ...(summary['modelDeployments'] && typeof summary['modelDeployments'] === 'object'
          ? (summary['modelDeployments'] as Record<string, unknown>)
          : {}),
        synth: metadata.synthModel,
        briefSelector: metadata.briefSelectorModel,
      };
      await store.put(summaryKey, Buffer.from(`${JSON.stringify(summary, null, 2)}\n`));
    } catch {
      // Keep sidecar metadata even if summary parsing fails.
    }
  }
}

/**
 * Build the terminal success comment posted to the asset-request issue when the
 * pipeline completes. The comment includes the brief/run metadata plus inline
 * Markdown image embeds for the completed spritesheet and the top-ranked
 * (chosen) variant so reviewers can inspect the art directly in the issue
 * without navigating to Azure Blob Storage.
 *
 * Image embed URLs prefer `store.resolveForExternalRead()` so private backends
 * (Azure) can return scoped signed URLs suitable for GitHub's image proxy.
 * Falls back to `store.resolve()` when the store has no external-read resolver.
 */
export function buildCompletionComment(
  result: Pick<GenerateOneResult, 'summary' | 'summaryPath'>,
  store: RunStore,
  selectedIndexes?: readonly number[],
  outcome: 'selected-pending-publish' | 'quality-stopped' = 'selected-pending-publish',
): string {
  const briefId = result.summary.brief;
  const runId = result.summary.runId;
  const resolveForComment = (key: string): string =>
    typeof store.resolveForExternalRead === 'function'
      ? store.resolveForExternalRead(key)
      : store.resolve(key);

  // The spritesheet file for the last generation attempt (0-indexed).
  const lastAttemptIndex = (result.summary.attempts ?? 1) - 1;
  const sheetFile = `sheet-${String(lastAttemptIndex).padStart(2, '0')}.png`;
  const sheetUrl = resolveForComment(`${briefId}/${runId}/${sheetFile}`);
  const legacyChosen = selectedIndexes === undefined ? result.summary.chosen : null;
  const displayedIndexes =
    selectedIndexes ??
    (legacyChosen === null || legacyChosen === undefined ? [] : [legacyChosen.index]);

  let body =
    `✅ Asset-request pipeline complete.\n\n` +
    `- brief: \`${briefId}\`\n` +
    `- run: \`${runId}\`\n` +
    `- summary: \`${result.summaryPath}\`\n` +
    (outcome === 'quality-stopped'
      ? `- selection: no acceptable variants; human intervention required (the sheet will not be regenerated)\n\n`
      : `- selected for publication: ${displayedIndexes.map((index) => `variant ${index + 1}`).join(', ')}\n\n`) +
    `### Spritesheet\n\n` +
    `![Spritesheet](${sheetUrl})`;

  for (const selectedIndex of displayedIndexes) {
    const selectedEntry = result.summary.candidates.find(
      (candidate) => candidate.index === selectedIndex,
    );
    if (selectedEntry?.processedPath) {
      const variantNum = selectedIndex + 1;
      const total = result.summary.variantCount;
      const altText =
        `Selected variant ${variantNum}/${total} ` +
        `(sensor failures ${selectedEntry.outOf - selectedEntry.score})`;
      const processedFile = `${String(selectedIndex).padStart(2, '0')}.png`;
      const processedUrl = resolveForComment(`${briefId}/${runId}/processed/${processedFile}`);
      if (legacyChosen?.index === selectedIndex) {
        const passLabel = legacyChosen.combinedPassed ? '✅' : '⚠️';
        const legacyAlt =
          `Chosen variant ${variantNum}/${total} ` +
          `(score ${legacyChosen.score}/${legacyChosen.outOf}) ${passLabel}`;
        body += `\n\n### Chosen variant (${variantNum}/${total})\n\n![${legacyAlt}](${processedUrl})`;
      } else {
        body += `\n\n### Selected variant (${variantNum}/${total})\n\n![${altText}](${processedUrl})`;
      }
    }
  }

  return body;
}
