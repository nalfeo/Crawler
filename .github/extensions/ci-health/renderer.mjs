function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderHtml({ instanceId, refreshIntervalMs }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CI Health</title>
  <style>
    :root {
      color-scheme: light dark;
      --panel: color-mix(in srgb, var(--background-color-default, #0d1117) 92%, var(--text-color-default, #c9d1d9));
      --subtle: color-mix(in srgb, var(--background-color-default, #0d1117) 96%, var(--text-color-default, #c9d1d9));
      --success: var(--true-color-green, #3fb950);
      --warning: var(--true-color-yellow, #d29922);
      --danger: var(--true-color-red, #f85149);
      --accent: var(--true-color-blue, #58a6ff);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--background-color-default, #0d1117);
      color: var(--text-color-default, #c9d1d9);
      font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      font-size: var(--text-body-medium, 14px);
      line-height: var(--leading-body-medium, 20px);
    }
    main { display: grid; gap: 16px; padding: 18px; }
    header, .toolbar, .section-heading, .run-heading {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    h1 {
      margin: 0;
      font-size: var(--text-title-large, 26px);
      line-height: var(--leading-title-large, 32px);
      font-weight: var(--font-weight-semibold, 600);
    }
    h2 {
      margin: 0;
      font-size: var(--text-title-medium, 20px);
      line-height: var(--leading-title-medium, 26px);
      font-weight: var(--font-weight-semibold, 600);
    }
    h3 { margin: 0; font-size: 15px; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    a:focus-visible, button:focus-visible, summary:focus-visible {
      outline: 2px solid var(--color-focus-outline, #58a6ff);
      outline-offset: 2px;
    }
    button {
      min-height: 34px;
      padding: 5px 12px;
      border: 1px solid var(--border-color-default, #30363d);
      border-radius: 6px;
      background: var(--panel);
      color: inherit;
      font: inherit;
      font-weight: var(--font-weight-semibold, 600);
      cursor: pointer;
    }
    button:disabled { cursor: wait; opacity: .65; }
    .muted { color: var(--text-color-muted, #8b949e); }
    .mono { font-family: var(--font-mono, "SFMono-Regular", Consolas, monospace); }
    .meta { display: flex; flex-wrap: wrap; gap: 8px 14px; font-size: 12px; }
    .card, .message, .run, details.group {
      border: 1px solid var(--border-color-default, #30363d);
      border-radius: 8px;
      background: var(--panel);
    }
    .card, .message, .run { padding: 12px; }
    .message { display: grid; gap: 5px; }
    .message[hidden] { display: none; }
    .message.danger, .bottleneck.danger { border-color: var(--danger); }
    .message.warning, .bottleneck.warning { border-color: var(--warning); }
    .bottleneck.success { border-color: var(--success); }
    .bottleneck.info { border-color: var(--accent); }
    .bottleneck { display: grid; gap: 5px; border-left-width: 4px; }
    .metrics {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 10px;
    }
    .metric { display: grid; gap: 3px; }
    .metric strong { font-size: 22px; line-height: 28px; font-variant-numeric: tabular-nums; }
    .progress {
      height: 7px;
      overflow: hidden;
      border-radius: 999px;
      background: var(--subtle);
    }
    .progress > span { display: block; height: 100%; background: var(--accent); }
    .progress.warning > span { background: var(--warning); }
    .progress.danger > span { background: var(--danger); }
    section { display: grid; gap: 10px; }
    .table-wrap { overflow-x: auto; border: 1px solid var(--border-color-default, #30363d); border-radius: 8px; }
    table { width: 100%; border-collapse: collapse; background: var(--panel); }
    th, td {
      padding: 8px 10px;
      border-bottom: 1px solid var(--border-color-default, #30363d);
      text-align: left;
      vertical-align: top;
    }
    th { background: var(--subtle); color: var(--text-color-muted, #8b949e); font-size: 12px; }
    tr:last-child td { border-bottom: none; }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      padding: 1px 7px;
      border: 1px solid var(--border-color-default, #30363d);
      border-radius: 999px;
      white-space: nowrap;
      font-size: 12px;
    }
    .pill.success { border-color: var(--success); color: var(--success); }
    .pill.warning { border-color: var(--warning); color: var(--warning); }
    .pill.danger { border-color: var(--danger); color: var(--danger); }
    .pill.info { border-color: var(--accent); color: var(--accent); }
    .stack { display: grid; gap: 8px; }
    .run { display: grid; gap: 10px; }
    .run-meta { display: flex; flex-wrap: wrap; gap: 6px 12px; color: var(--text-color-muted, #8b949e); font-size: 12px; }
    details.group { overflow: hidden; }
    details.group > summary { padding: 10px 12px; cursor: pointer; font-weight: var(--font-weight-semibold, 600); }
    details.group > div { border-top: 1px solid var(--border-color-default, #30363d); }
    .empty { padding: 18px; border: 1px dashed var(--border-color-default, #30363d); border-radius: 8px; text-align: center; color: var(--text-color-muted, #8b949e); }
    @media (max-width: 640px) {
      main { padding: 12px; }
      header { align-items: flex-start; }
      th, td { padding: 7px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>CI Health</h1>
        <div id="repository" class="muted">Resolving repository…</div>
      </div>
      <button id="refresh" type="button">Refresh now</button>
    </header>
    <div class="toolbar">
      <div id="freshness" class="meta muted">
        <span>Instance ${escapeHtml(instanceId)}</span>
        <span>Refresh every ${Math.round(refreshIntervalMs / 1000)}s</span>
      </div>
      <a id="actions-link" target="_blank" rel="noreferrer">Open GitHub Actions</a>
    </div>
    <div id="error" class="message danger" hidden></div>
    <div id="warnings" class="message warning" hidden></div>
    <section id="bottleneck" class="card bottleneck info">
      <strong>Loading CI state…</strong>
      <span class="muted">Waiting for the first authenticated GitHub snapshot.</span>
    </section>
    <section id="metrics" class="metrics"></section>
    <section>
      <div class="section-heading">
        <h2>Merge Train</h2>
        <span id="train-meta" class="muted"></span>
      </div>
      <div id="train"></div>
    </section>
    <section id="blocked-section" hidden>
      <div class="section-heading"><h2>Blocked train entries</h2></div>
      <div id="blocked"></div>
    </section>
    <section id="recovery-section" hidden>
      <div class="section-heading"><h2>CI Recovery</h2></div>
      <div id="recovery"></div>
    </section>
    <section>
      <div class="section-heading">
        <h2>Active and queued workflows</h2>
        <span id="run-meta" class="muted"></span>
      </div>
      <div id="runs" class="stack"></div>
    </section>
  </main>
  <script>
    const tokenQuery = location.search;
    const refreshButton = document.getElementById('refresh');
    let currentState = null;

    const endpoint = (path) => path + tokenQuery;
    const text = (value) => value == null || value === '' ? '—' : String(value);
    const shortSha = (value) => value ? String(value).slice(0, 8) : 'not built';
    const formatTime = (value) => value ? new Date(value).toLocaleString() : 'unknown';
    const age = (value) => {
      if (!value) return 'unknown';
      const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000));
      if (seconds < 60) return seconds + 's ago';
      const minutes = Math.round(seconds / 60);
      return minutes + 'm ago';
    };
    function node(tag, options = {}, ...children) {
      const element = document.createElement(tag);
      if (options.className) element.className = options.className;
      if (options.title) element.title = options.title;
      for (const child of children.flat()) {
        if (child == null) continue;
        element.append(child instanceof Node ? child : document.createTextNode(String(child)));
      }
      return element;
    }
    function link(url, label) {
      if (!url) return node('span', {}, label);
      const anchor = node('a', {}, label);
      anchor.href = url;
      anchor.target = '_blank';
      anchor.rel = 'noreferrer';
      return anchor;
    }
    function pill(label, tone = '') {
      return node('span', { className: 'pill ' + tone }, label);
    }
    function toneForState(state) {
      if (/fail|error|block|malformed|duplicate/i.test(state)) return 'danger';
      if (/queue|wait|pending|test|progress|transition/i.test(state)) return 'warning';
      if (/success|ready|promot|complete/i.test(state)) return 'success';
      return 'info';
    }
    function replaceChildren(id, ...children) {
      document.getElementById(id).replaceChildren(...children.flat());
    }
    function metric(label, value, detail, progress) {
      const card = node('div', { className: 'card metric' },
        node('span', { className: 'muted' }, label),
        node('strong', {}, value),
        node('span', { className: 'muted' }, detail),
      );
      if (progress) {
        const bar = node('div', { className: 'progress ' + progress.tone });
        const fill = node('span');
        fill.style.width = Math.min(100, Math.max(0, progress.value)) + '%';
        bar.append(fill);
        card.append(bar);
      }
      return card;
    }
    function renderPullTable(entries, mode) {
      if (!entries.length) return node('div', { className: 'empty' }, 'None.');
      const head = node('tr', {},
        mode === 'train' ? node('th', {}, 'Pos') : null,
        node('th', {}, 'Pull request'),
        node('th', {}, 'State'),
        node('th', {}, mode === 'train' ? 'Candidate' : 'Labels'),
        node('th', {}, 'Detail'),
      );
      const bodyRows = entries.map((entry) => {
        const status = mode === 'train' ? entry : entry.status;
        const state = mode === 'train' ? entry.state : entry.state;
        const detail = status?.detail || (mode === 'recovery' ? 'Recovery state is label-derived.' : 'No managed status detail.');
        const health = status?.commentHealth;
        const stateCell = node('td', {}, pill(state, toneForState(state)));
        if (health && health !== 'ok') stateCell.append(' ', pill(health, toneForState(health)));
        return node('tr', {},
          mode === 'train' ? node('td', {}, entry.position, entry.positionDrift ? ' (comment ' + entry.positionDrift + ')' : '') : null,
          node('td', {},
            link(entry.url, '#' + entry.number + ' ' + entry.title),
            node('div', { className: 'muted mono' }, entry.headRef || ''),
          ),
          stateCell,
          node('td', { className: 'mono' }, mode === 'train' ? shortSha(entry.candidateSha) : entry.labels.join(', ')),
          node('td', {}, detail),
        );
      });
      return node('div', { className: 'table-wrap' }, node('table', {}, node('thead', {}, head), node('tbody', {}, bodyRows)));
    }
    function renderRuns(runs) {
      if (!runs.length) return [node('div', { className: 'empty' }, 'No active or queued workflow runs.')];
      return runs.map((run) => {
        const jobRows = run.jobs.map((job) => node('tr', {},
          node('td', {}, link(job.url, job.name)),
          node('td', {}, pill(job.status, toneForState(job.status))),
          node('td', {}, job.hosted ? 'hosted' : 'self-hosted'),
          node('td', {}, text(job.runnerName)),
        ));
        const jobs = run.jobs.length
          ? node('div', { className: 'table-wrap' }, node('table', {},
              node('thead', {}, node('tr', {}, node('th', {}, 'Job'), node('th', {}, 'State'), node('th', {}, 'Pool'), node('th', {}, 'Runner'))),
              node('tbody', {}, jobRows),
            ))
          : node('div', { className: 'empty' }, run.jobsError || 'No visible jobs yet.');
        return node('article', { className: 'run' },
          node('div', { className: 'run-heading' },
            node('h3', {}, link(run.url, run.displayTitle)),
            pill(run.status, toneForState(run.status)),
          ),
          node('div', { className: 'run-meta' },
            node('span', {}, run.name),
            node('span', { className: 'mono' }, text(run.branch)),
            node('span', {}, 'started ' + age(run.createdAt)),
            node('span', {}, run.jobs.length + ' jobs'),
            run.jobsTruncated ? pill('jobs truncated', 'danger') : null,
          ),
          jobs,
        );
      });
    }
    function render(state) {
      currentState = state;
      refreshButton.disabled = Boolean(state.refreshing);
      refreshButton.textContent = state.refreshing ? 'Refreshing…' : 'Refresh now';
      const snapshot = state.snapshot;
      const errorBox = document.getElementById('error');
      if (state.error) {
        errorBox.hidden = false;
        errorBox.replaceChildren(node('strong', {}, 'Refresh failed'), node('span', {}, state.error));
      } else {
        errorBox.hidden = true;
        errorBox.replaceChildren();
      }
      if (!snapshot) return;

      const repository = document.getElementById('repository');
      repository.replaceChildren(link(snapshot.repositoryUrl, snapshot.repository));
      const actionsLink = document.getElementById('actions-link');
      actionsLink.href = snapshot.actionsUrl;
      document.getElementById('freshness').replaceChildren(
        node('span', {}, 'Updated ' + age(snapshot.fetchedAt)),
        node('span', {}, formatTime(snapshot.fetchedAt)),
        node('span', {}, snapshot.apiCalls + ' GitHub API calls'),
        node('span', {}, '30s live refresh'),
      );

      const warnings = snapshot.actions.warnings;
      const warningBox = document.getElementById('warnings');
      warningBox.hidden = warnings.length === 0;
      warningBox.replaceChildren(...warnings.map((warning) => node('span', {}, warning)));

      const bottleneck = document.getElementById('bottleneck');
      bottleneck.className = 'card bottleneck ' + snapshot.bottleneck.severity;
      bottleneck.replaceChildren(
        node('strong', {}, snapshot.bottleneck.title),
        node('span', { className: 'muted' }, snapshot.bottleneck.detail),
      );

      const actions = snapshot.actions;
      replaceChildren('metrics',
        metric('Visible hosted runners', actions.visibleHostedInProgress + ' / ' + actions.runnerCap, actions.occupancyScope, {
          value: actions.utilizationPercent,
          tone: actions.utilizationPercent >= 100 ? 'danger' : actions.utilizationPercent >= 80 ? 'warning' : '',
        }),
        metric('Hosted jobs queued', actions.visibleHostedQueued, 'Repository-visible queue'),
        metric('Active workflow runs', actions.activeRunCount, 'Queued, waiting, or in progress'),
        metric('Merge Train queue', snapshot.train.queueDepth, snapshot.train.backlogCount + ' beyond active six'),
      );

      document.getElementById('train-meta').textContent =
        snapshot.train.candidates.length + '/' + snapshot.train.maxSize + ' active · ' + snapshot.train.backlogCount + ' backlog';
      replaceChildren('train', renderPullTable(snapshot.train.candidates, 'train'));

      const blockedSection = document.getElementById('blocked-section');
      blockedSection.hidden = snapshot.train.blocked.length === 0;
      replaceChildren('blocked', renderPullTable(snapshot.train.blocked, 'blocked'));

      const recoverySection = document.getElementById('recovery-section');
      recoverySection.hidden = snapshot.train.recovery.length === 0;
      replaceChildren('recovery', renderPullTable(snapshot.train.recovery, 'recovery'));

      document.getElementById('run-meta').textContent =
        actions.activeRunCount + ' active runs · ' +
        actions.visibleHostedInProgress + ' hosted jobs running · ' +
        actions.visibleHostedQueued + ' hosted jobs queued';
      replaceChildren('runs', renderRuns(actions.runs));
    }
    async function fetchState() {
      const response = await fetch(endpoint('/api/state'), { cache: 'no-store' });
      if (!response.ok) throw new Error('State request failed (' + response.status + ').');
      render(await response.json());
    }
    refreshButton.addEventListener('click', async () => {
      refreshButton.disabled = true;
      refreshButton.textContent = 'Refreshing…';
      try {
        const response = await fetch(endpoint('/api/refresh'), { method: 'POST' });
        if (!response.ok) throw new Error('Refresh failed (' + response.status + ').');
        render(await response.json());
      } catch (error) {
        refreshButton.disabled = false;
        refreshButton.textContent = 'Refresh now';
        const errorBox = document.getElementById('error');
        errorBox.hidden = false;
        errorBox.replaceChildren(node('strong', {}, 'Refresh failed'), node('span', {}, error.message));
      }
    });
    const events = new EventSource(endpoint('/events'));
    events.onmessage = (event) => render(JSON.parse(event.data));
    events.onerror = () => {
      if (currentState) {
        const errorBox = document.getElementById('error');
        errorBox.hidden = false;
        errorBox.replaceChildren(node('strong', {}, 'Live connection interrupted'), node('span', {}, 'The dashboard will reconnect automatically.'));
      }
    };
    fetchState().catch((error) => {
      const errorBox = document.getElementById('error');
      errorBox.hidden = false;
      errorBox.replaceChildren(node('strong', {}, 'Unable to load state'), node('span', {}, error.message));
    });
  </script>
</body>
</html>`;
}
