import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import {
  generatedManifestConceptId,
  isRuntimeEligibleManifestEntry,
  type ManifestEntry,
} from '../../src/shared/generated-assets.js';
import { normalizeGeneratedSpriteConceptId } from '../../src/shared/sprite-concepts.js';
import {
  readPendingDislikedSpriteNames,
  resolvePendingAnnotationsPath,
} from '../../.github/extensions/sprite-editor/lib/pending-annotation-overlay.mjs';
import { unapproveVariant } from './approve.js';
import { composeManifestFromShards, shardPathForKey } from './generated-shards.js';
import { applySpriteAnnotationUpdates, type SpriteAnnotationUpdate } from './queue-commit.js';

const ANNOTATIONS_RELATIVE_PATH = 'public/assets/generated/sprite-editor-annotations.json';
const REFERENCE_EXTENSIONS = new Set(['.json', '.js', '.mjs', '.ts', '.tsx', '.yaml', '.yml']);
// Checked-in executable/configuration roots participate in deletion closure.
// docs/ is intentionally excluded: ADRs, handoffs, and metrics are immutable
// audit history, not live references, and must not be rewritten by lifecycle work.
const REFERENCE_ROOTS = [
  'src',
  'scripts',
  '.github',
  'tests',
  'data',
  'tools',
  'functions',
] as const;

export interface SpriteAnnotation {
  readonly favorite?: boolean;
  readonly disliked?: boolean;
  readonly comment?: string;
  readonly sourceRun?: string;
  readonly variantIndex?: number;
  readonly tombstone?: DislikedSpriteTombstone;
  readonly reconciliation?: {
    readonly outcome: 'unmatched';
    readonly annotationKey: string;
  };
}

export interface DislikedSpriteTombstone {
  readonly manifestKey: string;
  readonly conceptId: string;
  /** Exact accepted replacement that authorized this lifecycle deletion. */
  readonly replacementKey?: string;
  readonly assetPath: string;
  readonly sourceRun: string;
  readonly variantIndex: number;
  readonly annotationKeys: readonly string[];
  /**
   * AUDIT-ONLY provenance marker. NOTHING in this pipeline reads it to decide
   * anything: it is never produced by {@link buildDislikedLifecyclePlan}, never
   * consulted by {@link validateDislikedLifecycleClosure}, and never grants
   * deletion authority. It exists solely to record that a closed set of
   * historical tombstones was written by the one-time pre-hardening migration,
   * BEFORE stale annotation keys required exact-key or source-run provenance
   * corroboration. Deleting these markers would erase audit history; adding new
   * ones would falsely imply a migration that did not happen — so the marker
   * vocabulary is a closed literal union and the guard tests derive their
   * invariants from the data rather than pinning a magic count.
   */
  readonly authority?: 'pre-hardening-corroborated-provenance';
}

export interface SpriteAnnotationsDocument {
  readonly version: 1;
  readonly sprites: Readonly<Record<string, SpriteAnnotation>>;
}

export interface PendingAnnotationRecord {
  readonly base?: unknown;
  readonly annotation?: SpriteAnnotation;
}

export interface LifecycleReplacement {
  readonly manifestKey: string;
  readonly conceptId: string;
  readonly assetPath: string;
}

export interface LifecycleRemoval {
  readonly manifestKey: string;
  readonly conceptId: string;
  readonly assetPath: string;
  readonly sourceRun: string;
  readonly variantIndex: number;
  readonly replacementKey: string;
  readonly replacementAssetPath: string;
  readonly annotationKeys: readonly string[];
}

export interface LifecycleReferenceUpdate {
  readonly path: string;
  readonly before: string;
  readonly after: string;
}

export interface DislikedLifecyclePlan {
  readonly removed: readonly LifecycleRemoval[];
  readonly retainedGroups: readonly {
    readonly conceptId: string;
    readonly manifestKeys: readonly string[];
  }[];
  /**
   * Groups that ARE immediately removable but fall outside this plan's
   * {@link BuildDislikedLifecyclePlanInput.conceptScope}. Reported, never
   * silently dropped: an explicit acceptance only cleans the concept it
   * replaced, and `npm run sprites:disliked-lifecycle -- --apply` (unscoped)
   * remains the sweeper that finishes the rest. Nothing here is mutated, so a
   * deferred group cannot dangle — its art and annotations stay intact.
   */
  readonly deferredGroups: readonly {
    readonly conceptId: string;
    readonly manifestKeys: readonly string[];
  }[];
  readonly unresolvedAnnotationKeys: readonly string[];
  readonly annotations: SpriteAnnotationsDocument;
  readonly annotationUpdates: readonly (
    | { readonly key: string; readonly delete: true }
    | ({ readonly key: string; readonly delete?: false } & SpriteAnnotation)
  )[];
  readonly referenceUpdates: readonly LifecycleReferenceUpdate[];
  readonly promotedPendingCount: number;
}

export interface BuildDislikedLifecyclePlanInput {
  readonly repoRoot: string;
  readonly manifestEntries: Readonly<Record<string, ManifestEntry>>;
  readonly trackedAnnotations: SpriteAnnotationsDocument;
  readonly pendingAnnotations?: Readonly<Record<string, PendingAnnotationRecord>>;
  readonly pendingDislikedKeys?: ReadonlySet<string>;
  /**
   * Art whose acceptance is being explicitly authorized right now. Each entry
   * counts as a runtime-eligible survivor for its concept and has its own
   * dislike cleared, so accepting a replacement retires the variants it
   * replaces.
   */
  readonly replacements?: readonly LifecycleReplacement[];
  /**
   * Restrict every MUTATION this plan proposes to these normalized concepts.
   * Absent means repo-wide (the standalone lifecycle CLI). Acceptance passes
   * the accepted concepts so an unrelated concept's exact pin can never block
   * an approval, and so one acceptance never silently deletes art for a
   * concept the human did not touch.
   */
  readonly conceptScope?: ReadonlySet<string>;
  readonly readReferenceFiles?: boolean;
}

export interface ApplyDislikedLifecycleResult {
  readonly removedCount: number;
  readonly retainedGroupCount: number;
  readonly deferredGroupCount: number;
  readonly promotedPendingCount: number;
}

