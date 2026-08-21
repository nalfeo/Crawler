/**
 * The immutable asset-request contract (ADR: immutable asset request refs).
 *
 * An asset request is a SEALED, independently verifiable description of ONE
 * asset mutation. It replaces the long-lived mutable `assets/queue` aggregate
 * branch, whose "queue AND data store" dual role let a single bad writer delete
 * or overwrite unrelated art (the 2026-08 `1c1243b` corruption removed 1,028
 * generated paths).
 *
 * Shape on disk: a request lives on its own orphan ref
 * `refs/heads/assets/request/<request-id>` whose tree contains exactly
 *
 *     assets/requests/<request-id>.json     <- this manifest
 *     ...the declared payload paths, and nothing else
 *
 * The request id is DERIVED from the canonical manifest body (SHA-256), so:
 *   - replaying the same payload yields the same id (deterministic replay), and
 *   - editing a sealed request changes its identity, which is what makes
 *     immutability checkable rather than merely promised. A correction is a NEW
 *     request that names the old one in `supersedes`.
 *
 * This module is PURE (no fs, no child_process) so the whole contract —
 * validation, canonicalization, id derivation, path projection — is unit
 * testable without git.
 */

import { createHash } from 'node:crypto';
import { isSafeGeneratedAssetPath } from '../generated-asset-path.js';

/** Manifest schema version. Bump only for a breaking contract change. */
export const ASSET_REQUEST_MANIFEST_VERSION = 1 as const;

/** Branch-name prefix (under `refs/heads/`) for every request ref. */
export const ASSET_REQUEST_BRANCH_PREFIX = 'assets/request/';

/** Branch-name prefix for archived (consumed) request refs. */
export const ASSET_REQUEST_ARCHIVE_BRANCH_PREFIX = 'assets/archive/request/';

/** Directory (repo-relative, POSIX) holding request manifests. */
export const ASSET_REQUEST_MANIFEST_DIR = 'assets/requests';

/** Repo-relative POSIX root of the committed generated-art surface. */
export const GENERATED_ROOT = 'public/assets/generated';

/** Repo-relative POSIX path of the aggregate sprite-editor annotation file. */
export const ANNOTATIONS_PATH = `${GENERATED_ROOT}/sprite-editor-annotations.json`;

/** Maximum characters of a single annotation comment (fail closed on bloat). */
export const MAX_ANNOTATION_COMMENT_LENGTH = 2000;

/** What a request does. Exactly one payload array is populated per operation. */
export type AssetRequestOperation = 'upsert-asset' | 'update-annotations' | 'remove-asset';

/** One PNG + shard pair added or replaced by an `upsert-asset` request. */
export interface AssetRequestAsset {
  /** `public/assets`-relative POSIX path, e.g. `generated/skull-mace-var-2.png`. */
  readonly assetPath: string;
  /** Manifest shard key (unique per variant), e.g. `skull-mace-var-2`. */
  readonly manifestKey: string;
  /** SHA-256 (lowercase hex) of the PNG bytes carried by this request. */
  readonly contentHash: string;
  /** Canonical brief identity this variant belongs to. */
  readonly briefId: string;
  /** Canonical variant identity within the brief. */
  readonly variantIndex: number;
  /** Producing run directory, or null when the asset has no run provenance. */
  readonly sourceRun: string | null;
}

/** One per-key sprite annotation update. Never a whole-document replacement. */
export interface AssetRequestAnnotation {
  readonly key: string;
  readonly favorite: boolean;
  readonly disliked: boolean;
  readonly comment: string;
}

/**
 * A tightly constrained removal. It carries an explicit same-content duplicate
 * proof: the identical bytes MUST survive at `duplicateOfAssetPath`, so a
 * removal can never delete the last copy of an asset.
 */
