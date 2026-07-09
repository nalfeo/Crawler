// Extension: set-piece-editor
// Visual drag-and-drop editor for set-piece layouts, with Apply-to-repo support.
// Serves a loopback iframe canvas for editing props (move, resize, add, delete),
// and writes changes back to src/shared/data/set-pieces.json on Apply.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { joinSession, createCanvas, CanvasError } from '@github/copilot-sdk/extension';

// ──────────────────────────────────────────────────────────────────────────────
// File I/O
// ──────────────────────────────────────────────────────────────────────────────
// Derive repo root from this file's location:
//   <repo_root>/.github/extensions/set-piece-editor/extension.mjs
// so 4 levels up = repo root
const __extDir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__extDir, '..', '..', '..');

function getSetPiecesPath() {
  return join(REPO_ROOT, 'src', 'shared', 'data', 'set-pieces.json');
}

function readPack() {
  return JSON.parse(readFileSync(getSetPiecesPath(), 'utf-8'));
}

function writePack(pack) {
  writeFileSync(getSetPiecesPath(), JSON.stringify(pack, null, 2) + '\n', 'utf-8');
}

// ──────────────────────────────────────────────────────────────────────────────
// SSE broadcast
// ──────────────────────────────────────────────────────────────────────────────
const sseClients = new Map(); // instanceId → Set<res>

