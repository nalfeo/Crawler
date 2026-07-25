// Renderer: HTML + CSS + client-side JS for the agent-perf-panel canvas.
//
// This file is imported by extension.mjs and only exports `renderHtml()`.
// The whole panel is a single-page vanilla-JS app that fetches JSON from the
// same-origin extension HTTP server. Charts are hand-rolled SVG (no CDN /
// no bundling), so the panel works fully offline.

export function renderHtml(_instanceId) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Agent Perf Panel</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>${STYLES}</style>
</head>
<body>
  <header>
    <h1>Agent Perf Panel</h1>
    <div id="topbar">
      <label>Repo <select id="repoSel"></select></label>
      <label>Range
        <select id="rangeSel">
          <option value="1">last 24h</option>
          <option value="3">last 3d</option>
          <option value="7" selected>last 7d</option>
          <option value="30">last 30d</option>
          <option value="90">last 90d</option>
          <option value="all">all</option>
        </select>
      </label>
      <label>Session <select id="sessSel"><option value="">— aggregate view —</option></select></label>
      <button id="refreshBtn" title="Reload data">↻</button>
      <span id="status"></span>
    </div>
  </header>
  <nav id="tabs">
    <button data-tab="overview" class="active">Overview</button>
    <button data-tab="waterfall">Waterfall</button>
    <button data-tab="longpoles">Long poles</button>
    <button data-tab="tokens">Tokens &amp; context</button>
    <button data-tab="subagents">Sub-agents &amp; skills</button>
    <button data-tab="hooks">Hooks / guards</button>
    <button data-tab="aggregate">Aggregate</button>
  </nav>
  <main>
    <section id="overview" class="tab active"></section>
    <section id="waterfall" class="tab"></section>
    <section id="longpoles" class="tab"></section>
    <section id="tokens" class="tab"></section>
    <section id="subagents" class="tab"></section>
    <section id="hooks" class="tab"></section>
    <section id="aggregate" class="tab"></section>
  </main>
  <script>${CLIENT_SCRIPT}</script>
</body>
</html>`;
}

const STYLES = `
:root {
  --bg: #0d1117;
  --bg-alt: #161b22;
  --border: #30363d;
  --text: #e6edf3;
  --muted: #8b949e;
  --accent: #58a6ff;
  --warn: #d29922;
  --err: #f85149;
  --ok: #3fb950;
  --serial: #58a6ff;
  --parallel: #a371f7;
  --hook: #d29922;
  --api: #3fb950;
}
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); font-size: 13px; }
header { padding: 12px 16px 8px; border-bottom: 1px solid var(--border); }
h1 { margin: 0 0 8px; font-size: 15px; font-weight: 600; }
#topbar { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
#topbar label { display: inline-flex; gap: 6px; align-items: center; color: var(--muted); font-size: 12px; }
#topbar select, #topbar button { background: var(--bg-alt); color: var(--text); border: 1px solid var(--border); padding: 4px 8px; border-radius: 4px; font: inherit; }
#topbar select { min-width: 150px; }
#topbar select#sessSel { min-width: 320px; }
#topbar button { cursor: pointer; }
#status { color: var(--muted); font-size: 12px; margin-left: auto; }
#tabs { display: flex; gap: 4px; padding: 4px 16px; border-bottom: 1px solid var(--border); background: var(--bg-alt); }
#tabs button { background: transparent; color: var(--muted); border: 0; padding: 8px 12px; cursor: pointer; border-radius: 4px 4px 0 0; font: inherit; }
#tabs button.active { color: var(--accent); border-bottom: 2px solid var(--accent); }
#tabs button:hover:not(.active) { color: var(--text); }
main { padding: 16px; }
.tab { display: none; }
.tab.active { display: block; }
.kpis { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; margin-bottom: 20px; }
.kpi { padding: 10px 12px; background: var(--bg-alt); border: 1px solid var(--border); border-radius: 6px; }
.kpi .k { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.kpi .v { font-size: 20px; font-weight: 600; margin-top: 4px; }
.kpi .sub { font-size: 11px; color: var(--muted); margin-top: 2px; }
.panel { background: var(--bg-alt); border: 1px solid var(--border); border-radius: 6px; padding: 14px; margin-bottom: 16px; }
.panel h2 { margin: 0 0 10px; font-size: 13px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--border); }
th { color: var(--muted); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tr:hover td { background: rgba(88, 166, 255, 0.05); }
.bar { display: inline-block; height: 8px; background: var(--accent); border-radius: 2px; vertical-align: middle; }
.bar.warn { background: var(--warn); }
.bar.hook { background: var(--hook); }
.bar.parallel { background: var(--parallel); }
.bar.err { background: var(--err); }
.empty { color: var(--muted); font-style: italic; padding: 20px; text-align: center; }
svg { display: block; overflow: visible; }
svg text { fill: var(--text); font-size: 10px; }
svg text.muted { fill: var(--muted); }
svg .grid line { stroke: var(--border); stroke-width: 1; }
svg .axis text { fill: var(--muted); }
.wf-row { display: flex; align-items: center; gap: 8px; font-size: 11px; padding: 2px 0; }
.wf-row .label { min-width: 200px; max-width: 200px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wf-row .track { flex: 1; height: 14px; background: rgba(255,255,255,.02); border-radius: 2px; position: relative; }
.wf-row .track .seg { position: absolute; top: 1px; bottom: 1px; border-radius: 2px; background: var(--serial); }
.wf-row .track .seg.parallel { background: var(--parallel); }
.wf-row .track .seg.hook { background: var(--hook); }
.wf-row .track .seg.err { background: var(--err); }
.wf-row .dur { min-width: 60px; text-align: right; color: var(--muted); font-variant-numeric: tabular-nums; }
.wf-scroll { max-height: 560px; overflow: auto; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); }
.wf-axis { display: flex; align-items: center; gap: 8px; padding: 6px 0; background: var(--bg-alt); border-bottom: 1px solid var(--border); }
.wf-axis .label { min-width: 200px; max-width: 200px; }
.wf-axis .dur { min-width: 60px; }
.wf-axis .ruler { flex: 1; position: relative; height: 16px; }
.wf-axis .ruler .tick { position: absolute; top: 0; bottom: 0; }
.wf-axis .ruler .tick i { position: absolute; top: 0; bottom: 0; left: 0; width: 1px; background: var(--border); }
.wf-axis .ruler .tick b { position: absolute; top: 2px; left: 0; transform: translateX(-50%); color: var(--muted); font-weight: 500; font-size: 10px; white-space: nowrap; }
.wf-axis .ruler .tick.start b { transform: translateX(0); }
.wf-axis .ruler .tick.end b { transform: translateX(-100%); }
.wf-plot { position: relative; padding: 4px 0; }
.wf-plot .wf-grid { position: absolute; top: 0; bottom: 0; left: 208px; right: 68px; pointer-events: none; z-index: 0; }
.wf-plot .wf-grid .wf-gl { position: absolute; top: 0; bottom: 0; width: 1px; background: rgba(139,148,158,.16); }
.wf-plot .wf-row { position: relative; z-index: 1; padding: 1px 0; }
.wf-plot .wf-row .track { background: transparent; }
/* Bar POSITION is always the true leftPct; only rendered WIDTH has a 1px floor so
   sub-pixel/0ms spans stay visible + hoverable. 1px is below the visual-overlap
   threshold, so it can't manufacture a false "parallel" look between adjacent bars. */
.wf-plot .wf-row .track .seg { min-width: 1px; }
.wf-dot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 6px; vertical-align: middle; }
.wf-turn { display: flex; gap: 10px; align-items: baseline; padding: 8px 0 3px; margin-top: 2px; border-top: 1px dashed var(--border); font-size: 10px; text-transform: uppercase; letter-spacing: .04em; position: relative; z-index: 1; }
.wf-turn .idx { color: var(--text); font-weight: 600; }
/* Sticky header holding the context strip + axis ruler. Both live INSIDE .wf-scroll
   with the lanes, so they share the same scrollbar gutter and flex columns —
   guaranteeing the context markers line up over the tool lanes. */
