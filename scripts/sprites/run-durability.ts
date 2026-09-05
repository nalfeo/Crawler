/**
 * run-durability.ts — the single durability boundary for sprite generation.
 *
 * The incident this exists to prevent
 * -----------------------------------
 * Seven successful 12-candidate directional sheets were generated through
 * `sprites:run` / `sprites:batch`, winners were approved and queued into git,
 * and the source runs were then found in NEITHER `generated/runs/**` NOR Azure
 * (active or archive). Root cause: `generateSheetCore` falls back to
 * `new LocalRunStore(<outputRoot>/runs)` when a caller injects no store, and
 * `cli.ts` / `batch-cli.ts` injected none. Both CLIs *did* build the Azure image
 * provider, so the run looked cloud-backed while every LLM-authored artifact
 * lived only in one gitignored worktree directory. Approving published art with
 * a `sourceRun` pointer into content that no longer existed anywhere.
 *
 * The contract
 * ------------
 * 1. Generation resolves its store through {@link resolveGenerationRunStore},
 *    which is durable-by-default and fails closed rather than silently
 *    degrading to ephemeral local storage.
 * 2. {@link buildRunProvenance} + the generator persist the authored brief, the
 *    exact prompts, and full reference/seed provenance to the store BEFORE the
 *    (expensive, lossy) provider call, so even a mid-generation crash leaves the
 *    LLM-authored input behind.
 * 3. {@link ensureRunDurable} runs immediately before any git-backed
 *    publication. It backfills anything the durable store is missing from the
 *    local run directory, then verifies the required key set. It throws
 *    {@link RunDurabilityError} otherwise, so no queue commit, ingestion
 *    request, or durable `sourceRun` pointer can reference missing content.
 *
 * All three steps are keyed by stable, content-derived keys, so retrying a
 * partially-failed run rewrites byte-identical content to the same keys instead
 * of duplicating or corrupting anything.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRunStore } from './store/index.js';
import { LocalRunStore } from './store/local-store.js';
import { MirroredRunStore } from './store/mirrored-store.js';
import type { RunStore } from './store/types.js';

/** Env var selecting the run-store backend. Also read by `createRunStore`. */
export const RUN_STORE_ENV = 'SPRITES_RUN_STORE';

/**
 * Thrown when content that a git-backed publication would point at is not
 * durably persisted. Always fail closed on this — never downgrade to a warning.
 */
export class RunDurabilityError extends Error {
  constructor(
    message: string,
    readonly missingKeys: readonly string[] = [],
  ) {
    super(message);
    this.name = 'RunDurabilityError';
  }
}

/**
 * `'durable'` — writes reach a durable store (Azure) and publication is allowed.
 * `'ephemeral-explicit'` — the operator explicitly opted into local-only
 * storage. Clearly labelled, never inferred, and never the fallback when Azure
 * was expected.
 */
export type RunDurabilityMode = 'durable' | 'ephemeral-explicit';

export interface GenerationRunStoreResolution {
  /** Inject this into `runFull` / `runBatch` / `generateOne`. */
  readonly store: RunStore;
  /** The durable side. `null` only in `ephemeral-explicit` mode. */
  readonly durable: RunStore | null;
  readonly mode: RunDurabilityMode;
  /** One-line human-readable summary for CLI startup output. */
  readonly description: string;
}

export interface ResolveGenerationRunStoreOptions {
  readonly repoRoot: string;
  /** Defaults to `<repoRoot>/generated`. Roots the local working copy. */
  readonly outputRoot?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Test seam. Defaults to the real `createRunStore`, which is what actually
   * talks to Azure.
   */
  readonly createStore?: typeof createRunStore;
}

/** True when the environment carries usable Azure Blob credentials. */
export function hasAzureStorageCredentials(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  if (env['AZURE_STORAGE_CONNECTION_STRING']) return true;
  return Boolean(env['AZURE_STORAGE_ACCOUNT'] && env['AZURE_STORAGE_KEY']);
}

/**
 * Resolve the run store for a *generation* entrypoint (`sprites:run`,
 * `sprites:batch`, sidecar generate).
 *
 * Precedence, deliberately explicit-first so existing offline workflows and the
 * whole unit-test suite keep working unchanged:
 *
 * 1. `SPRITES_RUN_STORE=local` — explicit, clearly-labelled offline mode.
 * 2. `SPRITES_RUN_STORE=<anything else>` — delegated to `createRunStore`, then
 *    mirrored so local consumers still see real files.
 * 3. Unset + Azure credentials present — durable by default (the fix).
 * 4. Unset + no credentials — **fail closed** with an actionable message.
 *
 * Case 4 is the behaviour change: production generation can no longer *silently*
 * land in ephemeral storage. It is what AGENTS.md already mandates for the
 * sidecar ("report the blocker and stop instead of silently falling back").
 */
