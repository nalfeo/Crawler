/**
 * Vite plugin: Lab Tuning Save
 *
 * Exposes a dev-only POST endpoint that labs use to write tuning
 * values back to the JSON data files in src/shared/data/.
 *
 * POST /__save-tuning
 * Body: { "file": "tuning.json", "path": "player.speed", "value": 4.0 }
 *   or: { "file": "weapons.json", "id": "sword", "path": "baseDamage", "value": 20 }
 *   or: { "file": "tuning.json", "values": { "player.speed": 4.0, "damage.defaultContactDamage": 8 } }
 */
import { readFileSync, writeFileSync } from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import { resolve, relative, isAbsolute } from 'path';
import { spawn } from 'child_process';
import type { Plugin } from 'vite';
import { getSessionServerPorts } from '../scripts/shared/session-server-ports.js';
import {
  DEFAULT_CATALOG_PATH,
  runMetadataPipeline,
  resolveProvider,
  type MetadataProviderMode,
} from '../scripts/sprites/metadata-pipeline.js';
import { writeCatalogJson } from '../scripts/sprites/catalog-io.js';
import {
  ensureSentence,
  parseSpriteCatalog,
  type SpriteCatalogRecord,
} from '../src/shared/sprite-catalog.js';

const DATA_DIR = resolve(__dirname, '../src/shared/data');
const REPO_ROOT = resolve(__dirname, '..');
const GENERATED_MANIFEST_PATH = resolve(__dirname, '../public/assets/generated/manifest.json');
const SPRITE_SIDECAR_HEALTH_URL = `${
  getSessionServerPorts({
    cwd: REPO_ROOT,
    env: process.env,
  }).sidecarBaseUrl
}/api/health`;

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  if (keys.some((k) => DANGEROUS_KEYS.has(k))) {
    throw new Error(`Dangerous path segment in "${path}"`);
  }
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    if (typeof current[key] !== 'object' || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]!] = value;
}

function isInsideDataDir(filePath: string): boolean {
  const rel = relative(DATA_DIR, filePath);
  return !isAbsolute(rel) && !rel.startsWith('..');
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('::ffff:127.0.0.')
  );
}

