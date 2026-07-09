/**
 * renderer.mjs — the postprocess-debugger canvas iframe document.
 *
 * `renderHtml(instanceId)` returns a complete, self-contained HTML document (the
 * host embeds it in an iframe with no privileged bridge). All data comes from the
 * extension's own loopback server:
 *   - `GET  /api/state`   — full view model (health + runs + selected run bundle
 *     + slice map), built server-side.
 *   - `GET  /events`      — SSE; the server pushes fresh state after selection.
 *   - `GET  /api/select?briefId=&runId=&variant=&sheet=` — change selection.
 *   - `POST /api/live-postprocess` — relay a live re-process (body carries the
 *     browser-computed raw PNG + tolerances); returns `{ok, finalPng, steps}`.
 *   - `GET  /img/sheet|processed|raw?briefId=&runId=&file=` — binary image proxies.
 *
 * FUNCTIONAL parity target: the monolith `?page=postprocess` in
 * `src/devtools-main.ts` (`renderPostprocessDebugger`, ~4913+). Sections:
 *   1. Source sprite sheet (sheet tabs + plain sheet canvas).
 *   2. Slicing overlay (2nd canvas; dim + per-cell classify; click a cell to
 *      select its variant) — drawn with the SAME math as the monolith
 *      `drawSliceMapOnCanvas`, via the pure helpers in `lib/slice-overlay.mjs`
 *      that are serialized into this client verbatim (no hand-duplicated drift).
 *   3. Postprocess pipeline — live trace (`/api/live-postprocess`) with a
 *      pre-baked manifest fallback; adjustable background tolerances (Apply /
 *      Reset, non-persisting); final output.
 *
 * The client script is intentionally template-literal-free (plain string concat +
 * createElement) so this whole file stays clean outer template literals with no
 * escaping. It is READ-ONLY: no persistence/mutate affordances.
 *
 * @module postprocess/renderer
 */

import * as overlay from './lib/slice-overlay.mjs';

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Serialize the pure slice-overlay helpers into browser source. They are
 * self-contained (no imports/closures) so `Function.prototype.toString()` yields
 * runnable declarations; the SAME unit-tested code then draws the overlay.
 * @returns {string}
 */
