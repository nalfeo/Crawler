import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { SPRITE_TYPES, type Brief } from './brief-schema.js';
import { runFull, type RunFullResult } from './run-full.js';
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
import { ISSUE_STATUS_KEY_PREFIX } from './sidecar/issue-ingester-controller.js';
import { resolveAssetRequestSizeVariant, resolveAssetRequestMobRole } from './asset-request.js';

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

interface IssueRunStatus {
  readonly issueNumber: number;
  readonly fingerprint: string;
  readonly stage: string;
  readonly updatedAt: string;
  readonly details?: Record<string, unknown>;
}

const ISSUE_STATUS_PREFIX = ISSUE_STATUS_KEY_PREFIX;

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
}> {
  const { request } = options;
  const now = () => new Date().toISOString();
  const statusKey = `${ISSUE_STATUS_PREFIX}/${request.issueNumber}-${request.fingerprint}.json`;
  const setStatus = async (stage: string, details?: Record<string, unknown>): Promise<void> => {
    const doc: IssueRunStatus = {
      issueNumber: request.issueNumber,
      fingerprint: request.fingerprint,
      stage,
      updatedAt: now(),
      ...(details ? { details } : {}),
    };
    await options.store.put(statusKey, Buffer.from(`${JSON.stringify(doc, null, 2)}\n`));
  };
  const comment = (text: string) => options.issueApi.comment(request.issueNumber, text);
  // Progress comments show live pipeline status. They are suppressed on
  // redeliveries (see postProgressComments) so a transient failure that recurs
  // does not re-post the same updates on every natural retry; terminal comments
  // (success summary here, failure comment in the worker) always post.
  const postProgress = options.postProgressComments !== false;
  const progressComment = (text: string): Promise<void> =>
    postProgress ? comment(text) : Promise.resolve();

  await setStatus('synthesizing');
  await progressComment(
    `🧪 Started asset-request pipeline for \`${request.name}\`.\n\nStage: synthesize`,
  );
  const sizeVariant = resolveAssetRequestSizeVariant(request);
  const mobRole = resolveAssetRequestMobRole(request);
  // Resolve mobRole first: a type-omitted boss request (e.g. "countess-boss")
  // must synthesize as 'enemy', not 'character', so the boss prompt and
  // boss_presence judge axis are activated.
  const spriteType =
    request.type || (mobRole === 'boss' ? 'enemy' : inferSpriteTypeFromName(request.name));
  const synth = await synthesizeBrief({
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
  if (synth.written.length === 0) {
    throw new Error(`No synthesized candidates were written for issue #${request.issueNumber}`);
  }

  await setStatus('selecting-brief');
  const selected = await options.briefSelectorProvider.selectBrief({
    name: request.name,
    briefSentence: request.briefSentence,
    floor: request.floor ?? 1,
    candidates: synth.written.map((c, idx) => ({ index: idx, description: c.description })),
  });
  const winner = synth.written[selected.index];
  if (!winner) {
    throw new Error(`Brief selector picked out-of-range index ${selected.index}`);
  }
  await progressComment(
    `🧠 Selected candidate ${selected.index + 1}/${synth.written.length} ` +
      `using \`${selected.modelDeployment}\`: ${selected.rationale}`,
  );

  await setStatus('promoting-brief', {
    selectedIndex: selected.index,
    synthModel: synth.providerLabel,
    selectorModel: selected.modelDeployment,
  });
  const promotedRel = path.join(
    'briefs',
    'draft',
    briefDirectoryForType(synth.type),
    `${synth.name}.yaml`,
  );
  const promotedAbs = path.resolve(options.repoRoot, promotedRel);
  mkdirSync(path.dirname(promotedAbs), { recursive: true });
  copyFileSync(winner.yamlPath, promotedAbs);
  const judgeEnabled = options.visionProvider !== null;
  enableJudge(promotedAbs, options.repoRoot, judgeEnabled);
  // Mirror the final promoted brief into Azure so the local sidecar can
  // load it after the CI runner (which wrote the file) shuts down.
  await mirrorBriefToStore(options.store, options.repoRoot, promotedAbs);

  await progressComment(
    `📌 Promoted brief to \`${promotedRel}\`.\n\nStage: generate → postprocess` +
      `${judgeEnabled ? ' → judge' : ' (judge disabled: no vision deployment configured)'}`,
  );
  await setStatus('running-pipeline', { briefPath: promotedRel });
  const result = await runFull({
    briefPath: promotedAbs,
    provider: options.imageProvider,
    textProvider: options.textProvider,
    visionProvider: options.visionProvider,
    repoRoot: options.repoRoot,
    store: options.store,
    env: options.env ?? process.env,
  });

  await attachIssueMetadata(options.store, result.summary.brief, result.summary.runId, {
    issueNumber: request.issueNumber,
    issueFingerprint: request.fingerprint,
    synthModel: synth.providerLabel,
    briefSelectorModel: selected.modelDeployment,
  });
  await setStatus('completed', { briefId: result.summary.brief, runId: result.summary.runId });

  const completionComment = buildCompletionComment(result, options.store);
  await comment(completionComment);
  return {
    briefId: result.summary.brief,
    runId: result.summary.runId,
    summaryPath: result.summaryPath,
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
export function buildCompletionComment(result: RunFullResult, store: RunStore): string {
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

  let body =
    `✅ Asset-request pipeline complete.\n\n` +
    `- brief: \`${briefId}\`\n` +
    `- run: \`${runId}\`\n` +
    `- summary: \`${result.summaryPath}\`\n\n` +
    `### Spritesheet\n\n` +
    `![Spritesheet](${sheetUrl})`;

  // Embed the top-ranked (chosen) variant when the pipeline produced one.
  const chosen = result.summary.chosen;
  if (chosen !== null && chosen !== undefined) {
    const chosenEntry = result.summary.candidates.find((c) => c.index === chosen.index);
    if (chosenEntry?.processedPath) {
      const variantNum = chosen.index + 1;
      const total = result.summary.variantCount;
      const passLabel = chosen.combinedPassed ? '✅' : '⚠️';
      const altText = `Chosen variant ${variantNum}/${total} (score ${chosen.score}/${chosen.outOf}) ${passLabel}`;
      const processedFile = `${String(chosen.index).padStart(2, '0')}.png`;
      const processedUrl = resolveForComment(`${briefId}/${runId}/processed/${processedFile}`);
      body += `\n\n### Chosen variant (${variantNum}/${total})\n\n![${altText}](${processedUrl})`;
    }
  }

  return body;
}
