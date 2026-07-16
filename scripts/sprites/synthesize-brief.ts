/**
 * Brief synthesizer — turns a subject name into N reviewable
 * minimal-brief YAML candidates.
 *
 * Workflow:
 *   1. Refuse if `env.CI` is set (constitutional §3: synthesizer is
 *      local-only because each call costs money and is non-deterministic),
 *      UNLESS `SPRITES_ALLOW_CI_PIPELINE=true` is also set — the ADR-0043
 *      bypass reserved for the asset-request CI worker (author-allowlisted).
 *   2. Normalise + validate the subject name (lowercase kebab-case, no
 *      path separators, ≤64 chars).
 *   3. Issue ONE structured-output call to the synth provider for all
 *      N candidates. Per-candidate calls would scale cost linearly for
 *      no quality gain.
 *   4. For each candidate:
 *        a. Reject if the description contains a banned vague adjective.
 *        b. Require the sprite-type-aware embellishment seed count.
 *   5. Decide write policy with `partial`:
 *        - `partial=false` (default): if any candidate is rejected, throw
 *          an aggregated error and write nothing.
 *        - `partial=true`: write the valid candidates and surface
 *          rejections in the sidecar.
 *   6. If type was not supplied: require `typeConfidence >= 0.9`,
 *      otherwise throw (the user must re-run with --type).
 *   7. Write `<outDir>/<name>/<name>-v{1,N}.yaml` and `synthesis.json`.
 *      Atomic-ish: all validation happens before any write.
 *
 * Everything except the provider call and the filesystem hooks is pure.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

import { SPRITE_TYPES, type Brief } from './brief-schema.js';
import { isCiPipelineBypassed } from './ci-bypass.js';
import { coerceSizeVariant, DEFAULT_SIZE_VARIANT, type SizeVariant } from './size-variants.js';
import { buildSystemPrompt, buildUserPrompt } from './provider/azure-chat-synth.js';
import type {
  SynthProvider,
  SynthesizeBriefResponse,
  SynthesizedCandidate,
} from './provider/synth-types.js';

export type SpriteType = Brief['type'];

export const MIN_CANDIDATES = 1;
export const MAX_CANDIDATES = 5;
const MAX_NAME_LENGTH = 64;
const NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/;
const BANNED_ADJECTIVES = ['cool', 'awesome', 'epic', 'amazing', 'nice'] as const;
const BANNED_REGEX = new RegExp(`\\b(${BANNED_ADJECTIVES.join('|')})\\b`, 'i');
const MIN_SEEDS_PER_CANDIDATE = 3;
const MAX_SEEDS_PER_CANDIDATE = 5;
const MIN_TYPE_CONFIDENCE = 0.9;
/**
 * Schema default for `minVariations` (see `briefSchema` in
 * `brief-schema.ts`). Used as the fallback when a sprite-type defaults
 * file doesn't override it. Kept in sync with the Zod default by hand;
 * the schema is the source of truth.
 */
const DEFAULT_MIN_VARIATIONS = 4;

export interface SynthesizeBriefOptions {
  /** Subject name. Will be normalised to kebab-case. */
  readonly name: string;
  /**
   * Optional one-line direction that refines the subject without being part of
   * its name/slug. Passed through to the provider prompt; omitted/empty leaves
   * the prompt (and its hash) unchanged.
   */
  readonly briefHint?: string;
  /**
   * Caller-supplied type. When omitted, the model must classify with
   * `typeConfidence >= ${MIN_TYPE_CONFIDENCE}` or the call throws.
   */
  readonly type?: SpriteType;
  /** Dungeon floor intensity. Defaults to 1. */
  readonly floor?: number;
  /** Number of candidates to request. Default 3, capped at MAX_CANDIDATES. */
  readonly candidates?: number;
  /**
   * Size variant to stamp on every written candidate. Default `'default'`.
   * Reshapes the sheet grid on a fixed native canvas at brief-load time
   * (wide → 8 double-width cells, tall → 8 double-height, large → 4; see
   * ADR 0029) and scales the per-type size/anchor. Written into the candidate
   * YAML (and recorded in the sidecar) only when not `'default'`.
   */
  readonly sizeVariant?: SizeVariant;
  /** Synth provider — typically `createSynthProvider()` from `factory`. */
  readonly provider: SynthProvider;
  /** Repository root used to resolve sprite-type defaults + output dir. */
  readonly repoRoot: string;
  /**
   * Output directory. Defaults to `<repoRoot>/generated/brief-candidates`.
   * Each call writes into `<outputRoot>/<name>/`.
   */
  readonly outputRoot?: string;
  /**
   * When true, write all candidates that pass validation even if some
   * fail. Default false: if any candidate fails, the whole run aborts
   * with an aggregated error and no files are written.
   */
  readonly partial?: boolean;
  /**
   * Environment source for the CI guard. Defaults to `process.env`.
   * Tests pass an empty object to exercise the success path.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Optional override for filesystem writes. Tests inject an in-memory
   * sink; production uses real `fs`.
   */
  readonly fsWrites?: FsWriteHooks;
  /**
   * Optional override for resolving a sprite type's `minVariations`
   * default. Production reads `data/sprite-types/<type>.json` from
   * `repoRoot`; tests inject a literal map so they stay hermetic.
   * Returning `null` means "no override" and the schema default of
   * `${DEFAULT_MIN_VARIATIONS}` is used.
   */
  readonly loadMinVariations?: (type: SpriteType) => number | null;
}