function overlayFnsSource() {
  return Object.keys(overlay)
    .filter((name) => typeof overlay[name] === 'function')
    .map((name) => 'var ' + name + ' = ' + overlay[name].toString() + ';')
    .join('\n');
}

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
    line-height: var(--leading-body-medium, 1.5);
  }
  h1 { font-size: var(--text-title-large, 20px); font-weight: 600; margin: 0 0 4px; }
  .muted { color: var(--text-color-muted, #94a3b8); font-size: 12px; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .between { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  select, button, input {
    background: #0f172a; color: #e2e8f0;
    border: 1px solid rgba(148,163,184,0.35); border-radius: 6px;
    padding: 6px 10px; font-size: 13px; font-family: inherit;
  }
  button { cursor: pointer; }
  button:disabled { opacity: 0.55; cursor: default; }
  input[type=number] { width: 96px; }
  .badge { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
    padding: 3px 8px; border-radius: 999px; border: 1px solid transparent; }
  .badge.up { color: #86efac; border-color: rgba(134,239,172,0.4); background: rgba(134,239,172,0.08); }
  .badge.down { color: #fca5a5; border-color: rgba(252,165,165,0.4); background: rgba(252,165,165,0.08); }
  .badge.wrong-repo { color: #fde68a; border-color: rgba(253,230,138,0.4); background: rgba(253,230,138,0.08); }
  .v2 { font-size: 10px; padding: 2px 8px; border-radius: 999px; border: 1px solid #7dd3fc;
    background: rgba(125,211,252,0.12); color: #7dd3fc; font-weight: 600; }
  .panel { padding: 16px; border-radius: 8px; border: 1px solid rgba(148,163,184,0.25); background: #0f172a; }
  .panel.warn { background: #78350f; color: #fef3c7; border-color: rgba(255,255,255,0.18); }
  .panel.error { background: #7f1d1d; color: #fef3c7; }
  code { font-family: var(--font-mono, "SFMono-Regular", Consolas, monospace); font-size: 12px;
    background: rgba(148,163,184,0.15); padding: 1px 5px; border-radius: 4px; }
  .section { margin-bottom: 12px; border: 1px solid rgba(148,163,184,0.15); border-radius: 8px; overflow: hidden; }
  .section > .head { padding: 7px 12px; background: rgba(15,23,42,0.9); font-size: 10px; font-weight: 600;
    color: #94a3b8; letter-spacing: 0.06em; text-transform: uppercase; border-bottom: 1px solid rgba(148,163,184,0.1); }
  .section > .body { padding: 12px; background: rgba(8,12,24,0.6); }
  canvas.sheet { display: none; max-width: 100%; image-rendering: pixelated; border-radius: 4px;
    border: 1px solid rgba(148,163,184,0.2); }
  canvas.slice { display: none; max-width: 100%; image-rendering: pixelated; border-radius: 4px;
    border: 1px solid rgba(148,163,184,0.2); cursor: pointer; }
  .checker { background:
      linear-gradient(45deg, #1e293b 25%, transparent 25%), linear-gradient(-45deg, #1e293b 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, #1e293b 75%), linear-gradient(-45deg, transparent 75%, #1e293b 75%);
    background-size: 10px 10px; background-position: 0 0, 0 5px, 5px -5px, -5px 0px; background-color: #0f172a; }
  .step { border: 1px solid rgba(148,163,184,0.2); border-radius: 8px; padding: 10px; margin-bottom: 10px; background: #0b1220; }
  .step .label { font-size: 12px; font-weight: 600; color: #f1f5f9; margin-bottom: 8px; }
  .ba { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
  .ba .col { display: flex; flex-direction: column; gap: 4px; align-items: center; }
  .ba .cap { font-size: 10px; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }
  .ba img { width: 96px; height: 96px; image-rendering: pixelated; border-radius: 4px;
    border: 1px solid rgba(148,163,184,0.2); }
  .ba .arrow { color: #475569; font-size: 18px; }
  .final img { max-width: 160px; max-height: 160px; image-rendering: pixelated; border-radius: 4px;
    border: 1px solid rgba(148,163,184,0.2); }
  .tuning { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; margin-bottom: 12px;
    padding: 10px; border: 1px solid rgba(148,163,184,0.2); border-radius: 8px; background: #0b1220; }
  .tuning .fld { display: flex; flex-direction: column; gap: 3px; }
  .tuning .fld label { font-size: 10px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.04em; }
  .slice-status { font-size: 11px; color: #64748b; margin-top: 8px; }
  .toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 12px;
    padding-bottom: 10px; border-bottom: 1px solid rgba(148,163,184,0.15); }
  .busy { display: inline-flex; align-items: center; gap: 7px; color: var(--text-color-muted, #94a3b8); font-size: 12px; }
  .busy[hidden] { display: none; }
  .spinner { width: 13px; height: 13px; border: 2px solid rgba(148,163,184,0.3);
    border-top-color: #7dd3fc; border-radius: 50%; display: inline-block; animation: pp-spin 0.8s linear infinite; }
  @keyframes pp-spin { to { transform: rotate(360deg); } }
`;

// NOTE: template-literal-free on purpose (no backticks, no ${}) — see header.
// `/*__OVERLAY_FNS__*/` is replaced with the serialized slice-overlay helpers.
const CLIENT_SCRIPT = String.raw`
(function () {
  'use strict';
  /*__OVERLAY_FNS__*/

  var DEFAULT_TWEAKS = { colorToleranceSq: 4000, fringeToleranceSq: 12000 };
  var MAX_TOLERANCE = 255 * 255 * 3;
  var app = document.getElementById('app');

  var renderToken = 0;
  var liveSeq = 0;
  var liveFailed = false;
  var currentState = null;
  var currentTweaks = { colorToleranceSq: 4000, fringeToleranceSq: 12000 };
  var sheetImg = null;

  function h(tag, props, children) {
    var elem = document.createElement(tag);
    if (props) {
      for (var k in props) {
        if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
        if (k === 'style') { for (var s in props.style) { elem.style[s] = props.style[s]; } }
        else if (k === 'text') { elem.textContent = props[k]; }
        else if (k === 'class') { elem.className = props[k]; }
        else { elem.setAttribute(k, props[k]); }
      }
    }
    if (children) {
      for (var i = 0; i < children.length; i++) {
        var c = children[i];
        if (c == null) continue;
        elem.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return elem;
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  function clampTol(value, fallback) {
    if (typeof value !== 'number' || !isFinite(value)) return fallback;
    return Math.max(0, Math.min(MAX_TOLERANCE, Math.round(value)));
  }

  function imgUrl(kind, briefId, runId, file) {
    return '/img/' + kind + '?briefId=' + encodeURIComponent(briefId)
      + '&runId=' + encodeURIComponent(runId) + '&file=' + encodeURIComponent(file);
  }

  function stripDataUrl(dataUrl) {
    var idx = dataUrl.indexOf('base64,');
    return idx >= 0 ? dataUrl.slice(idx + 7) : dataUrl;
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(stripDataUrl(String(reader.result))); };
      reader.onerror = function () { reject(new Error('read-failed')); };
      reader.readAsDataURL(blob);
    });
  }

  function b64Src(b64) { return 'data:image/png;base64,' + b64; }

  // ── Health + degrade ─────────────────────────────────────────────
  function renderHealth(state) {
    var health = state.health || { state: 'down' };
    var badge = h('span', { class: 'badge ' + health.state, text: health.state });
    var meta = [];
    if (health.version) meta.push('sidecar ' + health.version);
    if (health.storeBackend) meta.push(health.storeBackend);
    if (state.baseUrl) meta.push(state.baseUrl);
    return h('div', { class: 'between' }, [
      h('div', null, [
        h('h1', { text: 'Postprocess Debugger' }),
        h('div', { class: 'muted', text: 'Inspect pipeline steps, validate sheet slicing, and trace live postprocess output.' })
      ]),
      h('div', { class: 'row' }, [badge, h('span', { class: 'muted', text: meta.join('  \u00b7  ') })])
    ]);
  }

  function renderDegrade(state) {
    var health = state.health || { state: 'down' };
    if (health.state === 'wrong-repo') {
      return h('div', { class: 'panel warn' }, [
        h('div', { class: 'label', text: 'Sidecar is serving a different repo' }),
        h('div', null, ['The sprite sidecar answered, but its repoRoot does not match this worktree.']),
        h('div', { class: 'muted', style: { marginTop: '6px' } }, ['sidecar repoRoot: ', h('code', { text: health.repoRoot || '(unknown)' })]),
        h('div', { class: 'muted' }, ['this workspace: ', h('code', { text: health.expectedRepoRoot || '(unknown)' })]),
        h('div', { style: { marginTop: '8px' } }, ['Restart the sidecar from THIS worktree: ', h('code', { text: 'npm run sprites:gallery' })])
      ]);
    }
    return h('div', { class: 'panel warn' }, [
      h('div', { class: 'label', text: 'Sprite sidecar not running' }),
      h('div', null, ['The postprocess debugger needs the sprite sidecar. Start it, then reload this canvas:']),
      h('div', { style: { marginTop: '8px' } }, [h('code', { text: 'npm run sprites:gallery' })]),
      state.baseUrl ? h('div', { class: 'muted', style: { marginTop: '6px' } }, ['Expected at ', h('code', { text: state.baseUrl })]) : null
    ]);
  }

  // ── Pickers ──────────────────────────────────────────────────────
  function renderPickers(state) {
    var runs = state.runs || [];
    var sel = state.selected;
    var runPicker = h('select', { title: 'Select generated run' });
    for (var i = 0; i < runs.length; i++) {
      var run = runs[i];
      var opt = document.createElement('option');
      opt.value = run.briefId + '::' + run.runId;
      var count = (typeof run.candidateCount === 'number' && run.candidateCount >= 0) ? ' (' + run.candidateCount + ' variants)' : '';
      opt.textContent = run.briefId + ' / ' + run.runId + count;
      if (sel && run.briefId === sel.briefId && run.runId === sel.runId) opt.selected = true;
      runPicker.appendChild(opt);
    }
    runPicker.addEventListener('change', function () {
      var parts = runPicker.value.split('::');
      if (parts.length === 2) select(parts[0], parts[1], null, null);
    });
    var kids = [h('span', { class: 'muted', text: 'Run:' }), runPicker];

    if (sel && Array.isArray(sel.variantIndices) && sel.variantIndices.length > 0) {
      var vPicker = h('select', { title: 'Select variant' });
      for (var v = 0; v < sel.variantIndices.length; v++) {
        var vi = sel.variantIndices[v];
        var vo = document.createElement('option');
        vo.value = String(vi);
        vo.textContent = '#' + vi;
        if (vi === sel.variantIndex) vo.selected = true;
        vPicker.appendChild(vo);
      }
      vPicker.addEventListener('change', function () {
        select(sel.briefId, sel.runId, parseInt(vPicker.value, 10), sel.activeSheet || null);
      });
      kids.push(h('span', { class: 'muted', text: 'Variant:' }));
      kids.push(vPicker);
    }
    return h('div', { class: 'row', style: { marginTop: '10px', marginBottom: '4px' } }, kids);
  }

  // ── Section 1: source sheet ──────────────────────────────────────
  function renderSheetSection(state, token) {
    var sel = state.selected;
    var body = h('div', { class: 'body' }, []);
    var section = h('div', { class: 'section' }, [h('div', { class: 'head', text: 'Source sprite sheet' }), body]);
    if (!sel) return section;

    var sheets = sel.sheets || [];
    if (sheets.length === 0) {
      body.appendChild(h('div', { class: 'muted', text: 'No source sheets found for this run.' }));
      return section;
    }
    var active = sel.activeSheet && sheets.indexOf(sel.activeSheet) >= 0 ? sel.activeSheet : sheets[sheets.length - 1];
    if (sheets.length > 1) {
      var tabs = h('div', { class: 'row', style: { marginBottom: '8px' } }, []);
      for (var i = 0; i < sheets.length; i++) {
        (function (file) {
          var btn = h('button', { type: 'button', text: file });
          if (file === active) { btn.style.borderColor = '#7dd3fc'; btn.style.color = '#7dd3fc'; }
          btn.addEventListener('click', function () { select(sel.briefId, sel.runId, sel.variantIndex, file); });
          tabs.appendChild(btn);
        })(sheets[i]);
      }
      body.appendChild(tabs);
    }
    body.appendChild(h('div', { class: 'muted', style: { marginBottom: '6px' } },
      [h('code', { text: sel.briefId + ' / ' + sel.sheetRunId }), '  ', active]));

    var status = h('div', { class: 'muted', text: 'Loading sheet from Azure\u2026' });
    var sheetCanvas = h('canvas', { class: 'sheet checker' });
    body.appendChild(status);
    body.appendChild(sheetCanvas);

    var img = new Image();
    sheetImg = null;
    img.addEventListener('load', function () {
      if (token !== renderToken) return;
      status.remove();
      drawSheetPlain(sheetCanvas, img);
      sheetImg = img;
      // overlay lives in the pipeline section; (re)draw it now that we have pixels
      redrawOverlay(state, token);
      startPipeline(state, token);
    });
    img.addEventListener('error', function () {
      if (token !== renderToken) return;
      status.textContent = 'Failed to load sheet: ' + active;
      startPipeline(state, token); // raw fallback still works
    });
    img.src = imgUrl('sheet', sel.briefId, sel.sheetRunId, active);
    return section;
  }

  function drawSheetPlain(canvas, img) {
    var scale = computeOverlayScale(img.naturalWidth, 640);
    var dims = computeDisplayDims(img.naturalWidth, img.naturalHeight, scale);
    canvas.width = dims.dw; canvas.height = dims.dh;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, dims.dw, dims.dh);
    ctx.drawImage(img, 0, 0, dims.dw, dims.dh);
    canvas.style.display = '';
  }

  // ── Slicing overlay (first pipeline item) ────────────────────────
  var overlayCanvas = null;
  var overlayStatus = null;
  var overlayHitCells = [];

  function redrawOverlay(state, token) {
    if (token !== renderToken || !overlayCanvas) return;
    var sel = state.selected;
    var sm = state.sliceMap;
    if (!sel) return;
    if (!sheetImg || !sheetImg.complete) { return; }
    overlayHitCells = drawSliceOverlay(overlayCanvas, sheetImg, sm, sel.variantIndex);
    overlayCanvas.style.display = '';
    if (overlayStatus) {
      if (sm && sm.ok === false) {
        overlayStatus.textContent = sm.error || 'Failed to load slice map.';
      } else {
        overlayStatus.textContent = sm ? buildSliceStatusText(sm, sel.variantIndex) : 'No slice map for this sheet.';
      }
    }
  }

  function drawSliceOverlay(canvas, img, sliceMap, variantIndex) {
    var scale = computeOverlayScale(img.naturalWidth, 640);
    var dims = computeDisplayDims(img.naturalWidth, img.naturalHeight, scale);
    canvas.width = dims.dw; canvas.height = dims.dh;
    var ctx = canvas.getContext('2d');
    var hits = [];
    if (!ctx) return hits;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, dims.dw, dims.dh);
    ctx.drawImage(img, 0, 0, dims.dw, dims.dh);
    if (!sliceMap || sliceMap.ok === false || !Array.isArray(sliceMap.cells)) return hits;
    ctx.fillStyle = 'rgba(8,12,24,0.55)';
    ctx.fillRect(0, 0, dims.dw, dims.dh);
    for (var i = 0; i < sliceMap.cells.length; i++) {
      var cell = sliceMap.cells[i];
      var p = projectCell(cell, scale);
      var kind = classifyCell(cell, sliceMap, variantIndex);
      if (kind === 'empty') {
        ctx.strokeStyle = 'rgba(239,68,68,0.5)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
        ctx.strokeRect(p.dx + 0.5, p.dy + 0.5, p.dw - 1, p.dh - 1); ctx.setLineDash([]);
        continue;
      }
      if (kind === 'selected') {
        ctx.drawImage(img, cell.x0, cell.y0, cell.w, cell.h, p.dx, p.dy, p.dw, p.dh);
        ctx.fillStyle = 'rgba(125,211,252,0.12)'; ctx.fillRect(p.dx, p.dy, p.dw, p.dh);
        ctx.strokeStyle = '#7dd3fc'; ctx.lineWidth = 2; ctx.strokeRect(p.dx + 1, p.dy + 1, p.dw - 2, p.dh - 2);
      } else {
        ctx.strokeStyle = 'rgba(148,163,184,0.4)'; ctx.lineWidth = 1; ctx.strokeRect(p.dx, p.dy, p.dw, p.dh);
      }
      hits.push({ cell: cell, x: p.dx, y: p.dy, w: p.dw, h: p.dh });
    }
    return hits;
  }

  function makeSlicingCard(state) {
    var sel = state.selected;
    var sm = state.sliceMap;
    overlayCanvas = h('canvas', { class: 'slice checker' });
    overlayStatus = h('div', { class: 'slice-status', text: 'Waiting for sheet\u2026' });

    overlayCanvas.addEventListener('click', function (ev) {
      if (!sel || !sm || !indicesTrustworthy(sm)) return;
      var rect = overlayCanvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      var cx = (ev.clientX - rect.left) * (overlayCanvas.width / rect.width);
      var cy = (ev.clientY - rect.top) * (overlayCanvas.height / rect.height);
      var hit = hitTestCell(overlayHitCells, cx, cy);
      if (hit && hit.cell && typeof hit.cell.index === 'number' && hit.cell.index >= 0 && hit.cell.index !== sel.variantIndex) {
        select(sel.briefId, sel.runId, hit.cell.index, sel.activeSheet || null);
      }
    });

    var head = h('div', { class: 'row', style: { marginBottom: '8px' } }, [
      h('span', { class: 'muted', text: 'Slicing' }),
      h('span', { class: 'v2', text: 'Canonical (v2)' })
    ]);
    var card = h('div', { class: 'step' }, [
      h('div', { class: 'label', text: 'Step 0 \u2014 sheet slicing' }),
      head, overlayCanvas, overlayStatus
    ]);
    return card;
  }

  // ── Background tuning ────────────────────────────────────────────
  function makeTuningPanel(state) {
    var colorIn = h('input', { type: 'number', min: '0', max: String(MAX_TOLERANCE), step: '100', value: String(currentTweaks.colorToleranceSq) });
    var fringeIn = h('input', { type: 'number', min: '0', max: String(MAX_TOLERANCE), step: '100', value: String(currentTweaks.fringeToleranceSq) });
    var applyBtn = h('button', { type: 'button', text: 'Apply' });
    var resetBtn = h('button', { type: 'button', text: 'Reset' });
    applyBtn.addEventListener('click', function () {
      currentTweaks = {
        colorToleranceSq: clampTol(parseFloat(colorIn.value), DEFAULT_TWEAKS.colorToleranceSq),
        fringeToleranceSq: clampTol(parseFloat(fringeIn.value), DEFAULT_TWEAKS.fringeToleranceSq)
      };
      colorIn.value = String(currentTweaks.colorToleranceSq);
      fringeIn.value = String(currentTweaks.fringeToleranceSq);
      liveFailed = false;
      startPipeline(currentState, renderToken);
    });
    resetBtn.addEventListener('click', function () {
      currentTweaks = { colorToleranceSq: DEFAULT_TWEAKS.colorToleranceSq, fringeToleranceSq: DEFAULT_TWEAKS.fringeToleranceSq };
      colorIn.value = String(currentTweaks.colorToleranceSq);
      fringeIn.value = String(currentTweaks.fringeToleranceSq);
      liveFailed = false;
      startPipeline(currentState, renderToken);
    });
    return h('div', { class: 'tuning' }, [
      h('div', { class: 'fld' }, [h('label', { text: 'colorToleranceSq' }), colorIn]),
      h('div', { class: 'fld' }, [h('label', { text: 'fringeToleranceSq' }), fringeIn]),
      applyBtn, resetBtn,
      h('span', { class: 'muted', text: 'max ' + MAX_TOLERANCE + ' \u00b7 non-persisting' })
    ]);
  }

  // ── Pipeline body (live + prebaked) ──────────────────────────────
  var pipelineBody = null;

  function makeStepCard(label, beforeSrc, afterSrc) {
    var beforeCol = h('div', { class: 'col' }, [h('span', { class: 'cap', text: 'before' }),
      beforeSrc ? h('img', { class: 'checker', src: beforeSrc, alt: 'before' }) : h('span', { class: 'muted', text: '—' })]);
    var afterCol = h('div', { class: 'col' }, [h('span', { class: 'cap', text: 'after' }),
      afterSrc ? h('img', { class: 'checker', src: afterSrc, alt: 'after' }) : h('span', { class: 'muted', text: '—' })]);
    return h('div', { class: 'step' }, [
      h('div', { class: 'label', text: label }),
      h('div', { class: 'ba' }, [beforeCol, h('span', { class: 'arrow', text: '\u2192' }), afterCol])
    ]);
  }

  function makeFinalCard(src) {
    return h('div', { class: 'step final' }, [
      h('div', { class: 'label', text: 'Final output' }),
      src ? h('img', { class: 'checker', src: src, alt: 'final output' }) : h('span', { class: 'muted', text: 'No final output available.' })
    ]);
  }

  function renderLiveSteps(state, resp, inputSrc) {
    if (!pipelineBody) return;
    pipelineBody.replaceChildren();
    pipelineBody.appendChild(h('div', { class: 'muted', style: { marginBottom: '8px' }, text: 'Live pipeline (re-processed from source).' }));
    var steps = Array.isArray(resp.steps) ? resp.steps : [];
    var before = inputSrc;
    for (var i = 0; i < steps.length; i++) {
      var after = b64Src(steps[i].png);
      pipelineBody.appendChild(makeStepCard(steps[i].label || steps[i].id || ('step ' + (i + 1)), before, after));
      before = after;
    }
    pipelineBody.appendChild(makeFinalCard(b64Src(resp.finalPng)));
  }

  function renderPrebaked(state, reason) {
    if (!pipelineBody) return;
    var sel = state.selected;
    pipelineBody.replaceChildren();
    if (reason && reason !== 'no-brief-path') {
      pipelineBody.appendChild(h('div', { style: { color: '#fbbf24', fontSize: '11px', marginBottom: '8px' },
        text: 'Live re-processing unavailable (' + reason + '). Showing pre-baked pipeline output.' }));
    } else if (reason === 'no-brief-path') {
      pipelineBody.appendChild(h('div', { class: 'muted', style: { marginBottom: '8px' },
        text: 'This run has no brief on disk; showing the pre-baked pipeline output.' }));
    }
    if (!sel) return;
    if (sel.profile) {
      pipelineBody.appendChild(h('div', { style: { color: '#475569', fontSize: '11px', marginBottom: '8px' }, text: 'Profile: ' + sel.profile }));
    }
    var steps = Array.isArray(sel.manifestSteps) ? sel.manifestSteps : [];
    var padded = pad2(sel.variantIndex);
    var before = imgUrl('raw', sel.briefId, sel.runId, padded + '.png');
    if (steps.length === 0) {
      pipelineBody.appendChild(h('div', { class: 'muted', style: { marginBottom: '8px' }, text: 'No pipeline trace available for this run.' }));
    } else {
      for (var i = 0; i < steps.length; i++) {
        var after = imgUrl('processed', sel.briefId, sel.runId, steps[i].file);
        pipelineBody.appendChild(makeStepCard(steps[i].label || steps[i].file, before, after));
        before = after;
      }
    }
    pipelineBody.appendChild(makeFinalCard(imgUrl('processed', sel.briefId, sel.runId, padded + '.png') + '&ts=' + Date.now()));
  }

  function computeInput(state) {
    var sel = state.selected;
    var sm = state.sliceMap;
    if (sheetImg && sheetImg.complete && sm && sm.ok !== false && indicesTrustworthy(sm)) {
      var cell = resolveSelectedCell(sm, sel.variantIndex);
      if (cell && !cell.empty && cell.w > 0 && cell.h > 0) {
        try {
          var c = document.createElement('canvas');
          c.width = cell.w; c.height = cell.h;
          var ctx = c.getContext('2d');
          if (ctx) {
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(sheetImg, cell.x0, cell.y0, cell.w, cell.h, 0, 0, cell.w, cell.h);
            var b64 = stripDataUrl(c.toDataURL('image/png'));
            return Promise.resolve({ base64: b64, src: b64Src(b64) });
          }
        } catch (e) { /* tainted/oversize — fall through to stored raw */ }
      }
    }
    var url = imgUrl('raw', sel.briefId, sel.runId, pad2(sel.variantIndex) + '.png');
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('raw ' + r.status);
      return r.blob();
    }).then(function (blob) {
      return blobToBase64(blob).then(function (b64) { return { base64: b64, src: b64Src(b64) }; });
    });
  }

  function startPipeline(state, token) {
    if (token !== renderToken || !state || !state.selected || !pipelineBody) return;
    if (!state.selected.briefPath || liveFailed) {
      renderPrebaked(state, state.selected.briefPath ? null : 'no-brief-path');
      return;
    }
    runLive(state, token);
  }

  function runLive(state, token) {
    var sel = state.selected;
    var mySeq = ++liveSeq;
    setBusy(true, 'Re-processing\u2026');
    pipelineBody.replaceChildren(h('div', { class: 'busy' }, [h('span', { class: 'spinner' }), 'Running live postprocess\u2026']));
    var inputSrc = null;
    computeInput(state).then(function (input) {
      inputSrc = input.src;
      return fetch('/api/live-postprocess', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          briefId: sel.briefId, runId: sel.runId, variant: sel.variantIndex,
          rawPngBase64: input.base64,
          colorToleranceSq: currentTweaks.colorToleranceSq,
          fringeToleranceSq: currentTweaks.fringeToleranceSq,
          seq: mySeq
        })
      });
    }).then(function (r) { return r.json(); }).then(function (resp) {
      setBusy(false);
      if (token !== renderToken || !shouldApplyResponse(mySeq, liveSeq)) return;
      if (resp && resp.ok) { renderLiveSteps(state, resp, inputSrc); }
      else { liveFailed = true; renderPrebaked(state, (resp && resp.reason) || 'error'); }
    }).catch(function () {
      setBusy(false);
      if (token !== renderToken || !shouldApplyResponse(mySeq, liveSeq)) return;
      liveFailed = true; renderPrebaked(state, 'error');
    });
  }

  // ── Top-level render ─────────────────────────────────────────────
  function render(state) {
    if (!state) return;
    currentState = state;
    var token = ++renderToken;
    sheetImg = null;
    overlayCanvas = null;
    overlayStatus = null;
    overlayHitCells = [];
    liveFailed = false;

    // reset tolerance knobs from the run's persisted overrides (or defaults)
    var applied = state.selected && state.selected.appliedBackground;
    currentTweaks = applied
      ? { colorToleranceSq: applied.colorToleranceSq, fringeToleranceSq: applied.fringeToleranceSq }
      : { colorToleranceSq: DEFAULT_TWEAKS.colorToleranceSq, fringeToleranceSq: DEFAULT_TWEAKS.fringeToleranceSq };

    var frag = document.createDocumentFragment();
    frag.appendChild(renderHealth(state));
    if (state.error) frag.appendChild(h('div', { class: 'panel error', style: { marginTop: '12px' }, text: state.error }));
    if (!state.health || state.health.state !== 'up') {
      frag.appendChild(h('div', { style: { marginTop: '12px' } }, [renderDegrade(state)]));
      app.replaceChildren(frag);
      return;
    }
    if (!state.runs || state.runs.length === 0) {
      frag.appendChild(h('div', { class: 'panel warn', style: { marginTop: '12px' } },
        ['No sprite runs found yet. Generate a run from the Sprite Generation Workflow, then reopen this debugger.']));
      app.replaceChildren(frag);
      return;
    }
    frag.appendChild(renderPickers(state));
    if (state.autoSelectedLatest) {
      frag.appendChild(h('div', { class: 'muted', style: { color: '#fde68a', margin: '4px 0' },
        text: 'Auto-selected latest run (briefId/runId were not specified).' }));
    }
    frag.appendChild(renderSheetSection(state, token));

    // pipeline section
    pipelineBody = h('div', { class: 'body' }, []);
    var pipeSection = h('div', { class: 'section' }, [
      h('div', { class: 'head', text: 'Postprocess pipeline \u2014 step by step' }),
      pipelineBody
    ]);
    if (state.selected) {
      pipelineBody.appendChild(makeSlicingCard(state));
      pipelineBody.appendChild(makeTuningPanel(state));
      var stepsHost = h('div', {}, [h('div', { class: 'muted', text: 'Loading pipeline trace\u2026' })]);
      pipelineBody.appendChild(stepsHost);
      // re-point pipelineBody at the steps host so live/prebaked replace only steps,
      // leaving the slicing card + tuning panel intact
      pipelineBody = stepsHost;
    }
    frag.appendChild(pipeSection);
    app.replaceChildren(frag);

    // if there are no sheets, the sheet section won't fire onload — kick the
    // pipeline now (raw-input fallback). With sheets, onload drives it.
    if (state.selected && (!state.selected.sheets || state.selected.sheets.length === 0)) {
      startPipeline(state, token);
    }
  }

  // ── Selection + busy + boot ──────────────────────────────────────
  var selecting = false;
  function select(briefId, runId, variant, sheet) {
    if (selecting) return;
    selecting = true;
    setBusy(true, 'Loading run\u2026');
    var url = '/api/select?briefId=' + encodeURIComponent(briefId) + '&runId=' + encodeURIComponent(runId);
    if (typeof variant === 'number' && !isNaN(variant)) url += '&variant=' + encodeURIComponent(variant);
    if (sheet) url += '&sheet=' + encodeURIComponent(sheet);
    fetch(url).then(function (r) { return r.json(); }).then(function (state) {
      selecting = false; setBusy(false); render(state);
    }).catch(function () { selecting = false; setBusy(false); });
  }

  var busyEl = document.getElementById('busy');
  var busyLabel = document.getElementById('busy-label');
  var refreshBtn = document.getElementById('refresh-btn');
  var inflight = 0;
  function setBusy(on, label) {
    inflight += on ? 1 : -1;
    if (inflight < 0) inflight = 0;
    var active = inflight > 0;
    if (busyEl) busyEl.hidden = !active;
    if (active && label && busyLabel) busyLabel.textContent = label;
    if (refreshBtn) refreshBtn.disabled = active;
  }

  function loadState(label) {
    setBusy(true, label || 'Loading from sidecar\u2026');
    return fetch('/api/state').then(function (r) { return r.json(); }).then(function (state) {
      setBusy(false); render(state);
    }).catch(function (err) {
      setBusy(false);
      app.replaceChildren(h('div', { class: 'panel error', text: 'Failed to load state: ' + err }));
    });
  }

  if (refreshBtn) refreshBtn.addEventListener('click', function () { loadState('Refreshing\u2026'); });

  function connect() {
    try {
      var es = new EventSource('/events');
      es.onmessage = function (ev) {
        try { var msg = JSON.parse(ev.data); if (msg && msg.type === 'state') render(msg.state); }
        catch (e) { /* ignore malformed frame */ }
      };
      es.onerror = function () { /* browser auto-reconnects */ };
    } catch (e) { /* EventSource unsupported */ }
  }

  loadState();
  connect();
})();
`;

/**
 * Full HTML document for one canvas instance.
 * @param {string} instanceId
 * @returns {string}
 */
export function renderHtml(instanceId) {
  const clientScript = CLIENT_SCRIPT.replace('/*__OVERLAY_FNS__*/', () => overlayFnsSource());
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<title>Postprocess Debugger</title>',
    '<style>' + STYLES + '</style>',
    '</head><body>',
    '<div class="toolbar">',
    '<button id="refresh-btn" type="button" title="Reload runs and the selected run from the sidecar">\u21bb Refresh</button>',
    '<span id="busy" class="busy" hidden><span class="spinner"></span><span id="busy-label">Loading\u2026</span></span>',
    '</div>',
    '<div id="app" data-instance="' + escapeHtml(instanceId) + '">',
    '<p class="muted">Loading postprocess debugger\u2026</p>',
    '</div>',
    '<script>' + clientScript + '</script>',
    '</body></html>',
  ].join('');
}
