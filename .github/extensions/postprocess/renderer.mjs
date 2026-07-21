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
 *   - `POST /api/persist-postprocess` — persist overrides (the "Apply changes"
 *     write); body carries the raw authoring intent, the server re-validates +
 *     rebuilds the payload, POSTs it to the sidecar run store, and returns fresh
 *     `{ok, state}` (re-seeded) so the iframe re-renders exactly once (no SSE).
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
 *      Reset, non-persisting preview); final output. The final output image is
 *      click-to-anchor (pure math from `lib/anchor.mjs`, serialized in verbatim).
 *   4. Authoring / persist — facing (left/right), apply-scope (this variant / all
 *      variants), a manual anchor (click the final image or type x/y), "Reset
 *      anchor", "Reset to defaults" (mode `reset`), and "Apply changes" (mode
 *      `replace`), matching the monolith's `renderPostprocessDebugger` write path.
 *      Destructive persists (all-variants or reset) are confirm-guarded.
 *
 * The client script is intentionally template-literal-free (plain string concat +
 * createElement) so this whole file stays clean outer template literals with no
 * escaping.
 *
 * @module postprocess/renderer
 */

import * as overlay from './lib/slice-overlay.mjs';
import * as anchorFns from './lib/anchor.mjs';
import { isDestructivePersist } from './lib/postprocess-client.mjs';

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

/**
 * Serialize the pure anchor-geometry helpers (`lib/anchor.mjs`) plus the pure
 * `isDestructivePersist` confirm predicate into browser source, the SAME way as
 * {@link overlayFnsSource}. All are self-contained (no imports/closures) so
 * `toString()` yields runnable declarations and the SAME unit-tested code runs in
 * the iframe.
 * @returns {string}
 */