export interface FsWriteHooks {
  readonly mkdir: (absolutePath: string) => void;
  readonly writeFile: (absolutePath: string, contents: string) => void;
}

export interface SynthesizedBriefCandidate {
  /** Candidate id: `<name>-v<N>` (1-based). */
  readonly id: string;
  /** Resolved sprite type. */
  readonly type: SpriteType;
  /** Concrete description (becomes the YAML `description` field). */
  readonly description: string;
  /** Variation seeds (become the YAML `variations` field). */
  readonly embellishmentSeeds: ReadonlyArray<string>;
  /** Why this candidate's silhouette differs from the others. */
  readonly synthesisRationale: string;
  /** Absolute path of the YAML written to disk (when not skipped). */
  readonly yamlPath: string;
}

export interface SynthesizedBriefRejection {
  /** 1-based index of the rejected candidate. */
  readonly index: number;
  /** Human-readable reason. */
  readonly reason: string;
}

export interface SynthesizeBriefResult {
  readonly name: string;
  readonly type: SpriteType;
  /** Size variant stamped on the candidates (`'default'` when unset). */
  readonly sizeVariant: SizeVariant;
  /** Output directory absolute path. */
  readonly outDir: string;
  /** Successfully written candidates. */
  readonly written: ReadonlyArray<SynthesizedBriefCandidate>;
  /** Per-candidate rejections (when `partial: true`). */
  readonly rejected: ReadonlyArray<SynthesizedBriefRejection>;
  /** Sidecar absolute path. */
  readonly sidecarPath: string;
  /** Provider label (e.g. `azure-openai:gpt-4o-mini`). */
  readonly providerLabel: string;
  /** SHA-256 of the system+user prompt template, for reproducibility. */
  readonly promptHash: string;
}

export class SynthesizeBriefError extends Error {
  override readonly name = 'SynthesizeBriefError';
  constructor(
    message: string,
    readonly rejections: ReadonlyArray<SynthesizedBriefRejection> = [],
  ) {
    super(message);
  }
}

