// Extension: set-piece-editor
// Visual drag-and-drop set-piece layout editor.
// Three-column layout: Scene Layers | Canvas | Inspector
// Features: scene org layers, real Kenney sprite rendering,
//   snap modes (tile / half-tile / free), zoom-to-fit, Apply to repo.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { joinSession, createCanvas, CanvasError } from '@github/copilot-sdk/extension';

const __extDir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__extDir, '..', '..', '..');

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

function handleRequest(instanceId, req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'GET' && url.pathname === '/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(renderHtml());
    return;
  }
  if (req.method === 'GET' && url.pathname === '/data') {
    try {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(readPack()));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: String(e) }));
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
    if (name.includes('..') || name.includes('/')) {
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
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const { setPieceId, props, sceneLayers, npcs } = JSON.parse(body);
        const pack = readPack();
        const idx = pack.setPieces.findIndex((s) => s.id === setPieceId);
        if (idx === -1) {
          res.writeHead(404);
          res.end(JSON.stringify({ ok: false, error: 'Not found' }));
          return;
        }
        pack.setPieces[idx] = { ...pack.setPieces[idx], props };
        if (sceneLayers && sceneLayers.length > 0) pack.setPieces[idx].sceneLayers = sceneLayers;
        if (npcs !== undefined) pack.setPieces[idx].npcs = npcs;
        writePack(pack);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
        broadcastToInstance(instanceId, { type: 'applied', setPieceId });
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
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
async function startServer(instanceId) {
  const server = createServer((req, res) => handleRequest(instanceId, req, res));
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
            pack.setPieces[idx] = { ...pack.setPieces[idx], props };
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
          await new Promise((r) => entry.server.close(() => r()));
        }
      },
    }),
  ],
});

