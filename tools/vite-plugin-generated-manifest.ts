/**
 * Vite plugin: compose the aggregate generated-sprite manifest from shards.
 *
 * The committed source of truth is the per-asset shard tree under
 * `public/assets/generated/entries/`. The aggregate
 * `public/assets/generated/manifest.json` that the browser fetches at runtime
 * (see `src/engine/generatedAssets/preload.ts`) is a BUILD ARTIFACT, gitignored
 * so parallel art check-ins never touch a shared file.
 *
 * This plugin keeps the aggregate present for both dev and build:
 *   - `configureServer` / `buildStart` write the on-disk aggregate from the
 *     shards, so Vite's normal `publicDir` copy ships it to `dist/` and the dev
 *     server can serve it as a static file.
 *   - A dev middleware recomposes the aggregate on each request for the
 *     manifest URL, so editing a shard is reflected without a manual rebuild.
 */
import type { Plugin, ViteDevServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  composeManifestFromShards,
  serializeManifest,
} from '../scripts/sprites/generated-shards.js';
import { mkdirSync, writeFileSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const GENERATED_DIR = path.join(repoRoot, 'public', 'assets', 'generated');
const MANIFEST_PATH = path.join(GENERATED_DIR, 'manifest.json');
const MANIFEST_URL_SUFFIX = '/assets/generated/manifest.json';

function writeAggregate(): void {
  mkdirSync(GENERATED_DIR, { recursive: true });
  writeFileSync(MANIFEST_PATH, serializeManifest(composeManifestFromShards(GENERATED_DIR)));
}

export function generatedManifestPlugin(): Plugin {
  return {
    name: 'crawler-generated-manifest',
    // Ensure the aggregate exists on disk before the production publicDir copy.
    buildStart() {
      writeAggregate();
    },
    configureServer(server: ViteDevServer) {
      // Seed the on-disk aggregate so static serving works immediately.
      writeAggregate();
      // Recompose on demand so a freshly written shard is reflected live.
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        const pathname = url.split('?')[0] ?? '';
        if (!pathname.endsWith(MANIFEST_URL_SUFFIX)) {
          next();
          return;
        }
        try {
          const body = serializeManifest(composeManifestFromShards(GENERATED_DIR));
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(body);
        } catch (err) {
          next(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
  };
}
