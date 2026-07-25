function jsonForHtml(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

export function renderHtml(bootstrap) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Theme Equipment Review</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--background-color-default,#0d1117); color: var(--text-color-default,#f0f6fc); font: var(--text-body-medium,14px)/var(--leading-body-medium,20px) var(--font-sans,system-ui); }
    button, textarea { font: inherit; }
    button { border: 1px solid var(--border-color-default,#30363d); border-radius: 7px; padding: 6px 10px; background: var(--background-color-muted,#161b22); color: inherit; cursor: pointer; }
    button:hover { border-color: var(--color-focus-outline,#58a6ff); }
    button:disabled { opacity: .45; cursor: not-allowed; }
    header { position: sticky; top: 0; z-index: 4; padding: 16px 20px 0; background: var(--background-color-default,#0d1117); border-bottom: 1px solid var(--border-color-default,#30363d); }
    h1 { margin: 0; font-size: var(--text-title-large,24px); }
    .subtitle, .muted { color: var(--text-color-muted,#8b949e); }
    .metrics { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
    .pill { border: 1px solid var(--border-color-default,#30363d); border-radius: 999px; padding: 3px 9px; }
    .tabs { display: flex; gap: 4px; overflow-x: auto; }
    .tab { border-bottom: 3px solid transparent; border-radius: 6px 6px 0 0; white-space: nowrap; }
    .tab.active { border-bottom-color: var(--true-color-blue,#58a6ff); }
    main { padding: 18px 20px 40px; }
    .panel { border: 1px solid var(--border-color-default,#30363d); border-radius: 10px; padding: 14px; margin-bottom: 16px; background: var(--background-color-muted,#161b22); }
    .panel-head, .card-head, .controls { display: flex; gap: 8px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill,minmax(285px,1fr)); gap: 12px; }
    .card { border: 1px solid var(--border-color-default,#30363d); border-radius: 10px; padding: 12px; background: var(--background-color-default,#0d1117); }
    .card.approved { border-color: var(--true-color-green,#3fb950); }
    .card.rejected { border-color: var(--true-color-red,#f85149); }
    .badge { font-size: 12px; border-radius: 999px; padding: 2px 7px; background: var(--background-color-muted,#21262d); }
    .artifacts { display: grid; grid-template-columns: repeat(auto-fit,minmax(90px,1fr)); gap: 8px; margin: 10px 0; }
    .artifact { min-height: 90px; border: 1px solid var(--border-color-default,#30363d); border-radius: 7px; padding: 7px; overflow: hidden; }
    .artifact img { width: 100%; aspect-ratio: 1; object-fit: contain; image-rendering: pixelated; background: repeating-conic-gradient(#222 0 25%,#333 0 50%) 0/12px 12px; }
    .artifact pre { white-space: pre-wrap; max-height: 150px; overflow: auto; font: var(--text-code-inline,12px) var(--font-mono,monospace); }
    textarea { width: 100%; min-height: 54px; resize: vertical; margin: 8px 0; border: 1px solid var(--border-color-default,#30363d); border-radius: 7px; padding: 7px; background: var(--background-color-default,#0d1117); color: inherit; }
    .up.active { border-color: var(--true-color-green,#3fb950); }
    .down.active { border-color: var(--true-color-red,#f85149); }
    .error { color: var(--true-color-red,#f85149); white-space: pre-wrap; }
    .gate-list { margin: 8px 0 0; padding-left: 20px; }
    .spinner { padding: 40px; text-align: center; color: var(--text-color-muted,#8b949e); }
  </style>
</head>
<body>
  <div id="app" class="spinner">Loading durable theme-set state…</div>
  <script type="module">
    const bootstrap = ${jsonForHtml(bootstrap)};
    const apiHeaders = { 'X-Canvas-Token': bootstrap.token };
    let state = null;
    let selectedPhase = null;
    let busy = false;
    const app = document.querySelector('#app');
    const phases = ['roster','briefs','sprite-sheets','variant-approval','complete'];
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

    async function request(path, options = {}) {
      const response = await fetch(path, {
        ...options,
        headers: { ...apiHeaders, ...(options.body ? {'Content-Type':'application/json'} : {}), ...(options.headers || {}) },
      });
      const payload = await response.json().catch(() => ({ error: response.statusText }));
      if (!response.ok) throw new Error(payload.error || response.statusText);
      return payload;
    }

    async function load() {
      try {
        state = await request('/api/state');
        selectedPhase ??= state.phase === 'complete' ? 'variant-approval' : state.phase;
        render();
      } catch (error) {
        app.className = 'error';
        app.textContent = error.message + '\\n\\nIf this set lives in Azure, refresh .env.local with npm run setup:azure:env.';
      }
    }

    function reviewButtons(review, scope, id = '') {
      const disabled = busy || selectedPhase !== state.phase || state.phase === 'complete';
      return '<div class="controls">' +
        '<button class="up ' + (review.verdict === 'up' ? 'active' : '') + '" data-review="' + scope + '" data-id="' + esc(id) + '" data-verdict="up" ' + (disabled ? 'disabled' : '') + '>👍 Approve</button>' +
        '<button class="down ' + (review.verdict === 'down' ? 'active' : '') + '" data-review="' + scope + '" data-id="' + esc(id) + '" data-verdict="down" ' + (disabled ? 'disabled' : '') + '>👎 Reject</button>' +
        '<button data-review="' + scope + '" data-id="' + esc(id) + '" data-verdict="clear" ' + (disabled ? 'disabled' : '') + '>Clear</button>' +
      '</div>';
    }

    function artifactHtml(item, artifact) {
      const previewable = ['raw-sheet','approved-variant','selected-brief'].includes(artifact.kind);
      return '<div class="artifact">' +
        '<strong>' + esc(artifact.kind) + '</strong>' +
        (previewable ? '<div class="preview" data-item="' + esc(item.id) + '" data-artifact="' + esc(artifact.id) + '">Loading…</div>' : '') +
        (artifact.summary ? '<pre>' + esc(artifact.summary) + '</pre>' : '') +
      '</div>';
    }

    function itemCard(item) {
      const record = item.phases[selectedPhase];
      const review = record.review;
      const frozen = item.frozenPhases.includes(selectedPhase) || review.verdict === 'up';
      const descriptor = item.kind === 'weapon' ? item.weaponType : item.slots.join(', ');
      return '<article class="card ' + (review.verdict === 'up' ? 'approved' : review.verdict === 'down' ? 'rejected' : '') + '">' +
        '<div class="card-head"><div><strong>' + esc(item.displayName) + '</strong><div class="muted">' + esc(descriptor) + '</div></div>' +
        '<div><span class="badge">r' + item.revision + '</span> <span class="badge">' + (frozen ? 'frozen' : 'open') + '</span></div></div>' +
        '<div class="artifacts">' + (record.artifacts.length ? record.artifacts.map(a => artifactHtml(item,a)).join('') : '<span class="muted">No artifacts yet</span>') + '</div>' +
        (record.evidence.length ? '<details><summary>Evidence (' + record.evidence.length + ')</summary>' + record.evidence.map(e => '<pre>' + esc(e.summary || e.kind) + '</pre>').join('') + '</details>' : '') +
        '<textarea maxlength="2000" data-feedback="' + esc(item.id) + '" placeholder="Optional feedback for rejected-item iteration">' + esc(review.feedback || '') + '</textarea>' +
        reviewButtons(review, 'item', item.id) +
      '</article>';
    }

    function render() {
      const currentRecord = state.phase === 'complete' ? state.phases['variant-approval'] : state.phases[state.phase];
      const selectedRecord = selectedPhase === 'complete' ? null : state.phases[selectedPhase];
      app.className = '';
      app.innerHTML =
        '<header><h1>' + esc(state.displayName) + '</h1><div class="subtitle">' + esc(state.id) + ' · durable revision ' + state.stateRevision + '</div>' +
        '<div class="metrics"><span class="pill">Phase: ' + esc(state.phase) + '</span><span class="pill">Weapons ' + state.coverage.weaponTypeCount + '/5+</span><span class="pill">Slots ' + state.coverage.coveredSlotCount + '/11+</span><span class="pill">Publication ' + esc(state.publication.status) + '</span></div>' +
        '<nav class="tabs">' + phases.map(p => '<button class="tab ' + (p === selectedPhase ? 'active' : '') + '" data-phase="' + p + '">' + esc(p) + '</button>').join('') + '</nav></header>' +
        '<main>' +
        (selectedRecord ? '<section class="panel"><div class="panel-head"><div><strong>Collection cohesion</strong><div class="muted">' +
          (selectedRecord.collectionJudge ? 'Judge ' + selectedRecord.collectionJudge.score + '/5 · ' + esc(selectedRecord.collectionJudge.provenance) : 'Judge pending') +
          '</div></div></div>' +
          (selectedRecord.collectionJudge ? '<p>' + esc(selectedRecord.collectionJudge.rationale) + '</p>' : '') +
          (selectedPhase === state.phase ? '<textarea maxlength="2000" data-feedback="collection" placeholder="Optional whole-set feedback">' + esc(selectedRecord.humanReview.feedback || '') + '</textarea>' + reviewButtons(selectedRecord.humanReview,'collection') : '') +
        '</section>' : '') +
        '<section class="panel"><div class="panel-head"><div><strong>Phase controls</strong><div class="muted">Approved items remain frozen; rejected items alone regenerate.</div></div>' +
        '<div class="controls">' +
          (state.phase !== 'complete' ? '<button data-dispatch="run-phase" ' + (busy ? 'disabled' : '') + '>Run / rerun unresolved items on GitHub</button>' : '') +
          (state.phase !== 'complete' ? '<button data-advance ' + (!state.gate.canAdvance || busy ? 'disabled' : '') + '>Advance to ' + esc(state.gate.toPhase || 'next phase') + '</button>' : '') +
          (state.phase === 'complete' && state.publication.status === 'held' ? '<button data-dispatch="publish" ' + (busy ? 'disabled' : '') + '>Publish complete set atomically on GitHub</button>' : '') +
          '<button data-refresh ' + (busy ? 'disabled' : '') + '>Refresh</button></div></div>' +
          (!state.gate.canAdvance && state.gate.reasons.length ? '<ul class="gate-list">' + state.gate.reasons.map(r => '<li>' + esc(r.message) + '</li>').join('') + '</ul>' : '') +
        '</section>' +
        (selectedPhase === 'complete' ? '<section class="panel">The complete set is held until one atomic publication workflow succeeds.</section>' :
          '<section class="grid">' + state.items.map(itemCard).join('') + '</section>') +
        '</main>';
      wire();
      loadPreviews();
    }

    function wire() {
      document.querySelectorAll('[data-phase]').forEach(button => button.addEventListener('click', () => {
        selectedPhase = button.dataset.phase;
        render();
      }));
      document.querySelectorAll('[data-review]').forEach(button => button.addEventListener('click', async () => {
        const scope = button.dataset.review;
        const id = button.dataset.id;
        const verdict = button.dataset.verdict === 'clear' ? null : button.dataset.verdict;
        const feedbackEl = document.querySelector('[data-feedback="' + (scope === 'item' ? CSS.escape(id) : 'collection') + '"]');
        await mutate(scope === 'item' ? '/api/review-item' : '/api/review-set', {
          ...(scope === 'item' ? { itemId: id } : {}),
          review: { verdict, ...(feedbackEl?.value.trim() ? { feedback: feedbackEl.value.trim() } : {}) },
          expectedRevision: state.stateRevision,
        });
      }));
      document.querySelector('[data-advance]')?.addEventListener('click', () => mutate('/api/advance', { expectedRevision: state.stateRevision }));
      document.querySelector('[data-refresh]')?.addEventListener('click', load);
      document.querySelectorAll('[data-dispatch]').forEach(button => button.addEventListener('click', async () => {
        if (!confirm('Dispatch ' + button.dataset.dispatch + ' for ' + state.id + ' on GitHub?')) return;
        await mutate('/api/dispatch', { action: button.dataset.dispatch }, false);
        alert('Workflow dispatched. Refresh after the run completes.');
      }));
    }

    async function mutate(path, body, receivesState = true) {
      if (busy) return;
      busy = true;
      render();
      try {
        const result = await request(path, { method: 'POST', body: JSON.stringify(body) });
        if (receivesState) state = result;
      } catch (error) {
        alert(error.message);
        if (error.message.includes('revision-conflict')) await load();
      } finally {
        busy = false;
        render();
      }
    }

    async function loadPreviews() {
      for (const target of document.querySelectorAll('.preview')) {
        try {
          const url = '/api/artifact?itemId=' + encodeURIComponent(target.dataset.item) + '&artifactId=' + encodeURIComponent(target.dataset.artifact);
          const response = await fetch(url, { headers: apiHeaders });
          if (!response.ok) throw new Error(await response.text());
          const blob = await response.blob();
          if (blob.type.startsWith('image/')) {
            const image = document.createElement('img');
            image.alt = target.dataset.artifact;
            image.src = URL.createObjectURL(blob);
            target.replaceChildren(image);
          } else {
            const pre = document.createElement('pre');
            pre.textContent = await blob.text();
            target.replaceChildren(pre);
          }
        } catch (error) {
          target.textContent = 'Preview unavailable';
          target.title = error.message;
        }
      }
    }

    const events = new EventSource('/events?token=' + encodeURIComponent(bootstrap.token));
    events.onmessage = event => {
      const payload = JSON.parse(event.data);
      if (payload.type === 'state') { state = payload.state; render(); }
    };
    load();
  </script>
</body>
</html>`;
}
