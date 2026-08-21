/**
 * Unit tests for the renderer shell (renderHtml). Asserts the persistent toolbar
 * (refresh button + busy indicator) lives OUTSIDE #app so it survives the
 * app.replaceChildren re-render, that the tab bar + all three read surfaces are
 * wired (Queue + Requests moved to the B2 write slice), that the instanceId is
 * HTML-escaped into the shell, and that the refresh button re-points at
 * /api/reload (which invalidates the fs-static cache) while the initial load
 * uses the cached /api/state.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderHtml } from '../renderer.mjs';

test('renderHtml returns a complete standalone document', () => {
  const html = renderHtml('workflow-1');
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<\/body><\/html>$/);
  assert.match(html, /<div id="app" data-instance="workflow-1">/);
});

test('the persistent toolbar (refresh + busy) sits before #app so it survives re-render', () => {
  const html = renderHtml('x');
  const toolbarAt = html.indexOf('class="toolbar"');
  const appAt = html.indexOf('id="app"');
  assert.ok(toolbarAt >= 0, 'toolbar present');
  assert.ok(appAt >= 0, 'app present');
  assert.ok(toolbarAt < appAt, 'toolbar rendered outside/before #app');
  assert.match(html, /id="refresh-btn"/);
  assert.match(html, /id="busy"[^>]*hidden/);
  assert.match(html, /id="busy-label"/);
  assert.match(html, /class="spinner"/);
});

test('the client script wires busy state, load/reload, and refresh', () => {
  const html = renderHtml('x');
  assert.match(html, /function setBusy\(/);
  assert.match(html, /function loadState\(/);
  assert.match(html, /function reloadState\(/);
  // Refresh must invalidate the fs-static cache via /api/reload, not /api/state.
  assert.match(html, /refreshBtn\.addEventListener\('click', function \(\) \{ reloadState/);
  assert.match(html, /fetchState\('\/api\/reload'/);
  assert.match(html, /fetchState\('\/api\/state'/);
  assert.match(html, /Refreshing…/);
});

test('the client script wires the tab bar and all three read surfaces', () => {
  const html = renderHtml('x');
  assert.match(html, /function renderTabs\(/);
  assert.match(html, /function renderBacklog\(/);
  assert.match(html, /function renderFiles\(/);
  assert.match(html, /function renderRuns\(/);
  // B1 is the READ surface only — Queue + Requests tabs are the B2 follow-up.
  assert.doesNotMatch(html, /function renderQueue\(/);
  assert.doesNotMatch(html, /function renderRequests\(/);
});

test('the Author tab exposes the complete Azure workflow controls and visible refresh', () => {
  const html = renderHtml('x');
  assert.match(html, /id: 'author', label: 'Author'/);
  assert.match(html, /function renderAuthor\(/);
  assert.match(html, /Refresh Azure workflow/);
  assert.match(html, /\/api\/workflow\/request/);
  assert.match(html, /\/api\/workflow\/synthesize/);
  assert.match(html, /\/api\/workflow\/brief/);
  assert.match(html, /\/api\/workflow\/generate/);
  assert.match(html, /\/api\/workflow\/postprocess/);
  assert.match(html, /\/api\/workflow\/judge/);
  assert.match(html, /\/api\/workflow\/approve/);
  assert.match(html, /\/api\/workflow\/rewind/);
  assert.match(html, /X-Workflow-Mutation-Token/);
  assert.doesNotMatch(html, /worker\/start/);
});

test('the client script wires SSE + run selection', () => {
  const html = renderHtml('x');
  assert.match(html, /new EventSource\('\/events'\)/);
  assert.match(html, /\/api\/select\?briefId=/);
});

test('successful embedded Postprocess applies patch and re-renders all candidate cards', () => {
  const html = renderHtml('x');
  assert.match(html, /msg\.type === 'postprocess:applied'/);
  assert.match(html, /function applyPostprocessPatch\(/);
  assert.match(html, /patch\.scope === 'all'/);
  assert.match(html, /data-workflow-candidates/);
  assert.match(html, /data-variant-index/);
  // Both scopes now re-render the full candidates section so sibling cards
  // reflect cleared judge maps from the re-run postprocess step.
  assert.match(html, /section\.replaceWith\(renderCandidates/);
  assert.match(html, /lastState\.stale = false/);
  assert.match(html, /staleBadge\.remove\(\)/);
  // Processed image URLs include a cache-buster on patched variants so the
  // browser fetches the new PNG rather than reusing a stale cached thumbnail.
  assert.match(html, /_patchTs/);
  assert.match(html, /candidate\._patchTs/);
});

test('applyPostprocessPatch preserves UI-owned feedback and lifecycle fields from existing candidates', () => {
  const html = renderHtml('x');
  // Must build an index of existing candidates to preserve feedback/lifecycle
  assert.match(html, /existingByIndex/);
  assert.match(html, /existing\.feedback/);
  assert.match(html, /existing\.lifecycle/);
  // The merge must not silently drop fields the composeState layer adds
  assert.match(html, /out\.feedback = existing\.feedback/);
  assert.match(html, /out\.lifecycle = existing\.lifecycle/);
});

test('the client script exposes token-gated accept and visible queue states', () => {
  const html = renderHtml('x', 'secret-token');
  assert.match(html, /Accept & queue/);
  assert.match(html, /Accepting & queueing…/);
  assert.match(html, /Already queued/);
  assert.match(html, /Open asset issue/);
  // Any accepted/staged/integrated/unverified variant exposes "Re-accept"
  // (force-retries the same idempotent sidecar acceptance path) rather than
  // the old ephemeral-acceptance-driven "Retry accept & queue" label.
  assert.match(html, /Re-accept/);
  assert.doesNotMatch(html, /Retry accept & queue/);
  assert.match(html, /'x-workflow-mutation-token': mutationToken/);
  assert.match(html, /var mutationToken = "secret-token"/);
  assert.doesNotMatch(html, /__WORKFLOW_MUTATION_TOKEN__/);
});

test('the accept button label is driven by per-variant lifecycle, not ephemeral acceptance state', () => {
  const html = renderHtml('x');
  assert.match(html, /lifecycleState === 'unaccepted' \? 'Accept & queue' : 'Re-accept'/);
});

test('per-variant lifecycle pills are wired for all four states', () => {
  const html = renderHtml('x');
  assert.match(html, /function lifecyclePill\(/);
  assert.match(html, /class: 'lifecycle-pill ' \+ lifecycle\.state/);
  for (const cls of ['unaccepted', 'accepted-staged', 'integrated', 'unverified']) {
    assert.match(html, new RegExp(`\\.lifecycle-pill\\.${cls}`));
  }
});

test('feedback uses compact thumbs, saves verdicts immediately, and puts comments below', () => {
  const html = renderHtml('x');
  assert.match(html, /function renderCriterionFeedback\(/);
  assert.match(html, /button\.thumb \{ width: 28px; height: 28px; min-width: 28px/);
  assert.match(html, /class: 'feedback-verdict-row'/);
  assert.match(html, /class: 'feedback-comment-row'/);
  assert.match(html, /commentRow\.hidden = !draft\.verdict/);
  assert.match(html, /function saveVerdict\(next\)/);
  assert.match(html, /save\(next, next \? previousComment : ''\)/);
  assert.match(html, /class: 'confirm-btn'/);
  assert.match(html, /confirmBtn\.hidden = !commentDirty/);
  assert.match(html, /draft\.comment\.trim\(\)\.length > 0/);
  assert.match(html, /commentDirty \? 'Comment not saved'/);
  assert.match(html, /fetch\('\/api\/feedback'/);
  assert.match(html, /'x-workflow-mutation-token': mutationToken/);
});

test('feedback confirmation serializes saves and freezes the submitted draft while saving', () => {
  const html = renderHtml('x');
  assert.match(html, /if \(saving\) return/);
  assert.match(html, /var submitted = \{ verdict: draft\.verdict, comment: draft\.comment \}/);
  assert.match(html, /setDisabled\(true\)/);
  assert.match(html, /up\.disabled = disabled/);
  assert.match(html, /down\.disabled = disabled/);
  assert.match(html, /input\.disabled = disabled/);
  assert.match(html, /persisted\.verdict = submitted\.verdict/);
  assert.match(html, /persisted\.comment = submitted\.comment/);
  assert.match(html, /\.finally\(function \(\) \{[\s\S]*setDisabled\(false\)/);
});

test('criterion feedback: a confirmed criterion is written to the CANONICAL candidate location, not a disconnected fallback', () => {
  const html = renderHtml('x');
  // Regression guard for the finding that a first-time-confirmed criterion
  // disappeared on the next rerender: renderCriterionFeedback must read/write
  // through the canonical read/write helpers (spliced from
  // lib/feedback-summary.mjs), not the old ad-hoc
  // `(((c.feedback||{})[kind]||{})[criterion]) || {...}` fallback that
  // confirm() only mutated locally.
  assert.match(html, /var persisted = readCriterionFeedback\(c, kind, criterion\)/);
  assert.match(html, /writeCriterionFeedback\(c, kind, criterion, result && result\.feedback\)/);
  assert.doesNotMatch(html, /\(\(\(c\.feedback \|\| \{\}\)\[kind\] \|\| \{\}\)\[criterion\]\)/);
});

test('"View Brief" resolves the run\'s exact brief path, not just a basename match', () => {
  const html = renderHtml('x');
  // Regression guard for the finding that View Brief could open the WRONG
  // file when a draft and committed brief share a basename: openBriefModal
  // must resolve through resolveBriefEntry (which prefers selected.briefPath)
  // and must no longer call the old basename-only findBriefEntry helper.
  assert.match(html, /var entry = resolveBriefEntry\(state, sel\)/);
  assert.doesNotMatch(html, /findBriefEntry\(state, sel\.briefId\)/);
  assert.match(html, /function resolveBriefEntry\(/);
});

test('a stale (cache-first) state shows a non-blocking revalidating badge, never a blocking spinner', () => {
  const html = renderHtml('x');
  assert.match(html, /state\.stale/);
  assert.match(html, /stale-badge/);
  assert.match(html, /revalidating…/);
});

test('the renderer warns when a queued acceptance batches more than one asset (ADR 0066 RSK-003)', () => {
  const html = renderHtml('x');
  // Styling for the warning state exists.
  assert.match(html, /\.accept-state\.warn/);
  // The gate is on assetCount, not just "queued" — a single-asset batch must
  // not show the warning.
  assert.match(html, /acceptance\.assetCount > 1/);
  assert.match(html, /Heads up/);
  // Existing vs. freshly-queued acceptances get distinct wording so an
  // operator can tell whether THIS click published the extra assets.
  assert.match(html, /this open issue batches/);
  assert.match(html, /accepting this variant also published/);
});

test('the run cards expose every current judge axis', () => {
  const html = renderHtml('x');
  for (const key of [
    'designLanguage',
    'referenceStyleMatch',
    'briefMatch',
    'readability',
    'poseOrientation',
    'bossPresence',
    'presentation',
    'themeAdherence',
  ]) {
    assert.match(html, new RegExp(`key: '${key}'`));
  }
  assert.match(html, /if \(!score\) continue;/);
});

test('instanceId is HTML-escaped into the shell', () => {
  const html = renderHtml('a"><script>bad</script>');
  assert.ok(!html.includes('a"><script>bad'));
  assert.match(html, /data-instance="a&quot;&gt;&lt;script&gt;bad&lt;\/script&gt;"/);
});

// ---- Expanded UX follow-up ------------------------------------------------

test('the client script splices the serialized pure lib helpers (no placeholders left in output)', () => {
  const html = renderHtml('x');
  assert.doesNotMatch(html, /__RUN_FILTER_FNS__/);
  assert.doesNotMatch(html, /__SHEET_DISPLAY_FNS__/);
  assert.doesNotMatch(html, /__FEEDBACK_SUMMARY_FNS__/);
  assert.doesNotMatch(html, /__POSTPROCESS_HANDOFF_FNS__/);
  assert.doesNotMatch(html, /__BRIEF_LOOKUP_FNS__/);
  assert.match(html, /function filterRuns\(/);
  assert.match(html, /function computeSheetDisplaySize\(/);
  assert.match(html, /function summarizeJudge\(/);
  assert.match(html, /function summarizeSensors\(/);
  assert.match(html, /function resolveBriefEntry\(/);
});

test('runs support type-to-filter search alongside the existing native promotion select', () => {
  const html = renderHtml('x');
  assert.match(html, /class: 'run-search'/);
  assert.match(html, /type: 'search'/);
  assert.match(html, /filterRuns\(state\.runs \|\| \[\], runFilter, runSearch\)/);
  // Native select preserved for the promotion filter (Refinement D: not a
  // bespoke combobox).
  assert.match(html, /title: 'Filter runs by promotion state'/);
});

test('the sheet defaults to a constrained (<=512x512) presentation with a full-size toggle, and never touches the <img> src', () => {
  const html = renderHtml('x');
  assert.match(html, /var sheetViewMode = 'constrained'/);
  assert.match(html, /title: 'Sheet display size'/);
  assert.match(html, /\['constrained', 'Fit to 512/);
  assert.match(html, /\['full', 'Full size'\]/);
  assert.match(html, /function applySheetSize\(/);
  // Toggling recomputes size/overlay in place — it must NOT re-render the
  // page or touch img.src (that would re-trigger the Azure sheet fetch).
  assert.match(
    html,
    /sizeSelect\.addEventListener\('change', function \(\) \{\s*sheetViewMode = sizeSelect\.value;\s*applySheetSize\(img\);\s*drawOverlay\(sheetWrap, img, sliceMap\);\s*\}\)/,
  );
});

test('the overlay is redrawn on load AND on every size-mode toggle (guard against a stale overlay)', () => {
  const html = renderHtml('x');
  const loadHandlerMatches = html.match(/drawOverlay\(sheetWrap, img, sliceMap\)/g) || [];
  // At least: on <img> load, on size toggle, and inside drawOverlay's own
  // ResizeObserver callback — three distinct call sites.
  assert.ok(
    loadHandlerMatches.length >= 3,
    'drawOverlay must be called from load, toggle, AND resize paths',
  );
  assert.match(html, /ResizeObserver/);
});

test('judge and sensor results show a concise one-line summary by default, with a <details> expander for full detail', () => {
  const html = renderHtml('x');
  assert.match(html, /function summarizeJudge\(/);
  assert.match(html, /function summarizeSensors\(/);
  assert.match(html, /class: 'concise-summary/);
  assert.match(html, /document\.createElement\('details'\)/);
  assert.match(html, /Show per-axis detail & feedback/);
  assert.match(html, /Show per-sensor detail & feedback/);
});

test('a "View Brief" button opens an accessible modal (dialog role, aria-modal, focus trap, Escape-to-close, focus return)', () => {
  const html = renderHtml('x');
  assert.match(html, /text: 'View Brief'/);
  assert.match(html, /openBriefModal\(state, ev\.currentTarget\)/);
  assert.match(html, /role: 'dialog'/);
  assert.match(html, /'aria-modal': 'true'/);
  assert.match(html, /'aria-labelledby': 'brief-modal-title'/);
  assert.match(html, /ev\.key === 'Escape'/);
  assert.match(html, /ev\.key === 'Tab'/);
  assert.match(html, /function closeBriefModal\(/);
  assert.match(html, /id: 'view-brief-btn'/);
  assert.match(html, /triggerId: triggerEl && triggerEl\.id/);
  assert.match(html, /document\.getElementById\(triggerId\)/);
  assert.match(html, /trigger\.focus\(\)/);
  assert.match(html, /modalContainer\.focus\(\)/);
  assert.match(html, /pendingFocusModal \|\| restoreModalFocus/);
});

test('REGRESSION: a late "View Brief" fetch response cannot overwrite a newer modal or clobber a fresher background state', () => {
  // Guards the finding that closing brief A and opening brief B before A's
  // `/api/brief` fetch resolves let A's late response overwrite B's modal
  // (both success and error paths only checked `!briefModal`, which stays
  // truthy across an A\u2192B reopen), and that re-rendering from the `state`
  // snapshot captured when the fetch started could revert a newer
  // background state update (SSE push/reload) that landed while the fetch
  // was in flight.
  const html = renderHtml('x');
  assert.match(html, /var briefModalRequestSeq = 0;/);
  assert.match(html, /var requestId = \+\+briefModalRequestSeq;/);
  assert.match(html, /id: requestId,/);
  // Both the success and the error callback must discard a response that no
  // longer matches the CURRENT modal's request id, not just check `briefModal`
  // truthiness (which is insufficient once briefModal has been reassigned to
  // a newer modal).
  const openBriefModalBody = html.slice(
    html.indexOf('function openBriefModal('),
    html.indexOf('function closeBriefModal('),
  );
  const staleGuardMatches =
    openBriefModalBody.match(/if \(!briefModal \|\| briefModal\.id !== requestId\) return;/g) || [];
  assert.equal(
    staleGuardMatches.length,
    2,
    'both the success and error callbacks must guard on requestId',
  );
  // Neither callback may re-render from the closure-captured `state` — only
  // from the live `lastState`, so a background update during the fetch is
  // never reverted.
  const rerenderCalls = openBriefModalBody.match(/render\((state|lastState)\);/g) || [];
  assert.deepEqual(rerenderCalls, ['render(state);', 'render(lastState);', 'render(lastState);']);
});

test('the brief supports thumb up/down with a hidden-until-selected comment box and a confirm checkmark', () => {
  const html = renderHtml('x');
  assert.match(html, /function renderBriefFeedback\(/);
  assert.match(html, /function saveBriefFeedback\(/);
  assert.match(html, /subjectType: 'brief'/);
  // Wired inside the View Brief modal, not duplicated inline in the sheet toolbar.
  assert.match(html, /modal\.appendChild\(renderBriefFeedback\(state\)\)/);
});

test('the overall sprite sheet supports thumb up/down with a hidden-until-selected comment box and a confirm checkmark', () => {
  const html = renderHtml('x');
  assert.match(html, /function renderSheetFeedback\(/);
  assert.match(html, /function saveSheetFeedback\(/);
  assert.match(html, /subjectType: 'sheet'/);
  // Actually wired under the sheet viewer, not merely declared.
  assert.match(html, /wrap\.appendChild\(renderSheetFeedback\(state\)\)/);
});

test('brief/sheet/criterion feedback all funnel through ONE generic confirm widget (same store/route)', () => {
  const html = renderHtml('x');
  assert.match(html, /function renderFeedbackWidget\(/);
  // All three call sites delegate to the shared widget.
  const widgetCallSites = (html.match(/renderFeedbackWidget\(/g) || []).length;
  assert.ok(
    widgetCallSites >= 4,
    'expected renderFeedbackWidget to be both declared and called by criterion/sheet/brief',
  );
});

test('a per-variant "Open in Post-process Debugger" control opens the embedded editor directly', () => {
  const html = renderHtml('x');
  assert.match(html, /text: 'Open in Post-process Debugger'/);
  assert.match(html, /function renderPostprocessHandoff\(/);
  assert.match(html, /function openPostprocess\(/);
  assert.match(
    html,
    /btn\.addEventListener\('click', function \(\) \{ openPostprocess\(context\); \}\)/,
  );
  assert.doesNotMatch(html, /Copy link/);
  assert.doesNotMatch(html, /project:postprocess/);
  assert.match(html, /renderPostprocessHandoff\(sel, candidate\.index\)/);
});

test('opening the embedded Post-process Debugger reveals the persistent host, lazily creates ONE iframe seeded by query string, and retargets later opens via postMessage', () => {
  const html = renderHtml('x');
  assert.match(html, /var postprocessHost = document\.getElementById\('postprocess-host'\)/);
  assert.match(html, /postprocessHost\.hidden = false/);
  assert.match(html, /postprocessIframe\.src = postprocessSrc\(context\)/);
  assert.match(html, /else if \(!postprocessIframeReady\)/);
  assert.match(html, /type: 'postprocess:select'/);
  assert.match(html, /postprocessIframe\.contentWindow\.postMessage/);
  assert.match(html, /postprocessHost\.scrollIntoView/);
  // The ready-metric bridge accepts same-origin direct callbacks with a
  // postMessage fallback, and rejects stale context before recording elapsed ms.
  assert.match(html, /window\.__workflowPostprocessReady = handlePostprocessReady/);
  assert.match(html, /type === 'postprocess:ready'/);
  assert.match(html, /postprocessReadyRecorded/);
  assert.match(html, /context\.briefId !== postprocessExpectedContext\.briefId/);
  assert.match(html, /typeof postprocessExpectedContext\.variantIndex === 'number'/);
  assert.match(html, /window\.__postprocessReadyMetric/);
});

test('the persistent #postprocess-host sits OUTSIDE #app (a sibling, like the toolbar) so render() never recreates it', () => {
  const html = renderHtml('x');
  const appAt = html.indexOf('id="app"');
  const hostAt = html.indexOf('id="postprocess-host"');
  assert.ok(appAt >= 0 && hostAt >= 0);
  assert.ok(
    hostAt > appAt,
    'the host must be declared as a sibling AFTER #app in the static shell',
  );
  // Starts collapsed/hidden — no eager iframe/network activity on initial paint.
  assert.match(html, /<div id="postprocess-host" hidden>/);
  assert.doesNotMatch(html, /<iframe/); // no iframe in the initial server-rendered shell
  // render()'s app.replaceChildren body must never reference postprocess-host —
  // a static guard that a future edit doesn't accidentally fold the host into
  // the re-rendered #app subtree (which would reset the iframe on every SSE
  // push/tab switch/refresh).
  const renderBody = html.slice(
    html.indexOf('function render(state) {'),
    html.indexOf('var selecting = false;'),
  );
  assert.doesNotMatch(renderBody, /postprocess-host/);
  assert.doesNotMatch(renderBody, /postprocessIframe/);
});
