function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderHtml({ instanceId, pollIntervalMs }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Screenshot Viewer — ${escapeHtml(instanceId)}</title>
    <style>
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      body { margin: 0; padding: 16px; background: var(--background-color-default, #0d1117); color: var(--text-color-default, #c9d1d9); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
      h1 { margin: 0; font-size: 20px; }
      button { min-height: 32px; padding: 4px 12px; border: 1px solid var(--border-color-default, #30363d); border-radius: 5px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
      button:hover { border-color: #58a6ff; }
      #status { margin-bottom: 12px; color: var(--text-color-muted, #8b949e); font-size: 12px; }
      .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
      .card { overflow: hidden; border: 1px solid var(--border-color-default, #30363d); border-radius: 8px; cursor: zoom-in; }
      .card img { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: contain; background: #000; }
      .meta { padding: 8px; font-size: 12px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
      .empty { padding: 32px; border: 1px dashed var(--border-color-default, #30363d); text-align: center; color: var(--text-color-muted, #8b949e); }
      dialog { width: min(96vw, 1400px); max-height: 96vh; padding: 12px; background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 8px; }
      dialog::backdrop { background: rgba(0, 0, 0, .84); }
      dialog img { display: block; max-width: 100%; max-height: calc(96vh - 64px); margin: 8px auto 0; object-fit: contain; }
    </style>
  </head>
  <body>
    <header><h1>All Screenshots</h1><button type="button" id="refresh">Refresh</button></header>
    <div id="status">Loading…</div>
    <main id="gallery"></main>
    <dialog id="lightbox"><button type="button" id="close">Close</button><img id="lightbox-image" alt="Screenshot" /></dialog>
    <script>
      const token = new URLSearchParams(location.search).get('token') ?? '';
      const url = (path, params = {}) => {
        const query = new URLSearchParams({ ...params, token });
        return path + '?' + query;
      };
      const gallery = document.getElementById('gallery');
      const status = document.getElementById('status');
      const lightbox = document.getElementById('lightbox');
      const lightboxImage = document.getElementById('lightbox-image');
      const esc = ${escapeHtml.toString()};
      const time = (value) => value ? new Date(value).toLocaleString() : '';
      function render(state) {
        const shots = Array.isArray(state.screenshots) ? state.screenshots : [];
        status.textContent = shots.length === 1 ? '1 screenshot' : shots.length + ' screenshots';
        gallery.innerHTML = shots.length
          ? '<div class="grid">' + shots.map((shot) => '<article class="card" data-path="' + esc(shot.path) + '"><img loading="lazy" src="' + esc(url('/img', { path: shot.path })) + '" alt="' + esc(shot.filename) + '"><div class="meta" title="' + esc(shot.path) + '">' + esc(shot.filename) + '<br>' + esc(time(shot.takenAt)) + '</div></article>').join('') + '</div>'
          : '<div class="empty">No screenshots yet.</div>';
      }
      async function load(method = 'GET') {
        const response = await fetch(url(method === 'POST' ? '/api/refresh' : '/api/state'), { method });
        render(await response.json());
      }
      document.getElementById('refresh').addEventListener('click', () => load('POST'));
      document.getElementById('close').addEventListener('click', () => lightbox.close());
      gallery.addEventListener('click', (event) => {
        const card = event.target.closest('.card');
        if (!card) return;
        lightboxImage.src = url('/img', { path: card.dataset.path });
        lightbox.showModal();
      });
      const events = new EventSource(url('/events'));
      events.onmessage = (event) => render(JSON.parse(event.data));
      void load();
      setInterval(load, ${JSON.stringify(pollIntervalMs)});
    </script>
  </body>
</html>`;
}