function renderHtml() {
  return HTML_TEMPLATE;
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
    <option value="free">Free</option>
  </select>
  <button class="btn" id="btnfit" title="Zoom to fit">&#8599;Fit</button>
  <button class="btn" id="btnzm" style="padding:3px 7px">&#8722;</button>
  <span id="zoomlbl" style="font-size:11px;min-width:32px;text-align:center">48px</span>
  <button class="btn" id="btnzp" style="padding:3px 7px">+</button>
  <button class="btn" id="btnundo" disabled title="Undo (Ctrl+Z)">&#8630; Undo</button>
  <button class="btn" id="btnredo" disabled title="Redo (Ctrl+Y)">&#8631; Redo</button>
  <button class="btn" id="btnreset" title="Reset to last saved">&#10227; Reset</button>
  <button class="btn" id="btnadd">+ Prop</button>
  <button class="btn" id="btnaddnpc">+ NPC</button>
  <button class="btn btn-r" id="btndel" disabled>&#10005;</button>
  <button class="btn btn-g" id="btnapply">&#10003; Apply</button>
</div>
<div class="main">
  <div class="lp">
    <div class="lp-hd">Scene Layers</div>
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
        <div class="fr"><label>z</label><input id="pz" type="number" placeholder="auto"></div>
      </div>
      <div class="ps">
        <h3>Sprites</h3>
        <div id="spriteslist"></div>
        <button class="btn" id="btnaddsprite" style="width:100%;margin-top:3px;font-size:11px">+ Add Sprite</button>
      </div>
    </div>
    <div id="npcped" style="display:none">
      <div class="ps">
        <h3>NPC</h3>
        <div class="fr"><label>id</label><input id="nid" type="text"></div>
        <div class="fr"><label>type</label><input id="ntype" type="text" placeholder="e.g. tutorial-goon"></div>
        <div class="pr">
          <div class="fr"><label>x</label><input id="nxf" type="number" min="0" step="1"></div>
          <div class="fr"><label>y</label><input id="nyf" type="number" min="0" step="1"></div>
        </div>
        <div class="fr"><label>layer</label><select id="nlayer"></select></div>
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
<div class="stbar" id="stbar">Ready</div>
<div class="toast" id="toast"></div>
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
var GENERATED_NPC_SPRITE_BY_DEF = {
  'tutorial-goon':'npc-welcome-goon-var-0',
  'shopkeeper':'npc-sweaty-merchant-var-0',
  'spell-quest-giver':'npc-spell-broker-var-1'
};
var imgCache={};
function loadSheet(key){
  if(imgCache[key]!==undefined)return imgCache[key];
  imgCache[key]=null;
  var img=new Image();
  img.onload=function(){imgCache[key]=img;render();};
  img.onerror=function(){imgCache[key]=null;};
  img.src='/sheet/'+encodeURIComponent(key);
  return null;
}
// Individual generated sprite PNGs (source:'catalog', non-registry IDs)
var genCache={};
function loadGenSprite(id){
  if(genCache[id]!==undefined)return genCache[id];
  genCache[id]=null;
  var img=new Image();
  img.onload=function(){genCache[id]=img;render();};
  img.onerror=function(){genCache[id]=null;};
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
var S={pack:null,selId:null,selPropIdx:-1,selNpcIdx:-1,tileSize:48,dirty:false,snapMode:'tile',activeLayerId:null};
var sp=null;
var hist=[],histIdx=-1,origSP=null,galTab='catalog',galleryTarget=null;
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
async function loadData(){
  var params=new URLSearchParams(location.search),initId=params.get('setPieceId')||'';
  var res=await fetch('/data');S.pack=await res.json();
  var sel=document.getElementById('spsel');
  sel.innerHTML=S.pack.setPieces.map(function(s){
    return '<option value="'+s.id+'">'+s.name+' ('+s.width+'x'+s.height+')</option>';
  }).join('');
  var fid=S.pack.setPieces.some(function(s){return s.id===initId;})?initId:(S.pack.setPieces[0]||{}).id;
  if(fid)selectSP(fid);
}
function selectSP(id){
  S.selId=id;S.selPropIdx=-1;S.selNpcIdx=-1;S.dirty=false;
  sp=JSON.parse(JSON.stringify(S.pack.setPieces.find(function(s){return s.id===id;})));
  if(!sp.npcs)sp.npcs=[];
  document.getElementById('spsel').value=id;
  document.getElementById('spmeta').textContent=(sp.theme||'')+' \u00b7 '+(sp.sizing||'');
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
    row.appendChild(vis);row.appendChild(lck);row.appendChild(nm);row.appendChild(del);
    ll.appendChild(row);
  });
  refreshLayerPicker();
}
function refreshLayerPicker(){
  var ls=getLayers();
  var sel=document.getElementById('player'),cur=sel.value;
  sel.innerHTML=ls.map(function(l){return'<option value="'+l.id+'">'+l.name+'</option>';}).join('');
  if(cur)sel.value=cur;
  var nsel=document.getElementById('nlayer'),ncur=nsel.value;
  nsel.innerHTML=ls.map(function(l){return'<option value="'+l.id+'">'+l.name+'</option>';}).join('');
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
function render(){
  if(!sp)return;
  var ts=S.tileSize,w=sp.width,h=sp.height;
  canvas.width=w*ts;canvas.height=h*ts;
  ctx.fillStyle='#090d12';ctx.fillRect(0,0,w*ts,h*ts);
  if(S.snapMode==='half'){
    ctx.strokeStyle='#141c26';ctx.lineWidth=1;
    for(var hx=1;hx<w*2;hx+=2){ctx.beginPath();ctx.moveTo(hx*ts/2,0);ctx.lineTo(hx*ts/2,h*ts);ctx.stroke();}
    for(var hy=1;hy<h*2;hy+=2){ctx.beginPath();ctx.moveTo(0,hy*ts/2);ctx.lineTo(w*ts,hy*ts/2);ctx.stroke();}
  }
  ctx.strokeStyle='#1e2530';ctx.lineWidth=1;
  for(var gx=0;gx<=w;gx++){ctx.beginPath();ctx.moveTo(gx*ts,0);ctx.lineTo(gx*ts,h*ts);ctx.stroke();}
  for(var gy=0;gy<=h;gy++){ctx.beginPath();ctx.moveTo(0,gy*ts);ctx.lineTo(w*ts,gy*ts);ctx.stroke();}
  ctx.fillStyle='#ffffff0d';ctx.font='7px monospace';ctx.textAlign='left';ctx.textBaseline='top';
  for(var cx2=0;cx2<w;cx2++)for(var cy2=0;cy2<h;cy2++)ctx.fillText(cx2+','+cy2,cx2*ts+2,cy2*ts+2);
  var sorted=sp.props.map(function(p,i){return{p:p,i:i};})
    .filter(function(x){return layerVisible(propLayer(x.p));})
    .sort(function(a,b){return getZ(a.p)-getZ(b.p);});
  sorted.forEach(function(x){drawProp(x.p,x.i===S.selPropIdx,drag&&drag.mode==='move'&&drag.idx===x.i?drag:null);});
  // Render NPCs on top (z=60)
  if(sp.npcs){sp.npcs.forEach(function(npc,ni){
    if(!layerVisible(npcLayer(npc)))return;
    var nd=drag&&drag.mode==='move-npc'&&drag.idx===ni?drag:null;
    drawNpcEntity(npc,ni===S.selNpcIdx,nd);
  });}
  if(S.selPropIdx>=0&&!drag){
    var sp2=sp.props[S.selPropIdx];
    if(sp2&&layerVisible(propLayer(sp2)))drawHandles(sp2.x*ts,sp2.y*ts,sp2.width||1,sp2.height||1);
  }else if(S.selPropIdx>=0&&drag&&drag.mode==='resize'){
    var sp3=sp.props[S.selPropIdx];
    if(sp3)drawHandles(drag.dispX,drag.dispY,drag.dispW/S.tileSize,drag.dispH/S.tileSize);
  }
}
function drawProp(prop,sel,ad){
  var ts=S.tileSize,pw=prop.width||1,ph=prop.height||1;
  var px,py;
  if(ad){px=ad.dispX;py=ad.dispY;}else{px=prop.x*ts;py=prop.y*ts;}
  var pw2=pw*ts,ph2=ph*ts;
  var locked=layerLocked(propLayer(prop));
  var C=KINDS[prop.kind]||KINDS.fixture;
  ctx.fillStyle=C.bg;ctx.fillRect(px+1,py+1,pw2-2,ph2-2);
  var fl=prop.layers&&prop.layers[0],fs=fl&&fl.sprite,sprited=false;
  if(fs){
    var res=resolveSprite(fs);
    if(res){
      ctx.save();ctx.imageSmoothingEnabled=false;
      ctx.beginPath();ctx.rect(px+1,py+1,pw2-2,ph2-2);ctx.clip();
      ctx.drawImage(res.img,res.sx,res.sy,res.w||16,res.h||16,px+1,py+1,pw2-2,ph2-2);
      ctx.restore();sprited=true;
    }else if(fs.source==='custom'&&!fs.placeholder){
      ctx.fillStyle='#ff00ff33';ctx.fillRect(px+1,py+1,pw2-2,ph2-2);
      ctx.fillStyle='#ff00ff';ctx.font='bold 9px monospace';
      ctx.textAlign='center';ctx.textBaseline='middle';
      ctx.fillText('\u2736',px+pw2/2,py+ph2/2);
    }
  }
  if(sprited){ctx.fillStyle='rgba(0,0,0,0.28)';ctx.fillRect(px+1,py+1,pw2-2,Math.min(18,ph2-2));}
  if(locked){ctx.fillStyle='rgba(0,0,0,0.38)';ctx.fillRect(px,py,pw2,ph2);}
  ctx.strokeStyle=sel?'#fff':C.bd;ctx.lineWidth=sel?2.5:1.5;
  ctx.strokeRect(px+1.5,py+1.5,pw2-3,ph2-3);
  ctx.fillStyle=C.lb;ctx.font='bold '+Math.min(11,ts*0.2)+'px system-ui';
  ctx.textAlign='left';ctx.textBaseline='top';
  ctx.fillText(truncT(prop.id,pw2-8),px+4,py+4);
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
  if(nd){px=nd.dispX;py=nd.dispY;}else{px=npc.x*ts;py=npc.y*ts;}
  var sz=ts;
  ctx.fillStyle=NPC_BG;ctx.fillRect(px+1,py+1,sz-2,sz-2);
  var mapped=GENERATED_NPC_SPRITE_BY_DEF[npc.npcTypeId];
  var ns=mapped?{source:'catalog',spriteId:mapped}:{source:'catalog',spriteId:'sprite:npc.guide'};
  var res=resolveSprite(ns);
  if(res){
    ctx.save();ctx.imageSmoothingEnabled=false;
    ctx.beginPath();ctx.rect(px+1,py+1,sz-2,sz-2);ctx.clip();
    ctx.drawImage(res.img,res.sx,res.sy,res.w||16,res.h||16,px+1,py+1,sz-2,sz-2);
    ctx.restore();
    ctx.fillStyle='rgba(0,0,0,0.28)';ctx.fillRect(px+1,py+1,sz-2,Math.min(18,sz-2));
  }
  ctx.strokeStyle=sel?'#fff':NPC_BD;ctx.lineWidth=sel?2.5:1.5;
  ctx.strokeRect(px+1.5,py+1.5,sz-3,sz-3);
  // NPC badge top-right
  ctx.fillStyle=NPC_LB;ctx.font='bold 7px system-ui';ctx.textAlign='left';ctx.textBaseline='top';
  ctx.fillText(truncT(npc.id,sz-6),px+3,py+3);
  // Anchor role badge
  if(npc.anchorRole){
    ctx.fillStyle='rgba(0,0,0,.6)';var aw=ctx.measureText(npc.anchorRole).width+6;
    ctx.fillRect(px+(sz-aw)/2,py+sz-14,aw,12);
    ctx.fillStyle='#facc15';ctx.font='bold 7px system-ui';ctx.textAlign='center';ctx.textBaseline='top';
    ctx.fillText(npc.anchorRole,px+sz/2,py+sz-13);
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
  var handles=hpos(prop.x*ts,prop.y*ts,pw*ts,ph*ts);
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
    if(cx>=p.x*ts&&cx<p.x*ts+pw&&cy>=p.y*ts&&cy<p.y*ts+ph)return sorted[i].i;
  }
  return-1;
}
function hitNpc(cx,cy){
  if(!sp||!sp.npcs)return-1;
  var ts=S.tileSize;
  for(var i=sp.npcs.length-1;i>=0;i--){
    var n=sp.npcs[i];
    if(!layerVisible(npcLayer(n))||layerLocked(npcLayer(n)))continue;
    if(cx>=n.x*ts&&cx<(n.x+1)*ts&&cy>=n.y*ts&&cy<(n.y+1)*ts)return i;
  }
  return-1;
}
function snapV(v){if(S.snapMode==='tile')return Math.round(v);if(S.snapMode==='half')return Math.round(v*2)/2;return Math.round(v*100)/100;}
function snapSz(v){if(S.snapMode==='tile')return Math.max(1,Math.round(v));if(S.snapMode==='half')return Math.max(0.5,Math.round(v*2)/2);return Math.max(0.25,Math.round(v*100)/100);}
var drag=null;
function cxy(e){var r=canvas.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top};}
canvas.addEventListener('mousedown',function(e){
  if(!sp)return;
  var pos=cxy(e);
  if(S.selPropIdx>=0){
    var p=sp.props[S.selPropIdx];
    if(!layerLocked(propLayer(p))){
      var h=hitHandle(p,pos.x,pos.y);
      if(h){var ts=S.tileSize;
        drag={mode:'resize',idx:S.selPropIdx,sx:pos.x,sy:pos.y,
          orig:JSON.parse(JSON.stringify(p)),dispX:p.x*ts,dispY:p.y*ts,
          dispW:(p.width||1)*ts,dispH:(p.height||1)*ts,h:h};return;}
    }
  }
  // NPCs take priority at top of z-stack
  var ni=hitNpc(pos.x,pos.y);
  if(ni>=0){
    S.selNpcIdx=ni;S.selPropIdx=-1;
    var nn=sp.npcs[ni];var ts3=S.tileSize;
    drag={mode:'move-npc',idx:ni,sx:pos.x,sy:pos.y,
      orig:{x:nn.x,y:nn.y},dispX:nn.x*ts3,dispY:nn.y*ts3};
    updatePropPanel();render();return;
  }
  var idx=hitProp(pos.x,pos.y);
  if(idx>=0){
    S.selPropIdx=idx;S.selNpcIdx=-1;var pp=sp.props[idx];var ts2=S.tileSize;
    drag={mode:'move',idx:idx,sx:pos.x,sy:pos.y,
      orig:JSON.parse(JSON.stringify(pp)),dispX:pp.x*ts2,dispY:pp.y*ts2};
    updatePropPanel();render();
  }else{S.selPropIdx=-1;S.selNpcIdx=-1;drag=null;updatePropPanel();render();}
});
canvas.addEventListener('mousemove',function(e){
  if(!drag||!sp)return;
  var pos=cxy(e),ts=S.tileSize,dx=pos.x-drag.sx,dy=pos.y-drag.sy;
  if(drag.mode==='move-npc'){
    drag.dispX=Math.max(0,Math.min((sp.width-1)*ts,drag.orig.x*ts+dx));
    drag.dispY=Math.max(0,Math.min((sp.height-1)*ts,drag.orig.y*ts+dy));
    render();return;
  }
  var p=sp.props[drag.idx];
  if(!p)return;
  if(drag.mode==='move'){
    var pw=(p.width||1)*ts,ph=(p.height||1)*ts;
    drag.dispX=Math.max(0,Math.min(sp.width*ts-pw,drag.orig.x*ts+dx));
    drag.dispY=Math.max(0,Math.min(sp.height*ts-ph,drag.orig.y*ts+dy));
  }else{
    var h=drag.h,o=drag.orig;
    var nx=o.x*ts,ny=o.y*ts,nw=(o.width||1)*ts,nh=(o.height||1)*ts;
    if(h.dx<0){var dd=Math.min(dx,nw-ts);nx=o.x*ts+dd;nw=(o.width||1)*ts-dd;}
    else if(h.dx>0){nw=Math.max(ts,(o.width||1)*ts+dx);}
    if(h.dy<0){var de=Math.min(dy,nh-ts);ny=o.y*ts+de;nh=(o.height||1)*ts-de;}
    else if(h.dy>0){nh=Math.max(ts,(o.height||1)*ts+dy);}
    nx=Math.max(0,nx);ny=Math.max(0,ny);
    nw=Math.min(nw,sp.width*ts-nx);nh=Math.min(nh,sp.height*ts-ny);
    drag.dispX=nx;drag.dispY=ny;drag.dispW=nw;drag.dispH=nh;
  }
  render();
});
canvas.addEventListener('mouseup',function(){
  if(!drag||!sp)return;
  var ts=S.tileSize;
  if(drag.mode==='move-npc'){
    var n=sp.npcs&&sp.npcs[drag.idx];
    if(n){
      n.x=Math.max(0,Math.min(sp.width-1,Math.round(drag.dispX/ts)));
      n.y=Math.max(0,Math.min(sp.height-1,Math.round(drag.dispY/ts)));
      refreshNpcInputs();markDirty();
    }
    drag=null;render();return;
  }
  var p=sp.props[drag.idx];
  if(p){
    if(drag.mode==='move'){
      p.x=snapV(drag.dispX/ts);p.y=snapV(drag.dispY/ts);
      p.x=Math.max(0,Math.min(sp.width-(p.width||1),p.x));
      p.y=Math.max(0,Math.min(sp.height-(p.height||1),p.y));
    }else{
      p.x=Math.max(0,snapV(drag.dispX/ts));p.y=Math.max(0,snapV(drag.dispY/ts));
      p.width=snapSz(drag.dispW/ts);p.height=snapSz(drag.dispH/ts);
      p.width=Math.min(p.width,sp.width-p.x);p.height=Math.min(p.height,sp.height-p.y);
    }
    refreshPropInputs();markDirty();
  }
  drag=null;render();
});
canvas.addEventListener('mouseleave',function(){drag=null;render();});
canvas.addEventListener('mousemove',function(e){
  if(drag)return;var pos=cxy(e);
  var CRS={nw:'nw-resize',ne:'ne-resize',sw:'sw-resize',se:'se-resize',
    n:'n-resize',s:'s-resize',e:'e-resize',w:'w-resize'};
  if(S.selPropIdx>=0){
    var p=sp.props[S.selPropIdx];
    if(!layerLocked(propLayer(p))){var h=hitHandle(p,pos.x,pos.y);if(h){canvas.style.cursor=CRS[h.t]||'crosshair';return;}}
  }
  canvas.style.cursor=hitNpc(pos.x,pos.y)>=0?'grab':(hitProp(pos.x,pos.y)>=0?'grab':'default');
},true);
function updatePropPanel(){
  var ns=document.getElementById('nosel'),ed=document.getElementById('proped'),ne=document.getElementById('npcped');
  document.getElementById('btndel').disabled=S.selPropIdx<0&&S.selNpcIdx<0;
  if(S.selNpcIdx>=0&&sp){ns.style.display='none';ed.style.display='none';ne.style.display='';refreshNpcInputs();return;}
  ne.style.display='none';
  if(S.selPropIdx<0||!sp){ns.style.display='';ed.style.display='none';return;}
  ns.style.display='none';ed.style.display='';
  refreshPropInputs();refreshSprites();
}
function refreshNpcInputs(){
  var n=sp&&sp.npcs&&sp.npcs[S.selNpcIdx];if(!n)return;
  document.getElementById('nid').value=n.id;
  document.getElementById('ntype').value=n.npcTypeId;
  document.getElementById('nxf').value=n.x;
  document.getElementById('nyf').value=n.y;
  document.getElementById('nlayer').value=npcLayer(n);
  document.getElementById('nanchor').value=n.anchorRole||'';
}
function refreshPropInputs(){
  var p=sp&&sp.props[S.selPropIdx];if(!p)return;
  document.getElementById('pid').value=p.id;
  document.getElementById('pkind').value=p.kind;
  document.getElementById('px').value=p.x;
  document.getElementById('py').value=p.y;
  document.getElementById('pw').value=p.width||1;
  document.getElementById('ph').value=p.height||1;
  document.getElementById('pz').value=p.z!==undefined?p.z:'';
  document.getElementById('player').value=propLayer(p);
}
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
    (function(li2){cpick.onclick=function(){openGallery(S.selPropIdx,li2);};})(li);
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
document.getElementById('player').addEventListener('change',function(){
  var p=sp&&sp.props[S.selPropIdx];if(!p)return;
  p.sceneLayer=document.getElementById('player').value;render();markDirty();
});
function syncPropInputs(){
  var p=sp&&sp.props[S.selPropIdx];if(!p)return;
  p.id=document.getElementById('pid').value||p.id;
  p.kind=document.getElementById('pkind').value;
  p.x=parseFloat(document.getElementById('px').value)||0;
  p.y=parseFloat(document.getElementById('py').value)||0;
  p.width=parseFloat(document.getElementById('pw').value)||1;
  p.height=parseFloat(document.getElementById('ph').value)||1;
  var zv=document.getElementById('pz').value.trim();
  if(zv===''){delete p.z;}else{p.z=parseInt(zv);}
  render();markDirty();
}
function syncNpcInputs(){
  var n=sp&&sp.npcs&&sp.npcs[S.selNpcIdx];if(!n)return;
  var nidv=document.getElementById('nid').value.trim();if(nidv)n.id=nidv;
  n.npcTypeId=document.getElementById('ntype').value.trim();
  n.x=Math.max(0,Math.min(sp.width-1,parseInt(document.getElementById('nxf').value)||0));
  n.y=Math.max(0,Math.min(sp.height-1,parseInt(document.getElementById('nyf').value)||0));
  n.sceneLayer=document.getElementById('nlayer').value;
  var anch=document.getElementById('nanchor').value;
  if(anch)n.anchorRole=anch;else delete n.anchorRole;
  render();markDirty();
}
['nid','ntype','nxf','nyf','nlayer','nanchor'].forEach(function(id){
  document.getElementById(id).addEventListener('change',syncNpcInputs);
});
document.getElementById('btnadd').addEventListener('click',function(){
  if(!sp)return;
  var al=getActiveLayer();
  sp.props.push({id:'prop-'+Date.now(),kind:'furniture',x:0,y:0,width:1,height:1,
    sceneLayer:al.id,layers:[{sprite:{source:'sheet',sheetKey:'kenney-tiny-dungeon',col:0,row:0}}]});
  S.selPropIdx=sp.props.length-1;S.selNpcIdx=-1;updatePropPanel();render();markDirty();
});
document.getElementById('btnaddnpc').addEventListener('click',function(){
  if(!sp)return;
  if(!sp.npcs)sp.npcs=[];
  var al=getActiveLayer();
  sp.npcs.push({id:'npc-'+Date.now(),npcTypeId:'tutorial-goon',x:0,y:0,sceneLayer:al.id});
  S.selNpcIdx=sp.npcs.length-1;S.selPropIdx=-1;updatePropPanel();render();markDirty();
});
document.getElementById('btndel').addEventListener('click',function(){
  if(S.selNpcIdx>=0&&sp&&sp.npcs){
    if(!confirm('Delete NPC "'+sp.npcs[S.selNpcIdx].id+'"?'))return;
    sp.npcs.splice(S.selNpcIdx,1);S.selNpcIdx=-1;updatePropPanel();render();markDirty();return;
  }
  if(S.selPropIdx<0||!sp)return;
  if(!confirm('Delete prop "'+sp.props[S.selPropIdx].id+'"?'))return;
  sp.props.splice(S.selPropIdx,1);S.selPropIdx=-1;updatePropPanel();render();markDirty();
});
document.getElementById('btnaddsprite').addEventListener('click',function(){
  if(S.selPropIdx<0||!sp)return;
  openGallery(S.selPropIdx,-1);
});
document.getElementById('btnapply').addEventListener('click',async function(){
  if(!sp)return;
  var props=sp.props.map(function(p){
    var out={id:p.id,kind:p.kind,x:p.x,y:p.y,layers:p.layers};
    if((p.width||1)!==1)out.width=p.width||1;
    if((p.height||1)!==1)out.height=p.height||1;
    if(p.z!==undefined)out.z=p.z;
    if(p.sceneLayer)out.sceneLayer=p.sceneLayer;
    return out;
  });
  var btn=document.getElementById('btnapply');btn.disabled=true;btn.textContent='Applying\u2026';
  try{
    var res=await fetch('/apply',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({setPieceId:sp.id,props:props,sceneLayers:sp.sceneLayers,npcs:sp.npcs||[]})});
    var r=await res.json();
    if(r.ok){showToast('\u2713 Applied!');S.dirty=false;updateStatus();}
    else showToast('\u2717 '+r.error,true);
  }catch(e){showToast('\u2717 '+e.message,true);}
  finally{btn.disabled=false;btn.textContent='\u2713 Apply';}
});
document.getElementById('spsel').addEventListener('change',function(){
  if(S.dirty&&!confirm('Discard unsaved changes?')){document.getElementById('spsel').value=S.selId;return;}
  selectSP(document.getElementById('spsel').value);
});
document.getElementById('snapsel').addEventListener('change',function(){S.snapMode=document.getElementById('snapsel').value;render();});
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
  S.selPropIdx=-1;S.selNpcIdx=-1;
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