interface ReconciledDislike {
  readonly manifestKey: string;
  readonly annotationKeys: readonly string[];
  readonly annotation: SpriteAnnotation;
}

class AmbiguousDislikeError extends Error {}

interface FileSnapshot {
  readonly path: string;
  readonly bytes: Buffer | null;
}

/**
 * Manifest keys whose provenance matches `annotation`, sorted. Read-only and
 * total: it never throws, so both the fail-closed mutation resolver and the
 * read-only reference resolver can share one matching rule.
 */
function provenanceCandidateKeys(
  annotation: SpriteAnnotation,
  entries: Readonly<Record<string, ManifestEntry>>,
): readonly string[] {
  if (
    typeof annotation.sourceRun !== 'string' ||
    annotation.sourceRun.trim() === '' ||
    typeof annotation.variantIndex !== 'number' ||
    !Number.isInteger(annotation.variantIndex) ||
    annotation.variantIndex < 0
  ) {
    return [];
  }
  const sourceRunBasename = path.posix.basename(annotation.sourceRun.replace(/\\/g, '/'));
  return Object.entries(entries)
    .filter(
      ([, entry]) =>
        entry.variantIndex === annotation.variantIndex &&
        path.posix.basename(entry.sourceRun.replace(/\\/g, '/')) === sourceRunBasename,
    )
    .map(([manifestKey]) => manifestKey)
    .sort();
}

function reconcileDislikeKey(
  key: string,
  annotation: SpriteAnnotation,
  entries: Readonly<Record<string, ManifestEntry>>,
): string | null {
  if (entries[key] !== undefined) return key;
  if (annotation.tombstone !== undefined) return null;

  const candidates = provenanceCandidateKeys(annotation, entries);
  if (candidates.length > 1) {
    throw new AmbiguousDislikeError(
      `Disliked annotation "${key}" is ambiguous: provenance matched ${candidates.join(
        ', ',
      )}. Add sourceRun provenance before retrying.`,
    );
  }
  return candidates[0] ?? null;
}

function mergePendingAnnotations(
  tracked: SpriteAnnotationsDocument,
  pending: Readonly<Record<string, PendingAnnotationRecord>>,
  pendingDislikedKeys: ReadonlySet<string>,
  isKeyInScope: (key: string) => boolean,
): { document: SpriteAnnotationsDocument; promotedCount: number } {
  const sprites: Record<string, SpriteAnnotation> = { ...tracked.sprites };
  let promotedCount = 0;
  for (const key of [...pendingDislikedKeys].sort()) {
    // Scope gate FIRST: promoting an out-of-scope pending dislike would make a
    // narrow acceptance publish curation the human never accepted for a concept
    // they never touched (and, once tracked, arm that concept for deletion by
    // the next sweep). The repo-wide CLI passes no scope, so it still promotes
    // every pending dislike.
    if (!isKeyInScope(key)) continue;
    const record = pending[key];
    const annotation = record?.annotation;
    if (annotation?.disliked !== true) continue;
    sprites[key] = {
      ...(tracked.sprites[key] ?? {}),
      favorite: false,
      disliked: true,
      comment: annotation.comment ?? '',
      ...(annotation.sourceRun !== undefined ? { sourceRun: annotation.sourceRun } : {}),
      ...(annotation.variantIndex !== undefined ? { variantIndex: annotation.variantIndex } : {}),
    };
    promotedCount += 1;
  }
  return { document: { version: 1, sprites }, promotedCount };
}

function reconcileDislikes(
  annotations: SpriteAnnotationsDocument,
  entries: Readonly<Record<string, ManifestEntry>>,
  isKeyInScope: (key: string) => boolean = () => true,
): { reconciled: readonly ReconciledDislike[]; unresolved: readonly string[] } {
  const grouped = new Map<string, { keys: string[]; annotation: SpriteAnnotation }>();
  const unresolved: string[] = [];
  for (const [key, annotation] of Object.entries(annotations.sprites).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (annotation.disliked !== true) continue;
    let manifestKey: string | null;
    try {
      manifestKey = reconcileDislikeKey(key, annotation, entries);
    } catch (error) {
      if (error instanceof AmbiguousDislikeError && !isKeyInScope(key)) {
        unresolved.push(key);
        continue;
      }
      throw error;
    }
    if (manifestKey === null) {
      if (annotation.tombstone === undefined) unresolved.push(key);
      continue;
    }

    const current = grouped.get(manifestKey);
    if (current === undefined) {
      grouped.set(manifestKey, { keys: [key], annotation });
    } else {
      current.keys.push(key);
    }
  }
  return {
    reconciled: [...grouped.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([manifestKey, value]) => ({
        manifestKey,
        annotationKeys: value.keys.sort(),
        annotation: value.annotation,
      })),
    unresolved: unresolved.sort(),
  };
}

/** Read-only exclusion sets for generation reference selection. */
export interface DislikedReferenceExclusions {
  /** Exact manifest keys that must never be sent as a generation reference. */
  readonly manifestKeys: ReadonlySet<string>;
  /**
   * Normalized concepts whose art must be excluded wholesale because a dislike
   * naming them could not be pinned to one exact accepted key.
   */
  readonly conceptIds: ReadonlySet<string>;
}

/**
 * Resolve disliked annotation keys to reference-selection exclusions.
 *
 * READ-ONLY. This grants ZERO deletion authority — it never feeds
 * {@link buildDislikedLifecyclePlan}. That asymmetry is deliberate: deleting
 * the wrong asset is unrecoverable, so mutation stays fail-closed (an
 * unresolvable or ambiguous key is preserved, never deleted), while merely
 * declining to send a sprite back to the image model as a style reference is
 * free. So this resolver fails SAFE in the other direction:
 *
 *   - exact manifest key → exclude that key;
 *   - unique source-run + variant-index provenance match → exclude that key;
 *   - ambiguous provenance → exclude every implicated key AND their concepts;
 *   - already tombstoned → nothing to exclude (the art is gone and its
 *     surviving replacement is legitimately referenceable);
 *   - otherwise (a stale key naming art that may still exist under a renamed
 *     key) → exclude the normalized concept the key names.
 *
 * `annotations` is optional so callers that only have a name set still get the
 * exact + conservative-concept behavior; supplying the full annotations lets
 * provenance rescue a stale key to its exact accepted entry.
 */
