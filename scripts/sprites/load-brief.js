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
import { briefSchema, minimalBriefSchema } from './brief-schema.js';
import { deepMergeDefaults } from './deep-merge.js';
export function loadBrief(briefPath, opts = {}) {
  const absolute = path.resolve(briefPath);
  const raw = readFileSync(absolute, 'utf8');
  const parsed = parseYaml(raw);
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
 * - `defaults` is treated as immutable.
 * - When `defaults` is `null` (loader returned no defaults for the type),
 *   the minimal brief is passed through more or less verbatim. The
 *   author is then responsible for supplying every required field.
 */
export function mergeMinimalIntoDefaults(minimal, defaults) {
  const base = defaults === null ? {} : defaults;
  // Safety: if the minimal brief explicitly provides a malformed `sensors`
  // (e.g. `sensors: null` or `sensors: "oops"`), skip the deep-merge for
  // that key — otherwise we'd silently overwrite the bad value with the
  // sprite-type sensor defaults and the user would never see their typo.
  // Pass it through so Zod surfaces a clear validation error. (PR #44.)
  const sanitizedMinimal = { ...minimal };
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
  const merged = deepMergeDefaults(base, minimal);
  if (merged.prompt === undefined && typeof merged.description === 'string') {
    merged.prompt = merged.description;
  }
  delete merged.description;
  return merged;
}
function defaultTypeDefaultsLoader(projectRoot) {
  const root = projectRoot ?? process.cwd();
  return (type) => {
    const defaultsPath = path.join(root, 'data', 'sprite-types', `${type}.json`);
    let raw;
    try {
      raw = readFileSync(defaultsPath, 'utf8');
    } catch (err) {
      // No defaults file for this type yet — the brief author is responsible
      // for supplying every required field; the merged schema validation
      // will surface anything missing with a clear message.
      const code = err.code;
      if (code === 'ENOENT') return null;
      throw new Error(`Failed reading sprite-type defaults at ${defaultsPath}: ${err.message}`, {
        cause: err,
      });
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Failed parsing sprite-type defaults at ${defaultsPath}: ${err.message}`, {
        cause: err,
      });
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Sprite-type defaults at ${defaultsPath} must be a JSON object`);
    }
    return stripMetaKeys(parsed);
  };
}
/**
 * Strip `$`-prefixed metadata keys (JSON-Schema convention for `$comment`,
 * `$schema`, `$id`, etc.) from defaults so the strict brief schema doesn't
 * reject them after merge. Applied recursively to nested objects.
 */
function stripMetaKeys(value) {
  if (Array.isArray(value)) return value.map(stripMetaKeys);
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k.startsWith('$')) continue;
    out[k] = stripMetaKeys(v);
  }
  return out;
}
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function defaultPaletteLoader(projectRoot) {
  const root = projectRoot ?? process.cwd();
  return (paletteId) => {
    const palettePath = path.join(root, 'data', 'palettes', `${paletteId}.json`);
    let raw;
    try {
      raw = readFileSync(palettePath, 'utf8');
    } catch (err) {
      throw new Error(
        `Palette '${paletteId}' not found at ${palettePath}. ` +
          `Add data/palettes/${paletteId}.json or correct the brief's palette.id. ` +
          `(${err.message})`,
        { cause: err },
      );
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error(`Palette ${palettePath} must be a non-empty array of [r,g,b] triples`);
    }
    return parsed.map((entry, idx) => validateTriple(entry, idx, palettePath));
  };
}
function validateTriple(entry, idx, source) {
  if (
    !Array.isArray(entry) ||
    entry.length !== 3 ||
    !entry.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 255)
  ) {
    throw new Error(
      `Palette ${source} entry ${idx} is not a [r,g,b] integer triple in [0,255]: ${JSON.stringify(entry)}`,
    );
  }
  return [entry[0], entry[1], entry[2]];
}
//# sourceMappingURL=load-brief.js.map
