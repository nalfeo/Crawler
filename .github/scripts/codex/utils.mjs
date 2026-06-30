import fs from 'node:fs';
import path from 'node:path';

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function getEnv(name, fallback = undefined) {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return value;
}

export function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function loadRepoConfig(workspace) {
  const configPath = path.join(workspace, '.github', 'codex-repair.json');
  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

export async function githubRequest(
  urlPath,
  { method = 'GET', body, accept = 'application/vnd.github+json' } = {},
) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN is required');
  }

  const apiBase = getEnv('GITHUB_API_URL', 'https://api.github.com');
  const response = await fetch(apiBase + urlPath, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      'GitHub API ' + method + ' ' + urlPath + ' failed (' + response.status + '): ' + text,
    );
  }

  if (response.status === 204) {
    return null;
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }

  return response.text();
}

function parseNextPageUrl(linkHeader) {
  if (!linkHeader) {
    return null;
  }
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) {
      return match[1];
    }
  }
  return null;
}

/**
 * GET a paginated GitHub list endpoint, following the `Link: rel="next"` header
 * until exhausted (or `maxPages` is reached, as a runaway guard). `extract` pulls
 * the array out of each page payload — identity for bare-array responses (e.g.
 * issue comments), or `(page) => page.check_runs` for the check-runs envelope.
 * Returns the concatenated items across all pages.
 */
export async function githubPaginate(urlPath, { extract = (page) => page, maxPages = 50 } = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN is required');
  }

  const apiBase = getEnv('GITHUB_API_URL', 'https://api.github.com');
  let url = urlPath.startsWith('http') ? urlPath : apiBase + urlPath;
  const items = [];

  for (let page = 0; url && page < maxPages; page += 1) {
    const response = await fetch(url, {
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error('GitHub API GET ' + url + ' failed (' + response.status + '): ' + text);
    }

    const pageItems = extract(await response.json());
    if (Array.isArray(pageItems)) {
      items.push(...pageItems);
    }

    url = parseNextPageUrl(response.headers.get('link'));
  }

  return items;
}

export async function githubGraphql(query, variables = {}, { token } = {}) {
  const authToken = token || process.env.GITHUB_TOKEN;
  if (!authToken) {
    throw new Error('GITHUB_TOKEN is required');
  }

  const apiBase = getEnv('GITHUB_API_URL', 'https://api.github.com');
  const response = await fetch(apiBase + '/graphql', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + authToken,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = await response.json();
  if (!response.ok || payload.errors) {
    throw new Error('GitHub GraphQL failed: ' + JSON.stringify(payload.errors || payload));
  }

  return payload.data;
}

export function statusStateMarkerRegex() {
  return /<!--\s*codex-repair-state:\s*(\{[\s\S]*?\})\s*-->/m;
}

export function parseStatusStateFromBody(body) {
  const regex = statusStateMarkerRegex();
  const match = String(body || '').match(regex);
  if (!match) {
    return null;
  }

  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

export function isExplicitCommand(command) {
  return typeof command === 'string' && command.startsWith('/codex');
}

function parseIntEnv(value, fallback) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Cost guardrail budgets for the auto-healer. Auto (non-explicit) repairs that
 * exceed any budget are bounced to a human instead of spending model tokens.
 * Set a budget to a negative number to disable that individual dimension, or
 * set CODEX_BOUNCE_ENABLED=false to disable bouncing entirely.
 */
export function getRepairBudgets(env = process.env) {
  return {
    enabled: parseBoolean(env.CODEX_BOUNCE_ENABLED, true),
    maxChangedFiles: parseIntEnv(env.CODEX_BOUNCE_MAX_CHANGED_FILES, 20),
    maxDiffLines: parseIntEnv(env.CODEX_BOUNCE_MAX_DIFF_LINES, 1500),
    maxFailingChecks: parseIntEnv(env.CODEX_BOUNCE_MAX_FAILING_CHECKS, 6),
  };
}

/**
 * Pure complexity/cost evaluation. Given cheap pre-flight metrics (PR diff size,
 * changed-file count, failing-check count) and budgets, decide whether the
 * repair is too expensive/complex for the auto-healer and should be bounced.
 */
export function evaluateRepairComplexity(metrics = {}, budgets = getRepairBudgets()) {
  const changedFiles = Number(metrics.changedFiles || 0);
  const diffLines = Number(metrics.additions || 0) + Number(metrics.deletions || 0);
  const failingChecks = Number(metrics.failingChecks || 0);

  const reasons = [];
  if (budgets.maxChangedFiles >= 0 && changedFiles > budgets.maxChangedFiles) {
    reasons.push(`${changedFiles} changed files exceeds budget of ${budgets.maxChangedFiles}`);
  }
  if (budgets.maxDiffLines >= 0 && diffLines > budgets.maxDiffLines) {
    reasons.push(`${diffLines} changed lines exceeds budget of ${budgets.maxDiffLines}`);
  }
  if (budgets.maxFailingChecks >= 0 && failingChecks > budgets.maxFailingChecks) {
    reasons.push(`${failingChecks} failing checks exceeds budget of ${budgets.maxFailingChecks}`);
  }

  return {
    tooComplex: Boolean(budgets.enabled) && reasons.length > 0,
    reasons,
    metrics: { changedFiles, diffLines, failingChecks },
    budgets,
  };
}
