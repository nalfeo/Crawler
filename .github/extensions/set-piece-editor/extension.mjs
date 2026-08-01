// Extension: set-piece-editor
// Visual drag-and-drop set-piece layout editor.
// Three-column layout: Scene Layers | Canvas | Inspector
// Features: scene org layers, real Kenney sprite rendering,
//   snap modes (tile / half-tile / free), zoom-to-fit, Apply to repo.

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { joinSession, createCanvas, CanvasError } from '@github/copilot-sdk/extension';
import { validateSetPieceCandidate } from './lib/editor-validators.mjs';
import { buildArtRequestIssue } from './lib/art-request.mjs';

const __extDir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__extDir, '..', '..', '..');
const CANONICAL_NPC_TYPE_IDS = [
  'tutorial-goon',
  'shopkeeper',
  'floor2-defector',
  'spell-quest-giver',
  'the-broker',
  'shop-the-fence',
  'shop-the-apothecary',
  'shop-the-quartermaster',
  'shop-the-resource-broker',
];

const SHEET_PATHS = {
  'kenney-tiny-dungeon': join(REPO_ROOT, 'public/assets/kenney/tiny-dungeon/spritesheet.png'),
  'kenney-tiny-town': join(REPO_ROOT, 'public/assets/kenney/tiny-town/spritesheet.png'),
  'kenney-tiny-battle': join(REPO_ROOT, 'public/assets/kenney/tiny-battle/spritesheet.png'),
  'kenney-tiny-ski': join(REPO_ROOT, 'public/assets/kenney/tiny-ski/spritesheet.png'),
  'kenney-roguelike-rpg-pack': join(
    REPO_ROOT,
    'public/assets/kenney/roguelike-rpg-pack/spritesheet.png',
  ),
  'kenney-roguelike-characters': join(
    REPO_ROOT,
    'public/assets/kenney/roguelike-characters/spritesheet.png',
  ),
  'custom-pixel-sprites': join(REPO_ROOT, 'public/assets/generated/custom-pixel-sprites.png'),
};

function getSetPiecesPath() {
  return join(REPO_ROOT, 'src', 'shared', 'data', 'set-pieces.json');
}
function getGeneratedShardsDir() {
  return join(REPO_ROOT, 'public', 'assets', 'generated', 'entries');
}
// The aggregate manifest.json is a gitignored build artifact; the committed
// per-asset shards under entries/ are the source of truth. Walk them to recover
// the manifest keys (the POSIX shard path minus `.json`).
function listShardKeys(dir, rel = '') {
  const out = [];
  let dirents;
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const dirent of dirents) {
    const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) {
      out.push(...listShardKeys(join(dir, dirent.name), childRel));
    } else if (dirent.isFile() && dirent.name.toLowerCase().endsWith('.json')) {
      out.push(childRel.slice(0, -'.json'.length));
    }
  }
  return out;
}
function getSubstratePath() {
  return join(REPO_ROOT, 'src', 'shared', 'data', 'set-piece-substrate.json');
}
function getNpcSpriteMapPath() {
  return join(REPO_ROOT, 'src', 'shared', 'data', 'npc-sprite-map.json');
}
function readGeneratedSpriteIds() {
  const keys = listShardKeys(getGeneratedShardsDir());
  if (keys.length > 0) {
    return keys.sort();
  }
  try {
    const generatedDir = join(REPO_ROOT, 'public', 'assets', 'generated');
    return readdirSync(generatedDir)
      .filter((name) => name.toLowerCase().endsWith('.png'))
      .map((name) => name.slice(0, -4))
      .filter((name) => name !== 'custom-pixel-sprites')
      .sort();
  } catch {
    return [];
  }
}
function readPack() {
  return JSON.parse(readFileSync(getSetPiecesPath(), 'utf-8'));
}
function writePack(pack) {
  writeFileSync(getSetPiecesPath(), JSON.stringify(pack, null, 2) + '\n', 'utf-8');
}

const sseClients = new Map();
function broadcastToInstance(instanceId, data) {
  const clients = sseClients.get(instanceId);
  if (!clients) return;
  const msg = 'data: ' + JSON.stringify(data) + '\n\n';
  for (const res of [...clients]) {
    try {
      res.write(msg);
    } catch {
      clients.delete(res);
    }
  }
}

function isLoopbackHostHeader(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader.trim() === '') return false;
  try {
    var u = new URL('http://' + hostHeader.trim());
    var h = (u.hostname || '').toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
  } catch {
    return false;
  }
}

function handleRequest(instanceId, allowedOrigin, req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const hostHeader = req.headers.host;
  const expectedOrigin = allowedOrigin;
  const applyToken = applyTokens.get(instanceId);
  const requestHostAllowed = isLoopbackHostHeader(hostHeader);

  if (req.method === 'GET' && url.pathname === '/') {
    if (!requestHostAllowed) {
      res.writeHead(403);
      res.end('Forbidden host');
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(renderHtml(applyToken ?? ''));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/data') {
    try {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(readPack()));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/npc-sprites') {
    try {
      res.setHeader('Content-Type', 'application/json');
      res.end(readFileSync(getNpcSpriteMapPath(), 'utf-8'));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/substrate') {
    // The carved terrain a set piece sits on (room floor + wall ring). It is NOT
    // in the set-piece def - map generation writes those tiles - so the editor
    // has to be told, or it previews props against a background the game never
    // draws. Served from the same JSON the lab fidelity test pins against
    // `tile-visuals.ts`, so this cannot drift into a private fourth copy.
    try {
      res.setHeader('Content-Type', 'application/json');
      res.end(readFileSync(getSubstratePath(), 'utf-8'));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/generated-index') {
    try {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(readGeneratedSpriteIds()));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
    return;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/sheet/')) {
    const key = decodeURIComponent(url.pathname.slice(7));
    const fp = SHEET_PATHS[key];
    if (fp && existsSync(fp)) {
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public,max-age=86400');
      res.end(readFileSync(fp));
    } else {
      res.writeHead(404);
      res.end('Sheet not found: ' + key);
    }
    return;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/generated/')) {
    const name = decodeURIComponent(url.pathname.slice(11));
    if (
      name.includes('..') ||
      name.includes('/') ||
      name.includes('\\') ||
      !name.endsWith('.png')
    ) {
      res.writeHead(400);
      res.end('Bad');
      return;
    }
    const fp = join(REPO_ROOT, 'public/assets/generated', name);
    if (existsSync(fp)) {
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public,max-age=3600');
      res.end(readFileSync(fp));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/apply') {
    if (!applyToken || req.headers['x-set-piece-editor-token'] !== applyToken) {
      res.writeHead(403);
      res.end(JSON.stringify({ ok: false, error: 'Missing or invalid apply token' }));
      return;
    }
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || origin !== expectedOrigin) {
      res.writeHead(403);
      res.end(JSON.stringify({ ok: false, error: 'Forbidden origin' }));
      return;
    }
    const MAX_APPLY_BODY_BYTES = 1024 * 1024;
    let body = '';
    let totalBytes = 0;
    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_APPLY_BODY_BYTES) {
        res.writeHead(413);
        res.end(JSON.stringify({ ok: false, error: 'Payload too large' }));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      try {
        const { setPieceId, props, sceneLayers, npcs, width, height } = JSON.parse(body);
        const pack = readPack();
        const idx = pack.setPieces.findIndex((s) => s.id === setPieceId);
        if (idx === -1) {
          res.writeHead(404);
          res.end(JSON.stringify({ ok: false, error: 'Not found' }));
          return;
        }
        const candidate = { ...pack.setPieces[idx], props };
        if (sceneLayers !== undefined) candidate.sceneLayers = sceneLayers;
        if (npcs !== undefined) candidate.npcs = npcs;
        if (width > 0) candidate.width = width;
        if (height > 0) candidate.height = height;
        const issues = validateSetPieceCandidate(candidate, {
          knownNpcTypeIds: CANONICAL_NPC_TYPE_IDS,
        });
        if (issues.length > 0) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: 'Validation failed', issues }));
          return;
        }
        pack.setPieces[idx] = candidate;
        writePack(pack);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
        broadcastToInstance(instanceId, { type: 'applied', setPieceId });
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      }
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/art-request') {
    // Same token + origin gate as /apply: this shells out to `gh` and creates a
    // real GitHub issue, so it must not be reachable from another origin.
    if (!applyToken || req.headers['x-set-piece-editor-token'] !== applyToken) {
      res.writeHead(403);
      res.end(JSON.stringify({ ok: false, error: 'Missing or invalid apply token' }));
      return;
    }
    const artOrigin = req.headers.origin;
    if (typeof artOrigin !== 'string' || artOrigin !== expectedOrigin) {
      res.writeHead(403);
      res.end(JSON.stringify({ ok: false, error: 'Forbidden origin' }));
      return;
    }
    let artBody = '';
    let artBytes = 0;
    req.on('data', (chunk) => {
      artBytes += chunk.length;
      if (artBytes > 64 * 1024) {
        res.writeHead(413);
        res.end(JSON.stringify({ ok: false, error: 'Payload too large' }));
        req.destroy();
        return;
      }
      artBody += chunk;
    });
    req.on('end', () => {
      let built;
      try {
        built = buildArtRequestIssue(JSON.parse(artBody));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
        return;
      }
      if (!built.ok) {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: 'Validation failed', issues: built.errors }));
        return;
      }
      // execFile (not exec) so the brief text is passed as an argv element and
      // is never parsed by a shell — briefs are free-form prose from a text box.
      execFile(
        'gh',
        [
          'issue',
          'create',
          '--title',
          built.title,
          '--body',
          built.body,
          '--label',
          built.labels.join(','),
        ],
        { cwd: REPO_ROOT, windowsHide: true, timeout: 60_000 },
        (err, stdout, stderr) => {
          res.setHeader('Content-Type', 'application/json');
          if (err) {
            res.writeHead(502);
            res.end(
              JSON.stringify({
                ok: false,
                error: 'gh issue create failed',
                issues: [String(stderr || err.message).trim()],
              }),
            );
            return;
          }
          const issueUrl = String(stdout).trim().split(/\s+/).pop() || '';
          res.end(JSON.stringify({ ok: true, url: issueUrl, name: built.payload.name }));
        },
      );
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/events') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.write(': connected\n\n');
    if (!sseClients.has(instanceId)) sseClients.set(instanceId, new Set());
    sseClients.get(instanceId).add(res);
    req.on('close', () => sseClients.get(instanceId)?.delete(res));
    return;
  }
  res.writeHead(404);
  res.end('Not found');
}