function isLoopbackHostHeader(hostHeader: string | string[] | undefined): boolean {
  const raw = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  if (!raw) return false;
  const host = raw.split(':')[0]?.toLowerCase() ?? '';
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

function sortCatalog(records: SpriteCatalogRecord[]): SpriteCatalogRecord[] {
  const copy = [...records];
  copy.sort((a, b) => {
    const kindCmp = (a.kind === 'sheet' ? 0 : 1) - (b.kind === 'sheet' ? 0 : 1);
    if (kindCmp !== 0) return kindCmp;
    return a.id.localeCompare(b.id);
  });
  return copy;
}

async function isSpriteGalleryRunning(timeoutMs = 1200): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(SPRITE_SIDECAR_HEALTH_URL, {
      cache: 'no-store',
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

interface GeneratedManifestEntry {
  readonly briefId?: string;
  readonly spriteName?: string;
  readonly assetPath?: string;
}

function readGeneratedManifestEntry(id: string): GeneratedManifestEntry | null {
  if (!id.startsWith('generated:')) return null;
  const manifestKey = id.slice('generated:'.length);
  if (!manifestKey) return null;
  try {
    const manifest = JSON.parse(readFileSync(GENERATED_MANIFEST_PATH, 'utf-8')) as {
      entries?: Record<string, GeneratedManifestEntry>;
    };
    return manifest.entries?.[manifestKey] ?? null;
  } catch {
    return null;
  }
}

function buildGeneratedCatalogEntry(
  id: string,
  manifestEntry: GeneratedManifestEntry,
): SpriteCatalogRecord {
  const spriteName = manifestEntry.spriteName ?? id.slice('generated:'.length);
  const briefId = manifestEntry.briefId ?? spriteName;
  return {
    id,
    kind: 'sprite',
    label: spriteName,
    description: ensureSentence(`Generated sprite from brief: ${briefId}`),
    tags: ['generated', 'pipeline-approved'],
    spriteId: spriteName,
    sheetKey: 'generated-manifest',
    assetPath: manifestEntry.assetPath ?? `generated/${spriteName}.png`,
    frame: 0,
    col: 0,
    row: 0,
  };
}

export function labTuningSavePlugin(): Plugin {
  return {
    name: 'lab-tuning-save',
    apply: 'serve',
    configureServer(server) {
      const enforceLocalOnly = (req: IncomingMessage, res: ServerResponse): boolean => {
        const remoteAddress = req.socket.remoteAddress;
        if (!isLoopbackAddress(remoteAddress) || !isLoopbackHostHeader(req.headers.host)) {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: 'Repo writes are local-only.' }));
          return false;
        }
        return true;
      };

      server.middlewares.use('/__save-tuning', (req, res) => {
        if (!enforceLocalOnly(req, res)) {
          return;
        }

        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          try {
            const payload = JSON.parse(body) as {
              file: string;
              path?: string;
              id?: string;
              value?: unknown;
              values?: Record<string, unknown>;
            };

            const filePath = resolve(DATA_DIR, payload.file);

            // Security: only allow writing within data dir
            if (!isInsideDataDir(filePath)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: 'Path outside data directory' }));
              return;
            }

            const raw = readFileSync(filePath, 'utf-8');
            const data = JSON.parse(raw) as unknown;

            if (Array.isArray(data) && !payload.id) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'Array-based files require an "id" field' }));
              return;
            }

            if (Array.isArray(data) && payload.id) {
              // Array-based file (weapons.json): find by id and patch
              const item = (data as Record<string, unknown>[]).find((d) => d['id'] === payload.id);
              if (!item) {
                res.statusCode = 404;
                res.end(JSON.stringify({ error: `Item "${payload.id}" not found` }));
                return;
              }
              if (payload.values) {
                Object.assign(item, payload.values);
              } else if (payload.path !== undefined && payload.value !== undefined) {
                setNestedValue(item, payload.path, payload.value);
              }
            } else if (typeof data === 'object' && data !== null) {
              // Object-based file (tuning.json): set by path
              if (payload.values) {
                for (const [key, val] of Object.entries(payload.values)) {
                  setNestedValue(data as Record<string, unknown>, key, val);
                }
              } else if (payload.path !== undefined && payload.value !== undefined) {
                setNestedValue(data as Record<string, unknown>, payload.path, payload.value);
              }
            }

            writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, file: payload.file }));
          } catch (err) {
            res.statusCode = 400;
            res.end(
              JSON.stringify({
                error: err instanceof Error ? err.message : 'Unknown error',
              }),
            );
          }
        });
      });

      server.middlewares.use('/__sprite-gallery-start', (req, res) => {
        if (!enforceLocalOnly(req, res)) {
          return;
        }
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }
        void (async () => {
          res.setHeader('Content-Type', 'application/json');
          if (await isSpriteGalleryRunning()) {
            res.statusCode = 200;
            res.end(JSON.stringify({ ok: true, alreadyRunning: true }));
            return;
          }
          try {
            const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
            const child = spawn(npmCmd, ['run', 'sprites:gallery'], {
              cwd: REPO_ROOT,
              detached: true,
              stdio: 'ignore',
            });
            child.unref();
            res.statusCode = 202;
            res.end(JSON.stringify({ ok: true, started: true }));
          } catch (err) {
            res.statusCode = 500;
            res.end(
              JSON.stringify({
                error: 'Failed to start sprite gallery',
                detail: err instanceof Error ? err.message : String(err),
              }),
            );
          }
        })();
      });

      server.middlewares.use('/__sprite-catalog-add', (req, res) => {
        if (!enforceLocalOnly(req, res)) {
          return;
        }
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          try {
            const payload = JSON.parse(body) as { entries: unknown[] };
            if (!Array.isArray(payload.entries) || payload.entries.length === 0) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'Missing or empty "entries" array.' }));
              return;
            }

            const catalogPath = resolve(DATA_DIR, 'sprite-catalog.json');
            const raw = JSON.parse(readFileSync(catalogPath, 'utf-8'));
            const catalog = parseSpriteCatalog(raw);
            const existingIds = new Set(catalog.map((e: SpriteCatalogRecord) => e.id));
            const existingFrames = new Set(
              catalog
                .filter((e: SpriteCatalogRecord) => e.kind === 'sprite')
                .map((e: SpriteCatalogRecord) =>
                  e.kind === 'sprite' ? `${e.sheetKey}:${e.frame}` : '',
                ),
            );

            // Validate new entries and skip duplicates (including intra-request)
            const toAdd: SpriteCatalogRecord[] = [];
            const skipped: string[] = [];

            for (const entry of payload.entries) {
              const record = entry as Record<string, unknown>;
              const id = record['id'] as string;
              if (existingIds.has(id)) {
                skipped.push(id);
                continue;
              }
              const frameKey =
                record['kind'] === 'sprite' ? `${record['sheetKey']}:${record['frame']}` : '';
              if (frameKey && existingFrames.has(frameKey)) {
                skipped.push(id);
                continue;
              }
              // Update sets to prevent intra-request duplicates
              existingIds.add(id);
              if (frameKey) existingFrames.add(frameKey);
              toAdd.push(record as unknown as SpriteCatalogRecord);
            }

            if (toAdd.length === 0) {
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok: true, added: 0, skipped: skipped.length }));
              return;
            }

            const merged = sortCatalog([...catalog, ...toAdd]);

            // Validate full catalog and write atomically with Prettier formatting
            const validated = parseSpriteCatalog(merged);
            writeCatalogJson(catalogPath, validated);

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                ok: true,
                added: toAdd.length,
                skipped: skipped.length,
                addedIds: toAdd.map((e) => (e as Record<string, unknown>)['id']),
              }),
            );
          } catch (err) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                error: err instanceof Error ? err.message : 'Unknown error',
              }),
            );
          }
        });
      });

      server.middlewares.use('/__sprite-metadata-run', (req, res) => {
        if (!enforceLocalOnly(req, res)) {
          return;
        }
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on('end', async () => {
          try {
            const payload = JSON.parse(body) as {
              id: string;
              provider?: MetadataProviderMode;
              minScore?: number;
              force?: boolean;
              catalogPath?: string;
            };

            if (!payload.id || payload.id.trim() === '') {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'Missing required "id".' }));
              return;
            }

            const requestedPath = payload.catalogPath ?? DEFAULT_CATALOG_PATH;
            const absoluteCatalogPath = resolve(REPO_ROOT, requestedPath);
            if (!isInsideDataDir(absoluteCatalogPath)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: 'Catalog path outside data directory.' }));
              return;
            }

            const raw = JSON.parse(readFileSync(absoluteCatalogPath, 'utf-8'));
            let catalog = parseSpriteCatalog(raw);
            let existingEntry = catalog.find(
              (entry: SpriteCatalogRecord) => entry.id === payload.id,
            );
            if (!existingEntry) {
              const generatedManifestEntry = readGeneratedManifestEntry(payload.id);
              if (generatedManifestEntry) {
                const hydrated = buildGeneratedCatalogEntry(payload.id, generatedManifestEntry);
                const merged = sortCatalog([
                  ...catalog.filter((entry: SpriteCatalogRecord) => entry.id !== payload.id),
                  hydrated,
                ]);
                catalog = parseSpriteCatalog(merged);
                writeCatalogJson(absoluteCatalogPath, catalog);
                existingEntry = hydrated;
              }
            }
            if (!existingEntry) {
              res.statusCode = 404;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: `Catalog entry "${payload.id}" not found.` }));
              return;
            }
            const provider = await resolveProvider(payload.provider ?? 'auto');
            const result = await runMetadataPipeline(catalog, {
              provider,
              ids: [payload.id],
              force: payload.force ?? true,
              minScore: payload.minScore,
            });
            writeCatalogJson(absoluteCatalogPath, result.updated);

            const updatedEntry = result.updated.find(
              (entry: SpriteCatalogRecord) => entry.id === payload.id,
            );
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                ok: true,
                provider: provider.name,
                changedCount: result.changedCount,
                processedCount: result.processedCount,
                rejectedCount: result.rejectedCount,
                skippedCount: result.skippedCount,
                entry: updatedEntry,
              }),
            );
          } catch (err) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                error: err instanceof Error ? err.message : 'Unknown error',
              }),
            );
          }
        });
      });
    },
  };
}
