import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { SPRITE_TYPES, type Brief } from './brief-schema.js';
import { runFull } from './run-full.js';
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
import { ISSUE_STATUS_KEY_PREFIX } from './sidecar/issue-ingester-controller.js';

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
  const spriteType = request.type || inferSpriteTypeFromName(request.name);
  const synth = await synthesizeBrief({
    name: request.name,
    briefHint: request.briefSentence,
    type: spriteType as Brief['type'],
    floor: request.floor ?? 1,
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
  await comment(
    `✅ Asset-request pipeline complete.\n\n` +
      `- brief: \`${result.summary.brief}\`\n` +
      `- run: \`${result.summary.runId}\`\n` +
      `- summary: \`${result.summaryPath}\``,
  );
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
