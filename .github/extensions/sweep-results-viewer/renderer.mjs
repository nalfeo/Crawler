export function renderHtml(instanceId) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sweep Results — ${escapeHtml(instanceId)}</title>
  <style>
    :root {
      --panel: color-mix(in srgb, var(--background-color-default, #0d1117) 88%, var(--text-color-default, #c9d1d9));
      --subtle: color-mix(in srgb, var(--background-color-default, #0d1117) 94%, var(--text-color-default, #c9d1d9));
      --win: var(--true-color-green, #3fb950);
      --loss: var(--true-color-red, #f85149);
      --timeout: var(--true-color-yellow, #d29922);
      --stalled: var(--true-color-purple, #a371f7);
      --errored: var(--true-color-pink, #f778ba);
      --accent: var(--true-color-blue, #58a6ff);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 16px;
      background: var(--background-color-default, #0d1117);
      color: var(--text-color-default, #c9d1d9);
      font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      font-size: var(--text-body-medium, 14px);
      line-height: var(--leading-body-medium, 20px);
    }
    header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 12px;
    }
    h1 {
      margin: 0;
      font-size: var(--text-title-medium, 20px);
      line-height: var(--leading-title-medium, 26px);
      font-weight: var(--font-weight-semibold, 600);
    }
    h2 {
      margin: 0 0 8px;
      color: var(--text-color-muted, #8b949e);
      font-size: var(--text-body-small, 12px);
      font-weight: var(--font-weight-semibold, 600);
      letter-spacing: .05em;
      text-transform: uppercase;
    }
    .meta {
      margin-top: 2px;
      color: var(--text-color-muted, #8b949e);
      font-size: var(--text-body-small, 12px);
    }
    .controls {
      display: grid;
      grid-template-columns: minmax(120px, .35fr) minmax(180px, .7fr) minmax(220px, 1fr) auto;
      gap: 8px;
      margin-bottom: 12px;
      padding: 10px;
      border: 1px solid var(--border-color-default, #30363d);
      border-radius: 6px;
      background: var(--subtle);
    }
    select, button {
      min-height: 32px;
      border: 1px solid var(--border-color-default, #30363d);
      border-radius: 5px;
      background: var(--panel);
      color: var(--text-color-default, #c9d1d9);
      font: inherit;
    }
    select { width: 100%; padding: 4px 8px; }
    button {
      padding: 4px 12px;
      cursor: pointer;
      font-weight: var(--font-weight-semibold, 600);
    }
    button:hover, select:focus { border-color: var(--accent); }
    button:focus-visible, select:focus-visible {
      outline: 2px solid var(--color-focus-outline, #58a6ff);
      outline-offset: 1px;
    }
    button:disabled, select:disabled { cursor: wait; opacity: .6; }
    .status-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      margin-bottom: 12px;
      color: var(--text-color-muted, #8b949e);
      font-size: var(--text-body-small, 12px);
    }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      padding: 1px 7px;
      border: 1px solid var(--border-color-default, #30363d);
      border-radius: 999px;
      background: var(--panel);
      color: var(--text-color-default, #c9d1d9);
    }
    .pill.active { border-color: var(--accent); color: var(--accent); }
    .pill.success { border-color: var(--win); color: var(--win); }
    .pill.failure, .pill.cancelled { border-color: var(--loss); color: var(--loss); }
    .message {
      margin: 0 0 12px;
      padding: 8px 10px;
      border: 1px solid var(--border-color-default, #30363d);
      border-radius: 5px;
      background: var(--subtle);
      white-space: pre-wrap;
    }
    .message.error { border-color: var(--loss); color: var(--loss); }
    .message.warning { border-color: var(--timeout); color: var(--timeout); }
    section { margin-bottom: 20px; }
    .table-wrap, .grid-wrap {
      overflow-x: auto;
      border: 1px solid var(--border-color-default, #30363d);
      border-radius: 6px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--panel);
    }
    th, td {
      padding: 7px 10px;
      border-bottom: 1px solid var(--border-color-default, #30363d);
      text-align: right;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    th:first-child, td:first-child { text-align: left; }
    th {
      background: var(--subtle);
      color: var(--text-color-muted, #8b949e);
      font-size: var(--text-body-small, 12px);
      font-weight: var(--font-weight-semibold, 600);
    }
    tr:last-child td { border-bottom: none; }
    .weapon-name, .combo-name { font-weight: var(--font-weight-semibold, 600); }
    .winrate {
      display: inline-block;
      min-width: 50px;
      padding: 1px 6px;
      border-radius: 4px;
      font-weight: var(--font-weight-semibold, 600);
    }
    .winrate.high { background: color-mix(in srgb, var(--win) 20%, transparent); color: var(--win); }
    .winrate.mid { background: color-mix(in srgb, var(--timeout) 20%, transparent); color: var(--timeout); }
    .winrate.low { background: color-mix(in srgb, var(--loss) 20%, transparent); color: var(--loss); }
    .incumbent-row { background: color-mix(in srgb, var(--accent) 8%, transparent); }
    .flip-positive { color: var(--win); font-weight: var(--font-weight-semibold, 600); }
    .flip-negative { color: var(--loss); font-weight: var(--font-weight-semibold, 600); }
    .phase-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 8px;
      margin-bottom: 16px;
    }
    .phase-card {
      padding: 10px 12px;
      border: 1px solid var(--border-color-default, #30363d);
      border-radius: 6px;
      background: var(--panel);
    }
    .phase-card .phase-name {
      font-size: var(--text-body-small, 12px);
      font-weight: var(--font-weight-semibold, 600);
      color: var(--text-color-muted, #8b949e);
      letter-spacing: .04em;
      text-transform: uppercase;
      margin-bottom: 4px;
    }
    .phase-card .phase-count {
      font-size: var(--text-title-medium, 20px);
      font-weight: var(--font-weight-semibold, 600);
    }
    .phase-card.running { border-color: var(--accent); }
    .phase-card.running .phase-name { color: var(--accent); }
    .phase-card.done { border-color: var(--win); }
    .phase-card.done .phase-name { color: var(--win); }
    .phase-card.failed { border-color: var(--loss); }
    .phase-card.failed .phase-name { color: var(--loss); }
    .grid {
      display: grid;
      gap: 2px;
      min-width: max-content;
      padding: 8px;
      background: var(--panel);
      font-family: var(--font-mono, "SFMono-Regular", Consolas, monospace);
      font-size: var(--text-code-inline, 12px);
    }
    .grid .head { padding: 2px 0; color: var(--text-color-muted, #8b949e); text-align: center; }
    .grid .row-label {
      position: sticky;
      left: 0;
      z-index: 1;
      padding: 2px 6px;
      background: var(--panel);
      color: var(--text-color-muted, #8b949e);
      text-align: right;
      white-space: nowrap;
    }
    .cell {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 24px;
      border-radius: 3px;
      color: var(--color-white, #fff);
      cursor: help;
      font-weight: var(--font-weight-semibold, 600);
    }
    .cell.victory { background: var(--win); }
    .cell.death { background: var(--loss); }
    .cell.timeout { background: var(--timeout); }
    .cell.stalled { background: var(--stalled); }
    .cell.errored { background: var(--errored); }
    .cell.empty {
      border: 1px solid var(--border-color-default, #30363d);
      background: var(--subtle);
      color: var(--text-color-muted, #8b949e);
    }
    .legend { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 7px; color: var(--text-color-muted, #8b949e); font-size: 12px; }
    .swatch { display: inline-block; width: 10px; height: 10px; margin-right: 4px; border-radius: 2px; vertical-align: middle; }
    .empty-state {
      padding: 28px;
      border: 1px dashed var(--border-color-default, #30363d);
      border-radius: 6px;
      color: var(--text-color-muted, #8b949e);
      text-align: center;
    }
    a { color: var(--accent); }
    code { font-family: var(--font-mono, "SFMono-Regular", Consolas, monospace); }
    @media (max-width: 620px) {
      header { display: block; }
      .controls { grid-template-columns: 1fr; }
      header button { margin-top: 8px; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1 id="page-title">Sweep Results</h1>
      <div id="meta" class="meta">Loading attached project context…</div>
    </div>
  </header>
  <div class="controls">
    <select id="source-select" aria-label="Sweep result source">
      <option value="cloud">Cloud runs</option>
      <option value="local">Local session</option>
      <option value="repository">Repository branch</option>
    </select>
    <select id="branch-select" aria-label="Repository baseline branch" hidden></select>
    <select id="run-select" aria-label="Cloud sweep run">
      <option>Loading cloud runs…</option>
    </select>
    <button id="reload" type="button">Refresh</button>
  </div>
  <div id="status" class="status-row"></div>
  <div id="connection-error" class="message error" hidden></div>
  <div id="error" class="message error" hidden></div>
  <div id="local-errors" class="message error" hidden></div>
  <div id="warning" class="message warning" hidden></div>
  <main id="content"></main>

  <script>
  const token = new URLSearchParams(location.search).get('token');
  const apiUrl = (path) => path + '?token=' + encodeURIComponent(token || '');
  const fmtPct = (value) => value != null && Number.isFinite(Number(value)) ? (Number(value) * 100).toFixed(1) + '%' : '—';
  const fmtNum = (value, digits = 1) => Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '—';
  const fmtMs = (ms) => Number.isFinite(Number(ms)) ? fmtNum(Number(ms) / 1000, 1) + 's' : '—';
  const esc = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  let currentState = null;

  function outcomeAbbrev(outcome) {
    return ({ victory: 'W', death: 'D', timeout: 'T', stalled: 'S', error: 'E', quit: 'Q' })[outcome] || 'N/A';
  }

  function outcomeClass(outcome) {
    return ({ victory: 'victory', death: 'death', timeout: 'timeout', stalled: 'stalled', error: 'errored', quit: 'stalled' })[outcome] || 'empty';
  }

  function winRateClass(rate) {
    if (rate == null || !Number.isFinite(Number(rate))) return 'empty';
    return rate >= .9 ? 'high' : rate >= .5 ? 'mid' : 'low';
  }

  function runLabel(run) {
    const created = run.createdAt ? new Date(run.createdAt).toLocaleString() : 'unknown time';
    const result = run.status === 'completed' ? (run.conclusion || 'completed') : run.status;
    const typeTag = run.workflowType === 'ai-sweep' ? '[AI] ' : run.workflowType === 'baseline-sweep' ? '[B] ' : '[W] ';
    return typeTag + '#' + run.id + ' · ' + created + ' · ' + (run.headBranch || 'detached') + ' · ' + result;
  }

  function localRunLabel(run) {
    const created = run.runAt ? new Date(run.runAt).toLocaleString() : 'unknown time';
    const floors = Array.isArray(run.floors) ? run.floors.join(', ') : 'Unknown';
    return created + ' · Floors ' + floors + ' · ' + run.name;
  }

  function repositoryArtifactLabel(artifact) {
    const created = artifact.generatedAt
      ? new Date(artifact.generatedAt).toLocaleString()
      : 'unknown time';
    const rate = Number.isFinite(Number(artifact.winRate))
      ? (Number(artifact.winRate) * 100).toFixed(1) + '%'
      : 'unknown win rate';
    return created + ' · ' + rate + ' · ' + (artifact.name || artifact.path);
  }

  function renderBranchSelector(state) {
    const select = document.getElementById('branch-select');
    const repository = state.source === 'repository';
    select.hidden = !repository;
    if (!repository) return;
    const branches = state.repositoryBranches || [];
    if (!branches.length) {
      select.innerHTML = '<option value="">No benchmark branches found</option>';
      select.disabled = true;
      return;
    }
    select.innerHTML = branches.map((branch) =>
      '<option value="' + esc(branch.name) + '"'
        + (branch.name === state.selectedRepositoryBranch?.name ? ' selected' : '')
        + '>' + esc(branch.name) + (branch.local ? ' · local' : ' · origin') + '</option>'
    ).join('');
    select.disabled = state.refreshing;
  }

  function renderRunSelector(state) {
    const select = document.getElementById('run-select');
    const cloud = state.source === 'cloud';
    const repository = state.source === 'repository';
    const runs = cloud
      ? (state.runs || [])
      : repository
        ? (state.repositoryArtifacts || [])
        : (state.localRuns || []);
    select.setAttribute(
      'aria-label',
      cloud ? 'Cloud sweep run' : repository ? 'Repository result artifact' : 'Local sweep result',
    );
    if (!runs.length) {
      if (!cloud && !repository && state.path) {
        select.innerHTML = '<option value="' + esc(state.path) + '" selected>Explicit path · ' + esc(state.path) + '</option>';
        select.disabled = state.refreshing;
        return;
      }
      // Cloud: explicit baseline-sweep run selected but absent from state.runs.
      if (cloud && state.selectedRun) {
        select.innerHTML = '<option value="' + state.selectedRun.id + '" selected>' + esc(runLabel(state.selectedRun)) + '</option>';
        select.disabled = state.refreshing;
        return;
      }
      const sourceLabel = cloud
        ? 'cloud sweep runs'
        : repository
          ? 'repository result artifacts'
          : 'local session results';
      select.innerHTML = '<option value="">No ' + sourceLabel + ' found</option>';
      select.disabled = true;
      return;
    }
    if (cloud) {
      select.setAttribute('aria-label', 'Cloud sweep run');
      const selectedId = state.selectedRun?.id;
      const explicitRun = selectedId !== undefined && !runs.some((run) => run.id === selectedId) ? state.selectedRun : null;
      const explicitOption = explicitRun
        ? '<option value="' + explicitRun.id + '" selected>' + esc(runLabel(explicitRun)) + '</option>'
        : '';
      select.innerHTML = explicitOption + runs.map((run) =>
        '<option value="' + run.id + '"' + (run.id === selectedId ? ' selected' : '') + '>' + esc(runLabel(run)) + '</option>'
      ).join('');
    } else if (repository) {
      select.innerHTML = runs.map((artifact) =>
        '<option value="' + esc(artifact.path) + '"'
          + (artifact.path === state.selectedRepositoryPath ? ' selected' : '')
          + '>' + esc(repositoryArtifactLabel(artifact)) + '</option>'
      ).join('');
    } else {
      select.setAttribute('aria-label', 'Local sweep result');
      const explicitOption = state.path && !runs.some((run) => run.path === state.path)
        ? '<option value="' + esc(state.path) + '" selected>Explicit path · ' + esc(state.path) + '</option>'
        : '';
      select.innerHTML = explicitOption + runs.map((run) =>
        '<option value="' + esc(run.path) + '"' + (run.path === state.selectedLocalPath ? ' selected' : '') + '>' + esc(localRunLabel(run)) + '</option>'
      ).join('');
    }
    select.disabled = state.refreshing;
  }

  function renderMessages(state) {
    for (const [id, message] of [['error', state.error], ['warning', state.warning]]) {
      const element = document.getElementById(id);
      element.hidden = !message;
      element.textContent = message || '';
    }
    const localErrors = document.getElementById('local-errors');
    const invalidResults = state.source === 'local'
      ? (state.localErrors || [])
      : state.source === 'repository'
        ? (state.repositoryErrors || [])
        : [];
    localErrors.hidden = invalidResults.length === 0;
    localErrors.textContent = invalidResults.length
      ? (state.source === 'repository' ? 'Invalid repository result files:\\n' : 'Invalid local result files:\\n')
        + invalidResults.map((entry) => entry.name + ': ' + entry.message).join('\\n')
      : '';
  }

  function renderStatus(state) {
    const status = document.getElementById('status');
    const run = state.selectedRun;
    const workflowType = state.workflowType || run?.workflowType;
    const pieces = [];
    const sourceLabel = state.source === 'cloud'
      ? 'GitHub Actions'
      : state.source === 'repository'
        ? 'Repository branch'
        : 'Local session';
    pieces.push('<span class="pill">' + esc(sourceLabel) + '</span>');
    if (run) {
      if (workflowType === 'ai-sweep') {
        pieces.push('<span class="pill">AI Sweep Eval</span>');
      } else if (workflowType === 'baseline-sweep') {
        pieces.push('<span class="pill">Release Baseline</span>');
      } else {
        pieces.push('<span class="pill">Weapon Sweep</span>');
      }
      const statusClass = run.status === 'completed' ? esc(run.conclusion || 'completed') : 'active';
      pieces.push('<span class="pill ' + statusClass + '">' + esc(run.status === 'completed' ? (run.conclusion || 'completed') : run.status) + '</span>');
      if (workflowType !== 'ai-sweep' && workflowType !== 'baseline-sweep') {
        if (state.expectedWeapons?.length) {
          pieces.push('<span class="pill">' + state.availableWeapons.length + '/' + state.expectedWeapons.length + ' weapons</span>');
        } else {
          pieces.push('<span class="pill">' + (state.availableWeapons || []).length + ' weapon result' + ((state.availableWeapons || []).length === 1 ? '' : 's') + '</span>');
        }
      }
      if (state.polling) pieces.push('<span class="pill active">auto-refresh 30s</span>');
      if (run.url) pieces.push('<a href="' + esc(run.url) + '" target="_blank" rel="noreferrer">Open workflow run</a>');
    }
    if (state.source === 'local') {
      const localCount = state.localRuns?.length || 0;
      pieces.push('<span class="pill">' + localCount + ' discovered local run' + (localCount === 1 ? '' : 's') + '</span>');
    }
    if (state.source === 'repository') {
      if (state.selectedRepositoryBranch) {
        pieces.push('<span class="pill">' + esc(state.selectedRepositoryBranch.name) + '</span>');
      }
      pieces.push(
        '<span class="pill">' + (state.repositoryArtifacts?.length || 0)
          + ' committed result artifact'
          + ((state.repositoryArtifacts?.length || 0) === 1 ? '' : 's') + '</span>',
      );
    }
    if (state.data && workflowType !== 'ai-sweep' && workflowType !== 'baseline-sweep') {
      const floors = Array.isArray(state.data.floors) ? state.data.floors.join(', ') : 'Unknown';
      pieces.push('<span class="pill">Floors: ' + esc(floors) + '</span>');
    }
    if (state.refreshing) pieces.push('<span class="pill active">refreshing…</span>');
    if (state.lastRefreshedAt) pieces.push('<span>Updated ' + esc(new Date(state.lastRefreshedAt).toLocaleTimeString()) + '</span>');
    status.innerHTML = pieces.join('');
  }

  function renderPhaseCard(name, phase) {
    if (!phase || phase.total === 0) return '';
    let cardClass = '';
    let countText = '';
    if (phase.running > 0) {
      cardClass = 'running';
      countText = phase.done + '+' + phase.running + ' / ' + phase.total;
    } else if (phase.failed > 0) {
      cardClass = 'failed';
      countText = phase.done + ' done, ' + phase.failed + ' failed';
    } else if (phase.done === phase.total) {
      cardClass = 'done';
      countText = phase.total + ' / ' + phase.total;
    } else {
      countText = phase.done + ' / ' + phase.total;
    }
    return '<div class="phase-card ' + cardClass + '"><div class="phase-name">' + esc(name) + '</div>'
      + '<div class="phase-count">' + esc(countText) + '</div></div>';
  }

  function renderAiJobPhases(state) {
    const phases = state.jobPhases;
    if (!phases) return '<div class="empty-state">' + (state.refreshing ? 'Loading AI Sweep Eval status…' : 'No job phase data available yet.') + '</div>';
    let html = '<section><h2>Live phase progress</h2><div class="phase-grid">';
    html += renderPhaseCard('Preflight', phases.preflight);
    html += renderPhaseCard('Search', phases.search);
    html += renderPhaseCard('Validate', phases.validate);
    html += renderPhaseCard('Aggregate', phases.aggregate);
    html += '</div></section>';
    return html;
  }

  function renderLeaderboardTable(rows, headingText) {
    if (!rows || !rows.length) return '<div class="empty-state">Leaderboard is empty.</div>';
    let html = '<section><h2>' + esc(headingText) + '</h2>';
    html += '<div class="table-wrap"><table><thead><tr>'
      + '<th>Rank</th><th>Combo</th><th>Runs</th><th>Wins</th><th>Win rate</th>'
      + '<th>Σ score</th><th>Mean score</th><th>Mean clear</th><th>Mean XP</th>'
      + '<th>Flips vs incumbent</th><th>Win Δ vs incumbent</th>'
      + '</tr></thead><tbody>';
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowClass = row.isIncumbent ? ' class="incumbent-row"' : '';
      html += '<tr' + rowClass + '>';
      html += '<td>' + (i + 1) + (row.isIncumbent ? ' ★' : '') + '</td>';
      html += '<td class="combo-name">' + esc(row.combo) + '</td>';
      html += '<td>' + esc(row.runs) + '</td><td>' + esc(row.wins) + '</td>';
      html += '<td><span class="winrate ' + winRateClass(row.winRate) + '">' + fmtPct(row.winRate) + '</span></td>';
      html += '<td>' + fmtNum(row.totalScore, 0) + '</td>';
      html += '<td>' + fmtNum(row.meanScore, 0) + '</td>';
      html += '<td>' + fmtMs(row.meanClearTimeMsWins) + '</td>';
      html += '<td>' + fmtNum(row.meanXp, 0) + '</td>';
      const flips = row.flipsVsIncumbent;
      const flipCell = flips == null ? '—' : (flips > 0 ? '<span class="flip-negative">' + flips + '</span>' : '0');
      html += '<td>' + flipCell + '</td>';
      const delta = row.winRateDeltaVsIncumbent;
      const deltaCell = delta == null ? '—' : (delta > 0 ? '<span class="flip-positive">+' + fmtPct(delta) + '</span>' : (delta < 0 ? '<span class="flip-negative">' + fmtPct(delta) + '</span>' : '0%'));
      html += '<td>' + deltaCell + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table></div></section>';
    return html;
  }

  function renderAiSweepLeaderboard(state) {
    const data = state.data;
    if (!data) return '';
    let html = '';
    if (data.winnersDiverge) {
      html += '<div class="message warning">⚠️ Composite-score winner differs from win-count winner — both orderings are shown below.</div>';
      html += renderLeaderboardTable(data.byComposite, 'Leaderboard — composite score ordering');
      html += renderLeaderboardTable(data.byLexicographic, 'Leaderboard — win-count ordering');
    } else {
      html += renderLeaderboardTable(data.byComposite, 'Leaderboard — composite score (by-combo, tuned finalist)');
    }
    return html;
  }

  function renderAiSweepResults(state) {
    const content = document.getElementById('content');
    let html = '';
    // Always show job phases if available.
    if (state.jobPhases) {
      html += renderAiJobPhases(state);
    }
    if (state.data) {
      html += renderAiSweepLeaderboard(state);
    } else if (!state.jobPhases) {
      html += '<div class="empty-state">'
        + (state.refreshing ? 'Loading AI Sweep Eval results…' : 'No leaderboard results available yet. The run is still in progress.')
        + '</div>';
    }
    content.innerHTML = html;
  }

  function renderWeaponSweepResults(state) {
    const content = document.getElementById('content');
    if (!state.data) {
      const detail = state.source === 'local'
        ? 'No local experiment data loaded from <code>' + esc(state.localDirectory || 'artifacts/experiments') + '</code>.'
        : (state.refreshing ? 'Loading cloud sweep results…' : 'No aggregate cloud results are available for this run.');
      content.innerHTML = '<div class="empty-state">' + detail + '</div>';
      return;
    }

    const data = state.data;
    const summaries = data.summaries || [];
    let html = '<section><h2>Per-weapon summary (' + (data.seeds?.length || 0) + ' seeds × ' + (data.weapons?.length || 0) + ' available weapons)</h2>';
    html += '<div class="table-wrap"><table><thead><tr><th>Weapon</th><th>Runs</th><th>Wins</th><th>Win rate</th><th>Mean score</th><th>Mean time</th><th>Mean level</th><th>Mean kills</th><th>Mean min HP</th></tr></thead><tbody>';
    for (const summary of summaries) {
      html += '<tr><td class="weapon-name">' + esc(summary.weapon) + '</td>';
      html += '<td>' + esc(summary.runs) + '</td><td>' + esc(summary.victories) + '</td>';
      html += '<td><span class="winrate ' + winRateClass(summary.winRate) + '">' + fmtPct(summary.winRate) + '</span></td>';
      html += '<td>' + fmtNum(summary.meanScore, 0) + '</td><td>' + fmtNum(summary.meanGameTimeSec, 1) + 's</td>';
      html += '<td>' + fmtNum(summary.meanLevel, 1) + '</td><td>' + fmtNum(summary.meanKills, 1) + '</td><td>' + fmtPct(summary.meanMinHealthPct) + '</td></tr>';
    }
    html += '</tbody></table></div></section>';

    const seeds = data.seeds || [];
    const weapons = data.weapons || [];
    if (seeds.length && weapons.length) {
      const records = {};
      for (const record of data.allRecords || []) {
        (records[record.weapon] ||= {})[record.seed] = record;
      }
      html += '<section><h2>Per-seed outcomes</h2><div class="grid-wrap"><div class="grid" style="grid-template-columns:auto repeat(' + seeds.length + ', minmax(28px, 1fr))">';
      html += '<div class="head"></div>';
      for (const seed of seeds) html += '<div class="head">' + esc(seed) + '</div>';
      for (const weapon of weapons) {
        html += '<div class="row-label">' + esc(weapon) + '</div>';
        for (const seed of seeds) {
          const record = records[weapon]?.[seed];
          if (!record) {
            html += '<div class="cell empty" title="' + esc(weapon) + ' seed ' + esc(seed) + ': no data">—</div>';
            continue;
          }
          const title = esc(weapon) + ' seed=' + esc(seed) + ' · ' + esc(record.outcome ?? 'N/A')
            + ' · t=' + fmtNum(record.gameTimeSec, 0) + 's · lv=' + esc(record.finalLevel)
            + ' · kills=' + esc(record.totalKills) + ' · score=' + fmtNum(record.score, 0)
            + ' · minHP=' + fmtPct(record.minHealthPct);
          html += '<div class="cell ' + outcomeClass(record.outcome) + '" title="' + title + '">' + outcomeAbbrev(record.outcome) + '</div>';
        }
      }
      html += '</div></div><div class="legend">'
        + '<span><span class="swatch" style="background:var(--win)"></span>victory</span>'
        + '<span><span class="swatch" style="background:var(--loss)"></span>death</span>'
        + '<span><span class="swatch" style="background:var(--timeout)"></span>timeout</span>'
        + '<span><span class="swatch" style="background:var(--stalled)"></span>stalled</span>'
        + '<span><span class="swatch" style="background:var(--errored)"></span>error</span>'
        + '</div></section>';
    }
    content.innerHTML = html;
  }

  function renderBaselineResults(state) {
    const content = document.getElementById('content');
    if (!state.data) {
      content.innerHTML = '<div class="empty-state">'
        + (state.refreshing ? 'Loading baseline snapshot…' : 'No baseline snapshot loaded.')
        + '</div>';
      return;
    }
    const data = state.data;
    let html = '<section><h2>Baseline summary</h2><div class="table-wrap"><table><thead><tr>'
      + '<th>Floor</th><th>Wins</th><th>Runs</th><th>Win rate</th><th>Captured</th>'
      + '</tr></thead><tbody><tr><td>' + esc(data.floorId || 'unknown') + '</td><td>'
      + esc(data.totalWins) + '</td><td>' + esc(data.totalRuns) + '</td><td><span class="winrate '
      + winRateClass(data.winRate) + '">' + fmtPct(data.winRate) + '</span></td><td>'
      + esc(data.meta?.capturedAt ? new Date(data.meta.capturedAt).toLocaleString() : 'unknown')
      + '</td></tr></tbody></table></div></section>';
    html += '<section><h2>Per-weapon win rate</h2><div class="table-wrap"><table><thead><tr>'
      + '<th>Weapon</th><th>Wins</th><th>Runs</th><th>Win rate</th><th>Slow victories</th>'
      + '</tr></thead><tbody>';
    for (const weapon of data.perWeapon || []) {
      const rate = weapon.runs ? weapon.wins / weapon.runs : 0;
      html += '<tr><td class="weapon-name">' + esc(weapon.weapon) + '</td><td>'
        + esc(weapon.wins) + '</td><td>' + esc(weapon.runs) + '</td><td><span class="winrate '
        + winRateClass(rate) + '">' + fmtPct(rate) + '</span></td><td>'
        + esc(weapon.slowVictories ?? 0) + '</td></tr>';
    }
    html += '</tbody></table></div></section>';
    content.innerHTML = html;
  }

  function renderBaselineSweepResults(state) {
    const content = document.getElementById('content');
    if (!state.data) {
      const detail = state.refreshing
        ? 'Loading baseline-sweep results…'
        : 'No baseline-sweep artifact is available for this run.';
      content.innerHTML = '<div class="empty-state">' + detail + '</div>';
      return;
    }

    const data = state.data;
    let html = '<section><h2>Release baseline</h2><div class="table-wrap"><table><tbody>';
    html += '<tr><th>Commit</th><td>' + esc(data.meta?.commitSubject || 'Unknown') + ' <code>' + esc((data.meta?.commit || '').slice(0, 12) || 'unknown') + '</code></td></tr>';
    html += '<tr><th>Win rate</th><td><span class="winrate ' + winRateClass(data.winRate) + '">' + fmtPct(data.winRate) + '</span> (' + esc(data.totalWins ?? '—') + '/' + esc(data.totalRuns ?? '—') + ')</td></tr>';
    if (Number.isFinite(data.totalSlowVictories) || Number.isFinite(data.totalTrueLosses)) {
      const fastWins = Number.isFinite(data.totalWins) && Number.isFinite(data.totalSlowVictories)
        ? data.totalWins - data.totalSlowVictories
        : null;
      html += '<tr><th>Breakdown</th><td>' + (fastWins === null ? '—' : esc(fastWins) + ' fast wins · ' + esc(data.totalSlowVictories ?? 0) + ' slow victories · ' + esc(data.totalTrueLosses ?? 0) + ' true losses') + '</td></tr>';
    }
    html += '</tbody></table></div></section>';

    if (Array.isArray(data.perWeapon) && data.perWeapon.length) {
      html += '<section><h2>Per-weapon</h2><div class="table-wrap"><table><thead><tr><th>Weapon</th><th>Wins</th><th>Runs</th><th>Win rate</th><th>Slow victories</th></tr></thead><tbody>';
      for (const w of data.perWeapon) {
        const rate = w.runs ? w.wins / w.runs : NaN;
        html += '<tr><td class="weapon-name">' + esc(w.weapon) + '</td><td>' + esc(w.wins) + '</td><td>' + esc(w.runs) + '</td>'
          + '<td><span class="winrate ' + winRateClass(rate) + '">' + fmtPct(rate) + '</span></td>'
          + '<td>' + esc(w.slowVictories ?? 0) + '</td></tr>';
      }
      html += '</tbody></table></div></section>';
    }

    html += '<section><h2>Fun evaluation</h2>';
    const report = data.funReport;
    if (!report) {
      html += '<div class="empty-state">Fun evaluation report is not available for this run (captured before fun evaluation existed, or scoring failed for this release).</div>';
    } else {
      const gatePillClass = report.gate ? (report.gate.pass ? 'success' : 'failure') : '';
      html += '<div class="table-wrap"><table><tbody>';
      html += '<tr><th>Overall fun score</th><td>' + fmtNum(report.overall_fun_score, 1) + ' / 100'
        + (report.gate ? ' <span class="pill ' + gatePillClass + '">' + (report.gate.pass ? 'gate pass' : 'gate fail') + '</span>' : '')
        + '</td></tr>';
      html += '<tr><th>Confidence</th><td>' + fmtNum(report.confidence, 2) + '</td></tr>';
      html += '<tr><th>Sameness grade</th><td>' + fmtNum(report.sameness_grade, 1) + '</td></tr>';
      html += '</tbody></table></div>';
      if (report.dimensions) {
        const keys = Object.keys(report.dimensions);
        html += '<div class="table-wrap"><table><thead><tr>' + keys.map((k) => '<th>' + esc(k) + '</th>').join('') + '</tr></thead><tbody><tr>'
          + keys.map((k) => '<td>' + fmtNum(report.dimensions[k], 1) + '</td>').join('') + '</tr></tbody></table></div>';
      }
      if (report.criteria) {
        html += '<div class="table-wrap"><table><thead><tr><th>Criterion</th><th>Status</th><th>Observed</th><th>Target</th><th>Reason</th></tr></thead><tbody>';
        for (const [name, criterion] of Object.entries(report.criteria)) {
          const statusClass = criterion.status === 'healthy' ? 'success' : criterion.status === 'needs_attention' ? 'failure' : '';
          html += '<tr><td><code>' + esc(name) + '</code></td>'
            + '<td><span class="pill ' + statusClass + '">' + esc(criterion.status) + '</span></td>'
            + '<td>' + fmtNum(criterion.observed, 2) + '</td>'
            + '<td>' + fmtNum(criterion.target, 2) + '</td>'
            + '<td>' + esc(criterion.reason) + '</td></tr>';
        }
        html += '</tbody></table></div>';
      }
      if (Array.isArray(report.hotspots) && report.hotspots.length) {
        html += '<div class="message warning">Hotspots: ' + report.hotspots.map((h) => esc(h.dimension) + ' (' + fmtNum(h.score, 1) + ')').join(', ') + '</div>';
      }
    }
    html += '</section>';
    content.innerHTML = html;
  }

  function renderResults(state) {
    const workflowType = state.workflowType || state.selectedRun?.workflowType;
    if (workflowType === 'ai-sweep') {
      renderAiSweepResults(state);
    } else if (workflowType === 'baseline') {
      renderBaselineResults(state);
    } else if (workflowType === 'baseline-sweep') {
      renderBaselineSweepResults(state);
    } else {
      renderWeaponSweepResults(state);
    }
  }

  function render(state) {
    currentState = state;
    document.getElementById('source-select').value = state.source;
    document.getElementById('source-select').disabled = state.refreshing;
    renderBranchSelector(state);
    const meta = document.getElementById('meta');
    meta.textContent = state.source === 'cloud'
      ? (state.repository || 'Unknown repository') + ' · attached branch ' + (state.branch || 'detached')
      : state.source === 'repository'
        ? (state.repository || 'Unknown repository') + ' · '
          + (state.selectedRepositoryBranch?.name || 'No benchmark branch')
          + (state.selectedRepositoryPath ? ' · ' + state.selectedRepositoryPath : '')
        : (state.path || state.localDirectory || 'No local path');
    document.getElementById('reload').disabled = state.refreshing;
    const workflowType = state.workflowType || state.selectedRun?.workflowType;
    const titleEl = document.getElementById('page-title');
    if (titleEl) {
      titleEl.textContent = workflowType === 'ai-sweep'
        ? '🤖 AI Sweep Eval Results'
        : workflowType === 'baseline-sweep'
          ? '📊 Release Baseline Results'
        : '🗡️ Weapon Sweep Results';
    }
    renderRunSelector(state);
    renderMessages(state);
    renderStatus(state);
    renderResults(state);
  }

  async function request(path, options = {}) {
    const response = await fetch(apiUrl(path), {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || ('Request failed with status ' + response.status));
    return body;
  }

  document.getElementById('reload').addEventListener('click', async () => {
    try { render(await request('/api/reload', { method: 'POST' })); }
    catch (error) {
      const element = document.getElementById('connection-error');
      element.hidden = false;
      element.textContent = 'Refresh request failed: ' + error.message;
    }
  });

  document.getElementById('source-select').addEventListener('change', async (event) => {
    event.target.disabled = true;
    try {
      render(await request('/api/select-source', {
        method: 'POST',
        body: JSON.stringify({ source: event.target.value }),
      }));
    } catch (error) {
      const element = document.getElementById('connection-error');
      element.hidden = false;
      element.textContent = 'Source switch failed: ' + error.message;
      if (currentState) render(currentState);
    }
  });

  document.getElementById('branch-select').addEventListener('change', async (event) => {
    event.target.disabled = true;
    try {
      render(await request('/api/select-repository-branch', {
        method: 'POST',
        body: JSON.stringify({ branch: event.target.value }),
      }));
    } catch (error) {
      const element = document.getElementById('connection-error');
      element.hidden = false;
      element.textContent = 'Branch selection failed: ' + error.message;
      if (currentState) render(currentState);
    }
  });

  document.getElementById('run-select').addEventListener('change', async (event) => {
    event.target.disabled = true;
    try {
      if (currentState?.source === 'local') {
        render(await request('/api/select-local', {
          method: 'POST',
          body: JSON.stringify({ path: event.target.value }),
        }));
      } else if (currentState?.source === 'repository') {
        render(await request('/api/select-repository-artifact', {
          method: 'POST',
          body: JSON.stringify({ path: event.target.value }),
        }));
      } else {
        const runId = Number(event.target.value);
        if (!Number.isSafeInteger(runId)) return;
        render(await request('/api/select-run', { method: 'POST', body: JSON.stringify({ runId }) }));
      }
    } catch (error) {
      const element = document.getElementById('connection-error');
      element.hidden = false;
      element.textContent = 'Run selection failed: ' + error.message;
      if (currentState) render(currentState);
    }
  });

  const events = new EventSource(apiUrl('/events'));
  events.onmessage = (event) => {
    try {
      document.getElementById('connection-error').hidden = true;
      render(JSON.parse(event.data));
    } catch (error) {
      const element = document.getElementById('connection-error');
      element.hidden = false;
      element.textContent = 'Live update was invalid: ' + error.message;
    }
  };
  events.onerror = () => {
    const element = document.getElementById('connection-error');
    element.hidden = false;
    element.textContent = 'Live updates disconnected; retrying automatically.';
  };
  request('/api/state').then(render).catch((error) => {
    const element = document.getElementById('connection-error');
    element.hidden = false;
    element.textContent = 'Initial state failed: ' + error.message;
  });
  </script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