function anchorFnsSource() {
  const parts = Object.keys(anchorFns)
    .filter((name) => typeof anchorFns[name] === 'function')
    .map((name) => 'var ' + name + ' = ' + anchorFns[name].toString() + ';');
  parts.push('var isDestructivePersist = ' + isDestructivePersist.toString() + ';');
  return parts.join('\n');
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
  .final .anchorable { cursor: crosshair; }
  .final .wrap { position: relative; display: inline-block; line-height: 0; }
  .final .marker { position: absolute; width: 9px; height: 9px; border-radius: 50%;
    transform: translate(-50%, -50%); pointer-events: none; box-shadow: 0 0 0 1px #0b1120, 0 0 4px rgba(0,0,0,0.6); }
  .authoring { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; margin-bottom: 12px;
    padding: 10px; border: 1px solid rgba(125,211,252,0.35); border-radius: 8px; background: #0b1220; }
  .authoring .fld { display: flex; flex-direction: column; gap: 3px; }
  .authoring .fld label { font-size: 10px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.04em; }
  .authoring .fld input[type=number] { width: 72px; }
  .authoring .primary { border-color: #7dd3fc; color: #7dd3fc; font-weight: 600; }
  .authoring .danger { border-color: rgba(252,165,165,0.5); color: #fca5a5; }
  .apply-status { font-size: 11px; min-width: 60px; }
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
// `/*__OVERLAY_FNS__*/` is replaced with the serialized slice-overlay helpers;
// `/*__ANCHOR_FNS__*/` with the serialized anchor-geometry + isDestructivePersist.
const CLIENT_SCRIPT = String.raw`
(function () {
  'use strict';
  /*__OVERLAY_FNS__*/
  /*__ANCHOR_FNS__*/

  // BASE is '' for the standalone canvas (root-relative transport, unchanged
  // behavior) and '/postprocess' when this SAME document is served under the
  // Sprite Generation Workflow canvas's own loopback server (see
  // renderHtml's basePath param + workflow/extension.mjs's namespaced
  // '/postprocess/*' routes). EMBED_TOKEN is the Workflow mutation token,
  // sent ONLY on the persisting Apply-changes write (empty/absent when
  // standalone, matching its current unauthenticated persist route).
  var BASE = __POSTPROCESS_BASE_PATH__;
  var EMBED_TOKEN = __POSTPROCESS_MUTATION_TOKEN__;
  var EMBEDDED = !!BASE;

  var DEFAULT_TWEAKS = { colorToleranceSq: 4000, fringeToleranceSq: 12000 };
  var MAX_TOLERANCE = 255 * 255 * 3;
  var DEFAULT_UPSCALE_FACTOR = 1;
  var MAX_UPSCALE_FACTOR = 8;
  var app = document.getElementById('app');

  var renderToken = 0;
  var liveSeq = 0;
  var liveFailed = false;
  var currentState = null;
  var currentTweaks = { colorToleranceSq: 4000, fringeToleranceSq: 12000 };
  var currentLiveUpscaleFactor = DEFAULT_UPSCALE_FACTOR;
  var sheetImg = null;

  // ── Authoring / persist state (reset + reseeded from persisted overrides in
  //    render(); the POST fires ONLY on "Apply changes") ──────────────────
  var currentFacing = 'right';       // 'left' | 'right'
  var currentScope = 'variant';      // 'variant' | 'all'
  var currentAnchor = null;          // {x,y} in final-image pixels, or null
  var pendingClear = false;          // "Reset anchor" staged a manualAnchor:null
  var pendingMode = 'default';       // 'default' | 'replace' | 'reset'
  var tuningColorInput = null;       // refs so "Reset to defaults" can reset the
  var tuningFringeInput = null;      //   preview knobs visually
  var tuningUpscaleInput = null;
  var anchorXInput = null;
  var anchorYInput = null;
  var applyStatusEl = null;
  var applyNote = null;              // survives the post-Apply re-render for feedback
  var finalImgEl = null;             // current final <img> (for marker redraw)
  var finalMarkerEl = null;          // current marker dot
  var authoringApplyBtn = null;      // current "Apply changes" <button> (for in-flight disable)
  var applyInFlight = false;         // guards against a double-POST from a rapid re-click

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

  function clampUpscaleFactor(value, fallback) {
    if (typeof value !== 'number' || !isFinite(value)) return fallback;
    return Math.max(DEFAULT_UPSCALE_FACTOR, Math.min(MAX_UPSCALE_FACTOR, Math.round(value)));
  }

  function imgUrl(kind, briefId, runId, file) {
    return BASE + '/img/' + kind + '?briefId=' + encodeURIComponent(briefId)
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

  function maybeUpscaleBase64(base64, factor) {
    var normalized = clampUpscaleFactor(factor, DEFAULT_UPSCALE_FACTOR);
    if (normalized <= DEFAULT_UPSCALE_FACTOR) {
      return Promise.resolve({ base64: base64, src: b64Src(base64) });
    }
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.addEventListener('load', function () {
        try {
          var srcW = img.naturalWidth || img.width;
          var srcH = img.naturalHeight || img.height;
          if (!srcW || !srcH) {
            resolve({ base64: base64, src: b64Src(base64) });
            return;
          }
          var canvas = document.createElement('canvas');
          canvas.width = srcW * normalized;
          canvas.height = srcH * normalized;
          var ctx = canvas.getContext('2d');
          if (!ctx) {
            resolve({ base64: base64, src: b64Src(base64) });
            return;
          }
          ctx.imageSmoothingEnabled = false;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, srcW, srcH, 0, 0, canvas.width, canvas.height);
          var scaled = stripDataUrl(canvas.toDataURL('image/png'));
          resolve({ base64: scaled, src: b64Src(scaled) });
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      img.addEventListener('error', function () {
        reject(new Error('upscale-image-load-failed'));
      });
      img.src = b64Src(base64);
    });
  }

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
        h('div', { class: 'muted', text: 'Inspect pipeline steps, validate sheet slicing, trace live postprocess output, and persist overrides.' })
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
    var startup = state.sidecarStartup || {};
    if (startup.state === 'starting') {
      return h('div', { class: 'panel warn' }, [
        h('div', { class: 'label', text: 'Starting sprite service…' }),
        h('div', null, ['The repo-scoped service is launching automatically. This view will refresh when it is ready.'])
      ]);
    }
    return h('div', { class: 'panel warn' }, [
      h('div', { class: 'label', text: 'Sprite service failed to start' }),
      h('div', null, [startup.error || 'The managed sprite service is unavailable.']),
      startup.logPath ? h('div', { class: 'muted', style: { marginTop: '6px' } }, ['Log: ', h('code', { text: startup.logPath })]) : null,
      h('div', { style: { marginTop: '8px' } }, ['Compatibility fallback: ', h('code', { text: 'npm run sprites:gallery' })]),
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
    var upscaleIn = h('input', {
      type: 'number',
      min: String(DEFAULT_UPSCALE_FACTOR),
      max: String(MAX_UPSCALE_FACTOR),
      step: '1',
      value: String(currentLiveUpscaleFactor)
    });
    tuningColorInput = colorIn;
    tuningFringeInput = fringeIn;
    tuningUpscaleInput = upscaleIn;
    var applyBtn = h('button', { type: 'button', text: 'Apply' });
    var resetBtn = h('button', { type: 'button', text: 'Reset' });
    applyBtn.addEventListener('click', function () {
      var prevColorToleranceSq = currentTweaks.colorToleranceSq;
      var prevFringeToleranceSq = currentTweaks.fringeToleranceSq;
      currentTweaks = {
        colorToleranceSq: clampTol(parseFloat(colorIn.value), DEFAULT_TWEAKS.colorToleranceSq),
        fringeToleranceSq: clampTol(parseFloat(fringeIn.value), DEFAULT_TWEAKS.fringeToleranceSq)
      };
      currentLiveUpscaleFactor = clampUpscaleFactor(
        parseFloat(upscaleIn.value),
        DEFAULT_UPSCALE_FACTOR
      );
      colorIn.value = String(currentTweaks.colorToleranceSq);
      fringeIn.value = String(currentTweaks.fringeToleranceSq);
      upscaleIn.value = String(currentLiveUpscaleFactor);
      // Stage persists only when tolerances changed. Live-only upscale is preview
      // input shaping and must not overwrite a staged reset intent.
      var tolerancesChanged =
        currentTweaks.colorToleranceSq !== prevColorToleranceSq ||
        currentTweaks.fringeToleranceSq !== prevFringeToleranceSq;
      if (tolerancesChanged) pendingMode = 'replace';
      liveFailed = false;
      startPipeline(currentState, renderToken);
    });
    resetBtn.addEventListener('click', function () {
      // Preview-only reset of the tolerance knobs (does NOT stage a persist-reset;
      // that is the authoring panel's "Reset to defaults", mode:'reset').
      currentTweaks = { colorToleranceSq: DEFAULT_TWEAKS.colorToleranceSq, fringeToleranceSq: DEFAULT_TWEAKS.fringeToleranceSq };
      currentLiveUpscaleFactor = DEFAULT_UPSCALE_FACTOR;
      colorIn.value = String(currentTweaks.colorToleranceSq);
      fringeIn.value = String(currentTweaks.fringeToleranceSq);
      upscaleIn.value = String(currentLiveUpscaleFactor);
      liveFailed = false;
      startPipeline(currentState, renderToken);
    });
    return h('div', { class: 'tuning' }, [
      h('div', { class: 'fld' }, [h('label', { text: 'colorToleranceSq' }), colorIn]),
      h('div', { class: 'fld' }, [h('label', { text: 'fringeToleranceSq' }), fringeIn]),
      h('div', { class: 'fld' }, [h('label', { text: 'upscaleFactor (live)' }), upscaleIn]),
      applyBtn, resetBtn,
      h('span', {
        class: 'muted',
        text: 'max ' + MAX_TOLERANCE + ' \u00b7 live preview (persists via Apply changes) \u00b7 upscale is live-only and does not persist'
      })
    ]);
  }

  // ── Authoring / persist panel ────────────────────────────────────
  function setApplyStatus(text, color) {
    if (!applyStatusEl) return;
    applyStatusEl.textContent = text || '';
    applyStatusEl.style.color = color || '#94a3b8';
  }

  function syncAnchorFromInputs() {
    if (!anchorXInput || !anchorYInput) return;
    var x = parseInt(anchorXInput.value, 10);
    var y = parseInt(anchorYInput.value, 10);
    // Monolith syncManualAnchorFromInputs: no-op if either coord is non-finite.
    if (!isFinite(x) || !isFinite(y)) return;
    currentAnchor = { x: x, y: y };
    pendingClear = false;
    pendingMode = 'replace';
    redrawAnchorMarker();
  }

  function makeAuthoringPanel(state) {
    var facingSel = h('select', { title: 'Facing direction to persist' });
    ['right', 'left'].forEach(function (dir) {
      var o = document.createElement('option');
      o.value = dir; o.textContent = dir;
      if (dir === currentFacing) o.selected = true;
      facingSel.appendChild(o);
    });
    facingSel.addEventListener('change', function () {
      currentFacing = facingSel.value === 'left' ? 'left' : 'right';
      pendingMode = 'replace';
    });

    var scopeSel = h('select', { title: 'Which variants the persist applies to' });
    [['variant', 'This variant'], ['all', 'All variants']].forEach(function (pair) {
      var o = document.createElement('option');
      o.value = pair[0]; o.textContent = pair[1];
      if (pair[0] === currentScope) o.selected = true;
      scopeSel.appendChild(o);
    });
    scopeSel.addEventListener('change', function () {
      currentScope = scopeSel.value === 'all' ? 'all' : 'variant';
      pendingMode = 'replace';
    });

    anchorXInput = h('input', { type: 'number', step: '1', value: currentAnchor ? String(currentAnchor.x) : '' });
    anchorYInput = h('input', { type: 'number', step: '1', value: currentAnchor ? String(currentAnchor.y) : '' });
    anchorXInput.addEventListener('change', syncAnchorFromInputs);
    anchorYInput.addEventListener('change', syncAnchorFromInputs);

    var resetAnchorBtn = h('button', { type: 'button', text: 'Reset anchor' });
    resetAnchorBtn.addEventListener('click', function () {
      // Clear the manual anchor but STAY a 'replace' persist (sends manualAnchor:null),
      // matching the monolith resetAnchorBtn (mode stays 'replace').
      currentAnchor = null;
      pendingClear = true;
      pendingMode = 'replace';
      anchorXInput.value = '';
      anchorYInput.value = '';
      redrawAnchorMarker();
    });

    var resetDefaultsBtn = h('button', { type: 'button', class: 'danger', text: 'Reset to defaults' });
    resetDefaultsBtn.addEventListener('click', function () {
      // Stage a full persist-reset (mode:'reset', monolith resetTweaksBtn): visually
      // reset the knobs + authoring state; the actual clear happens server-side on
      // Apply changes. Also refresh the live preview with default tolerances.
      currentTweaks = { colorToleranceSq: DEFAULT_TWEAKS.colorToleranceSq, fringeToleranceSq: DEFAULT_TWEAKS.fringeToleranceSq };
      if (tuningColorInput) tuningColorInput.value = String(currentTweaks.colorToleranceSq);
      if (tuningFringeInput) tuningFringeInput.value = String(currentTweaks.fringeToleranceSq);
      currentLiveUpscaleFactor = DEFAULT_UPSCALE_FACTOR;
      if (tuningUpscaleInput) tuningUpscaleInput.value = String(currentLiveUpscaleFactor);
      currentFacing = 'right'; facingSel.value = 'right';
      currentScope = 'variant'; scopeSel.value = 'variant';
      currentAnchor = null; pendingClear = false;
      anchorXInput.value = ''; anchorYInput.value = '';
      pendingMode = 'reset';
      redrawAnchorMarker();
      liveFailed = false;
      startPipeline(currentState, renderToken);
    });

    var applyBtn = h('button', { type: 'button', class: 'primary', text: 'Apply changes' });
    applyBtn.addEventListener('click', applyChanges);
    authoringApplyBtn = applyBtn;

    applyStatusEl = h('span', { class: 'apply-status' });
    if (applyNote) {
      applyStatusEl.textContent = applyNote.text;
      applyStatusEl.style.color = applyNote.color;
      applyNote = null;
    }

    return h('div', { class: 'authoring' }, [
      h('div', { class: 'fld' }, [h('label', { text: 'facing' }), facingSel]),
      h('div', { class: 'fld' }, [h('label', { text: 'apply scope' }), scopeSel]),
      h('div', { class: 'fld' }, [h('label', { text: 'anchor x' }), anchorXInput]),
      h('div', { class: 'fld' }, [h('label', { text: 'anchor y' }), anchorYInput]),
      resetAnchorBtn, resetDefaultsBtn, applyBtn, applyStatusEl
    ]);
  }

  function applyChanges() {
    if (!currentState || !currentState.selected) return;
    if (applyInFlight) return; // a persist is already pending — ignore the re-click
    var sel = currentState.selected;
    var mode = pendingMode === 'reset' ? 'reset' : 'replace';
    var applyToAll = currentScope === 'all';
    // Confirm-guard destructive persists (reset clears everything; all-variants
    // clobbers siblings). The monolith has no confirm; this is an intentional
    // safety affordance for the canvas tool (isDestructivePersist is the SAME
    // unit-tested predicate the server uses).
    if (isDestructivePersist({ mode: mode, applyToAll: applyToAll })) {
      var msg = mode === 'reset'
        ? 'Reset ALL postprocess overrides for this run to defaults? This clears the persisted background tolerances, facing, and manual anchor.'
        : 'Apply these overrides to ALL variants of this run? This overwrites every variant\u2019s facing and anchor.';
      if (!window.confirm(msg)) return;
    }
    var body = {
      briefId: sel.briefId, runId: sel.runId, mode: mode,
      variantIndex: sel.variantIndex, applyToAll: applyToAll,
      facingDirection: currentFacing,
      colorToleranceSq: currentTweaks.colorToleranceSq,
      fringeToleranceSq: currentTweaks.fringeToleranceSq
    };
    if (pendingClear) body.manualAnchorClear = true;
    else if (currentAnchor) body.manualAnchor = { x: currentAnchor.x, y: currentAnchor.y };
    setApplyStatus('Applying\u2026', '#94a3b8');
    setBusy(true, 'Persisting overrides\u2026');
    applyInFlight = true;
    if (authoringApplyBtn) authoringApplyBtn.disabled = true;
    var persistHeaders = { 'Content-Type': 'application/json' };
    if (EMBED_TOKEN) persistHeaders['x-workflow-mutation-token'] = EMBED_TOKEN;
    fetch(BASE + '/api/persist-postprocess', {
      method: 'POST', headers: persistHeaders,
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); }).then(function (resp) {
      setBusy(false);
      applyInFlight = false;
      if (resp && resp.ok && resp.state) {
        // Single re-render from the fresh (re-seeded) state; render() bumps
        // renderToken so any in-flight pre-apply live relay is dropped. applyNote
        // survives the re-render to show the "Saved" confirmation. render()
        // rebuilds the authoring panel with a fresh, enabled Apply button.
        applyNote = { text: 'Saved \u2713', color: '#86efac' };
        render(resp.state);
      } else {
        if (authoringApplyBtn) authoringApplyBtn.disabled = false;
        setApplyStatus('Failed: ' + ((resp && (resp.message || resp.reason)) || 'unknown'), '#fca5a5');
      }
    }).catch(function (err) {
      setBusy(false);
      applyInFlight = false;
      if (authoringApplyBtn) authoringApplyBtn.disabled = false;
      setApplyStatus('Failed: ' + err, '#fca5a5');
    });
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
    var label = h('div', { class: 'label', text: 'Final output' });
    if (!src) {
      finalImgEl = null;
      finalMarkerEl = null;
      return h('div', { class: 'step final' }, [label, h('span', { class: 'muted', text: 'No final output available.' })]);
    }
    var img = h('img', { class: 'checker anchorable', src: src, alt: 'final output',
      title: 'Click to set a manual anchor (final-image pixel space)' });
    var marker = h('div', { class: 'marker', style: { display: 'none' } });
    var wrap = h('div', { class: 'wrap' }, [img, marker]);
    finalImgEl = img;
    finalMarkerEl = marker;
    img.addEventListener('load', function () { redrawAnchorMarker(); });
    img.addEventListener('click', function (ev) {
      var rect = img.getBoundingClientRect();
      var a = finalImageClickToAnchor({
        clientX: ev.clientX, clientY: ev.clientY, rect: rect,
        naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight
      });
      if (!a) return;
      currentAnchor = { x: a.x, y: a.y };
      pendingClear = false;
      pendingMode = 'replace';
      if (anchorXInput) anchorXInput.value = String(a.x);
      if (anchorYInput) anchorYInput.value = String(a.y);
      redrawAnchorMarker();
    });
    return h('div', { class: 'step final' }, [label, wrap]);
  }

  // Position the anchor marker over the final image (center-of-pixel percent).
  function redrawAnchorMarker() {
    if (!finalImgEl || !finalMarkerEl) return;
    if (!currentAnchor || !finalImgEl.complete || !finalImgEl.naturalWidth) {
      finalMarkerEl.style.display = 'none';
      return;
    }
    var pct = anchorMarkerPercent({
      x: currentAnchor.x, y: currentAnchor.y,
      naturalWidth: finalImgEl.naturalWidth, naturalHeight: finalImgEl.naturalHeight
    });
    if (!pct) { finalMarkerEl.style.display = 'none'; return; }
    finalMarkerEl.style.display = '';
    finalMarkerEl.style.left = pct.leftPct + '%';
    finalMarkerEl.style.top = pct.topPct + '%';
    finalMarkerEl.style.background = '#facc15';
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
            return maybeUpscaleBase64(b64, currentLiveUpscaleFactor);
          }
        } catch (e) { /* tainted/oversize — fall through to stored raw */ }
      }
    }
    var url = imgUrl('raw', sel.briefId, sel.runId, pad2(sel.variantIndex) + '.png');
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('raw ' + r.status);
      return r.blob();
    }).then(function (blob) {
      return blobToBase64(blob).then(function (b64) {
        return maybeUpscaleBase64(b64, currentLiveUpscaleFactor);
      });
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
      return fetch(BASE + '/api/live-postprocess', {
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

  // ── Embedded-host bridge (postMessage) ────────────────────────────
  // Only active when EMBEDDED (BASE non-empty) — the standalone canvas's
  // parent is the host's own iframe chrome, not a Workflow document, so it
  // has no 'postprocess:select' contract to listen for and nothing useful to
  // notify. Same-origin only (window.location.origin — this document and its
  // embedding parent are served by the SAME loopback server/port).
  function notifyReady(state) {
    if (!EMBEDDED) return;
    var sel = state && state.selected;
    var context = sel ? {
      briefId: sel.briefId,
      runId: sel.runId,
      variantIndex: sel.variantIndex,
      sheet: sel.activeSheet
    } : null;
    try {
      // Same-origin embedded canvases can call the parent directly. This avoids
      // losing a fast first-paint signal during iframe startup. Keep postMessage
      // as a fallback for hosts that intentionally hide parent properties.
      if (typeof window.parent.__workflowPostprocessReady === 'function') {
        window.parent.__workflowPostprocessReady(context);
        return;
      }
      window.parent.postMessage({
        type: 'postprocess:ready',
        context: context
      }, window.location.origin);
    } catch (e) { /* no-op — a detached/closed parent must never break the iframe */ }
  }

  if (EMBEDDED) {
    window.addEventListener('message', function (ev) {
      if (ev.source !== window.parent || ev.origin !== window.location.origin) return;
      var msg = ev.data;
      if (!msg || msg.type !== 'postprocess:select') return;
      // Reuses the SAME select() the run/variant pickers call — no separate
      // reload path, so an already-open iframe retargets in place instead of
      // resetting its authoring/tuning state via a fresh document load.
      select(
        msg.briefId, msg.runId,
        typeof msg.variantIndex === 'number' ? msg.variantIndex : undefined,
        msg.sheet || null
      );
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
    finalImgEl = null;
    finalMarkerEl = null;

    // Reset tolerance knobs from the run's persisted overrides (or defaults).
    var applied = state.selected && state.selected.appliedBackground;
    currentTweaks = applied
      ? { colorToleranceSq: applied.colorToleranceSq, fringeToleranceSq: applied.fringeToleranceSq }
      : { colorToleranceSq: DEFAULT_TWEAKS.colorToleranceSq, fringeToleranceSq: DEFAULT_TWEAKS.fringeToleranceSq };

    // Reset authoring state to defaults FIRST, THEN layer persisted overrides
    // (default-first seeding — mirrors the monolith read-back at ~5939-6022). A
    // fresh render always starts from a clean authoring slate; nothing is staged
    // (pendingMode 'default') until the user edits a control.
    currentFacing = 'right';
    currentScope = 'variant';
    currentAnchor = null;
    pendingClear = false;
    pendingMode = 'default';
    anchorXInput = null;
    anchorYInput = null;
    var appliedFacing = state.selected && state.selected.appliedFacing;
    if (appliedFacing) {
      if (appliedFacing.direction === 'left' || appliedFacing.direction === 'right') {
        currentFacing = appliedFacing.direction;
      }
      if (appliedFacing.applyToAllVariants === true) currentScope = 'all';
    }
    var appliedAnchor = state.selected && state.selected.appliedManualAnchor;
    if (appliedAnchor && typeof appliedAnchor.x === 'number' && typeof appliedAnchor.y === 'number') {
      currentAnchor = { x: appliedAnchor.x, y: appliedAnchor.y };
      if (appliedAnchor.applyToAllVariants === true) currentScope = 'all';
    }

    var frag = document.createDocumentFragment();
    frag.appendChild(renderHealth(state));
    if (state.error) frag.appendChild(h('div', { class: 'panel error', style: { marginTop: '12px' }, text: state.error }));
    if (!state.health || state.health.state !== 'up') {
      frag.appendChild(h('div', { style: { marginTop: '12px' } }, [renderDegrade(state)]));
      app.replaceChildren(frag);
      notifyReady(state);
      return;
    }
    if (!state.runs || state.runs.length === 0) {
      frag.appendChild(h('div', { class: 'panel warn', style: { marginTop: '12px' } },
        ['No sprite runs found yet. Generate a run from the Sprite Generation Workflow, then reopen this debugger.']));
      app.replaceChildren(frag);
      notifyReady(state);
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
      pipelineBody.appendChild(makeAuthoringPanel(state));
      var stepsHost = h('div', {}, [h('div', { class: 'muted', text: 'Loading pipeline trace\u2026' })]);
      pipelineBody.appendChild(stepsHost);
      // re-point pipelineBody at the steps host so live/prebaked replace only steps,
      // leaving the slicing card + tuning panel intact
      pipelineBody = stepsHost;
    }
    frag.appendChild(pipeSection);
    app.replaceChildren(frag);
    notifyReady(state);

    // if there are no sheets, the sheet section won't fire onload — kick the
    // pipeline now (raw-input fallback). With sheets, onload drives it.
    if (state.selected && (!state.selected.sheets || state.selected.sheets.length === 0)) {
      startPipeline(state, token);
    }
  }

  // ── Selection + busy + boot ──────────────────────────────────────
  var selecting = false;
  var pendingSelection = null;
  function runPendingSelection() {
    if (!pendingSelection) return false;
    var next = pendingSelection;
    pendingSelection = null;
    select(next.briefId, next.runId, next.variant, next.sheet);
    return true;
  }
  function select(briefId, runId, variant, sheet) {
    if (selecting) {
      pendingSelection = { briefId: briefId, runId: runId, variant: variant, sheet: sheet };
      return;
    }
    selecting = true;
    setBusy(true, 'Loading run\u2026');
    var url = BASE + '/api/select?briefId=' + encodeURIComponent(briefId) + '&runId=' + encodeURIComponent(runId);
    if (typeof variant === 'number' && !isNaN(variant)) url += '&variant=' + encodeURIComponent(variant);
    if (sheet) url += '&sheet=' + encodeURIComponent(sheet);
    fetch(url).then(function (r) { return r.json(); }).then(function (state) {
      selecting = false;
      setBusy(false);
      if (runPendingSelection()) return;
      render(state);
    }).catch(function () {
      selecting = false;
      setBusy(false);
      runPendingSelection();
    });
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

  // Boot must render exactly once. loadState() (GET /api/state) AND the harness's
  // unconditional SSE initial-state frame both deliver the same boot state; rendering
  // both would run the live postprocess relay twice on open (the seq guard drops the
  // stale response, but both still hit the sidecar). Whichever arrives first renders
  // boot and sets bootRendered; the redundant initial SSE frame is then dropped. If
  // loadState fails, bootRendered stays false so the initial SSE frame can recover.
  var bootRendered = false;
  var sseInitialSeen = false;

  function loadState(label, isBoot) {
    setBusy(true, label || 'Loading from sidecar\u2026');
    return fetch(BASE + '/api/state').then(function (r) { return r.json(); }).then(function (state) {
      setBusy(false);
      if (isBoot && bootRendered) return; // SSE initial frame already rendered boot
      bootRendered = true;
      render(state);
    }).catch(function (err) {
      setBusy(false);
      // On boot failure leave bootRendered false so the SSE initial frame can recover.
      app.replaceChildren(h('div', { class: 'panel error', text: 'Failed to load state: ' + err }));
    });
  }

  if (refreshBtn) refreshBtn.addEventListener('click', function () { loadState('Refreshing\u2026', false); });

  function connect() {
    try {
      var es = new EventSource(BASE + '/events');
      es.onmessage = function (ev) {
        try {
          var msg = JSON.parse(ev.data);
          if (!msg || msg.type !== 'state') return;
          if (!sseInitialSeen) {
            sseInitialSeen = true;
            // The harness sends one unconditional state frame on connect. Drop it if
            // loadState already rendered boot (avoids a duplicate live relay); otherwise
            // render it (loadState in-flight or failed) so the view appears / recovers.
            if (bootRendered) return;
            bootRendered = true;
          }
          render(msg.state);
        } catch (e) { /* ignore malformed frame */ }
      };
      es.onerror = function () { /* browser auto-reconnects */ };
    } catch (e) { /* EventSource unsupported */ }
  }

  loadState(undefined, true);
  connect();
})();
`;

/**
 * Full HTML document for one canvas instance.
 *
 * @param {string} instanceId
 * @param {string} [basePath] '' for the standalone canvas (root-relative
 *   transport paths, unchanged); a non-empty prefix (e.g. '/postprocess') when
 *   this SAME document is mounted under another canvas's own loopback server
 *   (see workflow/extension.mjs's namespaced routes). Every fetch/EventSource
 *   URL in the client script is prefixed with this value.
 * @param {string} [mutationToken] sent as `x-workflow-mutation-token` on the
 *   persisting Apply-changes write ONLY when non-empty (embedded case); the
 *   standalone canvas's persist route has no token to check.
 * @returns {string}
 */
export function renderHtml(instanceId, basePath = '', mutationToken = '') {
  const clientScript = CLIENT_SCRIPT.replace('/*__OVERLAY_FNS__*/', () => overlayFnsSource())
    .replace('/*__ANCHOR_FNS__*/', () => anchorFnsSource())
    .replace('__POSTPROCESS_BASE_PATH__', JSON.stringify(basePath))
    .replace('__POSTPROCESS_MUTATION_TOKEN__', JSON.stringify(mutationToken));
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
