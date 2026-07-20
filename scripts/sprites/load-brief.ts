/**
 * Brief loader.
 *
 * Reads a YAML brief from disk, merges per-type defaults, validates the
 * merged result against the Zod schema, and resolves the palette `id` into
 * actual `[r, g, b]` color triples loaded from `data/palettes/<id>.json`.
 *
 * Authors write minimal briefs — typically just `type`, `name`, and
 * `description` — and per-type defaults from `data/sprite-types/<type>.json`
 * fill in everything else (size, palette, anchor, references, sheet layout,
 * sensor thresholds). Any field present on the minimal brief overrides the
 * default at that path. The `description` field becomes the `prompt` if the
 * author hasn't set `prompt` explicitly.
 *
 * Why a dedicated module: every consumer (CLI, lab sidecar, tests) wants
 * the same disk-to-validated-brief pipeline. Centralising the merge +
 * validation here keeps the post-processor / scorer / orchestrator
 * unchanged when we add new defaults, brief locations, or palette sources.
 *
 * Pure-ish: this module touches the filesystem (it has to), but given the
 * same inputs (file contents) it produces identical outputs.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  briefSchema,
  minimalBriefSchema,
  type Brief,
  type PaletteColors,
  type RgbTriple,
  type SpriteTypeDefaults,
} from './brief-schema.js';
import { deepMergeDefaults } from './deep-merge.js';
import { applySizeVariantToDefaults, coerceSizeVariant } from './size-variants.js';

export interface LoadedBrief {
  readonly brief: Brief;
  /** Resolved palette colors, from `data/palettes/<brief.palette.id>.json`. */
  readonly palette: PaletteColors;
  /** Absolute path the brief was loaded from — useful for diagnostics + retries. */
  readonly briefPath: string;
}

export interface LoadBriefOptions {
  /**
   * Project root for resolving `data/palettes/<id>.json` and
   * `data/sprite-types/<type>.json`. Defaults to `process.cwd()` which is
   * correct when the CLI is invoked through `npm run sprites:run` from the
   * repo root.
   */
  readonly projectRoot?: string;
  /**
   * Override palette loading entirely — used by tests so they can avoid
   * hitting the disk. When supplied, this is called with the brief's palette
   * id and must return the resolved colors.
   */
  readonly loadPalette?: (paletteId: string) => PaletteColors;
  /**
   * Override per-type defaults loading. Used by tests to avoid disk access
   * and to keep test briefs fully self-contained. When supplied, this is
   * called with the brief's `type` and must return the defaults object (or
   * `null` to skip merging — useful for legacy fully-specified briefs).
   */
  readonly loadTypeDefaults?: (type: string) => SpriteTypeDefaults | null;
}

