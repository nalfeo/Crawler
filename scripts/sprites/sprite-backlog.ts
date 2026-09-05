import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import type { ManifestEntry } from '../../src/shared/generated-assets.js';
import { loadGeneratedManifest } from './generated-shards.js';
import { loadBrief } from './load-brief.js';
import {
  isPlaceholderManifestEntry,
  normalizeConcept,
  type PlaceholderAuditReport,
} from './placeholder-audit.js';
import { runPlaceholderAudit } from './placeholder-audit-cli.js';
import {
  readPendingDislikedSpriteNames,
  resolvePendingAnnotationsPath,
} from '../../.github/extensions/sprite-editor/lib/pending-annotation-overlay.mjs';

const DEFAULT_STATE_PATH = path.join('generated', 'sprite-backlog-state.json');
const DEFAULT_MANIFEST_PATH = path.join('public', 'assets', 'generated', 'manifest.json');
const ANNOTATIONS_PATH = path.join(
  'public',
  'assets',
  'generated',
  'sprite-editor-annotations.json',
);

export type SpriteBacklogSource = 'disliked' | 'missing';

export interface SpriteBacklogBrief {
  readonly concept: string;
  readonly name: string;
  readonly path: string;
  readonly floor: number;
  readonly judgeEnabled: boolean;
}

export interface SpriteBacklogSelection extends SpriteBacklogBrief {
  readonly source: SpriteBacklogSource;
}

export interface SpriteBacklogPlan {
  readonly selected: readonly SpriteBacklogSelection[];
  readonly available: readonly SpriteBacklogSelection[];
  readonly blockedDisliked: readonly string[];
  readonly blockedMissing: readonly string[];
  readonly pendingReviewConcepts: readonly string[];
  readonly invalidBriefs: readonly InvalidSpriteBacklogBrief[];
}

export interface InvalidSpriteBacklogBrief {
  readonly path: string;
  readonly error: string;
}

interface SpriteAnnotations {
  readonly sprites: Readonly<
    Record<
      string,
      { readonly disliked?: boolean; readonly favorite?: boolean; readonly comment?: string }
    >
  >;
}

export interface SpriteBacklogStateEntry {
  readonly source: SpriteBacklogSource;
  readonly briefPath: string;
  readonly runDir: string;
  readonly generatedAt: string;
}

export interface SpriteBacklogState {
  readonly version: 1;
  readonly pendingReview: Readonly<Record<string, SpriteBacklogStateEntry>>;
}

export interface BuildSpriteBacklogPlanInput {
  readonly briefs: readonly SpriteBacklogBrief[];
  readonly manifestEntries: Readonly<Record<string, ManifestEntry>>;
  readonly dislikedSpriteNames: ReadonlySet<string>;
  readonly placeholderReport: Pick<PlaceholderAuditReport, 'placeholderOnly'>;
  readonly pendingReviewConcepts?: ReadonlySet<string>;
  readonly retrySources?: ReadonlyMap<string, SpriteBacklogSource>;
  readonly floors: ReadonlySet<number>;
  readonly limit: number;
  readonly invalidBriefs?: readonly InvalidSpriteBacklogBrief[];
}

export interface PrepareSpriteBacklogOptions {
  readonly floors: readonly number[];
  readonly limit: number;
  readonly statePath?: string;
  readonly retryConcepts?: readonly string[];
  readonly persistRetryChanges?: boolean;
}

export interface PreparedSpriteBacklog {
  readonly plan: SpriteBacklogPlan;
  readonly statePath: string;
  readonly state: SpriteBacklogState;
}

export interface SpriteBacklogResult {
  readonly briefPath: string;
  readonly status: 'succeeded' | 'failed' | 'skipped-over-budget';
  readonly runDir: string;
  readonly summary?: {
    readonly candidates: readonly { readonly combinedPassed: boolean }[];
  };
}

function compareBriefPreference(left: SpriteBacklogBrief, right: SpriteBacklogBrief): number {
  const leftExact = left.name === left.concept ? 0 : 1;
  const rightExact = right.name === right.concept ? 0 : 1;
  return (
    leftExact - rightExact ||
    left.name.localeCompare(right.name) ||
    left.path.localeCompare(right.path)
  );
}

function pickBriefsByConcept(
  briefs: readonly SpriteBacklogBrief[],
  floors: ReadonlySet<number>,
): Map<string, SpriteBacklogBrief> {
  const byConcept = new Map<string, SpriteBacklogBrief[]>();
  for (const brief of briefs) {
    if (!floors.has(brief.floor) || !brief.judgeEnabled) continue;
    const candidates = byConcept.get(brief.concept) ?? [];
    candidates.push(brief);
    byConcept.set(brief.concept, candidates);
  }
  return new Map(
    [...byConcept.entries()].map(([concept, candidates]) => [
      concept,
      [...candidates].sort(compareBriefPreference)[0]!,
    ]),
  );
}