export interface AssetRequestRemoval {
  readonly assetPath: string;
  readonly manifestKey: string;
  /** SHA-256 (hex) of the bytes being removed — must match `main` at apply time. */
  readonly contentHash: string;
  /** Surviving path holding byte-identical content. */
  readonly duplicateOfAssetPath: string;
  /** Surviving path's manifest shard key. */
  readonly duplicateOfManifestKey: string;
}

/** The sealed request manifest. `requestId` is derived from every other field. */
export interface AssetRequestManifest {
  readonly version: typeof ASSET_REQUEST_MANIFEST_VERSION;
  /** Derived id — SHA-256 (hex) over the canonical body. */
  readonly requestId: string;
  readonly operation: AssetRequestOperation;
  readonly assets: readonly AssetRequestAsset[];
  readonly annotations: readonly AssetRequestAnnotation[];
  readonly removals: readonly AssetRequestRemoval[];
  /** `main` commit SHA observed when the request was created (40 hex). */
  readonly observedMainSha: string;
  /** Producer identity, e.g. `sprite-editor`, `approve-cli`, `queue-migration`. */
  readonly producer: string;
  /**
   * Deterministic creation metadata: stable, caller-supplied key/value pairs
   * (workflow ref, run id, originating queue SHA, ...). No wall clock — a clock
   * would break replay-identical request ids.
   */
  readonly provenance: Readonly<Record<string, string>>;
  /** Request id this one supersedes (a correction), or null. */
  readonly supersedes: string | null;
}

/** Everything except the derived `requestId`. */
export type AssetRequestManifestBody = Omit<AssetRequestManifest, 'requestId'>;

export type AssetRequestErrorKind = 'invalid-manifest' | 'invalid-payload' | 'invalid-request-id';

export class AssetRequestError extends Error {
  constructor(
    readonly kind: AssetRequestErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AssetRequestError';
  }
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SHA1_HEX = /^[0-9a-f]{40}$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function fail(kind: AssetRequestErrorKind, message: string): never {
  throw new AssetRequestError(kind, message);
}

/**
 * Deterministic JSON with object keys sorted at every depth. The request id is
 * a hash of this string, so two structurally identical manifests written with
 * different key order MUST produce the same bytes.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** SHA-256 (hex) of a UTF-8 string. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** SHA-256 (hex) of raw bytes — used to verify a payload PNG against its hash. */
export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Derive the content-addressed request id from a validated manifest body. */
export function computeRequestId(body: AssetRequestManifestBody): string {
  return sha256Hex(canonicalJson(body));
}

function assertRequestId(requestId: string): void {
  if (!SHA256_HEX.test(requestId)) {
    fail('invalid-request-id', `request id must be 64 lowercase hex characters: "${requestId}"`);
  }
}

/** Branch name (no `refs/heads/`) for a request id. */
export function requestBranchName(requestId: string): string {
  assertRequestId(requestId);
  return `${ASSET_REQUEST_BRANCH_PREFIX}${requestId}`;
}

/** Archive branch name for a consumed request id. */
export function archiveBranchName(requestId: string): string {
  assertRequestId(requestId);
  return `${ASSET_REQUEST_ARCHIVE_BRANCH_PREFIX}${requestId}`;
}

/** Repo-relative POSIX path of a request's manifest inside its own commit. */
export function requestManifestPath(requestId: string): string {
  assertRequestId(requestId);
  return `${ASSET_REQUEST_MANIFEST_DIR}/${requestId}.json`;
}

/** Extract the request id from a full/short ref name, or null when not a request ref. */
export function requestIdFromRef(ref: string): string | null {
  const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
  if (!branch.startsWith(ASSET_REQUEST_BRANCH_PREFIX)) return null;
  const id = branch.slice(ASSET_REQUEST_BRANCH_PREFIX.length);
  return SHA256_HEX.test(id) ? id : null;
}

/** Repo-relative POSIX path of the committed PNG for a `public/assets`-relative path. */
export function pngRepoPath(assetPath: string): string {
  return `public/assets/${assetPath}`;
}

/** Repo-relative POSIX path of the manifest shard for a manifest key. */
export function shardRepoPath(manifestKey: string): string {
  return `${GENERATED_ROOT}/entries/${manifestKey}.json`;
}

function assertSafeManifestKeyValue(manifestKey: string, context: string): void {
  if (manifestKey.length === 0) {
    fail('invalid-payload', `${context}: manifest key must not be empty`);
  }
  if (manifestKey.includes('\\') || manifestKey.includes('\0')) {
    fail(
      'invalid-payload',
      `${context}: manifest key must be POSIX and NUL-free: "${manifestKey}"`,
    );
  }
  if (manifestKey.startsWith('/') || /^[A-Za-z]:/.test(manifestKey)) {
    fail('invalid-payload', `${context}: manifest key must be relative: "${manifestKey}"`);
  }
  for (const segment of manifestKey.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      fail('invalid-payload', `${context}: manifest key has an unsafe segment: "${manifestKey}"`);
    }
  }
}