const servers = new Map();
const applyTokens = new Map();
async function startServer(instanceId) {
  applyTokens.set(instanceId, randomBytes(16).toString('hex'));
  const server = createServer((req, res) => {
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : 0;
    const allowedOrigin = 'http://127.0.0.1:' + String(port);
    return handleRequest(instanceId, allowedOrigin, req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: 'http://127.0.0.1:' + server.address().port + '/' };
}

await joinSession({
  canvases: [
    createCanvas({
      id: 'set-piece-editor',
      displayName: 'Set Piece Editor',
      description:
        'Visual drag-and-drop tile-grid editor for set-piece layouts. Scene layers, real sprites, snap modes. Apply changes directly to set-pieces.json.',
      inputSchema: { type: 'object', properties: { setPieceId: { type: 'string' } } },
      actions: [
        {
          name: 'list_set_pieces',
          description: 'Return available set piece IDs, names, themes',
          handler: async () => {
            const p = readPack();
            return p.setPieces.map((s) => ({
              id: s.id,
              name: s.name,
              theme: s.theme,
              size: s.width + 'x' + s.height,
            }));
          },
        },
        {
          name: 'apply_layout',
          description: 'Apply a modified props array to a set piece',
          inputSchema: {
            type: 'object',
            required: ['setPieceId', 'props'],
            properties: { setPieceId: { type: 'string' }, props: { type: 'array' } },
          },
          handler: async (ctx) => {
            const { setPieceId, props } = ctx.input;
            const pack = readPack();
            const idx = pack.setPieces.findIndex((s) => s.id === setPieceId);
            if (idx === -1) throw new CanvasError('not_found', '"' + setPieceId + '" not found');
            const candidate = { ...pack.setPieces[idx], props };
            const issues = validateSetPieceCandidate(candidate, {
              knownNpcTypeIds: CANONICAL_NPC_TYPE_IDS,
            });
            if (issues.length > 0) {
              throw new CanvasError(
                'invalid_input',
                'Layout validation failed: ' + issues.join('; '),
              );
            }
            pack.setPieces[idx] = candidate;
            writePack(pack);
            return { ok: true, setPieceId };
          },
        },
      ],
      open: async (ctx) => {
        let entry = servers.get(ctx.instanceId);
        if (!entry) {
          entry = await startServer(ctx.instanceId);
          servers.set(ctx.instanceId, entry);
        }
        const id = ctx.input?.setPieceId ?? '';
        return {
          title: 'Set Piece Editor',
          url: entry.url + (id ? '?setPieceId=' + encodeURIComponent(id) : ''),
        };
      },
      onClose: async (ctx) => {
        const entry = servers.get(ctx.instanceId);
        if (entry) {
          servers.delete(ctx.instanceId);
          sseClients.delete(ctx.instanceId);
          applyTokens.delete(ctx.instanceId);
          await new Promise((r) => entry.server.close(() => r()));
        }
      },
    }),
  ],
});

function renderHtml(applyToken) {
  return HTML_TEMPLATE.replace('__SET_PIECE_EDITOR_APPLY_TOKEN__', JSON.stringify(applyToken));
}

const HTML_TEMPLATE = `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<title>Set Piece Editor</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{display:flex;flex-direction:column;height:100vh;overflow:hidden;
  background:var(--background-color-default,#0d1117);color:var(--text-color-default,#e6edf3);
  font-family:var(--font-sans,system-ui,sans-serif);font-size:13px;line-height:18px}
.hdr{display:flex;align-items:center;gap:5px;padding:5px 10px;flex-wrap:wrap;flex-shrink:0;
  border-bottom:1px solid var(--border-color-default,#30363d)}
.hdr h1{font-size:13px;font-weight:700;white-space:nowrap}
.hsel{max-width:200px;min-width:110px;background:var(--background-color-inset,#161b22);
  color:var(--text-color-default,#e6edf3);border:1px solid var(--border-color-default,#30363d);
  border-radius:6px;padding:3px 7px;font-size:12px}
.sp{flex:1;min-width:4px}
.btn{display:inline-flex;align-items:center;padding:3px 8px;
  border:1px solid var(--border-color-default,#30363d);border-radius:5px;
  background:var(--background-color-subtle,#21262d);color:var(--text-color-default,#e6edf3);
  cursor:pointer;font-size:11px;font-family:inherit;white-space:nowrap;line-height:1.4}
.btn:hover:not(:disabled){background:var(--background-color-emphasis,#30363d)}
.btn:disabled{opacity:.4;cursor:default}
.btn-g{background:#238636;border-color:#2ea043;color:#fff}
.btn-g:hover:not(:disabled){background:#2ea043}
.btn-r{background:#490202;border-color:#da3633;color:#ffa0a0}
.btn-r:hover:not(:disabled){background:#6b0000}
.main{display:flex;flex:1;overflow:hidden;min-height:0}
.lp{width:165px;flex-shrink:0;display:flex;flex-direction:column;
  border-right:1px solid var(--border-color-default,#30363d)}
.lp-hd{display:flex;align-items:center;padding:5px 8px;flex-shrink:0;
  font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;
  color:var(--text-color-muted,#8b949e);border-bottom:1px solid var(--border-color-default,#30363d)}
.ll{flex:1;overflow-y:auto;padding:3px}
.lr{display:flex;align-items:center;gap:3px;padding:3px 5px;border-radius:4px;
  cursor:pointer;border:1px solid transparent;user-select:none}
.lr:hover{background:var(--background-color-subtle,#21262d)}
.lr.act{background:var(--background-color-subtle,#21262d);
  border-color:var(--border-color-default,#30363d)}
.lname{flex:1;font-size:11px;color:var(--text-color-muted,#8b949e);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;outline:none;min-width:0}
.lr.act .lname{color:var(--text-color-default,#e6edf3)}
.ib{background:none;border:none;cursor:pointer;padding:1px 2px;
  font-size:11px;color:var(--text-color-muted,#8b949e);border-radius:3px;line-height:1;flex-shrink:0}
.ib:hover{background:var(--background-color-emphasis,#30363d);color:var(--text-color-default,#e6edf3)}
.ladd{padding:5px 7px;border-top:1px solid var(--border-color-default,#30363d);flex-shrink:0}
.ga{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}
.tb{display:flex;align-items:center;gap:5px;padding:4px 10px;font-size:11px;flex-shrink:0;
  color:var(--text-color-muted,#8b949e);border-bottom:1px solid var(--border-color-default,#30363d)}
.ssel{background:var(--background-color-inset,#161b22);color:var(--text-color-default,#e6edf3);
  border:1px solid var(--border-color-default,#30363d);border-radius:4px;
  padding:2px 5px;font-size:11px;font-family:inherit}
.gs{flex:1;overflow:auto;padding:16px}
#gc{cursor:default;display:block;image-rendering:pixelated}
.ins{width:215px;min-width:0;flex-shrink:0;display:flex;flex-direction:column;
  border-left:1px solid var(--border-color-default,#30363d);overflow-y:auto;overflow-x:hidden}
.ps{padding:7px 9px;border-bottom:1px solid var(--border-color-default,#30363d);
  box-sizing:border-box;width:100%}
.ps h3{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;
  color:var(--text-color-muted,#8b949e);margin-bottom:5px}
.fr{display:flex;align-items:center;gap:4px;margin-bottom:4px;min-width:0}
.fr label{width:28px;font-size:11px;color:var(--text-color-muted,#8b949e);flex-shrink:0}
.fr input,.fr select{flex:1;min-width:0;width:0;background:var(--background-color-inset,#161b22);
  color:var(--text-color-default,#e6edf3);border:1px solid var(--border-color-default,#30363d);
  border-radius:4px;padding:2px 5px;font-size:11px;font-family:inherit;box-sizing:border-box}
.fr input:focus,.fr select:focus{outline:2px solid var(--color-focus-outline,#1f6feb);outline-offset:-1px}
.pr{display:grid;grid-template-columns:repeat(auto-fill,minmax(72px,1fr));gap:3px}
.nosel{padding:12px;color:var(--text-color-muted,#8b949e);font-size:11px;text-align:center}
.si{background:var(--background-color-inset,#161b22);border:1px solid var(--border-color-default,#30363d);
  border-radius:5px;margin-bottom:4px;overflow:hidden}
.sh{display:flex;align-items:center;gap:3px;padding:3px 6px;
  background:var(--background-color-subtle,#21262d);font-size:10px;font-weight:700;
  color:var(--text-color-muted,#8b949e)}
.sb{padding:5px 7px}
.stbar{padding:3px 10px;font-size:11px;flex-shrink:0;
  color:var(--text-color-muted,#8b949e);border-top:1px solid var(--border-color-default,#30363d)}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
  background:#238636;color:#fff;padding:5px 13px;border-radius:8px;
  font-size:12px;font-weight:600;opacity:0;transition:opacity .2s;pointer-events:none;z-index:100}
.toast.show{opacity:1}
.gal{display:none;position:fixed;inset:0;z-index:300;background:rgba(0,0,0,.72);align-items:center;justify-content:center}
.galp{background:var(--background-color-default,#0d1117);border:1px solid var(--border-color-default,#30363d);border-radius:10px;width:540px;max-height:82vh;display:flex;flex-direction:column;overflow:hidden}
.galh{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border-color-default,#30363d);flex-shrink:0}
.galtabs{display:flex;flex-shrink:0;border-bottom:1px solid var(--border-color-default,#30363d)}
.galtab{flex:1;padding:5px 0;background:none;border:none;border-bottom:2px solid transparent;color:var(--text-color-muted,#8b949e);cursor:pointer;font-size:12px;font-family:inherit}
.galtab.act{border-bottom-color:#1f6feb;color:var(--text-color-default,#e6edf3);font-weight:600}
.galsc{flex:1;overflow:auto;padding:8px}
.galsi{display:inline-flex;flex-direction:column;align-items:center;cursor:pointer;padding:3px;border-radius:4px;border:1px solid transparent;width:58px;vertical-align:top;margin:1px}
.galsi:hover{border-color:var(--border-color-default,#30363d);background:var(--background-color-subtle,#21262d)}
.galsi canvas{image-rendering:pixelated;width:32px;height:32px}
.galsi span{font-size:9px;text-align:center;color:var(--text-color-muted,#8b949e);word-break:break-all;line-height:1.2;margin-top:2px;max-width:54px;overflow:hidden}
.galsi.sel{border-color:#1f6feb;background:rgba(31,111,235,.15)}
.galsrch{flex:1;background:var(--background-color-inset,#161b22);color:var(--text-color-default,#e6edf3);border:1px solid var(--border-color-default,#30363d);border-radius:4px;padding:3px 8px;font-size:12px;font-family:inherit}
.galsrch:focus{outline:2px solid var(--color-focus-outline,#1f6feb);outline-offset:-1px}
.pickbtn{display:inline-block;padding:1px 5px;background:var(--background-color-subtle,#21262d);border:1px solid var(--border-color-default,#30363d);border-radius:3px;cursor:pointer;font-size:10px;color:var(--text-color-muted,#8b949e)}
.pickbtn:hover{background:var(--background-color-emphasis,#30363d);color:var(--text-color-default,#e6edf3)}
#tooltip{position:fixed;z-index:200;background:rgba(13,17,23,.96);
  border:1px solid var(--border-color-default,#30363d);border-radius:6px;
  padding:6px 9px;font-size:11px;pointer-events:none;display:none;max-width:220px;
  line-height:1.6;white-space:pre}
#ctxmenu{position:fixed;z-index:250;background:var(--background-color-default,#0d1117);
  border:1px solid var(--border-color-default,#30363d);border-radius:6px;
  padding:3px;min-width:150px;display:none;box-shadow:0 4px 20px rgba(0,0,0,.6)}
.ctxi{padding:5px 11px;cursor:pointer;border-radius:4px;font-size:12px;white-space:nowrap;
  color:var(--text-color-default,#e6edf3)}
.ctxi:hover{background:var(--background-color-subtle,#21262d)}
.ctxsep{border-top:1px solid var(--border-color-default,#30363d);margin:3px 0}
.ctxi.danger{color:#f85149}
.lp-sz{display:flex;align-items:center;flex-wrap:wrap;gap:3px;padding:4px 7px;flex-shrink:0;
  border-bottom:1px solid var(--border-color-default,#30363d)}
.lp-sz label{font-size:10px;color:var(--text-color-muted,#8b949e)}
.lp-sz input{width:38px;background:var(--background-color-inset,#161b22);
  color:var(--text-color-default,#e6edf3);border:1px solid var(--border-color-default,#30363d);
  border-radius:3px;padding:2px 4px;font-size:11px;font-family:inherit;text-align:center}
</style>
</head>
<body>
<div class="hdr">
  <h1>&#9881; Set Piece Editor</h1>
  <select class="hsel" id="spsel"></select>
  <span style="font-size:11px;color:var(--text-color-muted,#8b949e)" id="spmeta"></span>
  <span class="sp"></span>
  <label style="font-size:11px;color:var(--text-color-muted,#8b949e)">Snap:</label>
  <select class="ssel" id="snapsel">
    <option value="tile">1 tile</option>
    <option value="half">&#189; tile</option>
    <option value="quarter" selected>&#188; tile</option>
    <option value="free">Free</option>
  </select>
  <label style="font-size:11px;color:var(--text-color-muted,#8b949e);display:inline-flex;align-items:center;gap:4px">
    <input id="keepaspect" type="checkbox" checked> Keep aspect
  </label>
  <button class="btn" id="btnfit" title="Zoom to fit">&#8599;Fit</button>
  <button class="btn" id="btnzm" style="padding:3px 7px">&#8722;</button>
  <span id="zoomlbl" style="font-size:11px;min-width:32px;text-align:center">48px</span>
  <button class="btn" id="btnzp" style="padding:3px 7px">+</button>
  <button class="btn" id="btnundo" disabled title="Undo (Ctrl+Z)">&#8630; Undo</button>
  <button class="btn" id="btnredo" disabled title="Redo (Ctrl+Y)">&#8631; Redo</button>
  <button class="btn" id="btnreset" title="Reset to last saved">&#10227; Reset</button>
  <button class="btn" id="btnadd">+ Prop</button>
  <button class="btn" id="btnaddnpc">+ NPC</button>
  <button class="btn" id="btnaddfloor" title="Add floor tile to Floors layer">&#9632; Floor</button>
  <button class="btn" id="btnaddwall" title="Add wall tile to Walls layer">&#9644; Wall</button>
  <button class="btn" id="btnadddoor" title="Add door tile to Doors layer">&#9645; Door</button>
  <button class="btn" id="btnovr" title="Toggle sprite overlay (box + label)">&#9711; Overlay</button>
  <button class="btn" id="btnartnew" title="Request brand-new art through the asset pipeline">&#127912; Request art</button>
  <button class="btn" id="btnartvar" disabled title="Request a variant of the selected prop's sprite">&#8634; Request variant</button>
  <button class="btn btn-r" id="btndel" disabled>&#10005;</button>
  <button class="btn btn-g" id="btnapply">&#10003; Apply</button>
</div>
<div class="main">
  <div class="lp">
    <div class="lp-hd">Scene Layers</div>
    <div class="lp-sz">
      <label>W</label><input id="spw" type="number" min="1" max="50" step="1" value="8">
      <label>H</label><input id="sph" type="number" min="1" max="50" step="1" value="7">
      <button class="btn" id="btnresize" style="font-size:10px;padding:2px 6px;flex:1">Resize</button>
    </div>
    <div class="ll" id="ll"></div>
    <div class="ladd"><button class="btn" id="btnaddlayer" style="width:100%;font-size:11px">+ Add Layer</button></div>
  </div>
  <div class="ga">
    <div class="tb"><span id="gstatus">Loading&#8230;</span></div>
    <div class="gs" id="gs"><canvas id="gc"></canvas></div>
  </div>
  <div class="ins">
    <div class="nosel" id="nosel">Click a prop or NPC to inspect.</div>
    <div id="proped" style="display:none">
      <div class="ps">
        <h3>Prop</h3>
        <div class="fr"><label>id</label><input id="pid" type="text"></div>
        <div class="fr"><label>kind</label>
          <select id="pkind">
            <option>floor</option><option>wall</option><option>door</option>
            <option>fixture</option><option>furniture</option><option>decoration</option><option>actor</option>
          </select>
        </div>
        <div class="fr"><label>layer</label><select id="player"></select></div>
        <div class="pr">
          <div class="fr"><label>x</label><input id="px" type="number" min="0" step="0.25"></div>
          <div class="fr"><label>y</label><input id="py" type="number" min="0" step="0.25"></div>
        </div>
        <div class="pr">
          <div class="fr"><label>w</label><input id="pw" type="number" min="0.25" step="0.25"></div>
          <div class="fr"><label>h</label><input id="ph" type="number" min="0.25" step="0.25"></div>
        </div>
        <div id="prendersz" style="display:none;font-size:10px;opacity:.65;padding:2px 0 0 2px"></div>
        <div class="fr"><label>size</label>
          <select id="pwhu">
            <option value="tiles">tiles</option>
            <option value="feet">feet</option>
          </select>
        </div>
        <div class="fr"><label>z</label><input id="pz" type="number" placeholder="auto"></div>
      </div>
      <div class="ps">
        <h3>Sprites</h3>
        <div id="spriteslist"></div>
        <button class="btn" id="btnaddsprite" style="width:100%;margin-top:3px;font-size:11px">+ Add Sprite</button>
      </div>
    </div>
    <div id="multiproped" style="display:none">
      <div class="ps">
        <h3>Selected Props</h3>
        <div class="fr"><label>count</label><input id="mps-count" type="text" readonly></div>
        <div class="fr"><label>layer</label><input id="mps-layer" type="text" readonly></div>
      </div>
      <div class="ps">
        <h3>Actions</h3>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px">
          <button class="btn" id="mps-front" title="Move selected props in their layers to front">Move Front</button>
          <button class="btn" id="mps-back" title="Move selected props in their layers to back">Send Back</button>
        </div>
        <button class="btn" id="mps-pick" style="width:100%;margin-top:6px">Pick Sprite for Selected</button>
        <button class="btn btn-r" id="mps-del" style="width:100%;margin-top:6px">Delete Selected</button>
      </div>
    </div>
    <div id="multinpcped" style="display:none">
      <div class="ps">
        <h3>Selected NPCs</h3>
        <div class="fr"><label>count</label><input id="mns-count" type="text" readonly></div>
      </div>
      <div class="ps">
        <h3>Actions</h3>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px">
          <button class="btn" id="mns-front">Move Front</button>
          <button class="btn" id="mns-back">Send Back</button>
          <button class="btn" id="mns-rotp">&#8635; +90&#176;</button>
          <button class="btn" id="mns-rotn">&#8634; -90&#176;</button>
          <button class="btn" id="mns-flipx">&#8644; Mirror X</button>
          <button class="btn" id="mns-flipy">&#8645; Mirror Y</button>
        </div>
        <button class="btn" id="mns-pick" style="width:100%;margin-top:6px">Pick Sprite for Selected</button>
        <button class="btn btn-r" id="mns-del" style="width:100%;margin-top:6px">Delete Selected</button>
      </div>
    </div>
    <div id="npcped" style="display:none">
      <div class="ps">
        <h3>NPC</h3>
        <div class="fr"><label>id</label><input id="nid" type="text"></div>
        <div class="fr"><label>type</label>
          <div style="display:flex;gap:6px;align-items:center">
            <input id="ntype" type="text" placeholder="e.g. tutorial-goon" style="flex:1">
            <button class="pickbtn" id="btnnpctypepick">Pick...</button>
          </div>
        </div>
        <div class="fr"><label>sprite</label>
          <div style="display:flex;gap:6px;align-items:center">
            <input id="ntypesprite" type="text" readonly style="flex:1">
            <button class="pickbtn" id="btnnpcspritepick">Pick...</button>
            <button class="pickbtn" id="btnnpcspriteclear">Clear</button>
          </div>
        </div>
        <div class="pr">
          <div class="fr"><label>x</label><input id="nxf" type="number" min="0" step="0.25"></div>
          <div class="fr"><label>y</label><input id="nyf" type="number" min="0" step="0.25"></div>
        </div>
        <div class="pr">
          <div class="fr"><label>w (ft)</label><input id="nwf" type="number" min="0.25" step="0.25"></div>
          <div class="fr"><label>h (ft)</label><input id="nhf" type="number" min="0.25" step="0.25"></div>
        </div>
        <div class="pr">
          <div class="fr"><label>rot</label><input id="nrot" type="number" step="1" placeholder="0"></div>
          <div class="fr" style="align-items:center"><label>flip</label>
            <div style="display:flex;gap:8px;font-size:11px;color:var(--text-color-muted,#8b949e)">
              <label style="display:flex;align-items:center;gap:3px"><input id="nflipx" type="checkbox">X</label>
              <label style="display:flex;align-items:center;gap:3px"><input id="nflipy" type="checkbox">Y</label>
            </div>
          </div>
        </div>
        <div class="fr"><label>layer</label><select id="nlayer"></select></div>
        <div class="fr"><label>z</label><input id="nz" type="number" placeholder="60"></div>
        <div class="fr"><label>anchor</label>
          <select id="nanchor">
            <option value="">none</option>
            <option value="welcome">welcome</option>
            <option value="shop">shop</option>
            <option value="spell">spell</option>
          </select>
        </div>
      </div>
    </div>
  </div>
</div>
<div id="tooltip"></div>
<div id="ctxmenu"></div>
<div class="stbar" id="stbar">Ready</div>
<div class="toast" id="toast"></div>
<div class="gal" id="gal">
  <div class="galp">
    <div class="galh">
      <span id="galtitle" style="font-weight:700;font-size:13px">Pick Sprite</span>
      <span style="flex:1"></span>
      <input class="galsrch" id="galsrch" type="text" placeholder="Search catalog...">
      <button class="btn" id="galbtnclose">&#10005;</button>
    </div>
    <div class="galtabs">
      <button class="galtab act" id="galtab-cat">Catalog</button>
      <button class="galtab" id="galtab-sht">Sheet Browser</button>
    </div>
    <div class="galsc" id="galsc"></div>
  </div>
</div>
<div class="gal" id="artdlg">
  <div class="galp" style="max-width:560px">
    <div class="galh">
      <span id="arttitle" style="font-weight:700;font-size:13px">Request art</span>
      <span style="flex:1"></span>
      <button class="btn" id="artclose">&#10005;</button>
    </div>
    <div class="galsc" style="padding:12px;display:block">
      <div id="artbasedon" style="display:none;font-size:11px;margin-bottom:10px;padding:7px 9px;border-radius:5px;background:#1f2937;color:var(--text-color-muted,#8b949e)"></div>
      <label style="display:block;font-size:11px;margin-bottom:3px">Name <span style="color:var(--text-color-muted,#8b949e)">(lowercase kebab-case)</span></label>
      <input id="artname" type="text" placeholder="bearskin-rug" style="width:100%;box-sizing:border-box;margin-bottom:10px;padding:5px 7px;font-size:12px">
      <label style="display:block;font-size:11px;margin-bottom:3px" id="artbrieflbl">Brief</label>
      <textarea id="artbrief" rows="5" placeholder="A shaggy bearskin rug, head at the west end, splayed on flagstones. Reads clearly from above at gameplay scale." style="width:100%;box-sizing:border-box;margin-bottom:10px;padding:5px 7px;font-size:12px;font-family:inherit"></textarea>
      <div style="display:flex;gap:8px;margin-bottom:10px">
        <div style="flex:1">
          <label style="display:block;font-size:11px;margin-bottom:3px">Type</label>
          <select id="arttype" class="ssel" style="width:100%">
            <option value="">auto-detect</option>
            <option value="prop">prop</option>
            <option value="tile">tile</option>
            <option value="item">item</option>
            <option value="character">character</option>
            <option value="enemy">enemy</option>
            <option value="weapon">weapon</option>
            <option value="equipment">equipment</option>
            <option value="vfx">vfx</option>
          </select>
        </div>
        <div style="flex:1">
          <label style="display:block;font-size:11px;margin-bottom:3px">Size</label>
          <select id="artsize" class="ssel" style="width:100%">
            <option value="">auto</option>
            <option value="default">default</option>
            <option value="wide">wide</option>
            <option value="tall">tall</option>
            <option value="large">large</option>
          </select>
        </div>
        <div style="width:70px">
          <label style="display:block;font-size:11px;margin-bottom:3px">Floor</label>
          <input id="artfloor" type="number" min="1" max="20" step="1" placeholder="1" style="width:100%;box-sizing:border-box;padding:5px 7px;font-size:12px">
        </div>
      </div>
      <div id="arterr" style="display:none;font-size:11px;color:#ff7b72;margin-bottom:10px;white-space:pre-line"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn" id="artcancel">Cancel</button>
        <button class="btn btn-g" id="artsubmit">Open issue</button>
      </div>
    </div>
  </div>
</div>
<script>
var SHEETS_META={
  'kenney-tiny-dungeon':{margin:0,spacing:1,cols:12},
  'kenney-tiny-town':{margin:0,spacing:1,cols:12},
  'kenney-tiny-battle':{margin:0,spacing:1,cols:18},
  'kenney-tiny-ski':{margin:0,spacing:1,cols:12},
  'kenney-roguelike-rpg-pack':{margin:0,spacing:1,cols:57},
  'kenney-roguelike-characters':{margin:0,spacing:1,cols:54},
  'custom-pixel-sprites':{margin:1,spacing:1,cols:19}
};
// Full catalog mirrored from src/engine/sprites/registry.ts SPRITES array.
// col = frame % sheetCols, row = Math.floor(frame / sheetCols)
var CATALOG = {
  // Kenney Tiny Dungeon (cols=12)
  player: { k: 'kenney-tiny-dungeon', c: 0, r: 8 },
  'enemy.goblin': { k: 'kenney-tiny-dungeon', c: 1, r: 10 },
  'enemy.orc': { k: 'kenney-tiny-dungeon', c: 1, r: 9 },
  'enemy.rat': { k: 'kenney-tiny-dungeon', c: 3, r: 10 },
  'enemy.slime': { k: 'kenney-tiny-dungeon', c: 0, r: 9 },
  'enemy.boss': { k: 'kenney-tiny-dungeon', c: 0, r: 10 },
  'npc.guide': { k: 'kenney-tiny-dungeon', c: 3, r: 8 },
  'weapon.sword': { k: 'kenney-tiny-dungeon', c: 8, r: 8 },
  'weapon.bat': { k: 'kenney-tiny-dungeon', c: 9, r: 9 },
  'weapon.arrow': { k: 'kenney-tiny-dungeon', c: 11, r: 10 },
  // Kenney Roguelike Characters (cols=54)
  'enemy.brigand': { k: 'kenney-roguelike-characters', c: 0, r: 7 },
  'enemy.ghost': { k: 'kenney-roguelike-characters', c: 1, r: 11 },
  // Custom pixel sprites (cols=19, row 0)
  'item.gem': { k: 'custom-pixel-sprites', c: 7, r: 0 },
  'effect.proj': { k: 'custom-pixel-sprites', c: 8, r: 0 },
  'effect.enemy_proj': { k: 'custom-pixel-sprites', c: 9, r: 0 },
  'effect.aoe': { k: 'custom-pixel-sprites', c: 10, r: 0 },
  'effect.enemy_aoe': { k: 'custom-pixel-sprites', c: 11, r: 0 },
  'weapon.returning': { k: 'custom-pixel-sprites', c: 12, r: 0 },
  'effect.melee': { k: 'custom-pixel-sprites', c: 13, r: 0 },
  'effect.trap_arming': { k: 'custom-pixel-sprites', c: 14, r: 0 },
  'effect.trap_armed': { k: 'custom-pixel-sprites', c: 15, r: 0 },
  'effect.explosion': { k: 'custom-pixel-sprites', c: 16, r: 0 },
  'effect.enemy_explosion': { k: 'custom-pixel-sprites', c: 17, r: 0 },
  'effect.dead': { k: 'custom-pixel-sprites', c: 18, r: 0 },
};
// Mirrors src/engine/phaser-bridge/sprite-kind.ts GENERATED_KEY_BY_NPC_DEF.
// Populated from /npc-sprites, which serves src/shared/data/npc-sprite-map.json -
// the SAME file the game imports. This used to be a hardcoded literal here and it
// went stale: the Goon and Merchant were regenerated to -v3- and the game was
// repointed, but this copy still named the old npc-*-var-0 art, so the editor
// showed sprites that had already been replaced.
var GENERATED_NPC_SPRITE_BY_DEF = {};
var KNOWN_NPC_TYPE_IDS = [
  'tutorial-goon',
  'shopkeeper',
  'floor2-defector',
  'spell-quest-giver',
  'the-broker',
  'shop-the-fence',
  'shop-the-apothecary',
  'shop-the-quartermaster',
  'shop-the-resource-broker'
];
var imgCache={};
var imgLoadFailed={};
function loadSheet(key){
  if(imgCache[key]!==undefined)return imgCache[key];
  imgCache[key]=null;
  imgLoadFailed[key]=false;
  var img=new Image();
  img.onload=function(){imgCache[key]=img;render();};
  img.onerror=function(){imgCache[key]=null;imgLoadFailed[key]=true;};
  img.src='/sheet/'+encodeURIComponent(key);
  return null;
}
// Individual generated sprite PNGs (source:'catalog', non-registry IDs)
var genCache={};
var genLoadFailed={};
function loadGenSprite(id){
  if(genCache[id]!==undefined)return genCache[id];
  genCache[id]=null;
  genLoadFailed[id]=false;
  var img=new Image();
  img.onload=function(){genCache[id]=img;render();};
  img.onerror=function(){genCache[id]=null;genLoadFailed[id]=true;};
  img.src='/generated/'+encodeURIComponent(id)+'.png';
  return null;
}
function resolveSprite(s){
  if(!s)return null;
  var k,c,r;
  if(s.source==='sheet'){k=s.sheetKey;c=s.col||0;r=s.row||0;}
  else if(s.source==='catalog'){
    var bare=(s.spriteId||'').replace(/^sprite:/,'');
    var def=CATALOG[bare];
    if(def){k=def.k;c=def.c;r=def.r;}
    else{
      // Generated individual PNG — bareId matches filename in /assets/generated/
      var gi=loadGenSprite(bare);if(!gi)return null;
      return{img:gi,sx:0,sy:0,w:gi.naturalWidth||16,h:gi.naturalHeight||16,individual:true};
    }
  }else if(s.source==='custom'){return s.placeholder?resolveSprite(s.placeholder):null;}
  else{return null;}
  var meta=SHEETS_META[k];if(!meta)return null;
  var img=loadSheet(k);if(!img)return null;
  return{img:img,sx:meta.margin+c*(16+meta.spacing),sy:meta.margin+r*(16+meta.spacing),w:16,h:16};
}
function bareSpriteId(id){return String(id||'').replace(/^sprite:/,'');}
function npcSpriteIdForType(npcTypeId){
  var mapped=GENERATED_NPC_SPRITE_BY_DEF[npcTypeId];
  return mapped?mapped:'npc.guide';
}
function formatSpriteRefLabel(sprite){
  if(!sprite||typeof sprite!=='object')return '(default)';
  if(sprite.source==='catalog')return 'catalog:'+bareSpriteId(sprite.spriteId||'');
  if(sprite.source==='sheet')return 'sheet:'+String(sprite.sheetKey||'')+' c'+String(sprite.col||0)+' r'+String(sprite.row||0);
  if(sprite.source==='custom')return 'custom:'+(sprite.label||sprite.requestId||'sprite');
  return '(default)';
}
function renderNpcSpriteLabel(npc){
  if(npc&&npc.spriteOverride)return formatSpriteRefLabel(npc.spriteOverride);
  return 'default: sprite:'+bareSpriteId(npcSpriteIdForType(npc&&npc.npcTypeId));
}
function clampNpcCoord(v,limit){
  var n=nnum(v,0);
  if(!Number.isFinite(limit)||limit<=0)return 0;
  var max=Math.max(0,limit-0.001);
  return Math.max(0,Math.min(max,n));
}
function npcSizeTiles(npc){
  var wFt=Math.max(0.25,nnum(npc&&npc.widthFt,2.5));
  var hFt=Math.max(0.25,nnum(npc&&npc.heightFt,3.5));
  return {w:wFt/FEET_PER_TILE,h:hFt/FEET_PER_TILE};
}
function npcSnapStep(){
  if(S.snapMode==='tile')return 1;
  if(S.snapMode==='half')return 0.5;
  if(S.snapMode==='quarter')return 0.25;
  return 0;
}
function clampNpcSnappedCoord(v,limit,sizeTiles){
  var step=npcSnapStep();
  if(step<=0)return clampNpcCoord(v,limit-sizeTiles+0.001);
  var max=Math.max(0,limit-sizeTiles);
  return Math.max(0,Math.min(max,nnum(v,0)));
}
// Snap the NPC *center* to the grid and return the clamped top-left tile coordinate.
// Mirrors the runtime center convention: stampSetPiece places NPC sprites at
// centreTile = boundedTopLeft + widthTiles/2, so we align authoring snaps the same way.
function snapNpcCenter(dispPx,tileSize,sizeTiles,limit){
  var step=npcSnapStep();
  var topLeftTiles=dispPx/tileSize;
  var centerTiles=topLeftTiles+sizeTiles/2;
  var snappedCenter=step>0?Math.round(centerTiles/step)*step:snapV(centerTiles);
  var snappedTopLeft=snappedCenter-sizeTiles/2;
  var max=Math.max(0,limit-sizeTiles);
  var clamped=Math.max(0,Math.min(max,snappedTopLeft));
  return step>0?clamped:snapV(clamped);
}
function clampGroupDeltaPx(items,dx,dy,widthTiles,heightTiles){
  if(!items||!items.length)return {dx:dx,dy:dy};
  var minDx=-Infinity,maxDx=Infinity,minDy=-Infinity,maxDy=Infinity;
  items.forEach(function(it){
    minDx=Math.max(minDx,-nnum(it.x,0));
    maxDx=Math.min(maxDx,Math.max(0,nnum(widthTiles,0)-nnum(it.w,1))-nnum(it.x,0));
    minDy=Math.max(minDy,-nnum(it.y,0));
    maxDy=Math.min(maxDy,Math.max(0,nnum(heightTiles,0)-nnum(it.h,1))-nnum(it.y,0));
  });
  if(!Number.isFinite(minDx)||!Number.isFinite(maxDx)||minDx>maxDx){minDx=0;maxDx=0;}
  if(!Number.isFinite(minDy)||!Number.isFinite(maxDy)||minDy>maxDy){minDy=0;maxDy=0;}
  var cdx=Math.max(minDx,Math.min(maxDx,dx));
  var cdy=Math.max(minDy,Math.min(maxDy,dy));
  return {dx:cdx,dy:cdy};
}
var FEET_PER_TILE=4;
var APPLY_TOKEN=__SET_PIECE_EDITOR_APPLY_TOKEN__;
// snapMode defaults to 'quarter' (1 ft on a 4 ft tile). Whole-tile snap is too
// coarse for dressing — it forces furniture onto a lattice, which is exactly the
// scattered-props-in-a-box look the set-piece work exists to kill. MUST match
// the "selected" option on #snapsel; editor-gestures.test.mjs asserts they agree.
var S={pack:null,selId:null,selPropIdx:-1,selNpcIdx:-1,selPropIds:{},selNpcIds:{},tileSize:48,dirty:false,snapMode:'quarter',activeLayerId:null,propSizeUnit:'tiles',showOverlay:true,keepAspect:true};
var GENERATED_LIBRARY=[];
var CLIPBOARD={props:[],npcs:[]};
var sp=null;
var hist=[],histIdx=-1,origSP=null,galTab='catalog',galMode='prop',galleryTarget=null,galSheetKey=Object.keys(SHEETS_META)[0];
var KINDS={
  floor:{bg:'#162016',bd:'#2d5a2d',lb:'#4ade80'},
  wall:{bg:'#16162e',bd:'#2d2d5a',lb:'#818cf8'},
  door:{bg:'#2a160a',bd:'#5a3410',lb:'#fb923c'},
  fixture:{bg:'#0a1826',bd:'#104060',lb:'#38bdf8'},
  furniture:{bg:'#0e2618',bd:'#1a5a30',lb:'#34d399'},
  decoration:{bg:'#28240a',bd:'#5a520a',lb:'#facc15'},
  actor:{bg:'#280a18',bd:'#5a1030',lb:'#f472b6'}
};
var ZD={floor:0,wall:10,door:12,fixture:20,furniture:30,decoration:40,actor:50};
function getZ(p){return p.z!==undefined?p.z:(ZD[p.kind]||0);}
function getNpcZ(n){return n.z!==undefined?n.z:0;}
function getLayers(){
  if(!sp)return[];
  if(!sp.sceneLayers||!sp.sceneLayers.length)
    sp.sceneLayers=[{id:'default',name:'Default',visible:true,locked:false}];
  return sp.sceneLayers;
}
function getActiveLayer(){
  var ls=getLayers();
  if(S.activeLayerId){var f=ls.find(function(l){return l.id===S.activeLayerId;});if(f)return f;}
  S.activeLayerId=ls[0].id;return ls[0];
}
function layerVisible(lid){var l=getLayers().find(function(x){return x.id===lid;});return!l||l.visible!==false;}
function layerLocked(lid){var l=getLayers().find(function(x){return x.id===lid;});return l&&l.locked===true;}
function propLayer(p){return p.sceneLayer||(getLayers()[0]||{id:'default'}).id;}
function npcLayer(n){return n.sceneLayer||(getLayers()[0]||{id:'default'}).id;}
// Mirror src/shared/render-depths.ts:setPieceZToDepth and TERRAIN_DEPTH so draw order matches runtime.
// Negative NPC z values clamp above terrain in PhaserBridge, so the editor must too.
var TERRAIN_DEPTH=-20;
var ENTITY_DEPTH=0;
var LAYER_DEPTH_EPSILON=0.001;
// Keep NPCs infinitesimally above terrain when authored z would otherwise sort them underneath it.
var NPC_TERRAIN_MARGIN=0.001;
function setPieceZToDepth(z){if(z<20)return -19+z*0.8;return 2+(z-20)*0.1;}
function getNativeSpriteTileDimensions(sprite){
  if(sprite&&sprite.source==='custom')return{w:nnum(sprite.widthTiles,1),h:nnum(sprite.heightTiles,1)};
  return{w:1,h:1};
}
// Depth-based sort key — keeps editor canvas order in parity with the Phaser depth stack.
// NPCs without an authored z sort at ENTITY_DEPTH (between background and foreground props).
function globalZ(layerId,kind,localZ){
  if(kind==='npc')return localZ!==undefined?Math.max(TERRAIN_DEPTH+NPC_TERRAIN_MARGIN,setPieceZToDepth(localZ)):ENTITY_DEPTH;
  return setPieceZToDepth(localZ);
}
function propRenderZ(layerId,localZ,propIndex){
  return globalZ(layerId,'prop',localZ)+propIndex*LAYER_DEPTH_EPSILON;
}
function nnum(v,d){var n=Number(v);return Number.isFinite(n)?n:d;}
function isPropSelectedIndex(idx){
  var p=sp&&sp.props&&sp.props[idx];
  return !!(p&&S.selPropIds&&S.selPropIds[p.id]);
}
function isNpcSelectedIndex(idx){
  var n=sp&&sp.npcs&&sp.npcs[idx];
  return !!(n&&S.selNpcIds&&S.selNpcIds[n.id]);
}
function getSelectedPropIndices(){
  var out=[];if(!sp||!sp.props)return out;
  for(var i=0;i<sp.props.length;i++)if(isPropSelectedIndex(i))out.push(i);
  return out;
}
function getSelectedNpcIndices(){
  var out=[];if(!sp||!sp.npcs)return out;
  for(var i=0;i<sp.npcs.length;i++)if(isNpcSelectedIndex(i))out.push(i);
  return out;
}
function setSinglePropSelection(idx){
  S.selPropIds={};S.selNpcIds={};S.selNpcIdx=-1;
  if(idx>=0&&sp&&sp.props&&sp.props[idx]){
    S.selPropIds[sp.props[idx].id]=true;S.selPropIdx=idx;
  }else S.selPropIdx=-1;
}
function setSingleNpcSelection(idx){
  S.selNpcIds={};S.selPropIds={};S.selPropIdx=-1;
  if(idx>=0&&sp&&sp.npcs&&sp.npcs[idx]){
    S.selNpcIds[sp.npcs[idx].id]=true;S.selNpcIdx=idx;
  }else S.selNpcIdx=-1;
}
function togglePropSelection(idx){
  if(!sp||!sp.props||!sp.props[idx])return;
  var id=sp.props[idx].id;
  if(S.selPropIds[id])delete S.selPropIds[id];
  else S.selPropIds[id]=true;
  var ps=getSelectedPropIndices();
  S.selNpcIds={};S.selNpcIdx=-1;
  S.selPropIdx=ps.length?ps[ps.length-1]:-1;
}
function toggleNpcSelection(idx){
  if(!sp||!sp.npcs||!sp.npcs[idx])return;
  var id=sp.npcs[idx].id;
  if(S.selNpcIds[id])delete S.selNpcIds[id];
  else S.selNpcIds[id]=true;
  var ns=getSelectedNpcIndices();
  S.selPropIds={};S.selPropIdx=-1;
  S.selNpcIdx=ns.length?ns[ns.length-1]:-1;
}
function clearSelection(){
  S.selPropIdx=-1;S.selNpcIdx=-1;S.selPropIds={};S.selNpcIds={};
}
function isTextEditingTarget(){
  var ae=document.activeElement;if(!ae)return false;
  var tag=(ae.tagName||'').toUpperCase();
  return tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT'||ae.isContentEditable===true;
}
function copySelection(){
  if(!sp)return false;
  var pidx=getSelectedPropIndices(),nidx=getSelectedNpcIndices();
  if(!pidx.length&&!nidx.length){
    if(S.selPropIdx>=0)pidx=[S.selPropIdx];
    else if(S.selNpcIdx>=0)nidx=[S.selNpcIdx];
  }
  if(!pidx.length&&!nidx.length)return false;
  CLIPBOARD.props=pidx.map(function(i){return JSON.parse(JSON.stringify(sp.props[i]));});
  CLIPBOARD.npcs=nidx.map(function(i){return JSON.parse(JSON.stringify(sp.npcs[i]));});
  showToast('Copied '+(CLIPBOARD.props.length+CLIPBOARD.npcs.length)+' item(s)');
  return true;
}
function deleteSelected(confirmDelete){
  if(!sp)return false;
  var pidx=getSelectedPropIndices(),nidx=getSelectedNpcIndices();
  if(!pidx.length&&!nidx.length){
    if(S.selPropIdx>=0)pidx=[S.selPropIdx];
    if(S.selNpcIdx>=0)nidx=[S.selNpcIdx];
  }
  if(!pidx.length&&!nidx.length)return false;
  var total=pidx.length+nidx.length;
  if(confirmDelete&&!confirm('Delete '+total+' selected item(s)?'))return false;
  var propIds={};pidx.forEach(function(i){var p=sp.props[i];if(p)propIds[p.id]=true;});
  var npcIds={};nidx.forEach(function(i){var n=sp.npcs[i];if(n)npcIds[n.id]=true;});
  sp.props=sp.props.filter(function(p){return !propIds[p.id];});
  if(sp.npcs)sp.npcs=sp.npcs.filter(function(n){return !npcIds[n.id];});
  clearSelection();updatePropPanel();render();markDirty();
  return true;
}
function cutSelection(){
  if(!copySelection())return false;
  return deleteSelected(false);
}
function pasteClipboard(){
  if(!sp)return false;
  if((!CLIPBOARD.props||!CLIPBOARD.props.length)&&(!CLIPBOARD.npcs||!CLIPBOARD.npcs.length))return false;
  var newPropIds={},newNpcIds={},stamp=Date.now();
  (CLIPBOARD.props||[]).forEach(function(src,i){
    var p=JSON.parse(JSON.stringify(src));
    p.id='copy-'+(src.id||'prop')+'-'+stamp+'-'+i;
    p.x=Math.max(0,Math.min(sp.width-(p.width||1),snapV((p.x||0)+1)));
    p.y=Math.max(0,Math.min(sp.height-(p.height||1),snapV((p.y||0)+1)));
    sp.props.push(p);newPropIds[p.id]=true;
  });
  if(!sp.npcs)sp.npcs=[];
  (CLIPBOARD.npcs||[]).forEach(function(src,j){
    var n=JSON.parse(JSON.stringify(src));
    n.id='copy-'+(src.id||'npc')+'-'+stamp+'-'+j;
    n.widthFt=Math.max(0.25,nnum(n.widthFt,2.5));
    n.heightFt=Math.max(0.25,nnum(n.heightFt,3.5));
    var ns=npcSizeTiles(n);
    n.x=clampNpcSnappedCoord(snapV((n.x||0)+1),sp.width||1,ns.w);
    n.y=clampNpcSnappedCoord(snapV((n.y||0)+1),sp.height||1,ns.h);
    sp.npcs.push(n);newNpcIds[n.id]=true;
  });
  S.selPropIds=newPropIds;S.selNpcIds=newNpcIds;
  var ps=getSelectedPropIndices(),ns=getSelectedNpcIndices();
  S.selPropIdx=ps.length?ps[0]:-1;S.selNpcIdx=ns.length?ns[0]:-1;
  updatePropPanel();render();markDirty();
  showToast('Pasted '+((CLIPBOARD.props||[]).length+(CLIPBOARD.npcs||[]).length+' item(s)'));
  return true;
}
function getSelectedProps(){
  if(!sp||!sp.props)return[];
  return getSelectedPropIndices().map(function(i){return sp.props[i];}).filter(Boolean);
}
function selectedPropsShareLayer(){
  var ps=getSelectedProps();if(!ps.length)return false;
  var lid=propLayer(ps[0]);
  for(var i=1;i<ps.length;i++)if(propLayer(ps[i])!==lid)return false;
  return true;
}
function moveSelectedPropsToFront(){
  if(!sp)return false;
  var pidx=getSelectedPropIndices();if(!pidx.length)return false;
  var selectedByLayer={};
  pidx.forEach(function(i){
    var p=sp.props[i];if(!p)return;
    var lid=propLayer(p);if(!selectedByLayer[lid])selectedByLayer[lid]=[];
    selectedByLayer[lid].push(p);
  });
  Object.keys(selectedByLayer).forEach(function(lid){
    var layerAll=sp.props.filter(function(p){return propLayer(p)===lid;});
    var maxZ=Math.max.apply(null,layerAll.map(function(p){return getZ(p);}));
    selectedByLayer[lid].forEach(function(p,rank){p.z=maxZ+1+rank;});
  });
  render();markDirty();return true;
}
function moveSelectedPropsToBack(){
  if(!sp)return false;
  var pidx=getSelectedPropIndices();if(!pidx.length)return false;
  var selectedByLayer={};
  pidx.forEach(function(i){
    var p=sp.props[i];if(!p)return;
    var lid=propLayer(p);if(!selectedByLayer[lid])selectedByLayer[lid]=[];
    selectedByLayer[lid].push(p);
  });
  Object.keys(selectedByLayer).forEach(function(lid){
    var layerAll=sp.props.filter(function(p){return propLayer(p)===lid;});
    var minZ=Math.min.apply(null,layerAll.map(function(p){return getZ(p);}));
    selectedByLayer[lid].forEach(function(p,rank){p.z=minZ-selectedByLayer[lid].length+rank;});
  });
  render();markDirty();return true;
}
function normalizeRotationDeg(v){
  var n=Number(v);
  if(!Number.isFinite(n))return 0;
  n=n%360;
  if(n<0)n+=360;
  return n;
}
function applyTransformToSelectedBaseLayers(mutator){
  if(!sp||typeof mutator!=='function')return false;
  var pidx=getSelectedPropIndices();
  if(!pidx.length&&S.selPropIdx>=0)pidx=[S.selPropIdx];
  if(!pidx.length)return false;
  var changed=false;
  pidx.forEach(function(i){
    var p=sp.props&&sp.props[i];
    var layer=p&&p.layers&&p.layers[0];
    if(!layer)return;
    mutator(layer,p);
    changed=true;
  });
  if(!changed)return false;
  refreshPropInputs();
  refreshSprites();
  render();
  markDirty();
  return true;
}
function rotateSelectedProps(stepDeg){
  stepDeg=Number(stepDeg)||0;
  if(stepDeg===0)return false;
  return applyTransformToSelectedBaseLayers(function(layer){
    layer.rotationDeg=normalizeRotationDeg(normalizeRotationDeg(layer.rotationDeg)+stepDeg);
  });
}
function mirrorSelectedProps(axis){
  return applyTransformToSelectedBaseLayers(function(layer){
    if(axis==='x')layer.flipX=!(layer.flipX===true);
    else if(axis==='y')layer.flipY=!(layer.flipY===true);
  });
}
function getSelectedNpcs(){
  if(!sp||!sp.npcs)return[];
  return getSelectedNpcIndices().map(function(i){return sp.npcs[i];}).filter(Boolean);
}
function applyToSelectedNpcs(mutator){
  if(!sp||typeof mutator!=='function')return false;
  var nidx=getSelectedNpcIndices();
  if(!nidx.length&&S.selNpcIdx>=0)nidx=[S.selNpcIdx];
  if(!nidx.length)return false;
  var changed=false;
  nidx.forEach(function(i){
    var n=sp.npcs&&sp.npcs[i];
    if(!n)return;
    mutator(n);
    changed=true;
  });
  if(!changed)return false;
  refreshNpcInputs();
  render();
  markDirty();
  return true;
}
function rotateSelectedNpcs(stepDeg){
  stepDeg=Number(stepDeg)||0;
  if(stepDeg===0)return false;
  return applyToSelectedNpcs(function(npc){
    npc.rotationDeg=normalizeRotationDeg(normalizeRotationDeg(npc.rotationDeg)+stepDeg);
  });
}
function mirrorSelectedNpcs(axis){
  return applyToSelectedNpcs(function(npc){
    if(axis==='x')npc.flipX=!(npc.flipX===true);
    else if(axis==='y')npc.flipY=!(npc.flipY===true);
  });
}
function moveSelectedNpcsToFront(){
  return applyToSelectedNpcs(function(npc){
    var lid=npcLayer(npc);
    var zs=(sp.npcs||[]).filter(function(q){return npcLayer(q)===lid;}).map(function(q){return getNpcZ(q);});
    npc.z=Math.max.apply(null,zs)+1;
  });
}
function moveSelectedNpcsToBack(){
  return applyToSelectedNpcs(function(npc){
    var lid=npcLayer(npc);
    var zs=(sp.npcs||[]).filter(function(q){return npcLayer(q)===lid;}).map(function(q){return getNpcZ(q);});
    npc.z=Math.min.apply(null,zs)-1;
  });
}
function enforceAspectRect(ox,oy,ow,oh,nx,ny,nw,nh,h){
  if(!S.keepAspect)return {nx:nx,ny:ny,nw:nw,nh:nh};
  var ratio=ow/Math.max(oh,0.0001);
  var useWidth=Math.abs(nw-ow)>=Math.abs(nh-oh);
  if(useWidth)nh=Math.max(0.25*S.tileSize,nw/ratio);
  else nw=Math.max(0.25*S.tileSize,nh*ratio);
  if(h.dx<0)nx=ox+(ow-nw);else if(h.dx===0)nx=ox+(ow-nw)/2;
  if(h.dy<0)ny=oy+(oh-nh);else if(h.dy===0)ny=oy+(oh-nh)/2;
  return {nx:nx,ny:ny,nw:nw,nh:nh};
}
function clampResizeRectToBounds(ox,oy,ow,oh,nx,ny,nw,nh,h,maxW,maxH){
  nx=Math.max(0,nx);ny=Math.max(0,ny);
  var availW=Math.max(0,maxW-nx),availH=Math.max(0,maxH-ny);
  if(!S.keepAspect){
    return {nx:nx,ny:ny,nw:Math.min(nw,availW),nh:Math.min(nh,availH)};
  }
  var sw=Math.max(0.0001,ow),sh=Math.max(0.0001,oh);
  var scale=Math.min(Math.max(0,nw)/sw,Math.max(0,nh)/sh,availW/sw,availH/sh);
  if(!Number.isFinite(scale))scale=0;
  var cw=sw*scale,ch=sh*scale;
  if(h.dx<0)nx=ox+(ow-cw);else if(h.dx===0)nx=ox+(ow-cw)/2;
  if(h.dy<0)ny=oy+(oh-ch);else if(h.dy===0)ny=oy+(oh-ch)/2;
  if(nx<0)nx=0;
  if(ny<0)ny=0;
  if(nx+cw>maxW)nx=Math.max(0,maxW-cw);
  if(ny+ch>maxH)ny=Math.max(0,maxH-ch);
  return {nx:nx,ny:ny,nw:cw,nh:ch};
}
async function loadData(){
  var params=new URLSearchParams(location.search),initId=params.get('setPieceId')||'';
  try{
    var nres=await fetch('/npc-sprites');
    var nmap=await nres.json();
    GENERATED_NPC_SPRITE_BY_DEF=(nmap&&nmap.byNpcDefId)||{};
  }catch(_){
    GENERATED_NPC_SPRITE_BY_DEF={};
  }
  try{
    var sres=await fetch('/substrate');
    SUBSTRATE=await sres.json();
  }catch(_){
    SUBSTRATE=null;
  }
  try{
    var gres=await fetch('/generated-index');
    GENERATED_LIBRARY=await gres.json();
  }catch(_){
    GENERATED_LIBRARY=[];
  }
  var res=await fetch('/data');S.pack=await res.json();
  var sel=document.getElementById('spsel');
  sel.innerHTML='';
  S.pack.setPieces.forEach(function(s){
    var opt=document.createElement('option');
    opt.value=String(s.id||'');
    opt.textContent=String(s.name||'')+' ('+String(s.width||0)+'x'+String(s.height||0)+')';
    sel.appendChild(opt);
  });
  var fid=S.pack.setPieces.some(function(s){return s.id===initId;})?initId:(S.pack.setPieces[0]||{}).id;
  if(fid)selectSP(fid);
}
function selectSP(id){
  S.selId=id;clearSelection();S.dirty=false;
  sp=JSON.parse(JSON.stringify(S.pack.setPieces.find(function(s){return s.id===id;})));
  if(!sp.npcs)sp.npcs=[];
  // Defensive normalize in case prior edits introduced NaN/invalid coords.
  (sp.props||[]).forEach(function(p){
    p.x=nnum(p.x,0);p.y=nnum(p.y,0);
    p.width=Math.max(0.25,nnum(p.width,1));p.height=Math.max(0.25,nnum(p.height,1));
  });
  (sp.npcs||[]).forEach(function(n){
    n.widthFt=Math.max(0.25,nnum(n.widthFt,2.5));
    n.heightFt=Math.max(0.25,nnum(n.heightFt,3.5));
    n.x=clampNpcCoord(n.x,sp.width||1);
    n.y=clampNpcCoord(n.y,sp.height||1);
  });
  document.getElementById('spsel').value=id;
  document.getElementById('pwhu').value=S.propSizeUnit;
  document.getElementById('spmeta').textContent=(sp.theme||'')+' \u00b7 '+(sp.sizing||'');
  document.getElementById('spw').value=sp.width||8;
  document.getElementById('sph').value=sp.height||7;
  getLayers();S.activeLayerId=sp.sceneLayers[0].id;
  origSP=JSON.stringify(sp);hist=[origSP];histIdx=0;
  renderLayersPanel();updatePropPanel();render();
  setGs('Editing: '+sp.name+' ('+sp.width+'x'+sp.height+')');updateStatus();updUR();
}
function renderLayersPanel(){
  var ll=document.getElementById('ll');ll.innerHTML='';
  var layers=getLayers().slice().reverse();
  layers.forEach(function(layer){
    var row=document.createElement('div');
    row.className='lr'+(layer.id===S.activeLayerId?' act':'');
    row.onclick=function(e){if(e.target.closest('.ib'))return;S.activeLayerId=layer.id;renderLayersPanel();};
    var vis=document.createElement('button');vis.className='ib';
    vis.title=layer.visible!==false?'Hide':'Show';
    vis.textContent=layer.visible!==false?'\uD83D\uDC41':'\u2205';
    vis.onclick=function(e){e.stopPropagation();layer.visible=layer.visible===false;renderLayersPanel();render();markDirty();};
    var lck=document.createElement('button');lck.className='ib';
    lck.title=layer.locked?'Unlock':'Lock';
    lck.textContent=layer.locked?'\uD83D\uDD12':'\uD83D\uDD13';
    lck.onclick=function(e){e.stopPropagation();layer.locked=!layer.locked;renderLayersPanel();markDirty();};
    var nm=document.createElement('span');nm.className='lname';nm.textContent=layer.name;
    nm.contentEditable='true';nm.spellcheck=false;
    nm.style.opacity=layer.visible===false?'0.4':'1';
    nm.addEventListener('blur',function(){layer.name=nm.textContent.trim()||layer.name;markDirty();});
    nm.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();nm.blur();}});
    var del=document.createElement('button');del.className='ib';del.title='Delete';del.textContent='\u00D7';
    del.onclick=function(e){
      e.stopPropagation();
      if(sp.sceneLayers.length<=1){showToast('Cannot delete last layer',true);return;}
      var otherId=sp.sceneLayers.find(function(l){return l.id!==layer.id;}).id;
      sp.props.forEach(function(p){if(propLayer(p)===layer.id)p.sceneLayer=otherId;});
      (sp.npcs||[]).forEach(function(n){if(npcLayer(n)===layer.id)n.sceneLayer=otherId;});
      sp.sceneLayers=sp.sceneLayers.filter(function(l){return l.id!==layer.id;});
      if(S.activeLayerId===layer.id)S.activeLayerId=sp.sceneLayers[0].id;
      renderLayersPanel();render();markDirty();
    };
    var realIdx=sp.sceneLayers.findIndex(function(l){return l.id===layer.id;});
    var upb=document.createElement('button');upb.className='ib';upb.title='Move Up (list order)';upb.textContent='\u25b2';
    upb.disabled=realIdx>=sp.sceneLayers.length-1;
    upb.onclick=function(e){e.stopPropagation();
      var i=sp.sceneLayers.findIndex(function(l){return l.id===layer.id;});
      if(i<sp.sceneLayers.length-1){var t=sp.sceneLayers[i];sp.sceneLayers[i]=sp.sceneLayers[i+1];sp.sceneLayers[i+1]=t;}
      renderLayersPanel();render();markDirty();
    };
    var dnb=document.createElement('button');dnb.className='ib';dnb.title='Move Down (list order)';dnb.textContent='\u25bc';
    dnb.disabled=realIdx<=0;
    dnb.onclick=function(e){e.stopPropagation();
      var i=sp.sceneLayers.findIndex(function(l){return l.id===layer.id;});
      if(i>0){var t=sp.sceneLayers[i];sp.sceneLayers[i]=sp.sceneLayers[i-1];sp.sceneLayers[i-1]=t;}
      renderLayersPanel();render();markDirty();
    };
    row.appendChild(vis);row.appendChild(lck);row.appendChild(nm);row.appendChild(upb);row.appendChild(dnb);row.appendChild(del);
    ll.appendChild(row);
  });
  refreshLayerPicker();
}
function refreshLayerPicker(){
  var ls=getLayers();
  var sel=document.getElementById('player'),cur=sel.value;
  sel.innerHTML='';
  ls.forEach(function(l){
    var opt=document.createElement('option');
    opt.value=String(l.id||'');
    opt.textContent=String(l.name||'');
    sel.appendChild(opt);
  });
  if(cur)sel.value=cur;
  var nsel=document.getElementById('nlayer'),ncur=nsel.value;
  nsel.innerHTML='';
  ls.forEach(function(l){
    var opt2=document.createElement('option');
    opt2.value=String(l.id||'');
    opt2.textContent=String(l.name||'');
    nsel.appendChild(opt2);
  });
  if(ncur)nsel.value=ncur;
}
document.getElementById('btnaddlayer').addEventListener('click',function(){
  if(!sp)return;
  var id='layer-'+Date.now();
  sp.sceneLayers.push({id:id,name:'Layer '+sp.sceneLayers.length,visible:true,locked:false});
  S.activeLayerId=id;renderLayersPanel();markDirty();
});
var canvas=document.getElementById('gc');
var ctx=canvas.getContext('2d');
// --- carved-terrain substrate -------------------------------------------------
// The room floor + wall ring are written by MAP GENERATION, not by the set-piece
// def, so the editor has no way to know them from set-pieces.json alone. Before
// this existed the editor filled the canvas with a black void (#090d12) and let
// the def's kind:'wall' props draw as blue-grey Kenney placeholders - so every
// prop in this editor was authored and judged against a background the player
// never sees. The lab had the same class of bug with a different wrong answer.
// Ids come from /substrate, which is pinned to the engine's terrain->art map by
// tests/unit/set-piece-lab-fidelity.test.ts.
var SUBSTRATE=null;
function substrateFor(id){
  if(!SUBSTRATE)return null;
  var o=(SUBSTRATE.bySetPiece||{})[id]||{},d=SUBSTRATE.default||{};
  return{floor:o.floorSpriteId||d.floorSpriteId,wall:o.wallSpriteId||d.wallSpriteId};
}
function drawTileImg(img,x,y,ts){
  ctx.drawImage(img,0,0,img.naturalWidth||16,img.naturalHeight||16,x*ts,y*ts,ts,ts);
}
function drawSubstrate(w,h,ts){
  // Fallback base: only visible until the tile PNGs load, or if they fail.
  ctx.fillStyle='#090d12';ctx.fillRect(0,0,w*ts,h*ts);
  var sub=substrateFor(sp&&sp.id);
  if(!sub)return;
  var floorImg=sub.floor?loadGenSprite(sub.floor):null;
  var wallImg=sub.wall?loadGenSprite(sub.wall):null;
  ctx.imageSmoothingEnabled=false;
  if(floorImg)for(var x=0;x<w;x++)for(var y=0;y<h;y++)drawTileImg(floorImg,x,y,ts);
  if(wallImg)for(var wx=0;wx<w;wx++)for(var wy=0;wy<h;wy++){
    if(wx!==0&&wy!==0&&wx!==w-1&&wy!==h-1)continue;
    drawTileImg(wallImg,wx,wy,ts);
  }
}
function render(){
  if(!sp)return;
  var ts=S.tileSize,w=sp.width,h=sp.height;
  canvas.width=w*ts;canvas.height=h*ts;
  drawSubstrate(w,h,ts);
  var chrome=S.showOverlay;
  if(chrome&&(S.snapMode==='half'||S.snapMode==='quarter')){
    ctx.strokeStyle='#141c26';ctx.lineWidth=1;
    var sub=S.snapMode==='quarter'?4:2;
    for(var hx=1;hx<w*sub;hx++){if(hx%sub===0)continue;ctx.beginPath();ctx.moveTo(hx*ts/sub,0);ctx.lineTo(hx*ts/sub,h*ts);ctx.stroke();}
    for(var hy=1;hy<h*sub;hy++){if(hy%sub===0)continue;ctx.beginPath();ctx.moveTo(0,hy*ts/sub);ctx.lineTo(w*ts,hy*ts/sub);ctx.stroke();}
  }
  ctx.strokeStyle='#1e2530';ctx.lineWidth=1;
  if(chrome){
  for(var gx=0;gx<=w;gx++){ctx.beginPath();ctx.moveTo(gx*ts,0);ctx.lineTo(gx*ts,h*ts);ctx.stroke();}
  for(var gy=0;gy<=h;gy++){ctx.beginPath();ctx.moveTo(0,gy*ts);ctx.lineTo(w*ts,gy*ts);ctx.stroke();}
  ctx.fillStyle='#ffffff0d';ctx.font='7px monospace';ctx.textAlign='left';ctx.textBaseline='top';
  for(var cx2=0;cx2<w;cx2++)for(var cy2=0;cy2<h;cy2++)ctx.fillText(cx2+','+cy2,cx2*ts+2,cy2*ts+2);
  }
  var drawables=[];
  sp.props.forEach(function(p,i){
    var lid=propLayer(p);
    if(!layerVisible(lid))return;
    drawables.push({kind:'prop',idx:i,z:propRenderZ(lid,getZ(p),i)});
  });
  (sp.npcs||[]).forEach(function(n,ni){
    var lid=npcLayer(n);
    if(!layerVisible(lid))return;
    drawables.push({kind:'npc',idx:ni,z:globalZ(lid,'npc',n.z)});
  });
  drawables.sort(function(a,b){
    if(a.z!==b.z)return a.z-b.z;
    if(a.kind!==b.kind)return a.kind==='npc'?-1:1;
    return a.idx-b.idx;
  });
  drawables.forEach(function(d){
    if(d.kind==='prop'){
      var p=sp.props[d.idx];
      var ad=null;
      if(drag&&drag.mode==='move'&&drag.idx===d.idx)ad=drag;
      else if(drag&&drag.mode==='move-group'&&drag.groupDisp&&drag.groupDisp[p.id])ad=drag.groupDisp[p.id];
      drawProp(p,(d.idx===S.selPropIdx)||isPropSelectedIndex(d.idx),ad);
    }else{
      var n=sp.npcs[d.idx];
      var nd=null;
      if(drag&&drag.mode==='move-npc'&&drag.idx===d.idx)nd=drag;
      else if(drag&&drag.mode==='move-npc-group'&&drag.groupDisp&&drag.groupDisp[n.id])nd=drag.groupDisp[n.id];
      drawNpcEntity(n,(d.idx===S.selNpcIdx)||isNpcSelectedIndex(d.idx),nd);
    }
  });
  if(S.selPropIdx>=0&&getSelectedPropIndices().length===1&&!drag){
    var sp2=sp.props[S.selPropIdx];
    if(sp2&&layerVisible(propLayer(sp2)))drawHandles(sp2.x*ts,sp2.y*ts,sp2.width||1,sp2.height||1);
  }else if(S.selPropIdx>=0&&getSelectedPropIndices().length===1&&drag&&drag.mode==='resize'){
    var sp3=sp.props[S.selPropIdx];
    if(sp3)drawHandles(drag.dispX,drag.dispY,drag.dispW/S.tileSize,drag.dispH/S.tileSize);
  }else if(S.selNpcIdx>=0&&getSelectedNpcIndices().length===1&&!drag){
    var sn=sp.npcs[S.selNpcIdx];
    if(sn&&layerVisible(npcLayer(sn))){
      var sns=npcSizeTiles(sn);
      drawHandles(nnum(sn.x,0)*ts,nnum(sn.y,0)*ts,sns.w,sns.h);
    }
  }else if(S.selNpcIdx>=0&&getSelectedNpcIndices().length===1&&drag&&drag.mode==='resize-npc'){
    drawHandles(drag.dispX,drag.dispY,drag.dispW/S.tileSize,drag.dispH/S.tileSize);
  }
}
function drawProp(prop,sel,ad){
  var ts=S.tileSize,pw=prop.width||1,ph=prop.height||1;
  var px,py;
  if(ad){px=nnum(ad.dispX,0);py=nnum(ad.dispY,0);}else{px=nnum(prop.x,0)*ts;py=nnum(prop.y,0)*ts;}
  var pw2=pw*ts,ph2=ph*ts;
  var locked=layerLocked(propLayer(prop));
  var C=KINDS[prop.kind]||KINDS.fixture;
  var layers=Array.isArray(prop.layers)?prop.layers:[];
  var sprited=false;
  // wall/door props are structural: the game does NOT draw them (their art is
  // the carved terrain, already painted by drawSubstrate) and drawing them again
  // here stacks a Kenney placeholder over the real wall tile. They stay
  // selectable - only their sprite is suppressed, never their box.
  var structural=prop.kind==='wall'||prop.kind==='door';
  if(structural)layers=[];
  layers.forEach(function(layer,layerIndex){
    if(!layer||!layer.sprite)return;
    var nativeTiles=layerIndex===0?{w:pw,h:ph}:getNativeSpriteTileDimensions(layer.sprite);
    var targetW=(layer.widthFt!==undefined&&layer.heightFt!==undefined)
      ?(Math.max(0.25,nnum(layer.widthFt,FEET_PER_TILE))/FEET_PER_TILE)*ts
      :(nativeTiles.w*ts);
    var targetH=(layer.widthFt!==undefined&&layer.heightFt!==undefined)
      ?(Math.max(0.25,nnum(layer.heightFt,FEET_PER_TILE))/FEET_PER_TILE)*ts
      :(nativeTiles.h*ts);
    var scale=Math.max(0.01,nnum(layer.scale,1));
    targetW*=scale;
    targetH*=scale;
    var offXPx=((nnum(layer.offsetX,0)/16)*ts)+((nnum(layer.offsetXFt,0)/FEET_PER_TILE)*ts);
    var offYPx=((nnum(layer.offsetY,0)/16)*ts)+((nnum(layer.offsetYFt,0)/FEET_PER_TILE)*ts);
    var cx=(px+pw2/2)+offXPx;
    var cy=(py+ph2/2)+offYPx;
    var rot=(normalizeRotationDeg(layer.rotationDeg)||0)*(Math.PI/180);
    var fx=layer.flipX===true?-1:1;
    var fy=layer.flipY===true?-1:1;
    var res=resolveSprite(layer.sprite);
    if(res){
      var nativeW=Math.max(1,nnum(res.w,16));
      var nativeH=Math.max(1,nnum(res.h,16));
      // Match the GAME's scale rule exactly (PhaserBridge.ts:1832-1838):
      //   upright (kind !== 'floor') -> scale = heightFt / nativeH; widthFt is
      //     IGNORED, the width follows the art's own aspect.
      //   floor decal (kind === 'floor', set by stampSetPiece.ts:313) -> both
      //     declared feet are real ground extents, so contain-fit them.
      // The editor used to contain-fit EVERYTHING, i.e. apply the floor-decal
      // rule to upright props. Whenever a declared widthFt was narrower than the
      // art's aspect, Math.min picked the width and the editor drew the prop
      // SHORTER than the game does - the welcome desk lost 34% of its width and
      // the banner drew at half size. An instrument that cannot show you the
      // defect is worse than no instrument.
      var fit;
      if(prop.kind==='floor'){
        fit=Math.min(targetW/nativeW,targetH/nativeH);
      }else{
        fit=targetH/nativeH;
      }
      if(!Number.isFinite(fit)||fit<=0)fit=1;
      var drawW=nativeW*fit;
      var drawH=nativeH*fit;
      ctx.save();ctx.imageSmoothingEnabled=false;
      ctx.translate(cx,cy);
      if(rot!==0)ctx.rotate(rot);
      if(fx!==1||fy!==1)ctx.scale(fx,fy);
      // Anchor: the game sets origin (0.5, 1) for anchorBase layers so a tall
      // object STANDS on its floor position and grows upward (PhaserBridge.ts
      // :1816). The editor always centre-anchored, so all 14 anchorBase props in
      // the welcome room were drawn half a body too low here relative to the
      // game. drawY is the offset of the sprite's top edge from the anchor point.
      var drawY=layer.anchorBase===true?-drawH:-drawH/2;
      var tinted=false;
      if(typeof layer.tintHex==='string'&&/^#[0-9a-fA-F]{6}$/.test(layer.tintHex)){
        var tintW=Math.max(1,Math.ceil(drawW));
        var tintH=Math.max(1,Math.ceil(drawH));
        var tintCanvas=document.createElement('canvas');
        tintCanvas.width=tintW;
        tintCanvas.height=tintH;
        var tintCtx=tintCanvas.getContext('2d');
        if(tintCtx){
          tintCtx.imageSmoothingEnabled=false;
          tintCtx.drawImage(res.img,res.sx,res.sy,res.w||16,res.h||16,0,0,tintW,tintH);
          tintCtx.globalCompositeOperation='multiply';
          tintCtx.fillStyle=layer.tintHex;
          tintCtx.fillRect(0,0,tintW,tintH);
          tintCtx.globalCompositeOperation='destination-atop';
          tintCtx.drawImage(res.img,res.sx,res.sy,res.w||16,res.h||16,0,0,tintW,tintH);
          tintCtx.globalCompositeOperation='source-over';
          ctx.drawImage(tintCanvas,-drawW/2,drawY,drawW,drawH);
          tinted=true;
        }
      }
      if(!tinted){
        ctx.drawImage(res.img,res.sx,res.sy,res.w||16,res.h||16,-drawW/2,drawY,drawW,drawH);
      }
      ctx.restore();
      sprited=true;
      return;
    }
    if(layer.sprite.source==='custom'&&!layer.sprite.placeholder){
      ctx.save();
      ctx.translate(cx,cy);
      if(rot!==0)ctx.rotate(rot);
      if(fx!==1||fy!==1)ctx.scale(fx,fy);
      ctx.fillStyle=C.bg;
      ctx.fillRect(-targetW/2,-targetH/2,targetW,targetH);
      ctx.fillStyle='#ff00ff33';
      ctx.fillRect(-targetW/2,-targetH/2,targetW,targetH);
      ctx.fillStyle='#ff00ff';ctx.font='bold 9px monospace';
      ctx.textAlign='center';ctx.textBaseline='middle';
      ctx.fillText('\u2736',0,0);
      ctx.restore();
      sprited=true;
    }
  });
  if(!sprited&&!structural){ctx.fillStyle=C.bg;ctx.fillRect(px+1,py+1,pw2-2,ph2-2);}
  // Structural props deliberately have no sprite here, so !sprited must not
  // force their box on - otherwise game-view is still boxed walls.
  var showBox=structural?(S.showOverlay||sel):(S.showOverlay||!sprited||sel);
  if(locked){ctx.fillStyle='rgba(0,0,0,0.38)';ctx.fillRect(px,py,pw2,ph2);}
  ctx.strokeStyle=sel?'#fff':C.bd;ctx.lineWidth=sel?2.5:1.5;
  if(showBox)ctx.strokeRect(px+1.5,py+1.5,pw2-3,ph2-3);
  if(showBox){
    ctx.fillStyle=C.lb;ctx.font='bold '+Math.min(11,ts*0.2)+'px system-ui';
    ctx.textAlign='left';ctx.textBaseline='top';
    ctx.fillText(truncT(prop.id,pw2-8),px+4,py+4);
  }
  if(locked){
    ctx.fillStyle='#ffffff88';ctx.font='10px system-ui';
    ctx.textAlign='center';ctx.textBaseline='middle';
    ctx.fillText('\uD83D\uDD12',px+pw2/2,py+ph2/2);
  }
}
// NPC entity rendering (separate from props — npcs[] array, spawned as living entities)
var NPC_BG='#0a1a28',NPC_BD='#1060a0',NPC_LB='#38bdf8';
function drawNpcEntity(npc,sel,nd){
  var ts=S.tileSize,px,py;
  if(nd){px=nnum(nd.dispX,0);py=nnum(nd.dispY,0);}else{px=nnum(npc.x,0)*ts;py=nnum(npc.y,0)*ts;}
  var size=npcSizeTiles(npc);
  var sw=Math.max(1,size.w*ts),sh=Math.max(1,size.h*ts);
  var mapped=GENERATED_NPC_SPRITE_BY_DEF[npc.npcTypeId];
  var ns=(npc&&npc.spriteOverride&&typeof npc.spriteOverride==='object')
    ?npc.spriteOverride
    :(mapped?{source:'catalog',spriteId:mapped}:{source:'catalog',spriteId:'sprite:npc.guide'});
  var res=resolveSprite(ns);
  if(!res){ctx.fillStyle=NPC_BG;ctx.fillRect(px+1,py+1,sw-2,sh-2);}
  if(res){
    ctx.save();ctx.imageSmoothingEnabled=false;
    var dw=sw-2,dh=sh-2,cx=px+1+dw/2,cy=py+1+dh/2;
    var rot=(normalizeRotationDeg(npc&&npc.rotationDeg)||0)*(Math.PI/180);
    var fx=(npc&&npc.flipX===true)?-1:1;
    var fy=(npc&&npc.flipY===true)?-1:1;
    ctx.translate(cx,cy);
    if(rot!==0)ctx.rotate(rot);
    if(fx!==1||fy!==1)ctx.scale(fx,fy);
    ctx.drawImage(res.img,res.sx,res.sy,res.w||16,res.h||16,-dw/2,-dh/2,dw,dh);
    ctx.restore();
  }
  // NPC boxes are chrome: game-view must hide them even when the sprite is
  // missing, or "what ships" is still an editor screenshot.
  var showNBox=S.showOverlay||sel;
  ctx.strokeStyle=sel?'#fff':NPC_BD;ctx.lineWidth=sel?2.5:1.5;
  if(showNBox)ctx.strokeRect(px+1.5,py+1.5,sw-3,sh-3);
  if(showNBox){
    ctx.fillStyle=NPC_LB;ctx.font='bold 7px system-ui';ctx.textAlign='left';ctx.textBaseline='top';
    ctx.fillText(truncT(npc.id,sw-6),px+3,py+3);
  }
  // Anchor role badge
  if(npc.anchorRole){
    ctx.fillStyle='rgba(0,0,0,.6)';var aw=ctx.measureText(npc.anchorRole).width+6;
    ctx.fillRect(px+(sw-aw)/2,py+sh-14,aw,12);
    ctx.fillStyle='#facc15';ctx.font='bold 7px system-ui';ctx.textAlign='center';ctx.textBaseline='top';
    ctx.fillText(npc.anchorRole,px+sw/2,py+sh-13);
  }
}
function truncT(txt,mx){
  if(ctx.measureText(txt).width<=mx)return txt;
  var t=txt;
  while(t.length>1&&ctx.measureText(t+'\u2026').width>mx)t=t.slice(0,-1);
  return t+'\u2026';
}
var HS=8;
function hpos(px,py,pw2,ph2){
  return[{x:px,y:py,dx:-1,dy:-1,t:'nw'},{x:px+pw2/2,y:py,dx:0,dy:-1,t:'n'},
    {x:px+pw2,y:py,dx:1,dy:-1,t:'ne'},{x:px+pw2,y:py+ph2/2,dx:1,dy:0,t:'e'},
    {x:px+pw2,y:py+ph2,dx:1,dy:1,t:'se'},{x:px+pw2/2,y:py+ph2,dx:0,dy:1,t:'s'},
    {x:px,y:py+ph2,dx:-1,dy:1,t:'sw'},{x:px,y:py+ph2/2,dx:-1,dy:0,t:'w'}];
}
function drawHandles(px,py,pw,ph){
  var ts=S.tileSize;
  ctx.fillStyle='#fff';ctx.strokeStyle='#1f6feb';ctx.lineWidth=1;
  hpos(px,py,pw*ts,ph*ts).forEach(function(h){
    ctx.fillRect(h.x-HS/2,h.y-HS/2,HS,HS);ctx.strokeRect(h.x-HS/2,h.y-HS/2,HS,HS);
  });
}
function hitHandle(prop,cx,cy){
  var ts=S.tileSize,pw=(prop.width||1),ph=(prop.height||1);
  var handles=hpos(nnum(prop.x,0)*ts,nnum(prop.y,0)*ts,pw*ts,ph*ts);
  for(var i=0;i<handles.length;i++){var h=handles[i];if(Math.abs(cx-h.x)<=HS&&Math.abs(cy-h.y)<=HS)return h;}
  return null;
}
function hitNpcHandle(npc,cx,cy){
  var ts=S.tileSize,ns=npcSizeTiles(npc);
  var handles=hpos(nnum(npc.x,0)*ts,nnum(npc.y,0)*ts,ns.w*ts,ns.h*ts);
  for(var i=0;i<handles.length;i++){var h=handles[i];if(Math.abs(cx-h.x)<=HS&&Math.abs(cy-h.y)<=HS)return h;}
  return null;
}
function hitProp(cx,cy){
  if(!sp)return-1;
  var ts=S.tileSize;
  var sorted=sp.props.map(function(p,i){return{p:p,i:i};})
    .filter(function(x){return layerVisible(propLayer(x.p))&&!layerLocked(propLayer(x.p));})
    .sort(function(a,b){return getZ(b.p)-getZ(a.p);});
  for(var i=0;i<sorted.length;i++){
    var p=sorted[i].p,pw=(p.width||1)*ts,ph=(p.height||1)*ts;
    var px=nnum(p.x,0)*ts,py=nnum(p.y,0)*ts;
    if(cx>=px&&cx<px+pw&&cy>=py&&cy<py+ph)return sorted[i].i;
  }
  return-1;
}
function hitNpc(cx,cy){
  if(!sp||!sp.npcs)return-1;
  var ts=S.tileSize;
  for(var i=sp.npcs.length-1;i>=0;i--){
    var n=sp.npcs[i];
    if(!layerVisible(npcLayer(n))||layerLocked(npcLayer(n)))continue;
    var nx=nnum(n.x,0),ny=nnum(n.y,0),ns=npcSizeTiles(n);
    if(cx>=nx*ts&&cx<((nx+ns.w)*ts)&&cy>=ny*ts&&cy<((ny+ns.h)*ts))return i;
  }
  return-1;
}
function hitTop(cx,cy){
  if(!sp)return null;
  var ts=S.tileSize;
  var hits=[];
  sp.props.forEach(function(p,i){
    var lid=propLayer(p);
    if(!layerVisible(lid)||layerLocked(lid))return;
    var pw=(p.width||1)*ts,ph=(p.height||1)*ts;
    var px=nnum(p.x,0)*ts,py=nnum(p.y,0)*ts;
    if(cx>=px&&cx<px+pw&&cy>=py&&cy<py+ph){
      hits.push({kind:'prop',idx:i,z:propRenderZ(lid,getZ(p),i)});
    }
  });
  (sp.npcs||[]).forEach(function(n,ni){
    var lid=npcLayer(n);
    if(!layerVisible(lid)||layerLocked(lid))return;
    var nx=nnum(n.x,0),ny=nnum(n.y,0),ns=npcSizeTiles(n);
    if(cx>=nx*ts&&cx<((nx+ns.w)*ts)&&cy>=ny*ts&&cy<((ny+ns.h)*ts)){
      hits.push({kind:'npc',idx:ni,z:globalZ(lid,'npc',n.z)});
    }
  });
  if(!hits.length)return null;
  hits.sort(function(a,b){return b.z-a.z;});
  return hits[0];
}
function snapV(v){
  if(S.snapMode==='tile')return Math.round(v);
  if(S.snapMode==='half')return Math.round(v*2)/2;
  if(S.snapMode==='quarter')return Math.round(v*4)/4;
  return Math.round(v*100)/100;
}
function snapSz(v){
  if(S.snapMode==='tile')return Math.max(1,Math.round(v));
  if(S.snapMode==='half')return Math.max(0.5,Math.round(v*2)/2);
  if(S.snapMode==='quarter')return Math.max(0.25,Math.round(v*4)/4);
  return Math.max(0.25,Math.round(v*100)/100);
}
var drag=null;
function cxy(e){var r=canvas.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top};}
canvas.addEventListener('mousedown',function(e){
  if(!sp)return;
  var pos=cxy(e);
  if(S.selPropIdx>=0&&getSelectedPropIndices().length===1){
    var p=sp.props[S.selPropIdx];
    if(!layerLocked(propLayer(p))){
      var h=hitHandle(p,pos.x,pos.y);
      if(h){var ts=S.tileSize;
        drag={mode:'resize',idx:S.selPropIdx,sx:pos.x,sy:pos.y,moved:false,
          orig:JSON.parse(JSON.stringify(p)),dispX:nnum(p.x,0)*ts,dispY:nnum(p.y,0)*ts,
          dispW:(p.width||1)*ts,dispH:(p.height||1)*ts,h:h};return;}
    }
  }
  if(S.selNpcIdx>=0&&getSelectedNpcIndices().length===1){
    var n0=sp.npcs[S.selNpcIdx];
    if(n0&&!layerLocked(npcLayer(n0))){
      var nh=hitNpcHandle(n0,pos.x,pos.y);
      if(nh){
        var tsn=S.tileSize,nsz=npcSizeTiles(n0);
        drag={mode:'resize-npc',idx:S.selNpcIdx,sx:pos.x,sy:pos.y,moved:false,
          orig:JSON.parse(JSON.stringify(n0)),dispX:nnum(n0.x,0)*tsn,dispY:nnum(n0.y,0)*tsn,
          dispW:nsz.w*tsn,dispH:nsz.h*tsn,h:nh};
        return;
      }
    }
  }
  var hit=hitTop(pos.x,pos.y);
  if(hit&&hit.kind==='npc'){
    if(e.shiftKey){toggleNpcSelection(hit.idx);updatePropPanel();render();return;}
    var ts3=S.tileSize;
    if(isNpcSelectedIndex(hit.idx)&&getSelectedNpcIndices().length>1){
      var nsel=getSelectedNpcIndices();
      var ngDisp={};
      nsel.forEach(function(ni){
        var gn=sp.npcs[ni];
        ngDisp[gn.id]={dispX:nnum(gn.x,0)*ts3,dispY:nnum(gn.y,0)*ts3};
      });
      drag={mode:'move-npc-group',idx:hit.idx,sx:pos.x,sy:pos.y,moved:false,groupOrig:nsel.map(function(ni){
        var gn=sp.npcs[ni],gns=npcSizeTiles(gn);
        return{idx:ni,id:gn.id,x:nnum(gn.x,0),y:nnum(gn.y,0),w:gns.w,h:gns.h};
      }),groupDisp:ngDisp};
    }else{
      setSingleNpcSelection(hit.idx);
      var nn=sp.npcs[hit.idx];
      drag={mode:'move-npc',idx:hit.idx,sx:pos.x,sy:pos.y,moved:false,
        orig:{x:nnum(nn.x,0),y:nnum(nn.y,0)},dispX:nnum(nn.x,0)*ts3,dispY:nnum(nn.y,0)*ts3};
    }
    updatePropPanel();render();return;
  }
  if(hit&&hit.kind==='prop'){
    var idx=hit.idx;
    if(e.shiftKey){togglePropSelection(idx);updatePropPanel();render();return;}
    var ts2=S.tileSize;
    if(isPropSelectedIndex(idx)&&getSelectedPropIndices().length>1){
      var selIdx=getSelectedPropIndices();
      var groupDisp={};
      selIdx.forEach(function(pi){
        var gp=sp.props[pi];
        groupDisp[gp.id]={dispX:nnum(gp.x,0)*ts2,dispY:nnum(gp.y,0)*ts2};
      });
      drag={mode:'move-group',idx:idx,sx:pos.x,sy:pos.y,moved:false,groupOrig:selIdx.map(function(pi){
        var gp=sp.props[pi];return{idx:pi,id:gp.id,x:nnum(gp.x,0),y:nnum(gp.y,0),w:gp.width||1,h:gp.height||1};
      }),groupDisp:groupDisp};
    }else{
      setSinglePropSelection(idx);var pp=sp.props[idx];
      drag={mode:'move',idx:idx,sx:pos.x,sy:pos.y,moved:false,
        orig:JSON.parse(JSON.stringify(pp)),dispX:nnum(pp.x,0)*ts2,dispY:nnum(pp.y,0)*ts2};
    }
    updatePropPanel();render();
  }else{clearSelection();drag=null;updatePropPanel();render();}
});
canvas.addEventListener('mousemove',function(e){
  hideCtxMenu();
  if(drag&&sp){
    var pos=cxy(e),ts=S.tileSize,dx=pos.x-drag.sx,dy=pos.y-drag.sy;
    if((dx*dx+dy*dy)>=9)drag.moved=true;
    if(drag.mode==='move-npc'){
      var dn=sp.npcs&&sp.npcs[drag.idx];
      var dns=npcSizeTiles(dn);
      drag.dispX=Math.max(0,Math.min(Math.max(0,(sp.width-dns.w))*ts,drag.orig.x*ts+dx));
      drag.dispY=Math.max(0,Math.min(Math.max(0,(sp.height-dns.h))*ts,drag.orig.y*ts+dy));
      render();return;
    }
    if(drag.mode==='move-npc-group'){
      var nd=clampGroupDeltaPx(drag.groupOrig,dx/ts,dy/ts,sp.width,sp.height);
      drag.groupOrig.forEach(function(it){
        var gx=(it.x+nd.dx)*ts;
        var gy=(it.y+nd.dy)*ts;
        drag.groupDisp[it.id]={dispX:gx,dispY:gy};
      });
      render();hideTooltip();return;
    }
    if(drag.mode==='move-group'){
      var pd=clampGroupDeltaPx(drag.groupOrig,dx/ts,dy/ts,sp.width,sp.height);
      drag.groupOrig.forEach(function(it){
        var gx=(it.x+pd.dx)*ts;
        var gy=(it.y+pd.dy)*ts;
        drag.groupDisp[it.id]={dispX:gx,dispY:gy};
      });
      render();hideTooltip();return;
    }
    var p=sp.props[drag.idx];
    if(drag.mode==='move'){
      if(!p)return;
      var pw=(p.width||1)*ts,ph=(p.height||1)*ts;
      drag.dispX=Math.max(0,Math.min(sp.width*ts-pw,drag.orig.x*ts+dx));
      drag.dispY=Math.max(0,Math.min(sp.height*ts-ph,drag.orig.y*ts+dy));
    }else if(drag.mode==='resize'){
      if(!p)return;
      var h=drag.h,o=drag.orig;
      var nx=o.x*ts,ny=o.y*ts,nw=(o.width||1)*ts,nh=(o.height||1)*ts;
      var minPx=0.25*ts;
      if(h.dx<0){var dd=Math.min(dx,nw-minPx);nx=o.x*ts+dd;nw=(o.width||1)*ts-dd;}
      else if(h.dx>0){nw=Math.max(minPx,(o.width||1)*ts+dx);}
      if(h.dy<0){var de=Math.min(dy,nh-minPx);ny=o.y*ts+de;nh=(o.height||1)*ts-de;}
      else if(h.dy>0){nh=Math.max(minPx,(o.height||1)*ts+dy);}
      var ar=enforceAspectRect(o.x*ts,o.y*ts,(o.width||1)*ts,(o.height||1)*ts,nx,ny,nw,nh,h);
      nx=ar.nx;ny=ar.ny;nw=ar.nw;nh=ar.nh;
      var cl=clampResizeRectToBounds(
        o.x*ts,o.y*ts,(o.width||1)*ts,(o.height||1)*ts,nx,ny,nw,nh,h,sp.width*ts,sp.height*ts
      );
      nx=cl.nx;ny=cl.ny;nw=cl.nw;nh=cl.nh;
      drag.dispX=nx;drag.dispY=ny;drag.dispW=nw;drag.dispH=nh;
    }else if(drag.mode==='resize-npc'){
      var n1=sp.npcs&&sp.npcs[drag.idx];
      if(!n1)return;
      var h2=drag.h,o2=drag.orig,ons=npcSizeTiles(o2);
      var nx2=nnum(o2.x,0)*ts,ny2=nnum(o2.y,0)*ts,nw2=ons.w*ts,nh2=ons.h*ts;
      var minPx2=0.25*ts;
      if(h2.dx<0){var dd2=Math.min(dx,nw2-minPx2);nx2=nnum(o2.x,0)*ts+dd2;nw2=ons.w*ts-dd2;}
      else if(h2.dx>0){nw2=Math.max(minPx2,ons.w*ts+dx);}
      if(h2.dy<0){var de2=Math.min(dy,nh2-minPx2);ny2=nnum(o2.y,0)*ts+de2;nh2=ons.h*ts-de2;}
      else if(h2.dy>0){nh2=Math.max(minPx2,ons.h*ts+dy);}
      var ar2=enforceAspectRect(nnum(o2.x,0)*ts,nnum(o2.y,0)*ts,ons.w*ts,ons.h*ts,nx2,ny2,nw2,nh2,h2);
      nx2=ar2.nx;ny2=ar2.ny;nw2=ar2.nw;nh2=ar2.nh;
      var cl2=clampResizeRectToBounds(
        nnum(o2.x,0)*ts,nnum(o2.y,0)*ts,ons.w*ts,ons.h*ts,nx2,ny2,nw2,nh2,h2,sp.width*ts,sp.height*ts
      );
      nx2=cl2.nx;ny2=cl2.ny;nw2=cl2.nw;nh2=cl2.nh;
      drag.dispX=nx2;drag.dispY=ny2;drag.dispW=nw2;drag.dispH=nh2;
    }
    render();
    hideTooltip();return;
  }
  if(sp){
    var hp=cxy(e);
    var ht=hitTop(hp.x,hp.y);
    if(ht){showTooltipForHit(ht,e.clientX,e.clientY);}else{hideTooltip();}
  }
});
canvas.addEventListener('mouseup',function(){
  if(!drag||!sp)return;
  var ts=S.tileSize;
  if(!drag.moved){drag=null;render();return;}
  if(drag.mode==='move-npc'){
    var n=sp.npcs&&sp.npcs[drag.idx];
    if(n){
      var ns=npcSizeTiles(n);
      n.x=snapNpcCenter(drag.dispX,ts,ns.w,sp.width||1);
      n.y=snapNpcCenter(drag.dispY,ts,ns.h,sp.height||1);
      refreshNpcInputs();markDirty();
    }
    drag=null;render();return;
  }
  if(drag.mode==='move-npc-group'){
    drag.groupOrig.forEach(function(it){
      var gn=sp.npcs[it.idx];if(!gn)return;
      var gd=drag.groupDisp[it.id];if(!gd)return;
      gn.x=snapNpcCenter(gd.dispX,ts,it.w,sp.width||1);
      gn.y=snapNpcCenter(gd.dispY,ts,it.h,sp.height||1);
    });
    refreshNpcInputs();markDirty();
    drag=null;render();return;
  }
  if(drag.mode==='resize-npc'){
    var rn=sp.npcs&&sp.npcs[drag.idx];
    if(rn){
      var rw=Math.max(0.25,snapSz(drag.dispW/ts));
      var rh=Math.max(0.25,snapSz(drag.dispH/ts));
      rn.widthFt=rw*FEET_PER_TILE;
      rn.heightFt=rh*FEET_PER_TILE;
      var rns=npcSizeTiles(rn);
      rn.x=snapNpcCenter(drag.dispX,ts,rns.w,sp.width||1);
      rn.y=snapNpcCenter(drag.dispY,ts,rns.h,sp.height||1);
      refreshNpcInputs();markDirty();
    }
    drag=null;render();return;
  }
  var p=sp.props[drag.idx];
  if(p){
    if(drag.mode==='move'){
      p.x=snapV(drag.dispX/ts);p.y=snapV(drag.dispY/ts);
      p.x=nnum(p.x,0);p.y=nnum(p.y,0);
      p.x=Math.max(0,Math.min(sp.width-(p.width||1),p.x));
      p.y=Math.max(0,Math.min(sp.height-(p.height||1),p.y));
    }else if(drag.mode==='move-group'){
      drag.groupOrig.forEach(function(it){
        var gp=sp.props[it.idx];if(!gp)return;
        var gd=drag.groupDisp[it.id];if(!gd)return;
        gp.x=nnum(snapV(gd.dispX/ts),0);gp.y=nnum(snapV(gd.dispY/ts),0);
        gp.x=Math.max(0,Math.min(sp.width-(gp.width||1),gp.x));
        gp.y=Math.max(0,Math.min(sp.height-(gp.height||1),gp.y));
      });
    }else{
      p.x=Math.max(0,nnum(snapV(drag.dispX/ts),0));p.y=Math.max(0,nnum(snapV(drag.dispY/ts),0));
      var prevDW=Math.max(0.0001,nnum(p.width,1)),prevDH=Math.max(0.0001,nnum(p.height,1));
      p.width=snapSz(drag.dispW/ts);p.height=snapSz(drag.dispH/ts);
      p.width=Math.min(p.width,sp.width-p.x);p.height=Math.min(p.height,sp.height-p.y);
      var baseLayer=p.layers&&p.layers[0];
      if(baseLayer&&baseLayer.widthFt!==undefined&&baseLayer.heightFt!==undefined){
        // Scale the render size with the footprint instead of forcing them
        // equal - see the note in syncPropInputs. Forcing flattened every
        // deliberate overhang (the door's 5.75x8ft leaf on a 1x1 footprint)
        // the first time anyone dragged a resize handle.
        if(p.width!==prevDW)baseLayer.widthFt=baseLayer.widthFt*(p.width/prevDW);
        if(p.height!==prevDH)baseLayer.heightFt=baseLayer.heightFt*(p.height/prevDH);
      }
    }
    refreshPropInputs();markDirty();
  }
  drag=null;render();
});
canvas.addEventListener('mouseleave',function(){drag=null;render();hideTooltip();});
canvas.addEventListener('mousemove',function(e){
  if(drag)return;var pos=cxy(e);
  var CRS={nw:'nw-resize',ne:'ne-resize',sw:'sw-resize',se:'se-resize',
    n:'n-resize',s:'s-resize',e:'e-resize',w:'w-resize'};
  if(S.selPropIdx>=0&&getSelectedPropIndices().length===1){
    var p=sp.props[S.selPropIdx];
    if(!layerLocked(propLayer(p))){var h=hitHandle(p,pos.x,pos.y);if(h){canvas.style.cursor=CRS[h.t]||'crosshair';return;}}
  }
  if(S.selNpcIdx>=0&&getSelectedNpcIndices().length===1){
    var n=sp.npcs[S.selNpcIdx];
    if(!layerLocked(npcLayer(n))){var nh=hitNpcHandle(n,pos.x,pos.y);if(nh){canvas.style.cursor=CRS[nh.t]||'crosshair';return;}}
  }
  canvas.style.cursor=hitTop(pos.x,pos.y)?'grab':'default';
},true);
// ── Tooltip ──────────────────────────────────────────────────────────────────
var ttEl=document.getElementById('tooltip');
function hideTooltip(){ttEl.style.display='none';}
function showTooltipForHit(ht,cx,cy){
  var lines=[];
  if(ht.kind==='prop'){
    var p=sp.props[ht.idx];
    var lname=(getLayers().find(function(l){return l.id===propLayer(p);})||{name:'?'}).name;
    lines.push('\uD83D\uDDFA\uFE0F '+p.id);
    lines.push('kind: '+p.kind);
    lines.push('pos: '+(p.x||0)+', '+(p.y||0));
    lines.push('size: '+(p.width||1)+'\u00d7'+(p.height||1)+' tiles');
    lines.push('layer: '+lname);
    if(p.z!==undefined)lines.push('z: '+p.z);else lines.push('z: auto ('+getZ(p)+')');
  }else{
    var n=sp.npcs[ht.idx];
    var lname2=(getLayers().find(function(l){return l.id===npcLayer(n);})||{name:'?'}).name;
    var ns=npcSizeTiles(n);
    lines.push('\uD83E\uDDCD NPC: '+n.id);
    lines.push('type: '+n.npcTypeId);
    lines.push('sprite: '+renderNpcSpriteLabel(n));
    lines.push('pos: '+(n.x||0)+', '+(n.y||0));
    lines.push('size: '+ns.w.toFixed(2)+'\u00d7'+ns.h.toFixed(2)+' tiles');
    lines.push('layer: '+lname2);
    if(n.z!==undefined)lines.push('z: '+n.z);else lines.push('z: auto ('+ENTITY_DEPTH+' entity depth)');
    if(n.anchorRole)lines.push('anchor: '+n.anchorRole);
  }
  ttEl.textContent=lines.join('\\n');
  var vw=window.innerWidth,vh=window.innerHeight;
  var tx=cx+14,ty=cy+8;
  ttEl.style.display='block';
  var tw=ttEl.offsetWidth,th=ttEl.offsetHeight;
  if(tx+tw>vw-4)tx=cx-tw-8;
  if(ty+th>vh-4)ty=cy-th-8;
  ttEl.style.left=tx+'px';ttEl.style.top=ty+'px';
}
// ── Context menu ─────────────────────────────────────────────────────────────
var ctxEl=document.getElementById('ctxmenu');
function hideCtxMenu(){ctxEl.style.display='none';}
function mkCtxItem(label,cls,fn){
  var d=document.createElement('div');d.className='ctxi'+(cls?' '+cls:'');d.textContent=label;
  d.onmousedown=function(e){e.stopPropagation();hideCtxMenu();fn();};return d;
}
function mkCtxSep(){var d=document.createElement('div');d.className='ctxsep';return d;}
canvas.addEventListener('contextmenu',function(e){
  e.preventDefault();
  if(!sp)return;
  var pos=cxy(e);
  var ht=hitTop(pos.x,pos.y);
  if(!ht){hideCtxMenu();return;}
  // Keep existing multi-selection if the hit item is already selected.
  if(ht.kind==='prop'){
    if(!isPropSelectedIndex(ht.idx))setSinglePropSelection(ht.idx);
  }else{
    if(!isNpcSelectedIndex(ht.idx))setSingleNpcSelection(ht.idx);
  }
  updatePropPanel();render();
  // Build menu
  ctxEl.innerHTML='';
  if(ht.kind==='prop'){
    var p=sp.props[ht.idx];
    var selectedCount=getSelectedPropIndices().length||1;
    ctxEl.appendChild(mkCtxItem('\u25b2 Move to Front','',function(){
      if(selectedCount>1)moveSelectedPropsToFront();
      else{
        var lid=propLayer(p);
        var zs=sp.props.filter(function(q){return propLayer(q)===lid;}).map(function(q){return getZ(q);});
        p.z=Math.max.apply(null,zs)+1;refreshPropInputs();render();markDirty();
      }
    }));
    ctxEl.appendChild(mkCtxItem('\u25bc Send to Back','',function(){
      if(selectedCount>1)moveSelectedPropsToBack();
      else{
        var lid=propLayer(p);
        var zs=sp.props.filter(function(q){return propLayer(q)===lid;}).map(function(q){return getZ(q);});
        p.z=Math.min.apply(null,zs)-1;refreshPropInputs();render();markDirty();
      }
    }));
    ctxEl.appendChild(mkCtxSep());
    ctxEl.appendChild(mkCtxItem('\u21bb Rotate +90\u00b0','',function(){
      rotateSelectedProps(90);
    }));
    ctxEl.appendChild(mkCtxItem('\u21ba Rotate -90\u00b0','',function(){
      rotateSelectedProps(-90);
    }));
    ctxEl.appendChild(mkCtxItem('\u21cb Mirror Horizontal','',function(){
      mirrorSelectedProps('x');
    }));
    ctxEl.appendChild(mkCtxItem('\u21c5 Mirror Vertical','',function(){
      mirrorSelectedProps('y');
    }));
    ctxEl.appendChild(mkCtxSep());
    ctxEl.appendChild(mkCtxItem('\u29C8 Duplicate','',function(){
      copySelection();pasteClipboard();
    }));
    ctxEl.appendChild(mkCtxItem(selectedCount>1?'\u2715 Delete Selected':'\u2715 Delete','danger',function(){
      deleteSelected(false);
    }));
  }else{
    var n=sp.npcs[ht.idx];
    var selectedNpcCount=getSelectedNpcIndices().length||1;
    ctxEl.appendChild(mkCtxItem('\u25b2 Move to Front','',function(){
      if(selectedNpcCount>1)moveSelectedNpcsToFront();
      else{
        var nlid=npcLayer(n);
        var zs=(sp.npcs||[]).filter(function(q){return npcLayer(q)===nlid;}).map(function(q){return getNpcZ(q);});
        n.z=Math.max.apply(null,zs)+1;refreshNpcInputs();render();markDirty();
      }
    }));
    ctxEl.appendChild(mkCtxItem('\u25bc Send to Back','',function(){
      if(selectedNpcCount>1)moveSelectedNpcsToBack();
      else{
        var nlid=npcLayer(n);
        var zs=(sp.npcs||[]).filter(function(q){return npcLayer(q)===nlid;}).map(function(q){return getNpcZ(q);});
        n.z=Math.min.apply(null,zs)-1;refreshNpcInputs();render();markDirty();
      }
    }));
    ctxEl.appendChild(mkCtxSep());
    ctxEl.appendChild(mkCtxItem('\u21bb Rotate +90\u00b0','',function(){
      rotateSelectedNpcs(90);
    }));
    ctxEl.appendChild(mkCtxItem('\u21ba Rotate -90\u00b0','',function(){
      rotateSelectedNpcs(-90);
    }));
    ctxEl.appendChild(mkCtxItem('\u21cb Mirror Horizontal','',function(){
      mirrorSelectedNpcs('x');
    }));
    ctxEl.appendChild(mkCtxItem('\u21c5 Mirror Vertical','',function(){
      mirrorSelectedNpcs('y');
    }));
    ctxEl.appendChild(mkCtxSep());
    ctxEl.appendChild(mkCtxItem('\u29C8 Duplicate','',function(){
      copySelection();pasteClipboard();
    }));
    ctxEl.appendChild(mkCtxItem(selectedNpcCount>1?'\u2715 Delete Selected':'\u2715 Delete NPC','danger',function(){
      deleteSelected(false);
    }));
  }
  var vw=window.innerWidth,vh=window.innerHeight;
  ctxEl.style.display='block';
  var mw=ctxEl.offsetWidth,mh=ctxEl.offsetHeight;
  var mx=e.clientX,my=e.clientY;
  if(mx+mw>vw-4)mx=e.clientX-mw;
  if(my+mh>vh-4)my=e.clientY-mh;
  ctxEl.style.left=mx+'px';ctxEl.style.top=my+'px';
});
document.addEventListener('mousedown',function(e){
  if(!ctxEl.contains(e.target))hideCtxMenu();
});
function updatePropPanel(){
  var ns=document.getElementById('nosel'),ed=document.getElementById('proped'),ne=document.getElementById('npcped'),
    me=document.getElementById('multiproped'),mne=document.getElementById('multinpcped');
  var spSel=getSelectedPropIndices(),snSel=getSelectedNpcIndices();
  document.getElementById('btndel').disabled=S.selPropIdx<0&&S.selNpcIdx<0&&!getSelectedPropIndices().length&&!getSelectedNpcIndices().length;
  syncArtVariantBtn();
  if(snSel.length>1){
    ns.style.display='none';ed.style.display='none';me.style.display='none';ne.style.display='none';mne.style.display='';
    updateMultiNpcPanel();
    return;
  }
  mne.style.display='none';
  if(S.selNpcIdx>=0&&sp){ns.style.display='none';ed.style.display='none';me.style.display='none';ne.style.display='';refreshNpcInputs();return;}
  ne.style.display='none';
  if(spSel.length>1){
    ns.style.display='none';ed.style.display='none';me.style.display='';updateMultiPropPanel();return;
  }
  me.style.display='none';
  if(S.selPropIdx<0||!sp){ns.style.display='';ed.style.display='none';return;}
  ns.style.display='none';ed.style.display='';
  refreshPropInputs();refreshSprites();
}
function updateMultiPropPanel(){
  var ps=getSelectedProps();
  document.getElementById('mps-count').value=String(ps.length);
  var sameLayer=selectedPropsShareLayer();
  document.getElementById('mps-layer').value=sameLayer?(getLayers().find(function(l){return l.id===propLayer(ps[0]);})||{name:propLayer(ps[0])}).name:'(mixed)';
  document.getElementById('mps-pick').disabled=!ps.length;
}
function updateMultiNpcPanel(){
  var ns=getSelectedNpcs();
  document.getElementById('mns-count').value=String(ns.length);
  document.getElementById('mns-pick').disabled=!ns.length;
}
function refreshNpcInputs(){
  var n=sp&&sp.npcs&&sp.npcs[S.selNpcIdx];if(!n)return;
  document.getElementById('nid').value=n.id;
  document.getElementById('ntype').value=n.npcTypeId;
  document.getElementById('ntypesprite').value=renderNpcSpriteLabel(n);
  document.getElementById('nxf').value=n.x;
  document.getElementById('nyf').value=n.y;
  document.getElementById('nwf').value=Math.max(0.25,nnum(n.widthFt,2.5));
  document.getElementById('nhf').value=Math.max(0.25,nnum(n.heightFt,3.5));
  document.getElementById('nrot').value=Number.isFinite(nnum(n.rotationDeg,NaN))?normalizeRotationDeg(n.rotationDeg):0;
  document.getElementById('nflipx').checked=n.flipX===true;
  document.getElementById('nflipy').checked=n.flipY===true;
  document.getElementById('nlayer').value=npcLayer(n);
  document.getElementById('nz').value=n.z!==undefined?n.z:'';
  document.getElementById('nanchor').value=n.anchorRole||'';
}
function refreshPropInputs(){
  var p=sp&&sp.props[S.selPropIdx];if(!p)return;
  document.getElementById('pid').value=p.id;
  document.getElementById('pkind').value=p.kind;
  document.getElementById('px').value=p.x;
  document.getElementById('py').value=p.y;
  var w=p.width||1,h=p.height||1;
  if(S.propSizeUnit==='feet'){w*=FEET_PER_TILE;h*=FEET_PER_TILE;}
  document.getElementById('pw').value=w;
  document.getElementById('ph').value=h;
  document.getElementById('pz').value=p.z!==undefined?p.z:'';
  document.getElementById('player').value=propLayer(p);
  // w/h edit the FOOTPRINT. The art is drawn at layer widthFt/heightFt, which
  // is legitimately different (deliberate overhang). Surface that instead of
  // letting the panel imply the footprint is the render size - 20 of 58
  // welcome-room props differ, and a panel that hides it is an instrument that
  // cannot show you the defect.
  var rs=document.getElementById('prendersz');
  var bl=p.layers&&p.layers[0];
  if(bl&&bl.widthFt!==undefined&&bl.heightFt!==undefined&&
     (Math.abs(bl.widthFt-(p.width||1)*FEET_PER_TILE)>0.01||
      Math.abs(bl.heightFt-(p.height||1)*FEET_PER_TILE)>0.01)){
    rs.textContent='art drawn '+rnd2(bl.widthFt)+' x '+rnd2(bl.heightFt)+' ft (overhangs footprint)';
    rs.style.display='block';
  }else{rs.style.display='none';}
}
function rnd2(v){return Math.round(v*100)/100;}
function refreshSprites(){
  var p=sp&&sp.props[S.selPropIdx];if(!p)return;
  var list=document.getElementById('spriteslist');list.innerHTML='';
  (p.layers||[]).forEach(function(layer,li){list.appendChild(mkSpriteEl(layer,li,p));});
}
function mkSpriteEl(layer,li,prop){
  var div=document.createElement('div');div.className='si';
  var hd=document.createElement('div');hd.className='sh';
  var lb=document.createElement('span');lb.style.flex='1';lb.textContent='Sprite '+(li+1);
  hd.appendChild(lb);
  if(prop.layers.length>1){
    var dl=document.createElement('button');dl.className='ib';dl.textContent='\u00D7';dl.title='Remove';
    dl.onclick=function(e){e.stopPropagation();prop.layers.splice(li,1);refreshSprites();render();markDirty();};
    hd.appendChild(dl);
  }
  var bd=document.createElement('div');bd.className='sb';
  bd.appendChild(mkSpriteFields(layer.sprite,li));
  div.appendChild(hd);div.appendChild(bd);return div;
}
var KNOWNSHEETS=Object.keys(SHEETS_META);
function mkSpriteFields(sprite,li){
  var frag=document.createDocumentFragment();
  var sr=mkFR('source');var ss=document.createElement('select');
  ['catalog','sheet','custom'].forEach(function(v){var o=document.createElement('option');o.value=v;o.textContent=v;ss.appendChild(o);});
  ss.value=sprite.source;
  ss.onchange=function(){setSprSrc(li,ss.value);};
  sr.appendChild(ss);frag.appendChild(sr);
  if(sprite.source==='catalog'){
    var rcat=mkFR('sprite');
    var cur=sprite.spriteId||'';
    var clbl=document.createElement('span');
    clbl.textContent=cur?cur.replace('sprite:',''):'(none)';
    clbl.style.cssText='flex:1;font-size:11px;color:var(--text-color-muted,#8b949e);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    var cpick=document.createElement('button');cpick.className='pickbtn';cpick.textContent='Pick...';
    (function(li2){cpick.onclick=function(){openGallery(S.selPropIdx,li2,{tab:'catalog'});};})(li);
    rcat.appendChild(clbl);rcat.appendChild(cpick);frag.appendChild(rcat);
  }else if(sprite.source==='sheet'){
    var kr=mkFR('sheet');var ks=document.createElement('select');
    KNOWNSHEETS.forEach(function(k){var o=document.createElement('option');o.value=k;o.textContent=k.replace('kenney-','');if(sprite.sheetKey===k)o.selected=true;ks.appendChild(o);});
    ks.onchange=function(){setSprFld(li,'sheetKey',ks.value);};
    kr.appendChild(ks);frag.appendChild(kr);
    var pr=document.createElement('div');pr.className='pr';
    [['col','col'],['row','row']].forEach(function(t){
      var r2=mkFR(t[1]);var i2=document.createElement('input');
      i2.type='number';i2.min='0';i2.step='1';i2.value=sprite[t[0]]||0;
      i2.onchange=function(){setSprFld(li,t[0],parseInt(i2.value)||0);};
      r2.appendChild(i2);pr.appendChild(r2);
    });
    frag.appendChild(pr);
    var spr=mkFR('picker');
    var spick=document.createElement('button');spick.className='pickbtn';spick.textContent='Pick...';
    (function(li2,sk){spick.onclick=function(){openGallery(S.selPropIdx,li2,{tab:'sheet',sheetKey:sk||'kenney-tiny-dungeon'});};})(li,sprite.sheetKey);
    spr.appendChild(spick);frag.appendChild(spr);
  }else if(sprite.source==='custom'){
    [['requestId','reqId','my-sprite'],['label','label','Label'],['prompt','prompt','Art prompt']].forEach(function(t){
      var r3=mkFR(t[1]);var i3=document.createElement('input');
      i3.type='text';i3.value=sprite[t[0]]||'';i3.placeholder=t[2];
      i3.onchange=function(){setSprFld(li,t[0],i3.value);};
      r3.appendChild(i3);frag.appendChild(r3);
    });
  }
  return frag;
}
function mkFR(lb){
  var r=document.createElement('div');r.className='fr';
  var l=document.createElement('label');l.textContent=lb;r.appendChild(l);return r;
}
function setSprSrc(li,src){
  var p=sp.props[S.selPropIdx];
  var defs={catalog:{source:'catalog',spriteId:'sprite:player'},
    sheet:{source:'sheet',sheetKey:'kenney-tiny-dungeon',col:0,row:0},
    custom:{source:'custom',requestId:'new-sprite',label:'New',prompt:'Pixel art'}};
  p.layers[li].sprite=defs[src]||defs.catalog;
  refreshSprites();render();markDirty();
}
function setSprFld(li,f,v){sp.props[S.selPropIdx].layers[li].sprite[f]=v;render();markDirty();}
['pid','pkind','px','py','pw','ph','pz'].forEach(function(id){
  document.getElementById(id).addEventListener('change',syncPropInputs);
});
document.getElementById('pwhu').addEventListener('change',function(){
  S.propSizeUnit=document.getElementById('pwhu').value;
  refreshPropInputs();
});
document.getElementById('player').addEventListener('change',function(){
  var p=sp&&sp.props[S.selPropIdx];if(!p)return;
  p.sceneLayer=document.getElementById('player').value;render();markDirty();
});
function syncPropInputs(ev){
  var p=sp&&sp.props[S.selPropIdx];if(!p)return;
  var oldId=p.id;
  p.id=document.getElementById('pid').value||p.id;
  if(oldId!==p.id&&S.selPropIds[oldId]){delete S.selPropIds[oldId];S.selPropIds[p.id]=true;}
  p.kind=document.getElementById('pkind').value;
  p.x=parseFloat(document.getElementById('px').value)||0;
  p.y=parseFloat(document.getElementById('py').value)||0;
  var prevW=Math.max(0.0001,nnum(p.width,1)),prevH=Math.max(0.0001,nnum(p.height,1));
  var wv=parseFloat(document.getElementById('pw').value)||1;
  var hv=parseFloat(document.getElementById('ph').value)||1;
  if(S.propSizeUnit==='feet'){wv=wv/FEET_PER_TILE;hv=hv/FEET_PER_TILE;}
  if(S.keepAspect){
    // Which field the user edited must come from the EVENT TARGET, not
    // document.activeElement. These inputs fire 'change', which for typed text
    // fires on BLUR - by then activeElement is whatever was clicked next, so
    // neither branch matched and keep-aspect silently did nothing. Stepper
    // arrows fire 'change' while still focused, which is why it appeared to
    // work only with up/down.
    var ar=Math.max(0.0001,prevW/prevH);
    var aid=(ev&&ev.target&&ev.target.id)||'';
    if(aid==='pw')hv=wv/ar;
    else if(aid==='ph')wv=hv*ar;
  }
  p.width=wv;
  p.height=hv;
  var baseLayer=p.layers&&p.layers[0];
  if(baseLayer&&baseLayer.widthFt!==undefined&&baseLayer.heightFt!==undefined){
    // The size box edits the FOOTPRINT; layer feet are the independently
    // authored RENDER size and are legitimately different (the door is a 1x1
    // footprint drawn 5.75x8ft, deliberate overhang for the 3/4-view leaf).
    // This used to force feet = footprint*4 on EVERY field change, so merely
    // renaming or nudging a prop silently rewrote its art scale - 20 of 58
    // welcome-room props carry such a mismatch. Scale proportionally instead,
    // and leave it untouched when the footprint did not change.
    if(wv!==prevW)baseLayer.widthFt=baseLayer.widthFt*(wv/prevW);
    if(hv!==prevH)baseLayer.heightFt=baseLayer.heightFt*(hv/prevH);
  }
  var zv=document.getElementById('pz').value.trim();
  if(zv===''){delete p.z;}else{p.z=parseInt(zv);}
  render();markDirty();
}
function syncNpcInputs(ev){
  var n=sp&&sp.npcs&&sp.npcs[S.selNpcIdx];if(!n)return;
  var oldId=n.id;
  var nidv=document.getElementById('nid').value.trim();if(nidv)n.id=nidv;
  if(oldId!==n.id&&S.selNpcIds[oldId]){delete S.selNpcIds[oldId];S.selNpcIds[n.id]=true;}
  n.npcTypeId=document.getElementById('ntype').value.trim();
  var nwv=Math.max(0.25,nnum(parseFloat(document.getElementById('nwf').value),2.5));
  var nhv=Math.max(0.25,nnum(parseFloat(document.getElementById('nhf').value),3.5));
  if(S.keepAspect){
    // Event target, not activeElement - see the note in syncPropInputs.
    var nar=Math.max(0.0001,nnum(n.widthFt,2.5)/Math.max(0.0001,nnum(n.heightFt,3.5)));
    var naid=(ev&&ev.target&&ev.target.id)||'';
    if(naid==='nwf')nhv=nwv/nar;
    else if(naid==='nhf')nwv=nhv*nar;
  }
  n.widthFt=nwv;
  n.heightFt=nhv;
  var ns=npcSizeTiles(n);
  n.x=clampNpcCoord(parseFloat(document.getElementById('nxf').value),(sp.width||1)-ns.w+0.001);
  n.y=clampNpcCoord(parseFloat(document.getElementById('nyf').value),(sp.height||1)-ns.h+0.001);
  n.sceneLayer=document.getElementById('nlayer').value;
  var nz=document.getElementById('nz').value.trim();
  if(nz===''){delete n.z;}else{n.z=parseInt(nz);}
  n.rotationDeg=normalizeRotationDeg(parseFloat(document.getElementById('nrot').value)||0);
  n.flipX=document.getElementById('nflipx').checked===true;
  n.flipY=document.getElementById('nflipy').checked===true;
  var anch=document.getElementById('nanchor').value;
  if(anch)n.anchorRole=anch;else delete n.anchorRole;
  document.getElementById('ntypesprite').value=renderNpcSpriteLabel(n);
  render();markDirty();
}
['nid','ntype','nxf','nyf','nwf','nhf','nrot','nflipx','nflipy','nlayer','nz','nanchor'].forEach(function(id){
  document.getElementById(id).addEventListener('change',syncNpcInputs);
});
document.getElementById('btnadd').addEventListener('click',function(){
  if(!sp)return;
  var al=getActiveLayer();
  sp.props.push({id:'prop-'+Date.now(),kind:'furniture',x:0,y:0,width:1,height:1,
    sceneLayer:al.id,layers:[{sprite:{source:'sheet',sheetKey:'kenney-tiny-dungeon',col:0,row:0}}]});
  setSinglePropSelection(sp.props.length-1);updatePropPanel();render();markDirty();
});
document.getElementById('btnaddnpc').addEventListener('click',function(){
  if(!sp)return;
  if(!sp.npcs)sp.npcs=[];
  var al=getActiveLayer();
  sp.npcs.push({id:'npc-'+Date.now(),npcTypeId:'tutorial-goon',x:0,y:0,widthFt:2.5,heightFt:3.5,rotationDeg:0,flipX:false,flipY:false,z:60,sceneLayer:al.id});
  setSingleNpcSelection(sp.npcs.length-1);updatePropPanel();render();markDirty();
});
document.getElementById('btndel').addEventListener('click',function(){
  deleteSelected(true);
});
document.getElementById('btnaddsprite').addEventListener('click',function(){
  if(S.selPropIdx<0||!sp)return;
  openGallery(S.selPropIdx,-1,{tab:'catalog'});
});
document.getElementById('mps-front').addEventListener('click',function(){moveSelectedPropsToFront();});
document.getElementById('mps-back').addEventListener('click',function(){moveSelectedPropsToBack();});
document.getElementById('mps-del').addEventListener('click',function(){deleteSelected(true);});
document.getElementById('mps-pick').addEventListener('click',function(){
  var pidx=getSelectedPropIndices();if(!pidx.length)return;
  openGallery(pidx[0],0,{tab:'catalog',propIndices:pidx});
});
document.getElementById('btnnpctypepick').addEventListener('click',function(){
  if(S.selNpcIdx<0||!sp)return;
  openNpcTypePicker();
});
document.getElementById('btnnpcspritepick').addEventListener('click',function(){
  if(S.selNpcIdx<0||!sp)return;
  openNpcSpritePicker();
});
document.getElementById('btnnpcspriteclear').addEventListener('click',function(){
  var n=sp&&sp.npcs&&sp.npcs[S.selNpcIdx];if(!n)return;
  delete n.spriteOverride;
  refreshNpcInputs();
  render();
  markDirty();
});
document.getElementById('mns-front').addEventListener('click',function(){moveSelectedNpcsToFront();});
document.getElementById('mns-back').addEventListener('click',function(){moveSelectedNpcsToBack();});
document.getElementById('mns-rotp').addEventListener('click',function(){rotateSelectedNpcs(90);});
document.getElementById('mns-rotn').addEventListener('click',function(){rotateSelectedNpcs(-90);});
document.getElementById('mns-flipx').addEventListener('click',function(){mirrorSelectedNpcs('x');});
document.getElementById('mns-flipy').addEventListener('click',function(){mirrorSelectedNpcs('y');});
document.getElementById('mns-del').addEventListener('click',function(){deleteSelected(true);});
document.getElementById('mns-pick').addEventListener('click',function(){
  var nidx=getSelectedNpcIndices();if(!nidx.length)return;
  openNpcSpritePicker({npcIndices:nidx});
});
document.getElementById('btnapply').addEventListener('click',async function(){
  if(!sp)return;
  var props=sp.props.map(function(p){
    var out={id:p.id,kind:p.kind,x:p.x,y:p.y,layers:p.layers};
    if((p.width||1)!==1)out.width=p.width||1;
    if((p.height||1)!==1)out.height=p.height||1;
    if(p.z!==undefined)out.z=p.z;
    if(p.sceneLayer)out.sceneLayer=p.sceneLayer;
    // Rebuilt field-by-field, so ANY prop field not listed here is silently
    // dropped on save. "solid" was lost this way — a save from the editor
    // would have quietly stripped collision off every solid prop, which is
    // worse than a validation error because nothing reports it.
    if(p.solid===true)out.solid=true;
    return out;
  });
  var btn=document.getElementById('btnapply');btn.disabled=true;btn.textContent='Applying\u2026';
  try{
    var res=await fetch('/apply',{method:'POST',headers:{'Content-Type':'application/json','X-Set-Piece-Editor-Token':APPLY_TOKEN},
      body:JSON.stringify({setPieceId:sp.id,props:props,sceneLayers:sp.sceneLayers,npcs:sp.npcs||[],width:sp.width,height:sp.height})});
    var r=await res.json();
    if(r.ok){origSP=JSON.stringify(sp);showToast('\u2713 Applied!');S.dirty=false;updateStatus();
      fetch('/data').then(function(rd){return rd.json();}).then(function(np){S.pack=np;});}
    else{
      var detail=Array.isArray(r.issues)&&r.issues.length?(' — '+r.issues.join('; ')):'';
      showToast('\u2717 '+r.error+detail,true);
    }
  }catch(e){showToast('\u2717 '+e.message,true);}
  finally{btn.disabled=false;btn.textContent='\u2713 Apply';}
});
document.getElementById('spsel').addEventListener('change',function(){
  if(S.dirty&&!confirm('Discard unsaved changes?')){document.getElementById('spsel').value=S.selId;return;}
  selectSP(document.getElementById('spsel').value);
});
document.getElementById('snapsel').addEventListener('change',function(){S.snapMode=document.getElementById('snapsel').value;render();});
document.getElementById('keepaspect').addEventListener('change',function(){S.keepAspect=this.checked===true;});
document.getElementById('btnzp').addEventListener('click',function(){S.tileSize=Math.min(128,S.tileSize+8);document.getElementById('zoomlbl').textContent=S.tileSize+'px';render();});
document.getElementById('btnzm').addEventListener('click',function(){S.tileSize=Math.max(12,S.tileSize-8);document.getElementById('zoomlbl').textContent=S.tileSize+'px';render();});
document.getElementById('btnfit').addEventListener('click',function(){
  if(!sp)return;
  var gs=document.getElementById('gs');
  var aw=gs.clientWidth-32,ah=gs.clientHeight-32;
  S.tileSize=Math.max(12,Math.min(128,Math.min(Math.floor(aw/sp.width),Math.floor(ah/sp.height))));
  document.getElementById('zoomlbl').textContent=S.tileSize+'px';render();
});
function pushHistory(){
  hist=hist.slice(0,histIdx+1);
  hist.push(JSON.stringify(sp));
  if(hist.length>80)hist.shift(); else histIdx++;
  updUR();
}
function updUR(){
  document.getElementById('btnundo').disabled=histIdx<=0;
  document.getElementById('btnredo').disabled=histIdx>=hist.length-1;
}
function applyHistState(s){
  var o=JSON.parse(s);
  sp.props=o.props;
  if(o.sceneLayers)sp.sceneLayers=o.sceneLayers;
  if(o.npcs!==undefined)sp.npcs=o.npcs;
  if(o.width>0){sp.width=o.width;document.getElementById('spw').value=o.width;}
  if(o.height>0){sp.height=o.height;document.getElementById('sph').value=o.height;}
  clearSelection();
  getLayers();if(sp.sceneLayers&&sp.sceneLayers[0])S.activeLayerId=sp.sceneLayers[0].id;
  renderLayersPanel();updatePropPanel();render();
}
function markDirty(){pushHistory();S.dirty=true;updateStatus();}
function setGs(t){document.getElementById('gstatus').textContent=t;}
function updateStatus(){
  var sb=document.getElementById('stbar');
  sb.textContent=S.dirty?'\u25CF Unsaved \u2014 click Apply to write to repo':'Ready';
  sb.style.color=S.dirty?'#f0883e':'';
}
var toastT;
function showToast(msg,err){
  var t=document.getElementById('toast');
  t.textContent=msg;t.style.background=err?'#6b0000':'#238636';
  t.classList.add('show');clearTimeout(toastT);
  toastT=setTimeout(function(){t.classList.remove('show');},2800);
}
var es=new EventSource('/events');
es.onmessage=function(e){try{var d=JSON.parse(e.data);if(d.type==='applied')showToast('\u2713 Saved!');}catch(ex){}};
loadData().catch(function(e){setGs('Error: '+e.message);});

// --- overlay toggle ---
document.getElementById('btnovr').addEventListener('click',function(){
  S.showOverlay=!S.showOverlay;
  this.style.opacity=S.showOverlay?'1':'0.45';
  render();
});

// --- set-piece resize ---
document.getElementById('btnresize').addEventListener('click',function(){
  if(!sp)return;
  var nw=parseInt(document.getElementById('spw').value,10);
  var nh=parseInt(document.getElementById('sph').value,10);
  if(isNaN(nw)||nw<1||isNaN(nh)||nh<1)return showToast('Invalid dimensions',true);
  sp.width=nw;sp.height=nh;
  // clamp all props to stay within new bounds
  (sp.props||[]).forEach(function(p){
    var pw=p.width||1,ph=p.height||1;
    if(p.x+pw>nw)p.x=Math.max(0,nw-pw);
    if(p.y+ph>nh)p.y=Math.max(0,nh-ph);
    p.x=Math.max(0,p.x);p.y=Math.max(0,p.y);
  });
  // clamp NPC anchors to the same in-bounds authored tile domain
  (sp.npcs||[]).forEach(function(n){
    var ns=npcSizeTiles(n),nx=nnum(n.x,0),ny=nnum(n.y,0);
    if(nx+ns.w>nw)n.x=Math.max(0,nw-ns.w);
    if(ny+ns.h>nh)n.y=Math.max(0,nh-ns.h);
    n.x=Math.max(0,nnum(n.x,0));n.y=Math.max(0,nnum(n.y,0));
  });
  markDirty();render();
  setGs('Editing: '+sp.name+' ('+sp.width+'x'+sp.height+')');
  showToast('Resized to '+nw+'\u00d7'+nh);
});

// --- find or create a structural layer (Floors / Walls / Doors) ---
function findOrCreateStructLayer(id,name,insertIdx){
  if(!sp.sceneLayers)sp.sceneLayers=[];
  var found=sp.sceneLayers.find(function(l){return l.id===id||l.name===name;});
  if(found)return found;
  var layer={id:id,name:name,visible:true,locked:false};
  sp.sceneLayers.splice(Math.min(insertIdx,sp.sceneLayers.length),0,layer);
  getLayers();renderLayersPanel();
  return layer;
}
// preferred insert indices: Floors=0 (bottom), Walls=1, Doors=2
function addStructTile(kind,layerId,layerName,insertIdx,col,row){
  if(!sp)return;
  var layer=findOrCreateStructLayer(layerId,layerName,insertIdx);
  var cx=Math.floor((sp.width||8)/2)-0.5;
  var cy=Math.floor((sp.height||7)/2)-0.5;
  var p={
    id:kind+'-'+Date.now(),
    kind:kind,
    x:snapV(cx),y:snapV(cy),width:1,height:1,sceneLayer:layer.id,
    layers:[{sprite:{source:'sheet',sheetKey:'kenney-tiny-dungeon',col:col,row:row}}],
  };
  sp.props.push(p);
  setSinglePropSelection(sp.props.length-1);
  S.activeLayerId=layer.id;
  markDirty();renderLayersPanel();updatePropPanel();render();
}
document.getElementById('btnaddfloor').addEventListener('click',function(){addStructTile('floor','floor','Floor',0,5,1);});
document.getElementById('btnaddwall').addEventListener('click',function(){addStructTile('wall','walls','Walls',1,6,0);});
document.getElementById('btnadddoor').addEventListener('click',function(){addStructTile('door','doors','Doors',2,4,2);});

document.getElementById('btnundo').addEventListener('click',function(){
  if(histIdx<=0)return;
  histIdx--;applyHistState(hist[histIdx]);
  S.dirty=hist[histIdx]!==origSP;updateStatus();updUR();
});
document.getElementById('btnredo').addEventListener('click',function(){
  if(histIdx>=hist.length-1)return;
  histIdx++;applyHistState(hist[histIdx]);
  S.dirty=hist[histIdx]!==origSP;updateStatus();updUR();
});
document.getElementById('btnreset').addEventListener('click',function(){
  if(!origSP)return;
  if(S.dirty&&!confirm('Reset to last saved state? Unsaved changes will be lost.'))return;
  var o=JSON.parse(origSP);
  sp.props=o.props;sp.sceneLayers=o.sceneLayers||sp.sceneLayers;
  if(o.npcs!==undefined)sp.npcs=o.npcs;
  if(o.width>0){sp.width=o.width;document.getElementById('spw').value=o.width;}
  if(o.height>0){sp.height=o.height;document.getElementById('sph').value=o.height;}
  clearSelection();S.dirty=false;hist=[origSP];histIdx=0;
  getLayers();S.activeLayerId=sp.sceneLayers[0].id;
  renderLayersPanel();updatePropPanel();render();updateStatus();updUR();
  showToast('Reset to saved state');
});
document.addEventListener('keydown',function(e){
  // The art dialog contains text inputs, so it must swallow keys BEFORE the
  // canvas shortcuts below — otherwise typing "bearskin-rug" would delete the
  // selected prop on the first Backspace.
  if(document.getElementById('artdlg').style.display==='flex'){if(e.key==='Escape')closeArtDlg();return;}
  if(document.getElementById('gal').style.display==='flex'){if(e.key==='Escape')closeGallery();return;}
  if(isTextEditingTarget())return;
  if((e.ctrlKey||e.metaKey)&&!e.shiftKey&&e.key.toLowerCase()==='c'){e.preventDefault();copySelection();return;}
  if((e.ctrlKey||e.metaKey)&&!e.shiftKey&&e.key.toLowerCase()==='x'){e.preventDefault();cutSelection();return;}
  if((e.ctrlKey||e.metaKey)&&!e.shiftKey&&e.key.toLowerCase()==='v'){e.preventDefault();pasteClipboard();return;}
  if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();deleteSelected(false);return;}
  if((e.ctrlKey||e.metaKey)&&!e.shiftKey&&e.key==='z'){e.preventDefault();document.getElementById('btnundo').click();}
  if((e.ctrlKey||e.metaKey)&&(e.key==='y'||(e.shiftKey&&e.key==='Z'))){e.preventDefault();document.getElementById('btnredo').click();}
});

// ── Gallery ──────────────────────────────────────────────────────────────────
function openGallery(propIdx,layerIdx,opts){
  opts=opts||{};
  galMode='prop';
  galleryTarget={propIdx:propIdx,layerIdx:layerIdx,propIndices:opts.propIndices||null};
  document.getElementById('galtitle').textContent='Pick Sprite';
  document.getElementById('galtab-cat').style.display='';
  document.getElementById('galtab-sht').style.display='';
  document.getElementById('galsrch').value=opts.search||'';
  document.getElementById('gal').style.display='flex';
  if(opts.sheetKey)galSheetKey=opts.sheetKey;
  if(opts.tab==='sheet'){
    galTab='sheet';
    document.getElementById('galtab-sht').classList.add('act');
    document.getElementById('galtab-cat').classList.remove('act');
    document.getElementById('galsrch').placeholder='Search sheet (c12,r3)';
    renderGalSheet(galSheetKey,document.getElementById('galsrch').value);
  }else{
    galTab='catalog';
    document.getElementById('galtab-cat').classList.add('act');
    document.getElementById('galtab-sht').classList.remove('act');
    document.getElementById('galsrch').placeholder='Search catalog...';
    renderGalCatalog(document.getElementById('galsrch').value);
  }
}
function openNpcTypePicker(opts){
  opts=opts||{};
  galMode='npc';
  galleryTarget={npcIdx:S.selNpcIdx};
  document.getElementById('galtitle').textContent='Pick NPC Type';
  document.getElementById('galtab-cat').style.display='none';
  document.getElementById('galtab-sht').style.display='none';
  document.getElementById('galsrch').placeholder='Search NPC type or sprite...';
  document.getElementById('galsrch').value=opts.search||'';
  document.getElementById('gal').style.display='flex';
  renderGalNpcTypes(document.getElementById('galsrch').value);
}
function openNpcSpritePicker(opts){
  opts=opts||{};
  galMode='npc-sprite';
  galleryTarget={npcIdx:S.selNpcIdx,npcIndices:opts.npcIndices||null};
  document.getElementById('galtitle').textContent='Pick NPC Sprite Override';
  document.getElementById('galtab-cat').style.display='';
  document.getElementById('galtab-sht').style.display='';
  document.getElementById('galsrch').value=opts.search||'';
  document.getElementById('gal').style.display='flex';
  galTab='catalog';
  document.getElementById('galtab-cat').classList.add('act');
  document.getElementById('galtab-sht').classList.remove('act');
  document.getElementById('galsrch').placeholder='Search catalog...';
  renderGalCatalog(document.getElementById('galsrch').value);
}
function closeGallery(){
  document.getElementById('gal').style.display='none';
  galMode='prop';
  document.getElementById('galtitle').textContent='Pick Sprite';
  document.getElementById('galtab-cat').style.display='';
  document.getElementById('galtab-sht').style.display='';
  galleryTarget=null;
}
function applyGallerySprite(sprite){
  if(galMode==='npc-sprite'){
    if(!galleryTarget||!sp)return;
    var targets=galleryTarget.npcIndices&&galleryTarget.npcIndices.length?galleryTarget.npcIndices:[galleryTarget.npcIdx];
    var changed=false;
    targets.forEach(function(nidx){
      var n=sp.npcs&&sp.npcs[nidx];
      if(!n)return;
      n.spriteOverride=JSON.parse(JSON.stringify(sprite));
      changed=true;
    });
    if(!changed)return;
    closeGallery();
    refreshNpcInputs();
    render();
    markDirty();
    return;
  }
  if(!galleryTarget||!sp)return;
  var targets=galleryTarget.propIndices&&galleryTarget.propIndices.length?galleryTarget.propIndices:[galleryTarget.propIdx];
  var firstIdx=-1;
  targets.forEach(function(pi){
    var p=sp.props[pi];if(!p)return;
    if(firstIdx<0)firstIdx=pi;
    if(galleryTarget.layerIdx===-1){
      p.layers.push({sprite:JSON.parse(JSON.stringify(sprite))});
    }else{
      if(!p.layers[galleryTarget.layerIdx])p.layers[galleryTarget.layerIdx]={sprite:JSON.parse(JSON.stringify(sprite))};
      else p.layers[galleryTarget.layerIdx].sprite=JSON.parse(JSON.stringify(sprite));
    }
  });
  if(firstIdx>=0)S.selPropIdx=firstIdx;
  closeGallery();
  updatePropPanel();render();markDirty();
}
function applyNpcTypeFromGallery(npcTypeId){
  if(!galleryTarget||!sp)return;
  var idx=galleryTarget.npcIdx;
  var npc=sp.npcs&&sp.npcs[idx];
  if(!npc)return;
  npc.npcTypeId=npcTypeId;
  closeGallery();
  refreshNpcInputs();
  render();
  markDirty();
}
function mkGalThumb(k,c,r){
  var cvs=document.createElement('canvas');cvs.width=32;cvs.height=32;
  var meta=SHEETS_META[k];
  function draw(){
    var img=imgCache[k];if(!img||!meta)return;
    var cx=cvs.getContext('2d');cx.imageSmoothingEnabled=false;
    cx.fillStyle='#0d1117';cx.fillRect(0,0,32,32);
    var sx=meta.margin+c*(16+meta.spacing),sy=meta.margin+r*(16+meta.spacing);
    cx.drawImage(img,sx,sy,16,16,0,0,32,32);
  }
  if(imgCache[k]){draw();}else{
    loadSheet(k);
    var attempts=0;
    var tid=setInterval(function(){
      attempts++;
      if(imgCache[k]||imgLoadFailed[k]||attempts>=60){
        clearInterval(tid);
        if(imgCache[k])draw();
      }
    },120);
  }
  return cvs;
}
function mkGenThumb(id){
  var cvs=document.createElement('canvas');cvs.width=32;cvs.height=32;
  function draw(){
    var img=genCache[id];if(!img)return;
    var cx=cvs.getContext('2d');cx.imageSmoothingEnabled=false;
    cx.fillStyle='#0d1117';cx.fillRect(0,0,32,32);
    cx.drawImage(img,0,0,img.naturalWidth,img.naturalHeight,0,0,32,32);
  }
  if(genCache[id]){draw();}else{
    loadGenSprite(id);
    var attempts2=0;
    var tid2=setInterval(function(){
      attempts2++;
      if(genCache[id]||genLoadFailed[id]||attempts2>=60){
        clearInterval(tid2);
        if(genCache[id])draw();
      }
    },120);
  }
  return cvs;
}
function mkCatalogThumbBySpriteId(spriteId){
  var bare=bareSpriteId(spriteId);
  var def=CATALOG[bare];
  return def?mkGalThumb(def.k,def.c,def.r):mkGenThumb(bare);
}
function renderGalNpcTypes(filter){
  var sc=document.getElementById('galsc');sc.innerHTML='';
  var lo=String(filter||'').toLowerCase().trim();
  var typeMap={};
  KNOWN_NPC_TYPE_IDS.forEach(function(typeId){typeMap[typeId]=true;});
  Object.keys(GENERATED_NPC_SPRITE_BY_DEF).forEach(function(typeId){typeMap[typeId]=true;});
  if(sp&&sp.npcs){
    sp.npcs.forEach(function(n){if(n&&n.npcTypeId)typeMap[n.npcTypeId]=true;});
  }
  var typeIds=Object.keys(typeMap).sort();
  if(lo){
    typeIds=typeIds.filter(function(typeId){
      var spriteLabel=('sprite:'+bareSpriteId(npcSpriteIdForType(typeId))).toLowerCase();
      return typeId.toLowerCase().indexOf(lo)>=0||spriteLabel.indexOf(lo)>=0;
    });
  }
  if(!typeIds.length){
    sc.innerHTML='<div style="color:var(--text-color-muted,#8b949e);padding:16px;text-align:center">No NPC matches</div>';
    return;
  }
  typeIds.forEach(function(typeId){
    var item=document.createElement('div');item.className='galsi';item.title=typeId;
    item.appendChild(mkCatalogThumbBySpriteId(npcSpriteIdForType(typeId)));
    var lbl=document.createElement('span');lbl.textContent=typeId;item.appendChild(lbl);
    item.onclick=function(){applyNpcTypeFromGallery(typeId);};
    sc.appendChild(item);
  });
}
function renderGalCatalog(filter){
  var sc=document.getElementById('galsc');sc.innerHTML='';
  var lo=filter.toLowerCase();
  // Registry sprites
  var keys=Object.keys(CATALOG).filter(function(k){return!filter||k.toLowerCase().indexOf(lo)>=0;});
  // Generated sprites: full approved library from manifest + cache + currently referenced IDs
  var genMap={};
  function addGenerated(id){
    if(!id||CATALOG[id])return;
    if(filter&&id.toLowerCase().indexOf(lo)<0)return;
    genMap[id]=true;
  }
  (GENERATED_LIBRARY||[]).forEach(addGenerated);
  Object.keys(genCache).forEach(addGenerated);
  if(S.pack){
    S.pack.setPieces.forEach(function(sp2){
      (sp2.props||[]).forEach(function(p2){
        (p2.layers||[]).forEach(function(l){
          var s2=l.sprite;
          if(s2&&s2.source==='catalog'){
            var bare=(s2.spriteId||'').replace(/^sprite:/,'');
            addGenerated(bare);
          }
        });
      });
    });
  }
  var genKeys=Object.keys(genMap).sort();
  if(!keys.length&&!genKeys.length){sc.innerHTML='<div style="color:var(--text-color-muted,#8b949e);padding:16px;text-align:center">No matches</div>';return;}
  keys.forEach(function(k){
    var def=CATALOG[k];
    var item=document.createElement('div');item.className='galsi';item.title='sprite:'+k;
    item.appendChild(mkGalThumb(def.k,def.c,def.r));
    var lbl=document.createElement('span');lbl.textContent=k;item.appendChild(lbl);
    item.onclick=function(){applyGallerySprite({source:'catalog',spriteId:'sprite:'+k});};
    sc.appendChild(item);
  });
  if(genKeys.length){
    var sep=document.createElement('div');
    sep.style.cssText='width:100%;padding:4px 2px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-color-muted,#8b949e);margin-top:6px;';
    sep.textContent='Generated Assets';sc.appendChild(sep);
  }
  genKeys.forEach(function(id){
    var item=document.createElement('div');item.className='galsi';item.title=id;
    item.appendChild(mkGenThumb(id));
    var lbl=document.createElement('span');lbl.textContent=id;item.appendChild(lbl);
    item.onclick=function(){applyGallerySprite({source:'catalog',spriteId:id});};
    sc.appendChild(item);
  });
}
function renderGalSheet(sheetKey,filter){
  var sc=document.getElementById('galsc');sc.innerHTML='';
  galSheetKey=sheetKey;
  var lo=(filter||'').toLowerCase().trim();
  var sel=document.createElement('select');
  sel.style.cssText='margin-bottom:8px;display:block;background:var(--background-color-inset,#161b22);color:var(--text-color-default,#e6edf3);border:1px solid var(--border-color-default,#30363d);border-radius:4px;padding:3px 7px;font-size:11px;';
  Object.keys(SHEETS_META).forEach(function(k){
    var o=document.createElement('option');o.value=k;o.textContent=k;if(k===sheetKey)o.selected=true;sel.appendChild(o);
  });
  sel.onchange=function(){renderGalSheet(sel.value,document.getElementById('galsrch').value);};
  sc.appendChild(sel);
  var meta=SHEETS_META[sheetKey];
  if(!imgCache[sheetKey]){
    loadSheet(sheetKey);
    var pnode=document.createElement('p');pnode.textContent='Loading sheet...';pnode.style.color='var(--text-color-muted,#8b949e)';sc.appendChild(pnode);
    var waitAttempts=0;
    var wt=setInterval(function(){
      waitAttempts++;
      if(imgCache[sheetKey]||imgLoadFailed[sheetKey]||waitAttempts>=50){
        clearInterval(wt);
        if(imgCache[sheetKey])renderGalSheet(sheetKey,document.getElementById('galsrch').value);
        else pnode.textContent='Failed to load sheet.';
      }
    },200);
    return;
  }
  var img=imgCache[sheetKey];
  var rows=Math.max(0,Math.floor((img.naturalHeight-meta.margin+meta.spacing)/(16+meta.spacing)));
  var exact=null,m=lo.match(/^c?\\s*(\\d+)\\s*[,x ]\\s*r?\\s*(\\d+)$/);
  if(m)exact={c:parseInt(m[1],10),r:parseInt(m[2],10)};
  if(lo){
    var out=document.createElement('div');
    out.style.cssText='display:flex;flex-wrap:wrap;gap:8px;align-content:flex-start';
    var count=0;
    for(var rr=0;rr<rows;rr++){
      for(var cc=0;cc<meta.cols;cc++){
        var lbl='c'+cc+' r'+rr;
        var hit=exact?(cc===exact.c&&rr===exact.r):((sheetKey+' '+lbl).toLowerCase().indexOf(lo)>=0);
        if(!hit)continue;
        count++;
        var item=document.createElement('div');item.className='galsi';item.title=sheetKey+' '+lbl;
        item.appendChild(mkGalThumb(sheetKey,cc,rr));
        var txt=document.createElement('span');txt.textContent=lbl;item.appendChild(txt);
        (function(cPick,rPick){item.onclick=function(){applyGallerySprite({source:'sheet',sheetKey:sheetKey,col:cPick,row:rPick});};})(cc,rr);
        out.appendChild(item);
      }
    }
    if(!count){var none=document.createElement('div');none.style.cssText='color:var(--text-color-muted,#8b949e);padding:10px 2px';none.textContent='No sheet matches';sc.appendChild(none);}
    else sc.appendChild(out);
    return;
  }
  var scale=2;
  var W=img.naturalWidth*scale,H=img.naturalHeight*scale;
  var cvs=document.createElement('canvas');cvs.width=W;cvs.height=H;
  cvs.style.cssText='image-rendering:pixelated;cursor:crosshair;display:block;border:1px solid var(--border-color-default,#30363d);border-radius:4px;';
  var cx=cvs.getContext('2d');cx.imageSmoothingEnabled=false;
  cx.drawImage(img,0,0,W,H);
  cx.strokeStyle='rgba(255,255,255,.2)';cx.lineWidth=1;
  for(var gc=0;gc<=meta.cols;gc++){var gx=(meta.margin+gc*(16+meta.spacing))*scale;cx.beginPath();cx.moveTo(gx,0);cx.lineTo(gx,H);cx.stroke();}
  for(var gr=0;gr<=rows;gr++){var gy=(meta.margin+gr*(16+meta.spacing))*scale;cx.beginPath();cx.moveTo(0,gy);cx.lineTo(W,gy);cx.stroke();}
  var hover={c:-1,r:-1};
  function redrawHover(){
    cx.drawImage(img,0,0,W,H);
    cx.strokeStyle='rgba(255,255,255,.2)';cx.lineWidth=1;
    for(var hc=0;hc<=meta.cols;hc++){var hx=(meta.margin+hc*(16+meta.spacing))*scale;cx.beginPath();cx.moveTo(hx,0);cx.lineTo(hx,H);cx.stroke();}
    for(var hr=0;hr<=rows;hr++){var hy=(meta.margin+hr*(16+meta.spacing))*scale;cx.beginPath();cx.moveTo(0,hy);cx.lineTo(W,hy);cx.stroke();}
    if(hover.c>=0){
      cx.fillStyle='rgba(31,111,235,.35)';
      cx.fillRect((meta.margin+hover.c*(16+meta.spacing))*scale,(meta.margin+hover.r*(16+meta.spacing))*scale,16*scale,16*scale);
    }
  }
  cvs.onmousemove=function(e){
    var rb=cvs.getBoundingClientRect();
    var px=(e.clientX-rb.left)*(cvs.width/rb.width);
    var py=(e.clientY-rb.top)*(cvs.height/rb.height);
    var nc=Math.floor((px/scale-meta.margin)/(16+meta.spacing));
    var nr=Math.floor((py/scale-meta.margin)/(16+meta.spacing));
    if(nc!==hover.c||nr!==hover.r){hover.c=nc;hover.r=nr;redrawHover();}
  };
  cvs.onmouseleave=function(){hover.c=-1;hover.r=-1;redrawHover();};
  cvs.onclick=function(e){
    var rb=cvs.getBoundingClientRect();
    var px=(e.clientX-rb.left)*(cvs.width/rb.width);
    var py=(e.clientY-rb.top)*(cvs.height/rb.height);
    var tc=Math.floor((px/scale-meta.margin)/(16+meta.spacing));
    var tr=Math.floor((py/scale-meta.margin)/(16+meta.spacing));
    if(tc<0||tr<0||tc>=meta.cols||tr>=rows)return;
    applyGallerySprite({source:'sheet',sheetKey:sheetKey,col:tc,row:tr});
  };
  sc.appendChild(cvs);
}
document.getElementById('galsrch').addEventListener('input',function(){
  if(galMode==='npc')renderGalNpcTypes(this.value);
  else if(galTab==='catalog')renderGalCatalog(this.value);
  else renderGalSheet(galSheetKey,this.value);
});
document.getElementById('galbtnclose').addEventListener('click',closeGallery);
document.getElementById('gal').addEventListener('click',function(e){if(e.target===this)closeGallery();});
// --- Art requests -----------------------------------------------------------
// Filing a request from the editor, where the hole in the room is visible, so
// "I need a bearskin rug" does not decay into no rug. Two entry points share
// one dialog; a non-empty artBasedOn means "variant of existing art".
var artBasedOn='';
// Prefill suggestion ONLY. The server-side lib/art-request.mjs owns the real
// name rules; this is a convenience so the user is not retyping suffixes.
function suggestNameFrom(spriteId,change){
  var base=String(spriteId||'').replace(/^generated:/,'').replace(/-var-\d+$/,'').replace(/-v\d+$/,'');
  var slug=String(change||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').split('-').slice(0,3).join('-');
  return slug?base+'-'+slug:base;
}
/** Sprite id of the selected prop's first layer, or '' when none applies. */
function selectedSpriteId(){
  if(!sp||S.selPropIdx<0)return '';
  var p=sp.props[S.selPropIdx];
  var s=p&&p.layers&&p.layers[0]&&p.layers[0].sprite;
  if(!s)return '';
  if(s.source==='catalog')return String(s.spriteId||'').replace(/^generated:/,'');
  return '';
}
function syncArtVariantBtn(){
  var b=document.getElementById('btnartvar');
  if(!b)return;
  var id=selectedSpriteId();
  b.disabled=id==='';
  b.title=id?('Request a variant of '+id):'Select a prop using catalog art first';
}
function openArtDlg(basedOn){
  artBasedOn=basedOn||'';
  var ref=document.getElementById('artbasedon');
  document.getElementById('arttitle').textContent=artBasedOn?'Request a variant':'Request art';
  document.getElementById('artbrieflbl').textContent=artBasedOn?'What should change?':'Brief';
  if(artBasedOn){
    ref.style.display='block';
    ref.textContent='Based on '+artBasedOn+' — its palette, outline weight and scale are kept; describe only the change.';
    document.getElementById('artbrief').placeholder='Same stove, but facing east instead of south.';
    document.getElementById('artname').value=suggestNameFrom(artBasedOn,'');
  }else{
    ref.style.display='none';
    document.getElementById('artbrief').placeholder='A shaggy bearskin rug, head at the west end, splayed on flagstones. Reads clearly from above at gameplay scale.';
    document.getElementById('artname').value='';
  }
  document.getElementById('artbrief').value='';
  document.getElementById('arterr').style.display='none';
  document.getElementById('artdlg').style.display='flex';
  document.getElementById(artBasedOn?'artbrief':'artname').focus();
}
function closeArtDlg(){document.getElementById('artdlg').style.display='none';}
document.getElementById('btnartnew').addEventListener('click',function(){openArtDlg('');});
document.getElementById('btnartvar').addEventListener('click',function(){
  var id=selectedSpriteId();
  if(!id){showToast('\u2717 Select a prop that uses catalog art first',true);return;}
  openArtDlg(id);
});
document.getElementById('artclose').addEventListener('click',closeArtDlg);
document.getElementById('artcancel').addEventListener('click',closeArtDlg);
document.getElementById('artdlg').addEventListener('click',function(e){if(e.target===this)closeArtDlg();});
// Suggest a name from the change text while the user types, but never clobber
// a name they have edited themselves.
document.getElementById('artbrief').addEventListener('input',function(){
  if(!artBasedOn)return;
  var n=document.getElementById('artname');
  if(n.dataset.touched==='1')return;
  n.value=suggestNameFrom(artBasedOn,this.value);
});
document.getElementById('artname').addEventListener('input',function(){this.dataset.touched='1';});
document.getElementById('artsubmit').addEventListener('click',async function(){
  var btn=this,err=document.getElementById('arterr');
  err.style.display='none';
  btn.disabled=true;btn.textContent='Opening\u2026';
  try{
    var res=await fetch('/art-request',{method:'POST',headers:{'Content-Type':'application/json','X-Set-Piece-Editor-Token':APPLY_TOKEN},
      body:JSON.stringify({
        name:document.getElementById('artname').value,
        brief:document.getElementById('artbrief').value,
        type:document.getElementById('arttype').value,
        sizeVariant:document.getElementById('artsize').value,
        floor:document.getElementById('artfloor').value,
        basedOn:artBasedOn
      })});
    var r=await res.json();
    if(r.ok){closeArtDlg();showToast('\u2713 Requested '+r.name+' \u2014 '+r.url);}
    else{
      err.textContent=(Array.isArray(r.issues)&&r.issues.length?r.issues.join('\\n'):r.error||'Request failed');
      err.style.display='block';
    }
  }catch(e){err.textContent=e.message;err.style.display='block';}
  finally{btn.disabled=false;btn.textContent='Open issue';}
});
document.getElementById('galtab-cat').addEventListener('click',function(){
  if(galMode==='npc')return;
  galTab='catalog';
  document.getElementById('galtab-cat').classList.add('act');
  document.getElementById('galtab-sht').classList.remove('act');
  document.getElementById('galsrch').placeholder='Search catalog...';
  renderGalCatalog(document.getElementById('galsrch').value);
});
document.getElementById('galtab-sht').addEventListener('click',function(){
  if(galMode==='npc')return;
  galTab='sheet';
  document.getElementById('galtab-sht').classList.add('act');
  document.getElementById('galtab-cat').classList.remove('act');
  document.getElementById('galsrch').placeholder='Search sheet (c12,r3)';
  renderGalSheet(galSheetKey,document.getElementById('galsrch').value);
});
</script>
</body>
</html>`;