export function buildSpriteBacklogPlan(input: BuildSpriteBacklogPlanInput): SpriteBacklogPlan {
  if (!Number.isInteger(input.limit) || input.limit < 1) {
    throw new Error(`sprite backlog limit must be a positive integer, got ${input.limit}`);
  }

  const pendingReview = input.pendingReviewConcepts ?? new Set<string>();
  const briefsByConcept = pickBriefsByConcept(input.briefs, input.floors);
  const dislikedConcepts = new Set<string>();

  for (const spriteName of input.dislikedSpriteNames) {
    const entry = input.manifestEntries[spriteName];
    if (!entry || isPlaceholderManifestEntry(entry)) continue;
    dislikedConcepts.add(normalizeConcept(entry.briefId || spriteName));
  }

  const missingConcepts = new Set(
    input.placeholderReport.placeholderOnly.map((item) => item.concept),
  );
  const blockedDisliked = [...dislikedConcepts]
    .filter((concept) => !briefsByConcept.has(concept))
    .sort();
  const blockedMissing = [...missingConcepts]
    .filter((concept) => !briefsByConcept.has(concept))
    .sort();

  const toSelection = (
    source: SpriteBacklogSource,
    concepts: ReadonlySet<string>,
  ): SpriteBacklogSelection[] =>
    [...concepts]
      .filter((concept) => !pendingReview.has(concept))
      .flatMap((concept) => {
        const brief = briefsByConcept.get(concept);
        return brief ? [{ ...brief, source }] : [];
      })
      .sort((left, right) => left.floor - right.floor || left.concept.localeCompare(right.concept));

  const disliked = toSelection('disliked', dislikedConcepts);
  const missing = toSelection(
    'missing',
    new Set([...missingConcepts].filter((concept) => !dislikedConcepts.has(concept))),
  );
  const ordinaryAvailable = [...disliked, ...missing];
  const retries = [...(input.retrySources ?? new Map<string, SpriteBacklogSource>())]
    .map(([concept, source]) => {
      const brief = briefsByConcept.get(concept);
      if (!brief) {
        throw new Error(
          `cannot retry "${concept}": no eligible judged brief exists for the selected floors`,
        );
      }
      return { ...brief, source };
    })
    .sort((left, right) => left.concept.localeCompare(right.concept));
  if (retries.length > input.limit) {
    throw new Error(
      `cannot retry ${retries.length} concepts: retry count exceeds backlog limit ${input.limit}`,
    );
  }
  const retriedConcepts = new Set(retries.map(({ concept }) => concept));
  const available = [
    ...retries,
    ...ordinaryAvailable.filter(({ concept }) => !retriedConcepts.has(concept)),
  ];

  return {
    selected: available.slice(0, input.limit),
    available,
    blockedDisliked,
    blockedMissing,
    pendingReviewConcepts: [...pendingReview].sort(),
    invalidBriefs: [...(input.invalidBriefs ?? [])],
  };
}

function walkYamlFiles(dirPath: string): string[] {
  if (!existsSync(dirPath)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const absolute = path.join(dirPath, entry.name);
    if (entry.isDirectory() && entry.name.toLowerCase() !== 'draft') {
      files.push(...walkYamlFiles(absolute));
    } else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) files.push(absolute);
  }
  return files.sort();
}

