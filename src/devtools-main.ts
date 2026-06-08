const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function render(): void {
  const root = document.getElementById('devtools-root');
  if (!(root instanceof HTMLElement)) {
    throw new Error('Missing #devtools-root host element');
  }

  const panel = document.createElement('section');
  panel.className = 'panel';

  const title = document.createElement('h1');
  title.textContent = 'Crawler DevTools';

  const body = document.createElement('p');
  body.textContent = LOCAL_HOSTS.has(window.location.hostname)
    ? 'DevTools is local-only. Add tool modules here as this surface grows.'
    : 'DevTools is disabled outside localhost.';

  panel.append(title, body);
  root.replaceChildren(panel);
}

render();
