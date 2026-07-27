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
    label { display: block; margin: 10px 0 0; font-weight: 600; }
    label .muted { font-weight: 400; }
    input[type=text] { font: inherit; width: 100%; margin: 4px 0 0; border: 1px solid var(--border-color-default,#30363d); border-radius: 7px; padding: 7px; background: var(--background-color-default,#0d1117); color: inherit; }
    .primary { border-color: var(--true-color-blue,#58a6ff); }
    .meter { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0; }
    .meter .pill.ok { border-color: var(--true-color-green,#3fb950); }
    .meter .pill.bad { border-color: var(--true-color-red,#f85149); }
    .roster { width: 100%; border-collapse: collapse; font-size: 13px; }
    .roster th, .roster td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--border-color-default,#30363d); vertical-align: top; }
    .json-editor { min-height: 260px; font: var(--text-code-inline,12px)/1.5 var(--font-mono,monospace); }
  </style>
</head>
<body>
  <div id="app" class="spinner">Loading durable theme-set state…</div>
  <script type="module">
    const bootstrap = ${jsonForHtml(bootstrap)};
    const apiHeaders = { 'X-Canvas-Token': bootstrap.token };
    let state = null;
    let index = null;
    let view = 'index';
    let currentSetId = bootstrap.setId ?? null;
    let draft = null;
    let selectedPhase = null;
    let busy = false;
    let dispatchNotice = null;
    const app = document.querySelector('#app');
    const phases = ['roster','briefs','sprite-sheets','variant-approval','complete'];
    const MIN_WEAPON_TYPES = 5;
    const MIN_SLOTS = 11;
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

    async function loadIndex() {
      app.className = 'spinner';
      app.textContent = 'Loading theme sets…';
      try {
        index = await request('/api/sets');
        currentSetId = index.currentSetId ?? currentSetId;
      } catch (error) {
        index = { sets: [], storeStatus: 'unavailable', storeError: error.message, planDir: 'data/theme-equipment-sets' };
      }
      view = 'index';
      renderIndex();
    }

    async function openSet(setId) {
      app.className = 'spinner';
      app.textContent = 'Loading ' + setId + '…';
      try {
        await request('/api/select', { method: 'POST', body: JSON.stringify({ setId }) });
        currentSetId = setId;
      } catch (error) {
        alert(error.message);
        return renderIndex();
      }
      await load();
    }

    async function load() {
      try {
        state = await request('/api/state');
        selectedPhase = state.phase === 'complete' ? 'variant-approval' : state.phase;
        view = 'board';
        render();
      } catch (error) {
        state = null;
        view = 'board';
        renderUninitialized(error.message);
      }
    }

    function stateBadge(entry) {
      const status = entry.state?.status ?? 'unknown';
      if (status === 'ready') return 'phase ' + esc(entry.state.phase) + ' · r' + entry.state.stateRevision;
      if (status === 'none') return 'not initialized';
      if (status === 'invalid') return 'state invalid';
      return 'state unknown';
    }

    function renderIndex() {
      app.className = '';
      const sets = index?.sets ?? [];
      app.innerHTML =
        '<header><h1>Theme equipment sets</h1>' +
        '<div class="subtitle">Authored plans live in ' + esc(index?.planDir ?? 'data/theme-equipment-sets') + '; durable state lives in the run store.</div>' +
        '<div class="controls" style="margin:12px 0"><button class="primary" data-create>+ New theme</button><button data-refresh-index>Refresh</button></div></header>' +
        '<main>' +
        (index?.storeStatus === 'unavailable'
          ? '<section class="panel"><p class="error">Run store unavailable: ' + esc(index.storeError || '') + '</p><p class="muted">Set-state badges below are unknown. Refresh credentials with npm run setup:azure:env if this set lives in Azure.</p></section>'
          : '') +
        (sets.length
          ? '<section class="grid">' + sets.map(setCard).join('') + '</section>'
          : '<section class="panel"><p class="muted">No authored theme sets yet. Create one to synthesize its roster.</p></section>') +
        '</main>';
      document.querySelector('[data-create]')?.addEventListener('click', () => {
        draft = { setId: '', displayName: '', themeDesignLanguage: '', notes: '', plan: null, planText: '', error: null, saved: null };
        view = 'create';
        renderCreate();
      });
      document.querySelector('[data-refresh-index]')?.addEventListener('click', loadIndex);
      document.querySelectorAll('[data-open]').forEach(button =>
        button.addEventListener('click', () => openSet(button.dataset.open)));
    }

    function setCard(entry) {
      const coverage = entry.planCoverage;
      return '<article class="card">' +
        '<div class="card-head"><div><strong>' + esc(entry.displayName) + '</strong><div class="muted">' + esc(entry.id) + '</div></div>' +
        '<span class="badge">' + stateBadge(entry) + '</span></div>' +
        (entry.plan.status === 'invalid' ? '<p class="error">Plan invalid: ' + esc(entry.plan.error || '') + '</p>' : '') +
        (entry.plan.status === 'missing' ? '<p class="muted">Durable state exists but no authored plan file is present.</p>' : '') +
        (coverage
          ? '<div class="metrics"><span class="pill">' + coverage.itemCount + ' items</span>' +
            '<span class="pill">' + coverage.weaponTypeCount + '/' + MIN_WEAPON_TYPES + '+ weapon types</span>' +
            '<span class="pill">' + coverage.coveredSlotCount + '/' + MIN_SLOTS + '+ slots</span></div>'
          : '') +
        '<div class="controls"><button data-open="' + esc(entry.id) + '">Open</button></div>' +
      '</article>';
    }

    function coverageOf(plan) {
      const weapons = Array.isArray(plan?.weapons) ? plan.weapons : [];
      const equipment = Array.isArray(plan?.equipment) ? plan.equipment : [];
      return {
        itemCount: weapons.length + equipment.length,
        weaponTypeCount: new Set(weapons.map(w => w?.weaponType).filter(Boolean)).size,
        coveredSlotCount: new Set(equipment.flatMap(e => Array.isArray(e?.slots) ? e.slots : []).filter(Boolean)).size,
      };
    }

    function renderCreate() {
      app.className = '';
      let parsed = null;
      let parseError = null;
      if (draft.planText.trim()) {
        try { parsed = JSON.parse(draft.planText); } catch (error) { parseError = error.message; }
      }
      const coverage = parsed ? coverageOf(parsed) : null;
      app.innerHTML =
        '<header><h1>New theme set</h1><div class="subtitle">The model proposes a roster; you review and edit it before it is written to the repo.</div>' +
        '<div class="controls" style="margin:12px 0"><button data-back>← All sets</button></div></header>' +
        '<main><section class="panel">' +
        '<label>Set id <span class="muted">lowercase-kebab, becomes the plan filename</span>' +
        '<input type="text" data-field="setId" value="' + esc(draft.setId) + '" placeholder="edo-samurai"></label>' +
        '<label>Display name<input type="text" data-field="displayName" value="' + esc(draft.displayName) + '" placeholder="Edo Samurai"></label>' +
        '<label>Theme design language <span class="muted">yours, never model-derived — drives every downstream art prompt (40+ chars)</span>' +
        '<textarea data-field="themeDesignLanguage" placeholder="Lacquered plate in deep indigo and oxblood, silk cord lacing, muted gold family crests, weathered steel with a soft satin sheen.">' + esc(draft.themeDesignLanguage) + '</textarea></label>' +
        '<label>Notes for the roster model <span class="muted">optional</span>' +
        '<textarea data-field="notes" placeholder="Favor polearms and paired blades; no firearms.">' + esc(draft.notes) + '</textarea></label>' +
        '<div class="controls"><button class="primary" data-synth ' + (busy ? 'disabled' : '') + '>' + (busy ? 'Synthesizing…' : 'Synthesize roster') + '</button></div>' +
        (draft.error ? '<p class="error">' + esc(draft.error) + '</p>' : '') +
        '</section>' +
        (draft.planText
          ? '<section class="panel"><div class="panel-head"><div><strong>Proposed roster</strong><div class="muted">Edit the JSON directly; coverage updates live and is re-validated server-side on save.</div></div></div>' +
            '<div class="meter">' +
            (parseError
              ? '<span class="pill bad">JSON invalid: ' + esc(parseError) + '</span>'
              : '<span class="pill">' + coverage.itemCount + ' items</span>' +
                '<span class="pill ' + (coverage.weaponTypeCount >= MIN_WEAPON_TYPES ? 'ok' : 'bad') + '">' + coverage.weaponTypeCount + ' / ' + MIN_WEAPON_TYPES + ' weapon types</span>' +
                '<span class="pill ' + (coverage.coveredSlotCount >= MIN_SLOTS ? 'ok' : 'bad') + '">' + coverage.coveredSlotCount + ' / ' + MIN_SLOTS + ' slots</span>') +
            '</div>' +
            (parsed ? rosterTable(parsed) : '') +
            '<textarea class="json-editor" data-plan-text>' + esc(draft.planText) + '</textarea>' +
            '<div class="controls"><button class="primary" data-save ' + (busy || parseError ? 'disabled' : '') + '>Save plan to repo</button>' +
            '<label style="display:flex;gap:6px;align-items:center;margin:0;font-weight:400"><input type="checkbox" data-overwrite> overwrite existing file</label></div>' +
            (draft.saved
              ? '<p class="muted">Wrote <strong>' + esc(draft.saved.planPath) + '</strong>. Commit and push it to this branch, then open the set and initialize it on GitHub — the workflow reads the plan from the pushed ref, not your working tree.</p>'
              : '') +
          '</section>'
          : '') +
        '</main>';
      wireCreate();
    }

    function rosterTable(plan) {
      const rows = [
        ...(Array.isArray(plan.weapons) ? plan.weapons : []).map(w => ({ id: w?.id, name: w?.displayName, kind: 'weapon', detail: w?.weaponType })),
        ...(Array.isArray(plan.equipment) ? plan.equipment : []).map(e => ({ id: e?.id, name: e?.displayName, kind: 'equipment', detail: Array.isArray(e?.slots) ? e.slots.join(', ') : '' })),
      ];
      if (!rows.length) return '';
      return '<details open><summary>' + rows.length + ' items</summary><table class="roster">' +
        '<thead><tr><th>Id</th><th>Name</th><th>Kind</th><th>Weapon type / slots</th></tr></thead><tbody>' +
        rows.map(r => '<tr><td>' + esc(r.id) + '</td><td>' + esc(r.name) + '</td><td>' + esc(r.kind) + '</td><td>' + esc(r.detail) + '</td></tr>').join('') +
        '</tbody></table></details>';
    }

    function wireCreate() {
      document.querySelector('[data-back]')?.addEventListener('click', loadIndex);
      document.querySelectorAll('[data-field]').forEach(input =>
        input.addEventListener('input', () => { draft[input.dataset.field] = input.value; }));
      const planEditor = document.querySelector('[data-plan-text]');
      let meterTimer = null;
      planEditor?.addEventListener('input', () => {
        draft.planText = planEditor.value;
        clearTimeout(meterTimer);
        meterTimer = setTimeout(() => { renderCreate(); }, 300);
      });
      planEditor?.addEventListener('change', () => { draft.planText = planEditor.value; renderCreate(); });
      document.querySelector('[data-synth]')?.addEventListener('click', synthRoster);
      document.querySelector('[data-save]')?.addEventListener('click', savePlan);
    }

    async function synthRoster() {
      if (busy) return;
      draft.error = null;
      draft.saved = null;
      busy = true;
      renderCreate();
      try {
        const result = await request('/api/synth-roster', {
          method: 'POST',
          body: JSON.stringify({
            setId: draft.setId.trim(),
            displayName: draft.displayName.trim(),
            themeDesignLanguage: draft.themeDesignLanguage.trim(),
            ...(draft.notes.trim() ? { notes: draft.notes.trim() } : {}),
          }),
        });
        draft.plan = result.plan;
        draft.planText = JSON.stringify(result.plan, null, 2);
      } catch (error) {
        draft.error = error.message;
      } finally {
        busy = false;
        renderCreate();
      }
    }

    async function savePlan() {
      if (busy) return;
      let plan;
      try {
        plan = JSON.parse(draft.planText);
      } catch (error) {
        draft.error = 'Roster JSON is invalid: ' + error.message;
        return renderCreate();
      }
      const overwrite = document.querySelector('[data-overwrite]')?.checked === true;
      draft.error = null;
      busy = true;
      renderCreate();
      try {
        draft.saved = await request('/api/save-plan', { method: 'POST', body: JSON.stringify({ plan, overwrite }) });
      } catch (error) {
        draft.error = error.message;
      } finally {
        busy = false;
        renderCreate();
      }
    }

    function renderUninitialized(message) {
      const missing = /was not found/.test(message);
      app.className = '';
      app.innerHTML =
        '<header><h1>' + esc(currentSetId) + '</h1>' +
        '<div class="subtitle">' + (missing ? 'No durable state yet' : 'State unavailable') + '</div>' +
        '<div class="controls" style="margin:12px 0"><button data-back>← All sets</button></div></header>' +
        '<main><section class="panel">' +
        (dispatchNotice
          ? '<p class="' + (dispatchNotice.tone === 'error' ? 'error' : 'muted') + '">' + esc(dispatchNotice.text) + '</p>'
          : '') +
        '<p class="error">' + esc(message) + '</p>' +
        (missing
          ? '<p class="muted">Initialize the durable set from its authored plan (data/theme-equipment-sets/' + esc(currentSetId) + '.json). The workflow reads the plan from the pushed branch, so commit and push it first.</p>' +
            '<div class="controls"><button data-dispatch="init" ' + (busy ? 'disabled' : '') + '>' + (busy ? 'Dispatching…' : 'Initialize set on GitHub') + '</button><button data-refresh ' + (busy ? 'disabled' : '') + '>Refresh</button></div>'
          : '<p class="muted">If this set lives in Azure, refresh .env.local with npm run setup:azure:env.</p>' +
            '<div class="controls"><button data-refresh>Refresh</button></div>') +
        '</section></main>';
      document.querySelector('[data-back]')?.addEventListener('click', () => { dispatchNotice = null; loadIndex(); });
      document.querySelector('[data-refresh]')?.addEventListener('click', load);
      document.querySelector('[data-dispatch]')?.addEventListener('click', async () => {
        if (busy) return;
        if (!confirm('Dispatch init for ' + currentSetId + ' on GitHub?')) return;
        // Dispatching takes several seconds (git rev-parse, fetch,
        // cat-file, then gh workflow run). Without a busy state the button
        // looks inert while it is working, which is exactly how a
        // successful init came across as doing nothing.
        const dispatchedSetId = currentSetId;
        // "← All sets" stays live during the dispatch, so a late result must
        // not repaint this pane over whatever the user navigated to. The
        // null-state term matters too: a still-running watch can push state
        // over SSE mid-dispatch, and render() has already drawn the board by
        // the time this resolves.
        const stillHere = () => view === 'board' && currentSetId === dispatchedSetId && state === null;
        busy = true;
        dispatchNotice = { tone: 'info', text: 'Dispatching init…' };
        renderUninitialized(message);
        let notice;
        try {
          const result = await request('/api/dispatch', { method: 'POST', body: JSON.stringify({ action: 'init' }) });
          notice = {
            tone: 'info',
            text: 'Initialization dispatched on ref ' + (result.ref || 'unknown') +
              '. The workflow runs on GitHub and takes a few minutes; this pane switches to the board on its own once the set exists.',
          };
        } catch (error) {
          notice = { tone: 'error', text: error.message };
        } finally {
          busy = false;
          if (stillHere()) {
            dispatchNotice = notice;
            renderUninitialized(message);
          } else {
            dispatchNotice = null;
          }
        }
      });
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

    const PHASE_NOUNS = {
      'roster': 'roster entries',
      'briefs': 'briefs',
      'sprite-sheets': 'sprite sheets',
      'variant-approval': 'variant sets',
    };

    /**
     * What a run-phase dispatch would actually do right now, for the CURRENT
     * phase (run-phase always targets state.phase, never the tab the user is
     * browsing).
     *
     * This MIRRORS isThemeSetItemResolvedForPhase in
     * scripts/sprites/theme-equipment-set.ts: the runner regenerates every item
     * that is not frozen and not up-reviewed — including an item that already
     * has artifacts but has not been reviewed yet. Counting only artifact-less
     * items would understate the work and tell the user "re-judge only" right
     * before a click regenerated all 18 briefs.
     */
    function runPhaseWork() {
      const phase = state.phase;
      let unresolved = 0;
      let rejected = 0;
      let withArtifacts = 0;
      for (const item of state.items) {
        const record = item.phases[phase];
        if (!record) continue;
        if (item.revisionStatus === 'frozen' || item.frozenPhases.includes(phase) || record.review.verdict === 'up') continue;
        unresolved++;
        if (record.review.verdict === 'down') rejected++;
        if (record.artifacts.length) withArtifacts++;
      }
      return { unresolved, rejected, withArtifacts, noun: PHASE_NOUNS[phase] || 'items' };
    }

    function runPhaseLabel() {
      if (busy) return 'Dispatching…';
      const work = runPhaseWork();
      // A zero-item run is still meaningful: run-phase always re-judges
      // collection cohesion at the end.
      if (!work.unresolved) return 'Re-judge collection cohesion on GitHub';
      const verb = work.withArtifacts ? 'Regenerate' : 'Generate';
      const detail = work.rejected && work.rejected < work.unresolved ? ' (' + work.rejected + ' rejected)' : '';
      return verb + ' ' + work.unresolved + ' ' + work.noun + ' on GitHub' + detail;
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
        '<div class="metrics"><span class="pill">Phase: ' + esc(state.phase) + '</span><span class="pill">Weapons ' + state.coverage.weaponTypeCount + '/' + MIN_WEAPON_TYPES + '+</span><span class="pill">Slots ' + state.coverage.coveredSlotCount + '/' + MIN_SLOTS + '+</span><span class="pill">Publication ' + esc(state.publication.status) + '</span>' +
        '<button data-back>← All sets</button></div>' +
        '<nav class="tabs">' + phases.map(p => '<button class="tab ' + (p === selectedPhase ? 'active' : '') + '" data-phase="' + p + '">' + esc(p) + '</button>').join('') + '</nav></header>' +
        '<main>' +
        (selectedRecord ? '<section class="panel"><div class="panel-head"><div><strong>Collection cohesion</strong><div class="muted">' +
          (selectedRecord.collectionJudge ? 'Judge ' + selectedRecord.collectionJudge.score + '/5 · ' + esc(selectedRecord.collectionJudge.provenance) : 'Judge pending') +
          '</div></div></div>' +
          (selectedRecord.collectionJudge ? '<p>' + esc(selectedRecord.collectionJudge.rationale) + '</p>' : '') +
          (selectedPhase === state.phase ? '<textarea maxlength="2000" data-feedback="collection" placeholder="Optional whole-set feedback">' + esc(selectedRecord.humanReview.feedback || '') + '</textarea>' + reviewButtons(selectedRecord.humanReview,'collection') : '') +
        '</section>' : '') +
        '<section class="panel"><div class="panel-head"><div><strong>Phase controls</strong><div class="muted">Up-reviewed and frozen items are skipped; every other item regenerates. Run generates artifacts on GitHub (minutes); Advance only moves the phase pointer once the gate is open.</div></div>' +
        '<div class="controls">' +
          (state.phase !== 'complete' ? '<button data-dispatch="run-phase" ' + (busy ? 'disabled' : '') + '>' + esc(runPhaseLabel()) + '</button>' : '') +
          (state.phase !== 'complete' ? '<button data-advance ' + (!state.gate.canAdvance || busy ? 'disabled' : '') + '>Advance to ' + esc(state.gate.toPhase || 'next phase') + '</button>' : '') +
          (state.phase === 'complete' && state.publication.status === 'held' ? '<button data-dispatch="publish" ' + (busy ? 'disabled' : '') + '>' + (busy ? 'Dispatching…' : 'Publish complete set atomically on GitHub') + '</button>' : '') +
          '<button data-refresh ' + (busy ? 'disabled' : '') + '>Refresh</button></div></div>' +
          (dispatchNotice ? '<p class="' + (dispatchNotice.tone === 'error' ? 'error' : 'muted') + '">' + esc(dispatchNotice.text) + '</p>' : '') +
          (!state.gate.canAdvance && state.gate.reasons.length ? '<ul class="gate-list">' + state.gate.reasons.map(r => '<li>' + esc(r.message) + '</li>').join('') + '</ul>' : '') +
        '</section>' +
        (selectedPhase === 'complete' ? '<section class="panel">The complete set is held until one atomic publication workflow succeeds.</section>' :
          '<section class="grid">' + state.items.map(itemCard).join('') + '</section>') +
        '</main>';
      wire();
      loadPreviews();
    }

    function wire() {
      document.querySelector('[data-back]')?.addEventListener('click', () => { dispatchNotice = null; loadIndex(); });
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
        if (busy) return;
        const action = button.dataset.dispatch;
        const dispatchedSetId = state.id;
        // A dispatch takes several seconds (git rev-parse, fetch, cat-file,
        // then gh workflow run) and the workflow itself runs for minutes.
        // Without an inline busy state + notice the button looks inert, which
        // is exactly how a successful run came across as doing nothing.
        const stillHere = () => view === 'board' && state !== null && state.id === dispatchedSetId;
        busy = true;
        dispatchNotice = { tone: 'info', text: 'Dispatching ' + action + '…' };
        render();
        let notice;
        try {
          const result = await request('/api/dispatch', { method: 'POST', body: JSON.stringify({ action }) });
          notice = {
            tone: 'info',
            text: action + ' dispatched on ref ' + (result.ref || 'unknown') +
              '. The workflow runs on GitHub and takes a few minutes; this pane updates on its own as the durable revision advances.',
          };
        } catch (error) {
          notice = { tone: 'error', text: error.message };
        } finally {
          busy = false;
          // Only repaint the pane we started from. "← All sets" stays live
          // during the dispatch, so a late result must not paint the board
          // over the index the user navigated to — and render() dereferences
          // state, which is null on an uninitialized set.
          if (stillHere()) {
            dispatchNotice = notice;
            render();
          } else {
            dispatchNotice = null;
          }
        }
      }));
    }

    async function mutate(path, body, receivesState = true) {
      if (busy) return null;
      busy = true;
      render();
      try {
        const result = await request(path, { method: 'POST', body: JSON.stringify(body) });
        if (receivesState) state = result;
        return result;
      } catch (error) {
        alert(error.message);
        if (error.message.includes('revision-conflict')) await load();
        return null;
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
      if (payload.type === 'state' && view === 'board' && payload.state?.id === currentSetId) {
        state = payload.state;
        selectedPhase ??= state.phase === 'complete' ? 'variant-approval' : state.phase;
        render();
      }
    };
    if (currentSetId) load(); else loadIndex();
  </script>
</body>
</html>`;
}
