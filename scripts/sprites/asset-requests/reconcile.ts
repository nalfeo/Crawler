/**
 * Materialize a promotion from immutable asset request refs.
 *
 * The old reconciler overlaid a long-lived mutable `assets/queue` branch onto
 * `main`, so the promotion inherited whatever state that aggregate happened to
 * be in — including a stale or corrupted one. This reconciler NEVER overlays an
 * aggregate: it starts a throwaway worktree at the exact current `origin/main`
 * and replays validated, sealed requests onto it.
 *
 * Guarantees this module is responsible for (all fail-closed):
 *   - a request commit may contain ONLY its manifest plus its declared payload;
 *   - a declared PNG's bytes must hash to the manifest `contentHash`, and its
 *     shard must agree on the same identity — the pair travels atomically;
 *   - a STALE request (its destination changed on `main` since the request
 *     observed it) is refused, never silently applied over newer bytes;
 *   - a generated path can only be deleted through a removal request carrying a
 *     same-content duplicate proof that still holds on the current `main`;
 *   - two requests claiming the same destination unit with different content are
 *     BOTH refused with an actionable status — the reconciler never picks a
 *     silent winner;
 *   - annotation updates merge per sprite key, so one request can never erase
 *     another sprite's annotation;
 *   - the promotion records the exact consumed request ids and source SHAs, so a
 *     replay from the same refs against the same base yields the same tree.
 */

import type { Exec } from '../checkin.js';
import {
  ANNOTATIONS_PATH,
  GENERATED_ROOT,
  destinationPaths,
  destinationUnits,
  declaredRequestPaths,
  parseAssetRequest,
  pngRepoPath,
  requestIdFromRef,
  requestManifestPath,
  sha256Bytes,
  shardRepoPath,
  type AssetRequestAnnotation,
  type AssetRequestManifest,
} from './manifest.js';

/** Scratch ref namespace request commits are fetched into. */
export const REQUEST_SCRATCH_REF_PREFIX = 'refs/asset-requests/';

/** Trailer naming one consumed request in the promotion commit message. */
export const CONSUMED_REQUEST_TRAILER = 'Asset-Request:';

/** Trailer naming the base `main` SHA the promotion was materialized from. */
export const PROMOTION_BASE_TRAILER = 'Promotion-Base:';

const DEFAULT_REMOTE = 'origin';
const DEFAULT_BASE_BRANCH = 'main';
const DEFAULT_PROMOTE_BRANCH = 'assets/promote';

/** Why a request was not applied. Every value is actionable for the producer. */
export type RefusalReason =
  | 'invalid-manifest'
  | 'ref-id-mismatch'
  | 'undeclared-payload'
  | 'payload-hash-mismatch'
  | 'shard-identity-mismatch'
  | 'unknown-observed-main'
  | 'stale-destination'
  | 'missing-removal-target'
  | 'missing-duplicate-proof'
  | 'request-conflict';

export type RequestDisposition = 'applied' | 'already-on-main' | 'duplicate-request' | 'refused';

export interface RequestOutcome {
  readonly requestId: string;
  /** Branch name (no `refs/heads/`) the request lives on. */
  readonly branch: string;
  /** Request commit SHA. */
  readonly commit: string;
  readonly disposition: RequestDisposition;
  /** Present iff `disposition === 'refused'`. */
  readonly reason?: RefusalReason;
  /** Human-actionable detail for the producer. */
  readonly detail?: string;
}

export type MaterializeStatus = 'noop' | 'materialized';

export interface MaterializeResult {
  readonly status: MaterializeStatus;
  /** The exact `main` SHA every request was validated and applied against. */
  readonly baseSha: string;
  readonly promoteBranch: string;
  /** Promotion commit SHA, absent when nothing was applied. */
  readonly promotionCommit?: string;
  /** One outcome per enumerated request, ordered by request id. */
  readonly outcomes: readonly RequestOutcome[];
}

export class MaterializeError extends Error {
  constructor(
    readonly kind: 'git-failed' | 'non-art-surface-change',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'MaterializeError';
  }
}

