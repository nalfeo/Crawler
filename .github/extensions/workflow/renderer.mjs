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
 * This is a READ-ONLY parity view of the READ surface of the monolith's
 * `sprite-generation-workflow` page: it browses the asset backlog, plans/briefs,
 * and generated runs. The durable queue + asset-request manifest (their status
 * reads AND controls) plus the write half of the workflow (synthesize/generate/
 * judge/approve/checkin/metadata, worker/issues start-stop, the interactive queue
 * state machine) are the documented follow-up slice (B2).
 *
 * The client script is intentionally template-literal-free (plain string concat +
 * createElement) so this whole file stays one clean outer template literal with no
 * escaping.
 *
 * @module workflow/renderer
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
  select, button {
    background: #0f172a; color: #e2e8f0;
    border: 1px solid rgba(148,163,184,0.35); border-radius: 6px;
    padding: 6px 10px; font-size: 13px; font-family: inherit;
  }
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
`;

// NOTE: template-literal-free on purpose (no backticks, no ${}) — see file header.
const CLIENT_SCRIPT = String.raw`
(function () {
  'use strict';
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
    { key: 'styleMatch', label: 'Style match' },
    { key: 'briefMatch', label: 'Brief match' },
    { key: 'readability', label: 'Readability' }
  ];
  var TABS = [
    { id: 'backlog', label: 'Backlog' },
    { id: 'files', label: 'Plans & Briefs' },
    { id: 'runs', label: 'Runs' }
  ];
  var app = document.getElementById('app');
  var activeTab = 'backlog';
  var lastState = null;
  var openedFile = null; // { relPath, kind, content, error }
  var runFilter = 'all'; // all | promoted | not-promoted (matches sidecar API token)

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
    return h('div', { class: 'between' }, [
      h('div', null, [
        h('h1', { text: 'Sprite Generation Workflow' }),
        h('div', { class: 'muted', text: 'Read-only parity view: asset backlog, plans/briefs, generated runs.' })
      ]),
      h('div', { class: 'row' }, [badge, h('span', { class: 'muted', text: meta.join('  ·  ') })])
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

    return h('div', { class: 'row', style: { marginTop: '10px', marginBottom: '4px' } }, [
      h('span', { class: 'muted', text: 'Run:' }), picker,
      h('span', { class: 'muted', text: 'Filter:' }), filterSel,
      h('span', { class: 'muted', text: runs.length + ' shown' })
    ]);
  }

  function filteredRuns(state) {
    var runs = state.runs || [];
    if (runFilter === 'promoted') return runs.filter(function (r) { return r.promoted; });
    if (runFilter === 'not-promoted') return runs.filter(function (r) { return !r.promoted; });
    return runs;
  }

  function renderSheetSection(state) {
    var sel = state.selected;
    var sheets = state.sheets || [];
    var wrap = h('div', null, []);
    if (!sel) return wrap;

    if (state.autoSelectedLatest) {
      wrap.appendChild(h('div', { class: 'muted', style: { color: '#fde68a', marginBottom: '6px' },
        text: 'Auto-selected latest run (briefId/runId were not specified).' }));
    }
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

    var sheetWrap = h('div', { class: 'sheet-wrap' }, []);
    var loadingNote = h('div', { class: 'sheet-loading' }, [
      h('span', { class: 'spinner' }), 'Loading sheet from Azure…'
    ]);
    sheetWrap.appendChild(loadingNote);
    var img = document.createElement('img');
    img.className = 'sheet-img';
    img.src = imgUrl('sheet', sel.briefId, sel.runId, current);
    img.addEventListener('load', function () { loadingNote.remove(); drawOverlay(sheetWrap, img, sliceMap); });
    img.addEventListener('error', function () {
      loadingNote.remove();
      sheetWrap.appendChild(h('div', { style: { color: '#fca5a5', padding: '8px' },
        text: 'Failed to load sheet: ' + current }));
    });
    sheetWrap.appendChild(img);
    wrap.appendChild(sheetWrap);
    return wrap;
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

  function renderJudge(card, c) {
    card.appendChild(h('div', { class: 'section-title', text: 'Judge (advisory)' }));
    if (c.judge) {
      for (var i = 0; i < JUDGE_AXES.length; i++) {
        var axis = JUDGE_AXES[i];
        var score = c.judge[axis.key] || 0;
        var ok = score >= 3;
        card.appendChild(h('div', { class: 'axis' }, [
          h('span', { class: 'lbl', text: axis.label }),
          h('span', { style: { color: ok ? '#86efac' : '#fca5a5', fontWeight: '600' },
            text: (score || '–') + '/5 ' + (ok ? '✓' : '✗') })
        ]));
        var rationale = c.rationale ? c.rationale[axis.key] : null;
        if (rationale) card.appendChild(h('div', { class: 'rationale', text: rationale }));
      }
      var verdict = 'Verdict: ' + (c.judge.passed ? 'passed' : 'rejected') + ' · lowest axis ' + c.judge.minScore + '/5';
      if (c.judge.rejectedBy && c.judge.rejectedBy.length) verdict += ' · rejected on ' + c.judge.rejectedBy.join(', ');
      card.appendChild(h('div', { style: { fontSize: '10px', color: c.judge.passed ? '#86efac' : '#fca5a5' },
        text: verdict }));
      var prov = [];
      if (c.modelDeployment) prov.push(c.modelDeployment);
      if (c.judgedAt) prov.push(c.judgedAt);
      if (prov.length) card.appendChild(h('div', { style: { fontSize: '9px', color: '#64748b' }, text: prov.join(' · ') }));
    } else {
      card.appendChild(h('div', { class: 'muted', text: c.judgeSkipMessage || 'Not judged yet.' }));
    }
  }

  function renderSensors(card, c) {
    card.appendChild(h('div', { class: 'section-title', text: 'Sensors' }));
    if (!c.sensors || c.sensors.length === 0) {
      card.appendChild(h('div', { class: 'muted', text: c.passed
        ? 'All sensors passed (no per-sensor detail recorded).'
        : 'No per-sensor detail recorded for this run.' }));
      return;
    }
    for (var i = 0; i < c.sensors.length; i++) {
      var s = c.sensors[i];
      card.appendChild(h('div', { class: 'sensor' }, [
        h('span', { text: s.sensor }),
        h('span', { style: { color: s.ok ? '#86efac' : '#fca5a5', fontWeight: '700' }, text: s.ok ? '✓' : '✗' })
      ]));
      if (!s.ok && (s.reason || s.pixelCount != null)) {
        card.appendChild(h('div', { class: 'sensor-reason',
          text: (s.reason || 'failed') + (s.pixelCount != null ? ' (' + s.pixelCount + 'px)' : '') }));
      }
    }
  }

  function renderCandidates(state) {
    var sel = state.selected;
    var cands = state.candidates || [];
    var wrap = h('div', { style: { marginTop: '16px' } }, [
      h('div', { class: 'section-title', text: 'Variants & pipeline traces (' + cands.length + ')' })
    ]);
    if (!sel || cands.length === 0) {
      wrap.appendChild(h('div', { class: 'muted', text: 'No variant traces recorded for this run.' }));
      return wrap;
    }
    var grid = h('div', { class: 'cards' }, []);
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      var status = candidateStatus(c);
      var card = h('div', { class: 'card' }, []);
      card.appendChild(h('div', { class: 'between' }, [
        h('strong', { text: 'Variant #' + c.index }),
        h('span', { text: c.score + '/' + c.outOf, class: 'muted' })
      ]));
      card.appendChild(h('span', { class: 'status-pill', style: { color: STATUS_COLORS[status.kind] }, text: status.label }));
      var thumb = document.createElement('img');
      thumb.className = 'thumb';
      thumb.src = imgUrl('processed', sel.briefId, sel.runId, pad2(c.index) + '.png');
      thumb.alt = 'variant ' + c.index;
      card.appendChild(thumb);
      renderJudge(card, c);
      renderSensors(card, c);
      grid.appendChild(card);
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


  // ---- Tab bar + top-level render ----------------------------------------
  function renderTabs(state) {
    var bar = h('div', { class: 'tabs' }, []);
    var counts = {
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
    if (activeTab === 'files') return renderFiles(state);
    if (activeTab === 'runs') return renderRuns(state);
    return renderBacklog(state);
  }

  function render(state) {
    if (!state) return;
    lastState = state;
    var frag = document.createDocumentFragment();
    frag.appendChild(renderHealth(state));
    if (state.error) {
      frag.appendChild(h('div', { class: 'panel error', style: { marginTop: '12px' }, text: state.error }));
    }
    frag.appendChild(renderTabs(state));
    frag.appendChild(h('div', { style: { marginTop: '4px' } }, [renderActiveTab(state)]));
    app.replaceChildren(frag);
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
 * @returns {string}
 */
export function renderHtml(instanceId) {
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
    '<script>' + CLIENT_SCRIPT + '</script>',
    '</body></html>',
  ].join('');
}