export function resolveDislikedReferenceExclusions(
  entries: Readonly<Record<string, ManifestEntry>>,
  dislikedKeys: ReadonlySet<string>,
  annotations: Readonly<Record<string, SpriteAnnotation>> = {},
): DislikedReferenceExclusions {
  const manifestKeys = new Set<string>();
  const conceptIds = new Set<string>();
  for (const key of [...dislikedKeys].sort()) {
    if (entries[key] !== undefined) {
      manifestKeys.add(key);
      continue;
    }
    const annotation = annotations[key] ?? {};
    if (annotation.tombstone !== undefined) continue;
    const candidates = provenanceCandidateKeys(annotation, entries);
    if (candidates.length === 1) {
      manifestKeys.add(candidates[0]!);
      continue;
    }
    if (candidates.length > 1) {
      for (const candidate of candidates) {
        manifestKeys.add(candidate);
        // MUST be the same derivation the reference selector groups by
        // (`generatedManifestConceptId`), not a hand-rolled `briefId` strip: an
        // icon-batch row's `briefId` is the BATCH id, so a hand-derived key
        // would exclude the batch concept while the selector keyed the row
        // under the cell's own concept — and the ambiguous dislike would
        // silently fail to exclude anything at all.
        conceptIds.add(generatedManifestConceptId(entries[candidate]!, candidate));
      }
      continue;
    }
    conceptIds.add(normalizeGeneratedSpriteConceptId(key));
  }
  return { manifestKeys, conceptIds };
}

function walkReferenceFiles(repoRoot: string): string[] {
  const files: string[] = [];
  const walk = (absolute: string): void => {
    if (!existsSync(absolute)) return;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (
        entry.name === 'node_modules' ||
        entry.name === '.git' ||
        entry.name === 'generated' ||
        entry.name === 'sprite-editor-annotations.json'
      ) {
        continue;
      }
      const child = path.join(absolute, entry.name);
      if (entry.isDirectory()) {
        walk(child);
      } else if (entry.isFile() && REFERENCE_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(child);
      }
    }
  };
  for (const root of REFERENCE_ROOTS) walk(path.join(repoRoot, root));
  return files.sort((a, b) => a.localeCompare(b));
}