function assertHash(value: string, context: string): void {
  if (!SHA256_HEX.test(value)) {
    fail('invalid-payload', `${context}: contentHash must be 64 lowercase hex characters`);
  }
}

function assertAssetIdentity(
  asset: AssetRequestAsset | AssetRequestRemoval,
  context: string,
): void {
  if (!isSafeGeneratedAssetPath(asset.assetPath)) {
    fail(
      'invalid-payload',
      `${context}: assetPath "${asset.assetPath}" must be a traversal-free generated/*.png path`,
    );
  }
  assertSafeManifestKeyValue(asset.manifestKey, context);
  assertHash(asset.contentHash, context);
}

/**
 * Validate a manifest body's internal consistency. Throws `AssetRequestError`
 * on the first violation — every rule here is fail-closed by design.
 */
export function assertValidManifestBody(body: AssetRequestManifestBody): void {
  if (body.version !== ASSET_REQUEST_MANIFEST_VERSION) {
    fail('invalid-manifest', `unsupported request manifest version: ${String(body.version)}`);
  }
  if (!SHA1_HEX.test(body.observedMainSha)) {
    fail('invalid-manifest', 'observedMainSha must be a full 40-hex commit SHA');
  }
  if (!SAFE_IDENTIFIER.test(body.producer)) {
    fail('invalid-manifest', `producer identity is not a safe identifier: "${body.producer}"`);
  }
  if (body.supersedes !== null && !SHA256_HEX.test(body.supersedes ?? '')) {
    fail('invalid-manifest', 'supersedes must be null or a 64-hex request id');
  }
  for (const [key, value] of Object.entries(body.provenance)) {
    if (!SAFE_IDENTIFIER.test(key)) {
      fail('invalid-manifest', `provenance key is not a safe identifier: "${key}"`);
    }
    if (typeof value !== 'string' || value.length > 512) {
      fail('invalid-manifest', `provenance value for "${key}" must be a string of <= 512 chars`);
    }
  }

  const populated = [
    body.assets.length > 0 ? 'assets' : null,
    body.annotations.length > 0 ? 'annotations' : null,
    body.removals.length > 0 ? 'removals' : null,
  ].filter((entry): entry is string => entry !== null);
  if (populated.length !== 1) {
    fail(
      'invalid-manifest',
      `a request must populate exactly one payload array, got [${populated.join(', ')}]`,
    );
  }

  switch (body.operation) {
    case 'upsert-asset': {
      if (body.assets.length === 0) fail('invalid-manifest', 'upsert-asset requires assets');
      const seenPaths = new Set<string>();
      const seenKeys = new Set<string>();
      for (const asset of body.assets) {
        assertAssetIdentity(asset, `asset "${asset.assetPath}"`);
        if (!SAFE_IDENTIFIER.test(asset.briefId)) {
          fail('invalid-payload', `asset "${asset.assetPath}": briefId is not a safe identifier`);
        }
        if (!Number.isInteger(asset.variantIndex) || asset.variantIndex < 0) {
          fail(
            'invalid-payload',
            `asset "${asset.assetPath}": variantIndex must be a non-negative integer`,
          );
        }
        if (asset.sourceRun !== null && !SAFE_IDENTIFIER.test(asset.sourceRun)) {
          fail('invalid-payload', `asset "${asset.assetPath}": sourceRun is not a safe identifier`);
        }
        if (seenPaths.has(asset.assetPath)) {
          fail('invalid-payload', `duplicate assetPath in one request: "${asset.assetPath}"`);
        }
        if (seenKeys.has(asset.manifestKey)) {
          fail('invalid-payload', `duplicate manifestKey in one request: "${asset.manifestKey}"`);
        }
        seenPaths.add(asset.assetPath);
        seenKeys.add(asset.manifestKey);
      }
      break;
    }
    case 'update-annotations': {
      if (body.annotations.length === 0) {
        fail('invalid-manifest', 'update-annotations requires annotations');
      }
      const seen = new Set<string>();
      for (const annotation of body.annotations) {
        if (!SAFE_IDENTIFIER.test(annotation.key)) {
          fail('invalid-payload', `annotation key is not a safe identifier: "${annotation.key}"`);
        }
        if (typeof annotation.favorite !== 'boolean' || typeof annotation.disliked !== 'boolean') {
          fail(
            'invalid-payload',
            `annotation "${annotation.key}": favorite/disliked must be booleans`,
          );
        }
        if (typeof annotation.comment !== 'string') {
          fail('invalid-payload', `annotation "${annotation.key}": comment must be a string`);
        }
        if (annotation.comment.length > MAX_ANNOTATION_COMMENT_LENGTH) {
          fail(
            'invalid-payload',
            `annotation "${annotation.key}": comment exceeds ${MAX_ANNOTATION_COMMENT_LENGTH} characters`,
          );
        }
        if (seen.has(annotation.key)) {
          fail('invalid-payload', `duplicate annotation key in one request: "${annotation.key}"`);
        }
        seen.add(annotation.key);
      }
      break;
    }
    case 'remove-asset': {
      if (body.removals.length === 0) fail('invalid-manifest', 'remove-asset requires removals');
      const seen = new Set<string>();
      for (const removal of body.removals) {
        assertAssetIdentity(removal, `removal "${removal.assetPath}"`);
        if (!isSafeGeneratedAssetPath(removal.duplicateOfAssetPath)) {
          fail(
            'invalid-payload',
            `removal "${removal.assetPath}": duplicateOfAssetPath must be a generated/*.png path`,
          );
        }
        assertSafeManifestKeyValue(
          removal.duplicateOfManifestKey,
          `removal "${removal.assetPath}"`,
        );
        if (removal.duplicateOfAssetPath === removal.assetPath) {
          fail(
            'invalid-payload',
            `removal "${removal.assetPath}": duplicate proof must name a DIFFERENT surviving path`,
          );
        }
        if (seen.has(removal.assetPath)) {
          fail('invalid-payload', `duplicate removal path in one request: "${removal.assetPath}"`);
        }
        seen.add(removal.assetPath);
      }
      break;
    }
    default:
      fail('invalid-manifest', `unknown operation: "${String(body.operation)}"`);
  }
}

