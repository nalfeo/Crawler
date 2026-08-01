import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { createLogger } from '../../src/shared/logger.js';
import { approveVariant } from './approve.js';
import type { CheckinAsset, Exec } from './checkin.js';
import { realExec } from './checkin-runtime.js';
import { shardPathForKey } from './generated-shards.js';
import {
  createIssueCheckpointController,
  isTransientPipelineError,
  issuePipelineCheckpointSchema,
  markIssuePipelineTerminal,
  resetExhaustedTransientStage,
  runCheckpointStage,
} from './issue-pipeline-checkpoint.js';
import { QueueCommitError, runQueueCommit } from './queue-commit.js';
import { createDefaultQueueCommitDeps } from './queue-commit-runtime.js';
import { ISSUE_STATUS_KEY_PREFIX } from './sidecar/issue-ingester-controller.js';
import type { RunStore } from './store/types.js';

const MANIFEST_REL = path.join('public', 'assets', 'generated', 'manifest.json');
const CATALOG_REL = path.join('src', 'shared', 'data', 'sprite-catalog.json');
const logger = createLogger('infra:sprites:asset-request-publisher');

const selectedDetailsSchema = z
  .object({
    outcome: z.literal('selected-pending-publish'),
    briefId: z.string(),
    runId: z.string(),
    selectedIndexes: z.array(z.number().int().nonnegative()).min(1).max(3),
    selectedAt: z.string(),
    promotedBriefPath: z.string(),
    promotedBriefYaml: z.string(),
  })
  .passthrough();

const publishOutputSchema = z
  .object({
    branch: z.string(),
    prNumber: z.number().int().positive(),
    publishedAt: z.string(),
  })
  .strict();

interface ReadyCheckpoint {
  readonly issueNumber: number;
  readonly fingerprint: string;
  readonly details: z.infer<typeof selectedDetailsSchema>;
}

interface PreparedPublish {
  readonly checkpoint: ReadyCheckpoint;
  readonly stageRoot: string;
  readonly assets: readonly CheckinAsset[];
}

interface PullRequestRef {
  readonly number: number;
  readonly url: string;
}