function exactReferencePattern(value: string): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}(?=$|[^A-Za-z0-9_-])`, 'gu');
}

function replaceExactReference(text: string, before: string, after: string): string {
  return text.replace(
    exactReferencePattern(before),
    (_match, prefix: string) => `${prefix}${after}`,
  );
}

function replaceExactReferences(
  repoRoot: string,
  removals: readonly LifecycleRemoval[],
): LifecycleReferenceUpdate[] {
  if (removals.length === 0) return [];
  const replacements = new Map<string, string>();
  for (const removal of removals) {
    replacements.set(removal.manifestKey, removal.replacementKey);
    replacements.set(removal.assetPath, removal.replacementAssetPath);
  }

  const updates: LifecycleReferenceUpdate[] = [];
  for (const file of walkReferenceFiles(repoRoot)) {
    const before = readFileSync(file, 'utf8');
    let after = before;
    for (const [removed, replacement] of [...replacements].sort(
      ([a], [b]) => b.length - a.length || a.localeCompare(b),
    )) {
      after = replaceExactReference(after, removed, replacement);
    }
    if (after !== before) updates.push({ path: file, before, after });
  }
  return updates;
}

export function buildDislikedLifecyclePlan(
  input: BuildDislikedLifecyclePlanInput,
): DislikedLifecyclePlan {
  const pending = input.pendingAnnotations ?? {};
  const pendingKeys = input.pendingDislikedKeys ?? new Set<string>();
  const inScope = (conceptId: string): boolean =>
    input.conceptScope === undefined || input.conceptScope.has(conceptId);
  /**
   * True when an ANNOTATION key belongs to a concept this plan may mutate.
   *
   * A key is in scope when EITHER derivation of its concept is: the manifest
   * entry's `briefId` (authoritative while the art exists, and the same key the
   * removal grouping below uses) or the bare key itself (the only thing a
   * tombstoned or stale key has left — and the id an icon-batch acceptance
   * declares, since those entries carry the BATCH brief id, not the icon's).
   * The union keeps a narrow acceptance from touching an unrelated concept
   * without accidentally excluding the very art being accepted.
   */
  const isKeyInScope = (key: string): boolean => {
    if (input.conceptScope === undefined) return true;
    const briefId = input.manifestEntries[key]?.briefId;
    return (
      (briefId !== undefined &&
        briefId !== '' &&
        inScope(normalizeGeneratedSpriteConceptId(briefId))) ||
      inScope(normalizeGeneratedSpriteConceptId(key))
    );
  };
  const promoted = mergePendingAnnotations(
    input.trackedAnnotations,
    pending,
    pendingKeys,
    isKeyInScope,
  );
  const { reconciled, unresolved } = reconcileDislikes(
    promoted.document,
    input.manifestEntries,
    isKeyInScope,
  );
  const dislikedKeys = new Set(reconciled.map((item) => item.manifestKey));
  const groups = new Map<string, Array<[string, ManifestEntry]>>();
  for (const pair of Object.entries(input.manifestEntries)) {
    const concept = generatedManifestConceptId(pair[1], pair[0]);
    const group = groups.get(concept) ?? [];
    group.push(pair);
    groups.set(concept, group);
  }

  const removals: LifecycleRemoval[] = [];
  const retainedGroups: Array<{ conceptId: string; manifestKeys: string[] }> = [];
  const deferredGroups: Array<{ conceptId: string; manifestKeys: string[] }> = [];
  const replacementsByConcept = new Map<string, LifecycleReplacement[]>();
  for (const replacement of input.replacements ?? []) {
    const bucket = replacementsByConcept.get(replacement.conceptId) ?? [];
    bucket.push(replacement);
    replacementsByConcept.set(replacement.conceptId, bucket);
  }

  for (const [conceptId, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const disliked = group.filter(([key]) => dislikedKeys.has(key));
    if (disliked.length === 0) continue;
    const conceptReplacements = [...(replacementsByConcept.get(conceptId) ?? [])].sort((a, b) =>
      a.manifestKey.localeCompare(b.manifestKey),
    );
    const replacementKeys = new Set(conceptReplacements.map((item) => item.manifestKey));
    // Runtime eligibility is the ONE survivor test (see
    // `isRuntimeEligibleManifestEntry`): a placeholder stand-in or an entry the
    // manifest itself marks `disliked` is invisible to the engine registry, so
    // treating it as a survivor would delete real art the game can never pick.
    const survivors = group
      .filter(([key, entry]) => !dislikedKeys.has(key) && isRuntimeEligibleManifestEntry(entry))
      .map(([key, entry]) => ({
        manifestKey: key,
        assetPath: entry.assetPath,
      }))
      .sort((a, b) => a.manifestKey.localeCompare(b.manifestKey));
    for (const replacement of [...conceptReplacements].reverse()) {
      survivors.unshift({
        manifestKey: replacement.manifestKey,
        assetPath: replacement.assetPath,
      });
    }
    if (survivors.length === 0) {
      retainedGroups.push({
        conceptId,
        manifestKeys: disliked.map(([key]) => key).sort(),
      });
      continue;
    }
    const removable = disliked
      .filter(([key]) => !replacementKeys.has(key))
      .sort(([a], [b]) => a.localeCompare(b));
    if (removable.length === 0) continue;
    if (!inScope(conceptId)) {
      deferredGroups.push({
        conceptId,
        manifestKeys: removable.map(([key]) => key),
      });
      continue;
    }
    const survivor = survivors[0]!;
    for (const [manifestKey, entry] of removable) {
      const reconciliation = reconciled.find((item) => item.manifestKey === manifestKey)!;
      removals.push({
        manifestKey,
        conceptId,
        assetPath: entry.assetPath,
        sourceRun: entry.sourceRun,
        variantIndex: entry.variantIndex,
        replacementKey: survivor.manifestKey,
        replacementAssetPath: survivor.assetPath,
        annotationKeys: reconciliation.annotationKeys,
      });
    }
  }

  const sprites: Record<string, SpriteAnnotation> = { ...promoted.document.sprites };
  for (const replacement of input.replacements ?? []) {
    if (!inScope(replacement.conceptId)) continue;
    const reconciledReplacement = reconciled.find(
      (item) => item.manifestKey === replacement.manifestKey,
    );
    if (reconciledReplacement === undefined) continue;
    const sourceAnnotations = reconciledReplacement.annotationKeys
      .map((key) => sprites[key])
      .filter((annotation): annotation is SpriteAnnotation => annotation !== undefined);
    for (const key of reconciledReplacement.annotationKeys) {
      if (key !== replacement.manifestKey) delete sprites[key];
    }
    sprites[replacement.manifestKey] = {
      ...(sprites[replacement.manifestKey] ?? {}),
      favorite: false,
      disliked: false,
      comment:
        sprites[replacement.manifestKey]?.comment ??
        sourceAnnotations.find((annotation) => (annotation.comment ?? '') !== '')?.comment ??
        '',
      // Own property with an explicit `undefined`: downstream publication
      // mappers MUST forward this as an intentional CLEAR (the accepted
      // replacement is no longer a tombstoned deletion), while a key that
      // never owned `tombstone` must leave the queue tip's value untouched.
      tombstone: undefined,
      reconciliation: undefined,
    };
  }
  const unresolvedKeys = new Set(unresolved);
  for (const key of unresolvedKeys) {
    if (!isKeyInScope(key)) continue;
    const annotation = sprites[key] ?? {};
    sprites[key] = {
      ...annotation,
      reconciliation: { outcome: 'unmatched', annotationKey: key },
    };
  }
  // A key that USED to be unmatched and now reconciles (its shard came back, or
  // provenance finally pins it, or the human cleared the dislike) must have the
  // stale marker retracted — otherwise the Sprite Editor keeps warning about a
  // reconciliation failure that no longer exists, forever. Emitted as an OWN
  // property holding `undefined` so `toQueueCommitAnnotationUpdates` /
  // `mergeSpriteAnnotationUpdates` forward it as an intentional DELETE, while a
  // key that never owned `reconciliation` still leaves the queue tip alone.
  for (const [key, annotation] of Object.entries(sprites)) {
    if (unresolvedKeys.has(key)) continue;
    if (!Object.hasOwn(annotation, 'reconciliation') || annotation.reconciliation === undefined) {
      continue;
    }
    if (!isKeyInScope(key)) continue;
    sprites[key] = { ...annotation, reconciliation: undefined };
  }
  for (const removal of removals) {
    const notes = removal.annotationKeys.map((key) => sprites[key]).filter(Boolean);
    for (const key of removal.annotationKeys) delete sprites[key];
    sprites[removal.manifestKey] = {
      favorite: false,
      disliked: true,
      comment: notes.find((note) => (note?.comment ?? '') !== '')?.comment ?? '',
      tombstone: {
        manifestKey: removal.manifestKey,
        conceptId: removal.conceptId,
        replacementKey: removal.replacementKey,
        assetPath: removal.assetPath,
        sourceRun: removal.sourceRun,
        variantIndex: removal.variantIndex,
        annotationKeys: removal.annotationKeys,
      },
    };
  }

  const sortedSprites = Object.fromEntries(
    Object.entries(sprites).sort(([a], [b]) => a.localeCompare(b)),
  );
  const annotationUpdates: Array<DislikedLifecyclePlan['annotationUpdates'][number]> = [];
  const annotationKeys = new Set([
    ...Object.keys(input.trackedAnnotations.sprites),
    ...Object.keys(sortedSprites),
  ]);
  for (const key of [...annotationKeys].sort()) {
    const before = input.trackedAnnotations.sprites[key];
    const after = sortedSprites[key];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    annotationUpdates.push(after === undefined ? { key, delete: true } : { key, ...after });
  }
  const planWithoutReferences: DislikedLifecyclePlan = {
    removed: removals.sort((a, b) => a.manifestKey.localeCompare(b.manifestKey)),
    retainedGroups,
    deferredGroups,
    unresolvedAnnotationKeys: unresolved,
    annotations: { version: 1, sprites: sortedSprites },
    annotationUpdates,
    referenceUpdates: [],
    promotedPendingCount: promoted.promotedCount,
  };
  return {
    ...planWithoutReferences,
    referenceUpdates:
      input.readReferenceFiles === false ? [] : replaceExactReferences(input.repoRoot, removals),
  };
}

function parseAnnotations(raw: string, source: string): SpriteAnnotationsDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${source} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { sprites?: unknown }).sprites !== 'object' ||
    (parsed as { sprites?: unknown }).sprites === null ||
    Array.isArray((parsed as { sprites?: unknown }).sprites)
  ) {
    throw new Error(`${source} must contain an object-valued "sprites" map.`);
  }
  return {
    version: 1,
    sprites: (parsed as { sprites: Record<string, SpriteAnnotation> }).sprites,
  };
}

export function readPendingDocument(pendingPath: string): Record<string, PendingAnnotationRecord> {
  if (!existsSync(pendingPath)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(pendingPath, 'utf8'));
    const sprites =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { readonly sprites?: unknown }).sprites
        : undefined;
    return sprites && typeof sprites === 'object' && !Array.isArray(sprites)
      ? (sprites as Record<string, PendingAnnotationRecord>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Read the tracked annotations document, treating an ABSENT file as an empty
 * document. Planning, closure validation, and the queue-tip merge in
 * `queue-commit-runtime.ts` all use this same "missing means empty" rule, so a
 * fresh checkout without an annotations file cannot make one of them throw a
 * raw ENOENT while the others succeed.
 */
function readTrackedAnnotations(repoRoot: string): SpriteAnnotationsDocument {
  const annotationsPath = path.join(repoRoot, ...ANNOTATIONS_RELATIVE_PATH.split('/'));
  if (!existsSync(annotationsPath)) return { version: 1, sprites: {} };
  return parseAnnotations(readFileSync(annotationsPath, 'utf8'), ANNOTATIONS_RELATIVE_PATH);
}

export function loadDislikedLifecyclePlan(
  repoRoot: string,
  replacements: readonly LifecycleReplacement[] = [],
  conceptScope?: ReadonlySet<string>,
): DislikedLifecyclePlan {
  const generatedDir = path.join(repoRoot, 'public', 'assets', 'generated');
  const tracked = readTrackedAnnotations(repoRoot);
  const pendingPath = resolvePendingAnnotationsPath(repoRoot);
  const pending = readPendingDocument(pendingPath);
  const pendingDislikedKeys = readPendingDislikedSpriteNames(pendingPath, {
    getCurrentAnnotation: (key: string) =>
      Object.hasOwn(tracked.sprites, key) ? tracked.sprites[key] : null,
  });
  return buildDislikedLifecyclePlan({
    repoRoot,
    manifestEntries: composeManifestFromShards(generatedDir).entries,
    trackedAnnotations: tracked,
    pendingAnnotations: pending,
    pendingDislikedKeys,
    replacements,
    ...(conceptScope !== undefined ? { conceptScope } : {}),
  });
}

function snapshot(paths: readonly string[]): FileSnapshot[] {
  return [...new Set(paths)].map((file) => ({
    path: file,
    bytes: existsSync(file) && statSync(file).isFile() ? readFileSync(file) : null,
  }));
}

function restoreSnapshots(snapshots: readonly FileSnapshot[]): void {
  for (const item of snapshots) {
    if (item.bytes === null) {
      rmSync(item.path, { force: true });
      continue;
    }
    mkdirSync(path.dirname(item.path), { recursive: true });
    writeFileSync(item.path, item.bytes);
  }
}

function atomicWrite(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, content, 'utf8');
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Find every removed manifest key / asset path still referenced exactly, in ONE
 * pass per file instead of one pass per file PER removal.
 *
 * Semantics are identical to {@link containsExactReference} applied to each
 * token — same escaping, same non-`[A-Za-z0-9_-]` boundaries, so a longer key
 * (`rat-var-10`) never matches a shorter one (`rat-var-1`). Longest-first
 * alternation ordering keeps the reported token deterministic when two tokens
 * start at the same offset. This matters because the tombstone ledger only ever
 * grows: the previous key-by-key scan was O(files x tombstones) and measured
 * 979ms for 28 tombstones over 2532 files (~10.5s projected at 300), while this
 * one measures 93ms today and 528ms at 336 synthetic tombstones. Coverage is NOT
 * reduced — every historical tombstone is still checked on every run.
 */
function findRemainingExactReferences(
  repoRoot: string,
  tokens: ReadonlyMap<string, string>,
): Array<{ readonly token: string; readonly file: string }> {
  if (tokens.size === 0) return [];
  const ordered = [...tokens.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const combined = new RegExp(
    `(?:^|[^A-Za-z0-9_-])(${ordered
      .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|')})(?=$|[^A-Za-z0-9_-])`,
    'gu',
  );
  const hits: Array<{ token: string; file: string }> = [];
  for (const file of walkReferenceFiles(repoRoot)) {
    const text = readFileSync(file, 'utf8');
    const seen = new Set<string>();
    for (const match of text.matchAll(combined)) {
      const token = match[1]!;
      if (seen.has(token)) continue;
      seen.add(token);
      hits.push({ token, file });
    }
  }
  return hits;
}

