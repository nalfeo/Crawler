// animation-viewer catalog + input validation helpers.
//
// Kept separate from extension.mjs so the pure logic can be unit tested with
// `node --test` (see tests/catalog.test.mjs).

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** Largest accepted grid dimension (rows / cols). */
export const MAX_GRID_DIMENSION = 512;
/** Largest accepted per-frame output dimension in px. */
export const MAX_OUTPUT_DIMENSION = 2048;
/** Largest accepted playback frame rate in fps. */
export const MAX_FRAME_RATE = 120;

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {boolean}
 */
export function isPositiveInteger(value, max) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPositiveFrameRate(value) {
  return (
    typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_FRAME_RATE
  );
}

const FIELD_RULES = [
  { key: 'rows', check: (v) => isPositiveInteger(v, MAX_GRID_DIMENSION), max: MAX_GRID_DIMENSION },
  { key: 'cols', check: (v) => isPositiveInteger(v, MAX_GRID_DIMENSION), max: MAX_GRID_DIMENSION },
  {
    key: 'outputW',
    check: (v) => isPositiveInteger(v, MAX_OUTPUT_DIMENSION),
    max: MAX_OUTPUT_DIMENSION,
  },
  {
    key: 'outputH',
    check: (v) => isPositiveInteger(v, MAX_OUTPUT_DIMENSION),
    max: MAX_OUTPUT_DIMENSION,
  },
];

/**
 * Merge caller-supplied sheet fields over defaults and validate every numeric
 * contract. Rejects zero, negative, fractional and oversized values so the
 * renderer never emits a modulo-zero animation loop or an unbounded canvas.
 *
 * @param {Record<string, unknown>} [input]
 * @param {Record<string, unknown>} [defaults]
 * @returns {{ ok: true, value: { rows: number, cols: number, frameRate: number, outputW: number, outputH: number } } | { ok: false, error: string }}
 */
export function normalizeSheetFields(input = {}, defaults = {}) {
  const pick = (key, fallback) => input[key] ?? defaults[key] ?? fallback;
  const value = {
    rows: pick('rows', 1),
    cols: pick('cols', 1),
    frameRate: pick('frameRate', 8),
    outputW: pick('outputW', 128),
    outputH: pick('outputH', 128),
  };

  for (const rule of FIELD_RULES) {
    if (!rule.check(value[rule.key])) {
      return {
        ok: false,
        error: `${rule.key} must be an integer between 1 and ${rule.max} (got ${String(value[rule.key])})`,
      };
    }
  }
  if (!isPositiveFrameRate(value.frameRate)) {
    return {
      ok: false,
      error: `frameRate must be greater than 0 and at most ${MAX_FRAME_RATE} (got ${String(value.frameRate)})`,
    };
  }

  return { ok: true, value };
}

/**
 * Convert one approved generated-animation entry into a catalog row.
 * Returns null when the entry does not describe a usable animation.
 *
 * @param {unknown} entry
 * @param {string} repoRoot
 * @param {string} fallbackLabel
 * @param {(candidate: string) => boolean} [sheetExists]
 * @returns {{ label: string, sheetPath: string, rows: number, cols: number, frameRate: number, outputW: number, outputH: number } | null}
 */
export function toCatalogEntry(entry, repoRoot, fallbackLabel, sheetExists = existsSync) {
  if (!entry || typeof entry !== 'object') return null;
  const animation = entry.animation;
  if (!animation || typeof animation !== 'object') return null;
  if (typeof entry.assetPath !== 'string' || entry.assetPath.length === 0) return null;

  const normalized = normalizeSheetFields({
    rows: 1,
    cols: animation.frameCount,
    frameRate: animation.frameRate,
    outputW: animation.frameWidth,
    outputH: animation.frameHeight,
  });
  if (!normalized.ok) return null;

  const sheetPath = path.resolve(repoRoot, 'public/assets', entry.assetPath);
  const generatedRoot = path.resolve(repoRoot, 'public/assets/generated') + path.sep;
  if (!sheetPath.startsWith(generatedRoot) || !sheetExists(sheetPath)) return null;

  const label =
    typeof entry.spriteName === 'string' && entry.spriteName.length > 0
      ? entry.spriteName
      : typeof entry.briefId === 'string' && entry.briefId.length > 0
        ? entry.briefId
        : fallbackLabel;

  return {
    label,
    sheetPath: path.relative(repoRoot, sheetPath),
    ...normalized.value,
  };
}

/**
 * Scan approved generated animation entries and build the selector catalog.
 *
 * @param {string} repoRoot
 * @returns {Array<{ label: string, sheetPath: string, rows: number, cols: number, frameRate: number, outputW: number, outputH: number }>}
 */
export function buildAnimationCatalog(repoRoot) {
  const entriesRoot = path.resolve(repoRoot, 'public/assets/generated/entries');
  if (!existsSync(entriesRoot)) return [];

  return readdirSync(entriesRoot)
    .filter((filename) => filename.endsWith('.json'))
    .flatMap((filename) => {
      const entryPath = path.join(entriesRoot, filename);
      try {
        const entry = JSON.parse(readFileSync(entryPath, 'utf8'));
        const catalogEntry = toCatalogEntry(entry, repoRoot, filename.replace(/\.json$/, ''));
        return catalogEntry ? [catalogEntry] : [];
      } catch (error) {
        console.warn(`Skipping invalid animation entry ${entryPath}:`, error);
        return [];
      }
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}
