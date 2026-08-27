function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Render the Screenshot Viewer HTML shell.
 * @param {{ instanceId: string, pollIntervalMs: number }} opts
 */
export function renderHtml({ instanceId, pollIntervalMs }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>A|B UX Testing — ${escapeHtml(instanceId)}</title>
    <style>
      :root {
        color-scheme: light dark;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        background: var(--background-color-default, #0d1117);
        color: var(--text-color-default, #c9d1d9);
        font-family: var(
          --font-sans,
          -apple-system,
          BlinkMacSystemFont,
          "Segoe UI",
          sans-serif
        );
        font-size: var(--text-body-medium, 14px);
        line-height: var(--leading-body-medium, 20px);
      }

      main {
        padding: 16px;
      }

      header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 12px;
        margin-bottom: 12px;
      }

      h1 {
        margin: 0;
        font-size: var(--text-title-medium, 20px);
        line-height: var(--leading-title-medium, 26px);
        font-weight: var(--font-weight-semibold, 600);
      }

      .toolbar {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
      }

      button {
        min-height: 32px;
        padding: 4px 12px;
        border: 1px solid var(--border-color-default, #30363d);
        border-radius: 5px;
        background: var(--background-color-default, #0d1117);
        color: var(--text-color-default, #c9d1d9);
        font: inherit;
        font-weight: var(--font-weight-semibold, 600);
        cursor: pointer;
      }

      button:hover {
        border-color: var(--true-color-blue, #58a6ff);
      }

      button:focus-visible {
        outline: 2px solid var(--color-focus-outline, #58a6ff);
        outline-offset: 1px;
      }

      button:disabled {
        opacity: 0.6;
        cursor: wait;
      }

      .meta {
        color: var(--text-color-muted, #8b949e);
        font-size: var(--text-body-small, 12px);
      }

      .status-bar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        margin-bottom: 12px;
        padding: 8px 10px;
        border: 1px solid var(--border-color-default, #30363d);
        border-radius: 6px;
        background: color-mix(in srgb, var(--background-color-default, #0d1117) 92%, white);
        font-size: var(--text-body-small, 12px);
        color: var(--text-color-muted, #8b949e);
      }

      .status-badge {
        display: inline-flex;
        align-items: center;
        padding: 1px 8px;
        border-radius: 999px;
        border: 1px solid var(--border-color-default, #30363d);
        font-size: 11px;
        line-height: 18px;
      }

      .status-badge--live {
        border-color: var(--true-color-green, #3fb950);
        color: var(--true-color-green, #3fb950);
      }

      .status-badge--stale {
        color: var(--text-color-muted, #8b949e);
      }

      .error-box {
        margin-bottom: 12px;
        padding: 10px 12px;
        border: 1px solid var(--true-color-red, #f85149);
        border-radius: 6px;
        background: color-mix(in srgb, var(--true-color-red, #f85149) 12%, transparent);
        color: var(--true-color-red, #f85149);
        font-size: var(--text-body-small, 12px);
      }

      .empty-state {
        padding: 32px 16px;
        text-align: center;
        border: 1px dashed var(--border-color-default, #30363d);
        border-radius: 8px;
        color: var(--text-color-muted, #8b949e);
      }

      .empty-state strong {
        display: block;
        font-size: 15px;
        margin-bottom: 6px;
        color: var(--text-color-default, #c9d1d9);
      }

      /* Screenshot grid */
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
        gap: 12px;
      }

      .pair-grid { display: grid; grid-template-columns: 1fr; gap: 16px; margin-bottom: 20px; }
      .pair-card, .feedback-panel {
        border: 1px solid var(--border-color-default, #30363d);
        border-radius: 8px;
        padding: 12px;
      }
      .pair-images { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
      .pair-images figure { margin: 0; }
      .pair-image-label { color: var(--text-color-default, #c9d1d9); font-size: 12px; font-weight: 600; margin-bottom: 4px; }
      .pair-images img { width: 100%; aspect-ratio: 16 / 9; object-fit: contain; background: #000; cursor: zoom-in; }
      .pair-missing {
        display: grid;
        place-items: center;
        min-height: 140px;
        padding: 12px;
        border: 1px dashed var(--border-color-default, #30363d);
        color: var(--text-color-muted, #8b949e);
        font-size: 12px;
        text-align: center;
      }
      .pair-images img:focus-visible { outline: 2px solid var(--color-focus-outline, #58a6ff); outline-offset: 2px; }
      figcaption { color: var(--text-color-muted, #8b949e); font-size: 11px; margin-top: 4px; }
      .review-details {
        margin-top: 6px;
        border: 1px solid var(--border-color-default, #30363d);
        border-radius: 6px;
        background: color-mix(in srgb, var(--background-color-default, #0d1117) 94%, white);
      }
      .review-details summary {
        cursor: pointer;
        padding: 6px 8px;
        color: var(--text-color-default, #c9d1d9);
        font-size: 12px;
        font-weight: var(--font-weight-semibold, 600);
      }
      .review-details-body {
        display: grid;
        gap: 8px;
        padding: 0 8px 8px;
        color: var(--text-color-muted, #8b949e);
        font-size: 11px;
        line-height: 16px;
      }
      .review-axis {
        padding-top: 6px;
        border-top: 1px solid var(--border-color-default, #30363d);
      }
      .review-list {
        margin: 2px 0 0;
        padding-left: 16px;
      }
      .review-list li {
        margin: 2px 0;
      }
      .review-pre {
        margin: 0;
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-word;
        color: var(--text-color-default, #c9d1d9);
      }
      .feedback-panel { margin: 16px 0; display: grid; gap: 8px; }
      textarea, select { width: 100%; font: inherit; padding: 8px; color: inherit; background: var(--background-color-default, #0d1117); border: 1px solid var(--border-color-default, #30363d); border-radius: 5px; }
      .feedback-list { display: grid; gap: 6px; }
      .feedback-item { padding: 8px; border-left: 3px solid var(--true-color-blue, #58a6ff); background: color-mix(in srgb, var(--background-color-default, #0d1117) 88%, white); }

      .thumb-card {
        border: 1px solid var(--border-color-default, #30363d);
        border-radius: 8px;
        overflow: hidden;
        cursor: pointer;
        transition: border-color 0.12s;
        background: color-mix(in srgb, var(--background-color-default, #0d1117) 88%, white);
      }

      .thumb-card:hover {
        border-color: var(--true-color-blue, #58a6ff);
      }

      .thumb-card:focus-visible {
        outline: 2px solid var(--color-focus-outline, #58a6ff);
        outline-offset: 1px;
      }

      .thumb-img-wrap {
        width: 100%;
        aspect-ratio: 16 / 9;
        background: var(--background-color-default, #0d1117);
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
      }

      .thumb-img-wrap img {
        width: 100%;
        height: 100%;
        object-fit: contain;
        display: block;
      }

      .thumb-img-wrap .thumb-load-error {
        color: var(--text-color-muted, #8b949e);
        font-size: 11px;
        text-align: center;
        padding: 8px;
      }

      .thumb-meta {
        padding: 8px 10px;
        border-top: 1px solid var(--border-color-default, #30363d);
      }

      .thumb-filename {
        font-size: var(--text-body-small, 12px);
        font-weight: var(--font-weight-semibold, 600);
        word-break: break-all;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .thumb-time {
        color: var(--text-color-muted, #8b949e);
        font-size: 11px;
        margin-top: 2px;
      }

      .thumb-tag {
        display: inline-block;
        margin-top: 4px;
        padding: 0 6px;
        border: 1px solid var(--border-color-default, #30363d);
        border-radius: 999px;
        font-size: 10px;
        color: var(--text-color-muted, #8b949e);
        line-height: 16px;
      }

      .thumb-tag--live {
        border-color: var(--true-color-green, #3fb950);
        color: var(--true-color-green, #3fb950);
      }

      /* Lightbox */
      .lightbox {
        position: fixed;
        inset: 0;
        z-index: 9999;
        background: rgba(0, 0, 0, 0.88);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 12px;
        padding: 16px;
      }

      .lightbox[hidden] {
        display: none;
      }

      .lightbox-close {
        position: absolute;
        top: 12px;
        right: 12px;
        background: none;
        border: 1px solid rgba(255,255,255,0.3);
        color: #fff;
        font-size: 18px;
        line-height: 1;
        padding: 4px 10px;
        border-radius: 4px;
        cursor: pointer;
      }

      .lightbox-close:hover {
        background: rgba(255,255,255,0.1);
      }

      .lightbox img {
        max-width: 100%;
        max-height: calc(100vh - 100px);
        object-fit: contain;
        border-radius: 4px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.6);
      }

      .lightbox-caption {
        color: rgba(255,255,255,0.72);
        font-size: var(--text-body-small, 12px);
        text-align: center;
        max-width: 600px;
        word-break: break-all;
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>A|B UX Testing</h1>
        <div class="toolbar">
          <label for="scenario-filter">Scenario</label>
          <select id="scenario-filter"><option value="">All scenarios</option></select>
          <button type="button" id="refresh-button">↻ Refresh</button>
        </div>
      </header>

      <div class="status-bar" id="status-bar">
        <span id="status-text">Loading…</span>
        <span id="live-badge" class="status-badge status-badge--live" hidden>● live</span>
      </div>

      <div class="error-box" id="error-box" hidden></div>

      <div id="pairs"></div>
      <section class="feedback-panel" aria-labelledby="feedback-heading">
        <strong id="feedback-heading">Capture review feedback</strong>
        <label for="feedback-pair">Screenshot pair</label>
        <select id="feedback-pair"><option value="">General screenshot feedback</option></select>
        <label for="feedback-scope">Feedback scope</label>
        <select id="feedback-scope">
          <option value="task">This task only</option>
          <option value="reusable">Promote to reusable guidance</option>
        </select>
        <label for="feedback-target">Feedback target</label>
        <select id="feedback-target" hidden>
          <option value="ux-agent">UX Designer agent</option>
          <option value="visual-review-skill">Visual review skill</option>
          <option value="deterministic-eval">Deterministic evaluation</option>
          <option value="workflow">Review workflow</option>
        </select>
        <label for="feedback-comment">Feedback comment</label>
        <textarea id="feedback-comment" rows="3" placeholder="What should change, and what evidence supports it?"></textarea>
        <button type="button" id="feedback-submit">Save feedback</button>
        <div class="feedback-list" id="feedback-list"></div>
      </section>
      <div id="gallery">
        <div class="empty-state">
          <strong>No screenshots yet</strong>
          Screenshots taken with the Playwright tool will appear here.
        </div>
      </div>
    </main>

    <!-- Lightbox overlay -->
    <div class="lightbox" id="lightbox" hidden aria-modal="true" role="dialog" aria-label="Screenshot">
      <button type="button" class="lightbox-close" id="lightbox-close" aria-label="Close">✕</button>
      <img id="lightbox-img" src="" alt="Screenshot" />
      <div class="lightbox-caption" id="lightbox-caption"></div>
    </div>

    <script>
      const token = new URLSearchParams(window.location.search).get('token') ?? '';
      function buildUrl(pathname, params = {}) {
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
          if (value !== null && value !== undefined) {
            query.set(key, String(value));
          }
        }
        if (token) query.set('token', token);
        const queryString = query.toString();
        return queryString ? pathname + '?' + queryString : pathname;
      }

      const stateUrl = buildUrl('/api/state');
      const refreshUrl = buildUrl('/api/refresh');
      const pollIntervalMs = ${JSON.stringify(pollIntervalMs)};

      const galleryEl = document.getElementById('gallery');
      const pairsEl = document.getElementById('pairs');
      const statusBar = document.getElementById('status-bar');
      const statusText = document.getElementById('status-text');
      const liveBadge = document.getElementById('live-badge');
      const errorBox = document.getElementById('error-box');
      const refreshButton = document.getElementById('refresh-button');
      const scenarioFilter = document.getElementById('scenario-filter');
      let lastState = null;
      const lightbox = document.getElementById('lightbox');
      const lightboxImg = document.getElementById('lightbox-img');
      const lightboxCaption = document.getElementById('lightbox-caption');
      const lightboxClose = document.getElementById('lightbox-close');
      const feedbackPair = document.getElementById('feedback-pair');
      const feedbackScope = document.getElementById('feedback-scope');
      const feedbackTarget = document.getElementById('feedback-target');
      const feedbackComment = document.getElementById('feedback-comment');
      const feedbackSubmit = document.getElementById('feedback-submit');
      const feedbackList = document.getElementById('feedback-list');

      function escapeHtml(value) {
        return String(value)
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;');
      }

      function formatTime(iso) {
        if (!iso) return '';
        try {
          return new Date(iso).toLocaleString();
        } catch {
          return iso;
        }
      }

      function formatRelative(iso) {
        if (!iso) return '';
        try {
          const diff = Date.now() - new Date(iso).getTime();
          if (diff < 60_000) return 'just now';
          if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm ago';
          if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h ago';
          return Math.floor(diff / 86_400_000) + 'd ago';
        } catch {
          return '';
        }
      }

      function openLightbox(imgUrl, caption) {
        lightboxImg.src = imgUrl;
        lightboxCaption.textContent = caption;
        lightbox.hidden = false;
        lightboxClose.focus();
      }

      function closeLightbox() {
        lightbox.hidden = true;
        lightboxImg.src = '';
      }

      lightboxClose.addEventListener('click', closeLightbox);
      lightbox.addEventListener('click', (e) => {
        if (e.target === lightbox) closeLightbox();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !lightbox.hidden) closeLightbox();
      });

      function buildImgUrl(encodedPath) {
        return buildUrl('/img', { path: encodedPath });
      }

      function renderThumb(screenshot) {
        const imgUrl = buildImgUrl(screenshot.path);
        const rel = formatRelative(screenshot.takenAt);
        const abs = formatTime(screenshot.takenAt);
        const tagHtml = screenshot.source === 'live'
          ? '<span class="thumb-tag thumb-tag--live">live</span>'
          : '<span class="thumb-tag">scanned</span>';

        return \`
          <article class="thumb-card" tabindex="0" role="button" aria-label="Open screenshot: \${escapeHtml(screenshot.filename)}" data-img-url="\${escapeHtml(imgUrl)}" data-caption="\${escapeHtml(screenshot.path)}">
            <div class="thumb-img-wrap">
              <img
                src="\${escapeHtml(imgUrl)}"
                alt="\${escapeHtml(screenshot.filename)}"
                loading="lazy"
              />
            </div>
            <div class="thumb-meta">
              <div class="thumb-filename" title="\${escapeHtml(screenshot.path)}">\${escapeHtml(screenshot.filename)}</div>
              <div class="thumb-time" title="\${escapeHtml(abs)}">\${escapeHtml(rel || abs)}</div>
              \${tagHtml}
            </div>
          </article>
        \`;
      }

      function renderList(title, items) {
        const list = Array.isArray(items) ? items.filter(Boolean) : [];
        if (list.length === 0) return '';
        return '<div><strong>' + escapeHtml(title) + '</strong><ul class="review-list">' +
          list.map((item) => '<li>' + escapeHtml(item) + '</li>').join('') +
          '</ul></div>';
      }

      function renderReviewDetails(review, reviewKey) {
        const details = review?.details;
        if (!details) return '';
        const summary = details.summary
          ? '<div><strong>Summary</strong><br>' + escapeHtml(details.summary) + '</div>'
          : '';
        const verdict = details.verdict
          ? '<div><strong>Verdict</strong> ' + escapeHtml(details.verdict) + '</div>'
          : '';
        const rawScore = details.rawScore !== null && details.rawScore !== undefined
          ? '<div><strong>Model raw score</strong> ' + escapeHtml(details.rawScore) + '/' + escapeHtml(details.scale ?? 100) + '</div>'
          : '';
        const derivation = details.scoreDerivation
          ? '<div><strong>Score derivation</strong><pre class="review-pre">' + escapeHtml(JSON.stringify(details.scoreDerivation, null, 2)) + '</pre></div>'
          : '';
        const axes = Array.isArray(details.axes) ? details.axes.map((axis) => {
          const score = axis.score === null || axis.score === undefined ? 'n/a' : axis.score;
          return '<div class="review-axis"><strong>' + escapeHtml(axis.label) + '</strong> · ' +
            escapeHtml(score) + '/' + escapeHtml(details.scale ?? 100) +
            renderList('Strengths', axis.strengths) +
            renderList('Issues', axis.issues) +
            '</div>';
        }).join('') : '';
        const precise = Array.isArray(details.preciseFixes) && details.preciseFixes.length > 0
          ? '<div><strong>Precise fixes</strong><ul class="review-list">' + details.preciseFixes.map((fix) => {
              const deltas = ['dx', 'dy', 'dw', 'dh']
                .filter((key) => fix[key] !== null && fix[key] !== undefined && fix[key] !== 0)
                .map((key) => key + '=' + fix[key])
                .join(' ');
              return '<li>' + escapeHtml([fix.action, fix.element, deltas, fix.reason].filter(Boolean).join(' · ')) + '</li>';
            }).join('') + '</ul></div>'
          : '';
        const rawResponse = details.rawReview
          ? '<details class="review-details" data-details-key="' + escapeHtml(reviewKey + ':raw') + '"><summary>Full raw judge response JSON</summary><pre class="review-pre">' + escapeHtml(JSON.stringify(details.rawReview, null, 2)) + '</pre></details>'
          : '';
        return '<details class="review-details" data-details-key="' + escapeHtml(reviewKey) + '"><summary>Score details + judge comments</summary><div class="review-details-body">' +
          verdict +
          rawScore +
          summary +
          derivation +
          renderList('Deterministic findings', details.deterministicFindings) +
          renderList('Blocking findings', details.blockingFindings) +
          renderList('Recommended fixes', details.recommendedFixes) +
          precise +
          axes +
          rawResponse +
          '</div></details>';
      }

      function renderGallery(state) {
        const screenshots = Array.isArray(state.screenshots) ? state.screenshots : [];
        const count = screenshots.length;
        const scannedAt = state.scannedAt ? formatTime(state.scannedAt) : null;
        const workspacePath = state.workspacePath || '';

        statusText.textContent = count === 0
          ? 'No screenshots found'
          : count === 1 ? '1 screenshot' : count + ' screenshots';
        if (scannedAt) {
          statusText.textContent += ' · last scan: ' + scannedAt;
        }
        if (workspacePath) {
          statusText.textContent += ' · ' + workspacePath;
        }

        liveBadge.hidden = !state.liveTracking;

        const allPairs = Array.isArray(state.pairs) ? state.pairs : [];
        const scenarios = Array.isArray(state.scenarios) ? state.scenarios : [];
        const selected = scenarios.some((scenario) => scenario.id === scenarioFilter.value) ? scenarioFilter.value : '';
        scenarioFilter.innerHTML = '<option value="">All scenarios</option>' +
          scenarios.map((scenario) => '<option value="' + escapeHtml(scenario.id) + '">' + escapeHtml(scenario.label) + '</option>').join('');
        scenarioFilter.value = selected;
        const pairs = selected ? allPairs.filter((pair) => pair.scenarioId === selected) : allPairs;
        if (count === 0) {
          galleryEl.innerHTML = \`
            <div class="empty-state">
              <strong>No screenshots yet</strong>
              Screenshots taken with the Playwright tool (<code>browser_take_screenshot</code>) will appear here automatically.
              Click Refresh to scan common directories.
            </div>
          \`;
          return;
        }

        // The backend emits complete lineages first, then valid current-only
        // captures. Keep both: hiding an after-only card conceals real evidence
        // while the release baseline is pending.
        const orderedPairs = pairs;
        const openDetails = new Set(
          [...pairsEl.querySelectorAll('details[data-details-key][open]')]
            .map((details) => details.getAttribute('data-details-key'))
            .filter(Boolean),
        );
        const pairHtml = orderedPairs.map((pair) => {
          const reviewMeta = (review, reviewKey) => review
            ? '<div class="meta"><strong>UX ' + escapeHtml(review.score) + '/' + escapeHtml(review.scale ?? 100) + '</strong> · evidence ' + escapeHtml(review.coverage) + '%<br>Hard failures: ' + escapeHtml(review.hardFailures.length) + '<br>' + review.findings.slice(0, 3).map(escapeHtml).join('<br>') + renderReviewDetails(review, reviewKey) + '</div>'
            : '<div class="meta">No evaluator result attached.</div>';
          const stateLabel = (state) => {
            if (state === 'live-dev') return 'live (dev)';
            return state ?? 'missing';
          };
          const image = (side) => {
            const screenshot = pair[side];
            const label = stateLabel(pair.states?.[side]);
            if (!screenshot) {
              return '<figure><div class="pair-image-label">' + escapeHtml(label) + '</div><div class="pair-missing">No ' + escapeHtml(label) + ' capture is available for this scenario.</div><figcaption>Capture a release baseline to complete this comparison.</figcaption></figure>';
            }
            return '<figure><div class="pair-image-label">' + escapeHtml(label) + '</div><img class="pair-image" tabindex="0" role="button" src="' + escapeHtml(buildImgUrl(screenshot.path)) + '" alt="' + side + ' ' + escapeHtml(pair.key) + '" aria-label="Zoom ' + side + ' screenshot for ' + escapeHtml(pair.key) + '" data-img-url="' + escapeHtml(buildImgUrl(screenshot.path)) + '" data-caption="' + escapeHtml(screenshot.path) + '"><figcaption>' + side + ' · ' + escapeHtml(screenshot.takenAt ? formatTime(screenshot.takenAt) : 'time unknown') + ' · click to zoom</figcaption>' + reviewMeta(pair.reviews?.[side], pair.key + ':' + side) + '</figure>';
          };
          const beforeState = stateLabel(pair.states?.before);
          const afterState = stateLabel(pair.states?.after);
          return '<article class="pair-card"><strong>' + escapeHtml((pair.scenarioLabel ?? pair.key) + ' · ' + beforeState + ' → ' + afterState) + '</strong><div class="pair-images">' + image('before') + image('after') + '</div></article>';
        }).join('');
        pairsEl.innerHTML = pairHtml ? '<h2>Before / After</h2><div class="pair-grid">' + pairHtml + '</div>' : '';
        for (const details of pairsEl.querySelectorAll('details[data-details-key]')) {
          details.open = openDetails.has(details.getAttribute('data-details-key'));
        }
        galleryEl.innerHTML = '<h2>All screenshots</h2><div class="grid">' + screenshots.map(renderThumb).join('') + '</div>';
        feedbackPair.innerHTML = '<option value="">General screenshot feedback</option>' + orderedPairs.map((pair) => '<option value="' + escapeHtml(pair.key) + '">' + escapeHtml(pair.key) + '</option>').join('');
        feedbackList.innerHTML = (state.feedback ?? []).slice().reverse().map((item) => '<div class="feedback-item"><strong>' + escapeHtml(item.scope) + '</strong> · ' + escapeHtml(item.target || item.pairKey || 'general') + '<br>' + escapeHtml(item.comment) + '</div>').join('');
      }

      scenarioFilter.addEventListener('change', () => {
        if (lastState) renderGallery(lastState);
      });

      feedbackScope.addEventListener('change', () => {
        feedbackTarget.hidden = feedbackScope.value !== 'reusable';
      });

      feedbackSubmit.addEventListener('click', async () => {
        const comment = feedbackComment.value.trim();
        if (!comment) return;
        feedbackSubmit.disabled = true;
        try {
          const response = await fetch(buildUrl('/api/feedback'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ comment, scope: feedbackScope.value, target: feedbackScope.value === 'reusable' ? feedbackTarget.value : null, pairKey: feedbackPair.value || null }) });
          if (!response.ok) throw new Error('feedback save failed');
          feedbackComment.value = '';
          await refresh();
        } finally {
          feedbackSubmit.disabled = false;
        }
      });

      function renderError(message) {
        if (message) {
          errorBox.hidden = false;
          errorBox.textContent = message;
        } else {
          errorBox.hidden = true;
          errorBox.textContent = '';
        }
      }

      function applyState(state) {
        lastState = state;
        renderError(state.error || null);
        renderGallery(state);
      }

      galleryEl.addEventListener('click', (e) => {
        const card = e.target instanceof Element ? e.target.closest('.thumb-card') : null;
        if (!card) return;
        const imgUrl = card.getAttribute('data-img-url');
        const caption = card.getAttribute('data-caption');
        if (imgUrl) openLightbox(imgUrl, caption || '');
      });

      pairsEl.addEventListener('click', (e) => {
        const image = e.target instanceof Element ? e.target.closest('.pair-image') : null;
        if (!image) return;
        const imgUrl = image.getAttribute('data-img-url');
        const caption = image.getAttribute('data-caption');
        if (imgUrl) openLightbox(imgUrl, caption || '');
      });

      pairsEl.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const image = e.target instanceof Element ? e.target.closest('.pair-image') : null;
        if (!image) return;
        e.preventDefault();
        const imgUrl = image.getAttribute('data-img-url');
        const caption = image.getAttribute('data-caption');
        if (imgUrl) openLightbox(imgUrl, caption || '');
      });

      document.addEventListener('error', (e) => {
        const image = e.target instanceof HTMLImageElement ? e.target : null;
        const isGalleryThumbnail = image?.closest('.thumb-img-wrap');
        const isPairImage = image?.classList.contains('pair-image');
        if (!image || image.dataset.loadFailed === 'true' || (!isGalleryThumbnail && !isPairImage)) return;
        image.dataset.loadFailed = 'true';
        image.style.display = 'none';
        const parent = image.parentElement;
        if (!parent || parent.querySelector('.thumb-load-error')) return;
        const fallback = document.createElement('div');
        fallback.className = 'thumb-load-error';
        fallback.textContent = 'Unable to load image';
        parent.appendChild(fallback);
      }, true);

      galleryEl.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const card = e.target instanceof Element ? e.target.closest('.thumb-card') : null;
        if (!card) return;
        e.preventDefault();
        const imgUrl = card.getAttribute('data-img-url');
        const caption = card.getAttribute('data-caption');
        if (imgUrl) openLightbox(imgUrl, caption || '');
      });

      async function loadState(url, options) {
        refreshButton.disabled = true;
        try {
          const response = await fetch(url, options);
          const state = await response.json();
          applyState(state);
        } catch (error) {
          // A dead backend previously left the last-rendered content on screen
          // with no signal, so stale ordering/timestamps looked like live data.
          renderError(
            'Backend unreachable — this panel is showing STALE content from a previous session. ' +
            'Close and reopen the A|B UX Testing canvas to reconnect. (' +
            (error instanceof Error ? error.message : String(error)) + ')'
          );
          liveBadge.hidden = true;
        } finally {
          refreshButton.disabled = false;
        }
      }

      async function refresh() {
        await loadState(refreshUrl, { method: 'POST' });
      }

      refreshButton.addEventListener('click', () => {
        void refresh();
      });

      // SSE live updates
      function subscribeEvents() {
        const events = new EventSource(buildUrl('/events'));
        events.onmessage = (e) => {
          try {
            applyState(JSON.parse(e.data));
          } catch {}
        };
        events.onerror = () => {
          // Fallback to polling if SSE drops
          events.close();
          liveBadge.hidden = true;
          window.setTimeout(subscribeEvents, 5000);
        };
      }

      void loadState(stateUrl);
      subscribeEvents();
      window.setInterval(() => {
        void loadState(stateUrl);
      }, pollIntervalMs);
    </script>
  </body>
</html>`;
}