export function validateDislikedLifecycleClosure(
  repoRoot: string,
  plan: Pick<DislikedLifecyclePlan, 'removed'>,
): void {
  const generatedDir = path.join(repoRoot, 'public', 'assets', 'generated');
  const manifest = composeManifestFromShards(generatedDir);
  const annotations = readTrackedAnnotations(repoRoot);
  const failures: string[] = [];
  const removals = new Map<
    string,
    Pick<LifecycleRemoval, 'manifestKey' | 'conceptId' | 'assetPath'>
  >(plan.removed.map((removal) => [removal.manifestKey, removal]));
  for (const [annotationKey, annotation] of Object.entries(annotations.sprites)) {
    const rawTombstone = (annotation as { readonly tombstone?: unknown }).tombstone;
    if (rawTombstone === undefined) continue;
    if (typeof rawTombstone !== 'object' || rawTombstone === null) {
      failures.push(`annotation tombstone is invalid for ${annotationKey}`);
      continue;
    }
    const tombstone = rawTombstone as Partial<DislikedSpriteTombstone>;
    if (typeof tombstone.manifestKey === 'string' && removals.has(tombstone.manifestKey)) continue;
    if (
      tombstone.manifestKey !== annotationKey ||
      typeof tombstone.conceptId !== 'string' ||
      typeof tombstone.assetPath !== 'string' ||
      typeof tombstone.sourceRun !== 'string' ||
      tombstone.sourceRun.length === 0 ||
      (tombstone.replacementKey !== undefined &&
        (typeof tombstone.replacementKey !== 'string' || tombstone.replacementKey.length === 0)) ||
      typeof tombstone.variantIndex !== 'number' ||
      !Number.isInteger(tombstone.variantIndex) ||
      tombstone.variantIndex < 0 ||
      !Array.isArray(tombstone.annotationKeys) ||
      tombstone.annotationKeys.length === 0 ||
      tombstone.annotationKeys.some((key) => typeof key !== 'string' || key.length === 0)
    ) {
      failures.push(`annotation tombstone is invalid for ${annotationKey}`);
      continue;
    }
    removals.set(tombstone.manifestKey, {
      manifestKey: tombstone.manifestKey,
      conceptId: tombstone.conceptId,
      assetPath: tombstone.assetPath,
    });
  }

  // Every removed key AND its asset path maps back to the removal that owns it,
  // so one combined scan can still name the offending manifest key per hit.
  const tokens = new Map<string, string>();
  for (const removal of removals.values()) {
    if (manifest.entries[removal.manifestKey] !== undefined) {
      failures.push(`manifest shard still exists for ${removal.manifestKey}`);
    }
    const asset = path.join(repoRoot, 'public', 'assets', ...removal.assetPath.split('/'));
    if (existsSync(asset)) failures.push(`PNG still exists at ${removal.assetPath}`);
    const tombstone = annotations.sprites[removal.manifestKey]?.tombstone;
    if (
      tombstone?.manifestKey !== removal.manifestKey ||
      tombstone.assetPath !== removal.assetPath ||
      tombstone.conceptId !== removal.conceptId
    ) {
      failures.push(`annotation tombstone is missing or stale for ${removal.manifestKey}`);
    }
    tokens.set(removal.manifestKey, removal.manifestKey);
    tokens.set(removal.assetPath, removal.manifestKey);
  }
  for (const hit of findRemainingExactReferences(repoRoot, tokens)) {
    failures.push(
      `exact reference to ${tokens.get(hit.token)!} remains in ${path.relative(
        repoRoot,
        hit.file,
      )}`,
    );
  }
  if (failures.length > 0) {
    throw new Error(
      `Disliked sprite lifecycle closure failed:\n${[...new Set(failures)]
        .sort()
        .map((failure) => `- ${failure}`)
        .join(
          '\n',
        )}\nRun \`npm run sprites:disliked-lifecycle -- --dry-run\` and repair the listed paths.`,
    );
  }
}

