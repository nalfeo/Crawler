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
import { resolve } from 'path';
import type { Plugin } from 'vite';

const DATA_DIR = resolve(__dirname, '../src/shared/data');

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
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

export function labTuningSavePlugin(): Plugin {
  return {
    name: 'lab-tuning-save',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__save-tuning', (req, res) => {
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
            if (!filePath.startsWith(DATA_DIR)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: 'Path outside data directory' }));
              return;
            }

            const raw = readFileSync(filePath, 'utf-8');
            const data = JSON.parse(raw) as unknown;

            if (Array.isArray(data) && payload.id) {
              // Array-based file (weapons.json): find by id and patch
              const item = (data as Record<string, unknown>[]).find(
                (d) => d['id'] === payload.id,
              );
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
    },
  };
}