/** Seal a validated body into a manifest with its derived id. */
export function sealAssetRequest(body: AssetRequestManifestBody): AssetRequestManifest {
  assertValidManifestBody(body);
  return { ...body, requestId: computeRequestId(body) };
}

/** Canonical on-disk text of a manifest (stable bytes, trailing newline). */
export function serializeAssetRequest(manifest: AssetRequestManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function asArray<T>(value: unknown, field: string): readonly T[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail('invalid-manifest', `"${field}" must be an array`);
  return value as T[];
}

function asProvenance(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid-manifest', '"provenance" must be an object');
  }
  return value as Record<string, string>;
}

/**
 * Parse + fully validate a manifest read back out of a request commit, and
 * re-derive its id. A manifest whose stored id does not match its body has been
 * tampered with (or hand-edited) and is rejected — this is the seal check.
 */
export function parseAssetRequest(text: string): AssetRequestManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new AssetRequestError('invalid-manifest', 'request manifest is not valid JSON', {
      cause: error,
    });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail('invalid-manifest', 'request manifest must be a JSON object');
  }
  const raw = parsed as Record<string, unknown>;
  const requestId = raw.requestId;
  if (typeof requestId !== 'string') {
    fail('invalid-manifest', 'request manifest is missing requestId');
  }

  const body: AssetRequestManifestBody = {
    version: raw.version as typeof ASSET_REQUEST_MANIFEST_VERSION,
    operation: raw.operation as AssetRequestOperation,
    assets: asArray<AssetRequestAsset>(raw.assets, 'assets'),
    annotations: asArray<AssetRequestAnnotation>(raw.annotations, 'annotations'),
    removals: asArray<AssetRequestRemoval>(raw.removals, 'removals'),
    observedMainSha: String(raw.observedMainSha ?? ''),
    producer: String(raw.producer ?? ''),
    provenance: asProvenance(raw.provenance),
    supersedes: raw.supersedes === undefined ? null : (raw.supersedes as string | null),
  };
  assertValidManifestBody(body);
  const derived = computeRequestId(body);
  if (derived !== requestId) {
    fail(
      'invalid-request-id',
      `request manifest id ${requestId} does not match its content (${derived}); ` +
        'a sealed request is immutable — publish a superseding request instead of editing one',
    );
  }
  return { ...body, requestId };
}

