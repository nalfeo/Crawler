/**
 * Brief loader.
 *
 * Reads a YAML brief from disk, parses it, validates against the Zod schema,
 * and resolves the palette `id` into actual `[r, g, b]` color triples loaded
 * from `data/palettes/<id>.json`.
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

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  briefSchema,
  type Brief,
  type PaletteColors,
  type RgbTriple,
} from './brief-schema.js';

export interface LoadedBrief {
  readonly brief: Brief;
  /** Resolved palette colors, from `data/palettes/<brief.palette.id>.json`. */
  readonly palette: PaletteColors;
  /** Absolute path the brief was loaded from — useful for diagnostics + retries. */
  readonly briefPath: string;
}

export interface LoadBriefOptions {
  /**
   * Project root for resolving `data/palettes/<id>.json`. Defaults to
   * `process.cwd()` which is correct when the CLI is invoked through
   * `npm run sprites:run` from the repo root.
   */
  readonly projectRoot?: string;
  /**
   * Override palette loading entirely — used by tests so they can avoid
   * hitting the disk. When supplied, this is called with the brief's palette
   * id and must return the resolved colors.
   */
  readonly loadPalette?: (paletteId: string) => PaletteColors;
}

export function loadBrief(briefPath: string, opts: LoadBriefOptions = {}): LoadedBrief {
  const absolute = path.resolve(briefPath);
  const raw = readFileSync(absolute, 'utf8');
  const parsed = parseYaml(raw) as unknown;
  const result = briefSchema.safeParse(parsed);
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