function broadcastToInstance(instanceId, data) {
  const clients = sseClients.get(instanceId);
  if (!clients) return;
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of [...clients]) {
    try {
      res.write(msg);
    } catch {
      clients.delete(res);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// HTTP request handler
// ──────────────────────────────────────────────────────────────────────────────
function handleRequest(instanceId, req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');

  // CORS headers for iframe requests
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'GET' && url.pathname === '/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(renderHtml());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/data') {
    try {
      const pack = readPack();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(pack));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: String(e) }));
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
        const { setPieceId, props } = JSON.parse(body);
        const pack = readPack();
        const idx = pack.setPieces.findIndex((sp) => sp.id === setPieceId);
        if (idx === -1) {
          res.writeHead(404);
          res.end(JSON.stringify({ ok: false, error: `Set piece "${setPieceId}" not found` }));
          return;
        }
        pack.setPieces[idx] = { ...pack.setPieces[idx], props };
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
    req.on('close', () => {
      sseClients.get(instanceId)?.delete(res);
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}

// ──────────────────────────────────────────────────────────────────────────────
// Server lifecycle
// ──────────────────────────────────────────────────────────────────────────────
const servers = new Map(); // instanceId → { server, url }

async function startServer(instanceId) {
  const server = createServer((req, res) => handleRequest(instanceId, req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { server, url: `http://127.0.0.1:${port}/` };
}

// ──────────────────────────────────────────────────────────────────────────────
// Extension registration
// ──────────────────────────────────────────────────────────────────────────────
const session = await joinSession({
  canvases: [
    createCanvas({
      id: 'set-piece-editor',
      displayName: 'Set Piece Editor',
      description:
        'Visual drag-and-drop tile-grid editor for set-piece layouts. Move, resize, and add props, then apply changes directly to set-pieces.json in the repo.',
      inputSchema: {
        type: 'object',
        properties: {
          setPieceId: {
            type: 'string',
            description: 'ID of the set piece to open for editing (optional, defaults to first)',
          },
        },
      },
      actions: [
        {
          name: 'list_set_pieces',
          description: 'Return the list of available set piece IDs, names, and themes',
          handler: async () => {
            const pack = readPack();
            return pack.setPieces.map((sp) => ({
              id: sp.id,
              name: sp.name,
              theme: sp.theme,
              size: `${sp.width}×${sp.height}`,
            }));
          },
        },
        {
          name: 'apply_layout',
          description:
            'Programmatically apply a modified props array to a set piece in set-pieces.json',
          inputSchema: {
            type: 'object',
            required: ['setPieceId', 'props'],
            properties: {
              setPieceId: { type: 'string' },
              props: { type: 'array' },
            },
          },
          handler: async (ctx) => {
            const { setPieceId, props } = ctx.input;
            const pack = readPack();
            const idx = pack.setPieces.findIndex((sp) => sp.id === setPieceId);
            if (idx === -1)
              throw new CanvasError('not_found', `Set piece "${setPieceId}" not found`);
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
        const initialId = ctx.input?.setPieceId ?? '';
        const suffix = initialId ? `?setPieceId=${encodeURIComponent(initialId)}` : '';
        return { title: 'Set Piece Editor', url: entry.url + suffix };
      },
      onClose: async (ctx) => {
        const entry = servers.get(ctx.instanceId);
        if (entry) {
          servers.delete(ctx.instanceId);
          sseClients.delete(ctx.instanceId);
          await new Promise((resolve) => entry.server.close(() => resolve()));
        }
      },
    }),
  ],
});

// ──────────────────────────────────────────────────────────────────────────────
// HTML template
// ──────────────────────────────────────────────────────────────────────────────
function renderHtml() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Set Piece Editor</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{
  display:flex;flex-direction:column;height:100vh;overflow:hidden;
  background:var(--background-color-default,#0d1117);
  color:var(--text-color-default,#e6edf3);
  font-family:var(--font-sans,system-ui,sans-serif);
  font-size:var(--text-body-medium,13px);
  line-height:var(--leading-body-medium,18px);
}
.header{
  display:flex;align-items:center;gap:8px;
  padding:6px 12px;
  border-bottom:1px solid var(--border-color-default,#30363d);
  flex-shrink:0;
}
.header h1{font-size:13px;font-weight:600;white-space:nowrap}
.header select{
  max-width:240px;min-width:140px;
  background:var(--background-color-inset,#161b22);
  color:var(--text-color-default,#e6edf3);
  border:1px solid var(--border-color-default,#30363d);
  border-radius:6px;padding:3px 8px;font-size:12px;
}
.spacer{flex:1}
.btn{
  display:inline-flex;align-items:center;gap:4px;
  padding:4px 10px;border:1px solid var(--border-color-default,#30363d);
  border-radius:6px;background:var(--background-color-subtle,#21262d);
  color:var(--text-color-default,#e6edf3);cursor:pointer;
  font-size:12px;font-family:inherit;white-space:nowrap;
}
.btn:hover:not(:disabled){background:var(--background-color-emphasis,#30363d)}
.btn:disabled{opacity:.4;cursor:default}
.btn-primary{background:#238636;border-color:#2ea043;color:#fff}
.btn-primary:hover:not(:disabled){background:#2ea043}
.btn-danger{background:#490202;border-color:#da3633;color:#ffa0a0}
.btn-danger:hover:not(:disabled){background:#6b0000}
.main{display:flex;flex:1;overflow:hidden}
.grid-area{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}
.grid-toolbar{
  display:flex;align-items:center;gap:6px;
  padding:5px 12px;font-size:11px;
  color:var(--text-color-muted,#8b949e);
  border-bottom:1px solid var(--border-color-default,#30363d);
  flex-shrink:0;
}
.grid-scroll{flex:1;overflow:auto;padding:16px}
#grid-canvas{cursor:default;display:block}
.props-panel{
  width:230px;flex-shrink:0;
  display:flex;flex-direction:column;
  border-left:1px solid var(--border-color-default,#30363d);
  overflow-y:auto;
}
.panel-section{padding:9px 11px;border-bottom:1px solid var(--border-color-default,#30363d)}
.panel-section h3{
  font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;
  color:var(--text-color-muted,#8b949e);margin-bottom:7px;
}
.form-row{display:flex;align-items:center;gap:5px;margin-bottom:5px}
.form-row label{width:44px;font-size:11px;color:var(--text-color-muted,#8b949e);flex-shrink:0}
.form-row input,.form-row select{
  flex:1;min-width:0;
  background:var(--background-color-inset,#161b22);
  color:var(--text-color-default,#e6edf3);
  border:1px solid var(--border-color-default,#30363d);
  border-radius:4px;padding:2px 6px;font-size:11px;font-family:inherit;
}
.form-row input:focus,.form-row select:focus{
  outline:2px solid var(--color-focus-outline,#1f6feb);outline-offset:-1px
}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:4px}
.no-sel{padding:16px;color:var(--text-color-muted,#8b949e);font-size:11px;text-align:center}
.layer-item{
  background:var(--background-color-inset,#161b22);
  border:1px solid var(--border-color-default,#30363d);
  border-radius:5px;margin-bottom:5px;overflow:hidden;
}
.layer-hd{
  display:flex;align-items:center;gap:5px;padding:3px 8px;
  background:var(--background-color-subtle,#21262d);
  font-size:10px;font-weight:700;
  color:var(--text-color-muted,#8b949e);
}
.layer-bd{padding:7px 8px}
.status{
  padding:3px 12px;font-size:11px;flex-shrink:0;
  color:var(--text-color-muted,#8b949e);
  border-top:1px solid var(--border-color-default,#30363d);
}
.toast{
  position:fixed;bottom:28px;left:50%;transform:translateX(-50%);
  background:#238636;color:#fff;padding:6px 14px;border-radius:8px;
  font-size:12px;font-weight:600;opacity:0;transition:opacity .2s;
  pointer-events:none;z-index:100;
}
.toast.show{opacity:1}
</style>
</head>
<body>

<div class="header">
  <h1>⚙ Set Piece Editor</h1>
  <select id="sp-sel"></select>
  <span style="font-size:11px;color:var(--text-color-muted,#8b949e)" id="sp-meta"></span>
  <span class="spacer"></span>
  <button class="btn" id="btn-add">+ Add Prop</button>
  <button class="btn btn-danger" id="btn-del" disabled>✕ Delete</button>
  <button class="btn btn-primary" id="btn-apply">✓ Apply to Repo</button>
</div>

<div class="main">
  <div class="grid-area">
    <div class="grid-toolbar">
      <span id="grid-status">Loading…</span>
      <span class="spacer"></span>
      <button class="btn" id="btn-zoom-out" style="padding:2px 7px">−</button>
      <span id="zoom-lbl" style="min-width:36px;text-align:center">48px</span>
      <button class="btn" id="btn-zoom-in" style="padding:2px 7px">+</button>
    </div>
    <div class="grid-scroll">
      <canvas id="grid-canvas"></canvas>
    </div>
  </div>

  <div class="props-panel" id="props-panel">
    <div class="no-sel" id="no-sel">Click a prop to inspect or edit it.</div>
    <div id="prop-ed" style="display:none">
      <div class="panel-section">
        <h3>Prop</h3>
        <div class="form-row"><label>id</label><input id="p-id" type="text"></div>
        <div class="form-row"><label>kind</label>
          <select id="p-kind">
            <option>floor</option><option>wall</option><option>door</option>
            <option>fixture</option><option>furniture</option><option>decoration</option><option>actor</option>
          </select>
        </div>
        <div class="pair">
          <div class="form-row"><label>x</label><input id="p-x" type="number" min="0" step="1"></div>
          <div class="form-row"><label>y</label><input id="p-y" type="number" min="0" step="1"></div>
        </div>
        <div class="pair">
          <div class="form-row"><label>w</label><input id="p-w" type="number" min="1" step="1"></div>
          <div class="form-row"><label>h</label><input id="p-h" type="number" min="1" step="1"></div>
        </div>
        <div class="form-row"><label>z</label><input id="p-z" type="number" placeholder="auto"></div>
      </div>
      <div class="panel-section">
        <h3>Layers</h3>
        <div id="layers-list"></div>
        <button class="btn" id="btn-add-layer" style="width:100%;margin-top:3px">+ Add Layer</button>
      </div>
    </div>
  </div>
</div>

<div class="status" id="status-bar">Ready</div>
<div class="toast" id="toast"></div>

<script>
// ── State ──
const S = {
  pack: null,
  selId: null,
  selPropIdx: -1,
  tileSize: 48,
  dirty: false,
};
let sp = null; // mutable deep-clone of current set piece

// ── Kind palette ──
const KINDS = {
  floor:      { bg:'#162016', bd:'#2d5a2d', lbl:'#4ade80' },
  wall:       { bg:'#16162e', bd:'#2d2d5a', lbl:'#818cf8' },
  door:       { bg:'#2a160a', bd:'#5a3410', lbl:'#fb923c' },
  fixture:    { bg:'#0a1826', bd:'#104060', lbl:'#38bdf8' },
  furniture:  { bg:'#0e2618', bd:'#1a5a30', lbl:'#34d399' },
  decoration: { bg:'#28240a', bd:'#5a520a', lbl:'#facc15' },
  actor:      { bg:'#280a18', bd:'#5a1030', lbl:'#f472b6' },
};
const Z_DEFAULT = { floor:0, wall:10, door:12, fixture:20, furniture:30, decoration:40, actor:50 };
function getZ(p){ return p.z !== undefined ? p.z : (Z_DEFAULT[p.kind] ?? 0); }

// ── DOM refs ──
const canvas = document.getElementById('grid-canvas');
const ctx = canvas.getContext('2d');
const spSel = document.getElementById('sp-sel');

// ── Data loading ──
async function loadData(){
  const params = new URLSearchParams(location.search);
  const initId = params.get('setPieceId') || '';
  const res = await fetch('/data');
  S.pack = await res.json();
  spSel.innerHTML = S.pack.setPieces.map(s =>
    \`<option value="\${s.id}">\${s.name} (\${s.width}×\${s.height})</option>\`
  ).join('');
  const firstId = S.pack.setPieces.some(s => s.id === initId) ? initId : S.pack.setPieces[0]?.id;
  if(firstId) selectSP(firstId);
}

function selectSP(id){
  S.selId = id;
  S.selPropIdx = -1;
  S.dirty = false;
  const src = S.pack.setPieces.find(s => s.id === id);
  sp = JSON.parse(JSON.stringify(src));
  spSel.value = id;
  document.getElementById('sp-meta').textContent = \`\${sp.theme} · \${sp.sizing}\`;
  updatePropPanel();
  render();
  setGridStatus(\`Editing: \${sp.name} (\${sp.width}×\${sp.height})\`);
  updateStatus();
}

// ── Rendering ──
function render(){
  if(!sp) return;
  const ts = S.tileSize;
  const w = sp.width, h = sp.height;
  canvas.width = w*ts; canvas.height = h*ts;
  // bg
  ctx.fillStyle = '#090d12';
  ctx.fillRect(0,0,w*ts,h*ts);
  // grid
  ctx.strokeStyle = '#1e2530'; ctx.lineWidth = 1;
  for(let x=0;x<=w;x++){ ctx.beginPath(); ctx.moveTo(x*ts,0); ctx.lineTo(x*ts,h*ts); ctx.stroke(); }
  for(let y=0;y<=h;y++){ ctx.beginPath(); ctx.moveTo(0,y*ts); ctx.lineTo(w*ts,y*ts); ctx.stroke(); }
  // coord hints
  ctx.fillStyle = '#ffffff18'; ctx.font = '8px monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  for(let x=0;x<w;x++) for(let y=0;y<h;y++) ctx.fillText(\`\${x},\${y}\`,x*ts+2,y*ts+2);
  // props sorted by z
  const sorted = sp.props.map((p,i)=>({...p,_i:i})).sort((a,b)=>getZ(a)-getZ(b));
  for(const p of sorted) drawProp(p, p._i === S.selPropIdx);
  // handles
  if(S.selPropIdx >= 0){ const p = sp.props[S.selPropIdx]; if(p) drawHandles(p); }
}

function drawProp(prop, sel){
  const ts = S.tileSize;
  const pw=(prop.width??1), ph=(prop.height??1);
  const px=prop.x*ts, py=prop.y*ts, pw2=pw*ts, ph2=ph*ts;
  const C = KINDS[prop.kind] ?? KINDS.fixture;
  ctx.fillStyle = C.bg;
  ctx.fillRect(px+1,py+1,pw2-2,ph2-2);
  ctx.strokeStyle = sel ? '#ffffff' : C.bd;
  ctx.lineWidth = sel ? 2.5 : 1.5;
  ctx.strokeRect(px+1.5,py+1.5,pw2-3,ph2-3);
  // label
  ctx.fillStyle = C.lbl;
  ctx.font = \`bold \${Math.min(11,ts*0.21)}px system-ui\`;
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  const maxW = pw2-8;
  ctx.fillText(trunc(ctx,prop.id,maxW),px+4,py+4);
  if(ph2>26){
    ctx.fillStyle = C.lbl+'99';
    ctx.font = \`\${Math.min(9,ts*0.17)}px system-ui\`;
    ctx.fillText(prop.kind,px+4,py+4+Math.min(14,ts*0.26));
  }
  const hint = spriteHint(prop);
  if(ph2>46 && hint){
    ctx.fillStyle='#8b949e';ctx.font='8px monospace';
    ctx.fillText(trunc(ctx,hint,maxW),px+4,py+ph2-12);
  }
}

function spriteHint(prop){
  const s = prop.layers?.[0]?.sprite;
  if(!s) return '';
  if(s.source==='catalog') return s.spriteId;
  if(s.source==='sheet') return \`\${s.sheetKey}[\${s.col},\${s.row}]\`;
  if(s.source==='custom') return \`✦ \${s.label}\`;
  return '';
}

function trunc(c,text,maxW){
  if(c.measureText(text).width<=maxW) return text;
  let t=text;
  while(t.length>1 && c.measureText(t+'…').width>maxW) t=t.slice(0,-1);
  return t+'…';
}

// ── Resize handles ──
const HS = 8;
function handlePositions(px,py,pw2,ph2){
  return [
    {x:px,      y:py,       dx:-1,dy:-1,type:'nw'},
    {x:px+pw2/2,y:py,       dx: 0,dy:-1,type:'n'},
    {x:px+pw2,  y:py,       dx: 1,dy:-1,type:'ne'},
    {x:px+pw2,  y:py+ph2/2, dx: 1,dy: 0,type:'e'},
    {x:px+pw2,  y:py+ph2,   dx: 1,dy: 1,type:'se'},
    {x:px+pw2/2,y:py+ph2,   dx: 0,dy: 1,type:'s'},
    {x:px,      y:py+ph2,   dx:-1,dy: 1,type:'sw'},
    {x:px,      y:py+ph2/2, dx:-1,dy: 0,type:'w'},
  ];
}
function drawHandles(prop){
  const ts=S.tileSize;
  const pw=(prop.width??1),ph=(prop.height??1);
  const hs=handlePositions(prop.x*ts,prop.y*ts,pw*ts,ph*ts,HS);
  ctx.fillStyle='#ffffff'; ctx.strokeStyle='#1f6feb'; ctx.lineWidth=1;
  for(const h of hs){
    ctx.fillRect(h.x-HS/2,h.y-HS/2,HS,HS);
    ctx.strokeRect(h.x-HS/2,h.y-HS/2,HS,HS);
  }
}
function hitHandle(prop,cx,cy){
  const ts=S.tileSize;
  const pw=(prop.width??1),ph=(prop.height??1);
  for(const h of handlePositions(prop.x*ts,prop.y*ts,pw*ts,ph*ts,HS)){
    if(Math.abs(cx-h.x)<=HS && Math.abs(cy-h.y)<=HS) return h;
  }
  return null;
}
function hitProp(cx,cy){
  const ts=S.tileSize;
  const sorted=[...sp.props.map((p,i)=>({p,i}))].sort((a,b)=>getZ(b.p)-getZ(a.p));
  for(const {p,i} of sorted){
    const pw=(p.width??1),ph=(p.height??1);
    if(cx>=p.x*ts&&cx<(p.x+pw)*ts&&cy>=p.y*ts&&cy<(p.y+ph)*ts) return i;
  }
  return -1;
}

// ── Drag / resize ──
let drag = null;
function cxy(e){ const r=canvas.getBoundingClientRect(); return {x:e.clientX-r.left,y:e.clientY-r.top}; }

canvas.addEventListener('mousedown',e=>{
  if(!sp) return;
  const {x,y}=cxy(e);
  if(S.selPropIdx>=0){
    const p=sp.props[S.selPropIdx];
    const h=hitHandle(p,x,y);
    if(h){ drag={mode:'resize',idx:S.selPropIdx,sx:x,sy:y,orig:JSON.parse(JSON.stringify(p)),h}; return; }
  }
  const idx=hitProp(x,y);
  if(idx>=0){
    S.selPropIdx=idx;
    drag={mode:'move',idx,sx:x,sy:y,orig:JSON.parse(JSON.stringify(sp.props[idx]))};
    updatePropPanel(); render();
  } else {
    S.selPropIdx=-1; drag=null; updatePropPanel(); render();
  }
});

canvas.addEventListener('mousemove',e=>{
  if(!drag||!sp) return;
  const {x,y}=cxy(e);
  const ts=S.tileSize;
  const dx=x-drag.sx, dy=y-drag.sy;
  const p=sp.props[drag.idx];
  if(!p) return;
  if(drag.mode==='move'){
    const dtx=Math.round(dx/ts), dty=Math.round(dy/ts);
    p.x=Math.max(0,Math.min(sp.width-(p.width??1),drag.orig.x+dtx));
    p.y=Math.max(0,Math.min(sp.height-(p.height??1),drag.orig.y+dty));
    refreshPropInputs(); render(); markDirty();
  } else {
    const h=drag.h, o=drag.orig;
    let nx=o.x,ny=o.y,nw=o.width??1,nh=o.height??1;
    const dtx=Math.round(dx/ts), dty=Math.round(dy/ts);
    if(h.dx<0){ const d=Math.min(dtx,nw-1); nx=o.x+d; nw=(o.width??1)-d; }
    else if(h.dx>0){ nw=Math.max(1,(o.width??1)+dtx); }
    if(h.dy<0){ const d=Math.min(dty,nh-1); ny=o.y+d; nh=(o.height??1)-d; }
    else if(h.dy>0){ nh=Math.max(1,(o.height??1)+dty); }
    nx=Math.max(0,nx); ny=Math.max(0,ny);
    nw=Math.min(nw,sp.width-nx); nh=Math.min(nh,sp.height-ny);
    p.x=nx; p.y=ny; p.width=nw; p.height=nh;
    refreshPropInputs(); render(); markDirty();
  }
});
canvas.addEventListener('mouseup',()=>{ drag=null; });
canvas.addEventListener('mouseleave',()=>{ drag=null; });

// cursor
canvas.addEventListener('mousemove',e=>{
  if(drag) return;
  if(!sp) return;
  const {x,y}=cxy(e);
  const CURSORS={nw:'nw-resize',ne:'ne-resize',sw:'sw-resize',se:'se-resize',n:'n-resize',s:'s-resize',e:'e-resize',w:'w-resize'};
  if(S.selPropIdx>=0){
    const h=hitHandle(sp.props[S.selPropIdx],x,y);
    if(h){ canvas.style.cursor=CURSORS[h.type]||'crosshair'; return; }
  }
  canvas.style.cursor=hitProp(x,y)>=0?'grab':'default';
},true);

// ── Property panel ──
function updatePropPanel(){
  const noSel=document.getElementById('no-sel');
  const ed=document.getElementById('prop-ed');
  document.getElementById('btn-del').disabled=S.selPropIdx<0;
  if(S.selPropIdx<0||!sp){ noSel.style.display=''; ed.style.display='none'; return; }
  noSel.style.display='none'; ed.style.display='';
  refreshPropInputs();
  renderLayers();
}

function refreshPropInputs(){
  const p=sp?.props[S.selPropIdx]; if(!p) return;
  document.getElementById('p-id').value=p.id;
  document.getElementById('p-kind').value=p.kind;
  document.getElementById('p-x').value=p.x;
  document.getElementById('p-y').value=p.y;
  document.getElementById('p-w').value=p.width??1;
  document.getElementById('p-h').value=p.height??1;
  document.getElementById('p-z').value=p.z!==undefined?p.z:'';
}

function renderLayers(){
  const p=sp?.props[S.selPropIdx]; if(!p) return;
  const list=document.getElementById('layers-list');
  list.innerHTML='';
  p.layers.forEach((l,i)=>list.appendChild(mkLayerEl(l,i,p)));
}

function mkLayerEl(layer,li,prop){
  const div=document.createElement('div'); div.className='layer-item';
  const hd=document.createElement('div'); hd.className='layer-hd';
  const lbl=document.createElement('span'); lbl.style.flex='1'; lbl.textContent='Layer '+(li+1);
  hd.appendChild(lbl);
  if(prop.layers.length>1){
    const del=document.createElement('button'); del.className='btn btn-danger';
    del.style.cssText='padding:1px 5px;font-size:10px;';
    del.textContent='×';
    del.onclick=e=>{ e.stopPropagation(); rmLayer(li); };
    hd.appendChild(del);
  }
  const bd=document.createElement('div'); bd.className='layer-bd';
  bd.appendChild(mkSpriteFields(layer.sprite,li));
  div.appendChild(hd); div.appendChild(bd);
  return div;
}

const SHEETS=['kenney-tiny-dungeon','kenney-tiny-town','kenney-roguelike-rpg-pack','custom-pixel-sprites'];

function mkSpriteFields(sprite,li){
  const frag=document.createDocumentFragment();
  const srcRow=mkRow('source');
  const srcSel=document.createElement('select');
  ['catalog','sheet','custom'].forEach(v=>{ const o=document.createElement('option'); o.value=v; o.textContent=v; srcSel.appendChild(o); });
  srcSel.value=sprite.source;
  srcSel.onchange=()=>{ setLayerSource(li,srcSel.value); };
  srcRow.appendChild(srcSel); frag.appendChild(srcRow);

  if(sprite.source==='catalog'){
    const r=mkRow('spriteId'); const inp=document.createElement('input');
    inp.type='text'; inp.value=sprite.spriteId; inp.placeholder='sprite:player';
    inp.onchange=()=>setLayerField(li,'spriteId',inp.value);
    r.appendChild(inp); frag.appendChild(r);
  } else if(sprite.source==='sheet'){
    const kr=mkRow('sheet'); const ks=document.createElement('select');
    SHEETS.forEach(k=>{ const o=document.createElement('option'); o.value=k; o.textContent=k.replace('kenney-',''); if(sprite.sheetKey===k) o.selected=true; ks.appendChild(o); });
    ks.onchange=()=>setLayerField(li,'sheetKey',ks.value);
    kr.appendChild(ks); frag.appendChild(kr);
    const pair=document.createElement('div'); pair.className='pair';
    for(const [f,lb] of [['col','col'],['row','row']]){
      const r=mkRow(lb); const inp=document.createElement('input');
      inp.type='number'; inp.min='0'; inp.step='1'; inp.value=sprite[f]??0;
      inp.onchange=()=>setLayerField(li,f,parseInt(inp.value)||0);
      r.appendChild(inp); pair.appendChild(r);
    }
    frag.appendChild(pair);
  } else if(sprite.source==='custom'){
    for(const [f,lb,ph] of [['requestId','reqId','my-custom'],['label','label','Human label'],['prompt','prompt','Art prompt']]){
      const r=mkRow(lb); const inp=document.createElement('input');
      inp.type='text'; inp.value=sprite[f]??''; inp.placeholder=ph;
      inp.onchange=()=>setLayerField(li,f,inp.value);
      r.appendChild(inp); frag.appendChild(r);
    }
  }
  return frag;
}

function mkRow(labelText){
  const r=document.createElement('div'); r.className='form-row';
  const l=document.createElement('label'); l.textContent=labelText;
  r.appendChild(l); return r;
}

function setLayerSource(li,src){
  const p=sp.props[S.selPropIdx];
  const defs={
    catalog:{source:'catalog',spriteId:'sprite:player'},
    sheet:{source:'sheet',sheetKey:'kenney-tiny-dungeon',col:0,row:0},
    custom:{source:'custom',requestId:'new-custom',label:'New sprite',prompt:'Pixel art description here'},
  };
  p.layers[li].sprite=defs[src]??defs.catalog;
  renderLayers(); render(); markDirty();
}
function setLayerField(li,field,val){
  sp.props[S.selPropIdx].layers[li].sprite[field]=val;
  render(); markDirty();
}
function rmLayer(li){
  sp.props[S.selPropIdx].layers.splice(li,1);
  renderLayers(); render(); markDirty();
}

// prop input sync
['p-id','p-kind','p-x','p-y','p-w','p-h','p-z'].forEach(id=>{
  document.getElementById(id).addEventListener('change',syncPropInputs);
});
function syncPropInputs(){
  const p=sp?.props[S.selPropIdx]; if(!p) return;
  p.id=document.getElementById('p-id').value||p.id;
  p.kind=document.getElementById('p-kind').value;
  p.x=Math.max(0,parseInt(document.getElementById('p-x').value)||0);
  p.y=Math.max(0,parseInt(document.getElementById('p-y').value)||0);
  p.width=Math.max(1,parseInt(document.getElementById('p-w').value)||1);
  p.height=Math.max(1,parseInt(document.getElementById('p-h').value)||1);
  const zv=document.getElementById('p-z').value.trim();
  if(zv===''){ delete p.z; } else { p.z=parseInt(zv); }
  render(); markDirty();
}

// ── Add / Delete ──
document.getElementById('btn-add').addEventListener('click',()=>{
  if(!sp) return;
  const id='prop-'+Date.now();
  sp.props.push({ id, kind:'furniture', x:0, y:0, width:1, height:1,
    layers:[{sprite:{source:'sheet',sheetKey:'kenney-tiny-dungeon',col:0,row:0}}] });
  S.selPropIdx=sp.props.length-1;
  updatePropPanel(); render(); markDirty();
});

document.getElementById('btn-del').addEventListener('click',()=>{
  if(S.selPropIdx<0||!sp) return;
  if(!confirm('Delete prop "'+sp.props[S.selPropIdx]?.id+'"?')) return;
  sp.props.splice(S.selPropIdx,1);
  S.selPropIdx=-1; updatePropPanel(); render(); markDirty();
});

document.getElementById('btn-add-layer').addEventListener('click',()=>{
  const p=sp?.props[S.selPropIdx]; if(!p) return;
  p.layers.push({sprite:{source:'sheet',sheetKey:'kenney-tiny-dungeon',col:0,row:0}});
  renderLayers(); render(); markDirty();
});

// ── Apply ──
document.getElementById('btn-apply').addEventListener('click',async()=>{
  if(!sp) return;
  const props=sp.props.map(p=>{
    const out={id:p.id,kind:p.kind,x:p.x,y:p.y,layers:p.layers};
    if((p.width??1)!==1||(p.height??1)!==1){ out.width=p.width??1; out.height=p.height??1; }
    if(p.z!==undefined) out.z=p.z;
    return out;
  });
  const btn=document.getElementById('btn-apply');
  btn.disabled=true; btn.textContent='⏳ Applying…';
  try{
    const res=await fetch('/apply',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({setPieceId:sp.id,props}),
    });
    const r=await res.json();
    if(r.ok){ showToast('✓ Applied to repo!'); S.dirty=false; updateStatus(); }
    else showToast('✗ '+r.error,true);
  } catch(e){ showToast('✗ '+e.message,true); }
  finally{ btn.disabled=false; btn.textContent='✓ Apply to Repo'; }
});

// ── Set piece selector ──
spSel.addEventListener('change',()=>{
  if(S.dirty&&!confirm('Discard unsaved changes?')){ spSel.value=S.selId; return; }
  selectSP(spSel.value);
});

// ── Zoom ──
document.getElementById('btn-zoom-in').addEventListener('click',()=>{
  S.tileSize=Math.min(128,S.tileSize+8);
  document.getElementById('zoom-lbl').textContent=S.tileSize+'px';
  render();
});
document.getElementById('btn-zoom-out').addEventListener('click',()=>{
  S.tileSize=Math.max(16,S.tileSize-8);
  document.getElementById('zoom-lbl').textContent=S.tileSize+'px';
  render();
});

// ── Helpers ──
function markDirty(){ S.dirty=true; updateStatus(); }
function setGridStatus(t){ document.getElementById('grid-status').textContent=t; }
function updateStatus(){
  const sb=document.getElementById('status-bar');
  sb.textContent=S.dirty?'● Unsaved changes — click Apply to write to repo':'Ready';
  sb.style.color=S.dirty?'#f0883e':'';
}
let toastT;
function showToast(msg,err=false){
  const t=document.getElementById('toast');
  t.textContent=msg; t.style.background=err?'#6b0000':'#238636';
  t.classList.add('show'); clearTimeout(toastT);
  toastT=setTimeout(()=>t.classList.remove('show'),2800);
}

// ── SSE ──
const es=new EventSource('/events');
es.onmessage=e=>{
  try{
    const d=JSON.parse(e.data);
    if(d.type==='applied') showToast('✓ Saved!');
  } catch {}
};

// ── Boot ──
loadData().catch(e=>{ setGridStatus('Error: '+e.message); });
</script>
</body>
</html>`;
}
