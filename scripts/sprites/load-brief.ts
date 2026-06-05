/**
 * Brief loader.
 *
 * Reads a YAML brief from disk, parses it, applies any matching sprite-type
 * defaults from `data/sprite-types/<type>.json`, validates against the Zod
 * schema, and resolves the palette `id` into actual `[r, g, b]` color
 * triples loaded from `data/palettes/<id>.json`.
 *
 * Sprite-type defaults give a single place to opt every brief of a given
 * sprite type into a sensor or option without editing each brief by hand.
 * Currently only `sensors.*` is merged from the type defaults; individual
 * brief fields (`anchor`, `prompt`, references, ...) are deliberately not
 * defaulted from the type. Brief values *always* win over type defaults
 * (per-key for `sensors.*` sub-objects), so existing briefs that already set
 * a value continue to work unchanged.
 *
 * Why a dedicated module: the Zod schema is format-agnostic (it accepts the
 * pre-parsed object), but every consumer (CLI, lab sidecar, tests) wants the
 * same disk-to-validated-brief pipeline. Centralising it here keeps the
 * post-processor / scorer / orchestrator unchanged when we add new palette
 * sources or brief locations later.
 *
 * Pure-ish: this module touches the filesystem (it has to), but given the
 * same inputs (file contents) it produces identical outputs.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { briefSchema, type Brief, type PaletteColors, type RgbTriple } from './brief-schema.js';

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
   * Override sprite-type defaults loading — used by tests to inject
   * deterministic defaults without writing JSON to disk. When supplied,
   * this is called with the brief's `type` and must return the defaults
   * object (or `null` / `undefined` to indicate "no defaults").
   */
  readonly loadSpriteTypeDefaults?: (spriteType: string) => unknown;
}

export function loadBrief(briefPath: string, opts: LoadBriefOptions = {}): LoadedBrief {
  const absolute = path.resolve(briefPath);
  const raw = readFileSync(absolute, 'utf8');
  const parsed = parseYaml(raw) as unknown;

  const merged = mergeSpriteTypeDefaults(parsed, opts);

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
 * Merge `sensors` defaults from `data/sprite-types/<type>.json` into the
 * parsed brief object before Zod validation. Brief values win on per-key
 * conflict; sensor sub-objects (`sensors.weapon`, `sensors.anchor`, ...)
 * are merged field-by-field so a brief can override a single option without
 * having to restate every other type-default field.
 *
 * Non-object inputs (e.g. when the YAML is malformed) are passed through
 * untouched — Zod will reject them downstream with a clearer error than
 * anything we could emit here. The same is true when the brief explicitly
 * provides a `sensors` key whose value is not a plain object (e.g.
 * `sensors: null` or `sensors: "oops"`): we leave it alone so the user sees
 * the schema error instead of silently inheriting sprite-type defaults.
 */
function mergeSpriteTypeDefaults(parsed: unknown, opts: LoadBriefOptions): unknown {
  if (!isPlainObject(parsed)) return parsed;
  const spriteType = parsed.type;
  if (typeof spriteType !== 'string' || spriteType.length === 0) return parsed;
  // If the brief explicitly provides a malformed `sensors`, leave it alone
  // and let Zod reject it. Only fall through when `sensors` is missing or a
  // plain object we can safely merge.
  if ('sensors' in parsed && !isPlainObject(parsed.sensors)) return parsed;

  const loader = opts.loadSpriteTypeDefaults ?? defaultSpriteTypeDefaultsLoader(opts.projectRoot);
  const defaults = loader(spriteType);
  if (!isPlainObject(defaults)) return parsed;

  const defaultSensors = isPlainObject(defaults.sensors) ? defaults.sensors : {};
  const briefSensors = isPlainObject(parsed.sensors) ? parsed.sensors : {};

  // Per-key sensor merge: brief sub-objects win field-by-field over defaults.
  const mergedSensors: Record<string, unknown> = { ...defaultSensors };
  for (const [key, briefValue] of Object.entries(briefSensors)) {
    const defaultValue = defaultSensors[key];
    if (isPlainObject(briefValue) && isPlainObject(defaultValue)) {
      mergedSensors[key] = { ...defaultValue, ...briefValue };
    } else {
      mergedSensors[key] = briefValue;
    }
  }

  return { ...parsed, sensors: mergedSensors };
}

function defaultSpriteTypeDefaultsLoader(projectRoot?: string): (spriteType: string) => unknown {
  const root = projectRoot ?? process.cwd();
  return (spriteType: string): unknown => {
    const file = path.join(root, 'data', 'sprite-types', `${spriteType}.json`);
    if (!existsSync(file)) return null;
    const raw = readFileSync(file, 'utf8');
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `Sprite-type defaults at ${file} is not valid JSON: ${(err as Error).message}`,
        { cause: err },
      );
    }
  };
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
