/**
 * renderer.mjs — the sprite-generation-workflow canvas iframe document.
 *
 * `renderHtml(instanceId)` returns a complete, self-contained HTML document (the
 * host embeds it in an iframe with no privileged bridge). All data comes from the
 * extension's own loopback server:
 *   - `GET /api/state`  — the full read view model (health + backlog + plan/brief
 *     listing + runs + selected run), built
 *     server-side with per-section graceful degrade.
 *   - `GET /events`     — SSE; the server pushes a fresh state after selection.
 *   - `GET /api/select?briefId=&runId=&sheet=` — change the selected run/sheet.
 *   - `GET /api/plan?relPath=` / `GET /api/brief?relPath=` — YAML content for the
 *     browser (server resolves ONLY allowlisted paths — no traversal).
 *   - `GET /img/sheet|processed?briefId=&runId=&file=` — binary image proxies.
 *
 * The canvas browses the asset backlog, plans/briefs, and generated runs. Its
 * focused write action accepts one variant through the sidecar's atomic
 * approve-and-check-in operation.
 *
 * The client script is intentionally template-literal-free (plain string concat +
 * createElement) so this whole file stays one clean outer template literal with no
 * escaping. The handful of PURE helpers below (run search filter, sheet display
 * sizing, judge/sensor summaries) are the one exception:
 * they are self-contained (no imports/closures) modules under `lib/`, unit-tested
 * directly in Node, and spliced into the client script here via
 * `Function.prototype.toString()` — the SAME tested code runs in the iframe (the
 * pattern already used by `postprocess/renderer.mjs`).
 *
 * @module workflow/renderer
 */

import * as runFilterFns from './lib/run-filter.mjs';
import * as sheetDisplayFns from './lib/sheet-display.mjs';
import * as feedbackSummaryFns from './lib/feedback-summary.mjs';
import * as briefLookupFns from './lib/brief-lookup.mjs';

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Serialize a module's exported pure functions into browser source (`var name
 * = function name(...) {...};` declarations), the same way
 * `postprocess/renderer.mjs` splices `lib/slice-overlay.mjs` /
 * `lib/anchor.mjs`. Every module passed here is self-contained (no imports,
 * no closures over module scope) so `toString()` yields runnable source.
 * @param {object} mod
 * @returns {string}
 */
function serializePureModule(mod) {
  return Object.keys(mod)
    .filter((name) => typeof mod[name] === 'function')
    .map((name) => 'var ' + name + ' = ' + mod[name].toString() + ';')
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
  header { margin-bottom: 12px; }
  select, button, input, textarea {
    background: #0f172a; color: #e2e8f0;
    border: 1px solid rgba(148,163,184,0.35); border-radius: 6px;
    padding: 6px 10px; font-size: 13px; font-family: inherit;
  }
  textarea { width: 100%; min-height: 180px; resize: vertical; font-family: var(--font-mono, monospace); font-size: 12px; }
  button { cursor: pointer; }
  .badge { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
    padding: 3px 8px; border-radius: 999px; border: 1px solid transparent; }
  .badge.up { color: #86efac; border-color: rgba(134,239,172,0.4); background: rgba(134,239,172,0.08); }
  .badge.down { color: #fca5a5; border-color: rgba(252,165,165,0.4); background: rgba(252,165,165,0.08); }
  .badge.wrong-repo { color: #fde68a; border-color: rgba(253,230,138,0.4); background: rgba(253,230,138,0.08); }
  .panel { padding: 16px; border-radius: 8px; border: 1px solid rgba(148,163,184,0.25); background: #0f172a; }
  .panel.warn { background: #78350f; color: #fef3c7; border-color: rgba(255,255,255,0.18); }
  .panel.error { background: #7f1d1d; color: #fef3c7; }
  .panel.info { background: #0c4a6e; color: #e0f2fe; border-color: rgba(125,211,252,0.35); }
  code { font-family: var(--font-mono, "SFMono-Regular", Consolas, monospace); font-size: 12px;
    background: rgba(148,163,184,0.15); padding: 1px 5px; border-radius: 4px; }
  pre.yaml { font-family: var(--font-mono, "SFMono-Regular", Consolas, monospace); font-size: 12px;
    background: #0b1220; border: 1px solid rgba(148,163,184,0.25); border-radius: 8px; padding: 12px;
    overflow: auto; max-height: 60vh; white-space: pre; margin: 8px 0 0; }
  .sheet-wrap { position: relative; display: inline-block; border: 1px solid rgba(148,163,184,0.2);
    border-radius: 8px; background: #0f172a; padding: 12px; overflow: auto; max-width: 100%; }
  .sheet-img { image-rendering: pixelated; display: block; max-width: 100%; }
  .cell-box { position: absolute; border: 1px solid rgba(56,189,248,0.7); box-sizing: border-box;
    pointer-events: none; }
  .cell-idx { position: absolute; top: 0; left: 0; font-size: 9px; background: rgba(2,6,23,0.75);
    color: #7dd3fc; padding: 0 3px; border-radius: 0 0 4px 0; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
  .card { border: 1px solid rgba(148,163,184,0.25); border-radius: 8px; padding: 10px; background: #0b1220;
    display: flex; flex-direction: column; gap: 6px; }
  .card .thumb { width: 96px; height: 96px; image-rendering: pixelated; align-self: center;
    background: #1e293b; border-radius: 6px; }
  .status-pill { align-self: flex-start; font-size: 10px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.04em; }
  .accept-button { width: 100%; margin-top: 6px; border-color: rgba(56,189,248,0.65);
    background: rgba(14,116,144,0.28); color: #e0f2fe; font-weight: 700; }
  .accept-button:hover:not(:disabled) { background: rgba(14,116,144,0.48); }
  .accept-button:disabled { opacity: 0.65; cursor: default; }
  .unapprove-button { width: 100%; margin-top: 4px; border-color: rgba(252,165,165,0.45);
    background: rgba(127,29,29,0.18); color: #fecaca; font-weight: 600; font-size: 11px; }
  .unapprove-button:hover:not(:disabled) { background: rgba(127,29,29,0.36); }
  .unapprove-button:disabled { opacity: 0.65; cursor: default; }
  .accept-state { margin-top: 6px; padding: 7px 8px; border-radius: 6px; font-size: 11px; }
  .accept-state.queued { color: #bbf7d0; background: rgba(22,101,52,0.28);
    border: 1px solid rgba(134,239,172,0.35); }
  .accept-state.error { color: #fecaca; background: rgba(127,29,29,0.34);
    border: 1px solid rgba(252,165,165,0.35); }
  .accept-state.warn { color: #fde68a; background: rgba(120,53,15,0.4);
    border: 1px solid rgba(253,230,138,0.4); }
  .accept-state a { color: inherit; font-weight: 700; }
  .unapprove-state { margin-top: 4px; padding: 6px 8px; border-radius: 6px; font-size: 11px; }
  .unapprove-state.evicted { color: #fca5a5; background: rgba(127,29,29,0.22);
    border: 1px solid rgba(252,165,165,0.3); }
  .unapprove-state.error { color: #fecaca; background: rgba(127,29,29,0.34);
    border: 1px solid rgba(252,165,165,0.35); }
  .axis { display: flex; justify-content: space-between; font-size: 11px; }
  .axis .lbl { font-weight: 600; }
  .rationale { font-size: 10px; color: #94a3b8; line-height: 1.35; }
  .sensor { display: flex; justify-content: space-between; font-size: 11px; }
  .sensor-reason { font-size: 10px; color: #fecaca; line-height: 1.3; }
  .section-title { font-weight: 600; font-size: 12px; color: #f1f5f9; margin: 6px 0 2px; }
  hr { border: none; border-top: 1px solid rgba(148,163,184,0.18); margin: 6px 0; }
  .toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 12px;
    padding-bottom: 10px; border-bottom: 1px solid rgba(148,163,184,0.15); }
  .toolbar button { display: inline-flex; align-items: center; gap: 6px; }
  .toolbar button:disabled { opacity: 0.55; cursor: default; }
  .busy { display: inline-flex; align-items: center; gap: 7px; color: var(--text-color-muted, #94a3b8);
    font-size: 12px; }
  .busy[hidden] { display: none; }
  .spinner { width: 13px; height: 13px; border: 2px solid rgba(148,163,184,0.3);
    border-top-color: #7dd3fc; border-radius: 50%; display: inline-block; animation: sr-spin 0.8s linear infinite; }
  .sheet-loading { display: inline-flex; align-items: center; gap: 7px; color: var(--text-color-muted, #94a3b8);
    font-size: 12px; padding: 8px 4px; }
  @keyframes sr-spin { to { transform: rotate(360deg); } }
  .tabs { display: flex; gap: 4px; flex-wrap: wrap; margin: 12px 0; border-bottom: 1px solid rgba(148,163,184,0.15); }
  .tab { background: transparent; border: 1px solid transparent; border-bottom: none; border-radius: 6px 6px 0 0;
    padding: 7px 12px; font-size: 12px; color: #94a3b8; }
  .tab.active { color: #e2e8f0; background: #0f172a; border-color: rgba(148,163,184,0.25); }
  .tab .count { color: #64748b; font-size: 11px; margin-left: 4px; }
  table.grid { border-collapse: collapse; width: 100%; margin-top: 8px; font-size: 12px; }
  table.grid th, table.grid td { text-align: left; padding: 5px 8px; border-bottom: 1px solid rgba(148,163,184,0.15);
    vertical-align: top; }
  table.grid th { color: #cbd5e1; font-weight: 600; position: sticky; top: 0; background: #0b1120; }
  table.grid tr:hover td { background: rgba(148,163,184,0.06); }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; }
  .chip { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid rgba(148,163,184,0.25);
    background: #0b1220; }
  .chip b { color: #e2e8f0; }
  .plan-card { border: 1px solid rgba(148,163,184,0.22); border-radius: 8px; padding: 12px; margin-bottom: 12px;
    background: #0f172a; }
  .filelist { display: flex; flex-direction: column; gap: 2px; max-height: 60vh; overflow: auto;
    border: 1px solid rgba(148,163,184,0.2); border-radius: 8px; padding: 6px; }
  .filelist button { text-align: left; background: transparent; border: 1px solid transparent; padding: 4px 8px;
    border-radius: 6px; font-size: 12px; color: #cbd5e1; width: 100%; }
  .filelist button:hover { background: rgba(148,163,184,0.08); }
  .filelist button.active { background: rgba(56,189,248,0.12); border-color: rgba(56,189,248,0.4); color: #e2e8f0; }
  .split { display: grid; grid-template-columns: minmax(220px, 320px) 1fr; gap: 12px; align-items: start; }
  .draft-tag { font-size: 9px; color: #fde68a; border: 1px solid rgba(253,230,138,0.4); border-radius: 4px;
    padding: 0 4px; margin-left: 6px; }
  .stale-badge { font-size: 10px; color: #fde68a; border: 1px solid rgba(253,230,138,0.4);
    border-radius: 999px; padding: 2px 8px; display: inline-flex; align-items: center; gap: 5px; }
  .stale-badge .spinner { width: 9px; height: 9px; border-width: 1.5px; }
  .lifecycle-pill { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em;
    padding: 2px 7px; border-radius: 999px; border: 1px solid transparent; align-self: flex-start; }
  .lifecycle-pill.unaccepted { color: #94a3b8; border-color: rgba(148,163,184,0.35); background: rgba(148,163,184,0.08); }
  .lifecycle-pill.accepted-staged { color: #7dd3fc; border-color: rgba(125,211,252,0.4); background: rgba(14,116,144,0.16); }
  .lifecycle-pill.integrated { color: #86efac; border-color: rgba(134,239,172,0.4); background: rgba(22,101,52,0.18); }
  .lifecycle-pill.unverified { color: #c4b5fd; border-color: rgba(196,181,253,0.4); background: rgba(88,28,135,0.18); }
  .criterion-feedback { display: flex; flex-direction: column; gap: 4px; margin: 3px 0 7px; }
  .criterion-feedback .feedback-verdict-row,
  .criterion-feedback .feedback-comment-row { display: flex; align-items: center; gap: 6px; }
  .criterion-feedback .feedback-comment-row[hidden] { display: none; }
  .criterion-feedback button.thumb { width: 28px; height: 28px; min-width: 28px; padding: 0; font-size: 14px;
    line-height: 1; display: inline-flex; align-items: center; justify-content: center; flex: 0 0 28px; }
  .criterion-feedback button.thumb.on { border-color: #7dd3fc; background: rgba(14,116,144,0.35); }
  .criterion-feedback input { min-width: 0; padding: 5px 7px; font-size: 11px; flex: 1; }
  .criterion-feedback button.confirm-btn { padding: 2px 8px; font-size: 11px; color: #64748b; }
  .criterion-feedback button.confirm-btn[hidden] { display: none; }
  .criterion-feedback button.confirm-btn.dirty { color: #fde68a; border-color: rgba(253,230,138,0.5);
    background: rgba(120,53,15,0.25); }
  .criterion-feedback .feedback-status { font-size: 9px; }
  .run-search { min-width: 160px; }
  .details-summary { cursor: pointer; font-size: 11px; color: #7dd3fc; margin-top: 4px; }
  .details-summary::-webkit-details-marker { color: #7dd3fc; }
  .concise-summary { font-size: 11px; }
  .concise-summary.pass { color: #86efac; }
  .concise-summary.fail { color: #fca5a5; }
  .concise-summary.unjudged, .concise-summary.none { color: #94a3b8; }
  .sheet-toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
  .modal-backdrop { position: fixed; inset: 0; background: rgba(2,6,23,0.75); display: flex;
    align-items: center; justify-content: center; z-index: 1000; padding: 24px; }
  .modal-backdrop[hidden] { display: none; }
  .modal { background: #0f172a; border: 1px solid rgba(148,163,184,0.35); border-radius: 10px;
    max-width: min(720px, 90vw); max-height: 85vh; overflow: auto; padding: 16px 18px; }
  .modal h2 { margin: 0 0 8px; font-size: 15px; }
  .modal-close { float: right; }
  #postprocess-host { margin-top: 18px; border: 1px solid rgba(125,211,252,0.3); border-radius: 8px;
    background: #0b1220; }
  #postprocess-host[hidden] { display: none; }
  #postprocess-host .postprocess-host-head { display: flex; align-items: center; justify-content: space-between;
    gap: 10px; padding: 8px 12px; border-bottom: 1px solid rgba(148,163,184,0.15); }
  #postprocess-host .postprocess-host-head h2 { font-size: 13px; margin: 0; font-weight: 600; color: #7dd3fc; }
  #postprocess-host-status { font-size: 11px; color: #94a3b8; }
  #postprocess-host-body { min-height: 0; }
  #postprocess-host-body.collapsed { padding: 10px 12px; color: #94a3b8; font-size: 12px; }
  #postprocess-iframe { display: block; width: 100%; height: 720px; border: 0; background: #0b1120; }
`;

