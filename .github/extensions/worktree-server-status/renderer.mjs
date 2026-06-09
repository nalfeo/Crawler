function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderHtml({ instanceId, pollIntervalMs, workspacePath }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Worktree Server</title>
    <style>
      :root {
        color-scheme: light dark;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        background: var(--background-color-default, #ffffff);
        color: var(--text-color-default, #1f2328);
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
        padding: 20px;
      }

      h1 {
        margin: 0;
        font-size: var(--text-title-large, 26px);
        line-height: var(--leading-title-large, 32px);
        font-weight: var(--font-weight-semibold, 600);
      }

      .subtitle {
        margin-top: 6px;
        color: var(--text-color-muted, #59636e);
        word-break: break-word;
      }

      .toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        align-items: center;
        justify-content: space-between;
        margin: 20px 0 16px;
      }

      button {
        border: 1px solid var(--border-color-default, #d1d9e0);
        border-radius: 10px;
        padding: 10px 14px;
        background: var(--background-color-default, #ffffff);
        color: inherit;
        font: inherit;
        cursor: pointer;
      }

      button:focus-visible,
      a:focus-visible {
        outline: 2px solid var(--color-focus-outline, #0969da);
        outline-offset: 2px;
      }

      .meta {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        color: var(--text-color-muted, #59636e);
      }

      .summary,
      .empty,
      .error {
        border: 1px solid var(--border-color-default, #d1d9e0);
        border-radius: 12px;
        padding: 14px 16px;
        background: color-mix(in srgb, var(--background-color-default, #ffffff) 92%, transparent);
      }

      .error {
        margin-bottom: 16px;
        border-color: var(--true-color-red, #cf222e);
        background: color-mix(in srgb, var(--true-color-red-muted, #ffebe9) 45%, transparent);
      }

      .stack {
        display: grid;
        gap: 16px;
      }

      .servers {
        display: grid;
        gap: 16px;
        margin-top: 16px;
      }

      .server-card {
        border: 1px solid var(--border-color-default, #d1d9e0);
        border-radius: 16px;
        padding: 16px;
        display: grid;
        gap: 14px;
      }

      .server-header {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
        justify-content: space-between;
      }

      .server-title {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
      }

      .badge {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 2px 10px;
        border: 1px solid var(--border-color-default, #d1d9e0);
        font-size: 12px;
        line-height: 18px;
      }

      .badge--ok {
        border-color: var(--true-color-blue, #0969da);
        color: var(--true-color-blue, #0969da);
        background: color-mix(in srgb, var(--true-color-blue-muted, #ddf4ff) 45%, transparent);
      }

      .badge--muted {
        color: var(--text-color-muted, #59636e);
      }

      .server-url {
        font-family: var(
          --font-mono,
          "SFMono-Regular",
          Consolas,
          "Liberation Mono",
          monospace
        );
        word-break: break-all;
      }

      .links {
        display: grid;
        gap: 10px;
      }

      .link-grid {
        display: grid;
        gap: 10px;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      }

      .route-card {
        border: 1px solid var(--border-color-default, #d1d9e0);
        border-radius: 12px;
        padding: 12px;
        display: grid;
        gap: 8px;
      }

      .route-card--missing {
        opacity: 0.72;
      }

      .route-card a {
        color: var(--true-color-blue, #0969da);
        text-decoration: none;
        word-break: break-all;
      }

      details {
        border-top: 1px solid var(--border-color-default, #d1d9e0);
        padding-top: 10px;
      }

      summary {
        cursor: pointer;
        color: var(--text-color-muted, #59636e);
      }

      pre {
        margin: 10px 0 0;
        white-space: pre-wrap;
        word-break: break-word;
        font-family: var(
          --font-mono,
          "SFMono-Regular",
          Consolas,
          "Liberation Mono",
          monospace
        );
        font-size: var(--text-code-inline, 12px);
      }
    </style>
  </head>
  <body>
    <main>
      <div class="stack">
        <header>
          <h1>Worktree Server</h1>
          <div class="subtitle">${escapeHtml(workspacePath)}</div>
        </header>

        <div class="toolbar">
          <div class="meta" id="meta">
            <span>Instance ${escapeHtml(instanceId)}</span>
            <span>Polling every ${escapeHtml(pollIntervalMs / 1000)}s</span>
          </div>
          <button type="button" id="refresh-button">Refresh now</button>
        </div>

        <section id="error" class="error" hidden></section>
        <section id="summary" class="summary">Loading live server state…</section>
        <section id="servers" class="servers"></section>
      </div>
    </main>

    <script>
      const stateUrl = '/api/state';
      const refreshUrl = '/api/refresh';
      const pollIntervalMs = ${JSON.stringify(pollIntervalMs)};

      const summaryEl = document.getElementById('summary');
      const serversEl = document.getElementById('servers');
      const errorEl = document.getElementById('error');
      const refreshButton = document.getElementById('refresh-button');

      function escapeHtml(value) {
        return String(value)
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;');
      }

      function renderRoute(route) {
        const statusBits = [];
        if (route.status !== null && route.status !== undefined) {
          statusBits.push('HTTP ' + route.status);
        }
        if (route.title) {
          statusBits.push('title: ' + route.title);
        }
        if (route.error) {
          statusBits.push(route.error);
        }

        return \`
          <article class="route-card \${route.available ? '' : 'route-card--missing'}">
            <div class="server-header">
              <strong>\${escapeHtml(route.label)}</strong>
              <span class="badge \${route.available ? 'badge--ok' : 'badge--muted'}">
                \${route.available ? 'available' : 'unavailable'}
              </span>
            </div>
            <a href="\${escapeHtml(route.url)}" target="_blank" rel="noreferrer">\${escapeHtml(route.url)}</a>
            <div class="meta">\${statusBits.map((bit) => '<span>' + escapeHtml(bit) + '</span>').join('')}</div>
          </article>
        \`;
      }

      function renderServer(server) {
        const commandLines = Array.isArray(server.matchedCommandLines) ? server.matchedCommandLines : [];
        const commandMarkup =
          commandLines.length > 0
            ? \`
                <details>
                  <summary>Matched launch commands</summary>
                  <pre>\${escapeHtml(commandLines.join('\\n\\n'))}</pre>
                </details>
              \`
            : '';

        return \`
          <article class="server-card">
            <div class="server-header">
              <div class="server-title">
                <strong>\${escapeHtml(server.modeLabel)}</strong>
                <span class="badge \${server.verified ? 'badge--ok' : 'badge--muted'}">
                  \${server.verified ? 'active' : 'unverified'}
                </span>
              </div>
              <span class="badge badge--muted">port \${escapeHtml(server.port)}</span>
            </div>
            <div class="server-url">\${escapeHtml(server.baseUrl)}</div>
            <div class="meta">
              <span>listen address: \${escapeHtml(server.localAddress)}</span>
              <span>owner PID: \${escapeHtml(server.owningProcess)}</span>
              <span>verified routes: \${escapeHtml(server.availableRouteCount)}</span>
            </div>
            <div class="links">
              <div class="link-grid">\${server.routes.map(renderRoute).join('')}</div>
            </div>
            \${commandMarkup}
          </article>
        \`;
      }

      function renderState(state) {
        const count = Number(state.activeServerCount || 0);
        const scannedAt = state.scannedAt ? new Date(state.scannedAt).toLocaleTimeString() : 'unknown';
        summaryEl.innerHTML = count > 0
          ? '<strong>' + escapeHtml(count) + '</strong> active worktree server' + (count === 1 ? '' : 's') + ' detected. <span class="meta"><span>Last scan: ' + escapeHtml(scannedAt) + '</span></span>'
          : 'No live Vite server matched this worktree on the last scan.';

        if (state.error) {
          errorEl.hidden = false;
          errorEl.textContent = state.error;
        } else {
          errorEl.hidden = true;
          errorEl.textContent = '';
        }

        const servers = Array.isArray(state.servers) ? state.servers : [];
        serversEl.innerHTML = servers.map(renderServer).join('');
      }

      async function loadState(url, options) {
        refreshButton.disabled = true;
        try {
          const response = await fetch(url, options);
          const state = await response.json();
          renderState(state);
        } catch (error) {
          renderState({
            activeServerCount: 0,
            servers: [],
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          refreshButton.disabled = false;
        }
      }

      refreshButton.addEventListener('click', () => {
        void loadState(refreshUrl, { method: 'POST' });
      });

      void loadState(stateUrl);
      window.setInterval(() => {
        void loadState(stateUrl);
      }, pollIntervalMs);
    </script>
  </body>
</html>`;
}