export async function synthesizeBrief(
  options: SynthesizeBriefOptions,
): Promise<SynthesizeBriefResult> {
  const env = options.env ?? process.env;
  if (isCi(env) && !isCiPipelineBypassed(env)) {
    throw new SynthesizeBriefError(
      'synthesizeBrief refuses to run in CI (env.CI is set). The synthesizer is ' +
        'local-only by policy: each call costs money and the output is non-deterministic. ' +
        'Run on a developer workstation instead, or set SPRITES_ALLOW_CI_PIPELINE=true ' +
        'in the asset-request CI workflow (see ADR 0043).',
    );
  }

  const name = normaliseName(options.name);
  const floor = options.floor ?? 1;
  if (!Number.isInteger(floor) || floor < 1 || floor > 20) {
    throw new SynthesizeBriefError(`floor must be an integer in [1, 20], got ${String(floor)}.`);
  }
  const sizeVariant = coerceSizeVariant(options.sizeVariant);
  const requested = options.candidates ?? 3;
  if (!Number.isInteger(requested) || requested < MIN_CANDIDATES || requested > MAX_CANDIDATES) {
    throw new SynthesizeBriefError(
      `candidates must be an integer in [${MIN_CANDIDATES}, ${MAX_CANDIDATES}], got ${String(requested)}.`,
    );
  }

  const callerType = options.type ?? null;
  const loadMinVariations = options.loadMinVariations ?? defaultLoadMinVariations(options.repoRoot);
  const { effectiveMinSeeds, effectiveMaxSeeds } = resolveSeedBounds(callerType, loadMinVariations);
  const briefHint = options.briefHint?.trim();
  const request = {
    name,
    ...(briefHint ? { briefHint } : {}),
    type: callerType,
    floor,
    candidates: requested,
    effectiveMinSeeds,
    effectiveMaxSeeds,
  } as const;

  const promptHash = hashPrompt(buildSystemPrompt(request), buildUserPrompt(request));

  const response = await options.provider.synthesizeBrief(request);

  const type = resolveType(callerType, response);

  // If the caller didn't supply a type, the up-front seed bounds were
  // computed across ALL sprite types (we conservatively pick the max).
  // Now that we know the actual inferred type, re-derive the bounds so
  // validation reports the right range in error messages and so a
  // candidate that satisfies the inferred type's needs isn't rejected
  // because some OTHER type happens to want even more seeds.
  const finalBounds =
    callerType === null
      ? resolveSeedBoundsForType(type, loadMinVariations)
      : { effectiveMinSeeds, effectiveMaxSeeds };

  const evaluated = response.candidates.map((c, i) =>
    evaluateCandidate(
      c,
      i + 1,
      name,
      type,
      finalBounds.effectiveMinSeeds,
      finalBounds.effectiveMaxSeeds,
    ),
  );

  const accepted = evaluated.filter(
    (e): e is { kind: 'ok'; candidate: SynthesizedBriefCandidate } => e.kind === 'ok',
  );
  const rejected: SynthesizedBriefRejection[] = evaluated
    .filter((e): e is { kind: 'rejected'; index: number; reason: string } => e.kind === 'rejected')
    .map(({ index, reason }) => ({ index, reason }));

  if (!options.partial && rejected.length > 0) {
    const lines = rejected.map((r) => `  - candidate ${r.index}: ${r.reason}`).join('\n');
    throw new SynthesizeBriefError(
      `${rejected.length} of ${response.candidates.length} candidates were rejected ` +
        `and partial=false. Aborting without writing any files.\n${lines}`,
      rejected,
    );
  }
  if (accepted.length === 0) {
    const lines = rejected.map((r) => `  - candidate ${r.index}: ${r.reason}`).join('\n');
    throw new SynthesizeBriefError(
      `No candidates passed validation. Re-run with a sharper subject name ` +
        `or pass --type to narrow the model.\n${lines}`,
      rejected,
    );
  }

  // All validation done. Now write.
  const outDir = path.resolve(
    options.outputRoot ?? path.join(options.repoRoot, 'generated', 'brief-candidates'),
    name,
  );
  const writes = options.fsWrites ?? defaultFsHooks();
  writes.mkdir(outDir);

  const written = accepted.map(({ candidate }, i) => {
    const yamlPath = path.join(outDir, `${name}-v${i + 1}.yaml`);
    const yaml = renderCandidateYaml(candidate, sizeVariant, floor);
    writes.writeFile(yamlPath, yaml);
    return { ...candidate, id: `${name}-v${i + 1}`, yamlPath };
  });

  const sidecarPath = path.join(outDir, 'synthesis.json');
  const sidecar = {
    name,
    type,
    sizeVariant,
    floor,
    requestedCandidates: requested,
    providerLabel: options.provider.providerLabel,
    promptHash,
    inferredType: response.inferredType,
    typeConfidence: response.typeConfidence,
    written: written.map((c) => ({
      id: c.id,
      yamlPath: path.relative(options.repoRoot, c.yamlPath).replace(/\\/g, '/'),
      rationale: c.synthesisRationale,
    })),
    rejected,
    rawResponse: serialiseResponse(response),
  } as const;
  writes.writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);

  return {
    name,
    type,
    sizeVariant,
    outDir,
    written,
    rejected,
    sidecarPath,
    providerLabel: options.provider.providerLabel,
    promptHash,
  };
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

export function normaliseName(raw: string): string {
  if (typeof raw !== 'string') {
    throw new SynthesizeBriefError('name must be a string.');
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new SynthesizeBriefError('name must not be empty.');
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new SynthesizeBriefError(`name '${trimmed}' is longer than ${MAX_NAME_LENGTH} chars.`);
  }
  // Lowercase, replace apostrophes with nothing (so "devil's" → "devils"),
  // any non-alphanumeric run becomes a single dash, trim dashes from the ends.
  // Path-traversal segments (`..`, `/`, `\`) are not handled with an extra
  // guard — the non-alphanumeric collapse converts them all to a single
  // dash, so e.g. "../etc/passwd" safely normalises to "etc-passwd". The
  // NAME_REGEX check below catches anything that still contains an unsafe
  // character (it shouldn't be possible after the collapse, but the regex
  // is the belt-and-braces guard).
  const slug = trimmed
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length === 0 || !NAME_REGEX.test(slug)) {
    throw new SynthesizeBriefError(
      `name '${raw}' could not be normalised to kebab-case (got '${slug}'). ` +
        `Use letters, digits, and dashes only.`,
    );
  }
  return slug;
}

