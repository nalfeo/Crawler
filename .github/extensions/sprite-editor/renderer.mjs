const STYLES = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 16px;
    background: var(--background-color-default, #0b1120);
    color: var(--text-color-default, #e2e8f0);
    font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    font-size: var(--text-body-medium, 13px);
    line-height: var(--leading-body-medium, 1.45);
  }
  h1 { margin: 0; font-size: 20px; }
  .muted { color: var(--text-color-muted, #94a3b8); font-size: 12px; }
  .top { display: flex; justify-content: space-between; gap: 10px; align-items: center; margin-bottom: 10px; }
  .layout { display: grid; grid-template-columns: minmax(300px, 340px) 1fr; gap: 12px; min-height: 520px; }
  .panel {
    border: 1px solid rgba(148,163,184,0.25);
    border-radius: 12px;
    background: #0f172a;
    overflow: hidden;
    box-shadow: 0 10px 30px rgba(2,6,23,0.18);
  }
  .head {
    border-bottom: 1px solid rgba(148,163,184,0.2);
    padding: 8px 10px;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .head > input[type="text"] { flex: 1 1 170px; min-width: 0; }
  input, select, button, textarea {
    background: #0b1220;
    color: #e2e8f0;
    border: 1px solid rgba(148,163,184,0.35);
    border-radius: 7px;
    padding: 6px 10px;
    font: inherit;
  }
  input:hover, select:hover, button:hover { border-color: rgba(125,211,252,0.55); }
  input:focus-visible, select:focus-visible, button:focus-visible, textarea:focus-visible {
    outline: 2px solid #38bdf8;
    outline-offset: 2px;
  }
  textarea { min-height: 64px; width: 100%; resize: vertical; }
  input[type="number"] { width: 88px; }
  input[type="color"] { width: 46px; padding: 0; height: 34px; }
  button { cursor: pointer; }
  button:disabled { opacity: 0.6; cursor: default; }
  .list { max-height: calc(100vh - 300px); overflow: auto; }
  .row-item {
    width: 100%;
    border: 0;
    border-bottom: 1px solid rgba(148,163,184,0.1);
    border-radius: 0;
    text-align: left;
    background: transparent;
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .row-item.active { background: rgba(125,211,252,0.14); }
  .pill {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border: 1px solid rgba(253,230,138,0.5);
    color: #fde68a;
    border-radius: 999px;
    padding: 2px 8px;
  }
  .variants-badge {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border: 1px solid rgba(125, 211, 252, 0.45);
    color: #7dd3fc;
    border-radius: 999px;
    padding: 2px 8px;
  }
  .heart {
    color: #fda4af;
    font-size: 13px;
    letter-spacing: 0.02em;
  }
  .heart-btn {
    border-radius: 999px;
    min-width: 40px;
    padding: 6px 10px;
    border: 1px solid rgba(251, 113, 133, 0.35);
    color: #fda4af;
    background: rgba(136, 19, 55, 0.25);
    transition: transform 120ms ease, background 120ms ease, box-shadow 120ms ease;
  }
  .dislike-btn {
    border-radius: 999px;
    min-width: 40px;
    padding: 6px 10px;
    border: 1px solid rgba(248, 113, 113, 0.35);
    color: #fca5a5;
    background: rgba(127, 29, 29, 0.18);
    transition: transform 120ms ease, background 120ms ease, box-shadow 120ms ease;
  }
  .dislike-btn:hover { transform: translateY(-1px); }
  .dislike-btn.on {
    color: #fee2e2;
    background: linear-gradient(135deg, rgba(239,68,68,0.72), rgba(190,24,93,0.62));
    box-shadow: 0 0 0 2px rgba(248,113,113,0.18), 0 0 18px rgba(239,68,68,0.28);
  }
  .heart-btn:hover { transform: translateY(-1px); }
  .heart-btn.on {
    color: #ffe4e6;
    background: linear-gradient(135deg, rgba(251,113,133,0.75), rgba(236,72,153,0.65));
    box-shadow: 0 0 0 2px rgba(251,113,133,0.2), 0 0 18px rgba(251,113,133,0.35);
  }
  .filters { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 8px 10px; border-bottom: 1px solid rgba(148,163,184,0.1); }
  .filters > .chk { grid-column: 1 / -1; }
  .chk { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: #cbd5e1; }
  .chk input { margin: 0; }
  .editor { display: flex; flex-direction: column; min-width: 0; }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: space-between;
  }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .app-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 58px;
    padding: 10px 12px;
    border-bottom: 1px solid rgba(148,163,184,0.18);
    background: linear-gradient(180deg, rgba(30,41,59,0.72), rgba(15,23,42,0.75));
  }
  .sprite-identity { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .sprite-title-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .sprite-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sprite-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 58vw; }
  .app-actions { display: flex; align-items: center; justify-content: flex-end; gap: 6px; flex-wrap: wrap; }
  .app-actions button { min-height: 34px; }
  .primary-action {
    color: #082f49;
    border-color: #7dd3fc;
    background: linear-gradient(135deg, #7dd3fc, #38bdf8);
    font-weight: 700;
  }
  .primary-action:hover { border-color: #bae6fd; background: linear-gradient(135deg, #bae6fd, #38bdf8); }
  .danger-action { color: #fecaca; border-color: rgba(248,113,113,0.35); background: rgba(127,29,29,0.22); }
  .dirty-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: #fde68a;
    background: rgba(161,98,7,0.18);
    border: 1px solid rgba(253,230,138,0.32);
    border-radius: 999px;
    padding: 3px 8px;
    font-size: 11px;
    font-weight: 650;
  }
  .dirty-badge::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: #facc15; }
  .workspace-shell {
    display: grid;
    grid-template-columns: 126px minmax(0, 1fr);
    min-height: 470px;
  }
  .tool-rail {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 10px 8px;
    border-right: 1px solid rgba(148,163,184,0.16);
    background: rgba(2,6,23,0.2);
  }
  .tool-tab {
    display: grid;
    grid-template-columns: 24px 1fr;
    align-items: center;
    gap: 7px;
    width: 100%;
    min-height: 38px;
    padding: 7px 8px;
    border-color: transparent;
    background: transparent;
    text-align: left;
    color: #cbd5e1;
  }
  .tool-tab:hover { background: rgba(30,41,59,0.85); }
  .tool-tab.on {
    color: #e0f2fe;
    border-color: rgba(125,211,252,0.45);
    background: linear-gradient(90deg, rgba(14,116,144,0.3), rgba(14,116,144,0.08));
    box-shadow: inset 3px 0 #38bdf8;
  }
  .tool-icon { font-size: 15px; text-align: center; line-height: 1; }
  .workspace-main { display: flex; flex-direction: column; min-width: 0; }
  .quick-bar {
    display: flex;
    align-items: center;
    gap: 7px;
    flex-wrap: wrap;
    min-height: 46px;
    padding: 7px 10px;
    border-bottom: 1px solid rgba(148,163,184,0.14);
    background: rgba(15,23,42,0.7);
  }
  .quick-bar button, .quick-bar input { height: 32px; }
  .quick-bar input[type="number"] { width: 80px; }
  .quick-bar .icon-btn { min-height: 32px; }
  .toolbar-divider { width: 1px; height: 24px; background: rgba(148,163,184,0.22); margin: 0 2px; }
  .control-label {
    color: #94a3b8;
    font-size: 10px;
    font-weight: 650;
    text-transform: uppercase;
    letter-spacing: 0.055em;
  }
  .tool-panel {
    min-height: 76px;
    padding: 8px 10px;
    border-bottom: 1px solid rgba(148,163,184,0.16);
    background: rgba(30,41,59,0.28);
  }
  .tool-panel-header { display: flex; align-items: baseline; gap: 8px; margin-bottom: 7px; }
  .tool-panel-title { font-weight: 700; color: #f8fafc; }
  .tool-panel-hint { color: #94a3b8; font-size: 11px; }
  .tool-options { display: flex; align-items: end; gap: 8px; flex-wrap: wrap; }
  .control-group { display: flex; flex-direction: column; gap: 3px; }
  .control-group.wide select { min-width: 190px; }
  .apply-action { min-height: 34px; padding-inline: 14px; font-weight: 650; }
  .canvas-area { padding: 10px; display: flex; flex-direction: column; gap: 7px; min-width: 0; }
  .canvas-topline { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .canvas-wrap {
    border: 1px solid rgba(148,163,184,0.25);
    background: #081120;
    border-radius: 8px;
    min-height: 220px;
    padding: 10px;
    overflow: auto;
  }
  .comparison-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(260px, 1fr));
    gap: 10px;
    width: max-content;
    min-width: max(540px, 100%);
  }
  .comparison-pane {
    min-width: 0;
    min-height: 198px;
    border: 1px solid rgba(148,163,184,0.2);
    border-radius: 7px;
    overflow: hidden;
    background: repeating-conic-gradient(#13213b 0% 25%, #0f1a30 0% 50%) 50% / 12px 12px;
  }
  .comparison-pane-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 30px;
    padding: 5px 8px;
    border-bottom: 1px solid rgba(148,163,184,0.18);
    background: rgba(2,6,23,0.72);
  }
  .comparison-pane-title { color: #e2e8f0; font-size: 11px; font-weight: 750; text-transform: uppercase; letter-spacing: 0.06em; }
  .comparison-stage-wrap { padding: 8px; overflow: hidden; }
  .canvas-stage { position: relative; display: inline-block; line-height: 0; }
  .sprite-canvas, .comparison-canvas, .overlay-canvas {
    image-rendering: pixelated;
    image-rendering: crisp-edges;
    border: 1px solid rgba(148,163,184,0.25);
    background: transparent;
    display: block;
  }
  .overlay-canvas { position: absolute; inset: 0; pointer-events: none; border-color: transparent; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field label { font-size: 10px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.04em; }
  .metadata-panel {
    margin: 0 10px 10px;
    padding: 10px;
    border: 1px solid rgba(148,163,184,0.16);
    border-radius: 9px;
    background: rgba(2,6,23,0.18);
  }
  .metadata-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .status { min-height: 20px; padding-top: 5px; font-size: 12px; color: #94a3b8; }
  .context-menu {
    position: fixed;
    z-index: 9999;
    min-width: 170px;
    background: #020617;
    border: 1px solid rgba(148,163,184,0.35);
    border-radius: 8px;
    box-shadow: 0 12px 30px rgba(2,6,23,0.6);
    padding: 4px;
  }
  .context-menu button {
    width: 100%;
    text-align: left;
    border: 0;
    background: transparent;
    border-radius: 6px;
    padding: 6px 8px;
  }
  .context-menu button:hover { background: rgba(59,130,246,0.2); }
  .context-menu button:disabled {
    opacity: 0.45;
    cursor: default;
    background: transparent;
  }
  .tool-btn.on {
    border-color: rgba(125, 211, 252, 0.6);
    box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.2);
  }
  .icon-btn {
    min-width: 34px;
    padding: 6px 8px;
    font-size: 16px;
    line-height: 1;
  }
  .scale-btn-label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .scale-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: #94a3b8;
  }
  .inline-spinner {
    width: 12px;
    height: 12px;
    border-radius: 999px;
    border: 2px solid rgba(125, 211, 252, 0.3);
    border-top-color: #7dd3fc;
    animation: spin 0.8s linear infinite;
  }
  .inline-spinner.hidden { display: none; }
  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
  @media (max-width: 980px) {
    body { padding: 10px; }
    .layout { grid-template-columns: 1fr; }
    .list { max-height: 280px; }
    .workspace-shell { grid-template-columns: 1fr; }
    .tool-rail { flex-direction: row; overflow-x: auto; border-right: 0; border-bottom: 1px solid rgba(148,163,184,0.16); }
    .tool-tab { min-width: 116px; }
    .sprite-path { max-width: 72vw; }
  }
`;

const CLIENT_SCRIPT = String.raw`
(function () {
  'use strict';

  var app = document.getElementById('app');
  var searchInput = null;
  var listEl = null;
  var statusEl = null;
  var editorEl = null;
  var totalEl = null;
  var tagsInput = null;
  var tagsDatalist = null;
  var collapseCheckbox = null;
  var placeholdersSelect = null;
  var favoritesSelect = null;

  var selectedKey = null;
  var selectedVariantGroup = null;
  var sprites = [];
  var sprite = null;
  var canvas = null;
  var overlayCanvas = null;
  var ctx = null;
  var overlayCtx = null;

  var drawing = false;
  var brushSize = 1;
  var pixelScale = 1;
  var drawMode = 'erase';
  var drawColor = '#ff00ff';
  var showAnchor = true;
  var setAnchorOnClick = false;
  var showHoleOverlay = false;
  var eyedropperArmed = false;
  var backgroundPickArmed = false;
  var undoStack = [];
  var redoStack = [];
  var maxHistory = 60;
  var cachedCanvasFingerprint = null;
  var editGeneration = 0;
  var strokeSnapshot = null;
  var contextMenu = null;
  var baselineFingerprint = null;
  var loadTokenCounter = 0;
  var listTokenCounter = 0;
  /** Sprite keys already warmed into the browser image cache (dedupes prefetch). */
  var prefetchedImageKeys = Object.create(null);
  var saveTokenCounter = 0;
  var revertTokenCounter = 0;
  var scaleFactor = 1;
  var scaleMethod = 'nearest';
  var edgeCleanupMethod = 'defringe';
  var edgeCleanupAmount = 60;
  var edgeCleanupAlphaCutoff = 24;
  var lastAppliedEdgeCleanupSignature = null;
  var backgroundRemovalMethod = 'color-key';
  var backgroundTolerance = 36;
  var backgroundSoftness = 24;
  var sampledBackgroundColor = null;
  var sampledBackgroundPoint = null;
  var lastAppliedBackgroundRemovalSignature = null;
  var fringeNormalizeMethod = 'opaque-average';
  var fringeNormalizeStrength = 70;
  var fringeNormalizeThreshold = 28;
  var lastAppliedFringeNormalizeSignature = null;
  var scaleInFlight = false;
  var mutationInFlight = false;
  var activeEditorTool = 'draw';
  var previousEditorTool = 'draw';
  var comparisonBeforeCanvas = null;
  var comparisonActionLabel = 'Last saved';

  var SCALE_FACTOR_MIN = 0.25;
  var SCALE_FACTOR_MAX = 8;
  var SCALE_METHODS = [
    { id: 'nearest', label: 'Nearest (pixel-perfect)' },
    { id: 'bilinear', label: 'Bilinear' },
    { id: 'bicubic', label: 'Bicubic' },
    { id: 'area', label: 'Pixel-area (best downscale)' },
    { id: 'lanczos4', label: 'Lanczos4' }
  ];
  var OPENCV_JS_URL = '/vendor/opencv.js';
  var SCALE_WORKER_TIMEOUT_MS = 10000;
  var MAX_SCALE_DIMENSION = 4096;
  var MAX_SCALE_PIXELS = 16 * 1024 * 1024;
  var MAX_HISTORY_BYTES = 64 * 1024 * 1024;
  var ZOOM_MIN = 0.5;
  var ZOOM_MAX = 20;
  var ZOOM_STEP = 0.5;
  var ZOOM_WHEEL_STEP = 0.5;

  function h(tag, props, children) {
    var elem = document.createElement(tag);
    if (props) {
      for (var key in props) {
        if (!Object.prototype.hasOwnProperty.call(props, key)) continue;
        var value = props[key];
        if (key === 'class') elem.className = value;
        else if (key === 'text') elem.textContent = value;
        else if (key === 'value') elem.value = value;
        else if (key === 'checked') elem.checked = !!value;
        else elem.setAttribute(key, value);
      }
    }
    if (children) {
      for (var i = 0; i < children.length; i++) {
        var child = children[i];
        if (child == null) continue;
        elem.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
      }
    }
    return elem;
  }

  function setStatus(message, isError) {
    if (!statusEl) return;
    statusEl.textContent = message || '';
    statusEl.style.color = isError ? '#fecaca' : '#94a3b8';
  }

  async function fetchJson(url, options) {
    var response = await fetch(url, options);
    var json = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      throw new Error(json.error || json.message || 'Request failed');
    }
    return json;
  }

  function clampScaleFactor(value) {
    var n = Number(value);
    if (!Number.isFinite(n)) return 1;
    return Math.max(SCALE_FACTOR_MIN, Math.min(SCALE_FACTOR_MAX, n));
  }

  function clampPixelScale(value) {
    var n = Number(value);
    if (!Number.isFinite(n)) return 1;
    n = Math.round(n / ZOOM_STEP) * ZOOM_STEP;
    return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, n));
  }

  function hasDirtyScaleSettings() {
    return clampScaleFactor(scaleFactor) !== 1;
  }

  function clampPercent(value, fallback) {
    var n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  function clampByte(value, fallback) {
    var n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(255, Math.round(n)));
  }

  function edgeCleanupSignature() {
    return [
      String(edgeCleanupMethod || 'defringe'),
      String(clampPercent(edgeCleanupAmount, 60)),
      String(clampByte(edgeCleanupAlphaCutoff, 24)),
      String(editGeneration)
    ].join('|');
  }

  function backgroundRemovalSignature() {
    return [
      String(backgroundRemovalMethod || 'color-key'),
      String(clampByte(backgroundTolerance, 36)),
      String(clampByte(backgroundSoftness, 24)),
      sampledBackgroundColor
        ? [sampledBackgroundColor.r, sampledBackgroundColor.g, sampledBackgroundColor.b, sampledBackgroundColor.a].join(',')
        : 'auto',
      sampledBackgroundPoint ? [sampledBackgroundPoint.x, sampledBackgroundPoint.y].join(',') : 'auto',
      String(editGeneration)
    ].join('|');
  }

  function hasDirtyEdgeCleanupSettings() {
    return edgeCleanupSignature() !== String(lastAppliedEdgeCleanupSignature || '');
  }

  function hasDirtyBackgroundRemovalSettings() {
    return backgroundRemovalSignature() !== String(lastAppliedBackgroundRemovalSignature || '');
  }

  function fringeNormalizeSignature() {
    return [
      String(fringeNormalizeMethod || 'opaque-average'),
      String(clampPercent(fringeNormalizeStrength, 70)),
      String(clampByte(fringeNormalizeThreshold, 28)),
      String(editGeneration)
    ].join('|');
  }

  function hasDirtyFringeNormalizeSettings() {
    return fringeNormalizeSignature() !== String(lastAppliedFringeNormalizeSignature || '');
  }

  function applyZoomScale() {
    if (!canvas || !overlayCanvas) return;
    var w = String(canvas.width * pixelScale) + 'px';
    var hPx = String(canvas.height * pixelScale) + 'px';
    canvas.style.width = w;
    canvas.style.height = hPx;
    overlayCanvas.style.width = w;
    overlayCanvas.style.height = hPx;
    if (comparisonBeforeCanvas) {
      comparisonBeforeCanvas.style.width = String(comparisonBeforeCanvas.width * pixelScale) + 'px';
      comparisonBeforeCanvas.style.height = String(comparisonBeforeCanvas.height * pixelScale) + 'px';
    }
  }

  function zoomBy(delta) {
    if (pixelScale < ZOOM_MIN && delta < 0) return false;
    var next = pixelScale < ZOOM_MIN ? ZOOM_MIN : clampPixelScale(pixelScale + delta);
    if (next === pixelScale) return false;
    pixelScale = next;
    applyZoomScale();
    setStatus('Zoom: ' + String(pixelScale) + 'x');
    return true;
  }

  function zoomToFit(canvasWrap) {
    if (!canvas || !canvasWrap) return false;
    var availableWidth = Math.max(1, (canvasWrap.clientWidth - 40) / 2);
    var availableHeight = Math.max(1, canvasWrap.clientHeight - 44);
    var widest = comparisonBeforeCanvas ? Math.max(canvas.width, comparisonBeforeCanvas.width) : canvas.width;
    var tallest = comparisonBeforeCanvas ? Math.max(canvas.height, comparisonBeforeCanvas.height) : canvas.height;
    var fitScale = Math.min(availableWidth / widest, availableHeight / tallest);
    var next = Math.min(ZOOM_MAX, fitScale);
    if (next === pixelScale) return false;
    pixelScale = next;
    applyZoomScale();
    setStatus('Zoom fit: ' + String(pixelScale) + 'x');
    return true;
  }

  function resolveSmoothingQuality(methodId, factor) {
    var id = String(methodId || '').toLowerCase();
    if (id === 'nearest') return { enabled: false, quality: 'low' };
    if (id === 'area' && factor < 1) return { enabled: true, quality: 'high' };
    if (id === 'lanczos4' || id === 'bicubic') return { enabled: true, quality: 'high' };
    return { enabled: true, quality: 'medium' };
  }

  function scaleWithBrowserCanvas(sourceCanvas, targetWidth, targetHeight, methodId, factor) {
    var quality = resolveSmoothingQuality(methodId, factor);
    var work = document.createElement('canvas');
    work.width = sourceCanvas.width;
    work.height = sourceCanvas.height;
    var workCtx = work.getContext('2d');
    workCtx.imageSmoothingEnabled = false;
    workCtx.drawImage(sourceCanvas, 0, 0);

    if (String(methodId || '').toLowerCase() === 'area' && factor < 1) {
      // Progressive downsizing reduces aliasing for area-like minification.
      while (work.width / 2 >= targetWidth && work.height / 2 >= targetHeight) {
        var step = document.createElement('canvas');
        step.width = Math.max(targetWidth, Math.floor(work.width / 2));
        step.height = Math.max(targetHeight, Math.floor(work.height / 2));
        var stepCtx = step.getContext('2d');
        stepCtx.imageSmoothingEnabled = true;
        stepCtx.imageSmoothingQuality = 'high';
        stepCtx.drawImage(work, 0, 0, step.width, step.height);
        work = step;
      }
    }

    var out = document.createElement('canvas');
    out.width = targetWidth;
    out.height = targetHeight;
    var outCtx = out.getContext('2d');
    outCtx.imageSmoothingEnabled = quality.enabled;
    outCtx.imageSmoothingQuality = quality.quality;
    outCtx.drawImage(work, 0, 0, out.width, out.height);
    return out;
  }

  function scaleWithWorker(payload) {
    if (typeof Worker !== 'function') {
      return Promise.reject(new Error('Worker scaling is unavailable in this browser.'));
    }
    var workerScriptLines = [
      '"use strict";',
      'self.onmessage = async function (event) {',
      '  var payload = event.data || {};',
      '  var workerTimeoutMs = 2500;',
      '  function clampPositiveInt(n) {',
      '    n = Number(n);',
      '    if (!Number.isFinite(n)) return 1;',
      '    return Math.max(1, Math.round(n));',
      '  }',
      '  function resolveSmoothingQuality(methodId, factor) {',
      '    var id = String(methodId || "").toLowerCase();',
      '    if (id === "nearest") return { enabled: false, quality: "low" };',
      '    if (id === "area" && factor < 1) return { enabled: true, quality: "high" };',
      '    if (id === "lanczos4" || id === "bicubic") return { enabled: true, quality: "high" };',
      '    return { enabled: true, quality: "medium" };',
      '  }',
      '  function resolveInterpolation(cv, methodId, factor) {',
      '    var id = String(methodId || "").toLowerCase();',
      '    if (id === "nearest") return cv.INTER_NEAREST_EXACT != null ? cv.INTER_NEAREST_EXACT : cv.INTER_NEAREST;',
      '    if (id === "bilinear") return cv.INTER_LINEAR_EXACT != null ? cv.INTER_LINEAR_EXACT : cv.INTER_LINEAR;',
      '    if (id === "bicubic") return cv.INTER_CUBIC;',
      '    if (id === "area") return factor < 1 ? cv.INTER_AREA : (cv.INTER_LINEAR_EXACT != null ? cv.INTER_LINEAR_EXACT : cv.INTER_LINEAR);',
      '    if (id === "lanczos4") return cv.INTER_LANCZOS4;',
      '    return cv.INTER_NEAREST_EXACT != null ? cv.INTER_NEAREST_EXACT : cv.INTER_NEAREST;',
      '  }',
      '  async function dataUrlToBitmap(dataUrl) {',
      '    var response = await fetch(dataUrl);',
      '    var blob = await response.blob();',
      '    return createImageBitmap(blob);',
      '  }',
      '  async function ensureCv(opencvUrl) {',
      '    var started = Date.now();',
      '    if (!self.cv) {',
      '      try { importScripts(opencvUrl); } catch (_err) { return null; }',
      '    }',
      '    if (self.cv && typeof self.cv.then === "function") {',
      '      var remainingMs = Math.max(0, workerTimeoutMs - (Date.now() - started));',
      '      try {',
      '        self.cv = await Promise.race([',
      '          self.cv,',
      '          new Promise(function (resolve) { setTimeout(function () { resolve(null); }, remainingMs); })',
      '        ]);',
      '      } catch (_err) {',
      '        return null;',
      '      }',
      '      if (!self.cv) return null;',
      '    }',
      '    while (Date.now() - started < workerTimeoutMs) {',
      '      if (self.cv && typeof self.cv.Mat === "function") return self.cv;',
      '      await new Promise(function (resolve) { setTimeout(resolve, 25); });',
      '    }',
      '    return null;',
      '  }',
      '  function scaleWithBrowser(sourceCanvas, targetWidth, targetHeight, methodId, factor) {',
      '    var quality = resolveSmoothingQuality(methodId, factor);',
      '    var work = new OffscreenCanvas(sourceCanvas.width, sourceCanvas.height);',
      '    var workCtx = work.getContext("2d", { alpha: true, willReadFrequently: true });',
      '    workCtx.imageSmoothingEnabled = false;',
      '    workCtx.drawImage(sourceCanvas, 0, 0);',
      '    if (String(methodId || "").toLowerCase() === "area" && factor < 1) {',
      '      while (work.width / 2 >= targetWidth && work.height / 2 >= targetHeight) {',
      '        var step = new OffscreenCanvas(Math.max(targetWidth, Math.floor(work.width / 2)), Math.max(targetHeight, Math.floor(work.height / 2)));',
      '        var stepCtx = step.getContext("2d", { alpha: true, willReadFrequently: true });',
      '        stepCtx.imageSmoothingEnabled = true;',
      '        stepCtx.imageSmoothingQuality = "high";',
      '        stepCtx.drawImage(work, 0, 0, step.width, step.height);',
      '        work = step;',
      '      }',
      '    }',
      '    var out = new OffscreenCanvas(targetWidth, targetHeight);',
      '    var outCtx = out.getContext("2d", { alpha: true, willReadFrequently: true });',
      '    outCtx.imageSmoothingEnabled = quality.enabled;',
      '    outCtx.imageSmoothingQuality = quality.quality;',
      '    outCtx.drawImage(work, 0, 0, targetWidth, targetHeight);',
      '    return out;',
      '  }',
      '  try {',
      '    var sourceWidth = clampPositiveInt(payload.sourceWidth);',
      '    var sourceHeight = clampPositiveInt(payload.sourceHeight);',
      '    var targetWidth = clampPositiveInt(payload.targetWidth);',
      '    var targetHeight = clampPositiveInt(payload.targetHeight);',
      '    var factor = Number(payload.factor);',
      '    var methodId = payload.methodId;',
      '    var sourceBitmap = await dataUrlToBitmap(String(payload.sourceDataUrl || ""));',
      '    var sourceCanvas = new OffscreenCanvas(sourceWidth, sourceHeight);',
      '    var sourceCtx = sourceCanvas.getContext("2d", { alpha: true, willReadFrequently: true });',
      '    sourceCtx.imageSmoothingEnabled = false;',
      '    sourceCtx.drawImage(sourceBitmap, 0, 0);',
      '    if (sourceBitmap && typeof sourceBitmap.close === "function") sourceBitmap.close();',
      '    var outCanvas = null;',
      '    var engine = "browser";',
      '    var cv = await ensureCv(String(payload.opencvUrl || ""));',
      '    if (cv) {',
      '      var src = null;',
      '      var dst = null;',
      '      try {',
      '        var srcImageData = sourceCtx.getImageData(0, 0, sourceWidth, sourceHeight);',
      '        src = cv.matFromImageData(srcImageData);',
      '        dst = new cv.Mat();',
      '        var dsize = new cv.Size(targetWidth, targetHeight);',
      '        var interpolation = resolveInterpolation(cv, methodId, factor);',
      '        cv.resize(src, dst, dsize, 0, 0, interpolation);',
      '        outCanvas = new OffscreenCanvas(targetWidth, targetHeight);',
      '        var outCtx = outCanvas.getContext("2d", { alpha: true, willReadFrequently: true });',
      '        var outImageData = new ImageData(new Uint8ClampedArray(dst.data), targetWidth, targetHeight);',
      '        outCtx.putImageData(outImageData, 0, 0);',
      '        engine = "opencv";',
      '      } catch (_cvErr) {',
      '        outCanvas = null;',
      '      } finally {',
      '        if (src && typeof src.delete === "function") src.delete();',
      '        if (dst && typeof dst.delete === "function") dst.delete();',
      '      }',
      '    }',
      '    if (!outCanvas) outCanvas = scaleWithBrowser(sourceCanvas, targetWidth, targetHeight, methodId, factor);',
      '    var outputBitmap = outCanvas.transferToImageBitmap();',
      '    self.postMessage({ ok: true, width: targetWidth, height: targetHeight, engine: engine, bitmap: outputBitmap }, [outputBitmap]);',
      '  } catch (error) {',
      '    self.postMessage({ ok: false, error: error && error.message ? error.message : String(error) });',
      '  }',
      '};'
    ];
    var workerBlob = new Blob([workerScriptLines.join('\n')], { type: 'text/javascript' });
    var workerUrl = URL.createObjectURL(workerBlob);
    var worker = new Worker(workerUrl);
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timeoutId = setTimeout(function () {
        if (settled) return;
        settled = true;
        worker.terminate();
        URL.revokeObjectURL(workerUrl);
        reject(new Error('Background scaler timed out.'));
      }, SCALE_WORKER_TIMEOUT_MS);
      var cleanup = function () {
        clearTimeout(timeoutId);
        worker.terminate();
        URL.revokeObjectURL(workerUrl);
      };
      worker.addEventListener('message', function (event) {
        if (settled) return;
        settled = true;
        cleanup();
        var data = event.data || {};
        if (!data.ok) {
          reject(new Error(data.error || 'Background scaling failed.'));
          return;
        }
        resolve(data);
      });
      worker.addEventListener('error', function () {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('Background scaler worker crashed.'));
      });
      worker.postMessage(payload);
    });
  }

  async function applyScaleTransform() {
    if (!canvas || !ctx) return;
    if (scaleInFlight) {
      setStatus('Scaling is already in progress…');
      return;
    }
    persistFormDraftToSprite();
    var expectedKey = sprite ? sprite.key : null;
    var expectedCanvas = canvas;
    var expectedLoadToken = loadTokenCounter;
    var expectedEditGen = editGeneration;
    var methodId = scaleMethod;
    var factor = clampScaleFactor(scaleFactor);
    var scaleApplied = false;
    var isCurrentScaleTarget = function () {
      if (
        !sprite ||
        sprite.key !== expectedKey ||
        canvas !== expectedCanvas ||
        loadTokenCounter !== expectedLoadToken ||
        editGeneration !== expectedEditGen
      ) {
        return false;
      }
      var currentState = cloneState();
      var currentMetadata = currentMetadataSnapshot();
      return (
        !statesDiffer(before, currentState) &&
        currentMetadata &&
        currentMetadata.holdX === before.holdX &&
        currentMetadata.holdY === before.holdY &&
        currentMetadata.pivotX === before.pivotX &&
        currentMetadata.pivotY === before.pivotY
      );
    };
    if (factor === 1) {
      setStatus('Scale factor 1x leaves sprite unchanged.');
      renderEditor();
      return;
    }
    var nextWidth = Math.max(1, Math.round(canvas.width * factor));
    var nextHeight = Math.max(1, Math.round(canvas.height * factor));
    if (
      nextWidth > MAX_SCALE_DIMENSION ||
      nextHeight > MAX_SCALE_DIMENSION ||
      nextWidth * nextHeight > MAX_SCALE_PIXELS
    ) {
      setStatus(
        'Scale target ' +
          String(nextWidth) +
          'x' +
          String(nextHeight) +
          ' exceeds the safe 4096px / 16-megapixel limit.',
        true
      );
      renderEditor();
      return;
    }
    scaleInFlight = true;
    renderEditor();
    var before = cloneState();
    setStatus(
      'Scaling sprite from ' +
        String(before.imageData.width) +
        'x' +
        String(before.imageData.height) +
        ' to ' +
        String(nextWidth) +
        'x' +
        String(nextHeight) +
        '…'
    );
    try {
      var prevData = canvas.toDataURL('image/png');
      setStatus('Scaling in background worker…');
      var engine = 'browser';
      var bitmap = null;
      try {
        var workerResult = await scaleWithWorker({
          sourceDataUrl: prevData,
          sourceWidth: canvas.width,
          sourceHeight: canvas.height,
          targetWidth: nextWidth,
          targetHeight: nextHeight,
          factor: factor,
          methodId: methodId,
          opencvUrl: new URL(OPENCV_JS_URL, window.location.href).href
        });
        bitmap = workerResult.bitmap;
        engine = workerResult.engine || 'browser';
      } catch (_workerError) {
        if (!isCurrentScaleTarget()) return;
        setStatus('Background worker unavailable; applying in-tab fallback…');
        var browserScaledCanvas = scaleWithBrowserCanvas(
          expectedCanvas,
          nextWidth,
          nextHeight,
          methodId,
          factor
        );
        canvas.width = browserScaledCanvas.width;
        canvas.height = browserScaledCanvas.height;
        overlayCanvas.width = canvas.width;
        overlayCanvas.height = canvas.height;
        ctx.imageSmoothingEnabled = false;
        overlayCtx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(browserScaledCanvas, 0, 0);
      }
      if (bitmap) {
        if (!isCurrentScaleTarget()) {
          if (typeof bitmap.close === 'function') bitmap.close();
          return;
        }
        canvas.width = bitmap.width || nextWidth;
        canvas.height = bitmap.height || nextHeight;
        overlayCanvas.width = canvas.width;
        overlayCanvas.height = canvas.height;
        ctx.imageSmoothingEnabled = false;
        overlayCtx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, 0, 0);
        if (typeof bitmap.close === 'function') bitmap.close();
      }
      invalidateCanvasFingerprint();
      overlayCanvas.width = canvas.width;
      overlayCanvas.height = canvas.height;
      ctx.imageSmoothingEnabled = false;
      overlayCtx.imageSmoothingEnabled = false;
      applyZoomScale();
      var widthRatio = canvas.width / before.imageData.width;
      var heightRatio = canvas.height / before.imageData.height;
      sprite.holdX = Math.round(before.holdX * widthRatio);
      sprite.holdY = Math.round(before.holdY * heightRatio);
      sprite.pivotX = Math.round(before.pivotX * widthRatio);
      sprite.pivotY = Math.round(before.pivotY * heightRatio);
      if (sampledBackgroundPoint) {
        sampledBackgroundPoint = {
          x: Math.min(canvas.width - 1, Math.max(0, Math.round(sampledBackgroundPoint.x * widthRatio))),
          y: Math.min(canvas.height - 1, Math.max(0, Math.round(sampledBackgroundPoint.y * heightRatio)))
        };
      }
      scaleApplied = true;

      var after = cloneState();
      if (statesDiffer(before, after)) pushUndoState(before);
      renderOverlay();
      var successMessage =
        'Scaled from ' +
          String(before.imageData.width) +
          'x' +
          String(before.imageData.height) +
          ' to ' +
          String(canvas.width) +
          'x' +
          String(canvas.height) +
          ' using ' +
          methodId +
          '.';
      successMessage += engine === 'opencv' ? ' (OpenCV worker)' : ' (browser worker)';
      setStatus(successMessage);
      if (prevData === canvas.toDataURL('image/png')) setStatus('Scale completed; output image data unchanged.');
    } catch (error) {
      setStatus(error.message || String(error), true);
    } finally {
      scaleInFlight = false;
      persistFormDraftToSprite({ preserveAnchors: scaleApplied });
      renderEditor({ skipDraftPersist: true });
    }
  }

  function currentFilters() {
    var tags = (tagsInput && tagsInput.value ? tagsInput.value : '')
      .split(',')
      .map(function (tag) { return tag.trim().toLowerCase(); })
      .filter(Boolean);
    return {
      q: searchInput ? searchInput.value.trim() : '',
      collapse: !!(collapseCheckbox && collapseCheckbox.checked),
      placeholders: placeholdersSelect ? placeholdersSelect.value : 'all',
      favorites: favoritesSelect ? favoritesSelect.value : 'all',
      tags: tags
    };
  }

  function currentMetadataSnapshot() {
    if (!sprite) return null;
    var getNum = function (id, fallback) {
      var input = document.getElementById(id);
      var n = Number(input ? input.value : fallback);
      return Number.isFinite(n) ? Math.max(0, Math.round(n)) : Math.max(0, Math.round(Number(fallback) || 0));
    };
    var facing = document.getElementById('facing');
    return {
      holdX: getNum('holdX', sprite.holdX || 0),
      holdY: getNum('holdY', sprite.holdY || 0),
      pivotX: getNum('pivotX', sprite.pivotX || 0),
      pivotY: getNum('pivotY', sprite.pivotY || 0),
      frame: getNum('frame', sprite.frame || 0),
      col: getNum('col', sprite.col || 0),
      row: getNum('row', sprite.row || 0),
      facingDirection: facing && facing.value === 'left' ? 'left' : 'right'
    };
  }

  function currentAnnotationSnapshot() {
    var favoriteInput = document.getElementById('favorite');
    var dislikedInput = document.getElementById('disliked');
    var commentInput = document.getElementById('comment');
    return {
      favorite: !!(favoriteInput && favoriteInput.value === 'true'),
      disliked: !!(dislikedInput && dislikedInput.value === 'true'),
      comment: commentInput ? commentInput.value : (sprite && sprite.comment ? String(sprite.comment) : '')
    };
  }

  function persistFormDraftToSprite(options) {
    if (!sprite || !editorEl) return;
    if (!editorEl.querySelector('#comment')) return;
    var opts = options || {};
    var meta = currentMetadataSnapshot();
    var note = currentAnnotationSnapshot();
    if (meta) {
      if (!opts.preserveAnchors) {
        sprite.holdX = meta.holdX;
        sprite.holdY = meta.holdY;
        sprite.pivotX = meta.pivotX;
        sprite.pivotY = meta.pivotY;
      }
      sprite.frame = meta.frame;
      sprite.col = meta.col;
      sprite.row = meta.row;
      sprite.facingDirection = meta.facingDirection;
    }
    sprite.favorite = note.favorite;
    sprite.disliked = note.disliked;
    sprite.comment = note.comment;
  }

  function serializeEditorFingerprint(key, metadata, annotation, pngDataUrl) {
    return JSON.stringify({ key, metadata, annotation, pngDataUrl });
  }

  function metadataSnapshotFromSprite(spriteState) {
    if (!spriteState) return null;
    return {
      holdX: Number(spriteState.holdX ?? 0),
      holdY: Number(spriteState.holdY ?? 0),
      pivotX: Number(spriteState.pivotX ?? 0),
      pivotY: Number(spriteState.pivotY ?? 0),
      frame: Number(spriteState.frame ?? 0),
      col: Number(spriteState.col ?? 0),
      row: Number(spriteState.row ?? 0),
      facingDirection: spriteState.facingDirection === 'left' ? 'left' : 'right',
    };
  }

  function annotationSnapshotFromSprite(spriteState) {
    return {
      favorite: !!(spriteState && spriteState.favorite),
      disliked: !!(spriteState && spriteState.disliked),
      comment: spriteState && spriteState.comment ? String(spriteState.comment) : '',
    };
  }

  function editorFingerprintForSprite(spriteState, pngDataUrl) {
    if (!spriteState) return null;
    return serializeEditorFingerprint(
      spriteState.key,
      metadataSnapshotFromSprite(spriteState),
      annotationSnapshotFromSprite(spriteState),
      pngDataUrl
    );
  }

  function currentEditorInputFingerprint() {
    if (!sprite) return null;
    return JSON.stringify({
      key: sprite.key,
      metadata: currentMetadataSnapshot(),
      annotation: currentAnnotationSnapshot()
    });
  }

  function currentEditorFingerprint() {
    if (!sprite) return null;
    return serializeEditorFingerprint(
      sprite.key,
      currentMetadataSnapshot(),
      currentAnnotationSnapshot(),
      currentCanvasFingerprint()
    );
  }

  function currentCanvasFingerprint() {
    if (!canvas) return null;
    if (cachedCanvasFingerprint === null) {
      cachedCanvasFingerprint = canvasToPngDataUrl();
    }
    return cachedCanvasFingerprint;
  }

  function invalidateCanvasFingerprint() {
    cachedCanvasFingerprint = null;
  }

  function resetBaseline() {
    baselineFingerprint = currentEditorFingerprint();
  }

  function isDirty() {
    if (!sprite || !baselineFingerprint) return false;
    return currentEditorFingerprint() !== baselineFingerprint;
  }

  async function confirmLeaveIfDirty() {
    if (!isDirty()) return { status: 'clean' };
    var saveFirst = confirm('Unsaved edits detected. Press OK to save before continuing. Press Cancel for discard/cancel options.');
    if (saveFirst) {
      var saved = await saveCurrent({ refreshList: false });
      return saved === true ? { status: 'saved' } : { status: 'save_failed' };
    }
    var discard = confirm('Discard unsaved edits and continue? Press OK to discard, Cancel to stay.');
    return discard ? { status: 'discarded' } : { status: 'cancelled' };
  }

  async function loadList(options) {
    var opts = options || {};
    var expectedFingerprint =
      typeof opts.expectedFingerprint === 'string' ? opts.expectedFingerprint : null;
    if (expectedFingerprint && currentEditorFingerprint() !== expectedFingerprint) {
      setStatus('Skipped list refresh to preserve newer edits.');
      return;
    }
    if (!opts.skipDirtyGuard) {
      var dirtyDecision = await confirmLeaveIfDirty();
      if (dirtyDecision.status === 'save_failed') return;
      if (dirtyDecision.status === 'cancelled') {
        setStatus('Stayed on current sprite.');
        return;
      }
    }
    var listToken = ++listTokenCounter;
    var filters = currentFilters();
    var qs = new URLSearchParams();
    qs.set('q', filters.q);
    qs.set('collapse', filters.collapse ? 'true' : 'false');
    qs.set('placeholders', filters.placeholders);
    qs.set('favorites', filters.favorites);
    qs.set('tags', filters.tags.join(','));
    qs.set('limit', '500');
    setStatus('Loading sprites…');
    try {
      var data = await fetchJson('/api/list?' + qs.toString());
      if (listToken !== listTokenCounter) return;
      if (expectedFingerprint && currentEditorFingerprint() !== expectedFingerprint) {
        setStatus('Skipped list refresh to preserve newer edits.');
        return;
      }
      sprites = data.sprites || [];
      // The list defines the prefetch universe; drop warm-keys from the previous
      // one so a re-listed sprite whose bytes changed is re-warmed at its new URL.
      prefetchedImageKeys = Object.create(null);
      if (totalEl) totalEl.textContent = String(data.total || 0);
      refreshTagsDatalist(data.availableTags || []);
      if (
        (!selectedKey || !sprites.some(function (s) { return s.key === selectedKey; })) &&
        sprites.length > 0
      ) {
        var byGroup = selectedVariantGroup
          ? sprites.find(function (s) { return s.variantGroup === selectedVariantGroup; })
          : null;
        selectedKey = byGroup ? byGroup.key : sprites[0].key;
      }
      renderList();
      if (selectedKey) await loadSprite(selectedKey, { skipDirtyGuard: true, updateSelection: false });
      else renderEditor();
      setStatus('Loaded ' + sprites.length + ' sprite entries.');
    } catch (error) {
      setStatus(error.message || String(error), true);
    }
  }

  function refreshTagsDatalist(tags) {
    if (!tagsDatalist) return;
    tagsDatalist.replaceChildren();
    for (var i = 0; i < tags.length; i++) {
      tagsDatalist.appendChild(h('option', { value: tags[i] }));
    }
  }

  function renderList() {
    if (!listEl) return;
    listEl.replaceChildren();
    for (var i = 0; i < sprites.length; i++) {
      (function () {
        var item = sprites[i];
        var active =
          item.key === selectedKey ||
          (!!collapseCheckbox && collapseCheckbox.checked && !!selectedVariantGroup && item.variantGroup === selectedVariantGroup);
        var row = h('button', { class: 'row-item' + (active ? ' active' : ''), type: 'button' }, [
          h('div', { class: 'row' }, [
            h('strong', { text: item.label }),
            item.favorite ? h('span', { class: 'heart', text: '♥ favorite' }) : null,
            item.disliked ? h('span', { class: 'heart', text: '👎 disliked' }) : null,
            item.variantCount > 1 ? h('span', { class: 'variants-badge', text: String(item.variantCount) + ' variants' }) : null,
            item.placeholder ? h('span', { class: 'pill', text: 'placeholder' }) : null
          ]),
          h('span', { class: 'muted', text: item.key + ' · ' + item.assetPath }),
          h('span', { class: 'muted', text: (item.briefId || item.variantGroup || 'no-brief') + (item.variantIndex != null ? ' · v' + item.variantIndex : '') }),
          item.comment ? h('span', { class: 'muted', text: 'Comment: ' + item.comment.slice(0, 80) }) : null
        ]);
        row.addEventListener('click', async function () {
          var loaded = await loadSprite(item.key);
          if (!loaded) return;
          selectedKey = item.key;
          selectedVariantGroup = item.variantGroup || null;
          renderList();
        });
        row.addEventListener('contextmenu', function (ev) {
          ev.preventDefault();
          showContextMenuAt(ev, [
            {
              label: 'Open sprite',
              onClick: async function () {
                var loaded = await loadSprite(item.key);
                if (!loaded) return;
                selectedKey = item.key;
                selectedVariantGroup = item.variantGroup || null;
                renderList();
              }
            },
            {
              label: item.favorite ? 'Unfavorite' : 'Favorite',
              onClick: async function () {
                if (mutationInFlight) {
                  setStatus('A save or revert is already in progress.');
                  return;
                }
                try {
                  var dirtyDecision = await confirmLeaveIfDirty();
                  if (dirtyDecision.status === 'save_failed' || dirtyDecision.status === 'cancelled') return;
                  setMutationInFlight(true);
                  var editorFingerprintAtStart = currentEditorFingerprint();
                  var currentFavorite = !!item.favorite;
                  var currentDisliked = !!item.disliked;
                  var currentComment = item.comment ? String(item.comment) : '';
                  if (sprite && sprite.key === item.key) {
                    currentFavorite = !!sprite.favorite;
                    currentDisliked = !!sprite.disliked;
                    currentComment = sprite.comment ? String(sprite.comment) : '';
                  }
                  var nextAnnotation = {
                    favorite: !currentFavorite,
                    disliked: !currentFavorite ? false : currentDisliked,
                    comment: currentComment
                  };
                  await fetchJson('/api/save', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      key: item.key,
                      annotation: nextAnnotation
                    })
                  });
                  if (sprite && sprite.key === item.key) {
                    sprite.favorite = nextAnnotation.favorite;
                    sprite.disliked = nextAnnotation.disliked;
                    sprite.comment = nextAnnotation.comment;
                    renderEditor({ skipDraftPersist: true });
                    resetBaseline();
                  }
                  if (currentEditorFingerprint() === editorFingerprintAtStart) {
                    await loadList({ skipDirtyGuard: true });
                  }
                  setStatus((!currentFavorite ? 'Marked' : 'Unmarked') + ' favorite.');
                } catch (error) {
                  setStatus(error.message || String(error), true);
                } finally {
                  setMutationInFlight(false);
                }
              }
            }
          ]);
        });
        listEl.appendChild(row);
      })();
    }
  }

  async function loadSprite(key, options) {
    var opts = options || {};
    persistFormDraftToSprite();
    if (!opts.skipDirtyGuard) {
      var dirtyDecision = await confirmLeaveIfDirty();
      if (dirtyDecision.status === 'save_failed') return false;
      if (dirtyDecision.status === 'cancelled') {
        setStatus('Stayed on current sprite.');
        return false;
      }
    }
    var expectedFingerprint = currentEditorFingerprint();
    var expectedInputFingerprint = currentEditorInputFingerprint();
    var loadToken = ++loadTokenCounter;
    setStatus('Loading sprite…');
    try {
      var data = await fetchJson('/api/sprite?key=' + encodeURIComponent(key));
      if (loadToken !== loadTokenCounter) return false;
      if (expectedFingerprint && currentEditorFingerprint() !== expectedFingerprint) {
        setStatus('Stayed on current sprite: newer edits were made while loading.');
        return false;
      }
      var nextSprite = data.sprite || null;
      if (!nextSprite) {
        renderEditor();
        setStatus('Sprite not found.', true);
        return false;
      }
      await loadImage(loadToken, nextSprite.key, nextSprite.imageVersion);
      if (loadToken !== loadTokenCounter) return false;
      // loadImage legitimately replaces the canvas, so the post-load guard must
      // compare only user-editable inputs; including canvas bytes here would
      // always trip and abort before resetBaseline(), leaving a stale baseline
      // that makes every subsequent sprite look falsely dirty.
      if (expectedInputFingerprint && currentEditorInputFingerprint() !== expectedInputFingerprint) {
        setStatus('Stayed on current sprite: newer edits were made while loading.');
        return false;
      }
      sprite = nextSprite;
      renderEditor({ skipDraftPersist: true });
      resetBaseline();
      // renderEditor paints the badge from the pre-load baseline, so refresh the
      // indicator once the new baseline is in place or a freshly loaded sprite
      // keeps a stale "Unsaved" badge.
      updateDirtyIndicator();
      if (opts.updateSelection !== false) {
        selectedKey = sprite.key;
        selectedVariantGroup = sprite.variantGroup || null;
        renderList();
      }
      setStatus('Ready.');
      prefetchNeighbors(sprite);
      return true;
    } catch (error) {
      console.error('[sprite-editor] failed to load sprite', error);
      setStatus(error.message || String(error), true);
      return false;
    }
  }

  function canvasToPngDataUrl() {
    if (!canvas) return null;
    return canvas.toDataURL('image/png');
  }

  /**
   * Build the image URL for a sprite. Keying on the content version (rather than
   * the old timestamp cache-buster) makes a repeat visit a browser-cache hit
   * instead of a fresh fetch + PNG decode, while still guaranteeing that edited
   * bytes mint a brand-new URL.
   */
  function spriteImageUrl(spriteKey, imageVersion) {
    var url = '/img/sprite?key=' + encodeURIComponent(spriteKey);
    return imageVersion ? url + '&v=' + encodeURIComponent(imageVersion) : url + '&_ts=' + Date.now();
  }

  /**
   * Warm the browser image cache for the sprites the user is most likely to open
   * next (the adjacent variants and the neighbouring list rows). Purely
   * best-effort: failures are ignored and nothing here touches editor state.
   */
  function prefetchNeighbors(currentSprite) {
    if (!currentSprite) return;
    var wanted = [];
    if (currentSprite.prevVariantKey) wanted.push(currentSprite.prevVariantKey);
    if (currentSprite.nextVariantKey) wanted.push(currentSprite.nextVariantKey);
    var index = -1;
    for (var i = 0; i < sprites.length; i++) {
      if (sprites[i].key === currentSprite.key) { index = i; break; }
    }
    if (index >= 0) {
      if (sprites[index - 1]) wanted.push(sprites[index - 1].key);
      if (sprites[index + 1]) wanted.push(sprites[index + 1].key);
    }
    for (var j = 0; j < wanted.length; j++) {
      var neighborKey = wanted[j];
      if (!neighborKey || prefetchedImageKeys[neighborKey]) continue;
      var row = null;
      for (var k = 0; k < sprites.length; k++) {
        if (sprites[k].key === neighborKey) { row = sprites[k]; break; }
      }
      // Without a known version we cannot build a cacheable URL, so prefetching
      // would just burn a request that the real load could not reuse.
      if (!row || !row.imageVersion) continue;
      prefetchedImageKeys[neighborKey] = true;
      var warm = new Image();
      warm.decoding = 'async';
      warm.src = spriteImageUrl(neighborKey, row.imageVersion);
    }
  }

  async function loadImage(loadToken, spriteKey, imageVersion) {
    if (!spriteKey) return;
    var img = new Image();
    img.src = spriteImageUrl(spriteKey, imageVersion);
    await new Promise(function (resolve, reject) {
      img.onload = resolve;
      img.onerror = reject;
    });
    if (loadToken != null && loadToken !== loadTokenCounter) return;
    canvas = h('canvas', { class: 'sprite-canvas' });
    overlayCanvas = h('canvas', { class: 'overlay-canvas' });
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    overlayCanvas.width = canvas.width;
    overlayCanvas.height = canvas.height;
    applyZoomScale();
    ctx = canvas.getContext('2d', { willReadFrequently: true });
    overlayCtx = overlayCanvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;
    overlayCtx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0);
    invalidateCanvasFingerprint();
    comparisonBeforeCanvas = null;
    comparisonActionLabel = 'Last saved';
    captureLastSavedSnapshot();
    undoStack = [];
    redoStack = [];
    strokeSnapshot = null;
    sampledBackgroundColor = null;
    sampledBackgroundPoint = null;
    lastAppliedEdgeCleanupSignature = null;
    lastAppliedBackgroundRemovalSignature = null;
    lastAppliedFringeNormalizeSignature = null;
    armEyedropper(false);
    bindCanvasDraw();
    renderOverlay();
  }

  function toPixel(ev) {
    if (!canvas) return null;
    var rect = canvas.getBoundingClientRect();
    var x = Math.floor(((ev.clientX - rect.left) * canvas.width) / rect.width);
    var y = Math.floor(((ev.clientY - rect.top) * canvas.height) / rect.height);
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return null;
    return { x: x, y: y };
  }

  function captureLastSavedSnapshot(sourceCanvas) {
    var snapshotSource = sourceCanvas || canvas;
    if (!snapshotSource) return;
    if (!comparisonBeforeCanvas) {
      comparisonBeforeCanvas = h('canvas', {
        id: 'comparison-before-canvas',
        class: 'comparison-canvas',
        'aria-label': 'Before edit preview'
      });
    }
    comparisonBeforeCanvas.width = snapshotSource.width;
    comparisonBeforeCanvas.height = snapshotSource.height;
    var comparisonCtx = comparisonBeforeCanvas.getContext('2d');
    comparisonCtx.imageSmoothingEnabled = false;
    comparisonCtx.clearRect(0, 0, comparisonBeforeCanvas.width, comparisonBeforeCanvas.height);
    comparisonCtx.drawImage(snapshotSource, 0, 0);
    comparisonActionLabel = 'Last saved';
    applyZoomScale();
    var labelEl = document.getElementById('comparison-before-label');
    if (labelEl) labelEl.textContent = comparisonActionLabel;
  }

  function applyBrush(x, y) {
    if (!ctx || !canvas) return;
    invalidateCanvasFingerprint();
    var half = Math.floor(brushSize / 2);
    var left = Math.max(0, x - half);
    var top = Math.max(0, y - half);
    var width = Math.min(canvas.width - left, brushSize);
    var height = Math.min(canvas.height - top, brushSize);
    if (drawMode === 'erase') {
      ctx.clearRect(left, top, width, height);
      return;
    }

    ctx.save();
    ctx.fillStyle = drawColor;
    ctx.fillRect(left, top, width, height);
    ctx.restore();
  }

  function getPixelOffset(x, y, width) {
    return (y * width + x) * 4;
  }

  function sampleCornerMatte(imageData) {
    var data = imageData.data;
    var width = imageData.width;
    var height = imageData.height;
    var sampleSize = Math.max(1, Math.min(3, width, height));
    var totalR = 0;
    var totalG = 0;
    var totalB = 0;
    var count = 0;
    function sampleBlock(startX, startY) {
      for (var y = startY; y < Math.min(height, startY + sampleSize); y++) {
        for (var x = startX; x < Math.min(width, startX + sampleSize); x++) {
          var offset = getPixelOffset(x, y, width);
          if (data[offset + 3] === 0) continue;
          totalR += data[offset];
          totalG += data[offset + 1];
          totalB += data[offset + 2];
          count += 1;
        }
      }
    }
    sampleBlock(0, 0);
    sampleBlock(Math.max(0, width - sampleSize), 0);
    sampleBlock(0, Math.max(0, height - sampleSize));
    sampleBlock(Math.max(0, width - sampleSize), Math.max(0, height - sampleSize));
    if (count === 0) return null;
    return {
      r: Math.round(totalR / count),
      g: Math.round(totalG / count),
      b: Math.round(totalB / count)
    };
  }

  function resolveBackgroundReference(imageData) {
    if (
      sampledBackgroundColor &&
      Number.isFinite(sampledBackgroundColor.r) &&
      Number.isFinite(sampledBackgroundColor.g) &&
      Number.isFinite(sampledBackgroundColor.b)
    ) {
      return {
        r: clampChannel(sampledBackgroundColor.r),
        g: clampChannel(sampledBackgroundColor.g),
        b: clampChannel(sampledBackgroundColor.b)
      };
    }
    return sampleCornerMatte(imageData);
  }

  function colorDistanceSq(r1, g1, b1, r2, g2, b2) {
    var dr = r1 - r2;
    var dg = g1 - g2;
    var db = b1 - b2;
    return dr * dr + dg * dg + db * db;
  }

  function clampChannel(value) {
    return Math.max(0, Math.min(255, Math.round(value)));
  }

  function findNeighborOpaqueAverage(data, width, height, x, y, alphaFloor) {
    var totalR = 0;
    var totalG = 0;
    var totalB = 0;
    var count = 0;
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        var nx = x + dx;
        var ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        var neighborOffset = getPixelOffset(nx, ny, width);
        if (data[neighborOffset + 3] < alphaFloor) continue;
        totalR += data[neighborOffset];
        totalG += data[neighborOffset + 1];
        totalB += data[neighborOffset + 2];
        count += 1;
      }
    }
    if (count === 0) return null;
    return {
      r: totalR / count,
      g: totalG / count,
      b: totalB / count
    };
  }

  function collectConnectedBackgroundMask(data, width, height, referenceColor, limitSq, softLimitSq, seedPoints) {
    var mask = new Uint8Array(width * height);
    var visited = new Uint8Array(width * height);
    var queue = [];
    var head = 0;
    function enqueue(x, y) {
      if (x < 0 || y < 0 || x >= width || y >= height) return;
      var index = y * width + x;
      if (visited[index]) return;
      visited[index] = 1;
      queue.push(index);
    }
    for (var i = 0; i < seedPoints.length; i++) {
      enqueue(seedPoints[i].x, seedPoints[i].y);
    }
    while (head < queue.length) {
      var pixelIndex = queue[head++];
      var px = pixelIndex % width;
      var py = (pixelIndex - px) / width;
      var offset = pixelIndex * 4;
      var distSq = colorDistanceSq(
        data[offset],
        data[offset + 1],
        data[offset + 2],
        referenceColor.r,
        referenceColor.g,
        referenceColor.b
      );
      if (distSq > softLimitSq) continue;
      mask[pixelIndex] = 1;
      if (px > 0) enqueue(px - 1, py);
      if (px + 1 < width) enqueue(px + 1, py);
      if (py > 0) enqueue(px, py - 1);
      if (py + 1 < height) enqueue(px, py + 1);
    }
    return mask;
  }

  function findMajorityOpaqueNeighbor(data, width, height, x, y, alphaFloor, bgLimitSq, referenceColor) {
    var buckets = new Map();
    var best = null;
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        var nx = x + dx;
        var ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        var neighborOffset = getPixelOffset(nx, ny, width);
        if (data[neighborOffset + 3] < alphaFloor) continue;
        if (
          referenceColor &&
          colorDistanceSq(
            data[neighborOffset],
            data[neighborOffset + 1],
            data[neighborOffset + 2],
            referenceColor.r,
            referenceColor.g,
            referenceColor.b
          ) <= bgLimitSq
        ) {
          continue;
        }
        var key = [
          Math.round(data[neighborOffset] / 16),
          Math.round(data[neighborOffset + 1] / 16),
          Math.round(data[neighborOffset + 2] / 16)
        ].join(',');
        var entry = buckets.get(key) || {
          count: 0,
          r: data[neighborOffset],
          g: data[neighborOffset + 1],
          b: data[neighborOffset + 2]
        };
        entry.count += 1;
        buckets.set(key, entry);
        if (!best || entry.count > best.count) best = entry;
      }
    }
    return best ? { r: best.r, g: best.g, b: best.b } : null;
  }

  function isFringeCandidate(data, width, height, x, y, referenceColor, bgLimitSq, alphaCutoff) {
    var offset = getPixelOffset(x, y, width);
    var alpha = data[offset + 3];
    if (alpha === 0) return false;
    var lowAlpha = alpha <= alphaCutoff;
    var selfNearBg =
      colorDistanceSq(data[offset], data[offset + 1], data[offset + 2], referenceColor.r, referenceColor.g, referenceColor.b) <=
      bgLimitSq;
    var touchesTransparent = false;
    var touchesSolid = false;
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        var nx = x + dx;
        var ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        var neighborOffset = getPixelOffset(nx, ny, width);
        var neighborAlpha = data[neighborOffset + 3];
        if (neighborAlpha === 0) touchesTransparent = true;
        if (neighborAlpha >= Math.max(alphaCutoff, 96)) touchesSolid = true;
      }
    }
    return touchesTransparent && (lowAlpha || selfNearBg || touchesSolid);
  }

  function applyImageDataTransform(label, applyFn, onApplied) {
    if (!canvas || !ctx) return;
    var before = cloneState();
    if (!before || !before.imageData) return;
    var working = new ImageData(
      new Uint8ClampedArray(before.imageData.data),
      before.imageData.width,
      before.imageData.height
    );
    var result = applyFn(working) || {};
    ctx.putImageData(working, 0, 0);
    invalidateCanvasFingerprint();
    var after = cloneState();
    if (!statesDiffer(before, after)) {
      setStatus(result.message || (label + ' made no visible change.'));
      renderEditor();
      renderOverlay();
      return;
    }
    pushUndoState(before);
    if (typeof onApplied === 'function') onApplied();
    renderEditor();
    renderOverlay();
    setStatus(result.message || (label + ' applied.'));
  }

  function applyEdgeCleanup() {
    var methodId = String(edgeCleanupMethod || 'defringe');
    var amount = clampPercent(edgeCleanupAmount, 60);
    var alphaCutoff = clampByte(edgeCleanupAlphaCutoff, 24);
    applyImageDataTransform('Edge cleanup', function (imageData) {
      var data = imageData.data;
      var width = imageData.width;
      var height = imageData.height;
      var strength = amount / 100;
      var bgTolerance = Math.max(10, clampByte(backgroundTolerance, 36));
      var bgLimitSq = bgTolerance * bgTolerance * 3;
      if (methodId === 'alpha-threshold') {
        for (var idx = 0; idx < data.length; idx += 4) {
          if (data[idx + 3] <= alphaCutoff) data[idx + 3] = 0;
        }
        return { message: 'Edge cleanup alpha-threshold applied.' };
      }
      var matte = resolveBackgroundReference(imageData);
      if (!matte) return { message: 'Pick a background color before edge cleanup.' };
      for (var y = 0; y < height; y++) {
        for (var x = 0; x < width; x++) {
          var offset = getPixelOffset(x, y, width);
          var alpha = data[offset + 3];
          if (alpha === 0) continue;
          var distSq = colorDistanceSq(data[offset], data[offset + 1], data[offset + 2], matte.r, matte.g, matte.b);
          var fringeCandidate = isFringeCandidate(
            data,
            width,
            height,
            x,
            y,
            matte,
            bgLimitSq,
            Math.max(10, alphaCutoff)
          );
          if (methodId === 'defringe') {
            if (!fringeCandidate) continue;
            if (alpha <= alphaCutoff) {
              data[offset + 3] = 0;
              continue;
            }
            if (distSq > bgLimitSq && alpha === 255) continue;
            var neighbor = findNeighborOpaqueAverage(data, width, height, x, y, Math.max(alphaCutoff, 96));
            if (!neighbor) continue;
            data[offset] = clampChannel(data[offset] * (1 - strength) + neighbor.r * strength);
            data[offset + 1] = clampChannel(data[offset + 1] * (1 - strength) + neighbor.g * strength);
            data[offset + 2] = clampChannel(data[offset + 2] * (1 - strength) + neighbor.b * strength);
            continue;
          }
          if (methodId === 'matte-neutralize') {
            if (!fringeCandidate) continue;
            if (alpha === 255 && distSq <= bgLimitSq) {
              var opaqueNeighbor = findNeighborOpaqueAverage(data, width, height, x, y, Math.max(alphaCutoff, 96));
              if (opaqueNeighbor) {
                data[offset] = clampChannel(data[offset] * (1 - strength) + opaqueNeighbor.r * strength);
                data[offset + 1] = clampChannel(data[offset + 1] * (1 - strength) + opaqueNeighbor.g * strength);
                data[offset + 2] = clampChannel(data[offset + 2] * (1 - strength) + opaqueNeighbor.b * strength);
              }
              continue;
            }
            if (alpha === 255) continue;
            var a = alpha / 255;
            if (a <= 0) continue;
            var solvedR = (data[offset] - matte.r * (1 - a)) / a;
            var solvedG = (data[offset + 1] - matte.g * (1 - a)) / a;
            var solvedB = (data[offset + 2] - matte.b * (1 - a)) / a;
            data[offset] = clampChannel(data[offset] * (1 - strength) + solvedR * strength);
            data[offset + 1] = clampChannel(data[offset + 1] * (1 - strength) + solvedG * strength);
            data[offset + 2] = clampChannel(data[offset + 2] * (1 - strength) + solvedB * strength);
          }
        }
      }
      return { message: 'Edge cleanup ' + methodId + ' applied.' };
    }, function () {
      lastAppliedEdgeCleanupSignature = edgeCleanupSignature();
    });
  }

  function applyBackgroundRemoval() {
    var methodId = String(backgroundRemovalMethod || 'color-key');
    var tolerance = clampByte(backgroundTolerance, 36);
    var softness = clampByte(backgroundSoftness, 24);
    applyImageDataTransform('Background removal', function (imageData) {
      var data = imageData.data;
      var width = imageData.width;
      var height = imageData.height;
      var limitSq = tolerance * tolerance * 3;
      var softLimitSq = Math.max(limitSq + softness * softness * 3, limitSq + 1);
      var seedPoints = methodId === 'flood-fill' && sampledBackgroundPoint
        ? [{ x: sampledBackgroundPoint.x, y: sampledBackgroundPoint.y }]
        : [
            { x: 0, y: 0 },
            { x: Math.max(0, width - 1), y: 0 },
            { x: 0, y: Math.max(0, height - 1) },
            { x: Math.max(0, width - 1), y: Math.max(0, height - 1) }
          ];
      if (methodId === 'alpha-threshold') {
        for (var idx = 0; idx < data.length; idx += 4) {
          if (data[idx + 3] <= tolerance) data[idx + 3] = 0;
        }
        return { message: 'Background removal alpha-threshold applied.' };
      }
      var matte = resolveBackgroundReference(imageData);
      if (!matte) return { message: 'Pick a background color before background removal.' };
      if (methodId === 'flood-fill') {
        var connectedMask = collectConnectedBackgroundMask(data, width, height, matte, limitSq, softLimitSq, seedPoints);
        for (var idx2 = 0; idx2 < connectedMask.length; idx2++) {
          if (!connectedMask[idx2]) continue;
          var offset2 = idx2 * 4;
          var distSq2 = colorDistanceSq(data[offset2], data[offset2 + 1], data[offset2 + 2], matte.r, matte.g, matte.b);
          if (distSq2 <= limitSq) {
            data[offset2 + 3] = 0;
          } else {
            var keep2 = (distSq2 - limitSq) / Math.max(1, softLimitSq - limitSq);
            data[offset2 + 3] = clampChannel(data[offset2 + 3] * keep2);
          }
        }
        return { message: 'Background removal ' + (sampledBackgroundPoint ? 'sampled-region' : 'flood-fill') + ' applied.' };
      }
      for (var idx3 = 0; idx3 < data.length; idx3 += 4) {
        var dSq = colorDistanceSq(data[idx3], data[idx3 + 1], data[idx3 + 2], matte.r, matte.g, matte.b);
        if (dSq <= limitSq) {
          data[idx3 + 3] = 0;
        } else if (dSq < softLimitSq) {
          var keep = (dSq - limitSq) / Math.max(1, softLimitSq - limitSq);
          data[idx3 + 3] = clampChannel(data[idx3 + 3] * keep);
        }
      }
      return { message: 'Background removal color-key applied.' };
    }, function () {
      lastAppliedBackgroundRemovalSignature = backgroundRemovalSignature();
    });
  }

  function applyFringeNormalize() {
    var methodId = String(fringeNormalizeMethod || 'opaque-average');
    var strength = clampPercent(fringeNormalizeStrength, 70) / 100;
    var threshold = clampByte(fringeNormalizeThreshold, 28);
    applyImageDataTransform('Fringe normalize', function (imageData) {
      var data = imageData.data;
      var width = imageData.width;
      var height = imageData.height;
      var referenceColor = resolveBackgroundReference(imageData);
      if (!referenceColor) {
        return { message: 'Pick a background color before fringe normalization.' };
      }
      var bgLimitSq = threshold * threshold * 3;
      var changed = 0;
      for (var y = 0; y < height; y++) {
        for (var x = 0; x < width; x++) {
          if (!isFringeCandidate(data, width, height, x, y, referenceColor, bgLimitSq, Math.max(10, edgeCleanupAlphaCutoff))) continue;
          var offset = getPixelOffset(x, y, width);
          var target = null;
          if (methodId === 'majority-neighbor') {
            target = findMajorityOpaqueNeighbor(
              data,
              width,
              height,
              x,
              y,
              Math.max(32, edgeCleanupAlphaCutoff),
              bgLimitSq,
              referenceColor
            );
          } else if (methodId === 'opaque-average') {
            target = findNeighborOpaqueAverage(
              data,
              width,
              height,
              x,
              y,
              Math.max(32, edgeCleanupAlphaCutoff)
            );
            if (
              target &&
              colorDistanceSq(target.r, target.g, target.b, referenceColor.r, referenceColor.g, referenceColor.b) <= bgLimitSq
            ) {
              target = null;
            }
          } else if (methodId === 'despill') {
            var baseStrength = Math.max(0.2, strength);
            target = {
              r: clampChannel(data[offset] + (data[offset] - referenceColor.r) * baseStrength),
              g: clampChannel(data[offset + 1] + (data[offset + 1] - referenceColor.g) * baseStrength),
              b: clampChannel(data[offset + 2] + (data[offset + 2] - referenceColor.b) * baseStrength)
            };
          }
          if (!target) continue;
          data[offset] = clampChannel(data[offset] * (1 - strength) + target.r * strength);
          data[offset + 1] = clampChannel(data[offset + 1] * (1 - strength) + target.g * strength);
          data[offset + 2] = clampChannel(data[offset + 2] * (1 - strength) + target.b * strength);
          changed += 1;
        }
      }
      return { message: changed > 0 ? 'Fringe normalize ' + methodId + ' applied to ' + changed + ' pixels.' : 'Fringe normalize made no visible change.' };
    }, function () {
      lastAppliedFringeNormalizeSignature = fringeNormalizeSignature();
    });
  }

  function hideContextMenu() {
    if (!contextMenu) return;
    contextMenu.remove();
    contextMenu = null;
  }

  function showContextMenuAt(ev, items) {
    hideContextMenu();
    contextMenu = h('div', { class: 'context-menu' });
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var btn = h('button', { type: 'button', text: item.label });
      btn.disabled = !!item.disabled;
      if (!item.disabled) {
        btn.addEventListener('click', (function (handler) {
          return function () {
            hideContextMenu();
            handler();
          };
        })(item.onClick));
      }
      contextMenu.appendChild(btn);
    }
    contextMenu.style.left = ev.clientX + 'px';
    contextMenu.style.top = ev.clientY + 'px';
    document.body.appendChild(contextMenu);
  }

  function cloneState() {
    if (!ctx || !canvas) return null;
    return {
      imageData: ctx.getImageData(0, 0, canvas.width, canvas.height),
      holdX: sprite ? Number(sprite.holdX || 0) : 0,
      holdY: sprite ? Number(sprite.holdY || 0) : 0,
      pivotX: sprite ? Number(sprite.pivotX || 0) : 0,
      pivotY: sprite ? Number(sprite.pivotY || 0) : 0,
      sampledBackgroundPoint: sampledBackgroundPoint
        ? { x: Number(sampledBackgroundPoint.x), y: Number(sampledBackgroundPoint.y) }
        : null
    };
  }

  function statesDiffer(a, b) {
    if (!a || !b) return false;
    if (
      a.holdX !== b.holdX ||
      a.holdY !== b.holdY ||
      a.pivotX !== b.pivotX ||
      a.pivotY !== b.pivotY
    ) {
      return true;
    }
    var aSample = a.sampledBackgroundPoint;
    var bSample = b.sampledBackgroundPoint;
    if (!!aSample !== !!bSample) return true;
    if (aSample && bSample && (aSample.x !== bSample.x || aSample.y !== bSample.y)) {
      return true;
    }
    if (
      !a.imageData ||
      !b.imageData ||
      a.imageData.width !== b.imageData.width ||
      a.imageData.height !== b.imageData.height
    ) {
      return true;
    }
    var lhs = a.imageData && a.imageData.data ? a.imageData.data : null;
    var rhs = b.imageData && b.imageData.data ? b.imageData.data : null;
    if (!lhs || !rhs || lhs.length !== rhs.length) return true;
    for (var i = 0; i < lhs.length; i++) {
      if (lhs[i] !== rhs[i]) return true;
    }
    return false;
  }

  function applyState(state) {
    if (!state || !ctx || !canvas || !sprite) return;
    if (
      canvas.width !== state.imageData.width ||
      canvas.height !== state.imageData.height
    ) {
      canvas.width = state.imageData.width;
      canvas.height = state.imageData.height;
      overlayCanvas.width = canvas.width;
      overlayCanvas.height = canvas.height;
      ctx = canvas.getContext('2d', { willReadFrequently: true });
      overlayCtx = overlayCanvas.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = false;
      overlayCtx.imageSmoothingEnabled = false;
      applyZoomScale();
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.putImageData(state.imageData, 0, 0);
    invalidateCanvasFingerprint();
    sprite.holdX = state.holdX;
    sprite.holdY = state.holdY;
    sprite.pivotX = state.pivotX;
    sprite.pivotY = state.pivotY;
    var xInput = document.getElementById('holdX');
    var yInput = document.getElementById('holdY');
    var pivotXInput = document.getElementById('pivotX');
    var pivotYInput = document.getElementById('pivotY');
    if (xInput) xInput.value = String(state.holdX);
    if (yInput) yInput.value = String(state.holdY);
    if (pivotXInput) pivotXInput.value = String(state.pivotX);
    if (pivotYInput) pivotYInput.value = String(state.pivotY);
    sampledBackgroundPoint = state.sampledBackgroundPoint
      ? {
          x: Math.min(canvas.width - 1, Math.max(0, Math.round(state.sampledBackgroundPoint.x))),
          y: Math.min(canvas.height - 1, Math.max(0, Math.round(state.sampledBackgroundPoint.y)))
        }
      : null;
  }

  function pushUndoState(state) {
    if (!state) return;
    editGeneration++;
    undoStack.push(state);
    if (undoStack.length > maxHistory) undoStack.shift();
    redoStack = [];
    trimHistoryToBudget();
    refreshAppliedActionButtons();
    updateDirtyIndicator();
  }

  function historyStateBytes(state) {
    return state && state.imageData && state.imageData.data
      ? state.imageData.data.byteLength
      : 0;
  }

  function trimHistoryToBudget() {
    var totalBytes = undoStack.concat(redoStack).reduce(function (sum, state) {
      return sum + historyStateBytes(state);
    }, 0);
    while (totalBytes > MAX_HISTORY_BYTES && undoStack.length + redoStack.length > 1) {
      var removed = undoStack.length > 0 ? undoStack.shift() : redoStack.shift();
      totalBytes -= historyStateBytes(removed);
    }
  }

  function refreshAppliedActionButtons() {
    var edgeButton = document.getElementById('apply-edge-cleanup');
    var backgroundButton = document.getElementById('apply-background-removal');
    var fringeButton = document.getElementById('apply-fringe-normalize');
    if (edgeButton) edgeButton.disabled = !hasDirtyEdgeCleanupSettings();
    if (backgroundButton) backgroundButton.disabled = !hasDirtyBackgroundRemovalSettings();
    if (fringeButton) fringeButton.disabled = !hasDirtyFringeNormalizeSettings();
  }

  function updateDirtyIndicator() {
    var titleRow = document.querySelector('.sprite-title-row');
    if (!titleRow) return;
    var badge = titleRow.querySelector('.dirty-badge');
    if (isDirty()) {
      if (!badge) titleRow.appendChild(h('span', { class: 'dirty-badge', text: 'Unsaved' }));
    } else if (badge) {
      badge.remove();
    }
  }

  function undo() {
    if (undoStack.length === 0) {
      setStatus('Nothing to undo.');
      return;
    }
    editGeneration++;
    var previous = undoStack.pop();
    var current = cloneState();
    if (current) redoStack.push(current);
    trimHistoryToBudget();
    applyState(previous);
    renderEditor();
    renderOverlay();
    setStatus('Undo.');
  }

  function redo() {
    if (redoStack.length === 0) {
      setStatus('Nothing to redo.');
      return;
    }
    editGeneration++;
    var next = redoStack.pop();
    var current = cloneState();
    if (current) undoStack.push(current);
    if (undoStack.length > maxHistory) undoStack.shift();
    trimHistoryToBudget();
    applyState(next);
    renderEditor();
    renderOverlay();
    setStatus('Redo.');
  }

  function armEyedropper(nextValue) {
    eyedropperArmed = nextValue;
    if (eyedropperArmed) {
      backgroundPickArmed = false;
      setAnchorOnClick = false;
    }
    if (canvas) canvas.style.cursor = eyedropperArmed ? 'copy' : (backgroundPickArmed || setAnchorOnClick ? 'crosshair' : 'default');
  }

  function armBackgroundPick(nextValue) {
    backgroundPickArmed = nextValue;
    if (backgroundPickArmed) {
      eyedropperArmed = false;
      setAnchorOnClick = false;
    }
    if (canvas) canvas.style.cursor = backgroundPickArmed ? 'crosshair' : (eyedropperArmed ? 'copy' : (setAnchorOnClick ? 'crosshair' : 'default'));
  }

  function armAnchorPick(nextValue) {
    setAnchorOnClick = nextValue;
    if (setAnchorOnClick) {
      eyedropperArmed = false;
      backgroundPickArmed = false;
    }
    if (canvas) canvas.style.cursor = setAnchorOnClick ? 'crosshair' : (eyedropperArmed ? 'copy' : (backgroundPickArmed ? 'crosshair' : 'default'));
  }

  function sampleDrawColor(x, y) {
    if (!ctx || !canvas) return;
    var px = ctx.getImageData(x, y, 1, 1).data;
    if (!px || px.length < 3) return;
    var toHex = function (value) {
      return value.toString(16).padStart(2, '0');
    };
    drawColor = '#' + toHex(px[0]) + toHex(px[1]) + toHex(px[2]);
    var colorInput = document.getElementById('draw-color');
    if (colorInput) colorInput.value = drawColor;
    setStatus('Picked color ' + drawColor + '.');
  }

  function readPixelSample(x, y) {
    if (!ctx || !canvas) return null;
    var px = ctx.getImageData(x, y, 1, 1).data;
    if (!px || px.length < 4) return null;
    return { r: px[0], g: px[1], b: px[2], a: px[3] };
  }

  function estimateLocalColorVariance(x, y) {
    if (!ctx || !canvas) return 0;
    var center = readPixelSample(x, y);
    if (!center) return 0;
    var total = 0;
    var count = 0;
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        var nx = x + dx;
        var ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= canvas.width || ny >= canvas.height) continue;
        var sample = readPixelSample(nx, ny);
        if (!sample) continue;
        total += Math.sqrt(colorDistanceSq(center.r, center.g, center.b, sample.r, sample.g, sample.b));
        count += 1;
      }
    }
    return count > 0 ? total / count : 0;
  }

  function autoTuneCleanupFromBackgroundSample(x, y) {
    var sample = readPixelSample(x, y);
    if (!sample) return;
    if (sample.a === 0) {
      sampledBackgroundColor = null;
      sampledBackgroundPoint = null;
      renderEditor();
      setStatus('Background sample ignored: picked pixel is fully transparent.');
      return;
    }
    sampledBackgroundColor = {
      r: sample.r,
      g: sample.g,
      b: sample.b,
      a: sample.a
    };
    sampledBackgroundPoint = { x: x, y: y };
    var variance = estimateLocalColorVariance(x, y);
    var saturation = Math.max(sample.r, sample.g, sample.b) - Math.min(sample.r, sample.g, sample.b);
    backgroundRemovalMethod = 'color-key';
    backgroundTolerance = clampByte(8 + Math.round(variance * 0.7) + Math.round(saturation * 0.06), 16);
    backgroundSoftness = clampByte(6 + Math.round(variance * 0.5) + Math.round((255 - sample.a) * 0.08), 12);
    edgeCleanupMethod = saturation > 22 ? 'matte-neutralize' : 'defringe';
    edgeCleanupAmount = clampPercent(28 + Math.round(saturation * 0.35), 40);
    edgeCleanupAlphaCutoff = clampByte(8 + Math.round((255 - sample.a) * 0.12) + Math.round(variance * 0.15), 14);
    armBackgroundPick(false);
    renderEditor();
    setStatus(
      'Auto-tuned cleanup from background sample at (' +
        x +
        ', ' +
        y +
        ').'
    );
  }

  function bindCanvasDraw() {
    if (!canvas) return;
    canvas.oncontextmenu = function (ev) {
      var px = toPixel(ev);
      if (!px) return;
      ev.preventDefault();
      showContextMenuAt(ev, [
        {
          label: 'Draw here',
          onClick: function () {
            var before = cloneState();
            drawMode = 'draw';
            applyBrush(px.x, px.y);
            var after = cloneState();
            if (statesDiffer(before, after)) pushUndoState(before);
            renderEditor();
            renderOverlay();
          }
        },
        {
          label: 'Erase here',
          onClick: function () {
            var before = cloneState();
            drawMode = 'erase';
            applyBrush(px.x, px.y);
            var after = cloneState();
            if (statesDiffer(before, after)) pushUndoState(before);
            renderEditor();
            renderOverlay();
          }
        },
        {
          label: 'Pick color here',
          onClick: function () {
            sampleDrawColor(px.x, px.y);
          }
        },
        {
          label: 'Use as background sample',
          onClick: function () {
            autoTuneCleanupFromBackgroundSample(px.x, px.y);
          }
        },
        {
          label: 'Set anchor here',
          onClick: function () {
            var before = cloneState();
            if (sprite) {
              sprite.holdX = px.x;
              sprite.holdY = px.y;
            }
            var after = cloneState();
            if (statesDiffer(before, after)) pushUndoState(before);
            renderEditor();
            renderOverlay();
            setStatus('Anchor moved to (' + px.x + ', ' + px.y + ').');
          }
        },
        { label: 'Undo', disabled: undoStack.length === 0, onClick: undo },
        { label: 'Redo', disabled: redoStack.length === 0, onClick: redo }
      ]);
    };
    canvas.onmousedown = function (ev) {
      hideContextMenu();
      if (ev.button !== 0) return;
      var px = toPixel(ev);
      if (!px) return;
      if (eyedropperArmed) {
        sampleDrawColor(px.x, px.y);
        armEyedropper(false);
        renderEditor();
        return;
      }
      if (backgroundPickArmed) {
        autoTuneCleanupFromBackgroundSample(px.x, px.y);
        return;
      }
      if (setAnchorOnClick) {
        var beforeAnchor = cloneState();
        var xInput = document.getElementById('holdX');
        var yInput = document.getElementById('holdY');
        if (xInput) xInput.value = String(px.x);
        if (yInput) yInput.value = String(px.y);
        if (sprite) {
          sprite.holdX = px.x;
          sprite.holdY = px.y;
        }
        var afterAnchor = cloneState();
        if (statesDiffer(beforeAnchor, afterAnchor)) pushUndoState(beforeAnchor);
        armAnchorPick(false);
        renderEditor();
        renderOverlay();
        setStatus('Anchor moved to (' + px.x + ', ' + px.y + ').');
        return;
      }
      strokeSnapshot = cloneState();
      drawing = true;
      applyBrush(px.x, px.y);
      renderOverlay();
    };
    canvas.onmousemove = function (ev) {
      if (!drawing) return;
      var px = toPixel(ev);
      if (!px) return;
      applyBrush(px.x, px.y);
      renderOverlay();
    };
    window.onmouseup = function () {
      if (drawing) {
        var afterStroke = cloneState();
        if (statesDiffer(strokeSnapshot, afterStroke)) pushUndoState(strokeSnapshot);
      }
      drawing = false;
      strokeSnapshot = null;
    };
  }

  function metadataFromForm() {
    if (!sprite) return null;
    var getNum = function (id, fallback) {
      var input = document.getElementById(id);
      var n = Number(input ? input.value : fallback);
      return Number.isFinite(n) ? Math.max(0, Math.round(n)) : fallback;
    };
    var facing = document.getElementById('facing');
    return {
      catalogId: sprite.catalogId || null,
      holdX: getNum('holdX', sprite.holdX || 0),
      holdY: getNum('holdY', sprite.holdY || 0),
      pivotX: getNum('pivotX', sprite.pivotX || 0),
      pivotY: getNum('pivotY', sprite.pivotY || 0),
      frame: getNum('frame', sprite.frame || 0),
      col: getNum('col', sprite.col || 0),
      row: getNum('row', sprite.row || 0),
      facingDirection: facing && facing.value === 'left' ? 'left' : 'right'
    };
  }

  function annotationFromForm() {
    var favorite = !!(
      document.getElementById('favorite') &&
      document.getElementById('favorite').value === 'true'
    );
    var disliked = !!(
      document.getElementById('disliked') &&
      document.getElementById('disliked').value === 'true'
    );
    var comment = document.getElementById('comment') ? document.getElementById('comment').value : '';
    return { favorite: favorite, disliked: disliked, comment: comment };
  }

  function setMutationInFlight(nextValue) {
    mutationInFlight = nextValue;
    var saveControl = document.getElementById('save-current');
    var revertControl = document.getElementById('revert-current');
    if (saveControl) saveControl.disabled = mutationInFlight;
    if (revertControl) revertControl.disabled = mutationInFlight;
  }

  async function saveCurrent() {
    var options = arguments.length > 0 && arguments[0] ? arguments[0] : {};
    if (!sprite) return;
    if (mutationInFlight) {
      setStatus('A save or revert is already in progress.');
      return false;
    }
    setMutationInFlight(true);
    var expectedKey = sprite.key;
    var saveToken = ++saveTokenCounter;
    setStatus('Saving…');
    try {
      var submittedCanvasFingerprint = currentCanvasFingerprint();
      var submittedFingerprint = serializeEditorFingerprint(
        sprite.key,
        currentMetadataSnapshot(),
        currentAnnotationSnapshot(),
        submittedCanvasFingerprint
      );
      var submittedCanvas = h('canvas');
      submittedCanvas.width = canvas.width;
      submittedCanvas.height = canvas.height;
      submittedCanvas.getContext('2d').drawImage(canvas, 0, 0);
      var body = {
        key: sprite.key,
        metadata: metadataFromForm(),
        annotation: annotationFromForm(),
        pngDataUrl: submittedCanvasFingerprint
      };
      var data = await fetchJson('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      // A durable-queue push failure is a GLOBAL concern (not tied to which
      // sprite is currently selected). The stale-token / changed-key guards
      // below return early when the user navigated to another sprite while this
      // save's queue push was still in flight (a push can take seconds), which
      // would otherwise silently drop the failure warning and let the edit be
      // lost when the worktree is discarded. So when the response is stale,
      // surface the failed push here before returning; the non-stale path below
      // reports it with more specific messaging.
      var saveStale = saveToken !== saveTokenCounter || !sprite || sprite.key !== expectedKey;
      if (saveStale && data && data.queue && data.queue.status === 'failed') {
        setStatus(
          '\u26a0 Saved to disk, but the durable queue push FAILED \u2014 this edit is NOT safe across worktrees/sessions yet. Keep this worktree and check the sprite-editor logs.',
          true
        );
      }
      if (saveToken !== saveTokenCounter) return false;
      if (!sprite || sprite.key !== expectedKey) return false;
      // The server persists edits to the durable assets/queue branch and reports
      // the outcome in data.queue ({status:'ok'|'skipped'|'failed'}). A 'failed'
      // push means the on-disk write is fine but the edit is NOT yet durable
      // across worktrees/sessions — surface it loudly so the worktree isn't
      // discarded and the edit lost. Annotation-only saves have no queue field.
      var queue = data && data.queue ? data.queue : null;
      var queueFailed = !!queue && queue.status === 'failed';
      if (currentEditorFingerprint() !== submittedFingerprint) {
        var savedSprite = data && data.sprite ? data.sprite : sprite;
        var savedBaselineFingerprint = editorFingerprintForSprite(
          savedSprite,
          submittedCanvasFingerprint
        );
        baselineFingerprint = savedBaselineFingerprint ?? submittedFingerprint;
        captureLastSavedSnapshot(submittedCanvas);
        updateDirtyIndicator();
        setStatus(
          'Saved submitted state; newer edits remain unsaved.' +
            (queueFailed
              ? ' \u26a0 Durable queue push FAILED \u2014 keep this worktree; the edit is not yet safe across sessions.'
              : ''),
          queueFailed
        );
        return false;
      }
      sprite = data.sprite || sprite;
      captureLastSavedSnapshot();
      renderEditor({ skipDraftPersist: true });
      resetBaseline();
      if (options.refreshList !== false) {
        await loadList({
          skipDirtyGuard: true,
          expectedFingerprint: currentEditorFingerprint()
        });
      }
      if (queueFailed) {
        setStatus(
          '\u26a0 Saved to disk, but the durable queue push FAILED \u2014 this edit is NOT safe across worktrees/sessions yet. Keep this worktree and check the sprite-editor logs.',
          true
        );
      } else if (queue && queue.status === 'ok') {
        setStatus('Saved to disk and queued for durable persistence.');
      } else {
        setStatus('Saved to disk.');
      }
      return true;
    } catch (error) {
      setStatus(error.message || String(error), true);
      return false;
    } finally {
      setMutationInFlight(false);
    }
  }

  async function revertCurrent() {
    if (!sprite) return;
    if (mutationInFlight) {
      setStatus('A save or revert is already in progress.');
      return;
    }
    if (!confirm('Revert this sprite PNG + manifest/catalog metadata to HEAD?')) return;
    setMutationInFlight(true);
    var expectedKey = sprite.key;
    var revertToken = ++revertTokenCounter;
    setStatus('Reverting…');
    try {
      var data = await fetchJson('/api/revert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: sprite.key })
      });
      // A durable-queue push failure is a GLOBAL concern; surface it at EVERY
      // early return (mirrors saveCurrent), or a mid-push navigation silently
      // drops the warning. Unlike save, revert has a SECOND async gap
      // (loadImage) with its own stale-token return, so it must surface at both
      // the stale-token guard AND the post-loadImage guard.
      var revertQueueFailed = !!(data && data.queue && data.queue.status === 'failed');
      var revertFailureMsg =
        '\u26a0 Reverted on disk, but the durable queue push FAILED \u2014 a previously-queued edit may resurface. Keep this worktree and check the sprite-editor logs.';
      var revertStale = revertToken !== revertTokenCounter || !sprite || sprite.key !== expectedKey;
      if (revertStale && revertQueueFailed) {
        setStatus(revertFailureMsg, true);
      }
      if (revertToken !== revertTokenCounter) return;
      if (!sprite || sprite.key !== expectedKey) return;
      sprite = data.sprite || sprite;
      var loadToken = ++loadTokenCounter;
      await loadImage(loadToken, sprite.key, sprite.imageVersion);
      if (loadToken !== loadTokenCounter) {
        // The user switched sprites during loadImage; this early return sits
        // before the terminal report below, so surface a failed push here too.
        if (revertQueueFailed) setStatus(revertFailureMsg, true);
        return;
      }
      renderEditor({ skipDraftPersist: true });
      resetBaseline();
      await loadList({ skipDirtyGuard: true });
      // Revert also re-queues the reverted state onto assets/queue so the hourly
      // reconciler can't resurface the discarded edit. Surface a failed push.
      if (revertQueueFailed) {
        setStatus(revertFailureMsg, true);
      } else {
        setStatus('Reverted to HEAD.');
      }
    } catch (error) {
      setStatus(error.message || String(error), true);
    } finally {
      setMutationInFlight(false);
    }
  }

  function renderAnchorCross() {
    if (!overlayCtx || !showAnchor || !sprite) return;
    var xInput = document.getElementById('holdX');
    var yInput = document.getElementById('holdY');
    var x = Number(xInput ? xInput.value : sprite.holdX || 0);
    var y = Number(yInput ? yInput.value : sprite.holdY || 0);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    overlayCtx.save();
    overlayCtx.strokeStyle = '#22d3ee';
    overlayCtx.lineWidth = 1;
    overlayCtx.beginPath();
    overlayCtx.moveTo(x - 4, y + 0.5);
    overlayCtx.lineTo(x + 4, y + 0.5);
    overlayCtx.moveTo(x + 0.5, y - 4);
    overlayCtx.lineTo(x + 0.5, y + 4);
    overlayCtx.stroke();
    overlayCtx.restore();
  }

  function computeInteriorHoleMask() {
    if (!ctx || !canvas) return null;
    var w = canvas.width;
    var h = canvas.height;
    var data = ctx.getImageData(0, 0, w, h).data;
    var size = w * h;
    var borderSeen = new Uint8Array(size);
    var queue = new Int32Array(size);
    var head = 0;
    var tail = 0;

    function alphaAt(idx) {
      return data[idx * 4 + 3];
    }

    function pushIfTransparent(x, y) {
      var idx = y * w + x;
      if (borderSeen[idx] === 1) return;
      if (alphaAt(idx) !== 0) return;
      borderSeen[idx] = 1;
      queue[tail++] = idx;
    }

    for (var x = 0; x < w; x++) {
      pushIfTransparent(x, 0);
      pushIfTransparent(x, h - 1);
    }
    for (var y = 1; y < h - 1; y++) {
      pushIfTransparent(0, y);
      pushIfTransparent(w - 1, y);
    }

    while (head < tail) {
      var idx = queue[head++];
      var px = idx % w;
      var py = (idx - px) / w;
      if (px > 0) pushIfTransparent(px - 1, py);
      if (px + 1 < w) pushIfTransparent(px + 1, py);
      if (py > 0) pushIfTransparent(px, py - 1);
      if (py + 1 < h) pushIfTransparent(px, py + 1);
    }

    var holes = new Uint8Array(size);
    for (var i = 0; i < size; i++) {
      holes[i] = alphaAt(i) === 0 && borderSeen[i] === 0 ? 1 : 0;
    }
    return { holes: holes, w: w, h: h };
  }

  function renderHoleOverlay() {
    if (!overlayCtx || !showHoleOverlay) return;
    var mask = computeInteriorHoleMask();
    if (!mask) return;
    overlayCtx.save();
    overlayCtx.fillStyle = 'rgba(255, 0, 128, 0.55)';
    var found = 0;
    for (var i = 0; i < mask.holes.length; i++) {
      if (mask.holes[i] !== 1) continue;
      found += 1;
      var x = i % mask.w;
      var y = (i - x) / mask.w;
      overlayCtx.fillRect(x, y, 1, 1);
    }
    overlayCtx.restore();
    if (found > 0) {
      setStatus('Highlighted ' + found + ' interior transparent pixels.');
    }
  }

  function renderOverlay() {
    if (!overlayCtx || !overlayCanvas) return;
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    renderHoleOverlay();
    renderAnchorCross();
  }

  function fieldNum(id, label, value, onChange) {
    var wrap = h('div', { class: 'field' }, [h('label', { for: id, text: label })]);
    var input = h('input', { id: id, type: 'number', min: '0', value: String(value == null ? 0 : value) });
    input.addEventListener('change', function () {
      if (typeof onChange === 'function') {
        onChange();
        return;
      }
      renderOverlay();
    });
    wrap.appendChild(input);
    return wrap;
  }

  function activateEditorTool(toolId) {
    if (toolId === activeEditorTool) return;
    previousEditorTool = activeEditorTool;
    activeEditorTool = toolId;
  }

  function labeledControl(label, control, wide) {
    return h('label', { class: 'control-group' + (wide ? ' wide' : '') }, [
      h('span', { class: 'control-label', text: label }),
      control
    ]);
  }

  function editorToolButton(toolId, icon, label, shortcut) {
    var selected = activeEditorTool === toolId;
    var button = h(
      'button',
      {
        id: 'tool-' + toolId,
        type: 'button',
        class: 'tool-tab' + (selected ? ' on' : ''),
        title: label + ' (' + shortcut + ')',
        'aria-pressed': selected ? 'true' : 'false'
      },
      [
        h('span', { class: 'tool-icon', 'aria-hidden': 'true', text: icon }),
        h('span', { text: label })
      ]
    );
    button.addEventListener('click', function () {
      activateEditorTool(toolId);
      renderEditor();
    });
    return button;
  }

  function updateVisualReviewProbe() {
    function region(id, selector, kind, parentId) {
      var element = document.querySelector(selector);
      if (!element) return null;
      var box = element.getBoundingClientRect();
      return {
        id: id,
        kind: kind,
        parentId: parentId || null,
        box: { x: box.x, y: box.y, width: box.width, height: box.height }
      };
    }
    var regions = [
      region('app-bar', '.app-bar', 'panel'),
      region('tool-rail', '.tool-rail', 'panel'),
      region('quick-actions', '.quick-bar', 'panel'),
      region('tool-options', '.tool-panel', 'panel'),
      region('canvas', '.canvas-wrap', 'panel'),
      region('metadata', '.metadata-panel', 'panel')
    ].filter(Boolean);
    var appendControls = function (selector, prefix, parentId) {
      var controls = document.querySelectorAll(selector);
      for (var i = 0; i < controls.length; i++) {
        var box = controls[i].getBoundingClientRect();
        regions.push({
          id: prefix + '-' + String(i + 1),
          kind: 'slot',
          parentId: parentId,
          box: { x: box.x, y: box.y, width: box.width, height: box.height }
        });
      }
    };
    appendControls('.tool-rail .tool-tab', 'tool', 'tool-rail');
    appendControls('.quick-bar button', 'quick-action', 'quick-actions');
    appendControls('.app-actions button', 'app-action', 'app-bar');
    window.__visualReview = {
      surface: 'sprite-editor',
      regions: regions,
      flags: [],
      expect: {
        tooltipAfterHover: false,
        statLabelsHumanReadable: true,
        sectionDividers: true
      }
    };
  }

  function renderEditor(options) {
    if (!editorEl) return;
    var renderOptions = options || {};
    if (!renderOptions.skipDraftPersist) persistFormDraftToSprite();
    var focusedId =
      document.activeElement && editorEl.contains(document.activeElement)
        ? document.activeElement.id
        : '';
    var previousCanvasWrap = editorEl.querySelector('[data-canvas-wrap]');
    var canvasScrollLeft = previousCanvasWrap ? previousCanvasWrap.scrollLeft : 0;
    var canvasScrollTop = previousCanvasWrap ? previousCanvasWrap.scrollTop : 0;
    editorEl.replaceChildren();
    if (!sprite) {
      editorEl.appendChild(h('div', { class: 'muted', text: 'Select a sprite to edit.' }));
      return;
    }

    var brushInput = h('input', { id: 'brush-size', type: 'number', min: '1', max: '8', value: String(brushSize) });
    brushInput.addEventListener('change', function () {
      var n = Number(brushInput.value);
      brushSize = Number.isFinite(n) ? Math.max(1, Math.min(8, Math.round(n))) : 1;
      brushInput.value = String(brushSize);
    });

    var zoomInput = h('input', {
      id: 'zoom-level',
      type: 'number',
      'aria-label': 'Zoom level',
      min: String(ZOOM_MIN),
      max: String(ZOOM_MAX),
      step: String(ZOOM_STEP),
      value: String(pixelScale)
    });
    zoomInput.addEventListener('change', function () {
      pixelScale = clampPixelScale(zoomInput.value);
      zoomInput.value = String(pixelScale);
      applyZoomScale();
    });
    var zoomFitBtn = h('button', { type: 'button', text: 'Fit', title: 'Zoom to fit' });

    var modeToggleBtn = h(
      'button',
      {
        id: 'draw-mode-toggle',
        type: 'button',
        class: 'tool-btn icon-btn',
        text: drawMode === 'draw' ? '✏️' : '⌫',
        title: drawMode === 'draw' ? 'Draw mode (pencil)' : 'Erase mode (eraser)',
        'aria-label': drawMode === 'draw' ? 'Draw mode' : 'Erase mode'
      },
      []
    );
    modeToggleBtn.addEventListener('click', function () {
      drawMode = drawMode === 'draw' ? 'erase' : 'draw';
      renderEditor();
    });

    var colorInput = h('input', {
      id: 'draw-color',
      type: 'color',
      value: drawColor,
      'aria-label': 'Draw color'
    });
    colorInput.addEventListener('change', function () {
      drawColor = colorInput.value || '#ff00ff';
    });
    var scaleFactorInput = h('input', {
      id: 'scale-factor',
      type: 'number',
      min: String(SCALE_FACTOR_MIN),
      max: String(SCALE_FACTOR_MAX),
      step: '0.25',
      value: String(scaleFactor),
    });
    scaleFactorInput.addEventListener('change', function () {
      scaleFactor = clampScaleFactor(scaleFactorInput.value);
      scaleFactorInput.value = String(scaleFactor);
      renderEditor();
    });
    var scaleMethodSelect = h('select', { id: 'scale-method' });
    for (var methodIdx = 0; methodIdx < SCALE_METHODS.length; methodIdx++) {
      var option = SCALE_METHODS[methodIdx];
      scaleMethodSelect.appendChild(h('option', { value: option.id, text: option.label }));
    }
    scaleMethodSelect.value = scaleMethod;
    scaleMethodSelect.addEventListener('change', function () {
      scaleMethod = scaleMethodSelect.value;
      renderEditor();
    });
    var scaleDirty = hasDirtyScaleSettings();
    var applyScaleBtn = h(
      'button',
      { id: 'apply-scale', type: 'button', class: 'apply-action' },
      [
        h('span', { class: 'scale-btn-label' }, [
          h('span', { class: 'inline-spinner' + (scaleInFlight ? '' : ' hidden') }),
          h('span', { text: scaleInFlight ? 'Scaling…' : 'Scale' })
        ])
      ]
    );
    applyScaleBtn.disabled = scaleInFlight || !scaleDirty;
    applyScaleBtn.addEventListener('click', function () {
      applyScaleTransform();
    });
    var eyedropperBtn = h(
      'button',
      {
        id: 'eyedropper-toggle',
        type: 'button',
        class: 'tool-btn icon-btn' + (eyedropperArmed ? ' on' : ''),
        text: '💧',
        title: eyedropperArmed ? 'Eyedropper active' : 'Eyedropper',
        'aria-label': eyedropperArmed ? 'Eyedropper active' : 'Eyedropper'
      },
      []
    );
    eyedropperBtn.addEventListener('click', function () {
      armEyedropper(!eyedropperArmed);
      if (eyedropperArmed) setStatus('Click a pixel to sample color.');
      renderEditor();
    });
    var edgeCleanupMethodSelect = h('select', { id: 'edge-cleanup-method' });
    var edgeCleanupMethods = [
      { id: 'defringe', label: 'Defringe' },
      { id: 'alpha-threshold', label: 'Alpha threshold' },
      { id: 'matte-neutralize', label: 'Matte neutralize' }
    ];
    for (var edgeIdx = 0; edgeIdx < edgeCleanupMethods.length; edgeIdx++) {
      var edgeOption = edgeCleanupMethods[edgeIdx];
      edgeCleanupMethodSelect.appendChild(h('option', { value: edgeOption.id, text: edgeOption.label }));
    }
    edgeCleanupMethodSelect.value = edgeCleanupMethod;
    edgeCleanupMethodSelect.title = 'Choose how edge cleanup fixes halos: defringe borrows nearby opaque colors, alpha threshold removes faint pixels, matte neutralize removes background-colored spill from semi-transparent edges.';
    edgeCleanupMethodSelect.addEventListener('change', function () {
      edgeCleanupMethod = edgeCleanupMethodSelect.value;
      renderEditor();
    });
    var edgeCleanupAmountInput = h('input', {
      id: 'edge-cleanup-amount',
      type: 'number',
      min: '0',
      max: '100',
      step: '1',
      value: String(edgeCleanupAmount)
    });
    edgeCleanupAmountInput.title = 'Cleanup strength from 0-100. Higher values replace more fringe color along translucent edges.';
    edgeCleanupAmountInput.addEventListener('change', function () {
      edgeCleanupAmount = clampPercent(edgeCleanupAmountInput.value, 60);
      renderEditor();
    });
    var edgeCleanupAlphaInput = h('input', {
      id: 'edge-cleanup-alpha',
      type: 'number',
      min: '0',
      max: '255',
      step: '1',
      value: String(edgeCleanupAlphaCutoff)
    });
    edgeCleanupAlphaInput.title = 'Alpha cutoff used by threshold-based cleanup and neighbor selection. Higher values treat more faint edge pixels as removable fringe.';
    edgeCleanupAlphaInput.addEventListener('change', function () {
      edgeCleanupAlphaCutoff = clampByte(edgeCleanupAlphaInput.value, 24);
      renderEditor();
    });
    var edgeCleanupDirty = hasDirtyEdgeCleanupSettings();
    var edgeCleanupBtn = h('button', {
      id: 'apply-edge-cleanup',
      type: 'button',
      class: 'apply-action',
      text: 'Edge cleanup',
      title: 'Defringe borrows nearby opaque color; matte neutralize removes colored spill; alpha threshold drops faint halo pixels.'
    });
    edgeCleanupBtn.disabled = !edgeCleanupDirty;
    edgeCleanupBtn.addEventListener('click', applyEdgeCleanup);
    var backgroundRemovalMethodSelect = h('select', { id: 'background-removal-method' });
    var backgroundRemovalMethods = [
      { id: 'color-key', label: 'Color key' },
      { id: 'flood-fill', label: 'Flood-fill corners' },
      { id: 'alpha-threshold', label: 'Alpha threshold' }
    ];
    for (var bgIdx = 0; bgIdx < backgroundRemovalMethods.length; bgIdx++) {
      var bgOption = backgroundRemovalMethods[bgIdx];
      backgroundRemovalMethodSelect.appendChild(h('option', { value: bgOption.id, text: bgOption.label }));
    }
    backgroundRemovalMethodSelect.value = backgroundRemovalMethod;
    backgroundRemovalMethodSelect.title = 'Choose how background removal identifies removable pixels: color key matches a background color, flood-fill expands inward from corners, alpha threshold removes low-alpha pixels.';
    backgroundRemovalMethodSelect.addEventListener('change', function () {
      backgroundRemovalMethod = backgroundRemovalMethodSelect.value;
      renderEditor();
    });
    var backgroundToleranceInput = h('input', {
      id: 'background-removal-tolerance',
      type: 'number',
      min: '0',
      max: '255',
      step: '1',
      value: String(backgroundTolerance)
    });
    backgroundToleranceInput.title = 'Color tolerance around the sampled/background color. Higher values remove a broader range of similar colors.';
    backgroundToleranceInput.addEventListener('change', function () {
      backgroundTolerance = clampByte(backgroundToleranceInput.value, 36);
      renderEditor();
    });
    var backgroundSoftnessInput = h('input', {
      id: 'background-removal-softness',
      type: 'number',
      min: '0',
      max: '255',
      step: '1',
      value: String(backgroundSoftness)
    });
    backgroundSoftnessInput.title = 'Soft transition width near the tolerance boundary. Higher values preserve smoother semi-transparent edges.';
    backgroundSoftnessInput.addEventListener('change', function () {
      backgroundSoftness = clampByte(backgroundSoftnessInput.value, 24);
      renderEditor();
    });
    var backgroundRemovalDirty = hasDirtyBackgroundRemovalSettings();
    var backgroundRemovalBtn = h('button', {
      id: 'apply-background-removal',
      type: 'button',
      class: 'apply-action',
      text: 'Remove BG',
      title: 'Tolerance widens the match, softness feathers the edge, and Pick background auto-tunes both tool groups from one sampled pixel.'
    });
    backgroundRemovalBtn.disabled = !backgroundRemovalDirty;
    backgroundRemovalBtn.addEventListener('click', applyBackgroundRemoval);
    var pickBackgroundBtn = h(
      'button',
      {
        id: 'background-picker-panel',
        type: 'button',
        class: 'tool-btn' + (backgroundPickArmed ? ' on' : ''),
        text: backgroundPickArmed ? 'Picking background…' : 'Pick background',
        title: 'Click a known background pixel on the sprite to auto-tune both background removal and edge cleanup settings.',
        'aria-pressed': backgroundPickArmed ? 'true' : 'false'
      },
      []
    );
    pickBackgroundBtn.addEventListener('click', function () {
      armBackgroundPick(!backgroundPickArmed);
      if (backgroundPickArmed) setStatus('Click a background pixel to auto-tune cleanup settings.');
      renderEditor();
    });
    var fringeNormalizeMethodSelect = h('select', { id: 'fringe-normalize-method' });
    var fringeNormalizeMethods = [
      { id: 'opaque-average', label: 'Opaque average' },
      { id: 'majority-neighbor', label: 'Majority neighbor' },
      { id: 'despill', label: 'Despill from background' }
    ];
    for (var fringeIdx = 0; fringeIdx < fringeNormalizeMethods.length; fringeIdx++) {
      var fringeOption = fringeNormalizeMethods[fringeIdx];
      fringeNormalizeMethodSelect.appendChild(h('option', { value: fringeOption.id, text: fringeOption.label }));
    }
    fringeNormalizeMethodSelect.value = fringeNormalizeMethod;
    fringeNormalizeMethodSelect.title = 'Choose how fringe colors snap back onto the sprite palette: average nearby solid pixels, snap to the dominant neighbor, or push colors away from the sampled background.';
    fringeNormalizeMethodSelect.addEventListener('change', function () {
      fringeNormalizeMethod = fringeNormalizeMethodSelect.value;
      renderEditor();
    });
    var fringeNormalizeStrengthInput = h('input', {
      id: 'fringe-normalize-strength',
      type: 'number',
      min: '0',
      max: '100',
      step: '1',
      value: String(fringeNormalizeStrength)
    });
    fringeNormalizeStrengthInput.title = 'How strongly to snap fringe pixels toward the chosen replacement color. Higher values are more aggressive.';
    fringeNormalizeStrengthInput.addEventListener('change', function () {
      fringeNormalizeStrength = clampPercent(fringeNormalizeStrengthInput.value, 70);
      renderEditor();
    });
    var fringeNormalizeThresholdInput = h('input', {
      id: 'fringe-normalize-threshold',
      type: 'number',
      min: '0',
      max: '255',
      step: '1',
      value: String(fringeNormalizeThreshold)
    });
    fringeNormalizeThresholdInput.title = 'How close a fringe pixel must be to the sampled/background color before the normalizer touches it.';
    fringeNormalizeThresholdInput.addEventListener('change', function () {
      fringeNormalizeThreshold = clampByte(fringeNormalizeThresholdInput.value, 28);
      renderEditor();
    });
    var fringeNormalizeDirty = hasDirtyFringeNormalizeSettings();
    var fringeNormalizeBtn = h('button', {
      id: 'apply-fringe-normalize',
      type: 'button',
      class: 'apply-action',
      text: 'Normalize fringe',
      title: 'Fringe-only palette snap: touches edge pixels near transparency/background color without recoloring the sprite interior.'
    });
    fringeNormalizeBtn.disabled = !fringeNormalizeDirty;
    fringeNormalizeBtn.addEventListener('click', applyFringeNormalize);

    var saveBtn = h(
      'button',
      { id: 'save-current', type: 'button', class: 'primary-action' },
      ['Save']
    );
    saveBtn.disabled = mutationInFlight;
    saveBtn.addEventListener('click', saveCurrent);
    var revertBtn = h(
      'button',
      { id: 'revert-current', type: 'button', class: 'danger-action' },
      ['Revert']
    );
    revertBtn.disabled = mutationInFlight;
    revertBtn.title = 'Revert PNG and metadata to HEAD';
    revertBtn.addEventListener('click', revertCurrent);
    var undoBtn = h('button', { id: 'undo-edit', type: 'button', text: 'Undo' });
    undoBtn.disabled = undoStack.length === 0;
    undoBtn.addEventListener('click', undo);
    var redoBtn = h('button', { id: 'redo-edit', type: 'button', text: 'Redo' });
    redoBtn.disabled = redoStack.length === 0;
    redoBtn.addEventListener('click', redo);

    var toggleAnchorBtn = h(
      'button',
      {
        id: 'anchor-overlay-toggle',
        type: 'button',
        class: 'tool-btn' + (showAnchor ? ' on' : ''),
        text: 'Anchor +',
        title: showAnchor ? 'Hide anchor overlay' : 'Show anchor overlay',
        'aria-pressed': showAnchor ? 'true' : 'false'
      },
      []
    );
    toggleAnchorBtn.addEventListener('click', function () {
      showAnchor = !showAnchor;
      renderEditor();
      renderOverlay();
    });

    var clickAnchorBtn = h('button', {
      id: 'anchor-picker-panel',
      type: 'button',
      class: 'tool-btn' + (setAnchorOnClick ? ' on' : ''),
      text: setAnchorOnClick ? 'Click target active' : 'Set anchor by click',
      'aria-pressed': setAnchorOnClick ? 'true' : 'false'
    });
    clickAnchorBtn.addEventListener('click', function () {
      armAnchorPick(!setAnchorOnClick);
      renderEditor();
    });

    var holeBtn = h('button', {
      id: 'hole-overlay-toggle',
      type: 'button',
      text: showHoleOverlay ? 'Hide hole overlay' : 'Show hole overlay',
    });
    holeBtn.addEventListener('click', function () {
      showHoleOverlay = !showHoleOverlay;
      renderEditor();
      renderOverlay();
    });

    var hasVariants = Number(sprite.variantCount || 0) > 1;
    var prevVariantBtn = h('button', { type: 'button', text: '←', title: 'Previous variant', 'aria-label': 'Previous variant' });
    prevVariantBtn.disabled = !hasVariants || !sprite.prevVariantKey;
    prevVariantBtn.addEventListener('click', function () {
      if (!sprite || !sprite.prevVariantKey) return;
      loadSprite(sprite.prevVariantKey);
    });
    var nextVariantBtn = h('button', { type: 'button', text: '→', title: 'Next variant', 'aria-label': 'Next variant' });
    nextVariantBtn.disabled = !hasVariants || !sprite.nextVariantKey;
    nextVariantBtn.addEventListener('click', function () {
      if (!sprite || !sprite.nextVariantKey) return;
      loadSprite(sprite.nextVariantKey);
    });

    var editorDirty = isDirty();
    var identityDetails = [
      h('span', { class: 'muted sprite-path', text: sprite.key + ' · ' + sprite.assetPath })
    ];
    if (hasVariants) {
      identityDetails.push(
        h('span', {
          class: 'muted',
          text: 'Variant ' + String(sprite.variantPosition || 1) + ' of ' + String(sprite.variantCount || 1)
        })
      );
    }
    var appBar = h('div', { class: 'app-bar' }, [
      h('div', { class: 'sprite-identity' }, [
        h('div', { class: 'sprite-title-row' }, [
          h('strong', { class: 'sprite-title', text: sprite.label }),
          sprite.favorite ? h('span', { class: 'heart', text: '♥' }) : null,
          editorDirty ? h('span', { class: 'dirty-badge', text: 'Unsaved' }) : null
        ]),
        h('div', { class: 'row' }, identityDetails)
      ]),
      h('div', { class: 'app-actions' }, [
        prevVariantBtn,
        nextVariantBtn,
        h('span', { class: 'toolbar-divider', 'aria-hidden': 'true' }),
        undoBtn,
        redoBtn,
        h('span', { class: 'toolbar-divider', 'aria-hidden': 'true' }),
        saveBtn,
        revertBtn
      ])
    ]);

    var backgroundQuickBtn = h('button', {
      id: 'background-picker-quick',
      type: 'button',
      class: 'tool-btn icon-btn' + (backgroundPickArmed ? ' on' : ''),
      text: '◉',
      title: backgroundPickArmed ? 'Background picker active' : 'Pick background',
      'aria-label': backgroundPickArmed ? 'Background picker active' : 'Pick background',
      'aria-pressed': backgroundPickArmed ? 'true' : 'false'
    });
    backgroundQuickBtn.addEventListener('click', function () {
      armBackgroundPick(!backgroundPickArmed);
      if (backgroundPickArmed) setStatus('Click a background pixel to auto-tune cleanup settings.');
      renderEditor();
    });
    var anchorQuickBtn = h('button', {
      id: 'anchor-picker-quick',
      type: 'button',
      class: 'tool-btn icon-btn' + (setAnchorOnClick ? ' on' : ''),
      text: '⌖',
      title: setAnchorOnClick ? 'Anchor picker active' : 'Set anchor by click',
      'aria-label': setAnchorOnClick ? 'Anchor picker active' : 'Set anchor by click',
      'aria-pressed': setAnchorOnClick ? 'true' : 'false'
    });
    anchorQuickBtn.addEventListener('click', function () {
      armAnchorPick(!setAnchorOnClick);
      if (setAnchorOnClick) {
        setStatus('Click the sprite to set its anchor.');
      }
      renderEditor();
    });

    var quickBar = h('div', { class: 'quick-bar', 'aria-label': 'Quick actions' }, [
      h('span', { class: 'control-label', text: 'Zoom' }),
      zoomInput,
      zoomFitBtn,
      h('span', { class: 'toolbar-divider', 'aria-hidden': 'true' }),
      modeToggleBtn,
      colorInput,
      eyedropperBtn,
      backgroundQuickBtn,
      anchorQuickBtn
    ]);

    var toolRail = h('nav', { class: 'tool-rail', 'aria-label': 'Editor tools' }, [
      editorToolButton('draw', '✎', 'Draw', 'D'),
      editorToolButton('scale', '↗', 'Scale', 'S'),
      editorToolButton('edge', '✦', 'Edges', 'E'),
      editorToolButton('background', '◉', 'Remove BG', 'B'),
      editorToolButton('fringe', '◇', 'Fringe', 'F'),
      editorToolButton('anchor', '⌖', 'Anchor', 'A')
    ]);

    var toolPanelTitle = '';
    var toolPanelHint = '';
    var toolOptions = [];
    if (activeEditorTool === 'scale') {
      toolPanelTitle = 'Scale sprite';
      toolPanelHint = 'Resize with pixel-safe or smooth interpolation.';
      toolOptions = [
        labeledControl('Factor', scaleFactorInput),
        labeledControl('Method', scaleMethodSelect, true),
        applyScaleBtn
      ];
    } else if (activeEditorTool === 'edge') {
      toolPanelTitle = 'Edge cleanup';
      toolPanelHint = 'Repair translucent halos without recoloring the interior.';
      toolOptions = [
        labeledControl('Method', edgeCleanupMethodSelect, true),
        labeledControl('Strength', edgeCleanupAmountInput),
        labeledControl('Alpha cutoff', edgeCleanupAlphaInput),
        edgeCleanupBtn
      ];
    } else if (activeEditorTool === 'background') {
      toolPanelTitle = 'Background removal';
      toolPanelHint = sampledBackgroundColor
        ? 'Sample locked at (' + sampledBackgroundPoint.x + ', ' + sampledBackgroundPoint.y + ').'
        : 'Pick a known background pixel first for safer auto-tuning.';
      toolOptions = [
        pickBackgroundBtn,
        labeledControl('Method', backgroundRemovalMethodSelect, true),
        labeledControl('Tolerance', backgroundToleranceInput),
        labeledControl('Softness', backgroundSoftnessInput),
        backgroundRemovalBtn
      ];
    } else if (activeEditorTool === 'fringe') {
      toolPanelTitle = 'Fringe palette';
      toolPanelHint = 'Snap edge colors back toward the sprite palette.';
      toolOptions = [
        labeledControl('Method', fringeNormalizeMethodSelect, true),
        labeledControl('Strength', fringeNormalizeStrengthInput),
        labeledControl('BG distance', fringeNormalizeThresholdInput),
        fringeNormalizeBtn
      ];
    } else if (activeEditorTool === 'anchor') {
      toolPanelTitle = 'Anchor & overlays';
      toolPanelHint = 'Inspect alignment and transparent interior holes.';
      toolOptions = [toggleAnchorBtn, clickAnchorBtn, holeBtn];
    } else {
      toolPanelTitle = drawMode === 'draw' ? 'Draw pixels' : 'Erase pixels';
      toolPanelHint = 'Paint directly on the sprite. Right-click for precise pixel actions.';
      toolOptions = [
        labeledControl('Brush size', brushInput),
        h('span', { class: 'muted', text: 'Mode, color, and sampling stay pinned in Quick actions.' })
      ];
    }
    var toolPanel = h('section', { class: 'tool-panel', 'aria-labelledby': 'active-tool-title' }, [
      h('div', { class: 'tool-panel-header' }, [
        h('span', { id: 'active-tool-title', class: 'tool-panel-title', text: toolPanelTitle }),
        h('span', { class: 'tool-panel-hint', text: toolPanelHint })
      ]),
      h('div', { class: 'tool-options' }, toolOptions)
    ]);

    var canvasWrap = h('div', { class: 'canvas-wrap', 'data-canvas-wrap': 'true' });
    var nativeDimsLabel = h('div', {
      class: 'muted',
      text: canvas
        ? 'Native dimensions: ' + String(canvas.width) + 'x' + String(canvas.height) + ' px'
        : 'Native dimensions: unavailable'
    });
    if (canvas && overlayCanvas) {
      var stage = h('div', { class: 'canvas-stage' }, [canvas, overlayCanvas]);
      var beforeStage = h('div', { class: 'canvas-stage' }, [comparisonBeforeCanvas]);
      var beforePane = h('section', { class: 'comparison-pane', 'aria-label': 'Before edit' }, [
        h('div', { class: 'comparison-pane-head' }, [
          h('span', { class: 'comparison-pane-title', text: 'Before' }),
          h('span', { id: 'comparison-before-label', class: 'muted', text: comparisonActionLabel })
        ]),
        h('div', { class: 'comparison-stage-wrap' }, [beforeStage])
      ]);
      var afterPane = h('section', { class: 'comparison-pane', 'aria-label': 'After edit' }, [
        h('div', { class: 'comparison-pane-head' }, [
          h('span', { class: 'comparison-pane-title', text: 'After' }),
          h('span', { class: 'muted', text: 'Live canvas' })
        ]),
        h('div', { class: 'comparison-stage-wrap' }, [stage])
      ]);
      canvas.style.cursor = eyedropperArmed ? 'copy' : (backgroundPickArmed || setAnchorOnClick ? 'crosshair' : 'default');
      canvasWrap.appendChild(h('div', { class: 'comparison-grid' }, [beforePane, afterPane]));
      canvasWrap.addEventListener(
        'wheel',
        function (ev) {
          if (scaleInFlight) return;
          ev.preventDefault();
          var changed = zoomBy(ev.deltaY < 0 ? ZOOM_WHEEL_STEP : -ZOOM_WHEEL_STEP);
          if (changed) {
            zoomInput.value = String(pixelScale);
          }
        },
        { passive: false }
      );
    } else {
      canvasWrap.appendChild(h('span', { class: 'muted', text: 'Image unavailable.' }));
    }
    zoomFitBtn.addEventListener('click', function () {
      if (zoomToFit(canvasWrap)) {
        zoomInput.value = String(pixelScale);
      }
    });

    var metaGrid = h('div', { class: 'grid' }, [
      fieldNum('holdX', 'Anchor X', sprite.holdX),
      fieldNum('holdY', 'Anchor Y', sprite.holdY),
      fieldNum('pivotX', 'Pivot X', sprite.pivotX),
      fieldNum('pivotY', 'Pivot Y', sprite.pivotY),
      fieldNum('frame', 'Frame', sprite.frame == null ? 0 : sprite.frame),
      fieldNum('col', 'Column', sprite.col == null ? 0 : sprite.col),
      fieldNum('row', 'Row', sprite.row == null ? 0 : sprite.row),
      (function () {
        var wrap = h('div', { class: 'field' }, [h('label', { for: 'facing', text: 'Facing' })]);
        var select = h('select', { id: 'facing' }, [
          h('option', { value: 'right', text: 'right' }),
          h('option', { value: 'left', text: 'left' })
        ]);
        select.value = sprite.facingDirection === 'left' ? 'left' : 'right';
        wrap.appendChild(select);
        return wrap;
      })(),
      (function () {
        var wrap = h('div', { class: 'field' }, [h('label', { text: 'Reaction' })]);
        var favValue = h('input', { id: 'favorite', type: 'hidden', value: sprite.favorite ? 'true' : 'false' });
        var dislikedValue = h('input', { id: 'disliked', type: 'hidden', value: sprite.disliked ? 'true' : 'false' });
        var heartBtn = h(
          'button',
          {
            id: 'favorite-heart',
            type: 'button',
            class: 'heart-btn' + (sprite.favorite ? ' on' : ''),
            'aria-label': 'Like as exemplar',
            'aria-pressed': sprite.favorite ? 'true' : 'false',
            text: sprite.favorite ? '♥' : '♡'
          },
          []
        );
        var dislikeBtn = h(
          'button',
          {
            id: 'dislike-button',
            type: 'button',
            class: 'dislike-btn' + (sprite.disliked ? ' on' : ''),
            'aria-label': 'Dislike and flag for regeneration',
            'aria-pressed': sprite.disliked ? 'true' : 'false',
            title: 'Flag for re-processing or regeneration',
            text: '👎'
          },
          []
        );
        var syncReactionButtons = function (favorite, disliked) {
          heartBtn.setAttribute('aria-pressed', favorite ? 'true' : 'false');
          heartBtn.textContent = favorite ? '♥' : '♡';
          heartBtn.className = 'heart-btn' + (favorite ? ' on' : '');
          dislikeBtn.setAttribute('aria-pressed', disliked ? 'true' : 'false');
          dislikeBtn.className = 'dislike-btn' + (disliked ? ' on' : '');
          favValue.value = favorite ? 'true' : 'false';
          dislikedValue.value = disliked ? 'true' : 'false';
          updateDirtyIndicator();
        };
        heartBtn.addEventListener('click', function () {
          var next = heartBtn.getAttribute('aria-pressed') !== 'true';
          syncReactionButtons(next, false);
        });
        dislikeBtn.addEventListener('click', function () {
          var next = dislikeBtn.getAttribute('aria-pressed') !== 'true';
          syncReactionButtons(false, next);
        });
        wrap.appendChild(
          h('div', { class: 'row' }, [
            heartBtn,
            dislikeBtn,
            h('span', { class: 'muted', text: 'Like as exemplar or flag for regeneration' })
          ])
        );
        wrap.appendChild(favValue);
        wrap.appendChild(dislikedValue);
        return wrap;
      })()
    ]);

    var commentField = h('div', { class: 'field' }, [
      h('label', { for: 'comment', text: 'Comment / Feedback' }),
      h('textarea', { id: 'comment' })
    ]);
    commentField.querySelector('textarea').value = sprite.comment || '';
    commentField.querySelector('textarea').addEventListener('input', updateDirtyIndicator);

    var canvasArea = h('div', { class: 'canvas-area' }, [
      h('div', { class: 'canvas-topline' }, [
        nativeDimsLabel,
        h('span', { class: 'muted', text: 'Wheel to zoom · Right-click for pixel actions' })
      ]),
      canvasWrap
    ]);
    var workspaceShell = h('div', { class: 'workspace-shell' }, [
      toolRail,
      h('div', { class: 'workspace-main' }, [quickBar, toolPanel, canvasArea])
    ]);
    var metadataPanel = h('section', { class: 'metadata-panel', 'aria-labelledby': 'metadata-heading' }, [
      h('div', { class: 'metadata-heading' }, [
        h('strong', { id: 'metadata-heading', text: 'Metadata & annotation' }),
        h('span', { class: 'muted', text: 'Group: ' + (sprite.variantGroup || '-') })
      ]),
      metaGrid,
      commentField
    ]);
    editorEl.append(appBar, workspaceShell, metadataPanel);
    metaGrid.addEventListener('input', updateDirtyIndicator);
    metaGrid.addEventListener('change', updateDirtyIndicator);
    canvasWrap.scrollLeft = canvasScrollLeft;
    canvasWrap.scrollTop = canvasScrollTop;
    var syncAnchorAndPivotFromInputs = function () {
      var before = cloneState();
      if (!sprite) return;
      var xInput = document.getElementById('holdX');
      var yInput = document.getElementById('holdY');
      var pivotXInput = document.getElementById('pivotX');
      var pivotYInput = document.getElementById('pivotY');
      var holdX = Number(xInput ? xInput.value : sprite.holdX || 0);
      var holdY = Number(yInput ? yInput.value : sprite.holdY || 0);
      var pivotX = Number(pivotXInput ? pivotXInput.value : sprite.pivotX || 0);
      var pivotY = Number(pivotYInput ? pivotYInput.value : sprite.pivotY || 0);
      sprite.holdX = Number.isFinite(holdX) ? Math.max(0, Math.round(holdX)) : 0;
      sprite.holdY = Number.isFinite(holdY) ? Math.max(0, Math.round(holdY)) : 0;
      sprite.pivotX = Number.isFinite(pivotX) ? Math.max(0, Math.round(pivotX)) : 0;
      sprite.pivotY = Number.isFinite(pivotY) ? Math.max(0, Math.round(pivotY)) : 0;
      if (xInput) xInput.value = String(sprite.holdX);
      if (yInput) yInput.value = String(sprite.holdY);
      if (pivotXInput) pivotXInput.value = String(sprite.pivotX);
      if (pivotYInput) pivotYInput.value = String(sprite.pivotY);
      var after = cloneState();
      if (statesDiffer(before, after)) pushUndoState(before);
      renderOverlay();
    };
    var holdXField = document.getElementById('holdX');
    var holdYField = document.getElementById('holdY');
    var pivotXField = document.getElementById('pivotX');
    var pivotYField = document.getElementById('pivotY');
    if (holdXField) holdXField.addEventListener('change', syncAnchorAndPivotFromInputs);
    if (holdYField) holdYField.addEventListener('change', syncAnchorAndPivotFromInputs);
    if (pivotXField) pivotXField.addEventListener('change', syncAnchorAndPivotFromInputs);
    if (pivotYField) pivotYField.addEventListener('change', syncAnchorAndPivotFromInputs);
    if (focusedId) {
      var focusTarget = document.getElementById(focusedId);
      if (focusTarget) focusTarget.focus({ preventScroll: true });
    }
    renderOverlay();
    updateVisualReviewProbe();
  }

  function debounce(fn, waitMs) {
    var timer = null;
    return function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(fn, waitMs);
    };
  }

  function init() {
    var top = h('div', { class: 'top' }, [
      h('div', null, [
        h('h1', { text: 'Sprite Editor' }),
        h('div', { class: 'muted', text: 'Local editor for checked-in sprites with metadata + annotation persistence.' })
      ]),
      h('div', { class: 'muted' }, ['Total: ', h('strong', { id: 'total', text: '0' })])
    ]);

    var leftPanel = h('div', { class: 'panel' }, [
      h('div', { class: 'head' }, [
        h('input', { id: 'search', type: 'text', placeholder: 'Search key, brief, path, comment…' }),
        h('button', { id: 'refresh', type: 'button', text: 'Refresh' })
      ]),
      h('div', { class: 'filters' }, [
        (function () {
          var wrap = h('div', { class: 'field' }, [h('label', { text: 'Tags (comma-separated)' })]);
          wrap.appendChild(h('input', { id: 'tags', type: 'text', list: 'tags-list', placeholder: 'enemy, generated' }));
          return wrap;
        })(),
        (function () {
          var wrap = h('div', { class: 'field' }, [h('label', { text: 'Placeholder' })]);
          var select = h('select', { id: 'placeholders' }, [
            h('option', { value: 'all', text: 'all' }),
            h('option', { value: 'only', text: 'only placeholders' }),
            h('option', { value: 'exclude', text: 'exclude placeholders' })
          ]);
          wrap.appendChild(select);
          return wrap;
        })(),
        (function () {
          var wrap = h('div', { class: 'field' }, [h('label', { text: 'Favorites' })]);
          var select = h('select', { id: 'favorites' }, [
            h('option', { value: 'all', text: 'all' }),
            h('option', { value: 'only', text: 'favorites only' })
          ]);
          wrap.appendChild(select);
          return wrap;
        })(),
        h('label', { class: 'chk' }, [
          h('input', { id: 'collapse', type: 'checkbox' }),
          'Collapse variants by sprite group'
        ])
      ]),
      h('div', { class: 'head' }, [h('datalist', { id: 'tags-list' })]),
      h('div', { id: 'list', class: 'list' })
    ]);

    var rightPanel = h('div', { class: 'panel' }, [h('div', { id: 'editor', class: 'editor' })]);
    var layout = h('div', { class: 'layout' }, [leftPanel, rightPanel]);
    var status = h('div', { id: 'status', class: 'status', role: 'status', 'aria-live': 'polite' });

    app.replaceChildren(top, layout, status);

    searchInput = document.getElementById('search');
    listEl = document.getElementById('list');
    editorEl = document.getElementById('editor');
    statusEl = document.getElementById('status');
    totalEl = document.getElementById('total');
    tagsInput = document.getElementById('tags');
    tagsDatalist = document.getElementById('tags-list');
    collapseCheckbox = document.getElementById('collapse');
    placeholdersSelect = document.getElementById('placeholders');
    favoritesSelect = document.getElementById('favorites');

    document.getElementById('refresh').addEventListener('click', loadList);
    searchInput.addEventListener('input', debounce(loadList, 150));
    tagsInput.addEventListener('input', debounce(loadList, 150));
    collapseCheckbox.addEventListener('change', loadList);
    placeholdersSelect.addEventListener('change', loadList);
    favoritesSelect.addEventListener('change', loadList);
    document.addEventListener('click', function () {
      hideContextMenu();
    });
    window.addEventListener('scroll', hideContextMenu, true);
    window.addEventListener('beforeunload', function (ev) {
      if (!isDirty()) return;
      ev.preventDefault();
      ev.returnValue = '';
    });
    document.addEventListener('keydown', function (ev) {
      var target = ev.target;
      var tag = target && target.tagName ? String(target.tagName).toUpperCase() : '';
      if (target && (target.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT')) {
        return;
      }
      if (ev.key === 'Escape') {
        armEyedropper(false);
        armBackgroundPick(false);
        armAnchorPick(false);
        hideContextMenu();
        renderEditor();
        return;
      }
      var key = String(ev.key || '').toLowerCase();
      if (!(ev.ctrlKey || ev.metaKey)) {
        var toolByKey = {
          d: 'draw',
          s: 'scale',
          e: 'edge',
          b: 'background',
          f: 'fringe',
          a: 'anchor'
        };
        if (key === 'q') {
          var swapTool = previousEditorTool;
          previousEditorTool = activeEditorTool;
          activeEditorTool = swapTool;
          renderEditor();
          return;
        }
        if (toolByKey[key]) {
          activateEditorTool(toolByKey[key]);
          renderEditor();
          return;
        }
        return;
      }
      if (key === 'z' && !ev.shiftKey) {
        ev.preventDefault();
        undo();
        return;
      }
      if (key === 'y' || (key === 'z' && ev.shiftKey)) {
        ev.preventDefault();
        redo();
      }
    });
    window.__uiProbe = {
      ready: function () {
        return !!document.querySelector('#tool-draw');
      }
    };
    loadList();
  }

  init();
})();
`;

export function renderHtml(instanceId) {
  const script = CLIENT_SCRIPT.replace(/__INSTANCE__/g, String(instanceId));
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sprite Editor</title>
    <style>${STYLES}</style>
  </head>
  <body>
    <div id="app"></div>
    <script>${script}</script>
  </body>
</html>`;
}
