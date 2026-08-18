// Extension: animation-viewer
// Slices a sprite sheet into individual frames and plays them back as a
// looping animation. Also renders each frame side-by-side and the full sheet.
//
// open_canvas input: { sheetPath, rows, cols, frameRate, name?, outputW?, outputH? }
// Actions: load_sheet — swap the sheet in an open instance

import { createServer } from 'node:http';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { joinSession, createCanvas } from '@github/copilot-sdk/extension';

const servers = new Map(); // instanceId → { server, state }

function buildAnimationCatalog(repoRoot) {
  const entriesRoot = path.resolve(repoRoot, 'public/assets/generated/entries');
  if (!existsSync(entriesRoot)) return [];

  return readdirSync(entriesRoot)
    .filter((filename) => filename.endsWith('.json'))
    .flatMap((filename) => {
      const entryPath = path.join(entriesRoot, filename);
      try {
        const entry = JSON.parse(readFileSync(entryPath, 'utf8'));
        const animation = entry.animation;
        if (
          !animation ||
          !Number.isInteger(animation.frameCount) ||
          animation.frameCount < 1 ||
          !Number.isFinite(animation.frameRate) ||
          !Number.isFinite(animation.frameWidth) ||
          !Number.isFinite(animation.frameHeight) ||
          typeof entry.assetPath !== 'string'
        ) {
          return [];
        }

        const sheetPath = path.resolve(repoRoot, 'public/assets', entry.assetPath);
        const generatedRoot = path.resolve(repoRoot, 'public/assets/generated') + path.sep;
        if (!sheetPath.startsWith(generatedRoot) || !existsSync(sheetPath)) return [];

        return [
          {
            label: entry.spriteName ?? entry.briefId ?? filename.replace(/\.json$/, ''),
            sheetPath: path.relative(repoRoot, sheetPath),
            rows: 1,
            cols: animation.frameCount,
            frameRate: animation.frameRate,
            outputW: animation.frameWidth,
            outputH: animation.frameHeight,
          },
        ];
      } catch (error) {
        console.warn(`Skipping invalid animation entry ${entryPath}:`, error);
        return [];
      }
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

function renderHtml(state, catalog) {
  const { sheetB64, rows, cols, frameRate, name, outputW, outputH, sheetPath } = state;
  const hasSheet = !!sheetB64;
  const selectedIndex = catalog.findIndex(
    (animation) => sheetPath && path.resolve(animation.sheetPath) === path.resolve(sheetPath),
  );

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>${name ?? 'Animation Viewer'}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #1a1a2e;
    color: #e2e8f0;
    font-family: 'Segoe UI', system-ui, sans-serif;
    padding: 20px;
    min-height: 100vh;
  }
  h1 { font-size: 1.1rem; font-weight: 600; color: #a78bfa; margin-bottom: 16px; letter-spacing: .05em; }
  .section-title {
    font-size: .7rem; font-weight: 600; text-transform: uppercase;
    letter-spacing: .12em; color: #64748b; margin-bottom: 8px;
  }
  .section { margin-bottom: 28px; }
  .selector {
    display: flex; align-items: end; gap: 8px; flex-wrap: wrap;
  }
  .selector label {
    display: flex; flex-direction: column; gap: 4px;
    font-size: .75rem; color: #94a3b8;
  }
  .selector select {
    min-width: 260px; background: #0f172a; color: #e2e8f0;
    border: 1px solid #475569; border-radius: 4px; padding: 5px 8px;
  }
  #anim-wrap {
    display: flex; align-items: flex-start; gap: 20px; flex-wrap: wrap;
  }
  #anim-canvas {
    image-rendering: pixelated;
    border: 2px solid #334155;
    border-radius: 6px;
    background: #0f172a;
  }
  .controls {
    display: flex; flex-direction: column; gap: 8px; min-width: 140px;
  }
  .controls label { font-size: .75rem; color: #94a3b8; }
  .controls input[type=range] { width: 100%; }
  .controls span { font-size: .75rem; color: #e2e8f0; font-variant-numeric: tabular-nums; }
  .btn {
    background: #334155; border: 1px solid #475569; border-radius: 4px;
    color: #e2e8f0; font-size: .75rem; padding: 4px 10px; cursor: pointer;
    text-align: center;
  }
  .btn:hover { background: #475569; }
  .frames-strip { display: flex; flex-wrap: wrap; gap: 8px; }
  .frame-cell { display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .frame-cell canvas {
    image-rendering: pixelated;
    border: 1px solid #334155;
    border-radius: 4px;
    background: #0f172a;
  }
  .frame-cell span { font-size: .65rem; color: #64748b; }
  #sheet-img {
    image-rendering: pixelated;
    border: 2px solid #334155;
    border-radius: 6px;
    max-width: 100%;
  }
  .empty { color: #64748b; font-size: .85rem; font-style: italic; }
  #frame-counter { font-size: .75rem; color: #64748b; }
</style>
</head>
<body>
<h1>🎞 ${name ?? 'Animation Viewer'}</h1>

<div class="section">
  <div class="section-title">Available Animations</div>
  ${
    catalog.length > 0
      ? `<div class="selector">
  <label>
    Animation
    <select id="animation-select">
      <option value="">Choose an animation...</option>
      ${catalog
        .map(
          (animation, index) =>
            `<option value="${index}" ${index === selectedIndex ? 'selected' : ''}>${animation.label}</option>`,
        )
        .join('')}
    </select>
  </label>
</div>`
      : `<p class="empty">No generated animations are available.</p>`
  }
</div>

${
  hasSheet
    ? `
<script>
  const SHEET_B64 = "${sheetB64}";
  const ROWS = ${rows};
  const COLS = ${cols};
  const FRAME_RATE = ${frameRate};
  const OUT_W = ${outputW ?? 128};
  const OUT_H = ${outputH ?? 128};
  const TOTAL_FRAMES = ROWS * COLS;
</script>
`
    : `<p class="empty">No sheet loaded yet.</p>`
}

<div class="section" id="preview-section" style="${hasSheet ? '' : 'display:none'}">
  <div class="section-title">Animation Preview</div>
  <div id="anim-wrap">
    <canvas id="anim-canvas"></canvas>
    <div class="controls">
      <div>
        <label>FPS</label><br/>
        <input type="range" id="fps-slider" min="1" max="30" step="1" value="${frameRate}"/>
        <span id="fps-label">${frameRate} fps</span>
      </div>
      <div>
        <label>Zoom</label><br/>
        <input type="range" id="zoom-slider" min="1" max="8" step="1" value="4"/>
        <span id="zoom-label">4×</span>
      </div>
      <button class="btn" id="pause-btn">⏸ Pause</button>
      <span id="frame-counter">Frame 0 / ${rows * cols}</span>
    </div>
  </div>
</div>

<div class="section" id="frames-section" style="${hasSheet ? '' : 'display:none'}">
  <div class="section-title">Individual Frames</div>
  <div class="frames-strip" id="frames-strip"></div>
</div>

<div class="section" id="sheet-section" style="${hasSheet ? '' : 'display:none'}">
  <div class="section-title">Full Sheet</div>
  <img id="sheet-img" alt="sprite sheet"/>
</div>

${
  hasSheet
    ? `
<script>
(function() {
  const animationSelect = document.getElementById('animation-select');
  animationSelect?.addEventListener('change', () => {
    if (animationSelect.value) {
      window.location.href = '/?animation=' + encodeURIComponent(animationSelect.value);
    }
  });

  const img = new Image();
  img.onload = function() {
    const cellW = img.naturalWidth / COLS;
    const cellH = img.naturalHeight / ROWS;

    document.getElementById('sheet-img').src = img.src;
    document.getElementById('sheet-img').style.width = Math.min(img.naturalWidth / 2, 600) + 'px';

    const strip = document.getElementById('frames-strip');
    for (let i = 0; i < TOTAL_FRAMES; i++) {
      const r = Math.floor(i / COLS), c = i % COLS;
      const fc = document.createElement('canvas');
      fc.width = OUT_W; fc.height = OUT_H;
      fc.style.width = OUT_W + 'px'; fc.style.height = OUT_H + 'px';
      const ctx = fc.getContext('2d');
      ctx.drawImage(img, c * cellW, r * cellH, cellW, cellH, 0, 0, OUT_W, OUT_H);
      const wrap = document.createElement('div');
      wrap.className = 'frame-cell';
      const lbl = document.createElement('span');
      lbl.textContent = 'Frame ' + i;
      wrap.appendChild(fc); wrap.appendChild(lbl);
      strip.appendChild(wrap);
    }

    let zoom = 4, fps = FRAME_RATE, paused = false, frame = 0, last = 0, raf;
    const animCanvas = document.getElementById('anim-canvas');
    const fpsSlider = document.getElementById('fps-slider');
    const zoomSlider = document.getElementById('zoom-slider');
    const fpsLabel = document.getElementById('fps-label');
    const zoomLabel = document.getElementById('zoom-label');
    const pauseBtn = document.getElementById('pause-btn');
    const counter = document.getElementById('frame-counter');

    function resize() {
      animCanvas.width = OUT_W * zoom;
      animCanvas.height = OUT_H * zoom;
      animCanvas.style.width = (OUT_W * zoom) + 'px';
      animCanvas.style.height = (OUT_H * zoom) + 'px';
    }

    function draw() {
      const r = Math.floor(frame / COLS), c = frame % COLS;
      const ctx = animCanvas.getContext('2d');
      ctx.clearRect(0, 0, animCanvas.width, animCanvas.height);
      ctx.drawImage(img, c * cellW, r * cellH, cellW, cellH,
                    0, 0, OUT_W * zoom, OUT_H * zoom);
      counter.textContent = 'Frame ' + frame + ' / ' + TOTAL_FRAMES;
    }

    function tick(ts) {
      if (!paused && ts - last >= 1000 / fps) {
        frame = (frame + 1) % TOTAL_FRAMES;
        draw();
        last = ts;
      }
      raf = requestAnimationFrame(tick);
    }

    fpsSlider.addEventListener('input', () => {
      fps = +fpsSlider.value;
      fpsLabel.textContent = fps + ' fps';
    });
    zoomSlider.addEventListener('input', () => {
      zoom = +zoomSlider.value;
      zoomLabel.textContent = zoom + '×';
      resize(); draw();
    });
    pauseBtn.addEventListener('click', () => {
      paused = !paused;
      pauseBtn.textContent = paused ? '▶ Play' : '⏸ Pause';
    });

    resize(); draw();
    raf = requestAnimationFrame(tick);
  };
  img.src = 'data:image/png;base64,' + SHEET_B64;
})();
</script>
`
    : ''
}
</body>
</html>`;
}

async function startServer(instanceId, state, catalog) {
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const requestedIndex = requestUrl.searchParams.get('animation');
    let requestState = servers.get(instanceId)?.state ?? state;

    if (requestedIndex !== null) {
      const animation = Number(requestedIndex);
      if (!Number.isInteger(animation) || !catalog[animation]) {
        res.statusCode = 400;
        res.end('Unknown animation selection');
        return;
      }
      const selected = catalog[animation];
      requestState = {
        ...requestState,
        ...selected,
        sheetB64: loadSheet(selected.sheetPath, requestState.repoRoot),
      };
      servers.get(instanceId).state = requestState;
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(renderHtml(requestState, catalog));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { server, url: `http://127.0.0.1:${port}/`, state };
}

function loadSheet(sheetPath, repoRoot) {
  const resolved = repoRoot ? path.resolve(repoRoot, sheetPath) : path.resolve(sheetPath);
  if (!existsSync(resolved)) throw new Error(`Sheet not found: ${resolved}`);
  return readFileSync(resolved).toString('base64');
}

const session = await joinSession({
  canvases: [
    createCanvas({
      id: 'animation-viewer',
      displayName: 'Animation Viewer',
      description:
        'Slices a sprite sheet into frames and plays a looping animation preview. ' +
        'Pass sheetPath (absolute or relative to cwd), rows, cols, and frameRate.',
      inputSchema: {
        type: 'object',
        properties: {
          sheetPath: { type: 'string', description: 'Absolute path or path relative to cwd' },
          rows: { type: 'number', description: 'Rows in the sheet grid' },
          cols: { type: 'number', description: 'Columns in the sheet grid' },
          frameRate: { type: 'number', description: 'Playback frame rate (fps)' },
          name: { type: 'string', description: 'Display name shown in the canvas header' },
          outputW: { type: 'number', description: 'Per-frame display width in px (default 128)' },
          outputH: { type: 'number', description: 'Per-frame display height in px (default 128)' },
        },
        required: ['sheetPath', 'rows', 'cols', 'frameRate'],
      },
      actions: [
        {
          name: 'load_sheet',
          description: 'Swap the sheet displayed in an open animation-viewer canvas',
          inputSchema: {
            type: 'object',
            properties: {
              sheetPath: { type: 'string' },
              rows: { type: 'number' },
              cols: { type: 'number' },
              frameRate: { type: 'number' },
              name: { type: 'string' },
              outputW: { type: 'number' },
              outputH: { type: 'number' },
            },
            required: ['sheetPath', 'rows', 'cols', 'frameRate'],
          },
          handler: async (input, ctx) => {
            const entry = servers.get(ctx.instanceId);
            if (!entry) return { ok: false, error: 'Canvas not open' };
            try {
              const b64 = loadSheet(input.sheetPath, entry.state.repoRoot);
              entry.state = {
                sheetB64: b64,
                sheetPath: input.sheetPath,
                rows: input.rows,
                cols: input.cols,
                frameRate: input.frameRate,
                name: input.name ?? entry.state.name,
                outputW: input.outputW ?? entry.state.outputW,
                outputH: input.outputH ?? entry.state.outputH,
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
        let sheetB64 = null;
        if (input.sheetPath) {
          try {
            sheetB64 = loadSheet(input.sheetPath, repoRoot);
          } catch {
            /* show empty state */
          }
        }
        const state = {
          sheetB64,
          sheetPath: input.sheetPath,
          repoRoot,
          rows: input.rows ?? 1,
          cols: input.cols ?? 1,
          frameRate: input.frameRate ?? 8,
          name: input.name ?? 'Animation Viewer',
          outputW: input.outputW ?? 128,
          outputH: input.outputH ?? 128,
        };
        let entry = servers.get(ctx.instanceId);
        if (!entry) {
          entry = await startServer(ctx.instanceId, state, catalog);
          servers.set(ctx.instanceId, entry);
        } else {
          entry.state = state;
        }
        return { title: input.name ?? 'Animation Viewer', url: entry.url };
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