document.getElementById('btnundo').addEventListener('click',function(){
  if(histIdx<=0)return;
  histIdx--;applyHistState(hist[histIdx]);
  S.dirty=hist[histIdx]!==origSP;updateStatus();updUR();
});
document.getElementById('btnredo').addEventListener('click',function(){
  if(histIdx>=hist.length-1)return;
  histIdx++;applyHistState(hist[histIdx]);
  S.dirty=true;updateStatus();updUR();
});
document.getElementById('btnreset').addEventListener('click',function(){
  if(!origSP)return;
  if(S.dirty&&!confirm('Reset to last saved state? Unsaved changes will be lost.'))return;
  var o=JSON.parse(origSP);
  sp.props=o.props;sp.sceneLayers=o.sceneLayers||sp.sceneLayers;
  if(o.npcs!==undefined)sp.npcs=o.npcs;
  S.selPropIdx=-1;S.selNpcIdx=-1;S.dirty=false;hist=[origSP];histIdx=0;
  getLayers();S.activeLayerId=sp.sceneLayers[0].id;
  renderLayersPanel();updatePropPanel();render();updateStatus();updUR();
  showToast('Reset to saved state');
});
document.addEventListener('keydown',function(e){
  if(document.getElementById('gal').style.display==='flex'){if(e.key==='Escape')closeGallery();return;}
  if((e.ctrlKey||e.metaKey)&&!e.shiftKey&&e.key==='z'){e.preventDefault();document.getElementById('btnundo').click();}
  if((e.ctrlKey||e.metaKey)&&(e.key==='y'||(e.shiftKey&&e.key==='Z'))){e.preventDefault();document.getElementById('btnredo').click();}
});

