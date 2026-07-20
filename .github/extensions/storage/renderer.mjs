/**
 * renderer.mjs — the `storage` canvas iframe document.
 *
 * `renderHtml(instanceId, { mutationToken })` returns a complete, self-contained
 * HTML document embedded in an iframe (no privileged bridge). It is a faithful
 * port of `src/devtools-main.ts` → `renderStorageLifecyclePage` (`?page=storage`):
 * list / search / sort / filter / select sprite-run blobs across the `active` and
 * `archive` scopes, and the two DESTRUCTIVE ops archive + delete.
 *
 * Data flow (client-authoritative, mirrors the monolith — the server is a set of
 * stateless proxy routes):
 *   - `GET  /api/runs?scope=&search=` — `{ health, scope, search, runs, error? }`.
 *   - `POST /api/enrich {scope, runs}` — `{ scope, enriched }` (two-phase; the list
 *     renders instantly with `…` placeholders, enrichment fills in async).
 *   - `POST /api/archive {keys}` / `POST /api/delete {keys}` — DESTRUCTIVE; require
 *     the per-instance mutation token header and are health-gated server-side.
 *   - `GET  /img/sheet|processed?briefId=&runId=&file=` — cached image proxies.
 *
 * DESTRUCTIVE-OPS CARE: archive/delete are reachable ONLY through the same
 * `window.confirm` guards the monolith uses, with the EXACT confirm strings, and
 * the buttons are disabled whenever the sidecar health is not `up`. This is never
 * more one-click than the monolith (project rule #12).
 *
 * The client script is intentionally template-literal-free (plain string concat +
 * createElement) so this file stays one clean outer `String.raw` literal with no
 * `${}` interpolation to escape.
 *
 * @module storage/renderer
 */

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
  select, button, input[type="search"] {
    background: #111827; color: #e5e7eb;
    border: 1px solid rgba(229,231,235,0.3); border-radius: 8px;
    padding: 8px 10px; font-size: 13px; font-family: inherit;
  }
  button {
    cursor: pointer; border-color: rgba(126,224,255,0.4);
    background: rgba(30,41,59,0.95); color: #7ee0ff; padding: 8px 12px;
  }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  input[type="search"] { flex: 1 1 220px; }
  .badge-health { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
    padding: 3px 8px; border-radius: 999px; border: 1px solid transparent; }
  .badge-health.up { color: #86efac; border-color: rgba(134,239,172,0.4); background: rgba(134,239,172,0.08); }
  .badge-health.down { color: #fca5a5; border-color: rgba(252,165,165,0.4); background: rgba(252,165,165,0.08); }
  .badge-health.wrong-repo { color: #fde68a; border-color: rgba(253,230,138,0.4); background: rgba(253,230,138,0.08); }
  .toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 8px; }
  #status { color: #93c5fd; font-size: 13px; margin: 4px 0 10px; min-height: 18px; }
  .panel { padding: 16px; border-radius: 8px; border: 1px solid rgba(148,163,184,0.25); background: #0f172a; }
  .panel.warn { background: #78350f; color: #fef3c7; border-color: rgba(255,255,255,0.18); }
  .panel.error { background: #7f1d1d; color: #fef3c7; }
  code { font-family: var(--font-mono, "SFMono-Regular", Consolas, monospace); font-size: 12px;
    background: rgba(148,163,184,0.15); padding: 1px 5px; border-radius: 4px; }
  .section-title { font-weight: 600; font-size: 12px; color: #f1f5f9; margin: 6px 0 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; padding: 8px 10px; border-bottom: 1px solid rgba(229,231,235,0.1);
    color: #cbd5e1; white-space: nowrap; }
  td { padding: 8px 10px; border-bottom: 1px solid rgba(229,231,235,0.1); vertical-align: middle; }
  .thumb-wrap { display: inline-flex; align-items: center; justify-content: center; color: #64748b; }
  .thumb-img { object-fit: contain; image-rendering: pixelated; border-radius: 6px;
    border: 1px solid rgba(148,163,184,0.2); background: #0f172a; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; white-space: nowrap; }
  .pill.good { color: #86efac; border: 1px solid rgba(134,239,172,0.4); background: rgba(22,101,52,0.35); }
  .pill.warn { color: #fcd34d; border: 1px solid rgba(252,211,77,0.4); background: rgba(120,53,15,0.35); }
  .pill.muted { color: #94a3b8; border: 1px solid rgba(148,163,184,0.3); background: rgba(30,41,59,0.6); }
  #list-host { overflow-x: auto; }
  .busy { display: inline-flex; align-items: center; gap: 7px; color: var(--text-color-muted, #94a3b8); font-size: 12px; }
  .busy[hidden] { display: none; }
  .spinner { width: 13px; height: 13px; border: 2px solid rgba(148,163,184,0.3);
    border-top-color: #7dd3fc; border-radius: 50%; display: inline-block; animation: st-spin 0.8s linear infinite; }
  @keyframes st-spin { to { transform: rotate(360deg); } }
`;

// NOTE: template-literal-free on purpose (no ${} interpolation) — see file header.
const CLIENT_SCRIPT = String.raw`
(function () {
  'use strict';
  var app = document.getElementById('app');
  var statusEl = document.getElementById('status');
  var listHost = document.getElementById('list-host');
  var scopeSelect = document.getElementById('scope-select');
  var searchInput = document.getElementById('search-input');
  var sortSelect = document.getElementById('sort-select');
  var filterSelect = document.getElementById('filter-select');
  var refreshBtn = document.getElementById('refresh-btn');
  var archiveBtn = document.getElementById('archive-btn');
  var deleteBtn = document.getElementById('delete-btn');
  var busyEl = document.getElementById('busy');
  var busyLabel = document.getElementById('busy-label');
  var healthBadge = document.getElementById('health-badge');
  var healthMeta = document.getElementById('health-meta');
  var mutationToken = app ? (app.getAttribute('data-mutation-token') || '') : '';

  // Client-authoritative state (mirrors the monolith exactly).
  var selected = Object.create(null);
  var currentRuns = [];
  var enrichment = new Map();
  var health = { state: 'down' };
  var requestSeq = 0;

  function currentScope() { return scopeSelect && scopeSelect.value === 'archive' ? 'archive' : 'active'; }
  function runKey(run) { return run.briefId + '/' + run.runId; }
  function keyForStorageRun(scope, run) {
    return (scope === 'archive' ? 'archive/' : '') + run.briefId + '/' + run.runId;
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function selectKeys() {
    var out = [];
    for (var k in selected) { if (selected[k]) out.push(k); }
    return out;
  }
  function clearSelection() { selected = Object.create(null); }

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

  function imgUrl(kind, briefId, runId, file) {
    return '/img/' + kind + '?briefId=' + encodeURIComponent(briefId)
      + '&runId=' + encodeURIComponent(runId) + '&file=' + encodeURIComponent(file);
  }

  function makeThumb(src, size, title) {
    var wrap = h('span', { class: 'thumb-wrap', title: title,
      style: { minWidth: size + 'px', minHeight: size + 'px' } });
    var img = document.createElement('img');
    img.className = 'thumb-img';
    img.src = src;
    img.alt = title;
    img.style.width = size + 'px';
    img.style.height = size + 'px';
    img.addEventListener('error', function () { wrap.textContent = '\u2014'; });
    wrap.appendChild(img);
    return wrap;
  }

  function makePill(text, kind) { return h('span', { class: 'pill ' + kind, text: text }); }
  function dots() { return h('span', { text: '\u2026', style: { color: '#64748b' } }); }
  function dash() { return h('span', { text: '\u2014', style: { color: '#64748b' } }); }

  var inflight = 0;
  function setBusy(on, label) {
    inflight += on ? 1 : -1;
    if (inflight < 0) inflight = 0;
    var active = inflight > 0;
    if (busyEl) busyEl.hidden = !active;
    if (active && label && busyLabel) busyLabel.textContent = label;
    if (refreshBtn) refreshBtn.disabled = active;
  }

  function updateHealthUI() {
    var state = health && health.state ? health.state : 'down';
    if (healthBadge) { healthBadge.className = 'badge-health ' + state; healthBadge.textContent = state; }
    var meta = [];
    if (health && health.version) meta.push('sidecar ' + health.version);
    if (health && health.storeBackend) meta.push(health.storeBackend);
    if (healthMeta) healthMeta.textContent = meta.join('  \u00b7  ');
    var up = state === 'up';
    // DESTRUCTIVE ops are disabled whenever the sidecar is not healthy for THIS repo.
    if (archiveBtn) archiveBtn.disabled = !up;
    if (deleteBtn) deleteBtn.disabled = !up;
  }

  function renderDegrade(startup) {
    var state = health && health.state ? health.state : 'down';
    if (state === 'wrong-repo') {
      return h('div', { class: 'panel warn' }, [
        h('div', { class: 'section-title', text: 'Sidecar is serving a different repo' }),
        h('div', null, ['The sprite sidecar answered, but its repoRoot does not match this worktree.']),
        h('div', { class: 'muted', style: { marginTop: '6px' } },
          ['sidecar repoRoot: ', h('code', { text: (health && health.repoRoot) || '(unknown)' })]),
        h('div', { class: 'muted' },
          ['this workspace: ', h('code', { text: (health && health.expectedRepoRoot) || '(unknown)' })]),
        h('div', { style: { marginTop: '8px' } },
          ['Restart the sidecar from THIS worktree: ', h('code', { text: 'npm run sprites:gallery' })])
      ]);
    }
    var su = startup || {};
    if (su.state === 'starting') {
      return h('div', { class: 'panel warn' }, [
        h('div', { class: 'section-title', text: 'Starting sprite service\u2026' }),
        h('div', null, ['The repo-scoped service is starting. Refresh in a moment.'])
      ]);
    }
    var errMsg = su.error || 'The managed sprite service is unavailable.';
    var children = [
      h('div', { class: 'section-title', text: 'Sprite service unavailable' }),
      h('div', null, [errMsg])
    ];
    if (su.logPath) {
      children.push(h('div', { class: 'muted', style: { marginTop: '6px' } },
        ['Log: ', h('code', { text: su.logPath })]));
    }
    children.push(h('div', { style: { marginTop: '8px' } },
      ['Start manually: ', h('code', { text: 'npm run sprites:gallery' })]));
    return h('div', { class: 'panel warn' }, children);
  }

  var byRunIdDesc = function (a, b) { return a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0; };

  function displayRuns() {
    var filter = filterSelect ? filterSelect.value : 'all';
    var filtered = currentRuns.filter(function (run) {
      var enr = enrichment.get(runKey(run));
      if (!enr) return true; // enrichment not loaded yet — never hide prematurely
      if (filter === 'approved') return enr.approvedCount > 0;
      if (filter === 'unapproved') return enr.approvedCount === 0;
      if (filter === 'brief-stored') return enr.briefStored;
      if (filter === 'brief-missing') return !enr.briefStored;
      return true;
    });
    var sorted = filtered.slice();
    var sort = sortSelect ? sortSelect.value : 'newest';
    if (sort === 'oldest') {
      sorted.sort(function (a, b) { return -byRunIdDesc(a, b); });
    } else if (sort === 'brief') {
      sorted.sort(function (a, b) { return a.briefId.localeCompare(b.briefId) || byRunIdDesc(a, b); });
    } else if (sort === 'approved') {
      sorted.sort(function (a, b) {
        var av = enrichment.get(runKey(a)); var bv = enrichment.get(runKey(b));
        return ((bv ? bv.approvedCount : -1) - (av ? av.approvedCount : -1)) || byRunIdDesc(a, b);
      });
    } else {
      sorted.sort(byRunIdDesc);
    }
    return sorted;
  }

  function renderRows() {
    var scope = currentScope();
    var rows = displayRuns();
    if (rows.length === 0) {
      listHost.replaceChildren(h('div', {
        text: currentRuns.length === 0 ? 'No runs in this scope.' : 'No runs match this filter.',
        style: { color: '#94a3b8', fontSize: '13px', padding: '10px 2px' } }));
      return;
    }
    var table = h('table', null, []);
    var head = document.createElement('thead');
    var headRow = document.createElement('tr');
    var labels = ['', 'Sheet', 'Approved art', 'Brief', 'Run', 'Timestamp', 'Variants', 'Brief stored'];
    for (var li = 0; li < labels.length; li++) {
      headRow.appendChild(h('th', { text: labels[li] }));
    }
    head.appendChild(headRow);
    table.appendChild(head);
    var body = document.createElement('tbody');
    for (var ri = 0; ri < rows.length; ri++) {
      var run = rows[ri];
      var enr = enrichment.get(runKey(run));
      var key = keyForStorageRun(scope, run);
      var row = document.createElement('tr');

      var checkCell = h('td', null, []);
      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selected[key] === true;
      (function (k, cb) {
        cb.addEventListener('change', function () {
          if (cb.checked) { selected[k] = true; }
          else { delete selected[k]; }
        });
      })(key, checkbox);
      checkCell.appendChild(checkbox);
      row.appendChild(checkCell);

      // Sprite-sheet thumbnail (active scope only — archived runs live under a
      // different key prefix the image routes don't serve).
      var sheetCell = h('td', null, []);
      if (!enr) sheetCell.appendChild(dots());
      else if (scope === 'active' && enr.sheetFile) sheetCell.appendChild(makeThumb(imgUrl('sheet', run.briefId, run.runId, enr.sheetFile), 56, enr.sheetFile));
      else sheetCell.appendChild(dash());
      row.appendChild(sheetCell);

      // First approved variant for the brief (from wherever it was approved).
      var approvedCell = h('td', null, []);
      if (!enr) approvedCell.appendChild(dots());
      else if (enr.firstApproved) {
        approvedCell.appendChild(makeThumb(
          imgUrl('processed', run.briefId, enr.firstApproved.runId, pad2(enr.firstApproved.variantIndex) + '.png'),
          48, 'Approved variant #' + enr.firstApproved.variantIndex + ' (from ' + enr.firstApproved.runId + ')'));
      } else approvedCell.appendChild(dash());
      row.appendChild(approvedCell);

      row.appendChild(h('td', { text: run.briefId }));
      row.appendChild(h('td', { text: run.runId }));
      row.appendChild(h('td', { text: run.timestamp != null ? run.timestamp : '\u2014' }));

      var variantsCell = h('td', null, []);
      if (!enr) variantsCell.appendChild(dots());
      else if (enr.approvedCount > 0) variantsCell.appendChild(makePill(
        enr.variantCount !== null ? (enr.approvedCount + ' approved / ' + enr.variantCount) : (enr.approvedCount + ' approved'), 'good'));
      else variantsCell.appendChild(makePill(
        enr.variantCount !== null ? ('0 / ' + enr.variantCount + ' approved') : 'none approved', 'muted'));
      row.appendChild(variantsCell);

      var briefCell = h('td', null, []);
      if (!enr) briefCell.appendChild(dots());
      else briefCell.appendChild(enr.briefStored ? makePill('\u2713 stored', 'good') : makePill('\u2717 missing', 'warn'));
      row.appendChild(briefCell);

      body.appendChild(row);
    }
    table.appendChild(body);
    listHost.replaceChildren(table);
  }

  function readErrorMessage(payload, fallback) {
    if (payload && typeof payload.message === 'string' && payload.message) return payload.message;
    if (payload && typeof payload.error === 'string' && payload.error) return payload.error;
    return fallback;
  }

  function loadEnrichment(seq, scope, runs) {
    if (runs.length === 0) return;
    fetch('/api/enrich', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: scope, runs: runs.map(function (r) { return { briefId: r.briefId, runId: r.runId }; }) })
    }).then(function (r) {
      return r.text().then(function (t) {
        var p = null; try { p = t ? JSON.parse(t) : null; } catch (e) { p = null; }
        if (!r.ok) throw new Error(readErrorMessage(p, 'HTTP ' + r.status));
        return p;
      });
    }).then(function (payload) {
      if (seq !== requestSeq) return; // stale — a newer load superseded this
      var list = payload && Array.isArray(payload.enriched) ? payload.enriched : [];
      var map = new Map();
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        if (e && typeof e.briefId === 'string' && typeof e.runId === 'string') map.set(e.briefId + '/' + e.runId, e);
      }
      enrichment = map;
      renderRows();
    }).catch(function (err) {
      if (seq !== requestSeq) return;
      statusEl.textContent = statusEl.textContent + ' \u00b7 enrichment unavailable: ' + (err && err.message ? err.message : String(err));
    });
  }

  function reload() {
    var scope = currentScope();
    var seq = ++requestSeq;
    var search = searchInput ? searchInput.value : '';
    statusEl.textContent = 'Loading runs\u2026';
    enrichment = new Map();
    setBusy(true, 'Loading runs\u2026');
    fetch('/api/runs?scope=' + encodeURIComponent(scope) + '&search=' + encodeURIComponent(search), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (payload) {
        setBusy(false);
        if (seq !== requestSeq) return; // stale response — drop it
        health = payload && payload.health ? payload.health : { state: 'down' };
        updateHealthUI();
        if (health.state !== 'up') {
          currentRuns = [];
          var startup = payload && payload.sidecarStartup ? payload.sidecarStartup : null;
          app_showDegrade(startup, payload && payload.error);
          return;
        }
        currentRuns = payload && Array.isArray(payload.runs) ? payload.runs : [];
        renderRows();
        statusEl.textContent = 'Loaded ' + currentRuns.length + ' ' + scope + ' run(s).';
        if (payload && payload.error) statusEl.textContent = statusEl.textContent + ' \u00b7 ' + payload.error;
        loadEnrichment(seq, scope, currentRuns);
      })
      .catch(function (err) {
        setBusy(false);
        if (seq !== requestSeq) return;
        statusEl.textContent = 'Failed to load runs: ' + (err && err.message ? err.message : String(err));
      });
  }

  function app_showDegrade(startup, errorText) {
    var frag = document.createDocumentFragment();
    if (errorText) frag.appendChild(h('div', { class: 'panel error', style: { marginBottom: '10px' }, text: errorText }));
    frag.appendChild(renderDegrade(startup));
    listHost.replaceChildren(frag);
    statusEl.textContent = 'Sidecar unavailable \u2014 start it and Refresh.';
  }

  // --- DESTRUCTIVE ops — EXACT monolith confirm/status UX, token-guarded. ---

  function pruneInvalid(invalidKeys) {
    if (!Array.isArray(invalidKeys)) return;
    for (var i = 0; i < invalidKeys.length; i++) {
      var k = invalidKeys[i];
      delete selected[k];
    }
    renderRows();
  }

  function mutate(path, keys, verb, onOk) {
    fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-storage-mutation-token': mutationToken },
      body: JSON.stringify({ keys: keys })
    }).then(function (r) {
      return r.text().then(function (t) {
        var p = null; try { p = t ? JSON.parse(t) : null; } catch (e) { p = null; }
        return { ok: r.ok, status: r.status, payload: p };
      });
    }).then(function (res) {
      if (res.status === 400 && res.payload && Array.isArray(res.payload.invalidKeys)) {
        pruneInvalid(res.payload.invalidKeys);
        statusEl.textContent = 'Failed to ' + verb + ' runs: ' + readErrorMessage(res.payload, 'invalid keys');
        return;
      }
      if (!res.ok) {
        statusEl.textContent = 'Failed to ' + verb + ' runs: ' + readErrorMessage(res.payload, 'HTTP ' + res.status);
        return;
      }
      onOk(res.payload || {});
      clearSelection();
      reload();
    }).catch(function (err) {
      statusEl.textContent = 'Failed to ' + verb + ' runs: ' + (err && err.message ? err.message : String(err));
    });
  }

  if (archiveBtn) archiveBtn.addEventListener('click', function () {
    // Archive is ACTIVE-only, exactly like the monolith (skip archive-prefixed keys).
    var keys = selectKeys().filter(function (k) { return k.indexOf('archive/') !== 0; });
    if (keys.length === 0) { statusEl.textContent = 'Select at least one active run to archive.'; return; }
    if (!window.confirm('Archive ' + keys.length + ' run(s)?')) return;
    mutate('/api/archive', keys, 'archive', function (p) {
      var archived = Array.isArray(p.archived) ? p.archived.length : 0;
      var skipped = Array.isArray(p.skipped) ? p.skipped.length : 0;
      statusEl.textContent = 'Archived ' + archived + '; skipped ' + skipped + '.';
    });
  });

  if (deleteBtn) deleteBtn.addEventListener('click', function () {
    var keys = selectKeys();
    if (keys.length === 0) { statusEl.textContent = 'Select at least one run to delete.'; return; }
    if (!window.confirm('Permanently delete ' + keys.length + ' run(s)? This cannot be undone.')) return;
    mutate('/api/delete', keys, 'delete', function (p) {
      var deleted = Array.isArray(p.deleted) ? p.deleted.length : 0;
      statusEl.textContent = 'Deleted ' + deleted + ' run(s).';
    });
  });

  if (refreshBtn) refreshBtn.addEventListener('click', function () { reload(); });
  if (scopeSelect) scopeSelect.addEventListener('change', function () { clearSelection(); reload(); });
  if (searchInput) searchInput.addEventListener('change', function () { reload(); });
  if (sortSelect) sortSelect.addEventListener('change', function () { renderRows(); });
  if (filterSelect) filterSelect.addEventListener('change', function () { renderRows(); });

  reload();
})();
`;

/**
 * Full HTML document for one canvas instance.
 * @param {string} instanceId
 * @param {{ mutationToken?: string }} [options] — per-instance secret required on
 *   the destructive `/api/archive` + `/api/delete` routes; minted by the extension
 *   and embedded here so only this iframe can issue mutations.
 * @returns {string}
 */
export function renderHtml(instanceId, options = {}) {
  const mutationToken = typeof options.mutationToken === 'string' ? options.mutationToken : '';
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<title>Storage Lifecycle</title>',
    '<style>' + STYLES + '</style>',
    '</head><body>',
    '<header class="between">',
    '<div>',
    '<h1>Storage Lifecycle</h1>',
    '<div class="muted">List, search, archive &amp; delete sprite-run blobs in Azure across active and archive scopes.</div>',
    '</div>',
    '<div class="row"><span id="health-badge" class="badge-health down">down</span><span id="health-meta" class="muted"></span></div>',
    '</header>',
    '<div class="toolbar">',
    '<select id="scope-select" title="Scope">',
    '<option value="active">Active runs</option>',
    '<option value="archive">Archive</option>',
    '</select>',
    '<input id="search-input" type="search" placeholder="Search brief or run id" />',
    '<button id="refresh-btn" type="button">Refresh</button>',
    '<button id="archive-btn" type="button" title="Archive the selected active runs">Archive selected</button>',
    '<button id="delete-btn" type="button" title="Permanently delete the selected runs">Delete selected</button>',
    '<span id="busy" class="busy" hidden><span class="spinner"></span><span id="busy-label">Loading…</span></span>',
    '</div>',
    '<div class="toolbar">',
    '<select id="sort-select" title="Sort order">',
    '<option value="newest">Sort: Newest first</option>',
    '<option value="oldest">Sort: Oldest first</option>',
    '<option value="brief">Sort: Brief (A–Z)</option>',
    '<option value="approved">Sort: Most approved</option>',
    '</select>',
    '<select id="filter-select" title="Filter runs">',
    '<option value="all">Show: All runs</option>',
    '<option value="approved">Show: Has approved</option>',
    '<option value="unapproved">Show: No approved</option>',
    '<option value="brief-stored">Show: Brief stored</option>',
    '<option value="brief-missing">Show: Brief missing</option>',
    '</select>',
    '</div>',
    '<div id="status">Loading…</div>',
    '<div id="app" data-instance="' +
      escapeHtml(instanceId) +
      '" data-mutation-token="' +
      escapeHtml(mutationToken) +
      '">',
    '<div id="list-host"><p class="muted">Loading storage runs…</p></div>',
    '</div>',
    '<script>' + CLIENT_SCRIPT + '</script>',
    '</body></html>',
  ].join('');
}