export function loadBrief(briefPath: string, opts: LoadBriefOptions = {}): LoadedBrief {
  const absolute = path.resolve(briefPath);
  const raw = readFileSync(absolute, 'utf8');
  const parsed = parseYaml(raw) as unknown;

  // Parse the minimal shape first so we get `type` early — we need it to
  // pick the defaults file. The minimal schema is `.passthrough()`, so any
  // fully-specified brief still passes this gate without losing fields.
  const minimal = minimalBriefSchema.safeParse(parsed);
  if (!minimal.success) {
    const issues = minimal.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Brief at ${absolute} failed minimal validation ` +
        `(type, name, and one of description/prompt required):\n${issues}`,
    );
  }
  const loadDefaults = opts.loadTypeDefaults ?? defaultTypeDefaultsLoader(opts.projectRoot);
  const defaults = loadDefaults(minimal.data.type);

  // Merge: defaults underneath, the minimal brief's fields on top. The
  // minimal brief's `description` is mapped to `prompt` only when the
  // merged object doesn't already have a `prompt`. We strip `description`
  // from the merged result so the strict full-brief schema doesn't trip
  // on it.
  //
  // Safety: if the minimal brief explicitly provides a malformed `sensors`
  // (e.g. `sensors: null` or `sensors: "oops"`), skip the deep-merge for
  // that key so Zod reports a clear error instead of us silently inheriting
  // sprite-type sensor defaults. (Carried over from PR #44.)
  const merged = mergeMinimalIntoDefaults(minimal.data, defaults);

  const result = briefSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new Error(`Brief at ${absolute} failed validation:\n${issues}`);
  }
  const brief = result.data;
  const palette = (opts.loadPalette ?? defaultPaletteLoader(opts.projectRoot))(brief.palette.id);
  return { brief, palette, briefPath: absolute };
}

/**
 * Merge a minimal brief on top of per-type defaults. Pure; exposed so tests
 * can exercise the merge semantics directly without disk I/O.
 *
 * - `description` becomes `prompt` when the merged brief has no explicit
 *   `prompt`. The `description` field is then stripped because the strict
 *   `briefSchema` doesn't allow unknown keys.
 * - `sizeVariant` (default/wide/tall/large) is consumed here, not merged: it
 *   scales the per-type defaults (size/anchor/native canvas) BEFORE the
 *   author's explicit fields merge on top, so a pinned `size`/`anchor` still
 *   wins over the variant. It is stripped for the same strict-schema reason.
 * - `defaults` is treated as immutable.
 * - When `defaults` is `null` (loader returned no defaults for the type),
 *   the minimal brief is passed through more or less verbatim. The
 *   author is then responsible for supplying every required field (and a
 *   `sizeVariant` has nothing to scale, so it no-ops but is still stripped).
 */
export function mergeMinimalIntoDefaults(
  minimal: Record<string, unknown>,
  defaults: SpriteTypeDefaults | null,
): Record<string, unknown> {
  // Pull the size-variant directive off the minimal brief and strip it: it is
  // an authoring convenience, not a strict-schema field. Apply it to the
  // per-type defaults so the author's explicit fields still merge on top.
  const variant = coerceSizeVariant(
    minimal.sizeVariant ??
      (minimal.type === 'enemy' && minimal.mobRole === 'boss' ? 'large' : undefined),
  );
  const sanitizedMinimal: Record<string, unknown> = { ...minimal };
  delete sanitizedMinimal.sizeVariant;

  const rawBase = defaults === null ? {} : (defaults as Record<string, unknown>);
  const base = applySizeVariantToDefaults(rawBase, variant);
  // Safety: if the minimal brief explicitly provides a malformed `sensors`
  // (e.g. `sensors: null` or `sensors: "oops"`), skip the deep-merge for
  // that key — otherwise we'd silently overwrite the bad value with the
  // sprite-type sensor defaults and the user would never see their typo.
  // Pass it through so Zod surfaces a clear validation error. (PR #44.)
  if (
    'sensors' in sanitizedMinimal &&
    !isPlainObject(sanitizedMinimal.sensors) &&
    sanitizedMinimal.sensors !== undefined
  ) {
    // Force-overwrite defaults.sensors so Zod sees the bad value verbatim.
    const baseCopy = { ...base };
    delete baseCopy.sensors;
    const merged = deepMergeDefaults(baseCopy, sanitizedMinimal);
    merged.sensors = sanitizedMinimal.sensors;
    if (merged.prompt === undefined && typeof merged.description === 'string') {
      merged.prompt = merged.description;
    }
    delete merged.description;
    return merged;
  }
  const merged = deepMergeDefaults(base, sanitizedMinimal);
  if (merged.prompt === undefined && typeof merged.description === 'string') {
    merged.prompt = merged.description;
  }
  delete merged.description;
  return merged;
}

function defaultTypeDefaultsLoader(
  projectRoot?: string,
): (type: string) => SpriteTypeDefaults | null {
  const root = projectRoot ?? process.cwd();
  return (type: string): SpriteTypeDefaults | null => {
    const defaultsPath = path.join(root, 'data', 'sprite-types', `${type}.json`);
    let raw: string;
    try {
      raw = readFileSync(defaultsPath, 'utf8');
    } catch (err) {
      // No defaults file for this type yet — the brief author is responsible
      // for supplying every required field; the merged schema validation
      // will surface anything missing with a clear message.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      throw new Error(
        `Failed reading sprite-type defaults at ${defaultsPath}: ${(err as Error).message}`,
        { cause: err },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (err) {
      throw new Error(
        `Failed parsing sprite-type defaults at ${defaultsPath}: ${(err as Error).message}`,
        { cause: err },
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Sprite-type defaults at ${defaultsPath} must be a JSON object`);
    }
    return stripMetaKeys(parsed as Record<string, unknown>) as SpriteTypeDefaults;
  };
}

/**
 * Strip `$`-prefixed metadata keys (JSON-Schema convention for `$comment`,
 * `$schema`, `$id`, etc.) from defaults so the strict brief schema doesn't
 * reject them after merge. Applied recursively to nested objects.
 */
function stripMetaKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripMetaKeys);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k.startsWith('$')) continue;
    out[k] = stripMetaKeys(v);
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function defaultPaletteLoader(projectRoot?: string): (paletteId: string) => PaletteColors {
  const root = projectRoot ?? process.cwd();
  return (paletteId: string): PaletteColors => {
    const palettePath = path.join(root, 'data', 'palettes', `${paletteId}.json`);
    let raw: string;
    try {
      raw = readFileSync(palettePath, 'utf8');
    } catch (err) {
      throw new Error(
        `Palette '${paletteId}' not found at ${palettePath}. ` +
          `Add data/palettes/${paletteId}.json or correct the brief's palette.id. ` +
          `(${(err as Error).message})`,
        { cause: err },
      );
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error(`Palette ${palettePath} must be a non-empty array of [r,g,b] triples`);
    }
    return parsed.map((entry, idx) => validateTriple(entry, idx, palettePath));
  };
}

function validateTriple(entry: unknown, idx: number, source: string): RgbTriple {
  if (
    !Array.isArray(entry) ||
    entry.length !== 3 ||
    !entry.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 255)
  ) {
    throw new Error(
      `Palette ${source} entry ${idx} is not a [r,g,b] integer triple in [0,255]: ${JSON.stringify(entry)}`,
    );
  }
  return [entry[0] as number, entry[1] as number, entry[2] as number] as const;
}