// NOTE: template-literal-free on purpose (no backticks, no ${}) — see file header.
// `/*__RUN_FILTER_FNS__*/` etc. are replaced with the serialized pure lib
// helpers below (Function.prototype.toString() splice — see renderHtml()).
const CLIENT_SCRIPT = String.raw`
(function () {
  'use strict';
  /*__RUN_FILTER_FNS__*/
  /*__SHEET_DISPLAY_FNS__*/
  /*__FEEDBACK_SUMMARY_FNS__*/
  /*__BRIEF_LOOKUP_FNS__*/
  var STATUS_COLORS = {
    pass: '#86efac', 'sensor-failed': '#fca5a5', 'judge-rejected': '#fca5a5', unjudged: '#94a3b8'
  };
  var ART_STATUS_COLORS = {
    'ready': '#86efac',
    'approved': '#5eead4',
    'approved-not-integrated': '#fde68a',
    'approved-missing-file': '#fca5a5',
    'approved-unverified': '#c4b5fd',
    'brief-ready': '#7dd3fc',
    'brief-ready-placeholder': '#38bdf8',
    'draft-ready': '#a5b4fc',
    'draft-ready-placeholder': '#818cf8',
    'needs-art-placeholder': '#94a3b8',
    'planned': '#64748b'
  };
  // Mirror the domain model's ALL_STATUSES ordering: the canvas-only
  // approved-unverified degrade status sorts LAST, after STATUS_ORDER.
  var STATUS_ORDER = [
    'ready', 'approved', 'approved-not-integrated', 'approved-missing-file',
    'brief-ready', 'brief-ready-placeholder', 'draft-ready', 'draft-ready-placeholder',
    'needs-art-placeholder', 'planned', 'approved-unverified'
  ];
  var JUDGE_AXES = [
    { key: 'designLanguage', label: 'Design language' },
    { key: 'referenceStyleMatch', label: 'Reference style' },
    { key: 'briefMatch', label: 'Brief match' },
    { key: 'readability', label: 'Readability' },
    { key: 'poseOrientation', label: 'Pose orientation' },
    { key: 'bossPresence', label: 'Boss presence' },
    { key: 'presentation', label: 'Presentation' },
    { key: 'themeAdherence', label: 'Theme adherence' }
  ];
  var TABS = [
    { id: 'author', label: 'Author' },
    { id: 'backlog', label: 'Backlog' },
    { id: 'files', label: 'Plans & Briefs' },
    { id: 'runs', label: 'Runs' }
  ];
  var app = document.getElementById('app');
  var mutationToken = __WORKFLOW_MUTATION_TOKEN__;
  var activeTab = 'author';
  var lastState = null;
  var openedFile = null; // { relPath, kind, content, error }
  var runFilter = 'all'; // all | promoted | not-promoted (matches sidecar API token)
  var runSearch = ''; // type-to-filter text over briefId/runId
  var sheetViewMode = 'constrained'; // 'constrained' (<=512x512) | 'full'
  var briefModal = null; // { relPath, name, content, error, triggerEl } | null

  // ── Embedded Postprocess Debugger host (persistent sibling of #app) ─────
  // #postprocess-host lives OUTSIDE #app in the static shell below (see
  // renderHtml) so app.replaceChildren(...) in render() NEVER touches it —
  // the lazily-created iframe (and all in-progress editor state inside it)
  // survives every SSE push / tab switch / refresh / feedback confirm.
  var postprocessHost = document.getElementById('postprocess-host');
  var postprocessBody = document.getElementById('postprocess-host-body');
  var postprocessStatusEl = document.getElementById('postprocess-host-status');
  var postprocessIframe = null;
  var postprocessIframeReady = false;
  var postprocessOpenStartedAt = 0;
  var postprocessExpectedContext = null;
  var postprocessReadyRecorded = false;

  /**
   * Reveal the (initially collapsed) host, lazily create ONE iframe on the
   * FIRST open (seeded via its initial URL's query string — see
   * workflow/extension.mjs's '/postprocess/' route), and on every LATER open
   * retarget that SAME iframe via a same-origin postMessage 'postprocess:select'.
   * Before the first document is ready, later clicks retarget its pending
   * navigation instead (there is no iframe message listener yet). Once ready,
   * authoring/tuning state is preserved. Always scrolls the host into view.
   */
  function postprocessSrc(context) {
    var qs = [];
    if (context.briefId) qs.push('briefId=' + encodeURIComponent(context.briefId));
    if (context.runId) qs.push('runId=' + encodeURIComponent(context.runId));
    if (typeof context.variantIndex === 'number') qs.push('variantIndex=' + encodeURIComponent(context.variantIndex));
    if (context.sheet) qs.push('sheet=' + encodeURIComponent(context.sheet));
    return '/postprocess/' + (qs.length ? ('?' + qs.join('&')) : '');
  }

  function openPostprocess(context) {
    if (!postprocessHost || !postprocessBody) return;
    postprocessHost.hidden = false;
    postprocessExpectedContext = {
      briefId: context.briefId,
      runId: context.runId,
      variantIndex: context.variantIndex,
      sheet: context.sheet
    };
    postprocessOpenStartedAt = (window.performance && performance.now) ? performance.now() : Date.now();
    postprocessReadyRecorded = false;
    if (postprocessStatusEl) postprocessStatusEl.textContent = 'Loading\u2026';
    if (!postprocessIframe) {
      postprocessIframe = document.createElement('iframe');
      postprocessIframe.id = 'postprocess-iframe';
      postprocessIframe.title = 'Postprocess Debugger';
      postprocessIframe.src = postprocessSrc(context);
      postprocessBody.className = '';
      postprocessBody.replaceChildren(postprocessIframe);
    } else if (!postprocessIframeReady) {
      postprocessIframe.src = postprocessSrc(context);
    } else {
      postprocessIframe.contentWindow.postMessage({
        type: 'postprocess:select',
        briefId: context.briefId, runId: context.runId,
        variantIndex: context.variantIndex, sheet: context.sheet
      }, window.location.origin);
    }
    postprocessHost.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Same-origin only: this document and the embedded iframe are served by the
  // SAME loopback server/port, so window.location.origin is the correct check
  // on both the sender (contentWindow.postMessage target) and receiver sides.
  function handlePostprocessReady(context) {
    if (
      postprocessReadyRecorded ||
      !postprocessIframe ||
      !context ||
      !postprocessExpectedContext
    ) return;
    if (
      context.briefId !== postprocessExpectedContext.briefId ||
      context.runId !== postprocessExpectedContext.runId ||
      (
        typeof postprocessExpectedContext.variantIndex === 'number' &&
        context.variantIndex !== postprocessExpectedContext.variantIndex
      ) ||
      (
        postprocessExpectedContext.sheet &&
        context.sheet !== postprocessExpectedContext.sheet
      )
    ) return;
    var now = (window.performance && performance.now) ? performance.now() : Date.now();
    var elapsedMs = Math.round(now - postprocessOpenStartedAt);
    postprocessIframeReady = true;
    postprocessReadyRecorded = true;
    window.__postprocessReadyMetric = { elapsedMs: elapsedMs, context: context };
    if (postprocessStatusEl) postprocessStatusEl.textContent = 'Ready \u00b7 ' + elapsedMs + ' ms';
  }
  window.__workflowPostprocessReady = handlePostprocessReady;

  function applyPostprocessPatch(patch) {
    if (!lastState || !lastState.selected || !patch) return;
    if (
      patch.briefId !== lastState.selected.briefId ||
      patch.runId !== lastState.selected.runId
    ) return;
    var isAll = patch.scope === 'all';
    var isVariant = patch.scope === 'variant' && typeof patch.variantIndex === 'number';
    if (!isAll && !isVariant) return;
    var replacements = Array.isArray(patch.candidates) ? patch.candidates : [];
    var patchTs = Date.now();
    // Build an index of the current candidates so we can preserve the
    // UI-owned feedback and lifecycle fields that composeState adds but that
    // the persisted (bare) patch data does not carry.
    var existingByIndex = {};
    (lastState.candidates || []).forEach(function (c) {
      if (c) existingByIndex[String(c.index)] = c;
    });
    lastState.candidates = replacements.map(function (r) {
      if (!r) return r;
      var existing = existingByIndex[String(r.index)];
      var out = Object.assign({}, r);
      if (existing) {
        if (existing.feedback !== undefined) out.feedback = existing.feedback;
        if (existing.lifecycle !== undefined) out.lifecycle = existing.lifecycle;
      }
      // Tag reprocessed-PNG variants with a cache-buster so the browser
      // fetches the new image rather than reusing a cached stale thumbnail.
      if (isAll || r.index === patch.variantIndex) out._patchTs = patchTs;
      return out;
    });
    lastState.stale = false;
    var staleBadge = document.querySelector('.stale-badge');
    if (staleBadge) staleBadge.remove();
    if (activeTab !== 'runs') return;
    // Re-render the full candidates section: a variant-scoped reprocess also
    // rebuilds every sibling's summary entry (clearing judge maps), so all
    // cards need refreshing, not just the target card.
    var section = document.querySelector('[data-workflow-candidates]');
    if (section) section.replaceWith(renderCandidates(lastState));
  }

  window.addEventListener('message', function (ev) {
    if (!postprocessIframe || ev.source !== postprocessIframe.contentWindow) return;
    if (ev.origin !== window.location.origin) return;
    var msg = ev.data;
    if (msg && msg.type === 'postprocess:ready') {
      handlePostprocessReady(msg.context || null);
    } else if (msg && msg.type === 'postprocess:applied') {
      applyPostprocessPatch(msg.patch || null);
    }
  });

  function h(tag, props, children) {
    var elem = document.createElement(tag);
    if (props) {
      for (var k in props) {
        if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
        if (k === 'style') { for (var s in props.style) { elem.style[s] = props.style[s]; } }
        else if (k === 'text') { elem.textContent = props[k]; }
        else if (k === 'class') { elem.className = props[k]; }
        else if (k === 'onclick') { elem.addEventListener('click', props[k]); }
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

  function statusPill(status) {
    return h('span', { class: 'status-pill', style: { color: ART_STATUS_COLORS[status] || '#94a3b8' },
      text: status });
  }

  function candidateStatus(c) {
    if (c.combinedPassed) return { kind: 'pass', label: 'PASS' };
    if (!c.passed) return { kind: 'sensor-failed', label: 'sensor fail' };
    if (c.judge && !c.judge.passed) return { kind: 'judge-rejected', label: 'judge fail' };
    return { kind: 'unjudged', label: 'not judged' };
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function imgUrl(kind, briefId, runId, file) {
    return '/img/' + kind + '?briefId=' + encodeURIComponent(briefId)
      + '&runId=' + encodeURIComponent(runId) + '&file=' + encodeURIComponent(file);
  }

  function renderHealth(state) {
    var health = state.health || { state: 'down' };
    var badge = h('span', { class: 'badge ' + health.state, text: health.state });
    var meta = [];
    if (health.version) meta.push('sidecar ' + health.version);
    if (health.storeBackend) meta.push(health.storeBackend);
    if (state.baseUrl) meta.push(state.baseUrl);
    var badges = [badge];
    if (state.stale) {
      badges.push(h('span', { class: 'stale-badge', title: 'Showing a cached view while a background refresh checks for updates.' },
        [h('span', { class: 'spinner' }), 'revalidating…']));
    }
    return h('div', { class: 'between' }, [
      h('div', null, [
        h('h1', { text: 'Sprite Generation Workflow' }),
        h('div', { class: 'muted', text: 'Inspect generated runs and accept a variant into the durable asset queue.' })
      ]),
      h('div', { class: 'row' }, badges.concat([h('span', { class: 'muted', text: meta.join('  ·  ') })]))
    ]);
  }

  function renderDegrade(state) {
    var health = state.health || { state: 'down' };
    if (health.state === 'wrong-repo') {
      return h('div', { class: 'panel warn' }, [
        h('div', { class: 'section-title', text: 'Sidecar is serving a different repo' }),
        h('div', null, ['The sprite sidecar answered, but its repoRoot does not match this worktree.']),
        h('div', { class: 'muted', style: { marginTop: '6px' } }, [
          'sidecar repoRoot: ', h('code', { text: health.repoRoot || '(unknown)' })
        ]),
        h('div', { class: 'muted' }, [
          'this workspace: ', h('code', { text: health.expectedRepoRoot || '(unknown)' })
        ]),
        h('div', { style: { marginTop: '8px' } }, ['Restart the sidecar from THIS worktree: ',
          h('code', { text: 'npm run sprites:gallery' })])
      ]);
    }
    var startup = state.sidecarStartup || {};
    if (startup.state === 'starting') {
      return h('div', { class: 'panel warn' }, [
        h('div', { class: 'section-title', text: 'Starting sprite service…' }),
        h('div', null, ['Runs are starting automatically. Backlog and plan/brief browsing remain available while startup completes.'])
      ]);
    }
    return h('div', { class: 'panel warn' }, [
      h('div', { class: 'section-title', text: 'Sprite service failed to start' }),
      h('div', null, [startup.error || 'The managed sprite service is unavailable.']),
      startup.logPath ? h('div', { class: 'muted', style: { marginTop: '6px' } }, ['Log: ', h('code', { text: startup.logPath })]) : null,
      h('div', { style: { marginTop: '8px' } }, ['Compatibility fallback: ', h('code', { text: 'npm run sprites:gallery' })]),
      state.baseUrl ? h('div', { class: 'muted', style: { marginTop: '6px' } },
        ['Expected at ', h('code', { text: state.baseUrl })]) : null
    ]);
  }

  // ---- Backlog tab -------------------------------------------------------
  function renderBacklog(state) {
    var backlog = state.backlog || {};
    var wrap = h('div', null, []);
    if (backlog.error) {
      wrap.appendChild(h('div', { class: 'panel error', text: 'Backlog failed to load: ' + backlog.error }));
      return wrap;
    }
    var reports = backlog.reports || [];
    if (reports.length === 0) {
      wrap.appendChild(h('div', { class: 'panel warn', text: 'No art plans found under plans/.' }));
      return wrap;
    }

    if (backlog.integrationResolved === false) {
      wrap.appendChild(h('div', { class: 'panel warn', style: { marginBottom: '10px' } }, [
        h('div', { class: 'section-title', text: 'Integration status unverified' }),
        h('div', null, ['The sprite/item registry could not be loaded, so registry-integration status is shown as ',
          h('code', { text: 'unverified' }), ' and approved assets that target the registry show ',
          h('code', { text: 'approved-unverified' }), ' instead of a guessed integrated/missing verdict.'])
      ]));
    }

    // Roll-up chips.
    var totals = backlog.totals || {};
    var chips = h('div', { class: 'chips' }, []);
    chips.appendChild(h('span', { class: 'chip' }, [h('b', { text: String(backlog.planCount || reports.length) }), ' plans']));
    chips.appendChild(h('span', { class: 'chip' }, [h('b', { text: String(backlog.unresolvedPlaceholders || 0) }), ' unresolved placeholders']));
    for (var si = 0; si < STATUS_ORDER.length; si++) {
      var st = STATUS_ORDER[si];
      var n = totals[st] || 0;
      if (n > 0) chips.appendChild(h('span', { class: 'chip', style: { color: ART_STATUS_COLORS[st] } },
        [h('b', { text: String(n) }), ' ' + st]));
    }
    wrap.appendChild(chips);

    for (var r = 0; r < reports.length; r++) {
      wrap.appendChild(renderPlanCard(reports[r], backlog.integrationResolved !== false));
    }
    return wrap;
  }

  function renderPlanCard(report, integrationResolved) {
    var card = h('div', { class: 'plan-card' }, []);
    card.appendChild(h('div', { class: 'between' }, [
      h('div', null, [
        h('strong', { text: report.title || report.planId }),
        h('div', { class: 'muted', text: report.summary || '' })
      ]),
      h('span', { class: 'muted', text: report.assets.length + ' assets' })
    ]));
    var table = h('table', { class: 'grid' }, []);
    table.appendChild(h('tr', null, [
      h('th', { text: 'Asset' }), h('th', { text: 'Type' }), h('th', { text: 'Status' }),
      h('th', { text: 'Integration' }), h('th', { text: 'Source run' })
    ]));
    for (var i = 0; i < report.assets.length; i++) {
      var a = report.assets[i];
      var integ = '—';
      if (a.integration) {
        integ = a.integration.kind + ':' + a.integration.id;
      }
      var integCell;
      if (a.integration) {
        var color = a.integrationState === 'integrated' ? '#86efac'
          : a.integrationState === 'missing' ? '#fca5a5'
          : a.integrationState === 'unverified' ? '#c4b5fd' : '#94a3b8';
        integCell = h('td', null, [
          h('span', { style: { color: color }, text: a.integrationState }),
          h('div', { class: 'muted', text: integ })
        ]);
      } else {
        integCell = h('td', { class: 'muted', text: 'n/a' });
      }
      table.appendChild(h('tr', null, [
        h('td', null, [h('div', { text: a.label || a.id }), h('div', { class: 'muted', text: a.briefId })]),
        h('td', { text: a.type }),
        h('td', null, [statusPill(a.status)]),
        integCell,
        h('td', { class: 'muted', text: a.sourceRun ? shortRun(a.sourceRun) : '—' })
      ]));
    }
    card.appendChild(table);
    return card;
  }

  function shortRun(sourceRun) {
    var parts = String(sourceRun).split('/');
    return parts[parts.length - 1] || sourceRun;
  }

  // ---- Plans & Briefs tab ------------------------------------------------
  function renderFiles(state) {
    var files = state.files || {};
    var wrap = h('div', null, []);
    if (files.error) {
      wrap.appendChild(h('div', { class: 'panel error', text: 'Plan/brief listing failed: ' + files.error }));
      return wrap;
    }
    var plans = files.plans || [];
    var briefs = files.briefs || [];
    var list = h('div', { class: 'filelist' }, []);
    list.appendChild(h('div', { class: 'section-title', text: 'Plans (' + plans.length + ')' }));
    for (var p = 0; p < plans.length; p++) list.appendChild(fileButton(plans[p], 'plan'));
    list.appendChild(h('div', { class: 'section-title', style: { marginTop: '8px' }, text: 'Briefs (' + briefs.length + ')' }));
    for (var b = 0; b < briefs.length; b++) list.appendChild(fileButton(briefs[b], 'brief'));

    var viewer = h('div', null, []);
    if (openedFile) {
      if (openedFile.error) {
        viewer.appendChild(h('div', { class: 'panel error', text: openedFile.error }));
      } else {
        viewer.appendChild(h('div', { class: 'row' }, [h('code', { text: openedFile.relPath })]));
        viewer.appendChild(h('pre', { class: 'yaml', text: openedFile.content || '' }));
      }
    } else {
      viewer.appendChild(h('div', { class: 'muted', text: 'Select a plan or brief to view its YAML.' }));
    }
    wrap.appendChild(h('div', { class: 'split' }, [list, viewer]));
    return wrap;
  }

  function fileButton(entry, kind) {
    var active = openedFile && openedFile.relPath === entry.relPath;
    var children = [entry.name || entry.relPath];
    if (entry.draft) children.push(h('span', { class: 'draft-tag', text: 'draft' }));
    return h('button', {
      class: active ? 'active' : '',
      title: entry.relPath,
      onclick: function () { openFile(entry.relPath, kind); }
    }, children);
  }

  function openFile(relPath, kind) {
    setBusy(true, 'Loading ' + kind + '…');
    var url = '/api/' + kind + '?relPath=' + encodeURIComponent(relPath);
    fetch(url).then(function (r) { return r.json(); }).then(function (data) {
      setBusy(false);
      if (data && data.error) openedFile = { relPath: relPath, kind: kind, error: data.error };
      else openedFile = { relPath: relPath, kind: kind, content: (data && data.content) || '' };
      if (lastState) render(lastState);
    }).catch(function (err) {
      setBusy(false);
      openedFile = { relPath: relPath, kind: kind, error: String(err) };
      if (lastState) render(lastState);
    });
  }

  // ---- Runs tab (reuses the sprite-review generation-output inspection) --
  function renderRunPicker(state) {
    var runs = filteredRuns(state);
    var sel = state.selected;
    var picker = h('select', { title: 'Select generated run' });
    for (var i = 0; i < runs.length; i++) {
      var run = runs[i];
      var opt = document.createElement('option');
      opt.value = run.briefId + '::' + run.runId;
      var count = (typeof run.candidateCount === 'number' && run.candidateCount >= 0)
        ? ' (' + run.candidateCount + ' variants)' : '';
      opt.textContent = (run.promoted ? '★ ' : '') + run.briefId + ' / ' + run.runId + count;
      if (sel && run.briefId === sel.briefId && run.runId === sel.runId) opt.selected = true;
      picker.appendChild(opt);
    }
    picker.addEventListener('change', function () {
      var parts = picker.value.split('::');
      if (parts.length === 2) select(parts[0], parts[1], null);
    });

    var filterSel = h('select', { title: 'Filter runs by promotion state' });
    var opts = [['all', 'All runs'], ['promoted', 'Promoted (★)'], ['not-promoted', 'Not promoted']];
    for (var f = 0; f < opts.length; f++) {
      var o = document.createElement('option');
      o.value = opts[f][0]; o.textContent = opts[f][1];
      if (opts[f][0] === runFilter) o.selected = true;
      filterSel.appendChild(o);
    }
    filterSel.addEventListener('change', function () { runFilter = filterSel.value; if (lastState) render(lastState); });

    // Plain type-to-filter TEXT INPUT (not a bespoke combobox) composed with
    // the native promotion <select> above — both preserve standard keyboard
    // (Tab/Arrow/Enter) and screen-reader behavior for free.
    var searchInput = h('input', {
      type: 'search',
      class: 'run-search',
      placeholder: 'Filter by briefId or runId…',
      'aria-label': 'Filter runs by briefId or runId',
      value: runSearch
    });
    searchInput.addEventListener('input', function () {
      runSearch = searchInput.value;
      if (lastState) render(lastState);
    });

    return h('div', { class: 'row', style: { marginTop: '10px', marginBottom: '4px' } }, [
      h('span', { class: 'muted', text: 'Run:' }), picker,
      h('span', { class: 'muted', text: 'Filter:' }), filterSel,
      searchInput,
      h('span', { class: 'muted', text: runs.length + ' shown' })
    ]);
  }

  function filteredRuns(state) {
    return filterRuns(state.runs || [], runFilter, runSearch);
  }

  // findBriefEntryByPath / findBriefEntryByBasename / resolveBriefEntry come
  // from the spliced lib/brief-lookup.mjs (the BRIEF_LOOKUP_FNS splice near
  // the top of this script) — resolveBriefEntry prefers the run's EXACT
  // briefPath and only falls back to the ambiguous basename match when no
  // exact path exists.

  function renderSheetSection(state) {
    var sel = state.selected;
    var sheets = state.sheets || [];
    var wrap = h('div', null, []);
    if (!sel) return wrap;

    if (state.autoSelectedLatest) {
      wrap.appendChild(h('div', { class: 'muted', style: { color: '#fde68a', marginBottom: '6px' },
        text: 'Auto-selected latest run (briefId/runId were not specified).' }));
    }

    var toolbar = h('div', { class: 'sheet-toolbar' }, []);
    var viewBriefBtn = h('button', { id: 'view-brief-btn', type: 'button', text: 'View Brief' });
    viewBriefBtn.addEventListener('click', function (ev) { openBriefModal(state, ev.currentTarget); });
    toolbar.appendChild(viewBriefBtn);
    toolbar.appendChild(renderPostprocessHandoff(sel, null));
    wrap.appendChild(toolbar);

    if (sheets.length === 0) {
      wrap.appendChild(h('div', { class: 'panel warn' }, ['No sprite sheets available for this run.']));
      return wrap;
    }

    var current = sel.sheet && sheets.indexOf(sel.sheet) >= 0 ? sel.sheet : sheets[0];
    if (sheets.length > 1) {
      var sheetPicker = h('select', { title: 'Select sheet' });
      for (var i = 0; i < sheets.length; i++) {
        var o = document.createElement('option');
        o.value = sheets[i]; o.textContent = sheets[i];
        if (sheets[i] === current) o.selected = true;
        sheetPicker.appendChild(o);
      }
      sheetPicker.addEventListener('change', function () { select(sel.briefId, sel.runId, sheetPicker.value); });
      wrap.appendChild(h('div', { class: 'row', style: { marginBottom: '6px' } },
        [h('span', { class: 'muted', text: 'Sheet:' }), sheetPicker]));
    }
    wrap.appendChild(h('div', { class: 'muted', style: { marginBottom: '6px' } },
      [h('code', { text: sel.briefId + ' / ' + sel.runId }), '  ', current]));

    var sliceMap = state.sliceMap;
    if (sliceMap && sliceMap.ok === false) {
      wrap.appendChild(h('div', { class: 'muted', style: { color: '#fca5a5', marginBottom: '6px' },
        text: 'Slice-map unavailable (' + (sliceMap.error || 'error') + ') — showing sheet without cell overlay.' }));
    } else if (sliceMap && sliceMap.emptyCellsApplied === false) {
      wrap.appendChild(h('div', { class: 'muted', style: { color: '#fde68a', marginBottom: '6px' },
        text: 'Degraded slice-map: brief could not be loaded, so cell indices are sequential and do NOT map to variant indices.' }));
    }

    // Presentation size toggle: DEFAULTS to constrained (<=512x512), never
    // upscaled; "Full size" shows the sheet at its natural pixel dimensions.
    // This ONLY changes the <img>'s CSS display box (computeSheetDisplaySize
    // is pure sizing math over natural width/height) — the <img> src (and so
    // the underlying asset's actual pixels) never changes between modes.
    var sizeSelect = h('select', { title: 'Sheet display size', 'aria-label': 'Sheet display size' });
    var sizeOpts = [['constrained', 'Fit to 512\u00d7512'], ['full', 'Full size']];
    for (var so = 0; so < sizeOpts.length; so++) {
      var sizeOpt = document.createElement('option');
      sizeOpt.value = sizeOpts[so][0]; sizeOpt.textContent = sizeOpts[so][1];
      if (sizeOpts[so][0] === sheetViewMode) sizeOpt.selected = true;
      sizeSelect.appendChild(sizeOpt);
    }
    wrap.appendChild(h('div', { class: 'row', style: { marginBottom: '6px' } },
      [h('span', { class: 'muted', text: 'Size:' }), sizeSelect]));

    var sheetWrap = h('div', { class: 'sheet-wrap' }, []);
    var loadingNote = h('div', { class: 'sheet-loading' }, [
      h('span', { class: 'spinner' }), 'Loading sheet from Azure…'
    ]);
    sheetWrap.appendChild(loadingNote);
    var img = document.createElement('img');
    img.className = 'sheet-img';
    img.src = imgUrl('sheet', sel.briefId, sel.runId, current);
    img.addEventListener('load', function () {
      loadingNote.remove();
      applySheetSize(img);
      drawOverlay(sheetWrap, img, sliceMap);
    });
    img.addEventListener('error', function () {
      loadingNote.remove();
      sheetWrap.appendChild(h('div', { style: { color: '#fca5a5', padding: '8px' },
        text: 'Failed to load sheet: ' + current }));
    });
    sheetWrap.appendChild(img);
    wrap.appendChild(sheetWrap);

    // Toggling size mode NEVER re-fetches the image or re-renders the page —
    // it resizes the ALREADY-LOADED <img> in place and recomputes the overlay
    // off the new display size (img.clientWidth), matching the existing
    // load-time redraw exactly (same drawOverlay call).
    sizeSelect.addEventListener('change', function () {
      sheetViewMode = sizeSelect.value;
      applySheetSize(img);
      drawOverlay(sheetWrap, img, sliceMap);
    });
    // Belt-and-suspenders: also redraw the overlay if the sheet's rendered box
    // changes for any OTHER reason (e.g. the host iframe itself is resized).
    if (typeof ResizeObserver !== 'undefined') {
      var sheetResizeObserver = new ResizeObserver(function () { drawOverlay(sheetWrap, img, sliceMap); });
      sheetResizeObserver.observe(img);
    }
    // Feedback on the OVERALL sheet (subjectType:'sheet') — distinct from the
    // brief (subjectType:'brief', in the View Brief modal) and per-criterion
    // judge/sensor feedback (subjectType:'criterion', per variant card below).
    wrap.appendChild(renderSheetFeedback(state));
    return wrap;
  }

  /** Apply the constrained/full presentation size to an already-loaded <img>. */
  function applySheetSize(img) {
    var size = computeSheetDisplaySize(img.naturalWidth, img.naturalHeight, sheetViewMode);
    if (size.width > 0 && size.height > 0) {
      img.style.width = size.width + 'px';
      img.style.height = size.height + 'px';
    } else {
      img.style.width = '';
      img.style.height = '';
    }
    img.classList.toggle('full', sheetViewMode === 'full');
  }

  function drawOverlay(sheetWrap, img, sliceMap) {
    var old = sheetWrap.querySelectorAll('.cell-box');
    for (var k = 0; k < old.length; k++) { old[k].remove(); }
    if (!sliceMap || sliceMap.ok === false || !sliceMap.cells || !sliceMap.sheetW) return;
    var scale = img.clientWidth / sliceMap.sheetW;
    if (!isFinite(scale) || scale <= 0) return;
    var degraded = sliceMap.emptyCellsApplied === false;
    for (var i = 0; i < sliceMap.cells.length; i++) {
      var cell = sliceMap.cells[i];
      if (cell.empty) continue;
      var box = h('div', { class: 'cell-box' });
      box.style.left = (img.offsetLeft + cell.x0 * scale) + 'px';
      box.style.top = (img.offsetTop + cell.y0 * scale) + 'px';
      box.style.width = (cell.w * scale) + 'px';
      box.style.height = (cell.h * scale) + 'px';
      if (degraded) box.style.borderColor = 'rgba(253,230,138,0.7)';
      var label = (cell.index != null && cell.index >= 0) ? String(cell.index) : '?';
      box.appendChild(h('span', { class: 'cell-idx', text: degraded ? ('seq ' + label) : label }));
      sheetWrap.appendChild(box);
    }
  }

  // ---- "Open in Post-process Debugger" — embeds + reveals the editor -----
  // Clicking reveals the persistent #postprocess-host section (lazily
  // creating its ONE iframe on first use, retargeting it via postMessage on
  // later opens — see openPostprocess()) and scrolls it into view.
  function renderPostprocessHandoff(sel, variantIndex) {
    var context = { briefId: sel.briefId, runId: sel.runId, sheet: sel.sheet, variantIndex: variantIndex };
    var btn = h('button', { type: 'button', title: 'Open this exact context in the embedded Post-process Debugger below',
      text: 'Open in Post-process Debugger' });
    btn.addEventListener('click', function () { openPostprocess(context); });
    return h('div', null, [btn]);
  }

  // ---- "View Brief" modal (accessible: focus trap, Escape, aria) ----------
  var pendingFocusModal = false;
  // Monotonic request identity for the brief fetch: guards against a late
  // response for a CLOSED/REPLACED modal (close A, open B before A's fetch
  // resolves) overwriting the currently-open modal's content with stale
  // captured state. briefModal itself is reassigned on every open, so a
  // bare !briefModal truthiness check is not enough - it stays truthy
  // across an A-to-B reopen and would let A's late response clobber B.
  var briefModalRequestSeq = 0;

  function openBriefModal(state, triggerEl) {
    var sel = state.selected;
    var entry = resolveBriefEntry(state, sel);
    var requestId = ++briefModalRequestSeq;
    briefModal = {
      id: requestId,
      relPath: entry ? entry.relPath : null,
      name: sel ? sel.briefId : '',
      content: null,
      loading: !!entry,
      error: entry ? null : ('No brief file found for ' + (sel ? sel.briefId : '')),
      triggerId: triggerEl && triggerEl.id ? triggerEl.id : null
    };
    pendingFocusModal = true;
    render(state);
    if (entry) {
      fetch('/api/brief?relPath=' + encodeURIComponent(entry.relPath)).then(function (r) { return r.json(); }).then(function (data) {
        // Discard a response that no longer belongs to the CURRENT modal -
        // either the modal was closed (briefModal is null) or replaced by a
        // newer open (briefModal.id !== requestId, e.g. a late A response
        // arriving after B was opened).
        if (!briefModal || briefModal.id !== requestId) return;
        briefModal.loading = false;
        if (data && data.error) briefModal.error = data.error;
        else briefModal.content = (data && data.content) || '';
        // Render from the CURRENT lastState, never the state snapshot
        // captured when this fetch started - a background state update
        // (SSE push, reload) that landed while the fetch was in flight must
        // not be silently reverted by re-rendering stale captured state.
        render(lastState);
      }).catch(function (err) {
        if (!briefModal || briefModal.id !== requestId) return;
        briefModal.loading = false;
        briefModal.error = String(err);
        render(lastState);
      });
    }
  }

  function closeBriefModal() {
    var triggerId = briefModal && briefModal.triggerId;
    briefModal = null;
    if (lastState) render(lastState);
    var trigger = triggerId ? document.getElementById(triggerId) : null;
    if (trigger && typeof trigger.focus === 'function') trigger.focus();
  }

  function renderBriefModal(state) {
    if (!briefModal) return null;
    var backdrop = h('div', { class: 'modal-backdrop' }, []);
    var modal = h('div', {
      class: 'modal', role: 'dialog', 'aria-modal': 'true',
      'aria-labelledby': 'brief-modal-title', tabindex: '-1'
    }, []);
    var closeBtn = h('button', { type: 'button', class: 'modal-close', 'aria-label': 'Close brief dialog', text: '\u2715 Close' });
    closeBtn.addEventListener('click', function () { closeBriefModal(); });
    modal.appendChild(closeBtn);
    modal.appendChild(h('h2', { id: 'brief-modal-title', text: 'Brief: ' + briefModal.name }));
    if (briefModal.loading) {
      modal.appendChild(h('div', { class: 'busy' }, [h('span', { class: 'spinner' }), 'Loading brief\u2026']));
    } else if (briefModal.error) {
      modal.appendChild(h('div', { class: 'panel error', text: briefModal.error }));
    } else {
      modal.appendChild(h('pre', { class: 'yaml', text: briefModal.content || '' }));
    }
    modal.appendChild(renderBriefFeedback(state));
    backdrop.appendChild(modal);
    backdrop.addEventListener('mousedown', function (ev) {
      if (ev.target === backdrop) closeBriefModal();
    });
    backdrop.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { ev.stopPropagation(); closeBriefModal(); return; }
      if (ev.key === 'Tab') {
        var focusables = modal.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusables.length === 0) return;
        var first = focusables[0];
        var last = focusables[focusables.length - 1];
        if (ev.shiftKey && document.activeElement === first) {
          ev.preventDefault(); last.focus();
        } else if (!ev.shiftKey && document.activeElement === last) {
          ev.preventDefault(); first.focus();
        }
      }
    });
    return backdrop;
  }

  function postFeedback(payload) {
    return fetch('/api/feedback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-workflow-mutation-token': mutationToken
      },
      body: JSON.stringify(payload)
    }).then(function (response) {
      return response.text().then(function (text) {
        var body = null;
        try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
        if (!response.ok) {
          var message = body && body.message ? body.message : 'Save failed (HTTP ' + response.status + ').';
          throw new Error(message);
        }
        return body;
      });
    });
  }

  function saveFeedback(sel, c, kind, criterion, verdict, comment) {
    return postFeedback({
      subjectType: 'criterion',
      briefId: sel.briefId, runId: sel.runId, variantIndex: c.index,
      kind: kind, criterion: criterion, verdict: verdict, comment: comment
    });
  }

  function saveSheetFeedback(briefId, runId, sheet, verdict, comment) {
    return postFeedback({
      subjectType: 'sheet', briefId: briefId, runId: runId, sheet: sheet,
      verdict: verdict, comment: comment
    });
  }

  function saveBriefFeedback(briefId, runId, verdict, comment) {
    return postFeedback({
      subjectType: 'brief', briefId: briefId, runId: runId,
      verdict: verdict, comment: comment
    });
  }

  // Generic feedback widget shared by criterion, sheet, and brief feedback.
  // Verdict changes persist immediately. Comment edits stay local until the
  // checkmark confirms a non-empty changed comment. Neither save path triggers
  // a full render/reload; each patches only the affected feedback object.
  function renderFeedbackWidget(persistedIn, save, confirmTitle) {
    var persisted = persistedIn || { verdict: null, comment: '' };
    var draft = { verdict: persisted.verdict || null, comment: persisted.comment || '' };

    var up = h('button', { type: 'button', class: 'thumb', title: 'Thumbs up', text: '👍' });
    var down = h('button', { type: 'button', class: 'thumb', title: 'Thumbs down', text: '👎' });
    var input = h('input', { type: 'text', maxlength: '1000', placeholder: 'Optional feedback comment' });
    var confirmBtn = h('button', { type: 'button', class: 'confirm-btn', title: confirmTitle || 'Confirm this feedback', text: '✓' });
    var status = h('span', { class: 'feedback-status muted' });
    var commentRow = h('div', { class: 'feedback-comment-row' }, [input, confirmBtn]);
    var saving = false;

    function setDisabled(disabled) {
      up.disabled = disabled;
      down.disabled = disabled;
      input.disabled = disabled;
      confirmBtn.disabled = disabled;
    }

    function hasCommentToSave() {
      return Boolean(
        draft.verdict &&
        draft.comment.trim().length > 0 &&
        draft.comment !== (persisted.comment || '')
      );
    }

    function sync() {
      up.className = 'thumb' + (draft.verdict === 'up' ? ' on' : '');
      down.className = 'thumb' + (draft.verdict === 'down' ? ' on' : '');
      commentRow.hidden = !draft.verdict;
      input.value = draft.comment;
      var commentDirty = hasCommentToSave();
      confirmBtn.hidden = !commentDirty;
      confirmBtn.className = 'confirm-btn' + (commentDirty ? ' dirty' : '');
      status.textContent = commentDirty ? 'Comment not saved' : (persisted.verdict ? 'Saved' : '');
    }

    function saveVerdict(next) {
      if (saving) return;
      var previousVerdict = persisted.verdict || null;
      var previousComment = persisted.comment || '';
      draft.verdict = next;
      if (!draft.verdict) draft.comment = '';
      sync();
      saving = true;
      setDisabled(true);
      status.textContent = 'Saving…';
      save(next, next ? previousComment : '').then(function () {
        persisted.verdict = next;
        if (!next) persisted.comment = '';
        sync();
      }).catch(function (err) {
        persisted.verdict = previousVerdict;
        persisted.comment = previousComment;
        draft.verdict = previousVerdict;
        draft.comment = previousComment;
        sync();
        status.textContent = err && err.message ? err.message : 'Save failed.';
      }).finally(function () {
        saving = false;
        setDisabled(false);
      });
    }

    up.addEventListener('click', function () { saveVerdict(draft.verdict === 'up' ? null : 'up'); });
    down.addEventListener('click', function () { saveVerdict(draft.verdict === 'down' ? null : 'down'); });
    input.addEventListener('input', function () { draft.comment = input.value; sync(); });

    confirmBtn.addEventListener('click', function () {
      if (saving || !hasCommentToSave()) return;
      var submitted = { verdict: draft.verdict, comment: draft.comment };
      saving = true;
      setDisabled(true);
      status.textContent = 'Saving…';
      save(submitted.verdict, submitted.comment).then(function () {
        persisted.verdict = submitted.verdict;
        persisted.comment = submitted.comment;
        sync();
      }).catch(function (err) {
        status.textContent = err && err.message ? err.message : 'Save failed.';
      }).finally(function () {
        saving = false;
        setDisabled(false);
      });
    });

    sync();
    return h('div', { class: 'criterion-feedback' }, [
      h('div', { class: 'feedback-verdict-row' }, [up, down, status]),
      commentRow
    ]);
  }

  function renderCriterionFeedback(sel, c, kind, criterion) {
    var persisted = readCriterionFeedback(c, kind, criterion);
    return renderFeedbackWidget(
      persisted,
      function (verdict, comment) {
        return saveFeedback(sel, c, kind, criterion, verdict, comment).then(function (result) {
          // Patch-only (HARD GATE, see extension.mjs's /api/feedback route):
          // write the CANONICAL location on the same c object retained in
          // lastState.candidates, exactly like sheet/brief feedback already
          // do. Without this, a first-time-confirmed criterion's fallback
          // object is orphaned (never stored on c.feedback) and the
          // confirmed value silently reverts on the next natural rerender.
          writeCriterionFeedback(c, kind, criterion, result && result.feedback);
          return result;
        });
      },
      'Confirm this criterion\u2019s feedback'
    );
  }

  function renderSheetFeedback(state) {
    var sel = state.selected;
    return renderFeedbackWidget(
      state.sheetFeedback,
      function (verdict, comment) {
        return saveSheetFeedback(sel.briefId, sel.runId, sel.sheet, verdict, comment).then(function (result) {
          // Patch-only: the server never rebuilds/broadcasts full state for a
          // feedback confirm (HARD GATE) — mutate our own local copy so a
          // later render() (e.g. tab switch) still reflects the confirmed
          // value without needing a reload.
          state.sheetFeedback = result && result.feedback ? result.feedback : null;
          return result;
        });
      },
      'Confirm feedback on this sheet'
    );
  }

  function renderBriefFeedback(state) {
    var sel = state.selected;
    return renderFeedbackWidget(
      state.briefFeedback,
      function (verdict, comment) {
        return saveBriefFeedback(sel.briefId, sel.runId, verdict, comment).then(function (result) {
          state.briefFeedback = result && result.feedback ? result.feedback : null;
          return result;
        });
      },
      'Confirm feedback on this brief'
    );
  }

  function renderJudge(card, c, sel) {
    var summary = summarizeJudge(c);
    card.appendChild(h('div', { class: 'section-title', text: 'Judge (advisory)' }));
    card.appendChild(h('div', { class: 'concise-summary ' + summary.state, text: summary.text }));
    if (!c.judge) return;
    var details = document.createElement('details');
    var summaryEl = h('summary', { class: 'details-summary', text: 'Show per-axis detail & feedback' });
    details.appendChild(summaryEl);
    for (var i = 0; i < JUDGE_AXES.length; i++) {
      var axis = JUDGE_AXES[i];
      var score = c.judge[axis.key] || 0;
      if (!score) continue;
      var ok = score >= 3;
      details.appendChild(h('div', { class: 'axis' }, [
        h('span', { class: 'lbl', text: axis.label }),
        h('span', { style: { color: ok ? '#86efac' : '#fca5a5', fontWeight: '600' },
          text: (score || '–') + '/5 ' + (ok ? '✓' : '✗') })
      ]));
      var rationale = c.rationale ? c.rationale[axis.key] : null;
      if (rationale) details.appendChild(h('div', { class: 'rationale', text: rationale }));
      details.appendChild(renderCriterionFeedback(sel, c, 'judge', axis.key));
    }
    var prov = [];
    if (c.modelDeployment) prov.push(c.modelDeployment);
    if (c.judgedAt) prov.push(c.judgedAt);
    if (prov.length) details.appendChild(h('div', { style: { fontSize: '9px', color: '#64748b' }, text: prov.join(' · ') }));
    card.appendChild(details);
  }

  function renderSensors(card, c, sel) {
    var summary = summarizeSensors(c);
    card.appendChild(h('div', { class: 'section-title', text: 'Sensors' }));
    card.appendChild(h('div', { class: 'concise-summary ' + summary.state, text: summary.text }));
    if (!c.sensors || c.sensors.length === 0) return;

    var details = document.createElement('details');
    details.appendChild(h('summary', { class: 'details-summary', text: 'Show per-sensor detail & feedback' }));
    for (var i = 0; i < c.sensors.length; i++) {
      var s = c.sensors[i];
      details.appendChild(h('div', { class: 'sensor' }, [
        h('span', { text: s.sensor }),
        h('span', { style: { color: s.ok ? '#86efac' : '#fca5a5', fontWeight: '700' }, text: s.ok ? '✓' : '✗' })
      ]));
      if (!s.ok && (s.reason || s.pixelCount != null)) {
        details.appendChild(h('div', { class: 'sensor-reason',
          text: (s.reason || 'failed') + (s.pixelCount != null ? ' (' + s.pixelCount + 'px)' : '') }));
      }
      details.appendChild(renderCriterionFeedback(sel, c, 'sensor', s.sensor));
    }
    card.appendChild(details);
  }

  function acceptanceKey(briefId, runId, variantIndex) {
    return briefId + '/' + runId + '/' + variantIndex;
  }

  function acceptVariant(briefId, runId, variantIndex) {
    if (!lastState) return;
    var key = acceptanceKey(briefId, runId, variantIndex);
    lastState.acceptance = lastState.acceptance || {};
    lastState.acceptance[key] = { state: 'accepting' };
    render(lastState);
    setBusy(true, 'Approving and queueing variant…');
    fetch('/api/accept', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-workflow-mutation-token': mutationToken
      },
      body: JSON.stringify({ briefId: briefId, runId: runId, variantIndex: variantIndex })
    }).then(function (response) {
      return response.text().then(function (text) {
        var payload = null;
        try { payload = text ? JSON.parse(text) : null; } catch (e) { payload = null; }
        return { ok: response.ok, status: response.status, payload: payload };
      });
    }).then(function (result) {
      if (!result.ok) {
        var message = result.payload && result.payload.message
          ? result.payload.message
          : 'Acceptance failed with HTTP ' + result.status + '.';
        throw new Error(message);
      }
      lastState.acceptance[key] = result.payload;
      render(lastState);
    }).catch(function (error) {
      lastState.acceptance[key] = {
        state: 'error',
        message: error && error.message ? error.message : String(error)
      };
      render(lastState);
    }).finally(function () {
      setBusy(false);
    });
  }

  function variantIdFor(briefId, variantIndex) {
    return briefId + '-var-' + variantIndex;
  }

  function unapproveVariant(manifestKey) {
    if (!lastState) return;
    var variantId = manifestKey;
    lastState.unapproval = lastState.unapproval || {};
    lastState.unapproval[variantId] = { state: 'unapproving' };
    render(lastState);
    setBusy(true, 'Unapproving variant…');
    fetch('/api/unapprove', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-workflow-mutation-token': mutationToken
      },
      body: JSON.stringify({ variantId: variantId })
    }).then(function (response) {
      return response.text().then(function (text) {
        var payload = null;
        try { payload = text ? JSON.parse(text) : null; } catch (e) { payload = null; }
        return { ok: response.ok, status: response.status, payload: payload };
      });
    }).then(function (result) {
      if (!result.ok) {
        var message = result.payload && result.payload.message
          ? result.payload.message
          : 'Unapprove failed with HTTP ' + result.status + '.';
        throw new Error(message);
      }
      lastState.unapproval[variantId] = { state: 'evicted', entry: result.payload };
      render(lastState);
    }).catch(function (error) {
      lastState.unapproval[variantId] = {
        state: 'error',
        message: error && error.message ? error.message : String(error)
      };
      render(lastState);
    }).finally(function () {
      setBusy(false);
    });
  }

  function renderAcceptance(card, state, sel, candidate) {
    var key = acceptanceKey(sel.briefId, sel.runId, candidate.index);
    var acceptance = state.acceptance && state.acceptance[key];
    if (acceptance && acceptance.state === 'queued') {
      var queued = h('div', { class: 'accept-state queued' }, [
        document.createTextNode(acceptance.existing ? 'Already queued · ' : 'Queued · '),
        h('a', {
          href: acceptance.issueUrl,
          target: '_blank',
          rel: 'noreferrer',
          text: 'Open asset issue'
        })
      ]);
      card.appendChild(queued);
      // ADR 0066 RSK-003: check-in is intentionally batched — one acceptance
      // can publish OTHER approved, unqueued art too. Surface the batch size
      // so operators aren't surprised by what a single click just shipped.
      if (typeof acceptance.assetCount === 'number' && acceptance.assetCount > 1) {
        var extra = acceptance.assetCount - 1;
        var extraNoun = extra === 1 ? 'asset' : 'assets';
        var warnText = acceptance.existing
          ? ('Heads up: this open issue batches ' + acceptance.assetCount +
              ' approved assets (this variant plus ' + extra + ' other ' + extraNoun + ').')
          : ('Heads up: accepting this variant also published ' + extra +
              ' other approved, unqueued ' + extraNoun + ' in the same batch.');
        card.appendChild(h('div', { class: 'accept-state warn', text: warnText }));
      }
      return;
    }
    if (acceptance && acceptance.state === 'error') {
      card.appendChild(h('div', {
        class: 'accept-state error',
        text: acceptance.message || 'Acceptance failed.'
      }));
    }
    var accepting = acceptance && acceptance.state === 'accepting';
    // ADR 0066 DEC-004: disable ALL acceptance controls while any transaction
    // is pending, not just the clicked variant's button. An in-flight accept
    // is irreversible (approve + check-in); allowing a second click on any
    // candidate while the first is still in progress could enqueue a
    // conflicting, concurrent acceptance.
    var anyAccepting = !!(state.acceptance && Object.keys(state.acceptance).some(function (k) {
      return state.acceptance[k] && state.acceptance[k].state === 'accepting';
    }));
    // Label is driven by the per-variant LIFECYCLE (unaccepted/accepted-staged/
    // integrated/unverified), not by this session's own ephemeral acceptance
    // bookkeeping — a variant already accepted/staged/integrated/unverified
    // exposes "Re-accept" (force-retrying the same idempotent sidecar
    // acceptance path); a genuinely unaccepted variant uses "Accept & queue".
    var lifecycleState = (candidate.lifecycle && candidate.lifecycle.state) || 'unaccepted';
    var label = accepting
      ? 'Accepting & queueing…'
      : (lifecycleState === 'unaccepted' ? 'Accept & queue' : 'Re-accept');
    var button = h('button', {
      type: 'button',
      class: 'accept-button',
      text: label,
      onclick: function () { acceptVariant(sel.briefId, sel.runId, candidate.index); }
    });
    if (anyAccepting) button.disabled = true;
    card.appendChild(button);

    // Show unapprove button for variants that are already accepted/staged or integrated.
    if (lifecycleState === 'accepted-staged' || lifecycleState === 'integrated') {
      // Use the exact manifest map key from the lifecycle, falling back to the
      // reconstructed form only when the lifecycle hasn't propagated the key yet
      // (e.g. a transient "queued this session" accepted-staged state where no
      // manifest entry exists yet). The lifecycle.manifestKey is authoritative
      // because approveVariant canonicalizes item brief IDs (e.g. 'flame-dagger-v2'
      // → 'flame-dagger'), so rebuilding from sel.briefId produces the wrong key.
      var variantId = (candidate.lifecycle && candidate.lifecycle.manifestKey)
        || variantIdFor(sel.briefId, candidate.index);
      var unapprovalEntry = state.unapproval && state.unapproval[variantId];
      var anyUnapproving = !!(state.unapproval && Object.keys(state.unapproval).some(function (k) {
        return state.unapproval[k] && state.unapproval[k].state === 'unapproving';
      }));
      if (unapprovalEntry && unapprovalEntry.state === 'evicted') {
        card.appendChild(h('div', {
          class: 'unapprove-state evicted',
          text: 'Evicted from manifest.'
        }));
      } else if (unapprovalEntry && unapprovalEntry.state === 'error') {
        card.appendChild(h('div', {
          class: 'unapprove-state error',
          text: unapprovalEntry.message || 'Unapprove failed.'
        }));
      }
      var unapproving = unapprovalEntry && unapprovalEntry.state === 'unapproving';
      var unapproveBtn = h('button', {
        type: 'button',
        class: 'unapprove-button',
        text: unapproving ? 'Evicting…' : 'Evict / Unapprove',
        onclick: function () { unapproveVariant(variantId); }
      });
      if (anyAccepting || anyUnapproving || unapproving) unapproveBtn.disabled = true;
      card.appendChild(unapproveBtn);
    }
  }

  function lifecyclePill(candidate) {
    var lifecycle = candidate.lifecycle || { state: 'unaccepted', detail: null };
    var label = lifecycle.state === 'accepted-staged' ? 'accepted/staged' : lifecycle.state;
    var pill = h('span', { class: 'lifecycle-pill ' + lifecycle.state, text: label });
    if (lifecycle.detail) pill.title = lifecycle.detail;
    return pill;
  }

  function renderCandidateCard(state, sel, candidate) {
    var status = candidateStatus(candidate);
    var card = h('div', {
      class: 'card',
      'data-variant-index': String(candidate.index)
    }, []);
    card.appendChild(h('div', { class: 'between' }, [
      h('strong', { text: 'Variant #' + candidate.index }),
      h('span', { text: candidate.score + '/' + candidate.outOf, class: 'muted' })
    ]));
    card.appendChild(h('span', {
      class: 'status-pill',
      style: { color: STATUS_COLORS[status.kind] },
      text: status.label
    }));
    card.appendChild(lifecyclePill(candidate));
    var thumb = document.createElement('img');
    thumb.className = 'thumb';
    thumb.src = imgUrl('processed', sel.briefId, sel.runId, pad2(candidate.index) + '.png') +
      (candidate._patchTs ? '&ts=' + candidate._patchTs : '');
    thumb.alt = 'variant ' + candidate.index;
    card.appendChild(thumb);
    renderJudge(card, candidate, sel);
    renderSensors(card, candidate, sel);
    renderAcceptance(card, state, sel, candidate);
    card.appendChild(renderPostprocessHandoff(sel, candidate.index));
    return card;
  }

  function renderCandidates(state) {
    var sel = state.selected;
    var cands = state.candidates || [];
    var wrap = h('div', {
      style: { marginTop: '16px' },
      'data-workflow-candidates': 'true'
    }, [
      h('div', { class: 'section-title', text: 'Variants & pipeline traces (' + cands.length + ')' })
    ]);
    if (!sel || cands.length === 0) {
      wrap.appendChild(h('div', { class: 'muted', text: 'No variant traces recorded for this run.' }));
      return wrap;
    }
    var grid = h('div', { class: 'cards' }, []);
    for (var i = 0; i < cands.length; i++) {
      grid.appendChild(renderCandidateCard(state, sel, cands[i]));
    }
    wrap.appendChild(grid);
    return wrap;
  }

  function renderRuns(state) {
    var wrap = h('div', null, []);
    if (!state.health || state.health.state !== 'up') {
      wrap.appendChild(renderDegrade(state));
      return wrap;
    }
    if (!state.runs || state.runs.length === 0) {
      wrap.appendChild(h('div', { class: 'panel warn' },
        ['No sprite runs found yet. Generate a run from the workflow, then reload.']));
      return wrap;
    }
    wrap.appendChild(renderRunPicker(state));
    wrap.appendChild(renderSheetSection(state));
    wrap.appendChild(renderCandidates(state));
    return wrap;
  }

  // ---- Author tab: durable Azure workflow state machine -------------------
  function workflowPost(path, body, label) {
    setBusy(true, label || 'Updating Azure workflow…');
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Workflow-Mutation-Token': mutationToken },
      body: JSON.stringify(body || {})
    }).then(function (response) {
      return response.json().then(function (payload) {
        if (!response.ok || (payload && payload.error)) throw new Error((payload && payload.message) || (payload && payload.error) || 'Workflow update failed');
        setBusy(false);
        return loadState();
      });
    }).catch(function (error) {
      setBusy(false);
      if (lastState) {
        lastState.error = 'Workflow action failed: ' + error.message;
        render(lastState);
      }
    });
  }

  function renderAuthor(state) {
    var workflow = state.workflow || { items: [], selectedId: null };
    var selected = null;
    for (var i = 0; i < workflow.items.length; i++) {
      if (workflow.items[i].id === workflow.selectedId) selected = workflow.items[i];
    }
    var wrap = h('div', null, []);
    var refresh = h('button', {
      class: 'accept-button',
      text: 'Refresh Azure workflow',
      title: 'Fetch externally completed Azure work now'
    });
    refresh.addEventListener('click', function () {
      workflowPost('/api/workflow/refresh', {}, 'Refreshing Azure workflow…');
    });
    wrap.appendChild(h('div', { class: 'panel info', style: { marginBottom: '12px' } }, [
      h('div', { class: 'between' }, [
        h('div', null, [
          h('strong', { text: 'Azure-backed authoring workflow' }),
          h('div', { class: 'muted', text: 'Generation is queued to Azure; this canvas never starts queue consumers.' })
        ]),
        refresh
      ]),
      h('div', { class: 'muted', style: { marginTop: '6px' },
        text: 'Last Azure refresh: ' + (state.workflowLastRefreshAt || 'not yet loaded') })
    ]));
    if (state.workflowError) {
      wrap.appendChild(h('div', { class: 'panel warn', style: { marginBottom: '12px' },
        text: 'Azure workflow state is unavailable: ' + state.workflowError }));
    }

    var composer = h('div', { class: 'panel', style: { marginBottom: '12px' } }, [
      h('div', { class: 'section-title', text: 'New art request' })
    ]);
    var name = h('input', { type: 'text', placeholder: 'Bare consumer id, e.g. rusty-anvil', 'aria-label': 'Asset name' });
    var brief = h('input', { type: 'text', placeholder: 'One-line art request', 'aria-label': 'One-line art request' });
    var type = h('select', { 'aria-label': 'Sprite type' });
    ['auto', 'weapon', 'equipment', 'enemy', 'item', 'prop', 'tile', 'vfx', 'character'].forEach(function (value) {
      type.appendChild(h('option', { value: value, text: value }));
    });
    var size = h('select', { 'aria-label': 'Sprite footprint' });
    ['default', 'wide', 'tall', 'large'].forEach(function (value) {
      size.appendChild(h('option', { value: value, text: value }));
    });
    var create = h('button', { class: 'accept-button', text: 'Create request' });
    create.addEventListener('click', function () {
      workflowPost('/api/workflow/request', {
        name: name.value, brief: brief.value, type: type.value, sizeVariant: size.value
      }, 'Creating request…');
    });
    composer.appendChild(h('div', { class: 'row' }, [name, brief, type, size, create]));
    wrap.appendChild(composer);

    if (workflow.items.length === 0) {
      wrap.appendChild(h('div', { class: 'muted', text: 'Create a request to begin synthesis.' }));
      return wrap;
    }
    var list = h('div', { class: 'filelist' }, []);
    workflow.items.forEach(function (item) {
      list.appendChild(h('button', {
        class: item.id === workflow.selectedId ? 'active' : '',
        text: item.name + ' · ' + item.stage,
        onclick: function () { workflowPost('/api/workflow/select', { itemId: item.id }, 'Selecting request…'); }
      }));
    });
    var detail = h('div', { class: 'panel' }, []);
    if (!selected) {
      detail.appendChild(h('div', { class: 'muted', text: 'Select an authoring request.' }));
    } else {
      detail.appendChild(h('div', { class: 'between' }, [
        h('div', null, [
          h('strong', { text: selected.name }),
          h('div', { class: 'muted', text: selected.requestedType + ' · ' + selected.sizeVariant + ' · phase: ' + selected.stage })
        ]),
        h('code', { text: selected.kebabName })
      ]));
      if (selected.brief) detail.appendChild(h('p', { class: 'muted', text: selected.brief }));
      var controls = h('div', { class: 'row' }, []);
      if (selected.stage === 'draft') {
        controls.appendChild(h('button', { class: 'accept-button', text: 'Synthesize draft briefs',
          onclick: function () { workflowPost('/api/workflow/synthesize', { itemId: selected.id, candidates: 3 }, 'Synthesizing briefs…'); } }));
      }
      if (selected.candidates && selected.candidates.length) {
        selected.candidates.forEach(function (candidate) {
          var candidatePanel = h('div', { class: 'card', style: { marginTop: '10px' } }, [
            h('div', { class: 'between' }, [h('strong', { text: candidate.id }), h('code', { text: candidate.yamlPath })]),
            h('div', { class: 'muted', text: candidate.description || '' })
          ]);
          var yaml = h('textarea', { 'aria-label': 'Editable synthesized YAML' });
          yaml.value = candidate.yaml || '';
          candidatePanel.appendChild(yaml);
          candidatePanel.appendChild(h('div', { class: 'row' }, [
            h('button', { text: 'Save YAML', onclick: function () {
              workflowPost('/api/workflow/brief', { itemId: selected.id, yamlPath: candidate.yamlPath, yaml: yaml.value }, 'Saving brief…');
            } }),
            h('button', { class: 'accept-button', text: (selected.chosenCandidatePath === candidate.yamlPath ? 'Chosen brief' : 'Choose brief'), onclick: function () {
              workflowPost('/api/workflow/brief', { itemId: selected.id, yamlPath: candidate.yamlPath, yaml: yaml.value, choose: true }, 'Choosing brief…');
            } })
          ]));
          detail.appendChild(candidatePanel);
        });
      }
      if ((selected.stage === 'candidates' || selected.stage === 'draft') && (selected.chosenCandidatePath || selected.candidates.length)) {
        controls.appendChild(h('button', { class: 'accept-button', text: 'Promote & queue Azure generation',
          onclick: function () { workflowPost('/api/workflow/generate', { itemId: selected.id }, 'Queueing Azure generation…'); } }));
      }
      if (selected.stage === 'generating') {
        controls.appendChild(h('span', { class: 'busy' }, [h('span', { class: 'spinner' }), 'Waiting for Azure queue output…']));
      }
      if (selected.run) {
        controls.appendChild(h('button', { text: 'View generated sheet', onclick: function () {
          activeTab = 'runs'; select(selected.run.briefId, selected.run.runId, null);
        } }));
      }
      if (selected.stage === 'sheet') {
        controls.appendChild(h('button', { class: 'accept-button', text: 'Post-process sheet',
          onclick: function () { workflowPost('/api/workflow/postprocess', { itemId: selected.id }, 'Post-processing sheet…'); } }));
      }
      if (selected.stage === 'postprocessed') {
        controls.appendChild(h('button', { class: 'accept-button', text: 'Judge variants',
          onclick: function () { workflowPost('/api/workflow/judge', { itemId: selected.id }, 'Judging variants…'); } }));
      }
      if (selected.stage === 'variants' && selected.run) {
        selected.run.candidates.forEach(function (candidate) {
          controls.appendChild(h('button', { class: 'accept-button', text: 'Approve variant ' + candidate.index,
            onclick: function () { workflowPost('/api/workflow/approve', { itemId: selected.id, variantIndex: candidate.index }, 'Approving variant…'); } }));
        });
      }
      if (selected.stage === 'checked-in' || selected.stage === 'approved') {
        detail.appendChild(h('div', { class: 'accept-state queued', text: selected.approvalSummary || 'Approved and queued durably on assets/queue.' }));
        controls.appendChild(h('button', { class: 'accept-button', text: 'Tag metadata & finish',
          onclick: function () { workflowPost('/api/workflow/metadata', { itemId: selected.id }, 'Tagging sprite metadata…'); } }));
      }
      if (selected.stage === 'tagging') {
        controls.appendChild(h('span', { class: 'busy' }, [h('span', { class: 'spinner' }), 'Writing metadata and durable queue state…']));
      }
      if (selected.stage === 'done') {
        detail.appendChild(h('div', { class: 'accept-state queued', text: selected.metadataSummary || 'Metadata tagged and queued durably on assets/queue.' }));
      }
      ['brief', 'sheet', 'postprocess'].forEach(function (target) {
        controls.appendChild(h('button', { class: 'unapprove-button', text: 'Rewind to ' + target,
          onclick: function () { workflowPost('/api/workflow/rewind', { itemId: selected.id, target: target }, 'Rewinding workflow…'); } }));
      });
      detail.appendChild(controls);
    }
    wrap.appendChild(h('div', { class: 'split' }, [list, detail]));
    return wrap;
  }


  // ---- Tab bar + top-level render ----------------------------------------
  function renderTabs(state) {
    var bar = h('div', { class: 'tabs' }, []);
    var counts = {
      author: (state.workflow && state.workflow.items) ? state.workflow.items.length : 0,
      backlog: (state.backlog && state.backlog.reports) ? state.backlog.reports.length : 0,
      files: (state.files ? ((state.files.plans || []).length + (state.files.briefs || []).length) : 0),
      runs: (state.runs || []).length
    };
    for (var i = 0; i < TABS.length; i++) {
      (function (tab) {
        var children = [tab.label];
        if (counts[tab.id] != null) children.push(h('span', { class: 'count', text: String(counts[tab.id]) }));
        bar.appendChild(h('button', {
          class: 'tab' + (activeTab === tab.id ? ' active' : ''),
          onclick: function () { activeTab = tab.id; if (lastState) render(lastState); }
        }, children));
      })(TABS[i]);
    }
    return bar;
  }

  function renderActiveTab(state) {
    if (activeTab === 'author') return renderAuthor(state);
    if (activeTab === 'files') return renderFiles(state);
    if (activeTab === 'runs') return renderRuns(state);
    return renderBacklog(state);
  }

  function render(state) {
    if (!state) return;
    var restoreModalFocus = !!(
      briefModal &&
      document.activeElement &&
      typeof document.activeElement.closest === 'function' &&
      document.activeElement.closest('[role="dialog"]')
    );
    lastState = state;
    var frag = document.createDocumentFragment();
    frag.appendChild(renderHealth(state));
    if (state.error) {
      frag.appendChild(h('div', { class: 'panel error', style: { marginTop: '12px' }, text: state.error }));
    }
    frag.appendChild(renderTabs(state));
    frag.appendChild(h('div', { style: { marginTop: '4px' } }, [renderActiveTab(state)]));
    app.replaceChildren(frag);
    var modalEl = renderBriefModal(state);
    if (modalEl) {
      app.appendChild(modalEl);
      if (pendingFocusModal || restoreModalFocus) {
        pendingFocusModal = false;
        var modalContainer = modalEl.querySelector('.modal');
        if (modalContainer) modalContainer.focus();
      }
    }
  }

  var selecting = false;
  function select(briefId, runId, sheet) {
    if (selecting) return;
    selecting = true;
    setBusy(true, 'Loading run…');
    var url = '/api/select?briefId=' + encodeURIComponent(briefId) + '&runId=' + encodeURIComponent(runId);
    if (sheet) url += '&sheet=' + encodeURIComponent(sheet);
    fetch(url).then(function (r) { return r.json(); }).then(function (state) {
      selecting = false;
      setBusy(false);
      render(state);
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

  function fetchState(endpoint, label) {
    setBusy(true, label || 'Loading from sidecar…');
    return fetch(endpoint).then(function (r) { return r.json(); }).then(function (state) {
      setBusy(false);
      render(state);
    }).catch(function (err) {
      setBusy(false);
      app.replaceChildren(h('div', { class: 'panel error', text: 'Failed to load state: ' + err }));
    });
  }

  // Initial load uses the cached fs-static view model. Explicit refresh hits
  // /api/reload, which invalidates that cache (re-parses plans/briefs + registry)
  // and re-probes the sidecar before pushing fresh state.
  function loadState(label) { return fetchState('/api/state', label); }
  function reloadState(label) { return fetchState('/api/reload', label || 'Refreshing…'); }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', function () { reloadState('Refreshing…'); });
  }

  function connect() {
    try {
      var es = new EventSource('/events');
      es.onmessage = function (ev) {
        try {
          var msg = JSON.parse(ev.data);
          if (msg && msg.type === 'state') render(msg.state);
        } catch (e) { /* ignore malformed frame */ }
      };
      es.onerror = function () { /* browser auto-reconnects */ };
    } catch (e) { /* EventSource unsupported — fall back to fetch below */ }
  }

  loadState();
  connect();
})();
`;