/**
 * Why `manifestKey` cannot serve as surviving art right now, or null when it
 * can. `entries` must be the CURRENT on-disk manifest, so it reflects an
 * approval that just ran. Runtime eligibility — not mere file presence — is the
 * bar: a survivor the engine registry filters out is no survivor at all.
 */
function describeUnusableSurvivor(
  repoRoot: string,
  entries: Readonly<Record<string, ManifestEntry>>,
  manifestKey: string,
  expectedAssetPath: string,
): string | null {
  const entry = entries[manifestKey];
  if (entry === undefined) return `replacement ${manifestKey} has no manifest shard`;
  if (entry.assetPath !== expectedAssetPath) {
    return `replacement ${manifestKey} points at ${entry.assetPath}, not the planned ${expectedAssetPath}`;
  }
  if (!isRuntimeEligibleManifestEntry(entry)) {
    return `replacement ${manifestKey} is not runtime-eligible (placeholder or disliked)`;
  }
  if (!existsSync(path.join(repoRoot, 'public', 'assets', ...entry.assetPath.split('/')))) {
    return `replacement ${manifestKey} has no PNG at ${entry.assetPath}`;
  }
  return null;
}

export function applyDislikedLifecyclePlan(
  repoRoot: string,
  plan: DislikedLifecyclePlan,
): ApplyDislikedLifecycleResult {
  const generatedDir = path.join(repoRoot, 'public', 'assets', 'generated');
  const manifestPath = path.join(generatedDir, 'manifest.json');
  const annotationsPath = path.join(repoRoot, ...ANNOTATIONS_RELATIVE_PATH.split('/'));
  const touched = [
    ...(plan.annotationUpdates.length > 0 ? [annotationsPath] : []),
    ...plan.referenceUpdates.map((update) => update.path),
    ...plan.removed.flatMap((removal) => [
      shardPathForKey(generatedDir, removal.manifestKey),
      path.join(repoRoot, 'public', 'assets', ...removal.assetPath.split('/')),
    ]),
  ];
  const snapshots = snapshot(touched);
  try {
    // FAIL CLOSED before deleting anything: every removal promises a concrete
    // surviving replacement, and repointed references now name it. The survivor
    // has to be art the ENGINE will actually select — a shard that is merely
    // present but placeholder-flagged, manifest-disliked, or pointing at a
    // different/absent PNG would leave the concept with zero usable art and
    // every repointed pin dangling. Checked here, after approval has written
    // its shard, so a claimed acceptance that never materialized (e.g. an
    // icon-batch cell whose processed PNG was missing) aborts the whole
    // transaction instead of deleting against a ghost.
    const survivorFailures =
      plan.removed.length === 0
        ? []
        : (() => {
            const entries = composeManifestFromShards(generatedDir).entries;
            return [
              ...new Set(
                plan.removed.map((removal) =>
                  describeUnusableSurvivor(
                    repoRoot,
                    entries,
                    removal.replacementKey,
                    removal.replacementAssetPath,
                  ),
                ),
              ),
            ]
              .filter((failure): failure is string => failure !== null)
              .sort();
          })();
    if (survivorFailures.length > 0) {
      throw new Error(
        `Disliked sprite lifecycle refused to delete: ${survivorFailures.join(
          '; ',
        )}. Approve a runtime-eligible replacement first (its manifest shard AND its PNG must exist, and it must not be a placeholder or itself disliked), then re-run.`,
      );
    }
    for (const update of plan.referenceUpdates) atomicWrite(update.path, update.after);
    if (plan.annotationUpdates.length > 0) {
      const current = readTrackedAnnotations(repoRoot);
      const merged = applySpriteAnnotationUpdates(current, plan.annotationUpdates);
      atomicWrite(annotationsPath, `${JSON.stringify(merged, null, 2)}\n`);
    }
    for (const removal of plan.removed) {
      unapproveVariant({
        variantId: removal.manifestKey,
        manifestPath,
        publicAssetsDir: path.join(repoRoot, 'public', 'assets'),
      });
    }
    validateDislikedLifecycleClosure(repoRoot, plan);
  } catch (error) {
    restoreSnapshots(snapshots);
    throw error;
  }
  return {
    removedCount: plan.removed.length,
    retainedGroupCount: plan.retainedGroups.length,
    deferredGroupCount: plan.deferredGroups.length,
    promotedPendingCount: plan.promotedPendingCount,
  };
}