export function resolveGenerationRunStore(
  options: ResolveGenerationRunStoreOptions,
): GenerationRunStoreResolution {
  const env = options.env ?? process.env;
  const outputRoot = options.outputRoot ?? path.join(options.repoRoot, 'generated');
  const createStore = options.createStore ?? createRunStore;
  const localRoot = path.join(outputRoot, 'runs');
  const configured = env[RUN_STORE_ENV]?.trim().toLowerCase();

  if (configured === 'local') {
    return {
      store: new LocalRunStore(localRoot),
      durable: null,
      mode: 'ephemeral-explicit',
      description:
        `run store: LOCAL ONLY (${RUN_STORE_ENV}=local) — artifacts live at ${localRoot} ` +
        `and are NOT durably persisted. Approvals from this run cannot be published to git ` +
        `until they are durably backfilled.`,
    };
  }

  if (configured === undefined || configured === '') {
    if (!hasAzureStorageCredentials(env)) {
      throw new RunDurabilityError(
        'Refusing to generate sprites into ephemeral local-only storage.\n' +
          'Generation output (brief, exact prompt, raw sheet, sliced candidates, scorecards) ' +
          'must be durably persisted before any git-backed asset ingestion request can be made.\n' +
          '\n' +
          'Fix one of these:\n' +
          '  • Refresh Azure credentials:  npm run setup:azure:env\n' +
          `  • Or opt explicitly into offline mode:  ${RUN_STORE_ENV}=local ` +
          '(runs must be durably backfilled before publication)\n',
      );
    }
  }

  // Durable path: Azure explicitly requested, or defaulted to because
  // credentials are present.
  const durable = createStore({
    repoRoot: options.repoRoot,
    env: { ...env, [RUN_STORE_ENV]: configured ?? 'azure-blob' },
  });
  return {
    store: new MirroredRunStore({ primary: new LocalRunStore(localRoot), mirror: durable }),
    durable,
    mode: 'durable',
    description:
      `run store: DURABLE (${durable.backend}), mirrored to ${localRoot} for local review` +
      (configured === undefined || configured === ''
        ? ' — defaulted to Azure because storage credentials are present'
        : ` (${RUN_STORE_ENV}=${configured})`),
  };
}

// ---------------------------------------------------------------------------
// Publication-side durable store
// ---------------------------------------------------------------------------

/**
 * Resolve the durable store to verify against at **publication** time
 * (`sprites:approve`, asset-request publication).
 *
 * Deliberately ignores `SPRITES_RUN_STORE=local`: that flag expresses a
 * *generation-time* offline preference, but at publication time the only
 * question is "is there somewhere durable this run can live?". If Azure is
 * reachable we would rather backfill an offline-generated run and let the
 * publication succeed than refuse it. Returns `null` only when no durable
 * target exists at all, which `ensureRunDurable` turns into a fail-closed
 * error.
 */
export function resolvePublicationDurableStore(
  options: Omit<ResolveGenerationRunStoreOptions, 'outputRoot'>,
): RunStore | null {
  const env = options.env ?? process.env;
  const createStore = options.createStore ?? createRunStore;
  const configured = env[RUN_STORE_ENV]?.trim().toLowerCase();
  const backend =
    configured === undefined || configured === '' || configured === 'local'
      ? 'azure-blob'
      : configured;
  if (backend === 'azure-blob' && !hasAzureStorageCredentials(env)) return null;
  return createStore({ repoRoot: options.repoRoot, env: { ...env, [RUN_STORE_ENV]: backend } });
}

// ---------------------------------------------------------------------------
// Per-run provenance
// ---------------------------------------------------------------------------

/** Bumped when the provenance record's shape changes incompatibly. */
export const RUN_PROVENANCE_VERSION = 1;

/** Verbatim authored brief bytes. Best-effort: absent if the file was unreadable. */
export const PROVENANCE_BRIEF_KEY = 'provenance/brief.yaml';
/** Exact prompts + effective brief + reference provenance. Always required. */
export const PROVENANCE_PROMPT_KEY = 'provenance/prompt.json';