/**
 * Every repo-relative POSIX path a request commit is allowed to contain: its
 * own manifest plus exactly its declared payload. The reconciler compares this
 * set against the request commit's actual tree, so a request can never smuggle
 * in an undeclared file.
 */
export function declaredRequestPaths(manifest: AssetRequestManifest): readonly string[] {
  const paths = new Set<string>([requestManifestPath(manifest.requestId)]);
  for (const asset of manifest.assets) {
    paths.add(pngRepoPath(asset.assetPath));
    paths.add(shardRepoPath(asset.manifestKey));
  }
  // Annotation updates travel as manifest DATA (per key), never as a copy of
  // the aggregate document, so an annotation request carries no payload blob and
  // structurally cannot clobber another sprite's keys. Removals likewise carry
  // no bytes — the manifest's duplicate proof alone authorizes the delete.
  return [...paths].sort();
}

/**
 * Conflict units a request MUTATES on `main`. Asset/removal requests conflict
 * per repo path; annotation requests conflict per sprite KEY (never on the
 * shared aggregate document), so two editors annotating different sprites are
 * always compatible.
 */
export function destinationUnits(manifest: AssetRequestManifest): readonly string[] {
  const units = new Set<string>();
  for (const asset of manifest.assets) {
    units.add(pngRepoPath(asset.assetPath));
    units.add(shardRepoPath(asset.manifestKey));
  }
  for (const removal of manifest.removals) {
    units.add(pngRepoPath(removal.assetPath));
    units.add(shardRepoPath(removal.manifestKey));
  }
  for (const annotation of manifest.annotations) {
    units.add(`${ANNOTATIONS_PATH}#${annotation.key}`);
  }
  return [...units].sort();
}

/** Repo paths (real files) a request reads/writes on `main`, for staleness checks. */
export function destinationPaths(manifest: AssetRequestManifest): readonly string[] {
  const paths = new Set<string>();
  for (const asset of manifest.assets) {
    paths.add(pngRepoPath(asset.assetPath));
    paths.add(shardRepoPath(asset.manifestKey));
  }
  for (const removal of manifest.removals) {
    paths.add(pngRepoPath(removal.assetPath));
    paths.add(shardRepoPath(removal.manifestKey));
  }
  return [...paths].sort();
}