export interface MaterializeDeps {
  readonly exec: Exec;
  readonly makeTempDir: () => Promise<string>;
  readonly removeDir: (dir: string) => Promise<void>;
  readonly readFileBytes: (absolutePath: string) => Promise<Uint8Array>;
  readonly readTextFile: (absolutePath: string) => Promise<string>;
  readonly writeTextFile: (absolutePath: string, contents: string) => Promise<void>;
  readonly copyFile: (source: string, destination: string) => Promise<void>;
  readonly removeFile: (absolutePath: string) => Promise<void>;
  readonly pathExists: (absolutePath: string) => Promise<boolean>;
  readonly joinPath: (...segments: string[]) => string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface MaterializeOptions {
  readonly remote?: string;
  readonly baseBranch?: string;
  readonly promoteBranch?: string;
  /** Push the materialized promotion branch. Defaults to true. */
  readonly push?: boolean;
}

interface EnumeratedRequest {
  readonly requestId: string;
  readonly branch: string;
  readonly commit: string;
}

export interface ValidatedRequest {
  readonly enumerated: EnumeratedRequest;
  readonly manifest: AssetRequestManifest;
  /** Worktree holding the request's payload bytes. */
  readonly payloadRoot: string;
}

async function runGit(
  deps: MaterializeDeps,
  cwd: string,
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return deps.exec('git', args, { cwd, env: deps.env });
}

async function mustGit(
  deps: MaterializeDeps,
  cwd: string,
  args: readonly string[],
): Promise<string> {
  const result = await runGit(deps, cwd, args);
  if (result.code !== 0) {
    throw new MaterializeError(
      'git-failed',
      `git ${args.join(' ')} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout.trim();
}

/** Parse `git ls-remote` output into request refs, ordered by request id. */
export function parseRequestRefs(lsRemoteStdout: string): readonly EnumeratedRequest[] {
  const requests: EnumeratedRequest[] = [];
  for (const line of lsRemoteStdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const [commit, ref] = trimmed.split(/\s+/);
    if (commit === undefined || ref === undefined) continue;
    if (!/^[0-9a-f]{40}$/.test(commit)) continue;
    const requestId = requestIdFromRef(ref);
    if (requestId === null) continue;
    requests.push({ requestId, commit, branch: ref.replace(/^refs\/heads\//, '') });
  }
  return requests.sort((a, b) =>
    a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0,
  );
}

/** Build the promotion commit message, including one trailer per consumed request. */
export function buildPromotionMessage(
  baseSha: string,
  consumed: readonly ValidatedRequest[],
): string {
  const lines = [
    `chore(assets): promote ${consumed.length} asset request${consumed.length === 1 ? '' : 's'}`,
    '',
    `${PROMOTION_BASE_TRAILER} ${baseSha}`,
  ];
  for (const request of consumed) {
    lines.push(
      `${CONSUMED_REQUEST_TRAILER} ${request.manifest.requestId}@${request.enumerated.commit}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Read the consumed request ids/SHAs back out of a promotion commit message. */
export function parseConsumedRequests(
  message: string,
): readonly { readonly requestId: string; readonly commit: string }[] {
  const consumed: { requestId: string; commit: string }[] = [];
  for (const line of message.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(CONSUMED_REQUEST_TRAILER)) continue;
    const value = trimmed.slice(CONSUMED_REQUEST_TRAILER.length).trim();
    const [requestId, commit] = value.split('@');
    if (requestId === undefined || commit === undefined) continue;
    if (!/^[0-9a-f]{64}$/.test(requestId) || !/^[0-9a-f]{40}$/.test(commit)) continue;
    consumed.push({ requestId, commit });
  }
  return consumed;
}

/** Blob SHA at `<rev>:<path>`, or null when the path does not exist there. */
async function blobAt(
  deps: MaterializeDeps,
  repoRoot: string,
  rev: string,
  repoPath: string,
): Promise<string | null> {
  const result = await runGit(deps, repoRoot, [
    'rev-parse',
    '--verify',
    '--quiet',
    `${rev}:${repoPath}`,
  ]);
  if (result.code !== 0) return null;
  const sha = result.stdout.trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

interface Refusal {
  readonly reason: RefusalReason;
  readonly detail: string;
}

function refuse(reason: RefusalReason, detail: string): Refusal {
  return { reason, detail };
}

/**
 * Validate one request against the exact `baseSha` snapshot. Returns a refusal
 * or the validated request; `already-on-main` is signalled separately.
 */
async function validateRequest(
  deps: MaterializeDeps,
  repoRoot: string,
  enumerated: EnumeratedRequest,
  baseSha: string,
  payloadRoot: string,
  mainWorktree: string,
): Promise<{ refusal: Refusal } | { manifest: AssetRequestManifest; alreadyOnMain: boolean }> {
  const manifestPath = requestManifestPath(enumerated.requestId);
  const manifestText = await runGit(deps, repoRoot, [
    'show',
    `${enumerated.commit}:${manifestPath}`,
  ]);
  if (manifestText.code !== 0) {
    return { refusal: refuse('invalid-manifest', `request commit has no ${manifestPath}`) };
  }

  let manifest: AssetRequestManifest;
  try {
    manifest = parseAssetRequest(manifestText.stdout);
  } catch (error) {
    return {
      refusal: refuse('invalid-manifest', error instanceof Error ? error.message : String(error)),
    };
  }
  if (manifest.requestId !== enumerated.requestId) {
    return {
      refusal: refuse(
        'ref-id-mismatch',
        `manifest declares ${manifest.requestId} but the ref names ${enumerated.requestId}`,
      ),
    };
  }

  // The commit tree must be EXACTLY the declared payload — no smuggled files.
  const tree = await mustGit(deps, repoRoot, ['ls-tree', '-r', '--name-only', enumerated.commit]);
  const actualPaths = tree
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .sort();
  const declared = [...declaredRequestPaths(manifest)];
  if (actualPaths.length !== declared.length || actualPaths.some((p, i) => p !== declared[i])) {
    return {
      refusal: refuse(
        'undeclared-payload',
        `request tree [${actualPaths.join(', ')}] does not match its declared payload [${declared.join(', ')}]`,
      ),
    };
  }

  // A request whose content main ALREADY carries is consumed, not stale: the
  // most common way a destination changes after `observedMainSha` is the
  // request's own promotion landing. Checking this first keeps a landed request
  // reported as a clean no-op instead of a spurious stale refusal.
  if (await isAlreadyOnMain(deps, repoRoot, manifest, baseSha, enumerated.commit, mainWorktree)) {
    return { manifest, alreadyOnMain: true };
  }

  // The observed base must be real history we can diff against; otherwise
  // staleness is unknowable and the request fails closed.
  const observed = await runGit(deps, repoRoot, [
    'merge-base',
    '--is-ancestor',
    manifest.observedMainSha,
    baseSha,
  ]);
  if (observed.code !== 0) {
    return {
      refusal: refuse(
        'unknown-observed-main',
        `observed main ${manifest.observedMainSha} is not an ancestor of ${baseSha}; ` +
          'republish the request against current main',
      ),
    };
  }

  // Stale-destination detection: if any destination path's bytes on main changed
  // since the request observed main, the request's view is stale.
  for (const repoPath of destinationPaths(manifest)) {
    const then = await blobAt(deps, repoRoot, manifest.observedMainSha, repoPath);
    const now = await blobAt(deps, repoRoot, baseSha, repoPath);
    if (then !== now) {
      return {
        refusal: refuse(
          'stale-destination',
          `"${repoPath}" changed on main since ${manifest.observedMainSha.slice(0, 12)} ` +
            `(${then ?? 'absent'} -> ${now ?? 'absent'}); republish against current main`,
        ),
      };
    }
  }

  // Payload integrity: PNG bytes must hash to the declared contentHash and the
  // shard must agree on the same asset identity.
  for (const asset of manifest.assets) {
    const pngAbsolute = deps.joinPath(payloadRoot, ...pngRepoPath(asset.assetPath).split('/'));
    const bytes = await deps.readFileBytes(pngAbsolute);
    const actual = sha256Bytes(bytes);
    if (actual !== asset.contentHash) {
      return {
        refusal: refuse(
          'payload-hash-mismatch',
          `"${asset.assetPath}" hashes to ${actual} but the manifest declares ${asset.contentHash}`,
        ),
      };
    }
    const shardAbsolute = deps.joinPath(
      payloadRoot,
      ...shardRepoPath(asset.manifestKey).split('/'),
    );
    let shard: Record<string, unknown>;
    try {
      shard = JSON.parse(await deps.readTextFile(shardAbsolute)) as Record<string, unknown>;
    } catch (error) {
      return {
        refusal: refuse(
          'shard-identity-mismatch',
          `shard for "${asset.manifestKey}" is not valid JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      };
    }
    const mismatch = shardIdentityMismatch(shard, asset);
    if (mismatch !== null) {
      return { refusal: refuse('shard-identity-mismatch', mismatch) };
    }
  }

  return { manifest, alreadyOnMain: false };
}

function shardIdentityMismatch(
  shard: Record<string, unknown>,
  asset: AssetRequestManifest['assets'][number],
): string | null {
  if (shard.assetPath !== asset.assetPath) {
    return `shard for "${asset.manifestKey}" points at "${String(shard.assetPath)}" but the request declares "${asset.assetPath}"`;
  }
  if (shard.briefId !== asset.briefId) {
    return `shard for "${asset.manifestKey}" declares briefId "${String(shard.briefId)}" but the request declares "${asset.briefId}"`;
  }
  if (shard.variantIndex !== asset.variantIndex) {
    return `shard for "${asset.manifestKey}" declares variantIndex ${String(shard.variantIndex)} but the request declares ${asset.variantIndex}`;
  }
  if (shard.contentHash !== undefined && shard.contentHash !== asset.contentHash) {
    return `shard for "${asset.manifestKey}" declares contentHash ${String(shard.contentHash)} but the request declares ${asset.contentHash}`;
  }
  if (
    asset.sourceRun !== null &&
    shard.sourceRun !== undefined &&
    shard.sourceRun !== asset.sourceRun
  ) {
    return `shard for "${asset.manifestKey}" declares sourceRun "${String(shard.sourceRun)}" but the request declares "${asset.sourceRun}"`;
  }
  return null;
}

interface AnnotationDocument {
  version: 1;
  sprites: Record<string, unknown>;
}

async function readAnnotations(
  deps: MaterializeDeps,
  worktree: string,
): Promise<AnnotationDocument> {
  const target = deps.joinPath(worktree, ...ANNOTATIONS_PATH.split('/'));
  if (!(await deps.pathExists(target))) return { version: 1, sprites: {} };
  const parsed = JSON.parse(await deps.readTextFile(target)) as unknown;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    typeof (parsed as { sprites?: unknown }).sprites !== 'object' ||
    (parsed as { sprites?: unknown }).sprites === null ||
    Array.isArray((parsed as { sprites?: unknown }).sprites)
  ) {
    throw new MaterializeError(
      'git-failed',
      `${ANNOTATIONS_PATH} on main must contain an object-valued "sprites" map`,
    );
  }
  return {
    version: 1,
    sprites: { ...(parsed as { sprites: Record<string, unknown> }).sprites },
  };
}

function annotationValue(annotation: AssetRequestAnnotation): Record<string, unknown> {
  return {
    favorite: annotation.favorite,
    disliked: annotation.disliked,
    comment: annotation.comment,
  };
}

function sameAnnotation(existing: unknown, annotation: AssetRequestAnnotation): boolean {
  if (typeof existing !== 'object' || existing === null) return false;
  const current = existing as Record<string, unknown>;
  return (
    current.favorite === annotation.favorite &&
    current.disliked === annotation.disliked &&
    current.comment === annotation.comment
  );
}

/**
 * Enumerate unresolved request refs, validate each against current `origin/main`
 * and materialize a promotion branch from the compatible ones.
 */
export async function materializeAssetRequests(
  repoRoot: string,
  deps: MaterializeDeps,
  options: MaterializeOptions = {},
): Promise<MaterializeResult> {
  const remote = options.remote ?? DEFAULT_REMOTE;
  const baseBranch = options.baseBranch ?? DEFAULT_BASE_BRANCH;
  const promoteBranch = options.promoteBranch ?? DEFAULT_PROMOTE_BRANCH;
  const shouldPush = options.push ?? true;

  await mustGit(deps, repoRoot, ['fetch', '--no-tags', remote, baseBranch]);
  const baseSha = await mustGit(deps, repoRoot, ['rev-parse', 'FETCH_HEAD']);

  const listed = await mustGit(deps, repoRoot, [
    'ls-remote',
    '--heads',
    remote,
    'refs/heads/assets/request/*',
  ]);
  const enumerated = parseRequestRefs(listed);
  if (enumerated.length === 0) {
    return { status: 'noop', baseSha, promoteBranch, outcomes: [] };
  }

  await mustGit(deps, repoRoot, [
    'fetch',
    '--no-tags',
    '--force',
    remote,
    `+refs/heads/assets/request/*:${REQUEST_SCRATCH_REF_PREFIX}*`,
  ]);

  const temp = await deps.makeTempDir();
  const worktrees: string[] = [];
  const outcomes: RequestOutcome[] = [];
  try {
    const mainWorktree = deps.joinPath(temp, 'main');
    await mustGit(deps, repoRoot, ['worktree', 'add', '--detach', mainWorktree, baseSha]);
    worktrees.push(mainWorktree);

    const validated: ValidatedRequest[] = [];

    for (const request of enumerated) {
      const payloadRoot = deps.joinPath(temp, 'requests', request.requestId);
      await mustGit(deps, repoRoot, ['worktree', 'add', '--detach', payloadRoot, request.commit]);
      worktrees.push(payloadRoot);

      const result = await validateRequest(
        deps,
        repoRoot,
        request,
        baseSha,
        payloadRoot,
        mainWorktree,
      );
      if ('refusal' in result) {
        outcomes.push({
          requestId: request.requestId,
          branch: request.branch,
          commit: request.commit,
          disposition: 'refused',
          reason: result.refusal.reason,
          detail: result.refusal.detail,
        });
        continue;
      }
      const manifest = result.manifest;
      if (result.alreadyOnMain) {
        outcomes.push({
          requestId: request.requestId,
          branch: request.branch,
          commit: request.commit,
          disposition: 'already-on-main',
          detail: 'main already carries this request’s content',
        });
        continue;
      }

      const removalRefusal = await validateRemovals(
        deps,
        repoRoot,
        manifest,
        baseSha,
        mainWorktree,
      );
      if (removalRefusal !== null) {
        outcomes.push({
          requestId: request.requestId,
          branch: request.branch,
          commit: request.commit,
          disposition: 'refused',
          reason: removalRefusal.reason,
          detail: removalRefusal.detail,
        });
        continue;
      }

      validated.push({ enumerated: request, manifest, payloadRoot });
    }

    const { applicable, conflicted, duplicates } = partitionConflicts(validated);
    for (const entry of conflicted) {
      outcomes.push({
        requestId: entry.request.enumerated.requestId,
        branch: entry.request.enumerated.branch,
        commit: entry.request.enumerated.commit,
        disposition: 'refused',
        reason: 'request-conflict',
        detail: entry.detail,
      });
    }
    for (const entry of duplicates) {
      outcomes.push({
        requestId: entry.request.enumerated.requestId,
        branch: entry.request.enumerated.branch,
        commit: entry.request.enumerated.commit,
        disposition: 'duplicate-request',
        detail: entry.detail,
      });
    }

    if (applicable.length === 0) {
      return {
        status: 'noop',
        baseSha,
        promoteBranch,
        outcomes: sortOutcomes(outcomes),
      };
    }

    for (const request of applicable) {
      await applyRequest(deps, request, mainWorktree);
      outcomes.push({
        requestId: request.enumerated.requestId,
        branch: request.enumerated.branch,
        commit: request.enumerated.commit,
        disposition: 'applied',
      });
    }

    await mustGit(deps, mainWorktree, ['add', '--all', '--', GENERATED_ROOT]);
    const staged = await mustGit(deps, mainWorktree, ['diff', '--cached', '--name-only']);
    assertArtSurfaceOnly(staged);
    if (staged.trim() === '') {
      return { status: 'noop', baseSha, promoteBranch, outcomes: sortOutcomes(outcomes) };
    }

    await mustGit(deps, mainWorktree, [
      'commit',
      '--no-verify',
      '-m',
      buildPromotionMessage(baseSha, applicable),
    ]);
    const promotionCommit = await mustGit(deps, mainWorktree, ['rev-parse', 'HEAD']);

    if (shouldPush) {
      await mustGit(deps, mainWorktree, [
        'push',
        '--force',
        remote,
        `${promotionCommit}:refs/heads/${promoteBranch}`,
      ]);
    }

    return {
      status: 'materialized',
      baseSha,
      promoteBranch,
      promotionCommit,
      outcomes: sortOutcomes(outcomes),
    };
  } finally {
    for (const worktree of worktrees) {
      await runGit(deps, repoRoot, ['worktree', 'remove', '--force', worktree]).catch(
        () => undefined,
      );
    }
    await mustGit(deps, repoRoot, ['worktree', 'prune']).catch(() => undefined);
    await deps.removeDir(temp).catch(() => undefined);
  }
}

function sortOutcomes(outcomes: readonly RequestOutcome[]): readonly RequestOutcome[] {
  return [...outcomes].sort((a, b) =>
    a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0,
  );
}

/** Every staged path must live under the generated art surface. */
export function assertArtSurfaceOnly(stagedNames: string): void {
  for (const line of stagedNames.split('\n')) {
    const repoPath = line.trim();
    if (repoPath === '') continue;
    if (repoPath !== GENERATED_ROOT && !repoPath.startsWith(`${GENERATED_ROOT}/`)) {
      throw new MaterializeError(
        'non-art-surface-change',
        `materialized promotion touches "${repoPath}", which is outside ${GENERATED_ROOT}`,
      );
    }
  }
}

/** Removals are only allowed with a duplicate proof that still holds on `main`. */
async function validateRemovals(
  deps: MaterializeDeps,
  repoRoot: string,
  manifest: AssetRequestManifest,
  baseSha: string,
  mainWorktree: string,
): Promise<Refusal | null> {
  for (const removal of manifest.removals) {
    const targetRepoPath = pngRepoPath(removal.assetPath);
    const proofRepoPath = pngRepoPath(removal.duplicateOfAssetPath);
    const targetBlob = await blobAt(deps, repoRoot, baseSha, targetRepoPath);
    if (targetBlob === null) continue; // already gone -> handled as already-on-main
    const proofBlob = await blobAt(deps, repoRoot, baseSha, proofRepoPath);
    if (proofBlob === null) {
      return refuse(
        'missing-duplicate-proof',
        `removal of "${removal.assetPath}" claims "${removal.duplicateOfAssetPath}" survives, ` +
          'but that path does not exist on main',
      );
    }
    const targetBytes = await deps.readFileBytes(
      deps.joinPath(mainWorktree, ...targetRepoPath.split('/')),
    );
    const proofBytes = await deps.readFileBytes(
      deps.joinPath(mainWorktree, ...proofRepoPath.split('/')),
    );
    const targetHash = sha256Bytes(targetBytes);
    const proofHash = sha256Bytes(proofBytes);
    if (targetHash !== removal.contentHash) {
      return refuse(
        'missing-removal-target',
        `"${removal.assetPath}" on main hashes to ${targetHash} but the removal proof declares ` +
          `${removal.contentHash}; a removal may never delete bytes it has not proven`,
      );
    }
    if (targetHash !== proofHash) {
      return refuse(
        'missing-duplicate-proof',
        `"${removal.duplicateOfAssetPath}" (${proofHash}) is not byte-identical to ` +
          `"${removal.assetPath}" (${targetHash}); removal requires a same-content duplicate`,
      );
    }
    if (
      (await blobAt(deps, repoRoot, baseSha, shardRepoPath(removal.duplicateOfManifestKey))) ===
      null
    ) {
      return refuse(
        'missing-duplicate-proof',
        `surviving key "${removal.duplicateOfManifestKey}" has no manifest shard on main`,
      );
    }
  }
  return null;
}

/** True when `main` already carries everything this request would change. */
async function isAlreadyOnMain(
  deps: MaterializeDeps,
  repoRoot: string,
  manifest: AssetRequestManifest,
  baseSha: string,
  requestCommit: string,
  mainWorktree: string,
): Promise<boolean> {
  for (const asset of manifest.assets) {
    const pngRepo = pngRepoPath(asset.assetPath);
    const shardRepo = shardRepoPath(asset.manifestKey);
    const mainPng = await blobAt(deps, repoRoot, baseSha, pngRepo);
    const mainShard = await blobAt(deps, repoRoot, baseSha, shardRepo);
    if (mainPng === null || mainShard === null) return false;
    if (mainPng !== (await blobAt(deps, repoRoot, requestCommit, pngRepo))) return false;
    if (mainShard !== (await blobAt(deps, repoRoot, requestCommit, shardRepo))) return false;
  }
  for (const removal of manifest.removals) {
    if ((await blobAt(deps, repoRoot, baseSha, pngRepoPath(removal.assetPath))) !== null) {
      return false;
    }
    if ((await blobAt(deps, repoRoot, baseSha, shardRepoPath(removal.manifestKey))) !== null) {
      return false;
    }
  }
  if (manifest.annotations.length > 0) {
    const document = await readAnnotations(deps, mainWorktree);
    for (const annotation of manifest.annotations) {
      if (!sameAnnotation(document.sprites[annotation.key], annotation)) return false;
    }
  }
  return true;
}

interface ConflictEntry {
  readonly request: ValidatedRequest;
  readonly detail: string;
}

/**
 * Split validated requests into applicable / conflicted / duplicate sets.
 * Two requests claiming the same destination unit with DIFFERENT content are
 * both refused (never a silent winner); identical content is reported as a
 * duplicate so the producer can retire the redundant request.
 */
export function partitionConflicts(validated: readonly ValidatedRequest[]): {
  applicable: readonly ValidatedRequest[];
  conflicted: readonly ConflictEntry[];
  duplicates: readonly ConflictEntry[];
} {
  const claims = new Map<string, { request: ValidatedRequest; content: string }[]>();
  for (const request of validated) {
    for (const unit of destinationUnits(request.manifest)) {
      const list = claims.get(unit) ?? [];
      list.push({ request, content: contentFor(request.manifest, unit) });
      claims.set(unit, list);
    }
  }

  const conflicted = new Map<string, string>();
  const duplicate = new Map<string, string>();
  for (const [unit, claimants] of [...claims.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (claimants.length < 2) continue;
    const distinct = new Set(claimants.map((claim) => claim.content));
    if (distinct.size > 1) {
      const ids = claimants.map((claim) => claim.request.manifest.requestId).sort();
      for (const claim of claimants) {
        conflicted.set(
          claim.request.manifest.requestId,
          `"${unit}" is claimed with different content by requests [${ids
            .map((id) => id.slice(0, 12))
            .join(', ')}]; resolve the conflict and republish the winner`,
        );
      }
      continue;
    }
    const ordered = [...claimants].sort((a, b) =>
      a.request.manifest.requestId < b.request.manifest.requestId ? -1 : 1,
    );
    for (const claim of ordered.slice(1)) {
      duplicate.set(
        claim.request.manifest.requestId,
        `"${unit}" carries identical content to request ` +
          `${ordered[0]!.request.manifest.requestId.slice(0, 12)}; nothing left to apply`,
      );
    }
  }

  const applicable: ValidatedRequest[] = [];
  const conflictedEntries: ConflictEntry[] = [];
  const duplicateEntries: ConflictEntry[] = [];
  for (const request of validated) {
    const id = request.manifest.requestId;
    const conflictDetail = conflicted.get(id);
    if (conflictDetail !== undefined) {
      conflictedEntries.push({ request, detail: conflictDetail });
      continue;
    }
    const duplicateDetail = duplicate.get(id);
    if (duplicateDetail !== undefined) {
      duplicateEntries.push({ request, detail: duplicateDetail });
      continue;
    }
    applicable.push(request);
  }
  return {
    applicable,
    conflicted: conflictedEntries,
    duplicates: duplicateEntries,
  };
}

/** Stable content fingerprint a request claims for one destination unit. */
function contentFor(manifest: AssetRequestManifest, unit: string): string {
  for (const asset of manifest.assets) {
    if (unit === pngRepoPath(asset.assetPath) || unit === shardRepoPath(asset.manifestKey)) {
      return `upsert:${asset.contentHash}:${asset.briefId}:${asset.variantIndex}`;
    }
  }
  for (const removal of manifest.removals) {
    if (unit === pngRepoPath(removal.assetPath) || unit === shardRepoPath(removal.manifestKey)) {
      return `remove:${removal.contentHash}`;
    }
  }
  for (const annotation of manifest.annotations) {
    if (unit === `${ANNOTATIONS_PATH}#${annotation.key}`) {
      return `annotate:${JSON.stringify(annotationValue(annotation))}`;
    }
  }
  return 'unknown';
}

/** Apply one validated request into the main worktree. */
async function applyRequest(
  deps: MaterializeDeps,
  request: ValidatedRequest,
  mainWorktree: string,
): Promise<void> {
  const { manifest, payloadRoot } = request;
  for (const asset of manifest.assets) {
    for (const repoPath of [pngRepoPath(asset.assetPath), shardRepoPath(asset.manifestKey)]) {
      const source = deps.joinPath(payloadRoot, ...repoPath.split('/'));
      const destination = deps.joinPath(mainWorktree, ...repoPath.split('/'));
      await deps.copyFile(source, destination);
    }
  }
  for (const removal of manifest.removals) {
    for (const repoPath of [pngRepoPath(removal.assetPath), shardRepoPath(removal.manifestKey)]) {
      const destination = deps.joinPath(mainWorktree, ...repoPath.split('/'));
      if (await deps.pathExists(destination)) await deps.removeFile(destination);
    }
  }
  if (manifest.annotations.length > 0) {
    const document = await readAnnotations(deps, mainWorktree);
    for (const annotation of manifest.annotations) {
      document.sprites[annotation.key] = annotationValue(annotation);
    }
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(document.sprites).sort()) sorted[key] = document.sprites[key];
    await deps.writeTextFile(
      deps.joinPath(mainWorktree, ...ANNOTATIONS_PATH.split('/')),
      `${JSON.stringify({ version: 1, sprites: sorted }, null, 2)}\n`,
    );
  }
}

export interface ArchiveResult {
  readonly archived: readonly string[];
  readonly skipped: readonly string[];
}

/**
 * Archive the requests a promotion consumed — ONLY once that promotion is
 * proven merged into `main`. The request commit is preserved under
 * `assets/archive/request/<id>` before the live ref is deleted, so a consumed
 * request stays fully auditable/replayable and can never be lost.
 */
export async function archiveConsumedRequests(
  repoRoot: string,
  promotionCommit: string,
  deps: MaterializeDeps,
  options: MaterializeOptions = {},
): Promise<ArchiveResult> {
  const remote = options.remote ?? DEFAULT_REMOTE;
  const baseBranch = options.baseBranch ?? DEFAULT_BASE_BRANCH;

  await mustGit(deps, repoRoot, ['fetch', '--no-tags', remote, baseBranch]);
  const baseSha = await mustGit(deps, repoRoot, ['rev-parse', 'FETCH_HEAD']);
  const merged = await runGit(deps, repoRoot, [
    'merge-base',
    '--is-ancestor',
    promotionCommit,
    baseSha,
  ]);
  if (merged.code !== 0) {
    // Not proven merged: keep every request ref live so nothing is consumed
    // without having landed.
    return { archived: [], skipped: [] };
  }

  const message = await mustGit(deps, repoRoot, ['log', '-1', '--format=%B', promotionCommit]);
  const consumed = parseConsumedRequests(message);
  const archived: string[] = [];
  const skipped: string[] = [];
  for (const entry of consumed) {
    const liveRef = `refs/heads/assets/request/${entry.requestId}`;
    const archiveRef = `refs/heads/assets/archive/request/${entry.requestId}`;
    const listed = await mustGit(deps, repoRoot, ['ls-remote', remote, liveRef]);
    if (listed.trim() === '') {
      skipped.push(entry.requestId);
      continue;
    }
    await mustGit(deps, repoRoot, ['push', remote, `${entry.commit}:${archiveRef}`]);
    await mustGit(deps, repoRoot, [
      'push',
      `--force-with-lease=${liveRef}:${entry.commit}`,
      remote,
      `:${liveRef}`,
    ]);
    archived.push(entry.requestId);
  }
  return { archived, skipped };
}