export interface RunProvenanceInput {
  readonly briefId: string;
  readonly runId: string;
  readonly createdAt: Date;
  /** Repo-relative, forward-slashed. */
  readonly briefPath: string;
  /** Verbatim authored brief source, when readable. */
  readonly briefSource: string | null;
  /** The brief after variation expansion — the input the provider actually saw. */
  readonly effectiveBrief: unknown;
  /** Exact sheet prompt handed to the image provider. */
  readonly prompt: string;
  /** Exact single-variant prompt (used by per-variant providers). */
  readonly singleVariantPrompt: string;
  readonly styleGuide: string;
  readonly referenceSprites?: unknown;
  readonly seedFrames?: readonly unknown[];
  /** Marks records rebuilt from `summary.json` rather than captured live. */
  readonly reconstructed?: boolean;
}

export interface RunProvenanceArtifact {
  /** Store key relative to `<briefId>/<runId>/`. */
  readonly key: string;
  readonly data: Buffer;
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Build the provenance artifacts for a run. Pure: deterministic given its input,
 * so re-running a failed generation produces byte-identical content under the
 * same keys (idempotent retry).
 */
export function buildRunProvenance(input: RunProvenanceInput): readonly RunProvenanceArtifact[] {
  const artifacts: RunProvenanceArtifact[] = [];
  if (input.briefSource !== null) {
    artifacts.push({ key: PROVENANCE_BRIEF_KEY, data: Buffer.from(input.briefSource, 'utf8') });
  }
  const record = {
    provenanceVersion: RUN_PROVENANCE_VERSION,
    brief: input.briefId,
    runId: input.runId,
    createdAt: input.createdAt.toISOString(),
    briefPath: input.briefPath,
    briefSourceSha256: input.briefSource === null ? null : sha256(input.briefSource),
    briefSourceCaptured: input.briefSource !== null,
    effectiveBrief: input.effectiveBrief,
    prompt: input.prompt,
    promptSha256: sha256(input.prompt),
    singleVariantPrompt: input.singleVariantPrompt,
    singleVariantPromptSha256: sha256(input.singleVariantPrompt),
    styleGuideSha256: sha256(input.styleGuide),
    ...(input.referenceSprites ? { referenceSprites: input.referenceSprites } : {}),
    ...(input.seedFrames && input.seedFrames.length > 0 ? { seedFrames: input.seedFrames } : {}),
    ...(input.reconstructed ? { reconstructed: true } : {}),
  };
  artifacts.push({
    key: PROVENANCE_PROMPT_KEY,
    data: Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8'),
  });
  return artifacts;
}

// ---------------------------------------------------------------------------
// Pre-publication durability gate
// ---------------------------------------------------------------------------

/**
 * Parse a manifest `sourceRun` pointer (`generated/runs/<briefId>/<runId>`, or
 * the bare `runs/<briefId>/<runId>` / `<briefId>/<runId>` forms) into its store
 * coordinates. Returns `null` when the pointer is not a recognisable run path.
 */
export function parseSourceRun(sourceRun: string): { briefId: string; runId: string } | null {
  const parts = sourceRun
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.');
  if (parts.some((segment) => segment === '..')) return null;
  const runsAt = parts.lastIndexOf('runs');
  const tail = runsAt >= 0 ? parts.slice(runsAt + 1) : parts;
  if (tail.length !== 2) return null;
  const [briefId, runId] = tail;
  if (!briefId || !runId) return null;
  return { briefId, runId };
}

/**
 * The exact inverse of {@link parseSourceRun}: render durable store coordinates
 * as the canonical repo-relative `sourceRun` pointer.
 *
 * Callers that approve from a run REMATERIALIZED outside the repo (the sidecar
 * hydrates a remote run into an OS temp dir) must use this rather than letting
 * `approveVariant` derive the pointer from the temp path — that derivation
 * cannot produce a repo-relative path, so it degrades to a synthetic
 * `generated/runs/<briefId>/external-<tmpname>` identity that
 * {@link ensureRunDurable} can never resolve back to the run that actually
 * exists in the store. One helper on both sides keeps the round-trip exact.
 *
 * FAILS CLOSED on the one pathological input where the round-trip does not
 * hold: `parseSourceRun` locates the run by the LAST `runs` segment, so a brief
 * literally named `runs` renders as `generated/runs/runs/<runId>` and parses
 * back to `null`. Publishing an unresolvable pointer is precisely the failure
 * this module exists to prevent, so it throws instead of emitting one.
 */
export function formatSourceRun(briefId: string, runId: string): string {
  const pointer = `generated/runs/${briefId}/${runId}`;
  const roundTripped = parseSourceRun(pointer);
  if (roundTripped === null || roundTripped.briefId !== briefId || roundTripped.runId !== runId) {
    throw new RunDurabilityError(
      `Refusing to publish a sourceRun pointer that does not resolve back to its own run ` +
        `coordinates: briefId='${briefId}', runId='${runId}' renders as '${pointer}', which ` +
        `parseSourceRun reads as ${roundTripped === null ? 'unparseable' : JSON.stringify(roundTripped)}.\n` +
        `Rename the brief so it is not a reserved path segment (e.g. 'runs'), then re-approve.`,
    );
  }
  return pointer;
}

export interface EnsureRunDurableOptions {
  /** The durable store. `null` short-circuits to a typed failure. */
  readonly durable: RunStore | null;
  readonly briefId: string;
  readonly runId: string;
  /**
   * Local run directory to backfill from, when present. Missing keys are
   * uploaded before verification, which makes this both the migration path for
   * pre-contract runs and the retry path after a partial upload.
   */
  readonly localRunDir?: string | null;
}

export interface EnsureRunDurableResult {
  /** Keys uploaded by this call. Empty on a fully-durable run (steady state). */
  readonly backfilled: readonly string[];
  /** Every key verified present in the durable store. */
  readonly verified: readonly string[];
}

/**
 * Backfill-then-verify that a run is durably persisted. MUST be awaited
 * successfully before any git-backed publication of that run's output.
 *
 * Idempotent: uploads are `has`-gated and keyed by content path, so repeated
 * calls after a partial failure converge without duplicating anything.
 */
export async function ensureRunDurable(
  options: EnsureRunDurableOptions,
): Promise<EnsureRunDurableResult> {
  const { durable, briefId, runId } = options;
  const prefix = `${briefId}/${runId}`;
  if (durable === null) {
    throw new RunDurabilityError(
      `Refusing to publish ${prefix}: no durable run store is configured, so the ` +
        `generated brief, prompt, and sheets cannot be proven to exist outside this worktree.\n` +
        `Run 'npm run setup:azure:env' and re-approve, or re-generate with Azure configured.`,
    );
  }

  const backfilled: string[] = [];
  const localRunDir = options.localRunDir ?? null;
  if (localRunDir !== null && existsSync(localRunDir)) {
    for (const rel of walkFiles(localRunDir)) {
      const key = `${prefix}/${rel}`;
      if (await durable.has(key)) continue;
      await durable.put(key, readFileSync(path.join(localRunDir, ...rel.split('/'))));
      backfilled.push(key);
    }
  }

  const present = await durable.list(prefix, { authoritative: true });
  const relative = new Set(
    present
      .map((key) => (key.startsWith(`${prefix}/`) ? key.slice(prefix.length + 1) : null))
      .filter((rel): rel is string => rel !== null),
  );

  const missing: string[] = [];
  for (const required of [PROVENANCE_PROMPT_KEY, 'summary.json']) {
    if (!relative.has(required)) missing.push(`${prefix}/${required}`);
  }
  if (![...relative].some((rel) => /^sheet-\d+\.png$/.test(rel))) {
    missing.push(`${prefix}/sheet-NN.png`);
  }

  if (missing.length > 0) {
    throw new RunDurabilityError(
      `Refusing to publish ${prefix}: required artifacts are missing from the durable ` +
        `run store (${durable.backend}).\n` +
        `Missing: ${missing.join(', ')}\n` +
        (localRunDir === null || !existsSync(localRunDir)
          ? `The local run directory is also gone, so this content is unrecoverable — ` +
            `re-generate the brief instead of publishing a dangling sourceRun pointer.`
          : `Local run dir: ${localRunDir}`),
      missing,
    );
  }

  return { backfilled, verified: [...relative].map((rel) => `${prefix}/${rel}`) };
}

/** Recursively list files under `root`, as forward-slashed relative paths. */
function walkFiles(root: string): readonly string[] {
  const out: string[] = [];
  const visit = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        throw new RunDurabilityError(
          `Refusing to backfill ${root}: symbolic link '${rel}' escapes the run-directory trust boundary.`,
        );
      }
      if (entry.isDirectory()) visit(abs, rel);
      else if (entry.isFile()) out.push(rel);
      else {
        throw new RunDurabilityError(
          `Refusing to backfill ${root}: unsupported filesystem entry '${rel}'.`,
        );
      }
    }
  };
  visit(root, '');
  return out.sort();
}
