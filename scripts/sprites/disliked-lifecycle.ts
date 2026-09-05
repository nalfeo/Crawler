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

import type { ManifestEntry } from '../../src/shared/generated-assets.js';
import { normalizeGeneratedSpriteConceptId } from '../../src/shared/sprite-concepts.js';
import {
  readPendingDislikedSpriteNames,
  resolvePendingAnnotationsPath,
} from '../../.github/extensions/sprite-editor/lib/pending-annotation-overlay.mjs';
import { unapproveVariant } from './approve.js';
import { composeManifestFromShards, shardPathForKey } from './generated-shards.js';
import { isPlaceholderManifestEntry } from './placeholder-audit.js';

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
  readonly assetPath: string;
  readonly sourceRun: string;
  readonly variantIndex: number;
  readonly annotationKeys: readonly string[];
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
  readonly replacement?: LifecycleReplacement;
  readonly readReferenceFiles?: boolean;
}

export interface ApplyDislikedLifecycleResult {
  readonly removedCount: number;
  readonly retainedGroupCount: number;
  readonly promotedPendingCount: number;
}

interface ReconciledDislike {
  readonly manifestKey: string;
  readonly annotationKeys: readonly string[];
  readonly annotation: SpriteAnnotation;
}

interface FileSnapshot {
  readonly path: string;
  readonly bytes: Buffer | null;
}

function reconcileDislikeKey(
  key: string,
  annotation: SpriteAnnotation,
  entries: Readonly<Record<string, ManifestEntry>>,
): string | null {
  if (entries[key] !== undefined) return key;
  if (annotation.tombstone !== undefined) return null;

  if (
    typeof annotation.sourceRun !== 'string' ||
    annotation.sourceRun.trim() === '' ||
    typeof annotation.variantIndex !== 'number' ||
    !Number.isInteger(annotation.variantIndex) ||
    annotation.variantIndex < 0
  ) {
    return null;
  }
  const sourceRunBasename = path.posix.basename(annotation.sourceRun.replace(/\\/g, '/'));

  const candidates = Object.entries(entries).filter(([, entry]) => {
    return (
      entry.variantIndex === annotation.variantIndex &&
      path.posix.basename(entry.sourceRun.replace(/\\/g, '/')) === sourceRunBasename
    );
  });
  if (candidates.length > 1) {
    throw new Error(
      `Disliked annotation "${key}" is ambiguous: provenance matched ${candidates
        .map(([manifestKey]) => manifestKey)
        .sort()
        .join(', ')}. Add sourceRun provenance before retrying.`,
    );
  }
  return candidates[0]?.[0] ?? null;
}

