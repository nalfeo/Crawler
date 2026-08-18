// animation-viewer HTML renderer.
//
// Pure string rendering so it can be unit tested with `node --test`
// (see tests/renderer.test.mjs).

import path from 'node:path';

/**
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Serialize a value into a `<script>`-safe JavaScript string literal.
 * @param {unknown} value
 * @returns {string}
 */
export function toScriptLiteral(value) {
  return JSON.stringify(String(value))
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026');
}

/**
 * @param {string | undefined | null} candidate
 * @param {string | undefined | null} repoRoot
 * @returns {string | null}
 */
function resolveSheetPath(candidate, repoRoot) {
  if (typeof candidate !== 'string' || candidate.length === 0) return null;
  return repoRoot ? path.resolve(repoRoot, candidate) : path.resolve(candidate);
}

/**
 * Render the animation-viewer page.
 *
 * @param {{ sheetB64?: string | null, sheetPath?: string, repoRoot?: string, rows: number, cols: number, frameRate: number, name?: string, outputW: number, outputH: number }} state
 * @param {Array<{ label: string, sheetPath: string }>} catalog
 * @returns {string}
 */
export function renderHtml(state, catalog = []) {
  const { sheetB64, rows, cols, frameRate, name, outputW, outputH, sheetPath, repoRoot } = state;
  const hasSheet = !!sheetB64;
  const title = escapeHtml(name ?? 'Animation Viewer');
  const activeSheet = resolveSheetPath(sheetPath, repoRoot);
  const selectedIndex = activeSheet
    ? catalog.findIndex(
        (animation) => resolveSheetPath(animation.sheetPath, repoRoot) === activeSheet,
      )
    : -1;
  const totalFrames = rows * cols;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>${title}</title>
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
<h1>🎞 ${title}</h1>

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
            `<option value="${index}"${index === selectedIndex ? ' selected' : ''}>${escapeHtml(animation.label)}</option>`,
        )
        .join('')}
    </select>
  </label>
</div>`
      : `<p class="empty">No generated animations are available.</p>`
  }
</div>

<script>
(function() {
  const animationSelect = document.getElementById('animation-select');
  animationSelect?.addEventListener('change', () => {
    if (animationSelect.value) {
      window.location.href = '/?animation=' + encodeURIComponent(animationSelect.value);
    }
  });
})();
</script>

${hasSheet ? '' : `<p class="empty">No sheet loaded yet.</p>`}

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
      <span id="frame-counter">Frame 0 / ${totalFrames}</span>
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
  const SHEET_B64 = ${toScriptLiteral(sheetB64)};
  const ROWS = ${rows};
  const COLS = ${cols};
  const FRAME_RATE = ${frameRate};
  const OUT_W = ${outputW};
  const OUT_H = ${outputH};
  const TOTAL_FRAMES = ROWS * COLS;
</script>
<script>
(function() {
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
