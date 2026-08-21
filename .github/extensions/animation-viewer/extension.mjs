// Extension: animation-viewer
// Slices a sprite sheet into individual frames and plays them back as a
// looping animation. Also renders each frame side-by-side and the full sheet.
//
// open_canvas input: { sheetPath?, rows?, cols?, frameRate?, name?, outputW?, outputH? }
// With no input the canvas opens on the available-animation selector.
// Actions: load_sheet — swap the sheet in an open instance

import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

import { createCanvas, joinSession } from '@github/copilot-sdk/extension';

import {
  MAX_FRAME_RATE,
  MAX_GRID_DIMENSION,
  MAX_OUTPUT_DIMENSION,
  buildAnimationCatalog,
  normalizeSheetFields,
} from './catalog.mjs';
import { renderHtml } from './renderer.mjs';

const servers = new Map(); // instanceId → { server, url, state }

const SHEET_NUMERIC_PROPERTIES = {
  rows: {
    type: 'integer',
    minimum: 1,
    maximum: MAX_GRID_DIMENSION,
    description: 'Rows in the sheet grid',
  },
  cols: {
    type: 'integer',
    minimum: 1,
    maximum: MAX_GRID_DIMENSION,
    description: 'Columns in the sheet grid',
  },
  frameRate: {
    type: 'number',
    exclusiveMinimum: 0,
    maximum: MAX_FRAME_RATE,
    description: 'Playback frame rate (fps)',
  },
  outputW: {
    type: 'integer',
    minimum: 1,
    maximum: MAX_OUTPUT_DIMENSION,
    description: 'Per-frame display width in px (default 128)',
  },
  outputH: {
    type: 'integer',
    minimum: 1,
    maximum: MAX_OUTPUT_DIMENSION,
    description: 'Per-frame display height in px (default 128)',
  },
};

function loadSheet(sheetPath, repoRoot) {
  const resolved = repoRoot ? path.resolve(repoRoot, sheetPath) : path.resolve(sheetPath);
  if (!existsSync(resolved)) throw new Error(`Sheet not found: ${resolved}`);
  return readFileSync(resolved).toString('base64');
}

async function startServer(instanceId, state, catalog) {
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const requestedIndex = requestUrl.searchParams.get('animation');
    let requestState = servers.get(instanceId)?.state ?? state;

    if (requestedIndex !== null) {
      const animationIndex = Number(requestedIndex);
      if (!Number.isInteger(animationIndex) || !catalog[animationIndex]) {
        res.statusCode = 400;
        res.end('Unknown animation selection');
        return;
      }
      const selected = catalog[animationIndex];
      try {
        requestState = {
          ...requestState,
          ...selected,
          name: selected.label,
          sheetB64: loadSheet(selected.sheetPath, requestState.repoRoot),
        };
      } catch {
        res.statusCode = 404;
        res.end('Selected animation sheet is no longer available');
        return;
      }
      const entry = servers.get(instanceId);
      if (entry) entry.state = requestState;
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(renderHtml(requestState, catalog));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { server, url: `http://127.0.0.1:${port}/`, state };
}

await joinSession({
  canvases: [
    createCanvas({
      id: 'animation-viewer',
      displayName: 'Animation Viewer',
      description:
        'Slices a sprite sheet into frames and plays a looping animation preview. ' +
        'Open with no input to pick from the approved generated animations, or pass ' +
        'sheetPath (absolute or relative to cwd), rows, cols, and frameRate.',
      inputSchema: {
        type: 'object',
        properties: {
          sheetPath: { type: 'string', description: 'Absolute path or path relative to cwd' },
          name: { type: 'string', description: 'Display name shown in the canvas header' },
          ...SHEET_NUMERIC_PROPERTIES,
        },
      },
      actions: [
        {
          name: 'load_sheet',
          description: 'Swap the sheet displayed in an open animation-viewer canvas',
          inputSchema: {
            type: 'object',
            properties: {
              sheetPath: { type: 'string' },
              name: { type: 'string' },
              ...SHEET_NUMERIC_PROPERTIES,
            },
            required: ['sheetPath'],
          },
          handler: async (ctx) => {
            const entry = servers.get(ctx.instanceId);
            if (!entry) return { ok: false, error: 'Canvas not open' };
            const input = ctx.input ?? {};
            if (typeof input.sheetPath !== 'string' || input.sheetPath.length === 0) {
              return { ok: false, error: 'sheetPath is required' };
            }
            const normalized = normalizeSheetFields(input, entry.state);
            if (!normalized.ok) return { ok: false, error: normalized.error };
            try {
              const sheetB64 = loadSheet(input.sheetPath, entry.state.repoRoot);
              entry.state = {
                ...entry.state,
                ...normalized.value,
                sheetB64,
                sheetPath: input.sheetPath,
                name: input.name ?? entry.state.name,
              };
              return { ok: true, url: entry.url };
            } catch (e) {
              return { ok: false, error: e.message };
            }
          },
        },
      ],
      open: async (ctx) => {
        const input = ctx.input ?? {};
        const repoRoot = process.cwd();
        const catalog = buildAnimationCatalog(repoRoot);
        const normalized = normalizeSheetFields(input);
        if (!normalized.ok) throw new Error(normalized.error);

        let sheetB64 = null;
        if (typeof input.sheetPath === 'string' && input.sheetPath.length > 0) {
          try {
            sheetB64 = loadSheet(input.sheetPath, repoRoot);
          } catch {
            /* show empty state */
          }
        }
        const name = input.name ?? 'Animation Viewer';
        const state = {
          ...normalized.value,
          sheetB64,
          sheetPath: input.sheetPath,
          repoRoot,
          name,
        };
        let entry = servers.get(ctx.instanceId);
        if (!entry) {
          entry = await startServer(ctx.instanceId, state, catalog);
          servers.set(ctx.instanceId, entry);
        } else {
          entry.state = state;
        }
        return { title: name, url: entry.url };
      },
      onClose: async (ctx) => {
        const entry = servers.get(ctx.instanceId);
        if (entry) {
          servers.delete(ctx.instanceId);
          await new Promise((resolve) => entry.server.close(() => resolve()));
        }
      },
    }),
  ],
});
