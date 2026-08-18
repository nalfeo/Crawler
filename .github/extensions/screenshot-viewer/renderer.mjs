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
    <title>Screenshot Viewer — ${escapeHtml(instanceId)}</title>
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
      .pair-filter { display: flex; align-items: center; gap: 8px; margin: 8px 0 12px; }
      .pair-filter select { width: auto; min-width: 180px; }
      .pair-card, .feedback-panel {
        border: 1px solid var(--border-color-default, #30363d);
        border-radius: 8px;
        padding: 12px;
      }
      .pair-images { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
      .pair-images figure { margin: 0; }
      .pair-image-label { color: var(--text-color-default, #c9d1d9); font-size: 12px; font-weight: 600; margin-bottom: 4px; }
      .pair-change { color: var(--text-color-muted, #8b949e); font-size: 11px; line-height: 1.35; min-height: 30px; margin-bottom: 6px; }
      .pair-images img { width: 100%; aspect-ratio: 16 / 9; object-fit: contain; background: #000; cursor: zoom-in; }
      .pair-images img:focus-visible { outline: 2px solid var(--color-focus-outline, #58a6ff); outline-offset: 2px; }
      figcaption { color: var(--text-color-muted, #8b949e); font-size: 11px; margin-top: 4px; }
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
        <h1>UX Screenshot Review</h1>
        <div class="toolbar">
          <button type="button" id="refresh-button">↻ Refresh</button>
        </div>
      </header>

      <div class="status-bar" id="status-bar">
        <span id="status-text">Loading…</span>
        <span id="live-badge" class="status-badge status-badge--live" hidden>● live</span>
      </div>

      <div class="error-box" id="error-box" hidden></div>

      <div class="pair-filter" aria-label="Comparison filters">
        <label for="pair-scenario">Scenario
          <select id="pair-scenario"><option value="">All scenarios</option></select>
        </label>
        <label for="pair-treatment">Treatment
          <select id="pair-treatment"><option value="">All treatments</option></select>
        </label>
      </div>
      </label>
      <div id="pairs"></div>
      <section class="feedback-panel" aria-labelledby="feedback-heading">
        <strong id="feedback-heading">Capture review feedback</strong>
        <select id="feedback-pair"><option value="">General screenshot feedback</option></select>
        <select id="feedback-scope">
          <option value="task">This task only</option>
          <option value="reusable">Promote to reusable guidance</option>
        </select>
        <select id="feedback-target" hidden>
          <option value="ux-agent">UX Designer agent</option>
          <option value="visual-review-skill">Visual review skill</option>
          <option value="deterministic-eval">Deterministic evaluation</option>
          <option value="workflow">Review workflow</option>
        </select>
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
      const pairScenario = document.getElementById('pair-scenario');
      const pairTreatment = document.getElementById('pair-treatment');
      let latestState = null;

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

      function renderGallery(state) {
        latestState = state;
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

        const pairs = Array.isArray(state.pairs) ? state.pairs : [];
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

        const comparablePairs = pairs.filter((pair) => pair.before && pair.after);
        const scenarios = [...new Set(comparablePairs.map((pair) => pair.scenario || 'Other'))].sort();
        const treatments = [...new Set(comparablePairs.map((pair) => pair.treatment || 'Other'))].sort();
        const selectedScenario = pairScenario.value;
        const selectedTreatment = pairTreatment.value;
        pairScenario.innerHTML = '<option value="">All scenarios</option>' + scenarios.map((scenario) => '<option value="' + escapeHtml(scenario) + '">' + escapeHtml(scenario) + '</option>').join('');
        pairScenario.value = scenarios.includes(selectedScenario) ? selectedScenario : '';
        pairTreatment.innerHTML = '<option value="">All treatments</option>' + treatments.map((treatment) => '<option value="' + escapeHtml(treatment) + '">' + escapeHtml(treatment) + '</option>').join('');
        pairTreatment.value = treatments.includes(selectedTreatment) ? selectedTreatment : '';
        const visiblePairs = comparablePairs.filter(
          (pair) =>
            (!pairScenario.value || (pair.scenario || 'Other') === pairScenario.value) &&
            (!pairTreatment.value || (pair.treatment || 'Other') === pairTreatment.value),
        );
        const pairHtml = visiblePairs.map((pair) => {
          const reviewMeta = (review) => review
            ? '<div class="meta"><strong>UX ' + escapeHtml(review.score) + '/100</strong> · evidence ' + escapeHtml(review.coverage) + '%<br>Hard failures: ' + escapeHtml(review.hardFailures.length) + '<br>' + review.findings.slice(0, 3).map(escapeHtml).join('<br>') + '</div>'
            : '<div class="meta">Unjudged — no Azure review artifact was saved for this capture.</div>';
          const taskLabel = pair.key.replace(/\s+\([^)]*\)$/, '');
          const image = (side) =>
            '<figure><div class="pair-image-label">' + escapeHtml(side === 'before' && pair.states?.before === 'main' ? 'Main' : taskLabel.replace(/\b\w/g, (char) => char.toUpperCase()) + ' (' + (pair.states?.[side] ?? 'missing').toUpperCase() + ')') + '</div><div class="pair-change">' + escapeHtml(pair.descriptions?.[side] ?? 'No change note is available.') + '</div><img class="pair-image" tabindex="0" role="button" src="' + escapeHtml(buildImgUrl(pair[side].path)) + '" alt="' + side + ' ' + escapeHtml(pair.key) + '" aria-label="Zoom ' + side + ' screenshot for ' + escapeHtml(pair.key) + '" data-img-url="' + escapeHtml(buildImgUrl(pair[side].path)) + '" data-caption="' + escapeHtml(pair[side].path) + '"><figcaption>' + side + ' · click to zoom</figcaption>' + reviewMeta(pair.reviews?.[side]) + '</figure>';
          const stateLabel = (state) => state ? state.replace(/[-_]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()) : 'Missing';
          const beforeState = stateLabel(pair.states?.before);
          const afterState = stateLabel(pair.states?.after);
          return '<article class="pair-card"><strong>' + escapeHtml(beforeState + ' | ' + afterState) + '</strong><div class="pair-state">' + escapeHtml((pair.scenario || pair.treatment || 'Other') + ' · ' + pair.key) + '</div><div class="pair-images">' + image('before') + image('after') + '</div></article>';
        }).join('');
        pairsEl.innerHTML = pairHtml ? '<h2>Before / After</h2><div class="pair-grid">' + pairHtml + '</div>' : '';
        galleryEl.innerHTML = '<h2>All screenshots</h2><div class="grid">' + screenshots.map(renderThumb).join('') + '</div>';
        feedbackPair.innerHTML = '<option value="">General screenshot feedback</option>' + comparablePairs.map((pair) => '<option value="' + escapeHtml(pair.key) + '">' + escapeHtml(pair.key) + '</option>').join('');
        feedbackList.innerHTML = (state.feedback ?? []).slice().reverse().map((item) => '<div class="feedback-item"><strong>' + escapeHtml(item.scope) + '</strong> · ' + escapeHtml(item.target || item.pairKey || 'general') + '<br>' + escapeHtml(item.comment) + '</div>').join('');
      }

      feedbackScope.addEventListener('change', () => {
        feedbackTarget.hidden = feedbackScope.value !== 'reusable';
      });

      const rerenderPairs = () => {
        if (latestState) renderGallery(latestState);
      };
      pairScenario.addEventListener('change', rerenderPairs);
      pairTreatment.addEventListener('change', rerenderPairs);

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
          renderError(error instanceof Error ? error.message : String(error));
        } finally {
          refreshButton.disabled = false;
        }
      }

      refreshButton.addEventListener('click', () => {
        void loadState(refreshUrl, { method: 'POST' });
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
