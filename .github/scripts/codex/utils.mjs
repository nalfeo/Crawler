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

export async function githubGraphql(query, variables = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN is required');
  }

  const apiBase = getEnv('GITHUB_API_URL', 'https://api.github.com');
  const response = await fetch(apiBase + '/graphql', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
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