.wf-head { position: sticky; top: 0; z-index: 3; background: var(--bg-alt); }
.wf-ctx { display: flex; align-items: flex-end; gap: 8px; padding: 8px 0 2px; }
.wf-ctx .label { min-width: 200px; max-width: 200px; color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; align-self: center; }
.wf-ctx .dur { min-width: 60px; text-align: right; color: var(--accent); font-size: 11px; font-variant-numeric: tabular-nums; align-self: center; }
.wf-ctx .track { flex: 1; position: relative; height: 54px; background: linear-gradient(to top, rgba(88,166,255,.05), transparent); border-bottom: 1px solid var(--border); }
.wf-ctx.empty { align-items: center; }
.wf-ctx.empty .track { height: auto; background: none; border-bottom: 0; font-size: 11px; padding: 2px 0; }
.wf-ctx .track .budget { position: absolute; left: 0; right: 0; height: 0; border-top: 1px dashed var(--warn); opacity: .75; }
.wf-ctx .track .budget::after { content: 'budget'; position: absolute; right: 0; top: -11px; font-size: 9px; color: var(--warn); letter-spacing: .03em; }
.wf-ctx .track .pt { position: absolute; top: 0; bottom: 0; width: 0; }
.wf-ctx .track .pt .stem { position: absolute; left: 0; bottom: 0; height: var(--h); border-left: 1px solid rgba(88,166,255,.45); }
.wf-ctx .track .pt .knob { position: absolute; left: 0; bottom: var(--h); width: 8px; height: 8px; border-radius: 50%; background: var(--accent); transform: translate(-50%, 50%); box-shadow: 0 0 0 2px var(--bg-alt); }
.wf-ctx .track .pt.over .knob { background: var(--err); }
.wf-ctx .track .pt.over .stem { border-left-color: rgba(248,81,73,.5); }
.wf-ctx .track .pt.off .knob { background: transparent; border: 1px dashed var(--muted); box-shadow: none; }
.legend { display: flex; gap: 12px; align-items: center; margin: 8px 0 14px; font-size: 11px; color: var(--muted); }
.legend .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: middle; }
.legend .swatch.ctxk { background: var(--accent); border-radius: 50%; width: 8px; height: 8px; }
.summary-block { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.summary-block > .panel { margin: 0; }
.pill { display: inline-block; padding: 2px 8px; border-radius: 999px; background: var(--bg); border: 1px solid var(--border); font-size: 10px; color: var(--muted); }
.pill.model { color: var(--accent); border-color: var(--accent); }
code { background: var(--bg); padding: 1px 4px; border-radius: 3px; font-size: 11px; }
.muted { color: var(--muted); }
`;

const CLIENT_SCRIPT = `
(async function () {
  const $ = (id) => document.getElementById(id);
  const state = { repo: '', days: 7, sessionId: '', currentSummary: null, currentAggregate: null };

  async function api(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }

  function fmtMs(ms) {
    // Reserve the em-dash for genuinely missing/invalid values; a real 0ms
    // duration must render as "0ms", not look like missing data.
    if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
    if (ms < 1000) return ms + 'ms';
    if (ms < 60_000) return (ms / 1000).toFixed(1) + 's';
    const m = Math.floor(ms / 60_000);
    const s = Math.round((ms % 60_000) / 1000);
    return m + 'm' + (s ? s + 's' : '');
  }
  function fmtInt(n) { return n == null ? '—' : n.toLocaleString('en-US'); }
  function fmtK(n) {
    if (n == null || !Number.isFinite(n)) return '—';
    if (n < 1000) return String(Math.round(n));
    if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'K';
    return (n / 1_000_000).toFixed(1) + 'M';
  }
  function fmtPct(x) { return (x * 100).toFixed(1) + '%'; }
  function fmtBytes(n) {
    if (!n) return '—';
    if (n < 1024) return n + 'B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB';
    return (n / (1024 * 1024)).toFixed(1) + 'MB';
  }
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  function setStatus(text) { $('status').textContent = text || ''; }

  async function loadRepos() {
    const { repositories } = await api('/api/repositories');
    const sel = $('repoSel');
    sel.innerHTML = '';
    for (const r of repositories) {
      const opt = document.createElement('option');
      opt.value = r.repository;
      opt.textContent = r.repository + ' (' + r.sessionCount + ')';
      sel.appendChild(opt);
    }
    // Honor a repo pre-selected via the open() URL fragment; else default to
    // Crawler if present; else the first (most-active) repo.
    const preselected = state.repo && repositories.some((r) => r.repository === state.repo);
    const crawler = repositories.find((r) => /crawler/i.test(r.repository));
    sel.value = preselected ? state.repo : crawler ? crawler.repository : repositories[0]?.repository || '';
    state.repo = sel.value;
  }

  async function loadSessions() {
    setStatus('loading sessions…');
    const days = $('rangeSel').value;
    state.days = days === 'all' ? 3650 : parseInt(days, 10);
    const sinceIso = days === 'all' ? '' : new Date(Date.now() - state.days * 86400e3).toISOString();
    const q = new URLSearchParams({ repository: state.repo, sinceIso, limit: '400' });
    const { sessions } = await api('/api/sessions?' + q.toString());
    const sel = $('sessSel');
    sel.innerHTML = '<option value="">— aggregate view —</option>';
    for (const s of sessions) {
      const opt = document.createElement('option');
      opt.value = s.id;
      const date = s.updatedAt.slice(0, 16).replace('T', ' ');
      const size = fmtBytes(s.eventLogBytes || 0);
      const label = date + '  ' + (s.branch || '(chat)') + '  ' + (s.summary || '').slice(0, 60);
      opt.textContent = label + '  · ' + size + (s.hasEventLog ? '' : '  · NO LOG');
      opt.disabled = !s.hasEventLog;
      sel.appendChild(opt);
    }
    // Keep the dropdown in sync with a session pre-selected via the open()
    // fragment or preserved across a refresh. If that session is outside the
    // current range, inject a synthetic option instead of silently dropping the
    // deep link back to the aggregate view.
    if (state.sessionId) {
      if (!sessions.some((s) => s.id === state.sessionId)) {
        const opt = document.createElement('option');
        opt.value = state.sessionId;
        opt.textContent = 'selected session ' + state.sessionId.slice(0, 8) + '… (outside range)';
        sel.appendChild(opt);
      }
      sel.value = state.sessionId;
    }
    setStatus(sessions.length + ' sessions in range');
    return sessions;
  }

  function switchTab(id) {
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === id));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === id));
    render();
  }

  async function render() {
    const active = document.querySelector('#tabs button.active').dataset.tab;
    const section = $(active);
    section.innerHTML = '<div class="empty">loading…</div>';
    try {
      if (state.sessionId) {
        if (!state.currentSummary || state.currentSummary.sessionId !== state.sessionId) {
          state.currentSummary = await api('/api/session/' + state.sessionId);
        }
        renderSession(active, state.currentSummary);
      } else {
        if (!state.currentAggregate) {
          const sinceIso = state.days >= 3650 ? '' : new Date(Date.now() - state.days * 86400e3).toISOString();
          const q = new URLSearchParams({ repository: state.repo, sinceIso });
          state.currentAggregate = await api('/api/aggregate?' + q.toString());
        }
        renderAggregate(active, state.currentAggregate);
      }
    } catch (e) {
      section.innerHTML = '<div class="empty">error: ' + esc(e.message) + '</div>';
    }
  }

  function renderSession(tab, s) {
    const section = $(tab);
    switch (tab) {
      case 'overview': return section.innerHTML = viewOverview(s);
      case 'waterfall': return section.innerHTML = viewWaterfall(s);
      case 'longpoles': return section.innerHTML = viewLongPoles(s);
      case 'tokens': return section.innerHTML = viewTokens(s);
      case 'subagents': return section.innerHTML = viewSubagents(s);
      case 'hooks': return section.innerHTML = viewHooks(s);
      case 'aggregate': return section.innerHTML = '<div class="empty">Aggregate view is disabled while a single session is selected. Choose "— aggregate view —" in the top bar.</div>';
    }
  }
  function renderAggregate(tab, a) {
    const section = $(tab);
    if (tab === 'aggregate' || tab === 'overview' || tab === 'longpoles' || tab === 'tokens') {
      return section.innerHTML = viewAggregate(a, tab);
    }
    section.innerHTML = '<div class="empty">Select a specific session to see this view.</div>';
  }

  // ---------- Session views ----------
  function viewOverview(s) {
    const t = s.totals;
    return \`
      <div class="kpis">
        \${kpi('Wall time', fmtMs(s.walltimeMs), \`\${t.turns} turns · \${t.userMessages} user prompts\`)}
        \${kpi('Tool time', fmtMs(t.toolTimeMs), \`\${t.toolCalls} calls · peak \${t.maxParallelism}× parallel\`)}
        \${kpi('Serial vs parallel', fmtMs(t.serialToolTimeMs) + ' / ' + fmtMs(t.parallelToolTimeMs), 'parallel share ' + fmtPct(t.parallelismRatio))}
        \${kpi('Idle time', fmtMs(t.idleTimeMs), 'waiting on user / model latency')}
        \${kpi('Model API calls', fmtInt(t.apiCalls), 'across ' + s.modelBreakdown.length + ' model(s)')}
        \${kpi('Output tokens', fmtInt(t.tokens.output), t.tokens.input ? fmtInt(t.tokens.input) + ' input tokens' : 'input tokens not logged locally')}
        \${kpi('Peak context', t.peakContextTokens ? fmtInt(t.peakContextTokens) + ' tok' : '—', s.modelContextBudget ? fmtPct((t.peakContextTokens || 0) / s.modelContextBudget) + ' of ' + fmtInt(s.modelContextBudget) + ' budget' : 'model budget unknown')}
        \${kpi('Compactions', fmtInt(t.compactions), (t.errors ? t.errors + ' errors' : 'no errors'))}
        \${kpi('Hook time', fmtMs(t.hookTimeMs), fmtInt(t.hookInvocations) + ' invocations')}
        \${kpi('Sub-agent spawns', fmtInt(t.subagentSpawns), fmtInt(t.skillInvocations) + ' skill invocations')}
        \${kpi('Reasoning', fmtBytes(t.reasoningChars) + ' text', fmtBytes(t.reasoningOpaqueBytes) + ' opaque')}
        \${kpi('External tools', fmtInt(t.externalToolRequests), fmtInt(t.externalToolCompletions) + ' completed')}
      </div>
      <div class="panel">
        <h2>Session identity</h2>
        <div><span class="pill model">\${esc(s.budgetModel || s.selectedModel || 'unknown')}</span>
          \${s.producer ? '<span class="pill">' + esc(s.producer) + '</span>' : ''}
          \${s.repository ? '<span class="pill">' + esc(s.repository) + '</span>' : ''}
          \${s.branch ? '<span class="pill">' + esc(s.branch) + '</span>' : ''}
        </div>
        <p class="muted" style="margin: 10px 0 0;">Session <code>\${s.sessionId}</code></p>
      </div>
      \${modelBreakdownPanel(s.modelBreakdown)}
      \${turnTimingChart(s.turns)}
    \`;
  }

  function contextPressureChart(wf) {
    const ctx = wf && wf.context;
    // Column layout mirrors .wf-row / .wf-axis so the track lines up with the lanes.
    if (!ctx || !ctx.hasData) {
      const note = ctx && ctx.budgetTokens
        ? 'No compactions in range — no context high-water mark was recorded (size is only sampled when a compaction fires; configured budget ' + fmtK(ctx.budgetTokens) + ' tokens).'
        : 'No compactions in range — context-window size is only sampled when a compaction fires.';
      return '<div class="wf-ctx empty"><div class="label">context</div><div class="track"><span class="muted">' + esc(note) + '</span></div><div class="dur"></div></div>';
    }

    const budgetPct = ctx.budgetTokens ? Math.min(100, Math.max(0, (ctx.budgetTokens / ctx.maxTokens) * 100)) : null;
    const budgetLine = budgetPct != null
      ? '<div class="budget" style="top:' + (100 - budgetPct).toFixed(2) + '%" title="configured budget — ' + fmtInt(ctx.budgetTokens) + ' tokens (approximate; can be exceeded before compaction)"></div>'
      : '';

    const dots = ctx.points.map((p) => {
      const bd = p.breakdown;
      const parts = [];
      parts.push(fmtInt(p.tokens) + ' tokens at compaction');
      if (p.budgetPct != null) parts.push((p.budgetPct).toFixed(0) + '% of budget' + (p.overBudget ? ' (over budget)' : ''));
      if (p.by) parts.push('by ' + p.by);
      if (bd) {
        const seg = [];
        if (bd.systemTokens != null) seg.push('system ' + fmtK(bd.systemTokens));
        if (bd.conversationTokens != null) seg.push('conversation ' + fmtK(bd.conversationTokens));
        if (bd.toolDefinitionsTokens != null) seg.push('tools ' + fmtK(bd.toolDefinitionsTokens));
        if (seg.length) parts.push(seg.join(' · '));
      }
      if (p.offAxis) parts.push('(timestamp outside session span — clamped to edge)');
      const tip = parts.join(' — ');
      const cls = 'pt' + (p.overBudget ? ' over' : '') + (p.offAxis ? ' off' : '');
      // The tooltip must ride the visible stem + knob, not the .pt wrapper:
      // .wf-ctx .track .pt is width:0, so a title on the wrapper has no
      // hittable area and never shows on hover. A stem (baseline to dot) makes
      // each compaction a discrete sample; we do NOT draw a line BETWEEN
      // compactions because nothing measures context there.
      const tipAttr = ' title="' + esc(tip) + '"';
      return (
        '<div class="' + cls + '" style="left:' + p.xPct.toFixed(3) + '%;--h:' + p.tokensPct.toFixed(3) + '%">' +
          '<i class="stem"' + tipAttr + '></i><i class="knob"' + tipAttr + '></i>' +
        '</div>'
      );
    }).join('');

    const offNote = ctx.offAxisCount
      ? '<span class="muted" title="clamped to the axis edge">· ' + ctx.offAxisCount + ' off-axis</span>'
      : '';
    const peakLabel = fmtK(ctx.peakTokens);
    return (
      '<div class="wf-ctx">' +
        '<div class="label" title="Context-window high-water marks. Only sampled at compactions; not a continuous measurement.">context <span class="muted">peak</span> ' + offNote + '</div>' +
        '<div class="track">' + budgetLine + dots + '</div>' +
        '<div class="dur" title="peak recorded context (pre-compaction)">' + peakLabel + '</div>' +
      '</div>'
    );
  }

  function viewWaterfall(s) {
    const wf = s.waterfall;
    // Render the panel when there are tool lanes OR real context samples on the
    // session axis. A session with compactions but no tool calls still has a
    // meaningful context strip + ruler, so we only bail out entirely when there
    // is genuinely nothing to show.
    const hasRows = !!(wf && wf.rows && wf.rows.length);
    const hasContext = !!(wf && wf.context && wf.context.hasData);
    if (!wf || (!hasRows && !hasContext)) return '<div class="empty">No tool calls recorded.</div>';

    // A TRUE waterfall: one shared wall-clock time axis spanning the whole
    // session, one lane per tool call ordered by real start time. Each bar is
    // positioned by its actual start + duration, so serial calls cascade
    // down-and-right and parallel calls stack as overlapping bars.
    const ruler = wf.ticks.map((tk, i) => {
      const edge = i === 0 ? 'start' : i === wf.ticks.length - 1 ? 'end' : 'mid';
      return '<span class="tick ' + edge + '" style="left:' + tk.pct.toFixed(3) + '%"><i></i><b>' + fmtMs(Math.round(tk.ms)) + '</b></span>';
    }).join('');

    // Faint vertical turn boundaries across the plot (skipped when too crowded).
    const gridlines = wf.turnBands.length && wf.turnBands.length <= 200
      ? wf.turnBands.map((b) => '<div class="wf-gl" style="left:' + b.leftPct.toFixed(3) + '%" title="turn ' + b.turnIndex + ' — starts +' + fmtMs(Math.round(b.startOffsetMs)) + ', ' + fmtMs(b.durationMs) + '"></div>').join('')
      : '';

    // Lanes, with a compact turn separator whenever the turn changes.
    const bandByTurn = new Map(wf.turnBands.map((b) => [b.turnIndex, b]));
    let prevTurn = null;
    const body = [];
    for (const r of wf.rows) {
      if (r.turnIndex !== prevTurn) {
        prevTurn = r.turnIndex;
        const b = bandByTurn.get(r.turnIndex);
        const meta = b
          ? '+' + fmtMs(Math.round(b.startOffsetMs)) + ' · ' + fmtMs(b.durationMs) +
            (b.userPromptChars ? ' · user ' + fmtBytes(b.userPromptChars) : '') +
            ' · ' + fmtInt(b.toolCount) + ' tools'
          : '';
        body.push('<div class="wf-turn"><span class="idx">turn ' + r.turnIndex + '</span><span class="muted">' + esc(meta) + '</span></div>');
      }
      const failed = r.success === false;
      const color = failed ? 'var(--err)' : colorForTool(r.name);
      // Failed calls use the .err class (no inline bg) so the stylesheet's
      // \`.seg.err\` rule wins; successful calls get the per-tool hash color.
      const bg = failed ? '' : ';background:' + colorForTool(r.name);
      const tip = esc(r.name) + ' — ' + fmtMs(r.durationMs) + ' (starts +' + fmtMs(Math.round(r.startOffsetMs)) + ')' + (failed ? ' — failed' : '');
      body.push(
        '<div class="wf-row">' +
          '<div class="label" title="' + tip + '"><span class="wf-dot" style="background:' + color + '"></span>' + esc(r.name) + '</div>' +
          '<div class="track"><div class="seg ' + (failed ? 'err' : '') + '" title="' + tip + '" style="left:' + r.leftPct.toFixed(3) + '%;width:' + r.widthPct.toFixed(3) + '%' + bg + '"></div></div>' +
          '<div class="dur">' + fmtMs(r.durationMs) + '</div>' +
        '</div>',
      );
    }

    // No tool lanes but real context samples: keep the context strip + ruler
    // (both meaningful on the session axis) and show an honest empty-plot note
    // instead of hiding the whole panel.
    if (!wf.rows.length) {
      body.push('<div class="muted" style="padding:8px 0;font-size:11px;">No tool calls in this session — context high-water marks are shown above.</div>');
    }

    const truncNote = wf.truncated
      ? '<div class="muted" style="font-size:11px;margin-top:6px;">Showing the first ' + fmtInt(wf.rows.length) + ' of ' + fmtInt(wf.totalRows) + ' tool calls (earliest by start time).</div>'
      : '';

    // The context strip + axis ruler share ONE sticky header inside .wf-scroll, so
    // they sit in the exact same horizontal sizing context as the lanes (same
    // scrollbar gutter, same flex columns) — guaranteeing x-alignment.
    return \`
      <div class="panel">
        <h2>Tool waterfall — wall-clock timeline (\${fmtMs(wf.spanMs)} total)</h2>
        <div class="legend">
          <span><span class="swatch" style="background:var(--serial)"></span>tool call (color = tool type)</span>
          <span><span class="swatch" style="background:var(--err)"></span>failed</span>
          <span><span class="swatch ctxk"></span>context peak at compaction</span>
          <span class="muted">one lane per call on a shared time axis; overlapping bars ran in parallel — hover for details</span>
        </div>
        <div class="wf-scroll">
          <div class="wf-head">
            \${contextPressureChart(wf)}
            <div class="wf-axis"><div class="label"></div><div class="ruler">\${ruler}</div><div class="dur"></div></div>
          </div>
          <div class="wf-plot">
            <div class="wf-grid">\${gridlines}</div>
            \${body.join('')}
          </div>
        </div>
        \${truncNote}
      </div>
      \${parallelismChart(s)}
    \`;
  }

  function viewLongPoles(s) {
    if (!s.longestTools.length) return '<div class="empty">No tool calls recorded.</div>';
    const maxDur = s.longestTools[0].durationMs;
    const rows = s.longestTools.map((t) => \`
      <tr>
        <td>\${esc(t.name)} <span class="pill">turn \${t.turnIndex}</span> \${t.success === false ? '<span class="pill" style="color:var(--err);border-color:var(--err)">FAIL</span>' : ''}</td>
        <td class="num" title="\${new Date(t.start).toISOString()}">\${new Date(t.start).toLocaleTimeString()}</td>
        <td class="num">\${fmtMs(t.durationMs)}</td>
        <td><div class="bar" style="width:\${(t.durationMs / maxDur) * 100}%"></div></td>
      </tr>\`).join('');
    const aggRows = s.toolAggregates.slice(0, 30).map((r) => \`
      <tr>
        <td>\${esc(r.name)}</td>
        <td class="num">\${fmtInt(r.count)}</td>
        <td class="num">\${fmtMs(r.totalMs)}</td>
        <td class="num">\${fmtMs(r.avgMs)}</td>
        <td class="num">\${fmtMs(r.p50)}</td>
        <td class="num">\${fmtMs(r.p95)}</td>
        <td class="num">\${fmtMs(r.max)}</td>
        <td class="num">\${r.failures > 0 ? '<span style="color:var(--err)">' + r.failures + '</span>' : '0'}</td>
        <td class="num" title="Bytes this tool pulled into context across the session">\${fmtBytes(r.totalResultBytes)}</td>
      </tr>\`).join('');
    // Ranked by context cost, which is a different order from latency: a fast
    // tool returning a huge payload is a common reason sessions compact.
    const sinkRows = (s.contextSinks || []).map((r) => \`
      <tr>
        <td>\${esc(r.name)}</td>
        <td class="num">\${fmtInt(r.count)}</td>
        <td class="num">\${fmtBytes(r.totalResultBytes)}</td>
        <td class="num">\${fmtBytes(r.avgResultBytes)}</td>
        <td class="num">\${fmtBytes(r.maxResultBytes)}</td>
      </tr>\`).join('');
    return \`
      <div class="summary-block">
        <div class="panel">
          <h2>Top 20 individual tool calls</h2>
          <table><thead><tr><th>Tool</th><th class="num">Started</th><th class="num">Duration</th><th></th></tr></thead><tbody>\${rows}</tbody></table>
        </div>
        <div class="panel">
          <h2>By tool name</h2>
          <table><thead><tr><th>Tool</th><th class="num">Count</th><th class="num">Total</th><th class="num">Avg</th><th class="num">p50</th><th class="num">p95</th><th class="num">Max</th><th class="num">Fail</th><th class="num">Context</th></tr></thead><tbody>\${aggRows}</tbody></table>
        </div>
        <div class="panel">
          <h2>Biggest context sinks</h2>
          \${sinkRows
            ? \`<table><thead><tr><th>Tool</th><th class="num">Count</th><th class="num">Total bytes</th><th class="num">Avg</th><th class="num">Max</th></tr></thead><tbody>\${sinkRows}</tbody></table>\`
            : '<div class="empty">No tool returned a measurable payload.</div>'}
        </div>
      </div>
    \`;
  }

  function viewTokens(s) {
    const t = s.totals.tokens;
    const budget = s.modelContextBudget || 0;
    // System-prompt + tool-definitions overhead. Exact values are only recorded
    // at compaction boundaries (contextEvents[].systemTokens); use the latest
    // observed value when present, else fall back to a rough fixed estimate and
    // label the bar "(est)" so it does not read as measured data.
    const SYSTEM_TOKENS_ESTIMATE = 9600;
    const observedSystem = s.contextEvents.filter((c) => c.systemTokens > 0).map((c) => c.systemTokens).pop();
    const systemTokens = observedSystem || SYSTEM_TOKENS_ESTIMATE;
    const systemLabel = observedSystem ? 'System' : 'System (est)';
    const budgetLine = budget ? \`
      <div class="panel">
        <h2>Context-window budget (\${esc(s.budgetModel || 'unknown')})</h2>
        \${budgetBar(systemLabel, systemTokens, budget, 'var(--api)')}
        \${s.compactions.map((c) => budgetBar('Peak at compaction ' + new Date(c.ts).toLocaleTimeString(), c.preTokens || 0, budget, 'var(--warn)')).join('')}
      </div>\` : '';
    const compactionRows = s.compactions.map((c) => \`
      <tr>
        <td class="num">\${new Date(c.ts).toLocaleTimeString()}</td>
        <td>\${esc(c.by)}</td>
        <td class="num">\${fmtInt(c.preTokens)}</td>
        <td class="num">\${fmtInt(c.preMessages)}</td>
        <td class="num">\${fmtBytes(c.summaryChars)}</td>
      </tr>\`).join('');
    const contextEventRows = s.contextEvents.filter((c) => c.type === 'compaction_start').map((c) => \`
      <tr>
        <td class="num">\${new Date(c.ts).toLocaleTimeString()}</td>
        <td class="num">\${fmtInt(c.systemTokens)}</td>
        <td class="num">\${fmtInt(c.conversationTokens)}</td>
        <td class="num">\${fmtInt(c.toolDefinitionsTokens)}</td>
        <td class="num"><b>\${fmtInt(c.totalTokens)}</b></td>
      </tr>\`).join('');
    return \`
      <div class="kpis">
        \${kpi('Output tokens', fmtInt(t.output), \`\${fmtInt(s.totals.apiCalls)} API calls\`)}
        \${kpi('Input tokens', t.input ? fmtInt(t.input) : '—', 'input token counts are not logged locally by copilot-agent — see server-side telemetry')}
        \${kpi('Cache read', t.cacheRead ? fmtInt(t.cacheRead) : '—', 'not logged locally')}
        \${kpi('Peak context', fmtInt(s.totals.peakContextTokens || 0), budget ? fmtPct((s.totals.peakContextTokens || 0) / budget) + ' of ' + fmtInt(budget) : '—')}
        \${kpi('Compactions', fmtInt(s.totals.compactions), 'context reductions')}
        \${kpi('Reasoning bytes', fmtBytes(s.totals.reasoningChars + s.totals.reasoningOpaqueBytes), 'internal think tokens (byte proxy)')}
      </div>
      \${budgetLine}
      \${outputTokensChart(s.usages, s.compactions)}
      <div class="panel">
        <h2>Compaction breakdown</h2>
        \${contextEventRows ? '<table><thead><tr><th>At</th><th class="num">System</th><th class="num">Conversation</th><th class="num">Tool defs</th><th class="num">Total</th></tr></thead><tbody>' + contextEventRows + '</tbody></table>' : '<div class="muted">No compaction events in this session.</div>'}
      </div>
      \${s.compactions.length ? '<div class="panel"><h2>Compactions</h2><table><thead><tr><th>At</th><th>By</th><th class="num">Pre-tokens</th><th class="num">Pre-messages</th><th class="num">Summary size</th></tr></thead><tbody>' + compactionRows + '</tbody></table></div>' : ''}
    \`;
  }

  function viewSubagents(s) {
    const agents = s.subagents;
    const skills = s.skillInvocations;
    return \`
      <div class="panel">
        <h2>Sub-agent spawns (\${agents.length})</h2>
        \${agents.length ? '<table><thead><tr><th>Agent</th><th class="num">Started</th><th class="num">Duration</th><th>Started by</th></tr></thead><tbody>' +
          agents.map((a) => '<tr><td>' + esc(a.name) + '</td><td class="num">' + new Date(a.start).toLocaleTimeString() + '</td><td class="num">' + (a.durationMs != null ? fmtMs(a.durationMs) : '<span class="muted">—</span>') + '</td><td><code>' + esc(a.startedByCallId || '—') + '</code></td></tr>').join('')
          + '</tbody></table>' : '<div class="muted">No sub-agent spawns in this session. (Task-tool invocations show up here for models that emit agent.* events.)</div>'}
      </div>
      <div class="panel">
        <h2>Skill invocations (\${skills.length})</h2>
        \${skills.length ? '<table><thead><tr><th>Skill</th><th class="num">At</th><th class="num">Content</th><th>Path</th></tr></thead><tbody>' +
          skills.map((sk) => '<tr><td>' + esc(sk.name) + '</td><td class="num">' + new Date(sk.ts).toLocaleTimeString() + '</td><td class="num">' + fmtBytes(sk.contentBytes || 0) + '</td><td class="muted"><code>' + esc(sk.path || '') + '</code></td></tr>').join('')
          + '</tbody></table>' : '<div class="muted">No skill invocations in this session.</div>'}
      </div>
    \`;
  }

  function viewHooks(s) {
    const rows = s.hookAggregates.map((h) => \`
      <tr>
        <td>\${esc(h.type)}</td>
        <td class="num">\${fmtInt(h.count)}</td>
        <td class="num">\${fmtMs(h.totalMs)}</td>
        <td class="num">\${fmtMs(h.totalMs / Math.max(1, h.count))}</td>
        <td class="num">\${h.failures > 0 ? '<span style="color:var(--err)">' + h.failures + '</span>' : '0'}</td>
      </tr>\`).join('');
    return \`
      <div class="panel">
        <h2>Hook / guard time</h2>
        <div class="muted" style="margin-bottom:10px;">Guards live in extensions like <code>copilot-guards</code>. Their overhead shows up here as pre/post-tool hook time — a proxy for how much guard work is on the critical path.</div>
        \${rows ? '<table><thead><tr><th>Hook type</th><th class="num">Count</th><th class="num">Total</th><th class="num">Avg</th><th class="num">Fail</th></tr></thead><tbody>' + rows + '</tbody></table>' : '<div class="muted">No hook events in this session.</div>'}
      </div>
    \`;
  }

  function viewAggregate(a, tab) {
    if (tab === 'overview' || tab === 'aggregate') {
      const t = a.totals;
      const sessionRows = a.sessions.slice(0, 60).map((s) => \`
        <tr>
          <td><code>\${s.sessionId.slice(0, 8)}</code> \${s.branch ? '<span class="pill">' + esc(s.branch) + '</span>' : ''}</td>
          <td>\${esc(s.model)}</td>
          <td class="num">\${new Date(s.startedAt).toISOString().slice(0, 16).replace('T', ' ')}</td>
          <td class="num">\${fmtMs(s.walltimeMs)}</td>
          <td class="num">\${fmtMs(s.toolTimeMs)}</td>
          <td class="num">\${fmtInt(s.toolCalls)}</td>
          <td class="num">\${fmtPct(s.parallelismRatio)}</td>
          <td class="num">\${fmtInt(s.outputTokens)}</td>
          <td class="num">\${s.peakContextTokens ? fmtInt(s.peakContextTokens) : '—'}</td>
          <td class="num">\${fmtInt(s.compactions)}</td>
          <td class="num">\${s.errors ? '<span style="color:var(--err)">' + s.errors + '</span>' : '0'}</td>
          <td><span class="muted" title="\${esc(s.summaryText || '')}">\${esc((s.summaryText || '').slice(0, 40))}</span></td>
        </tr>\`).join('');
      return \`
        <div class="kpis">
          \${kpi('Sessions', fmtInt(t.sessions), 'range: last ' + state.days + 'd')}
          \${kpi('Total wall', fmtMs(t.walltimeMs), 'summed session lifetimes')}
          \${kpi('Total tool time', fmtMs(t.toolTimeMs), fmtInt(t.toolCalls) + ' tool calls')}
          \${kpi('Total hook time', fmtMs(t.hookTimeMs), 'guard overhead')}
          \${kpi('Output tokens', fmtInt(t.outputTokens), fmtInt(t.apiCalls) + ' API calls')}
          \${kpi('Compactions', fmtInt(t.compactions), 'context flushes')}
          \${kpi('Skill invocations', fmtInt(t.skillInvocations), fmtInt(t.subagentSpawns) + ' sub-agents')}
          \${kpi('Errors', fmtInt(t.errors), 'across all sessions')}
        </div>
        \${modelBreakdownPanel(a.modelAggregate.map((m) => ({ ...m, callCount: m.apiCalls })))}
        <div class="panel">
          <h2>Session leaderboard</h2>
          <table><thead><tr><th>Session</th><th>Model</th><th class="num">Start</th><th class="num">Wall</th><th class="num">Tool time</th><th class="num">Calls</th><th class="num">Parallel</th><th class="num">Out tok</th><th class="num">Peak ctx</th><th class="num">Compact</th><th class="num">Err</th><th>Summary</th></tr></thead><tbody>\${sessionRows}</tbody></table>
        </div>
      \`;
    }
    if (tab === 'longpoles') {
      const rows = a.toolAggregate.slice(0, 40).map((r) => \`
        <tr>
          <td>\${esc(r.name)}</td>
          <td class="num">\${fmtInt(r.count)}</td>
          <td class="num">\${fmtMs(r.totalMs)}</td>
          <td class="num">\${fmtMs(r.avgMs)}</td>
          <td class="num">\${fmtMs(r.maxMs)}</td>
          <td class="num">\${r.failures}</td>
        </tr>\`).join('');
      return \`
        <div class="panel">
          <h2>Long poles across sessions</h2>
          <table><thead><tr><th>Tool</th><th class="num">Calls</th><th class="num">Total</th><th class="num">Avg</th><th class="num">Max</th><th class="num">Fail</th></tr></thead><tbody>\${rows}</tbody></table>
        </div>
      \`;
    }
    if (tab === 'tokens') {
      return \`
        <div class="panel">
          <h2>Model / token breakdown (aggregate)</h2>
          \${modelBreakdownPanel(a.modelAggregate.map((m) => ({ ...m, callCount: m.apiCalls })))}
        </div>
      \`;
    }
    return '<div class="empty">Select a specific session to see this view.</div>';
  }

  // ---------- Helpers ----------
  function kpi(k, v, sub) { return '<div class="kpi"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div>' + (sub ? '<div class="sub">' + esc(sub) + '</div>' : '') + '</div>'; }
  function budgetBar(label, tokens, budget, color) {
    const pct = Math.min(100, (tokens / budget) * 100);
    return '<div style="display:flex;gap:8px;align-items:center;margin:6px 0;font-size:12px;"><div style="min-width:220px;color:var(--muted)">' + esc(label) + '</div><div style="flex:1;height:14px;background:var(--bg);border:1px solid var(--border);border-radius:3px;position:relative;"><div style="position:absolute;top:0;left:0;bottom:0;background:' + color + ';width:' + pct + '%;border-radius:3px;"></div></div><div style="min-width:150px;text-align:right;font-variant-numeric:tabular-nums;">' + fmtInt(tokens) + ' / ' + fmtInt(budget) + ' (' + pct.toFixed(1) + '%)</div></div>';
  }

  function modelBreakdownPanel(models) {
    if (!models || !models.length) return '';
    const totalOut = models.reduce((s, m) => s + m.outputTokens, 0) || 1;
    const rows = models.map((m) => \`
      <tr>
        <td><span class="pill model">\${esc(m.model)}</span></td>
        <td class="num">\${fmtInt(m.callCount)}</td>
        <td class="num">\${fmtInt(m.outputTokens)}</td>
        <td class="num">\${fmtInt(m.inputTokens)}</td>
        <td class="num">\${fmtInt(m.cacheReadTokens)}</td>
        <td class="num">\${m.cost ? '$' + m.cost.toFixed(4) : '—'}</td>
        <td><div class="bar" style="width:\${(m.outputTokens / totalOut) * 100}%"></div></td>
      </tr>\`).join('');
    return '<div class="panel"><h2>By model</h2><table><thead><tr><th>Model</th><th class="num">API calls</th><th class="num">Output tok</th><th class="num">Input tok</th><th class="num">Cache read</th><th class="num">Cost</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function parallelismChart(s) {
    // Sweep-line over tools to draw concurrency-over-time.
    const tools = s.tools;
    if (!tools.length) return '';
    const w = 720, h = 120, pad = { l: 40, r: 8, t: 12, b: 24 };
    const t0 = s.startedAt, t1 = s.endedAt;
    const evs = [];
    for (const t of tools) { evs.push([t.start, 1]); evs.push([t.end, -1]); }
    // On tied timestamps process ends (-1) before starts (+1) so tools that
    // merely touch at a boundary ([0,10] then [10,20]) are not counted as
    // concurrent. Matches computeParallelStats() in analyzer.mjs so this chart's
    // peak agrees with the Overview maxParallelism KPI.
    evs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let active = 0, peak = 0;
    const points = [[0, 0]];
    for (const [ts, delta] of evs) {
      const x = ((ts - t0) / Math.max(1, t1 - t0));
      points.push([x, active]);
      active += delta;
      points.push([x, active]);
      if (active > peak) peak = active;
    }
    points.push([1, 0]);
    const cw = w - pad.l - pad.r, ch = h - pad.t - pad.b;
    const scale = peak > 0 ? ch / peak : 1;
    const path = points.map(([x, y], i) => (i ? 'L' : 'M') + (pad.l + x * cw).toFixed(1) + ' ' + (pad.t + ch - y * scale).toFixed(1)).join(' ');
    return \`
      <div class="panel">
        <h2>Tool concurrency over time (peak \${peak})</h2>
        <svg width="\${w}" height="\${h}">
          <g class="grid">
            \${Array.from({ length: peak + 1 }, (_, i) => '<line x1="' + pad.l + '" x2="' + (w - pad.r) + '" y1="' + (pad.t + ch - i * scale) + '" y2="' + (pad.t + ch - i * scale) + '"/>').join('')}
          </g>
          <path d="\${path}" fill="rgba(163,113,247,0.2)" stroke="var(--parallel)" stroke-width="1.5" />
          <g class="axis">
            \${Array.from({ length: peak + 1 }, (_, i) => '<text x="' + (pad.l - 4) + '" y="' + (pad.t + ch - i * scale + 3) + '" text-anchor="end">' + i + '</text>').join('')}
            <text x="\${pad.l}" y="\${h - 6}">\${new Date(t0).toLocaleTimeString()}</text>
            <text x="\${w - pad.r}" y="\${h - 6}" text-anchor="end">\${new Date(t1).toLocaleTimeString()}</text>
          </g>
        </svg>
      </div>
    \`;
  }

  function turnTimingChart(turns) {
    if (!turns.length) return '';
    const w = 720, h = 140, pad = { l: 40, r: 8, t: 12, b: 24 };
    const cw = w - pad.l - pad.r, ch = h - pad.t - pad.b;
    const maxD = Math.max(...turns.map((t) => t.durationMs || 0), 1);
    const bw = Math.max(2, cw / turns.length - 1);
    const bars = turns.map((t, i) => {
      const x = pad.l + (i / turns.length) * cw;
      const totalH = ((t.durationMs || 0) / maxD) * ch;
      const toolH = ((t.toolMs || 0) / maxD) * ch;
      const hookH = ((t.hookMs || 0) / maxD) * ch;
      const otherH = Math.max(0, totalH - toolH - hookH);
      const y0 = pad.t + ch;
      return \`
        <rect x="\${x}" y="\${y0 - toolH}" width="\${bw}" height="\${toolH}" fill="var(--serial)"><title>turn \${t.turnIndex} tool: \${fmtMs(t.toolMs)}</title></rect>
        <rect x="\${x}" y="\${y0 - toolH - hookH}" width="\${bw}" height="\${hookH}" fill="var(--hook)"><title>turn \${t.turnIndex} hook: \${fmtMs(t.hookMs)}</title></rect>
        <rect x="\${x}" y="\${y0 - toolH - hookH - otherH}" width="\${bw}" height="\${otherH}" fill="var(--api)" opacity="0.6"><title>turn \${t.turnIndex} model/other: \${fmtMs(otherH * maxD / ch)}</title></rect>
      \`;
    }).join('');
    return \`
      <div class="panel">
        <h2>Per-turn timing breakdown</h2>
        <div class="legend">
          <span><span class="swatch" style="background:var(--serial)"></span>tool time</span>
          <span><span class="swatch" style="background:var(--hook)"></span>hook time</span>
          <span><span class="swatch" style="background:var(--api)"></span>model/idle</span>
        </div>
        <svg width="\${w}" height="\${h}">
          <g class="grid">
            <line x1="\${pad.l}" x2="\${w - pad.r}" y1="\${pad.t + ch}" y2="\${pad.t + ch}"/>
            <line x1="\${pad.l}" x2="\${w - pad.r}" y1="\${pad.t + ch / 2}" y2="\${pad.t + ch / 2}"/>
          </g>
          \${bars}
          <g class="axis">
            <text x="\${pad.l - 6}" y="\${pad.t + ch}" text-anchor="end">0</text>
            <text x="\${pad.l - 6}" y="\${pad.t + 8}" text-anchor="end">\${fmtMs(maxD)}</text>
            <text x="\${pad.l}" y="\${h - 6}">turn 0</text>
            <text x="\${w - pad.r}" y="\${h - 6}" text-anchor="end">turn \${turns[turns.length - 1].turnIndex}</text>
          </g>
        </svg>
      </div>
    \`;
  }

  function outputTokensChart(usages, compactions) {
    if (!usages.length) return '';
    const w = 720, h = 140, pad = { l: 50, r: 8, t: 12, b: 24 };
    const cw = w - pad.l - pad.r, ch = h - pad.t - pad.b;
    let cum = 0;
    const pts = usages.map((u) => { cum += u.outputTokens; return { ts: u.ts, cum }; });
    const t0 = usages[0].ts, t1 = usages[usages.length - 1].ts;
    const maxY = cum || 1;
    const path = pts.map((p, i) => (i ? 'L' : 'M') + (pad.l + ((p.ts - t0) / Math.max(1, t1 - t0)) * cw).toFixed(1) + ' ' + (pad.t + ch - (p.cum / maxY) * ch).toFixed(1)).join(' ');
    const compLines = compactions.map((c) => {
      const x = pad.l + ((c.ts - t0) / Math.max(1, t1 - t0)) * cw;
      return '<line x1="' + x + '" x2="' + x + '" y1="' + pad.t + '" y2="' + (pad.t + ch) + '" stroke="var(--warn)" stroke-dasharray="3 3"/>';
    }).join('');
    return \`
      <div class="panel">
        <h2>Cumulative output tokens</h2>
        <svg width="\${w}" height="\${h}">
          <g class="grid">
            <line x1="\${pad.l}" x2="\${w - pad.r}" y1="\${pad.t + ch}" y2="\${pad.t + ch}"/>
          </g>
          <path d="\${path}" fill="none" stroke="var(--api)" stroke-width="1.5"/>
          \${compLines}
          <g class="axis">
            <text x="\${pad.l - 6}" y="\${pad.t + 8}" text-anchor="end">\${fmtInt(cum)}</text>
            <text x="\${pad.l - 6}" y="\${pad.t + ch}" text-anchor="end">0</text>
            <text x="\${pad.l}" y="\${h - 6}">\${new Date(t0).toLocaleTimeString()}</text>
            <text x="\${w - pad.r}" y="\${h - 6}" text-anchor="end">\${new Date(t1).toLocaleTimeString()}</text>
          </g>
        </svg>
        <div class="muted" style="font-size:11px;">Vertical dashed lines mark compaction events.</div>
      </div>
    \`;
  }

  // Deterministic color-per-tool-name hash so the waterfall stays legible.
  function colorForTool(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffff;
    const hue = h % 360;
    return 'hsl(' + hue + ' 60% 55%)';
  }

  // ---------- Boot ----------
  // Seed repo/session from the URL fragment the canvas open() handler sets
  // (#repo=…&session=…) so open({ repository, sessionId }) pre-selects them.
  function parseHash() {
    const raw = (location.hash || '').replace(/^#/, '');
    if (!raw) return;
    const params = new URLSearchParams(raw);
    const repo = params.get('repo');
    const session = params.get('session');
    if (repo) state.repo = repo;
    if (session) state.sessionId = session;
  }

  document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('repoSel').addEventListener('change', async () => { state.repo = $('repoSel').value; state.sessionId = ''; state.currentAggregate = null; state.currentSummary = null; await loadSessions(); await render(); });
  $('rangeSel').addEventListener('change', async () => { state.currentAggregate = null; await loadSessions(); await render(); });
  $('sessSel').addEventListener('change', async () => { state.sessionId = $('sessSel').value; state.currentSummary = null; state.currentAggregate = null; await render(); });
  $('refreshBtn').addEventListener('click', async () => { state.currentAggregate = null; state.currentSummary = null; await loadSessions(); await render(); });

  parseHash();
  await loadRepos();
  await loadSessions();
  await render();
})();
`;
