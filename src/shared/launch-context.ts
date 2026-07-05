export interface LaunchContext {
  sessionName: string | null;
  branchName: string | null;
  pullRequestNumber: number | null;
  pullRequestTitle: string | null;
  pullRequestUrl: string | null;
}

const LAUNCH_QUERY_KEYS = {
  sessionName: 'launchSession',
  branchName: 'launchBranch',
  pullRequestNumber: 'launchPrNumber',
  pullRequestTitle: 'launchPrTitle',
  pullRequestUrl: 'launchPrUrl',
} as const;

function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseOptionalNumber(value: string | null): number | null {
  const trimmed = cleanString(value);
  if (!trimmed) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseLaunchContext(search: string | URLSearchParams): LaunchContext | null {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const sessionName = cleanString(params.get('launchSession'));
  const branchName = cleanString(params.get('launchBranch'));
  const pullRequestNumber = parseOptionalNumber(params.get('launchPrNumber'));
  const pullRequestTitle = cleanString(params.get('launchPrTitle'));
  const pullRequestUrl = cleanString(params.get('launchPrUrl'));

  if (
    !sessionName &&
    !branchName &&
    pullRequestNumber === null &&
    !pullRequestTitle &&
    !pullRequestUrl
  ) {
    return null;
  }

  return {
    sessionName,
    branchName,
    pullRequestNumber,
    pullRequestTitle,
    pullRequestUrl,
  };
}

export function describeLaunchContext(context: LaunchContext): string[] {
  const lines: string[] = [];
  if (context.sessionName) {
    lines.push(`Session: ${context.sessionName}`);
  }
  if (context.branchName) {
    lines.push(`Branch: ${context.branchName}`);
  }
  if (context.pullRequestNumber !== null) {
    const title = context.pullRequestTitle ? ` — ${context.pullRequestTitle}` : '';
    lines.push(`PR #${context.pullRequestNumber}${title}`);
  } else if (context.pullRequestTitle) {
    lines.push(`PR: ${context.pullRequestTitle}`);
  }
  return lines;
}

export function mergeLaunchContextSearch(search: string, context: LaunchContext | null): string {
  if (!context) {
    return search;
  }

  const params = new URLSearchParams(search);
  if (context.sessionName) {
    params.set(LAUNCH_QUERY_KEYS.sessionName, context.sessionName);
  }
  if (context.branchName) {
    params.set(LAUNCH_QUERY_KEYS.branchName, context.branchName);
  }
  if (context.pullRequestNumber !== null) {
    params.set(LAUNCH_QUERY_KEYS.pullRequestNumber, String(context.pullRequestNumber));
  }
  if (context.pullRequestTitle) {
    params.set(LAUNCH_QUERY_KEYS.pullRequestTitle, context.pullRequestTitle);
  }
  if (context.pullRequestUrl) {
    params.set(LAUNCH_QUERY_KEYS.pullRequestUrl, context.pullRequestUrl);
  }

  const nextSearch = params.toString();
  return nextSearch ? `?${nextSearch}` : '';
}

export function appendLaunchContextToUrl(url: URL, context: LaunchContext | null): URL {
  if (!context) {
    return url;
  }

  url.search = mergeLaunchContextSearch(url.search, context);
  return url;
}

export function normalizeHttpUrl(rawUrl: string | null | undefined): string | null {
  const candidate = cleanString(rawUrl);
  if (!candidate) {
    return null;
  }

  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}