export function collectBacklogBriefs(repoRoot: string): {
  readonly briefs: SpriteBacklogBrief[];
  readonly invalidBriefs: InvalidSpriteBacklogBrief[];
} {
  const briefs: SpriteBacklogBrief[] = [];
  const invalidBriefs: InvalidSpriteBacklogBrief[] = [];
  for (const briefPath of walkYamlFiles(path.join(repoRoot, 'briefs'))) {
    try {
      const loaded = loadBrief(briefPath, { projectRoot: repoRoot }).brief;
      briefs.push({
        concept: normalizeConcept(loaded.name),
        name: loaded.name,
        path: briefPath,
        floor: loaded.floor,
        judgeEnabled: loaded.judge.enabled,
      });
    } catch (error) {
      invalidBriefs.push({
        path: briefPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { briefs, invalidBriefs };
}

function readAnnotations(repoRoot: string): SpriteAnnotations {
  const annotationsPath = path.join(repoRoot, ANNOTATIONS_PATH);
  if (!existsSync(annotationsPath)) return { sprites: {} };
  const parsed = JSON.parse(readFileSync(annotationsPath, 'utf8')) as Partial<SpriteAnnotations>;
  if (!parsed.sprites || typeof parsed.sprites !== 'object') {
    throw new Error(`${ANNOTATIONS_PATH} must contain a sprites object`);
  }
  return { sprites: parsed.sprites };
}

function emptyState(): SpriteBacklogState {
  return { version: 1, pendingReview: {} };
}

function readState(statePath: string): SpriteBacklogState {
  if (!existsSync(statePath)) return emptyState();
  const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<SpriteBacklogState>;
  if (parsed.version !== 1 || !parsed.pendingReview || typeof parsed.pendingReview !== 'object') {
    throw new Error(`${statePath} is not a valid sprite backlog state file`);
  }
  return { version: 1, pendingReview: parsed.pendingReview };
}

function writeState(statePath: string, state: SpriteBacklogState): void {
  mkdirSync(path.dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tempPath, statePath);
}

export function prepareSpriteBacklog(
  repoRoot: string,
  options: PrepareSpriteBacklogOptions,
): PreparedSpriteBacklog {
  const statePath = path.resolve(repoRoot, options.statePath ?? DEFAULT_STATE_PATH);
  let state = readState(statePath);
  const retrySources = new Map<string, SpriteBacklogSource>();
  if (options.retryConcepts && options.retryConcepts.length > 0) {
    const pendingReview = { ...state.pendingReview };
    for (const concept of options.retryConcepts) {
      const normalizedConcept = normalizeConcept(concept);
      const pending = pendingReview[normalizedConcept];
      if (!pending) {
        throw new Error(`cannot retry "${normalizedConcept}": it is not pending human review`);
      }
      retrySources.set(normalizedConcept, pending.source);
      delete pendingReview[normalizedConcept];
    }
    state = { version: 1, pendingReview };
  }
  const discovered = collectBacklogBriefs(repoRoot);
  const generatedDir = path.join(repoRoot, 'public', 'assets', 'generated');
  const manifestEntries = loadGeneratedManifest(generatedDir).entries;
  const annotations = readAnnotations(repoRoot);
  const trackedDislikedSpriteNames = new Set(
    Object.entries(annotations.sprites)
      .filter(([, annotation]) => annotation.disliked === true)
      .map(([spriteName]) => spriteName),
  );
  const pendingDislikedSpriteNames = readPendingDislikedSpriteNames(
    resolvePendingAnnotationsPath(repoRoot),
    {
      getCurrentAnnotation: (spriteName) =>
        Object.hasOwn(annotations.sprites, spriteName) ? annotations.sprites[spriteName] : null,
    },
  );
  const dislikedSpriteNames = new Set([
    ...trackedDislikedSpriteNames,
    ...pendingDislikedSpriteNames,
  ]);
  const placeholderReport = runPlaceholderAudit(repoRoot, {
    manifestPath: DEFAULT_MANIFEST_PATH,
    since: undefined,
    format: 'json',
    showAll: true,
    failOnReplaceable: false,
  });
  const plan = buildSpriteBacklogPlan({
    briefs: discovered.briefs,
    manifestEntries,
    dislikedSpriteNames,
    placeholderReport,
    pendingReviewConcepts: new Set(Object.keys(state.pendingReview)),
    retrySources,
    floors: new Set(options.floors),
    limit: options.limit,
    invalidBriefs: discovered.invalidBriefs,
  });
  if (retrySources.size > 0 && options.persistRetryChanges !== false) {
    writeState(statePath, state);
  }
  return { plan, statePath, state };
}

export function recordSpriteBacklogResult(
  prepared: PreparedSpriteBacklog,
  result: SpriteBacklogResult,
  now: Date = new Date(),
): void {
  if (result.status !== 'succeeded') return;
  if (!result.summary?.candidates.some((candidate) => candidate.combinedPassed)) return;
  const selection = prepared.plan.selected.find(
    (candidate) => path.resolve(candidate.path) === path.resolve(result.briefPath),
  );
  if (!selection) return;
  const latestState = readState(prepared.statePath);
  const pendingReview: Record<string, SpriteBacklogStateEntry> = {
    ...latestState.pendingReview,
    [selection.concept]: {
      source: selection.source,
      briefPath: selection.path,
      runDir: result.runDir,
      generatedAt: now.toISOString(),
    },
  };

  writeState(prepared.statePath, { version: 1, pendingReview });
}
