/**
 * renderer.mjs — icon-batch-review canvas HTML renderer.
 *
 * Called server-side with the full state; returns a complete HTML document
 * string that the canvas harness serves to the iframe.
 */

/**
 * @param {{ batches: import('./lib/bridge.mjs').BatchSummary[], baseUrl: string }} state
 * @returns {string} HTML document
 */
export function renderHtml({ batches, baseUrl }) {
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
          const inner = e.isApproved
            ? `<img src="${imgSrc}" alt="${escHtml(e.concept)}" title="${escHtml(e.id)}" />`
            : `<div class="icon-placeholder" title="${escHtml(e.id)}">${escHtml(e.concept.slice(0, 8))}</div>`;
          return `<div class="icon-cell ${e.isApproved ? 'approved' : 'pending'}">${inner}</div>`;
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
    .icon-cell { width: 48px; height: 48px; border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; overflow: hidden; }
    .icon-cell.approved { border-color: var(--done); }
    .icon-cell img { width: 100%; height: 100%; image-rendering: pixelated; }
    .icon-placeholder { font-size: 8px; color: var(--pending); text-align: center; word-break: break-all; padding: 2px; }
    #status-bar { padding: 5px 14px; background: var(--surface); color: var(--muted); font-size: 11px; border-top: 1px solid var(--border); position: fixed; bottom: 0; left: 0; right: 0; }
    .progress-bar { height: 4px; background: var(--border); margin-bottom: 4px; }
    .progress-fill { height: 100%; background: var(--done); transition: width 0.3s; }
    .scroll-area { overflow: auto; height: calc(100vh - 90px); }
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

    // Toggle icon grid rows.
    document.querySelectorAll('tr.batch-row').forEach(function(row) {
      row.addEventListener('click', function(e) {
        if (e.target.classList.contains('btn')) return;
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