interface RequiredLabel {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

const REQUIRED_PUBLICATION_LABELS: readonly RequiredLabel[] = [
  {
    name: 'art-only',
    color: '7057ff',
    description: 'Generated art-only changes eligible for guarded promotion',
  },
];

export interface AssetRequestPublisherOptions {
  readonly repoRoot: string;
  readonly store: RunStore;
  readonly env?: NodeJS.ProcessEnv;
  readonly exec?: Exec;
  readonly now?: () => Date;
}

export async function publishSelectedAssetRequests(
  options: AssetRequestPublisherOptions,
): Promise<{ published: number; skipped: number }> {
  const env = options.env ?? process.env;
  const exec = options.exec ?? realExec;
  const now = options.now ?? (() => new Date());
  const ready = await discoverReadyCheckpoints(options.store);
  const prepared: PreparedPublish[] = [];

  try {
    for (const checkpoint of ready) {
      prepared.push(await prepareCheckpoint(options.repoRoot, options.store, checkpoint));
    }
    try {
      await validatePreparedTargets(prepared);
    } catch (error) {
      throw new QueueCommitError(
        'destination-conflict',
        error instanceof Error ? error.message : String(error),
      );
    }
    await ensureRequiredPublicationLabels(exec, options.repoRoot);

    const pendingTerminal: Array<{
      controller: ReturnType<typeof createIssueCheckpointController>;
      output: z.infer<typeof publishOutputSchema>;
    }> = [];
    let published = 0;
    let skipped = 0;
    for (const item of prepared) {
      const controller = createIssueCheckpointController({
        store: options.store,
        issueNumber: item.checkpoint.issueNumber,
        fingerprint: item.checkpoint.fingerprint,
        now,
      });
      // If the publish stage exhausted all its attempts on transient failures
      // (e.g. git push bugs fixed between runs), clear the attempt record so
      // runCheckpointStage can retry from scratch. Permanent failures (auth,
      // destination-conflict, etc.) are left untouched.
      const wasPublishReset = await resetExhaustedTransientStage(controller, 'publish');
      if (wasPublishReset) {
        logger.info(
          `issue #${item.checkpoint.issueNumber}: reset transient-exhausted publish stage; will retry`,
        );
      }
      const result = await runCheckpointStage(
        controller,
        'publish',
        publishOutputSchema,
        async () => {
          try {
            await validateCurrentMain(options.repoRoot, item.stageRoot, item.assets, exec);
          } catch (error) {
            if (error instanceof QueueCommitError) throw error;
            throw new QueueCommitError(
              'destination-conflict',
              error instanceof Error ? error.message : String(error),
            );
          }
          const queueResult = await runQueueCommit(
            options.repoRoot,
            item.assets,
            createDefaultQueueCommitDeps(options.repoRoot, env),
            {
              message: `art: publish issue #${item.checkpoint.issueNumber} selected variants`,
              maxAttempts: 3,
              sourceRoot: item.stageRoot,
              briefs: [item.checkpoint.details.promotedBriefPath],
              ciAuthorization: { caller: 'asset-request-publisher' },
              validateDestination: validateExactAssetPayloads,
            },
          );

          const pr = await reconcileCanonicalPr(exec, options.repoRoot, env);
          return {
            branch: queueResult.branch,
            prNumber: pr.number,
            publishedAt: now().toISOString(),
          };
        },
        { isTransient: isTransientPipelineError },
      );
      if (result.resumed) skipped++;
      else published++;
      pendingTerminal.push({ controller, output: result.output });
    }
    // All items succeeded — write terminal marks atomically after the loop so a
    // mid-batch conflict does not strand earlier items with a stale published state.
    for (const { controller, output } of pendingTerminal) {
      await markIssuePipelineTerminal(controller, 'published', {
        publishedAt: output.publishedAt,
        branch: output.branch,
        prNumber: output.prNumber,
      });
    }
    return { published, skipped };
  } catch (error) {
    if (error instanceof QueueCommitError && error.kind === 'destination-conflict') {
      await closeCanonicalPrOnConflict(exec, options.repoRoot, error);
    }
    throw error;
  } finally {
    for (const item of prepared) {
      rmSync(item.stageRoot, { recursive: true, force: true });
    }
  }
}

export async function discoverReadyCheckpoints(store: RunStore): Promise<ReadyCheckpoint[]> {
  const keys = await store.list(ISSUE_STATUS_KEY_PREFIX, { authoritative: true });
  const ready: ReadyCheckpoint[] = [];
  for (const key of keys.filter((candidate) => candidate.endsWith('.json')).sort()) {
    let raw: unknown;
    try {
      raw = JSON.parse((await store.get(key)).toString('utf8'));
    } catch (error) {
      logger.warn(
        `Skipping malformed asset-request checkpoint ${key}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }
    const parsed = issuePipelineCheckpointSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn(`Skipping invalid asset-request checkpoint ${key}: ${parsed.error.message}`);
      continue;
    }
    if (parsed.data.stage !== 'completed') continue;
    if (parsed.data.details?.['outcome'] === 'published') continue;
    const details = selectedDetailsSchema.safeParse(parsed.data.details);
    if (!details.success) continue;
    ready.push({
      issueNumber: parsed.data.issueNumber,
      fingerprint: parsed.data.fingerprint,
      details: details.data,
    });
  }
  return ready;
}

async function prepareCheckpoint(
  repoRoot: string,
  store: RunStore,
  checkpoint: ReadyCheckpoint,
): Promise<PreparedPublish> {
  const stageRoot = mkdtempSync(path.join(tmpdir(), 'crawler-asset-publish-'));
  try {
    const sourceGenerated = path.join(repoRoot, 'public', 'assets', 'generated');
    if (existsSync(sourceGenerated)) {
      cpSync(sourceGenerated, path.join(stageRoot, 'public', 'assets', 'generated'), {
        recursive: true,
      });
    }
    const sourceCatalog = path.join(repoRoot, CATALOG_REL);
    const stageCatalog = path.join(stageRoot, CATALOG_REL);
    mkdirSync(path.dirname(stageCatalog), { recursive: true });
    copyFileSync(sourceCatalog, stageCatalog);

    const briefPath = path.join(stageRoot, checkpoint.details.promotedBriefPath);
    mkdirSync(path.dirname(briefPath), { recursive: true });
    writeFileSync(briefPath, checkpoint.details.promotedBriefYaml, 'utf8');

    const runPrefix = `${checkpoint.details.briefId}/${checkpoint.details.runId}/`;
    const runDir = path.join(
      stageRoot,
      'generated',
      'runs',
      checkpoint.details.briefId,
      checkpoint.details.runId,
    );
    const runKeys = await store.list(runPrefix, { authoritative: true });
    if (runKeys.length === 0) {
      throw new Error(`No stored run artifacts found under ${runPrefix}`);
    }
    for (const key of runKeys) {
      const relative = key.slice(runPrefix.length);
      const destination = path.join(runDir, ...relative.split('/'));
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, await store.get(key));
    }

    const assets: CheckinAsset[] = [];
    for (const variantIndex of checkpoint.details.selectedIndexes) {
      const entry = approveVariant({
        runDir,
        variantIndex,
        manifestPath: path.join(stageRoot, MANIFEST_REL),
        catalogPath: path.join(stageRoot, CATALOG_REL),
        publicAssetsDir: path.join(stageRoot, 'public', 'assets'),
        repoRoot: stageRoot,
        now: () => new Date(checkpoint.details.selectedAt),
        allowReapprove: true,
        sourceRunOverride: `generated/runs/${checkpoint.details.briefId}/${checkpoint.details.runId}`,
      });
      assets.push({
        assetPath: entry.assetPath,
        manifestKey: entry.spriteName,
        briefId: entry.briefId,
        variantIndex: entry.variantIndex,
      });
    }
    return { checkpoint, stageRoot, assets };
  } catch (error) {
    rmSync(stageRoot, { recursive: true, force: true });
    throw error;
  }
}

async function validatePreparedTargets(items: readonly PreparedPublish[]): Promise<void> {
  const firstByKey = new Map<string, PreparedPublish>();
  for (const item of items) {
    for (const asset of item.assets) {
      const key = asset.manifestKey;
      if (!key) continue;
      const prior = firstByKey.get(key);
      if (!prior) {
        firstByKey.set(key, item);
        continue;
      }
      await validateExactAssetPayloads(prior.stageRoot, item.stageRoot, [asset]);
    }
  }
}

export async function validateExactAssetPayloads(
  sourceRoot: string,
  destinationRoot: string,
  assets: readonly CheckinAsset[],
): Promise<void> {
  const sourceGeneratedDir = path.join(sourceRoot, 'public', 'assets', 'generated');
  const destinationGeneratedDir = path.join(destinationRoot, 'public', 'assets', 'generated');

  for (const asset of assets) {
    const key = asset.manifestKey;
    if (!key) continue;
    const sourceShardPath = shardPathForKey(sourceGeneratedDir, key);
    if (!existsSync(sourceShardPath)) {
      throw new Error(`Source manifest shard ${key} is missing`);
    }
    const sourceEntry = readJson(sourceShardPath);
    const sourcePng = path.join(sourceRoot, 'public', 'assets', ...asset.assetPath.split('/'));
    if (!existsSync(sourcePng)) throw new Error(`Source PNG ${asset.assetPath} is missing`);

    const destinationShardPath = shardPathForKey(destinationGeneratedDir, key);
    const destinationShardExists = existsSync(destinationShardPath);
    const destinationEntry = destinationShardExists ? readJson(destinationShardPath) : undefined;
    const destinationPng = path.join(
      destinationRoot,
      'public',
      'assets',
      ...asset.assetPath.split('/'),
    );
    const destinationExists = destinationShardExists || existsSync(destinationPng);
    if (!destinationExists) continue;

    const exact =
      stableJson(sourceEntry) === stableJson(destinationEntry) &&
      existsSync(destinationPng) &&
      hashFile(sourcePng) === hashFile(destinationPng);
    if (!exact) {
      throw new Error(
        `Destination already contains conflicting payload for ${key}; refusing to overwrite it`,
      );
    }
  }
}

async function validateCurrentMain(
  repoRoot: string,
  sourceRoot: string,
  assets: readonly CheckinAsset[],
  exec: Exec,
): Promise<void> {
  const worktree = mkdtempSync(path.join(tmpdir(), 'crawler-publisher-main-'));
  const ref = `refs/asset-publisher/main-${path.basename(worktree)}`;
  try {
    await mustExec(exec, 'git', ['fetch', '--no-tags', 'origin', `+main:${ref}`], repoRoot);
    await mustExec(exec, 'git', ['worktree', 'add', worktree, '--detach', ref], repoRoot);
    await validateExactAssetPayloads(sourceRoot, worktree, assets);
  } finally {
    await exec('git', ['worktree', 'remove', worktree, '--force'], { cwd: repoRoot });
    await exec('git', ['update-ref', '-d', ref], { cwd: repoRoot });
    rmSync(worktree, { recursive: true, force: true });
  }
}

export async function reconcileCanonicalPr(
  exec: Exec,
  repoRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<PullRequestRef> {
  const open = await listCanonicalPrs(exec, repoRoot);
  if (open.length > 1) {
    throw new QueueCommitError(
      'destination-conflict',
      `Expected at most one open assets/queue PR, found ${open.length}`,
    );
  }
  const body =
    '## Generated art batch\n\n' +
    '- Automatically postprocessed, judged, and selected by the asset-request pipeline.\n' +
    '- Contains only generated PNGs and their per-asset manifest shards.\n' +
    '- Ready for human review; this workflow never auto-merges.\n\n' +
    `Workflow run: ${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${env.GITHUB_REPOSITORY ?? ''}/actions/runs/${env.GITHUB_RUN_ID ?? ''}`;

  if (open[0]) {
    await mustExec(
      exec,
      'gh',
      [
        'pr',
        'edit',
        String(open[0].number),
        '--title',
        'art: publish generated sprite assets',
        '--body',
        body,
      ],
      repoRoot,
    );
    return open[0];
  }
  await ensureRequiredPublicationLabels(exec, repoRoot);
  const output = await mustExec(
    exec,
    'gh',
    [
      'pr',
      'create',
      '--base',
      'main',
      '--head',
      'assets/queue',
      '--title',
      'art: publish generated sprite assets',
      '--body',
      body,
      '--label',
      'art-only',
    ],
    repoRoot,
  );
  const created = await listCanonicalPrs(exec, repoRoot);
  if (created.length !== 1) {
    throw new Error(`Canonical PR creation did not yield exactly one open PR: ${output}`);
  }
  return created[0]!;
}

export async function ensureRequiredPublicationLabels(exec: Exec, repoRoot: string): Promise<void> {
  for (const label of REQUIRED_PUBLICATION_LABELS) {
    if (await publicationLabelExists(exec, repoRoot, label.name)) {
      continue;
    }
    await mustExec(
      exec,
      'gh',
      ['label', 'create', label.name, '--color', label.color, '--description', label.description],
      repoRoot,
    );
  }
}

async function publicationLabelExists(
  exec: Exec,
  repoRoot: string,
  labelName: string,
): Promise<boolean> {
  const output = await mustExec(
    exec,
    'gh',
    ['label', 'list', '--search', labelName, '--json', 'name', '--limit', '100'],
    repoRoot,
  );
  const labels = z.array(z.object({ name: z.string() }).passthrough()).parse(JSON.parse(output));
  return labels.some((label) => label.name === labelName);
}

export async function closeCanonicalPrOnConflict(
  exec: Exec,
  repoRoot: string,
  error: unknown,
): Promise<void> {
  const open = await listCanonicalPrs(exec, repoRoot);
  const message =
    `Automated publication detected a same-key generated-asset conflict with current main and ` +
    `closed this PR fail-closed. Human reconciliation is required.\n\n` +
    `Error: ${error instanceof Error ? error.message : String(error)}`;
  for (const pr of open) {
    await mustExec(exec, 'gh', ['pr', 'comment', String(pr.number), '--body', message], repoRoot);
    await mustExec(exec, 'gh', ['pr', 'close', String(pr.number)], repoRoot);
  }
}

async function listCanonicalPrs(exec: Exec, repoRoot: string): Promise<PullRequestRef[]> {
  const output = await mustExec(
    exec,
    'gh',
    [
      'pr',
      'list',
      '--state',
      'open',
      '--head',
      'assets/queue',
      '--base',
      'main',
      '--json',
      'number,url',
      '--limit',
      '10',
    ],
    repoRoot,
  );
  const parsed = z
    .array(z.object({ number: z.number().int().positive(), url: z.string() }).strict())
    .parse(JSON.parse(output));
  return parsed;
}

async function mustExec(
  exec: Exec,
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<string> {
  const result = await exec(command, args, { cwd });
  if (result.code !== 0) {
    const failureOutput = result.stderr || result.stdout;
    throw new QueueCommitError(
      'git-failed',
      `${formatCommand(command, args)} failed (exit ${result.code}): ${failureOutput}`,
    );
  }
  return result.stdout;
}

function formatCommand(command: string, args: readonly string[]): string {
  return [command, ...args.map(formatCommandArg)].join(' ');
}

function formatCommandArg(arg: string): string {
  return /^[A-Za-z0-9_./:=,@%+-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

function readJson(file: string): unknown {
  if (!existsSync(file)) return file.endsWith('manifest.json') ? { version: 1, entries: {} } : [];
  return JSON.parse(readFileSync(file, 'utf8')) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function hashFile(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
