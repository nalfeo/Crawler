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
    .brief-edit { min-height: 220px; font: var(--text-code-inline,12px)/1.5 var(--font-mono,monospace); white-space: pre; overflow-wrap: normal; overflow-x: auto; }
    .brief-error { color: var(--true-color-red,#f85149); white-space: pre-wrap; font-size: 12px; margin: 4px 0 0; }
    .bulk-skips { margin: 8px 0 0; font-size: 13px; }
    .bulk-skips ul { margin: 4px 0 0; padding-left: 20px; color: var(--text-color-muted,#8b949e); }
    .gate-list { margin: 8px 0 0; padding-left: 20px; }
    .judge-hint { margin: 8px 0 0; padding: 8px 10px; font-size: 13px; border-radius: 6px; background: rgba(210,153,34,0.12); border: 1px solid rgba(210,153,34,0.4); }
    .awaiting-note { margin: 6px 0 0; padding: 6px 8px; font-size: 12px; border-radius: 6px; color: var(--text-color-muted,#8b949e); background: rgba(139,148,158,0.1); border: 1px dashed rgba(139,148,158,0.35); }
    .run-status { margin: 8px 0 0; font-size: 12.5px; line-height: 1.5; }
    .run-status .run-active { color: var(--true-color-blue,#58a6ff); font-weight: 600; }
    .run-status .run-progress-detail { margin-top: 3px; font-size: 12px; }
    .run-lock-note { margin: 8px 0 0; padding: 8px 10px; font-size: 13px; border-radius: 6px; background: rgba(88,166,255,0.12); border: 1px solid rgba(88,166,255,0.4); }
    .filter-bar { display: flex; align-items: center; gap: 6px; margin: 0 0 10px; font-size: 13px; }
    .filter-bar label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
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
    let lastBulkResult = null;
    /** Per-item draft text keyed by item id; survives re-renders. */
    const draftBriefs = new Map();
    /**
     * In-progress feedback text keyed by item id (or 'collection'); survives
     * re-renders so reviewing one item never wipes another item's unsaved
     * comment or jumps the scroll (Change 10).
     */
    const draftFeedback = new Map();
    const BULK_NOUNS = { roster: 'items', briefs: 'briefs', 'sprite-sheets': 'sheets', 'variant-approval': 'items' };
    const ITEM_NOUN = { roster: 'item', briefs: 'brief', 'sprite-sheets': 'sprite sheet', 'variant-approval': 'approved variant' };
    // Truthful Run-button label, derived from the SAME server plan (state.runPhase,
    // computed via planRunPhase) that describes the work a run-phase dispatch does:
    // a run (re)generates every unresolved item and always judges the collection once.
    // A never-generated item is "generated"; an unresolved item that already has
    // output is "regenerated"; when nothing is unresolved it only produces the judge —
    // so the label must say "judge", not "regenerate 0", or it lies about the work.
    function runPhaseLabel(plan, phase) {
      if (!plan || plan.phase === null) return 'Run / rerun unresolved items on GitHub';
      const noun = BULK_NOUNS[phase] || 'items';
      const gen = plan.generateCount || 0;
      const regen = plan.regenerateCount || 0;
      if (gen > 0 && regen > 0) {
        return 'Generate ' + gen + ' + regenerate ' + regen + ' ' + noun + ' + judge on GitHub';
      }
      if (gen > 0) {
        return 'Generate ' + gen + ' ' + noun + ' + judge on GitHub';
      }
      if (regen > 0) {
        return 'Regenerate ' + regen + ' unresolved ' + noun + ' + judge on GitHub';
      }
      return plan.collectionJudgeMissing ? 'Judge collection cohesion on GitHub' : 'Re-judge collection cohesion on GitHub';
    }
    // Change 14 (A): honest in-flight detail for an ACTIVE run. Derived from the
    // SAME server plan (state.runPhase) as the Run label, so the item count it
    // shows is exactly the work the active run is doing. run-phase writes durable
    // state atomically at the very end, so the board cannot flip items one-by-one
    // while a run is mid-flight; this line says so and points at the GitHub log,
    // which is the only place per-item progress streams in real time.
    function runActiveDetail(plan, phase) {
      const noun = (plan && plan.phase !== null) ? (BULK_NOUNS[phase] || 'items') : 'items';
      const total = plan ? ((plan.generateCount || 0) + (plan.regenerateCount || 0)) : 0;
      const work = total > 0
        ? 'Working through ' + total + ' ' + noun + ' + the collection judge'
        : 'Producing the collection judge (regenerating nothing)';
      return work + '. Results appear together when the run finishes — items will not flip one at a time. Watch the GitHub log for live per-item progress.';
    }
    let dispatchNotice = null;
    /**
     * Latest GitHub run-status for this set, fetched from /api/run-status and
     * refreshed on a poll so the maintainer can see a dispatched run progress
     * without leaving the board. null = not fetched yet. Shapes:
     *   { available:true, run:{status,conclusion,url,createdAt,displayTitle}|null, ref }
     *   { available:false, errorKind }
     */
    let runStatus = null;
    let runStatusInFlight = false;
    let runStatusTimer = null;
    let runStatusToken = 0;

    // A run is "active" (in flight) when GitHub reports a run for this set whose
    // status is not 'completed'. While active, every durable-state MUTATION on
    // the board is locked (see render()): the runner reads state at revision R,
    // does ~30 min of paid vision work, then commits ONE atomic CAS save at the
    // end. A verdict/bulk/advance/brief mutation in that window either bumps
    // stateRevision and makes the runner's final save fail (all paid work
    // discarded) or silently overwrites the maintainer's change — both are
    // data-loss footguns. Mirrors runStatusStrip()'s own active predicate.
    function isRunActive() {
      return !!(runStatus && runStatus.run && runStatus.run.status && runStatus.run.status !== 'completed');
    }
    // Change 11: remember the last GitHub run we observed (by databaseId) so we
    // can auto-refresh the board once when it transitions active → completed,
    // instead of making the maintainer click Refresh. autoReloadedRunId guards
    // against re-triggering on the same completed run.
    let lastRunSeen = null;
    let autoReloadedRunId = null;
    // Change 12: when on, hide items already approved (verdict === 'up') so the
    // maintainer sees only what still needs a decision.
    let showOnlyUnapproved = false;
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
      stopRunStatusPoll();
      // Leaving a set: drop its per-item feedback/brief drafts so they can never
      // bleed into a different set opened later (drafts are keyed by item id, not
      // by set id). Refresh/re-render within a set does NOT clear — that is what
      // preserves an in-progress comment (Change 10).
      draftFeedback.clear();
      draftBriefs.clear();
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
      // Switching to a different set: clear drafts keyed by item id so one set's
      // unsent feedback/brief text cannot appear in another set.
      draftFeedback.clear();
      draftBriefs.clear();
      // Change 11/12: run-transition memory and the unapproved filter are
      // per-set; clear them so state from a previous set cannot leak in.
      lastRunSeen = null;
      autoReloadedRunId = null;
      showOnlyUnapproved = false;
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
        runStatus = null;
        stopRunStatusPoll();
        state = await request('/api/state');
        selectedPhase = state.phase === 'complete' ? 'variant-approval' : state.phase;
        lastBulkResult = null;
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
      const disabled = busy || isRunActive() || selectedPhase !== state.phase || state.phase === 'complete';
      return '<div class="controls">' +
        '<button class="up ' + (review.verdict === 'up' ? 'active' : '') + '" data-review="' + scope + '" data-id="' + esc(id) + '" data-verdict="up" ' + (disabled ? 'disabled' : '') + '>👍 Approve</button>' +
        '<button class="down ' + (review.verdict === 'down' ? 'active' : '') + '" data-review="' + scope + '" data-id="' + esc(id) + '" data-verdict="down" ' + (disabled ? 'disabled' : '') + '>👎 Reject</button>' +
        '<button data-review="' + scope + '" data-id="' + esc(id) + '" data-verdict="clear" ' + (disabled ? 'disabled' : '') + '>Clear</button>' +
      '</div>';
    }

    function artifactHtml(item, artifact) {
      if (artifact.kind === 'selected-brief' && selectedPhase === 'briefs' && selectedPhase === state.phase) {
        return '<div class="artifact">' +
          '<strong>' + esc(artifact.kind) + '</strong>' +
          '<textarea class="brief-edit" spellcheck="false" data-brief-item="' + esc(item.id) + '" data-artifact="' + esc(artifact.id) + '" readonly>Loading…</textarea>' +
          '<div class="brief-error" data-brief-error="' + esc(item.id) + '"></div>' +
          (artifact.summary ? '<pre>' + esc(artifact.summary) + '</pre>' : '') +
        '</div>';
      }
      const previewable = ['raw-sheet','approved-variant','selected-brief'].includes(artifact.kind);
      return '<div class="artifact">' +
        '<strong>' + esc(artifact.kind) + '</strong>' +
        (previewable ? '<div class="preview" data-item="' + esc(item.id) + '" data-artifact="' + esc(artifact.id) + '">Loading…</div>' : '') +
        (artifact.summary ? '<pre>' + esc(artifact.summary) + '</pre>' : '') +
      '</div>';
    }

    function feedbackKey(scope, id, phase = selectedPhase) {
      // Namespace drafts by phase and scope. That preserves drafts during
      // same-phase rerenders, while preventing cross-phase bleed (e.g. briefs
      // text appearing in sprite-sheets). Item drafts stay under "item:" so an
      // item whose id is literally "collection" cannot collide with the
      // set-level textarea.
      return scope === 'item' ? phase + ':item:' + id : phase + ':collection';
    }

    function feedbackValue(key, serverValue) {
      return draftFeedback.has(key) ? draftFeedback.get(key) : (serverValue || '');
    }

    function itemPhaseVerdict(item) {
      const record = item.phases[selectedPhase];
      return record && record.review ? record.review.verdict : null;
    }

    function itemCard(item) {
      const record = item.phases[selectedPhase];
      const review = record.review;
      const frozen = item.frozenPhases.includes(selectedPhase) || review.verdict === 'up';
      const descriptor = item.kind === 'weapon' ? item.weaponType : item.slots.join(', ');
      const activeTab = selectedPhase === state.phase;
      const awaits = activeTab && state.reviewStatus && state.reviewStatus[item.id] && state.reviewStatus[item.id].awaitsGeneration === true;
      const controls = awaits
        ? '<div class="awaiting-note">⏳ Awaiting generation — nothing to review yet. Click <strong>Run</strong> above to create this ' + esc(ITEM_NOUN[selectedPhase] || 'item') + '.</div>'
        : '<textarea maxlength="2000" data-feedback="' + esc(feedbackKey('item', item.id)) + '" placeholder="Optional feedback for rejected-item iteration">' + esc(feedbackValue(feedbackKey('item', item.id), review.feedback)) + '</textarea>' +
          reviewButtons(review, 'item', item.id);
      return '<article class="card ' + (review.verdict === 'up' ? 'approved' : review.verdict === 'down' ? 'rejected' : '') + '">' +
        '<div class="card-head"><div><strong>' + esc(item.displayName) + '</strong><div class="muted">' + esc(descriptor) + '</div></div>' +
        '<div><span class="badge">r' + item.revision + '</span> <span class="badge">' + (frozen ? 'frozen' : 'open') + '</span></div></div>' +
        '<div class="artifacts">' + (record.artifacts.length ? record.artifacts.map(a => artifactHtml(item,a)).join('') : '<span class="muted">No artifacts yet</span>') + '</div>' +
        (record.evidence.length ? '<details><summary>Evidence (' + record.evidence.length + ')</summary>' + record.evidence.map(e => '<pre>' + esc(e.summary || e.kind) + '</pre>').join('') + '</details>' : '') +
        controls +
      '</article>';
    }

    function render() {
      const restoreInteraction = captureInteraction();
      const currentRecord = state.phase === 'complete' ? state.phases['variant-approval'] : state.phases[state.phase];
      const selectedRecord = selectedPhase === 'complete' ? null : state.phases[selectedPhase];
      app.className = '';
      app.innerHTML =
        '<header><h1>' + esc(state.displayName) + '</h1><div class="subtitle">' + esc(state.id) + ' · durable revision ' + state.stateRevision + '</div>' +
        '<div class="metrics"><span class="pill">Phase: ' + esc(state.phase) + '</span><span class="pill">Weapons ' + state.coverage.weaponTypeCount + '/' + MIN_WEAPON_TYPES + '+</span><span class="pill">Slots ' + state.coverage.coveredSlotCount + '/' + MIN_SLOTS + '+</span><span class="pill">Publication ' + esc(state.publication.status) + '</span>' +
        '<button data-back>← All sets</button><button data-refresh ' + (busy ? 'disabled' : '') + '>Refresh</button></div>' +
        '<nav class="tabs">' + phases.map(p => '<button class="tab ' + (p === selectedPhase ? 'active' : '') + '" data-phase="' + p + '">' + esc(p) + '</button>').join('') + '</nav></header>' +
        '<main>' +
        (selectedRecord ? '<section class="panel"><div class="panel-head"><div><strong>Collection cohesion</strong><div class="muted">' +
          (selectedRecord.collectionJudge ? 'Judge ' + selectedRecord.collectionJudge.score + '/5 · ' + esc(selectedRecord.collectionJudge.provenance) : 'Judge pending') +
          '</div></div></div>' +
          (selectedRecord.collectionJudge ? '<p>' + esc(selectedRecord.collectionJudge.rationale) + '</p>' : '') +
          (selectedPhase === state.phase ? '<textarea maxlength="2000" data-feedback="' + esc(feedbackKey('collection')) + '" placeholder="Optional whole-set feedback">' + esc(feedbackValue(feedbackKey('collection'), selectedRecord.humanReview.feedback)) + '</textarea>' + reviewButtons(selectedRecord.humanReview,'collection') : '') +
        '</section>' : '') +
        (selectedPhase === state.phase ?
        '<section class="panel"><div class="panel-head"><div><strong>Phase controls</strong><div class="muted">Approved items remain frozen; rejected items alone regenerate.</div></div>' +
        '<div class="controls">' +
          (state.phase !== 'complete' ? '<button data-dispatch="run-phase" ' + (busy ? 'disabled' : '') + '>' + esc(runPhaseLabel(state.runPhase, state.phase)) + '</button>' : '') +
          (state.phase !== 'complete' && state.bulkApprove && state.bulkApprove.count > 0 ? '<button class="primary" data-approve-remaining ' + (busy || isRunActive() ? 'disabled' : '') + '>Approve remaining ' + state.bulkApprove.count + ' ' + esc(BULK_NOUNS[state.phase] || 'items') + '</button>' : '') +
          (state.phase !== 'complete' ? '<button data-advance ' + (!state.gate.canAdvance || busy || isRunActive() ? 'disabled' : '') + '>Advance to ' + esc(state.gate.toPhase || 'next phase') + '</button>' : '') +
          (state.phase === 'complete' && state.publication.status === 'held' ? '<button data-dispatch="publish" ' + (busy ? 'disabled' : '') + '>Publish complete set atomically on GitHub</button>' : '') +
          '</div></div>' +
          '<div class="run-status" id="run-status-strip" role="status" aria-live="polite" aria-atomic="true">' + runStatusStrip() + '</div>' +
          (isRunActive() ? '<div class="run-lock-note">🔒 Review controls are locked while a run is in flight — changing a verdict, bulk-approving, or advancing now would be discarded when the run writes its results. They unlock automatically when the run finishes.</div>' : '') +
          (state.phase !== 'complete' && state.runPhase && state.runPhase.judgeOnly && state.runPhase.collectionJudgeMissing ? '<div class="judge-hint">Every item in this phase is approved, but the collection judge is missing — Advance stays locked until it lands. Click <strong>' + esc(runPhaseLabel(state.runPhase, state.phase)) + '</strong> to generate it (it regenerates nothing).</div>' : '') +
          (lastBulkResult && lastBulkResult.skipped && lastBulkResult.skipped.length ? '<div class="bulk-skips"><strong>Skipped ' + lastBulkResult.skipped.length + ':</strong><ul>' + lastBulkResult.skipped.map(s => '<li>' + esc(s.reason) + '</li>').join('') + '</ul></div>' : '') +
          (dispatchNotice ? '<p class="' + (dispatchNotice.tone === 'error' ? 'error' : 'muted') + '">' + esc(dispatchNotice.text) + '</p>' : '') +
          (!state.gate.canAdvance && state.gate.reasons.length ? '<ul class="gate-list">' + state.gate.reasons.map(r => '<li>' + esc(r.message) + '</li>').join('') + '</ul>' : '') +
        '</section>'
        : (selectedPhase !== 'complete' ? '<section class="panel"><div class="muted">Advancement controls for the active phase (<strong>' + esc(state.phase) + '</strong>) live on its own tab. This tab is ' + (phases.indexOf(selectedPhase) < phases.indexOf(state.phase) ? 'an earlier, completed phase' : 'a later phase, not yet active') + ' — review-only.</div></section>' : '')) +
        (selectedPhase === 'complete' ? '<section class="panel">The complete set is held until one atomic publication workflow succeeds.</section>' :
          gridSection()) +
        '</main>';
      wire();
      restoreInteraction();
      loadPreviews();
      ensureRunStatusPoll();
    }

    /**
     * Change 12: the item grid, with an optional "show only unapproved" filter.
     * The filter predicate (verdict !== 'up') and the label count are derived
     * from the SAME computation, so the label can never lie about what it hides
     * (the truthful-label discipline that Change 4 established for bulk approve).
     */
    function gridSection() {
      const approvedCount = state.items.filter(i => itemPhaseVerdict(i) === 'up').length;
      const shown = showOnlyUnapproved
        ? state.items.filter(i => itemPhaseVerdict(i) !== 'up')
        : state.items;
      const toggle = '<div class="filter-bar"><label><input type="checkbox" data-filter-unapproved ' +
        (showOnlyUnapproved ? 'checked' : '') + (approvedCount === 0 ? ' disabled' : '') +
        '> Show only unapproved</label><span class="muted"> (' + approvedCount + ' approved' +
        (showOnlyUnapproved ? ' hidden' : '') + ')</span></div>';
      const grid = shown.length
        ? '<section class="grid">' + shown.map(itemCard).join('') + '</section>'
        : '<section class="panel"><div class="muted">All items are approved for this phase — nothing left to review here.</div></section>';
      return toggle + grid;
    }

    /**
     * Capture the volatile interaction state we want to preserve rather than
     * otherwise destroy — scroll offset and the caret in whatever textarea the
     * maintainer is typing in — and return a restore fn to reapply them after the
     * DOM is rebuilt. This is what keeps reviewing one item (or an SSE/poll push)
     * from scroll-jumping or wiping an in-progress comment in another card. Draft
     * TEXT itself is preserved separately via the draftFeedback/draftBriefs Maps.
     */
    function captureInteraction() {
      const scroller = document.scrollingElement || document.documentElement;
      const scrollTop = scroller ? scroller.scrollTop : 0;
      const active = document.activeElement;
      let focus = null;
      if (active && active.tagName === 'TEXTAREA') {
        let selector = null;
        if (active.dataset.feedback) {
          selector = '[data-feedback="' + CSS.escape(active.dataset.feedback) + '"]';
        } else if (active.dataset.briefItem) {
          selector = '.brief-edit[data-brief-item="' + CSS.escape(active.dataset.briefItem) + '"]';
        }
        if (selector) focus = { selector, start: active.selectionStart, end: active.selectionEnd };
      }
      return () => {
        if (scroller) scroller.scrollTop = scrollTop;
        if (!focus) return;
        const el = document.querySelector(focus.selector);
        if (!el) return;
        el.focus();
        try { el.setSelectionRange(focus.start, focus.end); } catch (_) { /* non-text input */ }
      };
    }

    function formatWhen(iso) {
      const t = Date.parse(iso);
      if (Number.isNaN(t)) return String(iso);
      const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
      if (secs < 60) return secs + 's ago';
      const mins = Math.round(secs / 60);
      if (mins < 60) return mins + 'm ago';
      return Math.round(mins / 60) + 'h ago';
    }

    // Inner HTML for the run-status strip, derived from runStatus (fetched from
    // /api/run-status). Distinguishes "no run found" from "status unavailable" so
    // the maintainer can tell a quiet pipeline from a broken gh/auth path.
    function runStatusStrip() {
      if (runStatus === null) return '<span class="muted">Checking GitHub for recent runs…</span>';
      if (runStatus.available === false) {
        return '<span class="muted">Run status unavailable' + (runStatus.errorKind ? ' (' + esc(runStatus.errorKind) + ')' : '') + '. The board still updates live as the durable revision advances.</span>';
      }
      if (!runStatus.run) {
        return '<span class="muted">No recent GitHub run for this set' + (runStatus.ref ? ' on ' + esc(runStatus.ref) : '') + ' yet.</span>';
      }
      const run = runStatus.run;
      const active = run.status !== 'completed';
      const label = active
        ? '▶ ' + esc(run.status === 'queued' ? 'queued (waiting for a runner)' : (run.status || 'in progress')) + (run.status === 'queued' ? '' : '…')
        : (run.conclusion === 'success' ? '✅ last run succeeded' : '⚠️ last run ' + esc(run.conclusion || 'finished'));
      const when = run.createdAt ? ' · started ' + esc(formatWhen(run.createdAt)) : '';
      const linkText = active ? 'watch live log ↗' : 'view on GitHub ↗';
      const link = run.url ? ' · <a href="' + esc(run.url) + '" target="_blank" rel="noreferrer">' + linkText + '</a>' : '';
      const head = '<span class="' + (active ? 'run-active' : '') + '">' + label + '</span><span class="muted">' + when + '</span>' + link;
      if (!active) return head;
      const detail = state ? runActiveDetail(state.runPhase, state.phase) : '';
      return head + (detail ? '<div class="run-progress-detail muted">' + esc(detail) + '</div>' : '');
    }

    function patchRunStatusStrip() {
      const node = document.getElementById('run-status-strip');
      if (node) node.innerHTML = runStatusStrip();
    }

    function stopRunStatusPoll() {
      if (runStatusTimer) { clearInterval(runStatusTimer); runStatusTimer = null; }
    }

    // Poll run-status only while its strip is on-screen (active, non-complete
    // phase tab). Starting is idempotent; the interval self-stops when the strip
    // leaves the DOM or the board is closed.
    function ensureRunStatusPoll() {
      if (!document.getElementById('run-status-strip')) { stopRunStatusPoll(); return; }
      if (runStatusTimer) return;
      fetchRunStatus();
      runStatusTimer = setInterval(() => {
        if (view !== 'board' || !state || !document.getElementById('run-status-strip')) { stopRunStatusPoll(); return; }
        fetchRunStatus();
      }, 10000);
    }

    async function fetchRunStatus() {
      if (runStatusInFlight || view !== 'board' || !state) return;
      const setId = state.id;
      const token = ++runStatusToken;
      runStatusInFlight = true;
      // Capture active-ness BEFORE this poll updates runStatus so we can detect a
      // transition and re-render the controls (lock/unlock) — not just patch the
      // strip. render() preserves drafts + scroll (Change 10), so this is cheap.
      const prevActive = isRunActive();
      try {
        const result = await request('/api/run-status?setId=' + encodeURIComponent(setId));
        // Fence: ignore a late response if the user navigated or switched sets.
        if (token !== runStatusToken || view !== 'board' || !state || state.id !== setId) return;
        runStatus = result;
        // Change 11: if a run we were watching just finished, refresh the durable
        // board once so the maintainer sees the produced artifacts without
        // clicking Refresh. load() preserves drafts and scroll (Change 10). Guard
        // on autoReloadedRunId so we fire exactly once per completed run.
        const run = result && result.run ? result.run : null;
        if (run && run.databaseId != null) {
          const wasActive = lastRunSeen && lastRunSeen.databaseId === run.databaseId && lastRunSeen.status !== 'completed';
          lastRunSeen = { databaseId: run.databaseId, status: run.status };
          if (wasActive && run.status === 'completed' && autoReloadedRunId !== run.databaseId) {
            autoReloadedRunId = run.databaseId;
            await load();
            return;
          }
        }
        // On an active⇄inactive transition, re-render so the mutation controls
        // lock/unlock in step with the run; otherwise just patch the strip.
        if (isRunActive() !== prevActive) render(); else patchRunStatusStrip();
      } catch (error) {
        if (token !== runStatusToken || view !== 'board' || !state || state.id !== setId) return;
        runStatus = { available: false, errorKind: error.message };
        // A broken run-status poll must never leave the controls stuck locked.
        if (isRunActive() !== prevActive) render(); else patchRunStatusStrip();
      } finally {
        runStatusInFlight = false;
      }
    }

    function wire() {
      document.querySelector('[data-back]')?.addEventListener('click', () => { dispatchNotice = null; loadIndex(); });
      document.querySelector('[data-filter-unapproved]')?.addEventListener('change', event => {
        showOnlyUnapproved = event.target.checked;
        render();
      });
      document.querySelectorAll('[data-phase]').forEach(button => button.addEventListener('click', () => {
        selectedPhase = button.dataset.phase;
        lastBulkResult = null;
        render();
      }));
      document.querySelectorAll('[data-feedback]').forEach(area => area.addEventListener('input', () => {
        draftFeedback.set(area.dataset.feedback, area.value);
      }));
      document.querySelectorAll('.brief-edit').forEach(area => area.addEventListener('input', () => {
        const itemId = area.dataset.briefItem;
        if (area.value !== area.dataset.original) {
          draftBriefs.set(itemId, area.value);
        } else {
          draftBriefs.delete(itemId);
        }
        const dirty = draftBriefs.has(itemId);
        const upButton = document.querySelector('[data-review="item"][data-id="' + CSS.escape(itemId) + '"][data-verdict="up"]');
        if (upButton) upButton.textContent = dirty ? '💾 Save and Approve' : '👍 Approve';
      }));
      document.querySelectorAll('[data-review]').forEach(button => button.addEventListener('click', async () => {
        const scope = button.dataset.review;
        const id = button.dataset.id;
        const verdict = button.dataset.verdict === 'clear' ? null : button.dataset.verdict;
        if (scope === 'item' && verdict === 'up') {
          const briefEl = document.querySelector('.brief-edit[data-brief-item="' + CSS.escape(id) + '"]');
          if (briefEl && briefEl.dataset.loaded === '1' && draftBriefs.has(id)) {
            await saveAndApproveBrief(id, briefEl);
            return;
          }
        }
        const feedbackEl = document.querySelector('[data-feedback="' + CSS.escape(feedbackKey(scope, id)) + '"]');
        const result = await mutate(scope === 'item' ? '/api/review-item' : '/api/review-set', {
          ...(scope === 'item' ? { itemId: id } : {}),
          review: { verdict, ...(feedbackEl?.value.trim() ? { feedback: feedbackEl.value.trim() } : {}) },
          expectedRevision: state.stateRevision,
        });
        // The submitted feedback is now the server value; drop the local draft so
        // it doesn't mask a later change. Other items' drafts stay untouched.
        if (result) draftFeedback.delete(feedbackKey(scope, id));
      }));
      document.querySelector('[data-approve-remaining]')?.addEventListener('click', async () => {
        const result = await mutate('/api/approve-remaining', { expectedRevision: state.stateRevision });
        if (result && result.bulkResult) {
          lastBulkResult = result.bulkResult;
          render();
        }
      });
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

    async function saveAndApproveBrief(itemId, briefEl) {
      if (busy) return;
      const errEl = document.querySelector('[data-brief-error="' + CSS.escape(itemId) + '"]');
      if (errEl) errEl.textContent = '';
      busy = true;
      try {
        const result = await request('/api/save-and-approve-brief', {
          method: 'POST',
          body: JSON.stringify({ itemId, briefText: briefEl.value, expectedRevision: state.stateRevision }),
        });
        state = result;
        lastBulkResult = null;
        draftBriefs.delete(itemId);
        busy = false;
        render();
      } catch (error) {
        busy = false;
        // Keep the dirty draft: surface the error inline and do NOT re-render.
        if (errEl) errEl.textContent = error.message;
        else alert(error.message);
        if (error.message.includes('revision-conflict')) await load();
      }
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
      for (const area of document.querySelectorAll('.brief-edit')) {
        if (area.dataset.loaded === '1') continue;
        try {
          const url = '/api/artifact?itemId=' + encodeURIComponent(area.dataset.briefItem) + '&artifactId=' + encodeURIComponent(area.dataset.artifact);
          const response = await fetch(url, { headers: apiHeaders });
          if (!response.ok) throw new Error(await response.text());
          const text = await response.text();
          area.dataset.original = text;
          area.dataset.loaded = '1';
          area.removeAttribute('readonly');
          // Restore any draft the user typed before this render cycle.
          const savedDraft = draftBriefs.get(area.dataset.briefItem);
          if (savedDraft !== undefined) {
            area.value = savedDraft;
            const upButton = document.querySelector('[data-review="item"][data-id="' + CSS.escape(area.dataset.briefItem) + '"][data-verdict="up"]');
            if (upButton) upButton.textContent = '💾 Save and Approve';
          } else {
            area.value = text;
          }
        } catch (error) {
          area.value = '';
          area.removeAttribute('readonly');
          area.placeholder = 'Brief unavailable: ' + error.message;
        }
      }
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
