/**
 * Reference spritesheet allow-list.
 *
 * The brief synthesizer (`scripts/sprites/synthesize-brief.ts`) lets an
 * LLM pick reference sprite-sheets that ground the generation call's
 * style + silhouette. Letting the model name raw filesystem paths is
 * unsafe — it would invent paths that don't exist on disk, point
 * outside the repo, or smuggle path-traversal segments. This module
 * is the only place that resolves a stable *id* into a real file path.
 *
 * Behaviour:
 *   - Discover all `public/assets/kenney/<pack>/spritesheet.png` files
 *     on disk. The pack-directory name becomes the stable id.
 *   - Attach a hand-curated one-line note per known pack describing
 *     what it contains, so the LLM can match the right pack to the
 *     subject. Unknown packs fall back to a generic note rather than
 *     dropping out of the catalog.
 *   - Expose `resolveReferenceId(id)` which returns the validated
 *     repo-relative path or throws if the id is not in the catalog.
 *
 * The module is pure given (`repoRoot`, `readdir`-style hook) so unit
 * tests build catalogs without touching real disk.
 */

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export interface ReferenceSheet {
  /** Stable id — the pack directory name (e.g. `tiny-dungeon`). */
  readonly id: string;
  /** Repo-relative path to the spritesheet PNG (forward slashes). */
  readonly path: string;
  /** One-line note describing the pack's contents. */
  readonly note: string;
}

export interface BuildReferenceCatalogOptions {
  readonly repoRoot: string;
  /**
   * Override the directory enumerator. Tests pass a fake to avoid
   * touching disk. The fake receives the absolute path to
   * `public/assets/kenney`.
   */
  readonly readPacks?: (kenneyRoot: string) => ReadonlyArray<string>;
  /**
   * Override the per-file existence check. Tests use this to assert
   * the existence guard fires when a directory entry's
   * `spritesheet.png` is missing.
   */
  readonly fileExists?: (absolutePath: string) => boolean;
}

const KENNEY_RELATIVE = 'public/assets/kenney';

/**
 * Curated notes per known pack id. Update when a new Kenney pack is
 * added — the model leans heavily on these to pick the right
 * reference for a given subject. Unknown packs still appear in the
 * catalog with a generic note; better to surface them than to drop
 * them silently.
 */
const PACK_NOTES: Readonly<Record<string, string>> = {
  'roguelike-characters':
    'Top-down 16x16 roguelike humanoid + creature characters; use for biped silhouettes, robes, armored figures.',
  'roguelike-rpg-pack':
    'Top-down 16x16 RPG weapons + items + props; primary anchor for swords, axes, maces, staffs, bows, shields.',
  'tiny-battle':
    '16x16 hand-weapons + soldiers + small props; secondary palette and pose anchor for melee weapons.',
  'tiny-dungeon':
    '16x16 dungeon items, weapons, monsters, environment props; use for traps, keys, doors, slimes, rats, small enemies.',
  'tiny-ski':
    '16x16 winter-themed characters and props; niche — use only for snow / ski subjects.',
  'tiny-town':
    '16x16 town buildings, civilians, signs, foliage; use for non-combat props, shopkeepers, decorative items.',
};

const GENERIC_PACK_NOTE =
  '16x16 Kenney pack — contents not specifically curated; pick only if the subject clearly matches the pack name.';

export function buildReferenceCatalog(
  options: BuildReferenceCatalogOptions,
): ReadonlyArray<ReferenceSheet> {
  const kenneyRoot = path.join(options.repoRoot, KENNEY_RELATIVE);
  const readPacks = options.readPacks ?? defaultReadPacks;
  const fileExists = options.fileExists ?? defaultFileExists;

  const packs = [...readPacks(kenneyRoot)].sort();
  const catalog: ReferenceSheet[] = [];
  for (const id of packs) {
    if (!isSafePackId(id)) continue;
    const absolute = path.join(kenneyRoot, id, 'spritesheet.png');
    if (!fileExists(absolute)) continue;
    const relPath = `${KENNEY_RELATIVE}/${id}/spritesheet.png`;
    catalog.push({
      id,
      path: relPath,
      note: PACK_NOTES[id] ?? GENERIC_PACK_NOTE,
    });
  }
  if (catalog.length === 0) {
    throw new Error(
      `Reference catalog is empty — no spritesheets discovered under ${kenneyRoot}. ` +
        `Check that the Kenney asset directory exists and contains at least one ` +
        `<pack>/spritesheet.png file. The synthesizer requires references to ground ` +
        `generation; refusing to run without any.`,
    );
  }
  return catalog;
}

/**
 * Resolve a model-supplied reference id into a validated repo-relative
 * path. Throws if the id is not in the catalog. Used both at
 * validation time (synthesize-brief) and as the single mapping point
 * from "what the LLM said" → "what we write into YAML".
 */
export function resolveReferenceId(
  catalog: ReadonlyArray<ReferenceSheet>,
  id: string,
): ReferenceSheet {
  const match = catalog.find((entry) => entry.id === id);
  if (!match) {
    const known = catalog.map((entry) => entry.id).join(', ') || '<empty>';
    throw new Error(
      `Reference id '${id}' is not in the allow-list. Known ids: ${known}. ` +
        `The synthesizer refuses to invent reference paths; pick from the catalog.`,
    );
  }
  return match;
}

/**
 * Format the catalog as a short list block suitable for embedding in
 * the LLM system prompt. Stable formatting helps the prompt hash.
 */
export function formatCatalogForPrompt(catalog: ReadonlyArray<ReferenceSheet>): string {
  return catalog.map((entry) => `- ${entry.id}: ${entry.note}`).join('\n');
}

function isSafePackId(id: string): boolean {
  // Mirror the brief-name regex (lowercase kebab-case) so a pack
  // directory accidentally named with `..` or path separators can
  // never enter the catalog.
  return /^[a-z0-9][a-z0-9-]*$/.test(id);
}

function defaultReadPacks(kenneyRoot: string): ReadonlyArray<string> {
  let entries: string[];
  try {
    entries = readdirSync(kenneyRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw err;
  }
  return entries;
}

function defaultFileExists(absolutePath: string): boolean {
  try {
    return statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}