/**
 * Project a plan's annotation updates onto the durable queue-commit wire shape.
 *
 * ONE shared mapper because `mergeSpriteAnnotationUpdates` distinguishes an
 * ABSENT field from an explicit `undefined`: absent preserves whatever the
 * queue tip holds, explicit `undefined` DELETES it. A mapper that unconditionally
 * wrote `tombstone: undefined` would therefore erase a tombstone another
 * worktree had already published for a key this update never owned — silently
 * un-recording a deletion and breaking closure on the tip. Own-property-ness is
 * preserved exactly; the accepted replacement's intentional clear still clears.
 */
export function toQueueCommitAnnotationUpdates(
  updates: DislikedLifecyclePlan['annotationUpdates'],
): readonly SpriteAnnotationUpdate[] {
  return updates.map((update): SpriteAnnotationUpdate => {
    if (update.delete === true) return { key: update.key, delete: true };
    const base = {
      key: update.key,
      favorite: update.favorite ?? false,
      disliked: update.disliked ?? false,
      comment: update.comment ?? '',
      ...(update.sourceRun !== undefined ? { sourceRun: update.sourceRun } : {}),
      ...(update.variantIndex !== undefined ? { variantIndex: update.variantIndex } : {}),
      ...(Object.hasOwn(update, 'reconciliation')
        ? {
            reconciliation:
              update.reconciliation === undefined ? undefined : { ...update.reconciliation },
          }
        : {}),
    };
    // `tombstone` is set ONLY when this update owns it, so an update that never
    // touched the field leaves the queue tip's tombstone alone.
    if (!Object.hasOwn(update, 'tombstone')) return base;
    return {
      ...base,
      tombstone: update.tombstone === undefined ? undefined : { ...update.tombstone },
    };
  });
}

export function summarizeDislikedLifecycle(plan: DislikedLifecyclePlan): object {
  return {
    removedCount: plan.removed.length,
    retainedGroupCount: plan.retainedGroups.length,
    deferredGroupCount: plan.deferredGroups.length,
    promotedPendingCount: plan.promotedPendingCount,
    removed: plan.removed.map((removal) => ({
      manifestKey: removal.manifestKey,
      conceptId: removal.conceptId,
      assetPath: removal.assetPath,
      replacementKey: removal.replacementKey,
      annotationKeys: removal.annotationKeys,
    })),
    retainedGroups: plan.retainedGroups,
    deferredGroups: plan.deferredGroups,
    unresolvedAnnotationKeys: plan.unresolvedAnnotationKeys,
    referenceUpdates: plan.referenceUpdates.map((update) =>
      path.relative(process.cwd(), update.path),
    ),
  };
}

export interface AcceptedDislikedLifecycleTransactionOptions<T> {
  readonly repoRoot: string;
  /**
   * Every asset this acceptance is authorizing. Their normalized concepts —
   * and ONLY their concepts — are in scope for cleanup.
   */
  readonly replacements: readonly LifecycleReplacement[];
  readonly approve: () => T;
  /**
   * Resolve the exact declared replacements that `approve` materialized. Batch
   * approval must supply this because a skipped cell can have stale accepted art
   * on disk; file presence alone is not proof that this acceptance selected it.
   * Single-replacement transactions default to their sole declared key.
   */
  readonly approvedReplacementKeys?: (approved: T) => readonly string[];
  readonly publish: (approved: T, plan: DislikedLifecyclePlan) => Promise<void>;
}

/** True when `plan` proposes any mutation that this replacement authorizes. */
function planMutatesReplacement(
  plan: DislikedLifecyclePlan,
  replacement: LifecycleReplacement,
): boolean {
  return (
    plan.annotationUpdates.some((update) => update.key === replacement.manifestKey) ||
    plan.removed.some((removal) => removal.conceptId === replacement.conceptId)
  );
}

/**
 * Couple explicit human approval, retained-dislike cleanup, closure validation,
 * and durable publication. Publication is last; any pre-publication or publish
 * failure restores every local path, including the newly approved replacement.
 *
 * Cleanup is SCOPED to the accepted concepts. Repo-wide cleanup belongs to
 * `npm run sprites:disliked-lifecycle -- --apply`: an unrelated concept's exact
 * source pin must not block an unrelated approval, and one acceptance must not
 * quietly delete art for a concept the human never looked at. Anything skipped
 * for that reason is reported on `plan.deferredGroups`, never dropped silently.
 */
