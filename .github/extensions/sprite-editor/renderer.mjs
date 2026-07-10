const STYLES = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 14px;
    background: var(--background-color-default, #0b1120);
    color: var(--text-color-default, #e2e8f0);
    font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    font-size: var(--text-body-medium, 13px);
    line-height: var(--leading-body-medium, 1.45);
  }
  h1 { margin: 0; font-size: 20px; }
  .muted { color: var(--text-color-muted, #94a3b8); font-size: 12px; }
  .top { display: flex; justify-content: space-between; gap: 10px; align-items: center; margin-bottom: 10px; }
  .layout { display: grid; grid-template-columns: 360px 1fr; gap: 12px; min-height: 520px; }
  .panel {
    border: 1px solid rgba(148,163,184,0.25);
    border-radius: 8px;
    background: #0f172a;
    overflow: hidden;
  }
  .head {
    border-bottom: 1px solid rgba(148,163,184,0.2);
    padding: 8px 10px;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  input, select, button, textarea {
    background: #0b1220;
    color: #e2e8f0;
    border: 1px solid rgba(148,163,184,0.35);
    border-radius: 6px;
    padding: 6px 10px;
    font: inherit;
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
  .heart-btn:hover { transform: translateY(-1px); }
  .heart-btn.on {
    color: #ffe4e6;
    background: linear-gradient(135deg, rgba(251,113,133,0.75), rgba(236,72,153,0.65));
    box-shadow: 0 0 0 2px rgba(251,113,133,0.2), 0 0 18px rgba(251,113,133,0.35);
  }
  .filters { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 8px 10px; border-bottom: 1px solid rgba(148,163,184,0.1); }
  .chk { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: #cbd5e1; }
  .chk input { margin: 0; }
  .editor { padding: 10px; display: flex; flex-direction: column; gap: 10px; }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: space-between;
  }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .canvas-wrap {
    border: 1px solid rgba(148,163,184,0.25);
    background: repeating-conic-gradient(#13213b 0% 25%, #0f1a30 0% 50%) 50% / 12px 12px;
    border-radius: 8px;
    min-height: 220px;
    padding: 10px;
    overflow: auto;
  }
  .canvas-stage { position: relative; display: inline-block; line-height: 0; }
  .sprite-canvas, .overlay-canvas {
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
  .status { min-height: 18px; font-size: 12px; color: #94a3b8; }
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
  var pixelScale = 6;
  var drawMode = 'erase';
  var drawColor = '#ff00ff';
  var showAnchor = true;
  var setAnchorOnClick = false;
  var showHoleOverlay = false;
  var eyedropperArmed = false;
  var undoStack = [];
  var redoStack = [];
  var maxHistory = 60;
  var strokeSnapshot = null;
  var contextMenu = null;
  var baselineFingerprint = null;
  var loadTokenCounter = 0;
  var listTokenCounter = 0;
  var saveTokenCounter = 0;
  var revertTokenCounter = 0;
  var scaleFactor = 1;
  var scaleMethod = 'nearest';
  var openCvReadyPromise = null;

  var SCALE_FACTOR_MIN = 0.25;
  var SCALE_FACTOR_MAX = 8;
  var SCALE_METHODS = [
    { id: 'nearest', label: 'Nearest (pixel-perfect)' },
    { id: 'bilinear', label: 'Bilinear' },
    { id: 'bicubic', label: 'Bicubic' },
    { id: 'area', label: 'Pixel-area (best downscale)' },
    { id: 'lanczos4', label: 'Lanczos4' }
  ];
  var OPENCV_JS_URL = 'https://docs.opencv.org/4.10.0/opencv.js';

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

  function resolveInterpolation(cv, methodId, factor) {
    var id = String(methodId || '').toLowerCase();
    if (id === 'nearest') return cv.INTER_NEAREST_EXACT != null ? cv.INTER_NEAREST_EXACT : cv.INTER_NEAREST;
    if (id === 'bilinear') return cv.INTER_LINEAR_EXACT != null ? cv.INTER_LINEAR_EXACT : cv.INTER_LINEAR;
    if (id === 'bicubic') return cv.INTER_CUBIC;
    if (id === 'area') return factor < 1 ? cv.INTER_AREA : (cv.INTER_LINEAR_EXACT != null ? cv.INTER_LINEAR_EXACT : cv.INTER_LINEAR);
    if (id === 'lanczos4') return cv.INTER_LANCZOS4;
    return cv.INTER_NEAREST_EXACT != null ? cv.INTER_NEAREST_EXACT : cv.INTER_NEAREST;
  }

  function ensureOpenCvReady() {
    if (openCvReadyPromise) return openCvReadyPromise;
    openCvReadyPromise = new Promise(function (resolve, reject) {
      var timeoutId = setTimeout(function () {
        reject(new Error('OpenCV.js timed out while loading.'));
      }, 30000);
      var finalize = function () {
        var cv = window.cv;
        if (!cv) return false;
        if (typeof cv.Mat === 'function') {
          clearTimeout(timeoutId);
          resolve(cv);
          return true;
        }
        var prev = cv.onRuntimeInitialized;
        cv.onRuntimeInitialized = function () {
          if (typeof prev === 'function') prev();
          clearTimeout(timeoutId);
          resolve(window.cv);
        };
        return true;
      };
      if (finalize()) return;
      var existing = document.querySelector('script[data-opencv-js="true"]');
      if (!existing) {
        var script = document.createElement('script');
        script.src = OPENCV_JS_URL;
        script.async = true;
        script.defer = true;
        script.setAttribute('data-opencv-js', 'true');
        script.addEventListener('load', function () {
          if (!finalize()) {
            clearTimeout(timeoutId);
            reject(new Error('OpenCV.js loaded but cv runtime is unavailable.'));
          }
        });
        script.addEventListener('error', function () {
          clearTimeout(timeoutId);
          reject(new Error('Failed to load OpenCV.js.'));
        });
        document.head.appendChild(script);
      } else {
        existing.addEventListener('load', function () {
          if (!finalize()) {
            clearTimeout(timeoutId);
            reject(new Error('OpenCV.js loaded but cv runtime is unavailable.'));
          }
        });
        existing.addEventListener('error', function () {
          clearTimeout(timeoutId);
          reject(new Error('Failed to load OpenCV.js.'));
        });
      }
    });
    return openCvReadyPromise;
  }

  async function applyScaleTransform() {
    if (!canvas || !ctx) return;
    var factor = clampScaleFactor(scaleFactor);
    if (factor === 1) {
      setStatus('Scale factor 1x leaves sprite unchanged.');
      return;
    }
    var nextWidth = Math.max(1, Math.round(canvas.width * factor));
    var nextHeight = Math.max(1, Math.round(canvas.height * factor));
    var before = cloneState();
    setStatus('Scaling sprite via OpenCV.js…');
    try {
      var cv = await ensureOpenCvReady();
      var src = cv.imread(canvas);
      var dst = new cv.Mat();
      var dsize = new cv.Size(nextWidth, nextHeight);
      var interpolation = resolveInterpolation(cv, scaleMethod, factor);
      cv.resize(src, dst, dsize, 0, 0, interpolation);

      var prevData = canvas.toDataURL('image/png');
      var scaledCanvas = document.createElement('canvas');
      cv.imshow(scaledCanvas, dst);
      var scaledDataUrl = scaledCanvas.toDataURL('image/png');
      src.delete();
      dst.delete();

      var img = new Image();
      await new Promise(function (resolve, reject) {
        img.addEventListener('load', resolve);
        img.addEventListener('error', reject);
        img.src = scaledDataUrl;
      });
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      overlayCanvas.width = canvas.width;
      overlayCanvas.height = canvas.height;
      ctx.imageSmoothingEnabled = false;
      overlayCtx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      var w = String(canvas.width * pixelScale) + 'px';
      var hPx = String(canvas.height * pixelScale) + 'px';
      canvas.style.width = w;
      canvas.style.height = hPx;
      overlayCanvas.style.width = w;
      overlayCanvas.style.height = hPx;

      var after = cloneState();
      if (statesDiffer(before, after)) pushUndoState(before);
      renderOverlay();
      setStatus(
        'Scaled from ' +
          String(before.imageData.width) +
          'x' +
          String(before.imageData.height) +
          ' to ' +
          String(canvas.width) +
          'x' +
          String(canvas.height) +
          ' using ' +
          scaleMethod +
          '.',
      );
      if (prevData === scaledDataUrl) setStatus('OpenCV scale completed; output image data unchanged.');
    } catch (error) {
      setStatus(error.message || String(error), true);
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
    var commentInput = document.getElementById('comment');
    return {
      favorite: !!(favoriteInput && favoriteInput.value === 'true'),
      comment: commentInput ? commentInput.value : (sprite && sprite.comment ? String(sprite.comment) : '')
    };
  }

  function persistFormDraftToSprite() {
    if (!sprite || !editorEl) return;
    if (!editorEl.querySelector('#comment')) return;
    var meta = currentMetadataSnapshot();
    var note = currentAnnotationSnapshot();
    if (meta) {
      sprite.holdX = meta.holdX;
      sprite.holdY = meta.holdY;
      sprite.pivotX = meta.pivotX;
      sprite.pivotY = meta.pivotY;
      sprite.frame = meta.frame;
      sprite.col = meta.col;
      sprite.row = meta.row;
      sprite.facingDirection = meta.facingDirection;
    }
    sprite.favorite = note.favorite;
    sprite.comment = note.comment;
  }

  function currentEditorFingerprint() {
    if (!sprite) return null;
    return JSON.stringify({
      key: sprite.key,
      metadata: currentMetadataSnapshot(),
      annotation: currentAnnotationSnapshot(),
      pngDataUrl: canvasToPngDataUrl()
    });
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
      sprites = data.sprites || [];
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
                try {
                  var dirtyDecision = await confirmLeaveIfDirty();
                  if (dirtyDecision.status === 'save_failed' || dirtyDecision.status === 'cancelled') return;
                  await fetchJson('/api/save', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      key: item.key,
                      annotation: { favorite: !item.favorite, comment: item.comment || '' }
                    })
                  });
                  await loadList({ skipDirtyGuard: true });
                  setStatus((!item.favorite ? 'Marked' : 'Unmarked') + ' favorite.');
                } catch (error) {
                  setStatus(error.message || String(error), true);
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
    var loadToken = ++loadTokenCounter;
    setStatus('Loading sprite…');
    try {
      var data = await fetchJson('/api/sprite?key=' + encodeURIComponent(key));
      if (loadToken !== loadTokenCounter) return false;
      sprite = data.sprite || null;
      if (!sprite) {
        renderEditor();
        setStatus('Sprite not found.', true);
        return false;
      }
      await loadImage(loadToken);
      if (loadToken !== loadTokenCounter) return false;
      renderEditor();
      resetBaseline();
      if (opts.updateSelection !== false) {
        selectedKey = sprite.key;
        selectedVariantGroup = sprite.variantGroup || null;
        renderList();
      }
      setStatus('Ready.');
      return true;
    } catch (error) {
      setStatus(error.message || String(error), true);
      return false;
    }
  }

  function canvasToPngDataUrl() {
    if (!canvas) return null;
    return canvas.toDataURL('image/png');
  }

  async function loadImage(loadToken) {
    if (!sprite) return;
    var img = new Image();
    img.src = '/img/sprite?key=' + encodeURIComponent(sprite.key) + '&_ts=' + Date.now();
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
    var w = String(canvas.width * pixelScale) + 'px';
    var hPx = String(canvas.height * pixelScale) + 'px';
    canvas.style.width = w;
    canvas.style.height = hPx;
    overlayCanvas.style.width = w;
    overlayCanvas.style.height = hPx;
    ctx = canvas.getContext('2d', { willReadFrequently: true });
    overlayCtx = overlayCanvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;
    overlayCtx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0);
    undoStack = [];
    redoStack = [];
    strokeSnapshot = null;
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

  function applyBrush(x, y) {
    if (!ctx || !canvas) return;
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
      holdY: sprite ? Number(sprite.holdY || 0) : 0
    };
  }

  function statesDiffer(a, b) {
    if (!a || !b) return false;
    if (a.holdX !== b.holdX || a.holdY !== b.holdY) return true;
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
    ctx.putImageData(state.imageData, 0, 0);
    sprite.holdX = state.holdX;
    sprite.holdY = state.holdY;
    var xInput = document.getElementById('holdX');
    var yInput = document.getElementById('holdY');
    if (xInput) xInput.value = String(state.holdX);
    if (yInput) yInput.value = String(state.holdY);
  }

  function pushUndoState(state) {
    if (!state) return;
    undoStack.push(state);
    if (undoStack.length > maxHistory) undoStack.shift();
    redoStack = [];
  }

  function undo() {
    if (undoStack.length === 0) {
      setStatus('Nothing to undo.');
      return;
    }
    var previous = undoStack.pop();
    var current = cloneState();
    if (current) redoStack.push(current);
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
    var next = redoStack.pop();
    var current = cloneState();
    if (current) undoStack.push(current);
    applyState(next);
    renderEditor();
    renderOverlay();
    setStatus('Redo.');
  }

  function armEyedropper(nextValue) {
    eyedropperArmed = nextValue;
    if (canvas) canvas.style.cursor = eyedropperArmed ? 'copy' : (setAnchorOnClick ? 'crosshair' : 'default');
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
        setAnchorOnClick = false;
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
    var comment = document.getElementById('comment') ? document.getElementById('comment').value : '';
    return { favorite: favorite, comment: comment };
  }

  async function saveCurrent() {
    var options = arguments.length > 0 && arguments[0] ? arguments[0] : {};
    if (!sprite) return;
    var expectedKey = sprite.key;
    var saveToken = ++saveTokenCounter;
    setStatus('Saving…');
    try {
      var body = {
        key: sprite.key,
        metadata: metadataFromForm(),
        annotation: annotationFromForm(),
        pngDataUrl: canvasToPngDataUrl()
      };
      var data = await fetchJson('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (saveToken !== saveTokenCounter) return false;
      if (!sprite || sprite.key !== expectedKey) return false;
      sprite = data.sprite || sprite;
      renderEditor();
      resetBaseline();
      if (options.refreshList !== false) await loadList({ skipDirtyGuard: true });
      setStatus('Saved to disk.');
      return true;
    } catch (error) {
      setStatus(error.message || String(error), true);
      return false;
    }
  }

  async function revertCurrent() {
    if (!sprite) return;
    if (!confirm('Revert this sprite PNG + manifest/catalog metadata to HEAD?')) return;
    var expectedKey = sprite.key;
    var revertToken = ++revertTokenCounter;
    setStatus('Reverting…');
    try {
      var data = await fetchJson('/api/revert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: sprite.key })
      });
      if (revertToken !== revertTokenCounter) return;
      if (!sprite || sprite.key !== expectedKey) return;
      sprite = data.sprite || sprite;
      var loadToken = ++loadTokenCounter;
      await loadImage(loadToken);
      if (loadToken !== loadTokenCounter) return;
      renderEditor();
      resetBaseline();
      await loadList({ skipDirtyGuard: true });
      setStatus('Reverted to HEAD.');
    } catch (error) {
      setStatus(error.message || String(error), true);
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
    var wrap = h('div', { class: 'field' }, [h('label', { text: label })]);
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

  function renderEditor() {
    if (!editorEl) return;
    persistFormDraftToSprite();
    editorEl.replaceChildren();
    if (!sprite) {
      editorEl.appendChild(h('div', { class: 'muted', text: 'Select a sprite to edit.' }));
      return;
    }

    var brushInput = h('input', { type: 'number', min: '1', max: '8', value: String(brushSize) });
    brushInput.addEventListener('change', function () {
      var n = Number(brushInput.value);
      brushSize = Number.isFinite(n) ? Math.max(1, Math.min(8, Math.round(n))) : 1;
      brushInput.value = String(brushSize);
    });

    var zoomInput = h('input', { type: 'number', min: '2', max: '20', value: String(pixelScale) });
    zoomInput.addEventListener('change', function () {
      var n = Number(zoomInput.value);
      pixelScale = Number.isFinite(n) ? Math.max(2, Math.min(20, Math.round(n))) : 6;
      zoomInput.value = String(pixelScale);
      if (canvas && overlayCanvas) {
        var w = String(canvas.width * pixelScale) + 'px';
        var hPx = String(canvas.height * pixelScale) + 'px';
        canvas.style.width = w;
        canvas.style.height = hPx;
        overlayCanvas.style.width = w;
        overlayCanvas.style.height = hPx;
      }
    });

    var modeSelect = h('select', { id: 'mode' }, [
      h('option', { value: 'erase', text: 'Erase' }),
      h('option', { value: 'draw', text: 'Draw' })
    ]);
    modeSelect.value = drawMode;
    modeSelect.addEventListener('change', function () {
      drawMode = modeSelect.value === 'draw' ? 'draw' : 'erase';
    });

    var colorInput = h('input', { id: 'draw-color', type: 'color', value: drawColor });
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
    });
    var scaleMethodSelect = h('select', { id: 'scale-method' });
    for (var methodIdx = 0; methodIdx < SCALE_METHODS.length; methodIdx++) {
      var option = SCALE_METHODS[methodIdx];
      scaleMethodSelect.appendChild(h('option', { value: option.id, text: option.label }));
    }
    scaleMethodSelect.value = scaleMethod;
    scaleMethodSelect.addEventListener('change', function () {
      scaleMethod = scaleMethodSelect.value;
    });
    var applyScaleBtn = h('button', { type: 'button', text: 'Apply OpenCV scale' });
    applyScaleBtn.addEventListener('click', function () {
      applyScaleTransform();
    });
    var eyedropperBtn = h(
      'button',
      { type: 'button', class: 'tool-btn' + (eyedropperArmed ? ' on' : ''), text: eyedropperArmed ? 'Eyedropper active' : 'Eyedropper' },
      []
    );
    eyedropperBtn.addEventListener('click', function () {
      armEyedropper(!eyedropperArmed);
      if (eyedropperArmed) setStatus('Click a pixel to sample color.');
      renderEditor();
    });

    var saveBtn = h('button', { type: 'button' }, ['Save']);
    saveBtn.addEventListener('click', saveCurrent);
    var revertBtn = h('button', { type: 'button' }, ['Revert to HEAD']);
    revertBtn.addEventListener('click', revertCurrent);
    var undoBtn = h('button', { type: 'button', text: 'Undo' });
    undoBtn.disabled = undoStack.length === 0;
    undoBtn.addEventListener('click', undo);
    var redoBtn = h('button', { type: 'button', text: 'Redo' });
    redoBtn.disabled = redoStack.length === 0;
    redoBtn.addEventListener('click', redo);

    var toggleAnchorBtn = h('button', { type: 'button', text: showAnchor ? 'Hide anchor +' : 'Show anchor +' });
    toggleAnchorBtn.addEventListener('click', function () {
      showAnchor = !showAnchor;
      renderEditor();
      renderOverlay();
    });

    var clickAnchorBtn = h('button', { type: 'button', text: setAnchorOnClick ? 'Click target active' : 'Set anchor by click' });
    clickAnchorBtn.addEventListener('click', function () {
      setAnchorOnClick = !setAnchorOnClick;
      if (setAnchorOnClick) armEyedropper(false);
      renderEditor();
    });

    var holeBtn = h('button', { type: 'button', text: showHoleOverlay ? 'Hide hole overlay' : 'Show hole overlay' });
    holeBtn.addEventListener('click', function () {
      showHoleOverlay = !showHoleOverlay;
      renderEditor();
      renderOverlay();
    });

    var hasVariants = Number(sprite.variantCount || 0) > 1;
    var prevVariantBtn = h('button', { type: 'button', text: 'Prev variant' });
    prevVariantBtn.disabled = !hasVariants || !sprite.prevVariantKey;
    prevVariantBtn.addEventListener('click', function () {
      if (!sprite || !sprite.prevVariantKey) return;
      loadSprite(sprite.prevVariantKey);
    });
    var nextVariantBtn = h('button', { type: 'button', text: 'Next variant' });
    nextVariantBtn.disabled = !hasVariants || !sprite.nextVariantKey;
    nextVariantBtn.addEventListener('click', function () {
      if (!sprite || !sprite.nextVariantKey) return;
      loadSprite(sprite.nextVariantKey);
    });

    var toolbar = h('div', { class: 'toolbar' }, [
      h('div', { class: 'row' }, [
        h('strong', { text: sprite.label }),
        sprite.favorite ? h('span', { class: 'heart', text: '♥' }) : null,
        h('span', { class: 'muted', text: sprite.key }),
        hasVariants
          ? h(
              'span',
              {
                class: 'muted',
                text: 'Variant ' + String(sprite.variantPosition || 1) + ' / ' + String(sprite.variantCount || 1)
              },
              []
            )
          : null,
        prevVariantBtn,
        nextVariantBtn
      ]),
      h('div', { class: 'row' }, [
        h('span', { class: 'muted', text: 'Brush' }), brushInput,
        h('span', { class: 'muted', text: 'Zoom' }), zoomInput,
        modeSelect, colorInput, eyedropperBtn,
        h('span', { class: 'muted', text: 'Scale' }), scaleFactorInput, scaleMethodSelect, applyScaleBtn,
        undoBtn, redoBtn,
        toggleAnchorBtn, clickAnchorBtn, holeBtn,
        saveBtn, revertBtn
      ])
    ]);

    var canvasWrap = h('div', { class: 'canvas-wrap' });
    if (canvas && overlayCanvas) {
      var stage = h('div', { class: 'canvas-stage' }, [canvas, overlayCanvas]);
      canvas.style.cursor = eyedropperArmed ? 'copy' : (setAnchorOnClick ? 'crosshair' : 'default');
      canvasWrap.appendChild(stage);
    } else {
      canvasWrap.appendChild(h('span', { class: 'muted', text: 'Image unavailable.' }));
    }

    var metaGrid = h('div', { class: 'grid' }, [
      fieldNum('holdX', 'Anchor X', sprite.holdX),
      fieldNum('holdY', 'Anchor Y', sprite.holdY),
      fieldNum('pivotX', 'Pivot X', sprite.pivotX),
      fieldNum('pivotY', 'Pivot Y', sprite.pivotY),
      fieldNum('frame', 'Frame', sprite.frame == null ? 0 : sprite.frame),
      fieldNum('col', 'Column', sprite.col == null ? 0 : sprite.col),
      fieldNum('row', 'Row', sprite.row == null ? 0 : sprite.row),
      (function () {
        var wrap = h('div', { class: 'field' }, [h('label', { text: 'Facing' })]);
        var select = h('select', { id: 'facing' }, [
          h('option', { value: 'right', text: 'right' }),
          h('option', { value: 'left', text: 'left' })
        ]);
        select.value = sprite.facingDirection === 'left' ? 'left' : 'right';
        wrap.appendChild(select);
        return wrap;
      })(),
      (function () {
        var wrap = h('div', { class: 'field' }, [h('label', { text: 'Favorite' })]);
        var favValue = h('input', { id: 'favorite', type: 'hidden', value: sprite.favorite ? 'true' : 'false' });
        var heartBtn = h(
          'button',
          {
            id: 'favorite-heart',
            type: 'button',
            class: 'heart-btn' + (sprite.favorite ? ' on' : ''),
            'aria-pressed': sprite.favorite ? 'true' : 'false',
            text: sprite.favorite ? '♥' : '♡'
          },
          []
        );
        heartBtn.addEventListener('click', function () {
          var next = heartBtn.getAttribute('aria-pressed') !== 'true';
          heartBtn.setAttribute('aria-pressed', next ? 'true' : 'false');
          heartBtn.textContent = next ? '♥' : '♡';
          heartBtn.className = 'heart-btn' + (next ? ' on' : '');
          favValue.value = next ? 'true' : 'false';
        });
        wrap.appendChild(h('div', { class: 'row' }, [heartBtn, h('span', { class: 'muted', text: 'Prioritize as exemplar' })]));
        wrap.appendChild(favValue);
        return wrap;
      })()
    ]);

    var commentField = h('div', { class: 'field' }, [
      h('label', { text: 'Comment / Feedback' }),
      h('textarea', { id: 'comment' })
    ]);
    commentField.querySelector('textarea').value = sprite.comment || '';

    editorEl.append(
      toolbar,
      h('div', { class: 'muted', text: sprite.assetPath + ' · group: ' + (sprite.variantGroup || '-') }),
      canvasWrap,
      metaGrid,
      commentField
    );
    var syncAnchorFromInputs = function () {
      var before = cloneState();
      if (!sprite) return;
      var xInput = document.getElementById('holdX');
      var yInput = document.getElementById('holdY');
      var holdX = Number(xInput ? xInput.value : sprite.holdX || 0);
      var holdY = Number(yInput ? yInput.value : sprite.holdY || 0);
      sprite.holdX = Number.isFinite(holdX) ? Math.max(0, Math.round(holdX)) : 0;
      sprite.holdY = Number.isFinite(holdY) ? Math.max(0, Math.round(holdY)) : 0;
      if (xInput) xInput.value = String(sprite.holdX);
      if (yInput) yInput.value = String(sprite.holdY);
      var after = cloneState();
      if (statesDiffer(before, after)) pushUndoState(before);
      renderOverlay();
    };
    var holdXField = document.getElementById('holdX');
    var holdYField = document.getElementById('holdY');
    if (holdXField) holdXField.addEventListener('change', syncAnchorFromInputs);
    if (holdYField) holdYField.addEventListener('change', syncAnchorFromInputs);
    renderOverlay();
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
    var status = h('div', { id: 'status', class: 'status' });

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
    document.addEventListener('keydown', function (ev) {
      var target = ev.target;
      var tag = target && target.tagName ? String(target.tagName).toUpperCase() : '';
      if (target && (target.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT')) {
        return;
      }
      if (ev.key === 'Escape') {
        armEyedropper(false);
        setAnchorOnClick = false;
        hideContextMenu();
        renderEditor();
        return;
      }
      if (!(ev.ctrlKey || ev.metaKey)) return;
      var key = String(ev.key || '').toLowerCase();
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
    <div id="app" aria-live="polite"></div>
    <script>${script}</script>
  </body>
</html>`;
}