function isCi(env: Readonly<Record<string, string | undefined>>): boolean {
  const v = env.CI;
  if (v === undefined || v === '') return false;
  // Truthy under common conventions: "1", "true", "yes". Treat any other
  // non-empty string as truthy too (GitHub Actions sets CI=true).
  return v !== '0' && v.toLowerCase() !== 'false';
}

function resolveType(callerType: SpriteType | null, response: SynthesizeBriefResponse): SpriteType {
  if (callerType !== null) return callerType;
  if (response.inferredType === null || response.typeConfidence === null) {
    throw new SynthesizeBriefError(
      'no --type was supplied and the synthesizer did not return a classification. ' +
        'Re-run with --type weapon|enemy|item|tile|vfx|character.',
    );
  }
  if (response.typeConfidence < MIN_TYPE_CONFIDENCE) {
    throw new SynthesizeBriefError(
      `no --type was supplied and the synthesizer's classification ` +
        `('${response.inferredType}', confidence ${response.typeConfidence.toFixed(2)}) ` +
        `is below the required ${MIN_TYPE_CONFIDENCE}. ` +
        `Re-run with --type to remove the ambiguity.`,
    );
  }
  return response.inferredType;
}

type EvaluatedCandidate =
  | { readonly kind: 'ok'; readonly candidate: SynthesizedBriefCandidate }
  | { readonly kind: 'rejected'; readonly index: number; readonly reason: string };

function evaluateCandidate(
  source: SynthesizedCandidate,
  index: number,
  name: string,
  type: SpriteType,
  effectiveMinSeeds: number,
  effectiveMaxSeeds: number,
): EvaluatedCandidate {
  // Banned-adjective check is the cheapest and the most reliably wrong
  // signal: fail fast.
  const bannedMatch = BANNED_REGEX.exec(source.description);
  if (bannedMatch) {
    return reject(
      index,
      `description contains banned vague adjective '${bannedMatch[0]}'. ` +
        `Rewrite with concrete pose/silhouette/colour language.`,
    );
  }
  if (
    source.embellishmentSeeds.length < effectiveMinSeeds ||
    source.embellishmentSeeds.length > effectiveMaxSeeds
  ) {
    return reject(
      index,
      `embellishmentSeeds must be ${effectiveMinSeeds}-${effectiveMaxSeeds} ` +
        `entries (sprite-type '${type}' wants at least ${effectiveMinSeeds}), ` +
        `got ${source.embellishmentSeeds.length}.`,
    );
  }
  // The candidate is valid. Build the canonical SynthesizedBriefCandidate
  // record (yamlPath is overwritten when we actually write).
  return {
    kind: 'ok',
    candidate: {
      id: `${name}-v${index}`,
      type,
      description: source.description,
      embellishmentSeeds: source.embellishmentSeeds,
      synthesisRationale: source.rationale,
      yamlPath: '',
    },
  };
}

function reject(index: number, reason: string): EvaluatedCandidate {
  return { kind: 'rejected', index, reason };
}

function renderCandidateYaml(
  candidate: SynthesizedBriefCandidate,
  sizeVariant: SizeVariant,
  floor: number,
): string {
  // Minimal-brief shape only: type, name, [sizeVariant], description,
  // variations. Let the loader's deep-merge fill in defaults.
  // `sizeVariant` is emitted only when non-default so default briefs stay
  // byte-for-byte identical to the pre-variant output.
  const doc = {
    type: candidate.type,
    name: candidate.id,
    ...(sizeVariant === DEFAULT_SIZE_VARIANT ? {} : { sizeVariant }),
    ...(floor === 1 ? {} : { floor }),
    description: candidate.description,
    variations: candidate.embellishmentSeeds.slice(),
  };
  return [
    `# Synthesised candidate: ${candidate.id}`,
    `# Rationale: ${candidate.synthesisRationale}`,
    '#',
    '# This file lives under generated/brief-candidates/ (gitignored). To promote:',
    `#   1. mv this file into briefs/draft/<type>/${candidate.id}.yaml`,
    '#   2. run `npm run sprites:run -- --brief briefs/draft/<type>/<file>.yaml`',
    `#   3. if a variant passes sensors, move into briefs/${candidate.type}s/`,
    '',
    stringifyYaml(doc, { lineWidth: 0 }),
  ].join('\n');
}