export async function runAcceptedDislikedLifecycleTransaction<T>(
  options: AcceptedDislikedLifecycleTransactionOptions<T>,
): Promise<{ approved: T; plan: DislikedLifecyclePlan }> {
  if (options.replacements.length === 0) {
    throw new Error(
      'runAcceptedDislikedLifecycleTransaction requires at least one accepted replacement; ' +
        'an empty acceptance has no concept scope and must not run cleanup.',
    );
  }
  const conceptScope = new Set(options.replacements.map((item) => item.conceptId));
  const initialPlan = loadDislikedLifecyclePlan(
    options.repoRoot,
    options.replacements,
    conceptScope,
  );
  if (options.replacements.length === 1 && initialPlan.referenceUpdates.length > 0) {
    throw new Error(
      `Acceptance would remove exact-pinned sprite(s) referenced by ${initialPlan.referenceUpdates
        .map((update) => path.relative(options.repoRoot, update.path))
        .join(
          ', ',
        )}. Repoint and commit those pins before retrying approval; the art-only durable queue cannot publish source/data edits.`,
    );
  }
  const generatedDir = path.join(options.repoRoot, 'public', 'assets', 'generated');
  const annotationsPath = path.join(options.repoRoot, ...ANNOTATIONS_RELATIVE_PATH.split('/'));
  const annotationsExisted = existsSync(annotationsPath);
  const annotationsBefore = readTrackedAnnotations(options.repoRoot);
  const rollbackAnnotationKeys = new Set<string>();
  const touched = [
    ...options.replacements.flatMap((replacement) => [
      shardPathForKey(generatedDir, replacement.manifestKey),
      path.join(options.repoRoot, 'public', 'assets', ...replacement.assetPath.split('/')),
    ]),
    ...initialPlan.referenceUpdates.map((update) => update.path),
    ...initialPlan.removed.flatMap((removal) => [
      shardPathForKey(generatedDir, removal.manifestKey),
      path.join(options.repoRoot, 'public', 'assets', ...removal.assetPath.split('/')),
    ]),
  ];
  const snapshots = snapshot(touched);
  try {
    const approved = options.approve();
    const approvedKeys =
      options.approvedReplacementKeys?.(approved) ??
      (options.replacements.length === 1 ? [options.replacements[0]!.manifestKey] : null);
    if (approvedKeys === null) {
      throw new Error(
        'Batch acceptance must report the exact approved replacement keys; on-disk art cannot prove a skipped cell was accepted.',
      );
    }
    const declaredKeys = new Set(
      options.replacements.map((replacement) => replacement.manifestKey),
    );
    for (const key of approvedKeys) {
      if (!declaredKeys.has(key)) {
        throw new Error(`Approval reported undeclared replacement "${key}".`);
      }
    }
    const approvedKeySet = new Set(approvedKeys);
    if (approvedKeySet.size === 0) {
      throw new Error(
        'Acceptance produced no approved replacements; skipped candidates cannot authorize lifecycle changes.',
      );
    }
    // A declared replacement only earns the right to mutate its concept's
    // annotations once approval ACTUALLY produced runtime-eligible art for it.
    // Batch acceptances (icon batches) legitimately skip cells whose processed
    // PNG is missing; without this check a skipped cell would still clear its
    // dislike — or worse, erase a historical tombstone and quietly retire the
    // closure check that guards that deletion forever.
    const entries = composeManifestFromShards(generatedDir).entries;
    const materializedReplacements = options.replacements.filter((replacement) => {
      if (!approvedKeySet.has(replacement.manifestKey)) return false;
      return (
        describeUnusableSurvivor(
          options.repoRoot,
          entries,
          replacement.manifestKey,
          replacement.assetPath,
        ) === null
      );
    });
    const unmaterializedMutations = options.replacements
      .filter(
        (replacement) =>
          planMutatesReplacement(initialPlan, replacement) &&
          !materializedReplacements.includes(replacement),
      )
      .map((replacement) => {
        const failure = describeUnusableSurvivor(
          options.repoRoot,
          entries,
          replacement.manifestKey,
          replacement.assetPath,
        );
        return failure ?? `replacement ${replacement.manifestKey} was not among the approved keys`;
      })
      .sort();
    if (materializedReplacements.length === 0 && unmaterializedMutations.length > 0) {
      throw new Error(
        `Acceptance would rewrite dislike history for art that was not approved: ${unmaterializedMutations.join(
          '; ',
        )}. Re-run the approval for the missing candidate(s) before accepting.`,
      );
    }
    const effectiveReplacements = materializedReplacements;
    const effectiveScope = new Set(effectiveReplacements.map((item) => item.conceptId));
    const plan = loadDislikedLifecyclePlan(options.repoRoot, effectiveReplacements, effectiveScope);
    if (plan.referenceUpdates.length > 0) {
      throw new Error(
        `Acceptance would remove exact-pinned sprite(s) referenced by ${plan.referenceUpdates
          .map((update) => path.relative(options.repoRoot, update.path))
          .join(
            ', ',
          )}. Repoint and commit those pins before retrying approval; the art-only durable queue cannot publish source/data edits.`,
      );
    }
    for (const update of plan.annotationUpdates) rollbackAnnotationKeys.add(update.key);
    const snapshottedPaths = new Set(snapshots.map((item) => item.path));
    const finalTouched = [
      ...plan.referenceUpdates.map((update) => update.path),
      ...plan.removed.flatMap((removal) => [
        shardPathForKey(generatedDir, removal.manifestKey),
        path.join(options.repoRoot, 'public', 'assets', ...removal.assetPath.split('/')),
      ]),
    ].filter((file) => !snapshottedPaths.has(file));
    snapshots.push(...snapshot(finalTouched));
    applyDislikedLifecyclePlan(options.repoRoot, plan);
    await options.publish(approved, plan);
    return { approved, plan };
  } catch (error) {
    restoreSnapshots(snapshots);
    if (rollbackAnnotationKeys.size > 0) {
      const current = readTrackedAnnotations(options.repoRoot);
      const restoredSprites: Record<string, SpriteAnnotation> = { ...current.sprites };
      for (const key of rollbackAnnotationKeys) {
        const original = annotationsBefore.sprites[key];
        if (original === undefined) delete restoredSprites[key];
        else restoredSprites[key] = original;
      }
      if (!annotationsExisted && Object.keys(restoredSprites).length === 0) {
        rmSync(annotationsPath, { force: true });
      } else {
        atomicWrite(
          annotationsPath,
          `${JSON.stringify({ version: 1, sprites: restoredSprites }, null, 2)}\n`,
        );
      }
    }
    throw error;
  }
}