/**
 * Full HTML document for one canvas instance.
 * @param {string} instanceId
 * @param {string} mutationToken
 * @returns {string}
 */
export function renderHtml(instanceId, mutationToken = '') {
  const clientScript = CLIENT_SCRIPT.replace(
    '__WORKFLOW_MUTATION_TOKEN__',
    JSON.stringify(mutationToken),
  )
    .replace('/*__RUN_FILTER_FNS__*/', () => serializePureModule(runFilterFns))
    .replace('/*__SHEET_DISPLAY_FNS__*/', () => serializePureModule(sheetDisplayFns))
    .replace('/*__FEEDBACK_SUMMARY_FNS__*/', () => serializePureModule(feedbackSummaryFns))
    .replace('/*__BRIEF_LOOKUP_FNS__*/', () => serializePureModule(briefLookupFns));
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<title>Sprite Generation Workflow</title>',
    '<style>' + STYLES + '</style>',
    '</head><body>',
    '<div class="toolbar">',
    '<button id="refresh-btn" type="button" title="Reload backlog and runs">↻ Refresh</button>',
    '<span id="busy" class="busy" hidden><span class="spinner"></span><span id="busy-label">Loading…</span></span>',
    '</div>',
    '<div id="app" data-instance="' + escapeHtml(instanceId) + '">',
    '<p class="muted">Loading sprite generation workflow…</p>',
    '</div>',
    // Persistent SIBLING of #app (never touched by render()'s
    // app.replaceChildren) — collapsed/hidden placeholder until the first
    // "Open in Post-process Debugger" click lazily creates its ONE iframe.
    // See openPostprocess()/the postMessage bridge above.
    '<div id="postprocess-host" hidden>',
    '<div class="postprocess-host-head">',
    '<h2>Postprocess Debugger</h2>',
    '<span id="postprocess-host-status" class="muted"></span>',
    '</div>',
    '<div id="postprocess-host-body" class="collapsed">',
    '<span class="muted">Opens here on demand — click "Open in Post-process Debugger" on any variant.</span>',
    '</div>',
    '</div>',
    '<script>' + clientScript + '</script>',
    '</body></html>',
  ].join('');
}