function mergePendingAnnotations(
  tracked: SpriteAnnotationsDocument,
  pending: Readonly<Record<string, PendingAnnotationRecord>>,
  pendingDislikedKeys: ReadonlySet<string>,
): { document: SpriteAnnotationsDocument; promotedCount: number } {
  const sprites: Record<string, SpriteAnnotation> = { ...tracked.sprites };
  let promotedCount = 0;
  for (const key of [...pendingDislikedKeys].sort()) {
    const record = pending[key];
    const annotation = record?.annotation;
    if (annotation?.disliked !== true) continue;
    sprites[key] = {
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
): { reconciled: readonly ReconciledDislike[]; unresolved: readonly string[] } {
  const grouped = new Map<string, { keys: string[]; annotation: SpriteAnnotation }>();
  const unresolved: string[] = [];
  for (const [key, annotation] of Object.entries(annotations.sprites).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (annotation.disliked !== true) continue;
    const manifestKey = reconcileDislikeKey(key, annotation, entries);
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

/** Resolve annotation keys to concrete accepted manifest keys without guessing. */
export function resolveDislikedManifestKeys(
  entries: Readonly<Record<string, ManifestEntry>>,
  dislikedKeys: ReadonlySet<string>,
): ReadonlySet<string> {
  const resolved = new Set<string>();
  for (const key of [...dislikedKeys].sort()) {
    const manifestKey = reconcileDislikeKey(key, { disliked: true }, entries);
    if (manifestKey !== null) resolved.add(manifestKey);
  }
  return resolved;
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

function containsExactReference(text: string, value: string): boolean {
  return exactReferencePattern(value).test(text);
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
  const promoted = mergePendingAnnotations(input.trackedAnnotations, pending, pendingKeys);
  const { reconciled, unresolved } = reconcileDislikes(promoted.document, input.manifestEntries);
  const dislikedKeys = new Set(reconciled.map((item) => item.manifestKey));
  const groups = new Map<string, Array<[string, ManifestEntry]>>();
  for (const pair of Object.entries(input.manifestEntries)) {
    const concept = normalizeGeneratedSpriteConceptId(pair[1].briefId || pair[0]);
    const group = groups.get(concept) ?? [];
    group.push(pair);
    groups.set(concept, group);
  }

  const removals: LifecycleRemoval[] = [];
  const retainedGroups: Array<{ conceptId: string; manifestKeys: string[] }> = [];
  for (const [conceptId, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const disliked = group.filter(([key]) => dislikedKeys.has(key));
    if (disliked.length === 0) continue;
    const replacement = input.replacement?.conceptId === conceptId ? input.replacement : undefined;
    const survivors = group
      .filter(([key, entry]) => !dislikedKeys.has(key) && !isPlaceholderManifestEntry(entry))
      .map(([key, entry]) => ({
        manifestKey: key,
        assetPath: entry.assetPath,
      }))
      .sort((a, b) => a.manifestKey.localeCompare(b.manifestKey));
    if (replacement !== undefined) {
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
    const survivor = survivors[0]!;
    for (const [manifestKey, entry] of disliked
      .filter(([key]) => key !== replacement?.manifestKey)
      .sort(([a], [b]) => a.localeCompare(b))) {
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
  if (
    input.replacement !== undefined &&
    sprites[input.replacement.manifestKey]?.disliked === true
  ) {
    sprites[input.replacement.manifestKey] = {
      ...sprites[input.replacement.manifestKey],
      favorite: false,
      disliked: false,
      tombstone: undefined,
    };
  }
  for (const key of unresolved) {
    const annotation = sprites[key] ?? {};
    sprites[key] = {
      ...annotation,
      reconciliation: { outcome: 'unmatched', annotationKey: key },
    };
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

function readPendingDocument(pendingPath: string): Record<string, PendingAnnotationRecord> {
  if (!existsSync(pendingPath)) return {};
  const parsed = JSON.parse(readFileSync(pendingPath, 'utf8')) as {
    readonly sprites?: unknown;
  };
  return parsed.sprites && typeof parsed.sprites === 'object' && !Array.isArray(parsed.sprites)
    ? (parsed.sprites as Record<string, PendingAnnotationRecord>)
    : {};
}

export function loadDislikedLifecyclePlan(
  repoRoot: string,
  replacement?: LifecycleReplacement,
): DislikedLifecyclePlan {
  const generatedDir = path.join(repoRoot, 'public', 'assets', 'generated');
  const annotationsPath = path.join(repoRoot, ...ANNOTATIONS_RELATIVE_PATH.split('/'));
  const tracked = existsSync(annotationsPath)
    ? parseAnnotations(readFileSync(annotationsPath, 'utf8'), ANNOTATIONS_RELATIVE_PATH)
    : { version: 1 as const, sprites: {} };
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
    replacement,
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

export function validateDislikedLifecycleClosure(
  repoRoot: string,
  plan: DislikedLifecyclePlan,
): void {
  const generatedDir = path.join(repoRoot, 'public', 'assets', 'generated');
  const manifest = composeManifestFromShards(generatedDir);
  const annotationsPath = path.join(repoRoot, ...ANNOTATIONS_RELATIVE_PATH.split('/'));
  const annotations = parseAnnotations(
    readFileSync(annotationsPath, 'utf8'),
    ANNOTATIONS_RELATIVE_PATH,
  );
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
      typeof tombstone.assetPath !== 'string'
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

  const referenceContents = walkReferenceFiles(repoRoot).map((file) => ({
    file,
    text: readFileSync(file, 'utf8'),
  }));
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
    for (const reference of referenceContents) {
      const text = reference.text;
      if (
        containsExactReference(text, removal.manifestKey) ||
        containsExactReference(text, removal.assetPath)
      ) {
        failures.push(
          `exact reference to ${removal.manifestKey} remains in ${path.relative(
            repoRoot,
            reference.file,
          )}`,
        );
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Disliked sprite lifecycle closure failed:\n${failures
        .sort()
        .map((failure) => `- ${failure}`)
        .join(
          '\n',
        )}\nRun \`npm run sprites:disliked-lifecycle -- --dry-run\` and repair the listed paths.`,
    );
  }
}

export function applyDislikedLifecyclePlan(
  repoRoot: string,
  plan: DislikedLifecyclePlan,
): ApplyDislikedLifecycleResult {
  const generatedDir = path.join(repoRoot, 'public', 'assets', 'generated');
  const manifestPath = path.join(generatedDir, 'manifest.json');
  const annotationsPath = path.join(repoRoot, ...ANNOTATIONS_RELATIVE_PATH.split('/'));
  const touched = [
    annotationsPath,
    ...plan.referenceUpdates.map((update) => update.path),
    ...plan.removed.flatMap((removal) => [
      shardPathForKey(generatedDir, removal.manifestKey),
      path.join(repoRoot, 'public', 'assets', ...removal.assetPath.split('/')),
    ]),
  ];
  const snapshots = snapshot(touched);
  try {
    for (const update of plan.referenceUpdates) atomicWrite(update.path, update.after);
    atomicWrite(annotationsPath, `${JSON.stringify(plan.annotations, null, 2)}\n`);
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
    promotedPendingCount: plan.promotedPendingCount,
  };
}

export function summarizeDislikedLifecycle(plan: DislikedLifecyclePlan): object {
  return {
    removedCount: plan.removed.length,
    retainedGroupCount: plan.retainedGroups.length,
    promotedPendingCount: plan.promotedPendingCount,
    removed: plan.removed.map((removal) => ({
      manifestKey: removal.manifestKey,
      conceptId: removal.conceptId,
      assetPath: removal.assetPath,
      replacementKey: removal.replacementKey,
      annotationKeys: removal.annotationKeys,
    })),
    retainedGroups: plan.retainedGroups,
    unresolvedAnnotationKeys: plan.unresolvedAnnotationKeys,
    referenceUpdates: plan.referenceUpdates.map((update) =>
      path.relative(process.cwd(), update.path),
    ),
  };
}

export interface AcceptedDislikedLifecycleTransactionOptions<T> {
  readonly repoRoot: string;
  readonly replacement: LifecycleReplacement;
  readonly approve: () => T;
  readonly publish: (approved: T, plan: DislikedLifecyclePlan) => Promise<void>;
}

/**
 * Couple explicit human approval, retained-dislike cleanup, closure validation,
 * and durable publication. Publication is last; any pre-publication or publish
 * failure restores every local path, including the newly approved replacement.
 */
export async function runAcceptedDislikedLifecycleTransaction<T>(
  options: AcceptedDislikedLifecycleTransactionOptions<T>,
): Promise<{ approved: T; plan: DislikedLifecyclePlan }> {
  const plan = loadDislikedLifecyclePlan(options.repoRoot, options.replacement);
  if (plan.referenceUpdates.length > 0) {
    throw new Error(
      `Acceptance would remove exact-pinned sprite(s) referenced by ${plan.referenceUpdates
        .map((update) => path.relative(options.repoRoot, update.path))
        .join(
          ', ',
        )}. Repoint and commit those pins before retrying approval; the art-only durable queue cannot publish source/data edits.`,
    );
  }
  const generatedDir = path.join(options.repoRoot, 'public', 'assets', 'generated');
  const replacementShard = shardPathForKey(generatedDir, options.replacement.manifestKey);
  const replacementPng = path.join(
    options.repoRoot,
    'public',
    'assets',
    ...options.replacement.assetPath.split('/'),
  );
  const annotationsPath = path.join(options.repoRoot, ...ANNOTATIONS_RELATIVE_PATH.split('/'));
  const touched = [
    replacementShard,
    replacementPng,
    annotationsPath,
    ...plan.referenceUpdates.map((update) => update.path),
    ...plan.removed.flatMap((removal) => [
      shardPathForKey(generatedDir, removal.manifestKey),
      path.join(options.repoRoot, 'public', 'assets', ...removal.assetPath.split('/')),
    ]),
  ];
  const snapshots = snapshot(touched);
  try {
    const approved = options.approve();
    applyDislikedLifecyclePlan(options.repoRoot, plan);
    await options.publish(approved, plan);
    return { approved, plan };
  } catch (error) {
    restoreSnapshots(snapshots);
    throw error;
  }
}
