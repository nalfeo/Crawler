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
        const { setPieceId, props, sceneLayers } = JSON.parse(body);
        const pack = readPack();
        const idx = pack.setPieces.findIndex((s) => s.id === setPieceId);
        if (idx === -1) {
          res.writeHead(404);
          res.end(JSON.stringify({ ok: false, error: 'Not found' }));
          return;
        }
        pack.setPieces[idx] = { ...pack.setPieces[idx], props };
        if (sceneLayers && sceneLayers.length > 0) pack.setPieces[idx].sceneLayers = sceneLayers;
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
.ins{width:215px;flex-shrink:0;display:flex;flex-direction:column;
  border-left:1px solid var(--border-color-default,#30363d);overflow-y:auto}
.ps{padding:7px 9px;border-bottom:1px solid var(--border-color-default,#30363d)}
.ps h3{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;
  color:var(--text-color-muted,#8b949e);margin-bottom:5px}
.fr{display:flex;align-items:center;gap:4px;margin-bottom:4px}
.fr label{width:38px;font-size:11px;color:var(--text-color-muted,#8b949e);flex-shrink:0}
.fr input,.fr select{flex:1;min-width:0;background:var(--background-color-inset,#161b22);
  color:var(--text-color-default,#e6edf3);border:1px solid var(--border-color-default,#30363d);
  border-radius:4px;padding:2px 5px;font-size:11px;font-family:inherit}
.fr input:focus,.fr select:focus{outline:2px solid var(--color-focus-outline,#1f6feb);outline-offset:-1px}
.pr{display:grid;grid-template-columns:1fr 1fr;gap:3px}
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
  <button class="btn" id="btnadd">+ Prop</button>
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
    <div class="nosel" id="nosel">Click a prop to inspect.</div>
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
var CATALOG={
  'player':{k:'kenney-tiny-dungeon',c:0,r:8},
  'enemy.goblin':{k:'kenney-tiny-dungeon',c:1,r:10},
  'enemy.orc':{k:'kenney-tiny-dungeon',c:1,r:9},
  'enemy.rat':{k:'kenney-tiny-dungeon',c:3,r:10},
  'enemy.slime':{k:'kenney-tiny-dungeon',c:0,r:9},
  'enemy.boss':{k:'kenney-tiny-dungeon',c:0,r:10},
  'npc.guide':{k:'kenney-tiny-dungeon',c:3,r:8},
  'item.gem':{k:'custom-pixel-sprites',c:7,r:0},
  'weapon.sword':{k:'kenney-tiny-dungeon',c:8,r:8},
  'weapon.bat':{k:'kenney-tiny-dungeon',c:9,r:9}
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
function resolveSprite(s){
  if(!s)return null;
  var k,c,r;
  if(s.source==='sheet'){k=s.sheetKey;c=s.col||0;r=s.row||0;}
  else if(s.source==='catalog'){
    var bare=(s.spriteId||'').replace(/^sprite:/,'');
    var def=CATALOG[bare];if(!def)return null;
    k=def.k;c=def.c;r=def.r;
  }else if(s.source==='custom'){return s.placeholder?resolveSprite(s.placeholder):null;}
  else{return null;}
  var meta=SHEETS_META[k];if(!meta)return null;
  var img=loadSheet(k);if(!img)return null;
  return{img:img,sx:meta.margin+c*(16+meta.spacing),sy:meta.margin+r*(16+meta.spacing)};
}
var S={pack:null,selId:null,selPropIdx:-1,tileSize:48,dirty:false,snapMode:'tile',activeLayerId:null};
var sp=null;
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
  S.selId=id;S.selPropIdx=-1;S.dirty=false;
  sp=JSON.parse(JSON.stringify(S.pack.setPieces.find(function(s){return s.id===id;})));
  document.getElementById('spsel').value=id;
  document.getElementById('spmeta').textContent=(sp.theme||'')+' \u00b7 '+(sp.sizing||'');
  getLayers();S.activeLayerId=sp.sceneLayers[0].id;
  renderLayersPanel();updatePropPanel();render();
  setGs('Editing: '+sp.name+' ('+sp.width+'x'+sp.height+')');updateStatus();
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
  var sel=document.getElementById('player'),ls=getLayers(),cur=sel.value;
  sel.innerHTML=ls.map(function(l){return'<option value="'+l.id+'">'+l.name+'</option>';}).join('');
  if(cur)sel.value=cur;
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
  sorted.forEach(function(x){drawProp(x.p,x.i===S.selPropIdx,drag&&drag.idx===x.i?drag:null);});
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
      ctx.drawImage(res.img,res.sx,res.sy,16,16,px+1,py+1,pw2-2,ph2-2);
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
  var idx=hitProp(pos.x,pos.y);
  if(idx>=0){
    S.selPropIdx=idx;var pp=sp.props[idx];var ts2=S.tileSize;
    drag={mode:'move',idx:idx,sx:pos.x,sy:pos.y,
      orig:JSON.parse(JSON.stringify(pp)),dispX:pp.x*ts2,dispY:pp.y*ts2};
    updatePropPanel();render();
  }else{S.selPropIdx=-1;drag=null;updatePropPanel();render();}
});
canvas.addEventListener('mousemove',function(e){
  if(!drag||!sp)return;
  var pos=cxy(e),ts=S.tileSize,dx=pos.x-drag.sx,dy=pos.y-drag.sy,p=sp.props[drag.idx];
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
  var ts=S.tileSize,p=sp.props[drag.idx];
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
  canvas.style.cursor=hitProp(pos.x,pos.y)>=0?'grab':'default';
},true);
function updatePropPanel(){
  var ns=document.getElementById('nosel'),ed=document.getElementById('proped');
  document.getElementById('btndel').disabled=S.selPropIdx<0;
  if(S.selPropIdx<0||!sp){ns.style.display='';ed.style.display='none';return;}
  ns.style.display='none';ed.style.display='';
  refreshPropInputs();refreshSprites();
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
    var r=mkFR('spriteId');var inp=document.createElement('input');
    inp.type='text';inp.value=sprite.spriteId||'';inp.placeholder='sprite:player';
    inp.onchange=function(){setSprFld(li,'spriteId',inp.value);};
    r.appendChild(inp);frag.appendChild(r);
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
document.getElementById('btnadd').addEventListener('click',function(){
  if(!sp)return;
  var al=getActiveLayer();
  sp.props.push({id:'prop-'+Date.now(),kind:'furniture',x:0,y:0,width:1,height:1,
    sceneLayer:al.id,layers:[{sprite:{source:'sheet',sheetKey:'kenney-tiny-dungeon',col:0,row:0}}]});
  S.selPropIdx=sp.props.length-1;updatePropPanel();render();markDirty();
});
document.getElementById('btndel').addEventListener('click',function(){
  if(S.selPropIdx<0||!sp)return;
  if(!confirm('Delete prop "'+sp.props[S.selPropIdx].id+'"?'))return;
  sp.props.splice(S.selPropIdx,1);S.selPropIdx=-1;updatePropPanel();render();markDirty();
});
document.getElementById('btnaddsprite').addEventListener('click',function(){
  var p=sp&&sp.props[S.selPropIdx];if(!p)return;
  p.layers.push({sprite:{source:'sheet',sheetKey:'kenney-tiny-dungeon',col:0,row:0}});
  refreshSprites();render();markDirty();
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
      body:JSON.stringify({setPieceId:sp.id,props:props,sceneLayers:sp.sceneLayers})});
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
function markDirty(){S.dirty=true;updateStatus();}
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
</script>
</body>
</html>`;