function hashPrompt(system: string, user: string): string {
  const h = createHash('sha256');
  h.update(system);
  h.update('\n---\n');
  h.update(user);
  return h.digest('hex');
}

function serialiseResponse(response: SynthesizeBriefResponse): unknown {
  // We deliberately drop nothing here — the sidecar is for forensic
  // review by the human. We do NOT serialise the prompt body or any provider
  // credentials (which never reach this function in the first place).
  return {
    inferredType: response.inferredType,
    typeConfidence: response.typeConfidence,
    candidates: response.candidates.map((c) => ({
      description: c.description,
      rationale: c.rationale,
      embellishmentSeeds: c.embellishmentSeeds.slice(),
    })),
  };
}

function defaultFsHooks(): FsWriteHooks {
  return {
    mkdir: (p) => mkdirSync(p, { recursive: true }),
    writeFile: (p, contents) => writeFileSync(p, contents),
  };
}

/**
 * Resolve the effective `embellishmentSeeds` window for a single
 * sprite type. The lower bound is `max(MIN_SEEDS_PER_CANDIDATE,
 * type.minVariations)` so synth never produces fewer seeds than the
 * downstream expander expects from the brief schema. The upper bound
 * grows to match if the type wants more than the static cap; otherwise
 * the static cap holds. (No type ships with minVariations > 5 today,
 * but the schema allows up to 20.)
 */
function resolveSeedBoundsForType(
  type: SpriteType,
  loadMinVariations: (type: SpriteType) => number | null,
): { effectiveMinSeeds: number; effectiveMaxSeeds: number } {
  // `null` means "no override on disk", so fall back to the schema's
  // own default. An explicit `0` (the "stay strictly canonical" opt-out
  // — see `brief-schema.ts`) is honoured: it can never push the synth
  // lower bound below MIN_SEEDS_PER_CANDIDATE because of the max() guard,
  // but we don't want it to bump the bound up to the schema default
  // either.
  const raw = loadMinVariations(type);
  const wanted = raw ?? DEFAULT_MIN_VARIATIONS;
  const min = Math.max(MIN_SEEDS_PER_CANDIDATE, wanted);
  const max = Math.max(MAX_SEEDS_PER_CANDIDATE, min);
  return { effectiveMinSeeds: min, effectiveMaxSeeds: max };
}

/**
 * Resolve the seed window used to prompt the model. When the caller
 * supplied a type we use that type's bounds. When the caller did NOT
 * supply a type (classification mode) we pick the widest min across
 * all sprite types so the response is guaranteed to satisfy whichever
 * type the model ends up inferring. The bounds are recomputed against
 * the actual inferred type at validation time.
 */
function resolveSeedBounds(
  callerType: SpriteType | null,
  loadMinVariations: (type: SpriteType) => number | null,
): { effectiveMinSeeds: number; effectiveMaxSeeds: number } {
  if (callerType !== null) {
    return resolveSeedBoundsForType(callerType, loadMinVariations);
  }
  let min = MIN_SEEDS_PER_CANDIDATE;
  let max = MAX_SEEDS_PER_CANDIDATE;
  for (const t of SPRITE_TYPES) {
    const bounds = resolveSeedBoundsForType(t, loadMinVariations);
    if (bounds.effectiveMinSeeds > min) min = bounds.effectiveMinSeeds;
    if (bounds.effectiveMaxSeeds > max) max = bounds.effectiveMaxSeeds;
  }
  return { effectiveMinSeeds: min, effectiveMaxSeeds: max };
}

/**
 * Default loader that reads `data/sprite-types/<type>.json` from the
 * repo root and returns the `minVariations` field, or `null` when the
 * file is missing or the field is unset. Caller maps `null` to the
 * schema default of {@link DEFAULT_MIN_VARIATIONS}.
 */
function defaultLoadMinVariations(repoRoot: string): (type: SpriteType) => number | null {
  return (type) => {
    const defaultsPath = path.join(repoRoot, 'data', 'sprite-types', `${type}.json`);
    let raw: string;
    try {
      raw = readFileSync(defaultsPath, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      // Other read failures should not abort synthesis — log via the
      // returned null and let the schema default take over. Synthesis
      // is local-only and cheap to retry; a noisy throw here would be
      // worse than silent fallback for a sprite-type that exists on
      // disk but has a transient read error.
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const v = (parsed as Record<string, unknown>).minVariations;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return null;
    return v;
  };
}

/** Re-exported for the CLI so it can print the canonical sprite type list. */
export { SPRITE_TYPES };
