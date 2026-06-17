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
const KENNEY_RELATIVE = 'public/assets/kenney';
/**
 * Curated notes per known pack id. Update when a new Kenney pack is
 * added — the model leans heavily on these to pick the right
 * reference for a given subject. Unknown packs still appear in the
 * catalog with a generic note; better to surface them than to drop
 * them silently.
 */
const PACK_NOTES = {
  'roguelike-characters':
    'Top-down roguelike humanoid + creature characters from legacy 16x16 source sheets; use for biped silhouettes, robes, armored figures.',
  'roguelike-rpg-pack':
    'Top-down RPG weapons + items + props from legacy 16x16 source sheets; primary anchor for swords, axes, maces, staffs, bows, shields.',
  'tiny-battle':
    'Hand-weapons + soldiers + small props from legacy 16x16 sheets; secondary palette and pose anchor for melee weapons.',
  'tiny-dungeon':
    'Dungeon items, weapons, monsters, and environment props from legacy 16x16 sheets; use for traps, keys, doors, slimes, rats, small enemies.',
  'tiny-ski':
    'Winter-themed characters and props from legacy 16x16 sheets; niche — use only for snow / ski subjects.',
  'tiny-town':
    'Town buildings, civilians, signs, and foliage from legacy 16x16 sheets; use for non-combat props, shopkeepers, decorative items.',
};
const GENERIC_PACK_NOTE =
  'Kenney pack (legacy 16x16 source sheet) — contents not specifically curated; pick only if the subject clearly matches the pack name.';
export function buildReferenceCatalog(options) {
  const kenneyRoot = path.join(options.repoRoot, KENNEY_RELATIVE);
  const readPacks = options.readPacks ?? defaultReadPacks;
  const fileExists = options.fileExists ?? defaultFileExists;
  const packs = [...readPacks(kenneyRoot)].sort();
  const catalog = [];
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
export function resolveReferenceId(catalog, id) {
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
export function formatCatalogForPrompt(catalog) {
  return catalog.map((entry) => `- ${entry.id}: ${entry.note}`).join('\n');
}
function isSafePackId(id) {
  // Mirror the brief-name regex (lowercase kebab-case) so a pack
  // directory accidentally named with `..` or path separators can
  // never enter the catalog.
  return /^[a-z0-9][a-z0-9-]*$/.test(id);
}
function defaultReadPacks(kenneyRoot) {
  let entries;
  try {
    entries = readdirSync(kenneyRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    const code = err.code;
    if (code === 'ENOENT') return [];
    throw err;
  }
  return entries;
}
function defaultFileExists(absolutePath) {
  try {
    return statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}
//# sourceMappingURL=reference-allow-list.js.map
