/**
 * registry-ids.mjs — source the sprite-registry + item-catalog id SETS a plain
 * node canvas extension needs for the backlog's integration column.
 *
 * The monolith reads these from the Vite bundle:
 *   `spriteRegistryIds = new Set(SPRITES.map((s) => s.id))`
 *   `itemCatalogIds    = new Set(ITEM_CATALOG.map((i) => i.id))`
 * (see `src/devtools-main.ts`). SPRITES + ITEM_CATALOG are pure TypeScript data
 * modules — a plain node .mjs cannot `import` a `.ts`, so we transpile the two
 * source files with esbuild (a guaranteed repo dependency) and import the
 * emitted ESM via a `data:` URL. Both files are self-contained data:
 *   - `src/engine/sprites/registry.ts` — its ONLY import is `import type
 *     { SpriteAnchor }`, which esbuild erases → no runtime imports remain.
 *   - `src/shared/items.ts`            — no imports at all.
 * so a source-to-source `transform` (no bundling, no import resolution) is
 * sufficient and standalone.
 *
 * This is best-effort: ANY failure (esbuild missing, transform error, unexpected
 * shape) degrades to `{ spriteIds: null, itemIds: null, error }` so the backlog's
 * integration column shows an HONEST "unverified" state instead of fabricating
 * parity. It never throws.
 *
 * @module workflow/registry-ids
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRepoRequire } from '../../shared/node-modules-resolver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// lib -> workflow -> extensions -> .github -> repo root
const _repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const _require = createRepoRequire(_repoRoot, import.meta.url);

/**
 * Transpile one TS data module and pull a top-level exported array's `id` field
 * into a Set. Returns `null` on any failure (caller decides how to degrade).
 *
 * @param {string} absFile   absolute path to the .ts source
 * @param {string} exportName  the exported array (e.g. 'SPRITES')
 * @returns {Promise<Set<string> | null>}
 */
async function loadIdSet(absFile, exportName) {
  // Use createRepoRequire so this works in git worktrees where node_modules
  // lives in the main checkout, not in the worktree directory.
  const esbuild = _require('esbuild');
  const source = await readFile(absFile, 'utf8');
  const { code } = await esbuild.transform(source, {
    loader: 'ts',
    format: 'esm',
    // Keep it a pure syntax transform: no minify, no define, no bundling.
  });
  const url = `data:text/javascript,${encodeURIComponent(code)}`;
  const mod = await import(url);
  const arr = mod[exportName];
  if (!Array.isArray(arr)) return null;
  const ids = new Set();
  for (const entry of arr) {
    if (entry && typeof entry.id === 'string' && entry.id.length > 0) {
      ids.add(entry.id);
    }
  }
  return ids;
}

/**
 * Load the sprite-registry + item-catalog id sets from the repo's TS sources.
 * Never throws.
 *
 * @param {string} repoRoot  absolute repo root (the checkout the extension lives in)
 * @returns {Promise<{ spriteIds: Set<string> | null, itemIds: Set<string> | null, error: string | null }>}
 */
export async function loadRegistryIds(repoRoot) {
  try {
    const spriteIds = await loadIdSet(
      path.join(repoRoot, 'src', 'engine', 'sprites', 'registry.ts'),
      'SPRITES',
    );
    const itemIds = await loadIdSet(
      path.join(repoRoot, 'src', 'shared', 'items.ts'),
      'ITEM_CATALOG',
    );
    if (!spriteIds || !itemIds) {
      return {
        spriteIds: null,
        itemIds: null,
        error: 'registry/catalog transform returned an unexpected shape',
      };
    }
    return { spriteIds, itemIds, error: null };
  } catch (err) {
    return { spriteIds: null, itemIds: null, error: String(err?.message ?? err) };
  }
}
