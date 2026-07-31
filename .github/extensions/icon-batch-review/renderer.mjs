/**
 * renderer.mjs — icon-batch-review canvas HTML renderer.
 *
 * Called server-side with the full state; returns a complete HTML document
 * string that the canvas harness serves to the iframe.
 */

/**
 * @param {{ batches: import('./lib/bridge.mjs').BatchSummary[], baseUrl: string, recentRuns?: { databaseId: number, status: string, conclusion: string|null, displayTitle: string, createdAt: string }[] }} state
 * @returns {string} HTML document
 */
export function renderHtml({ batches, baseUrl, recentRuns = [] }) {
  const totalIcons = batches.reduce((s, b) => s + b.total, 0);
  const totalApproved = batches.reduce((s, b) => s + b.approved, 0);
  const pct = totalIcons > 0 ? Math.round((totalApproved / totalIcons) * 100) : 0;

  const batchRows = batches
    .map((b) => {
      const statusClass =
        b.approved === b.total && b.total > 0
          ? 'status-done'
          : b.approved > 0
            ? 'status-partial'
            : 'status-pending';
      const statusLabel =
        b.approved === b.total && b.total > 0
          ? '✓ done'
          : b.approved > 0
            ? `~ ${b.approved}/${b.total}`
            : '· pending';

      const iconCells = b.entries
        .map((e) => {
          const imgSrc = e.isApproved ? `${baseUrl}icon/${encodeURIComponent(e.id)}` : '';
          const escapedConcept = escHtml(e.concept).replace(/'/g, "\\'");
          const escapedId = escHtml(e.id).replace(/'/g, "\\'");
          let stateClass = 'pending';
          if (e.isRejected) stateClass = 'rejected';
          else if (e.isApproved) stateClass = 'approved';
          const imgEl = e.isApproved
            ? `<img src="${imgSrc}" alt="${escHtml(e.concept)}" title="${escHtml(e.id)}" />`
            : `<div class="icon-placeholder" title="${escHtml(e.id)}">${escHtml(e.concept.slice(0, 8))}</div>`;
          const rejectBtn =
            e.isApproved || e.isRejected
              ? `<button class="icon-btn icon-btn-reject" title="Reject" onclick="event.stopPropagation();rejectIcon('${escapedId}','${escapedConcept}')">🚫</button>`
              : '';
          const unrejectBtn = e.isRejected
            ? `<button class="icon-btn icon-btn-unreject" title="Un-reject" onclick="event.stopPropagation();unrejectIcon('${escapedId}')">↺</button>`
            : '';
          return `<div class="icon-cell ${stateClass}" title="${escHtml(e.id)}: ${escHtml(e.concept)}">
              ${imgEl}
              ${e.isRejected ? `<div class="rejected-badge">rejected</div>` : ''}
              <div class="icon-actions">${rejectBtn}${unrejectBtn}</div>
            </div>`;
        })
        .join('');

      return `
        <tr class="batch-row" data-brief-id="${escHtml(b.briefId)}">
          <td class="batch-id">${escHtml(b.briefId)}</td>
          <td class="batch-cat">${escHtml(b.category)}</td>
          <td class="batch-total">${b.total}</td>
          <td class="batch-approved"><span class="${statusClass}">${statusLabel}</span></td>
          <td>
            <button class="btn btn-run" data-brief-id="${escHtml(b.briefId)}" onclick="dispatchRun('${escHtml(b.briefId)}')">Run</button>
          </td>
        </tr>
        <tr class="icons-row" id="icons-${escHtml(b.briefId)}" style="display:none">
          <td colspan="5">
            <div class="icon-grid">${iconCells}</div>
          </td>
        </tr>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Icon Batch Review</title>
  <style>
    :root {
      --bg: #1a1a2e;
      --surface: #16213e;
      --border: #0f3460;
      --accent: #e94560;
      --text: #eaeaea;
      --muted: #888;
      --done: #4caf50;
      --partial: #ff9800;
      --pending: #555;
      --running: #2196f3;
      --queued: #9c27b0;
      font-family: 'Courier New', monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--text); font-size: 13px; }
    header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 10px 14px; display: flex; align-items: center; gap: 12px; }
    header h1 { font-size: 15px; color: var(--accent); }
    header .summary { color: var(--muted); font-size: 12px; }
    .toolbar { padding: 8px 14px; display: flex; gap: 8px; border-bottom: 1px solid var(--border); background: var(--surface); }
    .btn { background: var(--border); color: var(--text); border: 1px solid var(--accent); padding: 4px 10px; cursor: pointer; font-size: 12px; font-family: inherit; }
    .btn:hover { background: var(--accent); color: #fff; }
    .btn-primary { background: var(--accent); color: #fff; }
    .btn-sm { padding: 2px 7px; font-size: 11px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 5px 10px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: middle; }
    th { background: var(--surface); color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; position: sticky; top: 0; z-index: 1; }
    tr.batch-row:hover { background: rgba(233,69,96,0.07); cursor: pointer; }
    .batch-id { font-weight: bold; color: var(--accent); }
    .batch-cat { color: var(--muted); }
    .status-done { color: var(--done); }
    .status-partial { color: var(--partial); }
    .status-pending { color: var(--pending); }
    .icon-grid { display: flex; flex-wrap: wrap; gap: 4px; padding: 8px 4px; }
    .icon-cell { position: relative; width: 52px; height: 52px; border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; overflow: hidden; flex-shrink: 0; }
    .icon-cell.approved { border-color: var(--done); }
    .icon-cell.rejected { border-color: var(--accent); opacity: 0.6; }
    .icon-cell img { width: 100%; height: 100%; image-rendering: pixelated; }
    .icon-placeholder { font-size: 8px; color: var(--pending); text-align: center; word-break: break-all; padding: 2px; }
    .icon-actions { position: absolute; top: 0; right: 0; display: none; flex-direction: column; gap: 1px; }
    .icon-cell:hover .icon-actions { display: flex; }
    .icon-btn { background: rgba(0,0,0,0.75); color: #fff; border: none; cursor: pointer; width: 18px; height: 18px; font-size: 10px; line-height: 18px; padding: 0; text-align: center; }
    .icon-btn-reject { background: rgba(233,69,96,0.9); }
    .icon-btn-unreject { background: rgba(76,175,80,0.9); }
    .rejected-badge { position: absolute; bottom: 0; left: 0; right: 0; background: rgba(233,69,96,0.82); color: #fff; font-size: 7px; text-align: center; text-transform: uppercase; letter-spacing: 0.04em; pointer-events: none; }
    #status-bar { padding: 5px 14px; background: var(--surface); color: var(--muted); font-size: 11px; border-top: 1px solid var(--border); position: fixed; bottom: 0; left: 0; right: 0; }
    .progress-bar { height: 4px; background: var(--border); margin-bottom: 4px; }
    .progress-fill { height: 100%; background: var(--done); transition: width 0.3s; }
    .scroll-area { overflow: auto; height: calc(100vh - 90px); }
    #runs-panel { padding: 0 14px 2px; }
    .runs-header { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; padding: 6px 0 3px; border-bottom: 1px solid var(--border); margin-bottom: 2px; }
    .run-item { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 12px; border-bottom: 1px solid rgba(15,52,96,0.5); }
    .run-item:last-child { border-bottom: none; }
    .run-badge { display: inline-block; padding: 1px 5px; font-size: 10px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.04em; min-width: 60px; text-align: center; }
    .run-in_progress { background: var(--running); color: #fff; }
    .run-queued, .run-waiting { background: var(--queued); color: #fff; }
    .run-success { background: var(--done); color: #fff; }
    .run-failure { background: var(--accent); color: #fff; }
    .run-cancelled, .run-skipped { background: var(--pending); color: #ccc; }
    .run-title { flex: 1; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .run-link { color: var(--accent); text-decoration: none; font-size: 11px; flex-shrink: 0; }
    .run-link:hover { text-decoration: underline; }
    .run-age { color: var(--muted); font-size: 11px; flex-shrink: 0; }
    .pulse { animation: pulse 1.5s ease-in-out infinite; }
    @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:0.4 } }
  </style>
</head>
<body>
  <header>
    <h1>🎨 Icon Batch Review</h1>
    <span class="summary">${totalApproved} / ${totalIcons} icons approved (${pct}%)</span>
  </header>
  <div class="toolbar">
    <button class="btn btn-primary" onclick="dispatchGenerateBriefs()">Generate Briefs</button>
    <button class="btn" onclick="dispatchRunAll()">Run All Pending</button>
    <button class="btn" onclick="refresh()">↺ Refresh</button>
  </div>
  <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
  <div id="runs-panel"></div>
  <div class="scroll-area">
    <table>
      <thead>
        <tr>
          <th>Batch ID</th>
          <th>Category</th>
          <th>Total</th>
          <th>Approved</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${batchRows || '<tr><td colspan="5" style="color:var(--muted);padding:20px">No briefs found. Click "Generate Briefs" to create them.</td></tr>'}
      </tbody>
    </table>
  </div>
  <div id="status-bar">Ready</div>
  <script>
    // ── Run helpers ──────────────────────────────────────────────────────────
    const INITIAL_RUNS = ${JSON.stringify(recentRuns).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')};

    function timeAgo(isoStr) {
      const secs = Math.floor((Date.now() - new Date(isoStr).getTime()) / 1000);
      if (secs < 60) return secs + 's ago';
      if (secs < 3600) return Math.floor(secs / 60) + 'm ago';
      return Math.floor(secs / 3600) + 'h ago';
    }

    function runBadgeClass(r) {
      if (r.conclusion === 'success') return 'run-success';
      if (r.conclusion === 'failure') return 'run-failure';
      if (r.conclusion === 'cancelled' || r.conclusion === 'skipped') return 'run-cancelled';
      if (r.status === 'in_progress') return 'run-in_progress';
      return 'run-queued';
    }

    function runItemHtml(r) {
      const cls = runBadgeClass(r);
      const isPulse = r.status === 'in_progress';
      const label = (r.conclusion || r.status || '').replace(/_/g, ' ');
      return '<div class="run-item">' +
        '<span class="run-badge ' + cls + (isPulse ? ' pulse' : '') + '">' + escHtml(label) + '</span>' +
        '<span class="run-title">' + escHtml(r.displayTitle) + '</span>' +
        '<span class="run-age">' + timeAgo(r.createdAt) + '</span>' +
        '<a class="run-link" href="https://github.com/nalfeo/Crawler/actions/runs/' + r.databaseId + '" target="_blank" rel="noreferrer">#' + r.databaseId + ' ↗</a>' +
        '</div>';
    }

    function renderRuns(runs) {
      const el = document.getElementById('runs-panel');
      if (!runs || !runs.length) { el.innerHTML = ''; return; }
      const active = runs.filter(function(r) { return ['in_progress','queued','waiting'].includes(r.status) && !r.conclusion; });
      const finished = runs.filter(function(r) { return !active.includes(r); });
      let html = '';
      if (active.length) html += '<div class="runs-header">⚡ Active (' + active.length + ')</div>' + active.map(runItemHtml).join('');
      if (finished.length) html += '<div class="runs-header">📋 Recent</div>' + finished.map(runItemHtml).join('');
      el.innerHTML = html;
    }

    function escHtml(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    let pollRunsInFlight = false;
    async function pollRuns() {
      if (pollRunsInFlight) return;
      pollRunsInFlight = true;
      try {
        const res = await fetch('/_runs');
        if (!res.ok) return;
        const data = await res.json();
        renderRuns(data.runs || []);
      } catch {} finally {
        pollRunsInFlight = false;
      }
    }

    renderRuns(INITIAL_RUNS);
    setInterval(pollRuns, 10000);

    // ── Batch table helpers ──────────────────────────────────────────────────
    function setStatus(msg) {
      document.getElementById('status-bar').textContent = msg;
    }

    async function post(action, body) {
      setStatus('Working...');
      try {
        const res = await fetch('/_action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, ...body }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);
        setStatus(data.message || 'Done');
        return data;
      } catch (err) {
        setStatus('Error: ' + err.message);
        throw err;
      }
    }

    function refresh() {
      setStatus('Refreshing...');
      location.reload();
    }

    function dispatchGenerateBriefs() {
      post('dispatch', { workflowAction: 'generate-briefs' })
        .then(() => setStatus('Dispatched generate-briefs workflow. Refresh in ~30s.'))
        .catch(() => {});
    }

    function dispatchRunAll() {
      post('dispatch', { workflowAction: 'run-all' })
        .then(() => setStatus('Dispatched run-all workflow. This may take several minutes.'))
        .catch(() => {});
    }

    function dispatchRun(briefId) {
      post('dispatch', { workflowAction: 'run', batchIds: briefId })
        .then(() => setStatus('Dispatched run for ' + briefId + '. Refresh when complete.'))
        .catch(() => {});
    }

    // ── Per-icon review ──────────────────────────────────────────────────────
    function rejectIcon(iconId, concept) {
      var feedback = window.prompt('Reject "' + concept + '"?\n\nOptional feedback (leave blank to skip):');
      if (feedback === null) return; // cancelled
      post('reject', { iconId: iconId, feedback: feedback.trim() })
        .then(function() { refresh(); })
        .catch(function() {});
    }

    function unrejectIcon(iconId) {
      post('unreject', { iconId: iconId })
        .then(function() { refresh(); })
        .catch(function() {});
    }

    // Toggle icon grid rows.
    document.querySelectorAll('tr.batch-row').forEach(function(row) {
      row.addEventListener('click', function(e) {
        if (e.target.classList.contains('btn') || e.target.classList.contains('icon-btn')) return;
        const briefId = row.dataset.briefId;
        const iconsRow = document.getElementById('icons-' + briefId);
        if (iconsRow) {
          iconsRow.style.display = iconsRow.style.display === 'none' ? '' : 'none';
        }
      });
    });
  </script>
</body>
</html>`;
}

/** Escape HTML special characters. */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
