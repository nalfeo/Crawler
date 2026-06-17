/**
 * Brief synthesizer — turns a subject name into N reviewable
 * minimal-brief YAML candidates.
 *
 * Workflow:
 *   1. Refuse if `env.CI` is set (constitutional §3: synthesizer is
 *      local-only because each call costs money and is non-deterministic).
 *   2. Normalise + validate the subject name (lowercase kebab-case, no
 *      path separators, ≤64 chars).
 *   3. Build the reference allow-list from disk.
 *   4. Issue ONE structured-output call to the synth provider for all
 *      N candidates. Per-candidate calls would scale cost linearly for
 *      no quality gain.
 *   5. For each candidate:
 *        a. Reject if the description contains a banned vague adjective.
 *        b. Reject if any reference id is not in the catalog OR its
 *           file does not exist on disk. (Catalog membership alone is
 *           technically enough — the catalog only contains existing
 *           files — but the explicit existence check is a defence
 *           against a stale in-memory catalog if anything ever
 *           re-introduces caching here.)
 *        c. Require 2-3 references and 3-5 embellishment seeds.
 *   6. Decide write policy with `partial`:
 *        - `partial=false` (default): if any candidate is rejected, throw
 *          an aggregated error and write nothing.
 *        - `partial=true`: write the valid candidates and surface
 *          rejections in the sidecar.
 *   7. If type was not supplied: require `typeConfidence >= 0.9`,
 *      otherwise throw (the user must re-run with --type).
 *   8. Write `<outDir>/<name>/<name>-v{1,N}.yaml` and `synthesis.json`.
 *      Atomic-ish: all validation happens before any write.
 *
 * Everything except the provider call and the filesystem hooks is pure.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { SPRITE_TYPES } from './brief-schema.js';
import { buildReferenceCatalog, resolveReferenceId } from './reference-allow-list.js';
import { buildSystemPrompt, buildUserPrompt } from './provider/azure-chat-synth.js';
export const MIN_CANDIDATES = 1;
export const MAX_CANDIDATES = 5;
const MAX_NAME_LENGTH = 64;
const NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/;
const BANNED_ADJECTIVES = ['cool', 'awesome', 'epic', 'amazing', 'nice'];
const BANNED_REGEX = new RegExp(`\\b(${BANNED_ADJECTIVES.join('|')})\\b`, 'i');
const MIN_REFS_PER_CANDIDATE = 2;
const MAX_REFS_PER_CANDIDATE = 3;
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
export class SynthesizeBriefError extends Error {
  rejections;
  name = 'SynthesizeBriefError';
  constructor(message, rejections = []) {
    super(message);
    this.rejections = rejections;
  }
}
export async function synthesizeBrief(options) {
  const env = options.env ?? process.env;
  if (isCi(env)) {
    throw new SynthesizeBriefError(
      'synthesizeBrief refuses to run in CI (env.CI is set). The synthesizer is ' +
        'local-only by policy: each call costs money and the output is non-deterministic. ' +
        'Run on a developer workstation instead.',
    );
  }
  const name = normaliseName(options.name);
  const requested = options.candidates ?? 3;
  if (!Number.isInteger(requested) || requested < MIN_CANDIDATES || requested > MAX_CANDIDATES) {
    throw new SynthesizeBriefError(
      `candidates must be an integer in [${MIN_CANDIDATES}, ${MAX_CANDIDATES}], got ${String(requested)}.`,
    );
  }
  const catalog = buildReferenceCatalog({
    repoRoot: options.repoRoot,
    ...(options.referenceCatalogOptions?.readPacks
      ? { readPacks: options.referenceCatalogOptions.readPacks }
      : {}),
    ...(options.referenceCatalogOptions?.fileExists
      ? { fileExists: options.referenceCatalogOptions.fileExists }
      : {}),
  });
  // Resolution order for the per-candidate re-check:
  //   1. explicit synthesis-time hook (tests use this to exercise the
  //      defence-in-depth without also affecting catalog discovery),
  //   2. the catalog's fileExists hook (so a unit test that bypasses
  //      disk for catalog discovery doesn't accidentally fall back to
  //      real disk for the re-check),
  //   3. the real fs-backed default.
  const referenceFileExists =
    options.referenceFileExistsAtSynthesisTime ??
    options.referenceCatalogOptions?.fileExists ??
    defaultFileExistsAtSynthesisTime;
  const callerType = options.type ?? null;
  const loadMinVariations = options.loadMinVariations ?? defaultLoadMinVariations(options.repoRoot);
  const { effectiveMinSeeds, effectiveMaxSeeds } = resolveSeedBounds(callerType, loadMinVariations);
  const request = {
    name,
    type: callerType,
    candidates: requested,
    referenceCatalog: catalog,
    effectiveMinSeeds,
    effectiveMaxSeeds,
  };
  const promptHash = hashPrompt(buildSystemPrompt(request), buildUserPrompt(request), catalog);
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
      catalog,
      options.repoRoot,
      name,
      type,
      referenceFileExists,
      finalBounds.effectiveMinSeeds,
      finalBounds.effectiveMaxSeeds,
    ),
  );
  const accepted = evaluated.filter((e) => e.kind === 'ok');
  const rejected = evaluated
    .filter((e) => e.kind === 'rejected')
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
    const yaml = renderCandidateYaml(candidate);
    writes.writeFile(yamlPath, yaml);
    return { ...candidate, id: `${name}-v${i + 1}`, yamlPath };
  });
  const sidecarPath = path.join(outDir, 'synthesis.json');
  const sidecar = {
    name,
    type,
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
  };
  writes.writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
  return {
    name,
    type,
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
export function normaliseName(raw) {
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
function isCi(env) {
  const v = env.CI;
  if (v === undefined || v === '') return false;
  // Truthy under common conventions: "1", "true", "yes". Treat any other
  // non-empty string as truthy too (GitHub Actions sets CI=true).
  return v !== '0' && v.toLowerCase() !== 'false';
}
function resolveType(callerType, response) {
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
function evaluateCandidate(
  source,
  index,
  catalog,
  repoRoot,
  name,
  type,
  fileExists,
  effectiveMinSeeds,
  effectiveMaxSeeds,
) {
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
    source.references.length < MIN_REFS_PER_CANDIDATE ||
    source.references.length > MAX_REFS_PER_CANDIDATE
  ) {
    return reject(
      index,
      `references must be ${MIN_REFS_PER_CANDIDATE}-${MAX_REFS_PER_CANDIDATE} entries, ` +
        `got ${source.references.length}.`,
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
  const seenIds = new Set();
  const resolvedRefs = [];
  for (const ref of source.references) {
    if (seenIds.has(ref.id)) {
      return reject(index, `reference id '${ref.id}' appears twice in this candidate.`);
    }
    seenIds.add(ref.id);
    let sheet;
    try {
      sheet = resolveReferenceId(catalog, ref.id);
    } catch (err) {
      return reject(
        index,
        `reference id '${ref.id}' is not in the allow-list. ` +
          `(${err instanceof Error ? err.message : String(err)})`,
      );
    }
    // Defensive: even though buildReferenceCatalog already confirmed the
    // file exists on disk when assembling the catalog, re-check at write
    // time so a deleted/renamed sheet between catalog build and write
    // surfaces here rather than poisoning a YAML.
    const absolute = path.join(repoRoot, sheet.path);
    if (!fileExists(absolute)) {
      return reject(
        index,
        `reference '${ref.id}' resolved to ${sheet.path} but the file is missing on disk.`,
      );
    }
    resolvedRefs.push({ path: sheet.path, note: ref.note });
  }
  // The candidate is valid. Build the canonical SynthesizedBriefCandidate
  // record (yamlPath is overwritten when we actually write).
  return {
    kind: 'ok',
    candidate: {
      id: `${name}-v${index}`,
      type,
      description: source.description,
      references: resolvedRefs,
      embellishmentSeeds: source.embellishmentSeeds,
      synthesisRationale: source.rationale,
      yamlPath: '',
    },
  };
}
function reject(index, reason) {
  return { kind: 'rejected', index, reason };
}
function renderCandidateYaml(candidate) {
  // Minimal-brief shape only: type, name, description, references,
  // variations. Let the loader's deep-merge fill in defaults.
  const doc = {
    type: candidate.type,
    name: candidate.id,
    description: candidate.description,
    references: candidate.references.map((r) => ({ path: r.path, note: r.note })),
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
function hashPrompt(system, user, catalog) {
  const h = createHash('sha256');
  h.update(system);
  h.update('\n---\n');
  h.update(user);
  h.update('\n---\n');
  for (const r of catalog) {
    h.update(`${r.id}|${r.path}\n`);
  }
  return h.digest('hex');
}
function serialiseResponse(response) {
  // We deliberately drop nothing here — the sidecar is for forensic
  // review by the human. We do NOT serialise the prompt body (which
  // would duplicate the catalog and bloat the file) or any provider
  // credentials (which never reach this function in the first place).
  return {
    inferredType: response.inferredType,
    typeConfidence: response.typeConfidence,
    candidates: response.candidates.map((c) => ({
      description: c.description,
      rationale: c.rationale,
      references: c.references.map((r) => ({ id: r.id, note: r.note })),
      embellishmentSeeds: c.embellishmentSeeds.slice(),
    })),
  };
}
function defaultFsHooks() {
  return {
    mkdir: (p) => mkdirSync(p, { recursive: true }),
    writeFile: (p, contents) => writeFileSync(p, contents),
  };
}
function defaultFileExistsAtSynthesisTime(absolutePath) {
  try {
    return statSync(absolutePath).isFile();
  } catch {
    return false;
  }
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
function resolveSeedBoundsForType(type, loadMinVariations) {
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
function resolveSeedBounds(callerType, loadMinVariations) {
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
function defaultLoadMinVariations(repoRoot) {
  return (type) => {
    const defaultsPath = path.join(repoRoot, 'data', 'sprite-types', `${type}.json`);
    let raw;
    try {
      raw = readFileSync(defaultsPath, 'utf8');
    } catch (err) {
      const code = err.code;
      if (code === 'ENOENT') return null;
      // Other read failures should not abort synthesis — log via the
      // returned null and let the schema default take over. Synthesis
      // is local-only and cheap to retry; a noisy throw here would be
      // worse than silent fallback for a sprite-type that exists on
      // disk but has a transient read error.
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const v = parsed.minVariations;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return null;
    return v;
  };
}
/** Re-exported for the CLI so it can print the canonical sprite type list. */
export { SPRITE_TYPES };
//# sourceMappingURL=synthesize-brief.js.map
