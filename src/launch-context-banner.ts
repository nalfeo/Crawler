import {
  appendLaunchContextToUrl,
  describeLaunchContext,
  normalizeHttpUrl,
  parseLaunchContext,
} from './shared/launch-context.js';

const BANNER_STYLE_ID = 'launch-context-banner-style';
const BANNER_STORAGE_PREFIX = 'crawler-launch-context-dismissed:';

function getDismissKey(context: ReturnType<typeof parseLaunchContext>): string {
  const sessionName = context?.sessionName ?? '';
  const branchName = context?.branchName ?? '';
  const pullRequestNumber = context?.pullRequestNumber ?? '';
  return `${BANNER_STORAGE_PREFIX}${sessionName}:${branchName}:${pullRequestNumber}`;
}

function ensureStyles(): void {
  if (document.getElementById(BANNER_STYLE_ID)) {
    return;
  }

  const style = document.createElement('style');
  style.id = BANNER_STYLE_ID;
  style.textContent = `
    .launch-context-banner {
      position: fixed;
      top: 16px;
      right: 16px;
      z-index: 10000;
      width: min(420px, calc(100vw - 32px));
      border: 1px solid rgba(59, 130, 246, 0.35);
      border-radius: 14px;
      background: rgba(15, 23, 42, 0.96);
      color: #e2e8f0;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.35);
      padding: 14px 16px 16px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
    }

    .launch-context-banner__header {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 10px;
    }

    .launch-context-banner__title {
      font-size: 13px;
      font-weight: 700;
      color: #93c5fd;
      letter-spacing: 0.02em;
    }

    .launch-context-banner__dismiss {
      appearance: none;
      border: 1px solid rgba(148, 163, 184, 0.35);
      border-radius: 999px;
      background: transparent;
      color: inherit;
      font: inherit;
      cursor: pointer;
      padding: 4px 9px;
      line-height: 1;
    }

    .launch-context-banner__details {
      display: grid;
      gap: 6px;
      font-size: 12px;
      line-height: 1.45;
      color: #cbd5e1;
      word-break: break-word;
    }

    .launch-context-banner__details a {
      color: #7dd3fc;
      text-decoration: none;
    }

    .launch-context-banner__hint {
      margin-top: 10px;
      font-size: 11px;
      color: #94a3b8;
    }
  `;

  document.head.appendChild(style);
}

function preserveLaunchContextOnLinks(context: ReturnType<typeof parseLaunchContext>): void {
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const rawHref = anchor.getAttribute('href');
    if (!rawHref) {
      continue;
    }

    let url: URL;
    try {
      url = new URL(rawHref, window.location.href);
    } catch {
      continue;
    }

    if (url.origin !== window.location.origin) {
      continue;
    }

    anchor.href = appendLaunchContextToUrl(url, context).toString();
  }
}

function watchForNewLinks(context: ReturnType<typeof parseLaunchContext>): MutationObserver {
  const observer = new MutationObserver(() => {
    preserveLaunchContextOnLinks(context);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return observer;
}

export function renderLaunchContextBanner(): void {
  const context = parseLaunchContext(window.location.search);
  if (!context || !document.body) {
    return;
  }

  const dismissKey = getDismissKey(context);
  try {
    if (window.sessionStorage.getItem(dismissKey) === '1') {
      return;
    }
  } catch {
    // If storage is unavailable, still show the banner.
  }

  const existing = document.querySelector<HTMLElement>('[data-launch-context-banner="true"]');
  if (existing) {
    return;
  }

  ensureStyles();
  preserveLaunchContextOnLinks(context);
  const observer = watchForNewLinks(context);

  const banner = document.createElement('aside');
  banner.dataset.launchContextBanner = 'true';
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');
  banner.className = 'launch-context-banner';

  const lines = describeLaunchContext(context);
  const details =
    lines.length > 0 ? lines : ['Launch context was provided, but no details were available.'];
  const header = document.createElement('div');
  header.className = 'launch-context-banner__header';

  const title = document.createElement('div');
  title.className = 'launch-context-banner__title';
  title.textContent = 'Related launch';

  const dismissButton = document.createElement('button');
  dismissButton.type = 'button';
  dismissButton.className = 'launch-context-banner__dismiss';
  dismissButton.setAttribute('aria-label', 'Dismiss launch context popup');
  dismissButton.textContent = 'Dismiss';

  header.append(title, dismissButton);

  const detailsEl = document.createElement('div');
  detailsEl.className = 'launch-context-banner__details';

  for (const line of details) {
    const entry = document.createElement('div');
    entry.textContent = line;
    detailsEl.appendChild(entry);
  }

  const prEntry = document.createElement('div');
  const prUrl = normalizeHttpUrl(context.pullRequestUrl);
  if (context.pullRequestNumber !== null && prUrl) {
    const link = document.createElement('a');
    link.href = prUrl;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = `Open PR #${context.pullRequestNumber}`;
    prEntry.appendChild(link);
  } else if (context.pullRequestNumber !== null) {
    prEntry.textContent = `PR #${context.pullRequestNumber}`;
  } else if (context.pullRequestTitle) {
    prEntry.textContent = context.pullRequestTitle;
  } else {
    prEntry.textContent = 'No open PR found for this branch.';
  }
  detailsEl.appendChild(prEntry);

  const hint = document.createElement('div');
  hint.className = 'launch-context-banner__hint';
  hint.textContent = 'This popup is tied to the launch session and can be dismissed.';

  banner.append(header, detailsEl, hint);

  const dismiss = (): void => {
    try {
      window.sessionStorage.setItem(dismissKey, '1');
    } catch {
      // Ignore storage write failures.
    }
    observer.disconnect();
    banner.remove();
  };

  dismissButton?.addEventListener('click', dismiss);
  banner.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      dismiss();
    }
  });

  document.body.appendChild(banner);
}