// ── Gallery ──────────────────────────────────────────────────────────────────
function openGallery(propIdx,layerIdx){
  galleryTarget={propIdx:propIdx,layerIdx:layerIdx};
  document.getElementById('galsrch').value='';
  document.getElementById('gal').style.display='flex';
  galTab='catalog';
  document.getElementById('galtab-cat').classList.add('act');
  document.getElementById('galtab-sht').classList.remove('act');
  renderGalCatalog('');
}
function closeGallery(){
  document.getElementById('gal').style.display='none';
  galleryTarget=null;
}
function applyGallerySprite(sprite){
  if(!galleryTarget||!sp)return;
  var p=sp.props[galleryTarget.propIdx];if(!p)return;
  if(galleryTarget.layerIdx===-1){
    p.layers.push({sprite:sprite});
  }else{
    p.layers[galleryTarget.layerIdx].sprite=sprite;
  }
  S.selPropIdx=galleryTarget.propIdx;
  closeGallery();
  refreshSprites();render();markDirty();
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
    var tid=setInterval(function(){if(imgCache[k]){clearInterval(tid);draw();}},120);
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
    var tid2=setInterval(function(){if(genCache[id]){clearInterval(tid2);draw();}},120);
  }
  return cvs;
}
function renderGalCatalog(filter){
  var sc=document.getElementById('galsc');sc.innerHTML='';
  var lo=filter.toLowerCase();
  // Registry sprites
  var keys=Object.keys(CATALOG).filter(function(k){return!filter||k.indexOf(lo)>=0;});
  // Generated sprites: scan genCache keys + pre-populate from known IDs in pack
  var genKeys=[];
  if(S.pack){
    S.pack.setPieces.forEach(function(sp2){
      (sp2.props||[]).forEach(function(p2){
        (p2.layers||[]).forEach(function(l){
          var s2=l.sprite;
          if(s2&&s2.source==='catalog'){
            var bare=(s2.spriteId||'').replace(/^sprite:/,'');
            if(!CATALOG[bare]&&(!filter||bare.indexOf(lo)>=0)&&genKeys.indexOf(bare)<0)
              genKeys.push(bare);
          }
        });
      });
    });
  }
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
function renderGalSheet(sheetKey){
  var sc=document.getElementById('galsc');sc.innerHTML='';
  var sel=document.createElement('select');
  sel.style.cssText='margin-bottom:8px;display:block;background:var(--background-color-inset,#161b22);color:var(--text-color-default,#e6edf3);border:1px solid var(--border-color-default,#30363d);border-radius:4px;padding:3px 7px;font-size:11px;';
  Object.keys(SHEETS_META).forEach(function(k){
    var o=document.createElement('option');o.value=k;o.textContent=k;if(k===sheetKey)o.selected=true;sel.appendChild(o);
  });
  sel.onchange=function(){renderGalSheet(sel.value);};
  sc.appendChild(sel);
  var meta=SHEETS_META[sheetKey];
  if(!imgCache[sheetKey]){
    loadSheet(sheetKey);
    var pnode=document.createElement('p');pnode.textContent='Loading sheet...';pnode.style.color='var(--text-color-muted,#8b949e)';sc.appendChild(pnode);
    var wt=setInterval(function(){if(imgCache[sheetKey]){clearInterval(wt);renderGalSheet(sheetKey);}},200);
    return;
  }
  var img=imgCache[sheetKey];
  var scale=2;
  var W=img.naturalWidth*scale,H=img.naturalHeight*scale;
  var cvs=document.createElement('canvas');cvs.width=W;cvs.height=H;
  cvs.style.cssText='image-rendering:pixelated;cursor:crosshair;display:block;border:1px solid var(--border-color-default,#30363d);border-radius:4px;';
  var cx=cvs.getContext('2d');cx.imageSmoothingEnabled=false;
  cx.drawImage(img,0,0,W,H);
  cx.strokeStyle='rgba(255,255,255,.2)';cx.lineWidth=1;
  var rows=Math.floor((img.naturalHeight-meta.margin)/(16+meta.spacing));
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
    if(tc<0||tr<0||tc>=meta.cols||tr<0)return;
    applyGallerySprite({source:'sheet',sheetKey:sheetKey,col:tc,row:tr});
  };
  sc.appendChild(cvs);
}
document.getElementById('galsrch').addEventListener('input',function(){
  if(galTab==='catalog')renderGalCatalog(this.value);
});
document.getElementById('galbtnclose').addEventListener('click',closeGallery);
document.getElementById('gal').addEventListener('click',function(e){if(e.target===this)closeGallery();});
document.getElementById('galtab-cat').addEventListener('click',function(){
  galTab='catalog';
  document.getElementById('galtab-cat').classList.add('act');
  document.getElementById('galtab-sht').classList.remove('act');
  renderGalCatalog(document.getElementById('galsrch').value);
});
document.getElementById('galtab-sht').addEventListener('click',function(){
  galTab='sheet';
  document.getElementById('galtab-sht').classList.add('act');
  document.getElementById('galtab-cat').classList.remove('act');
  document.getElementById('galsrch').value='';
  renderGalSheet(Object.keys(SHEETS_META)[0]);
});
</script>
<div class="gal" id="gal">
  <div class="galp">
    <div class="galh">
      <span style="font-weight:700;font-size:13px">Pick Sprite</span>
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
</body>
</html>`;
