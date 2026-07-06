// HTML renderer for the sweep-results-viewer canvas.
// The page connects to /events (SSE) and re-renders on every state update.

export function renderHtml(instanceId) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Sweep Results — ${instanceId}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0d1117;
      --panel: #161b22;
      --border: #30363d;
      --text: #c9d1d9;
      --muted: #8b949e;
      --accent: #58a6ff;
      --win: #3fb950;
      --loss: #f85149;
      --timeout: #d29922;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 1rem;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      font-size: 13px;
    }
    header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 1rem;
      margin-bottom: 0.75rem;
    }
    h1 { font-size: 15px; margin: 0; font-weight: 600; }
    .meta { color: var(--muted); font-size: 11px; }
    .path { font-family: ui-monospace, monospace; color: var(--accent); }
    button {
      background: var(--panel);
      color: var(--text);
      border: 1px solid var(--border);
      padding: 4px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }
    button:hover { border-color: var(--accent); }
    .error {
      background: rgba(248,81,73,0.1);
      border: 1px solid var(--loss);
      color: var(--loss);
      padding: 0.5rem 0.75rem;
      border-radius: 4px;
      margin: 0.5rem 0;
      font-family: ui-monospace, monospace;
    }
    section { margin-bottom: 1.25rem; }
    h2 { font-size: 13px; margin: 0 0 0.5rem; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 4px;
      overflow: hidden;
    }
    th, td {
      text-align: right;
      padding: 6px 10px;
      border-bottom: 1px solid var(--border);
      font-variant-numeric: tabular-nums;
    }
    th:first-child, td:first-child { text-align: left; }
    th {
      background: rgba(255,255,255,0.03);
      color: var(--muted);
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    tr:last-child td { border-bottom: none; }
    .weapon-name { font-weight: 600; }
    .winrate {
      display: inline-block;
      min-width: 44px;
      padding: 1px 6px;
      border-radius: 3px;
      font-weight: 600;
    }
    .winrate.high { background: rgba(63,185,80,0.2); color: var(--win); }
    .winrate.mid  { background: rgba(210,153,34,0.2); color: var(--timeout); }
    .winrate.low  { background: rgba(248,81,73,0.2); color: var(--loss); }

    .grid-wrap { overflow-x: auto; }
    .grid {
      display: grid;
      gap: 2px;
      font-family: ui-monospace, monospace;
      font-size: 10px;
    }
    .grid .head {
      color: var(--muted);
      text-align: center;
      padding: 2px 0;
    }
    .grid .row-label {
      color: var(--muted);
      padding: 2px 6px;
      text-align: right;
      white-space: nowrap;
    }
    .cell {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 22px;
      border-radius: 2px;
      cursor: help;
      color: #fff;
      font-weight: 600;
    }
    .cell.victory { background: var(--win); }
    .cell.death   { background: var(--loss); }
    .cell.timeout { background: var(--timeout); }
    .cell.empty   { background: var(--panel); border: 1px solid var(--border); color: var(--muted); }

    .legend { display: flex; gap: 1rem; font-size: 11px; color: var(--muted); margin-top: 0.5rem; }
    .legend .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; vertical-align: middle; margin-right: 4px; }

    .empty-state {
      background: var(--panel);
      border: 1px dashed var(--border);
      border-radius: 4px;
      padding: 2rem;
      text-align: center;
      color: var(--muted);
    }
    .empty-state code { color: var(--accent); }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Weapon Sweep Results</h1>
      <div class="meta"><span id="path" class="path">—</span> · <span id="runAt">—</span></div>
    </div>
    <button id="reload">↻ Reload</button>
  </header>
  <div id="error" class="error" style="display:none"></div>
  <div id="content"></div>

  <script>
  const instanceId = ${JSON.stringify(instanceId)};

  const fmtPct = (n) => (n * 100).toFixed(1) + '%';
  const fmtNum = (n, d = 1) => Number(n).toFixed(d);

  function winRateClass(r) {
    if (r >= 0.9) return 'high';
    if (r >= 0.5) return 'mid';
    return 'low';
  }

  function outcomeAbbrev(o) {
    if (o === 'victory') return 'W';
    if (o === 'death') return 'D';
    if (o === 'timeout') return 'T';
    return '?';
  }

  function render(state) {
    const path = document.getElementById('path');
    const runAt = document.getElementById('runAt');
    const errorEl = document.getElementById('error');
    const content = document.getElementById('content');

    path.textContent = state.path || '—';

    if (state.error) {
      errorEl.style.display = 'block';
      errorEl.textContent = state.error;
    } else {
      errorEl.style.display = 'none';
    }

    if (!state.data) {
      runAt.textContent = 'no data';
      content.innerHTML = '<div class="empty-state">No sweep data loaded. Run <code>npm run ai:weapon-sweep</code> to produce <code>' + (state.path || '/tmp/weapon-sweep.json') + '</code>, then click Reload.</div>';
      return;
    }

    const d = state.data;
    runAt.textContent = d.runAt ? new Date(d.runAt).toLocaleString() : '—';

    // Summary table
    const summaries = d.summaries || [];
    let html = '<section><h2>Per-Weapon Summary (' + (d.seeds?.length ?? 0) + ' seeds × ' + (d.weapons?.length ?? 0) + ' weapons)</h2>';
    html += '<table><thead><tr>';
    html += '<th>Weapon</th><th>Runs</th><th>Wins</th><th>Win Rate</th><th>Mean Score</th><th>Mean Time (s)</th><th>Mean Lv</th><th>Mean Kills</th><th>Mean Min HP%</th>';
    html += '</tr></thead><tbody>';
    for (const s of summaries) {
      html += '<tr>';
      html += '<td class="weapon-name">' + s.weapon + '</td>';
      html += '<td>' + s.runs + '</td>';
      html += '<td>' + s.victories + '</td>';
      html += '<td><span class="winrate ' + winRateClass(s.winRate) + '">' + fmtPct(s.winRate) + '</span></td>';
      html += '<td>' + fmtNum(s.meanScore, 0) + '</td>';
      html += '<td>' + fmtNum(s.meanGameTimeSec, 1) + '</td>';
      html += '<td>' + fmtNum(s.meanLevel, 1) + '</td>';
      html += '<td>' + fmtNum(s.meanKills, 1) + '</td>';
      html += '<td>' + fmtPct(s.meanMinHealthPct) + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table></section>';

    // Per-seed heatmap
    const seeds = d.seeds || [];
    const weapons = d.weapons || [];
    if (seeds.length && weapons.length) {
      // Index records: recordsByWeaponSeed[weapon][seed] = record
      const idx = {};
      for (const r of d.allRecords || []) {
        (idx[r.weapon] ||= {})[r.seed] = r;
      }

      html += '<section><h2>Per-Seed Outcomes</h2><div class="grid-wrap">';
      const cols = seeds.length + 1;
      html += '<div class="grid" style="grid-template-columns: auto repeat(' + seeds.length + ', minmax(28px, 1fr));">';
      html += '<div class="head"></div>';
      for (const seed of seeds) html += '<div class="head">' + seed + '</div>';
      for (const weapon of weapons) {
        html += '<div class="row-label">' + weapon + '</div>';
        for (const seed of seeds) {
          const r = idx[weapon]?.[seed];
          if (!r) {
            html += '<div class="cell empty" title="' + weapon + ' seed=' + seed + ': (no data)">—</div>';
          } else {
            const cls = 'cell ' + (r.outcome || 'empty');
            const title = weapon + ' seed=' + seed + ' · ' + r.outcome
              + ' · t=' + fmtNum(r.gameTimeSec, 0) + 's'
              + ' · lv=' + r.finalLevel
              + ' · kills=' + r.totalKills
              + ' · score=' + fmtNum(r.score, 0)
              + ' · minHP=' + fmtPct(r.minHealthPct);
            html += '<div class="' + cls + '" title="' + title.replace(/"/g, '&quot;') + '">' + outcomeAbbrev(r.outcome) + '</div>';
          }
        }
      }
      html += '</div></div>';
      html += '<div class="legend">'
        + '<span><span class="swatch" style="background:var(--win)"></span>victory</span>'
        + '<span><span class="swatch" style="background:var(--loss)"></span>death</span>'
        + '<span><span class="swatch" style="background:var(--timeout)"></span>timeout</span>'
        + '</div>';
      html += '</section>';
    }

    content.innerHTML = html;
  }

  document.getElementById('reload').addEventListener('click', async () => {
    try {
      const resp = await fetch('/api/reload', { method: 'POST' });
      const state = await resp.json();
      render(state);
    } catch (err) {
      const el = document.getElementById('error');
      el.style.display = 'block';
      el.textContent = 'Reload failed: ' + err.message;
    }
  });

  // Live updates via SSE
  const es = new EventSource('/events');
  es.onmessage = (ev) => {
    try { render(JSON.parse(ev.data)); } catch (e) { /* ignore */ }
  };

  // Initial fetch (in case SSE lags)
  fetch('/api/state').then((r) => r.json()).then(render).catch(() => {});
  </script>
</body>
</html>`;
}
