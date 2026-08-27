import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repo = process.env.GITHUB_REPOSITORY || 'nalfeo/Crawler';
const token = process.env.GH_TOKEN || process.env.CRAWLER_CI_PAT || process.env.GITHUB_TOKEN;
const resultFile = process.env.GOOBERS_RESULT_FILE || 'requirements-result.json';
const contextRoot = path.resolve('.goobers', 'context');

function readContextFiles(dir) {
  const out = [];
  try {
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const fullPath = path.join(entry.parentPath ?? dir, entry.name);
      out.push({ path: fullPath, content: readFileSync(fullPath, 'utf8') });
    }
  } catch (error) {
    throw new Error(`failed to read ${contextRoot}: ${error.message}`);
  }
  return out;
}

function findIssueNumber(files) {
  for (const file of files) {
    const jsonMatch = file.content.match(/"number"\s*:\s*(\d+)/);
    if (jsonMatch) return jsonMatch[1];

    const claimedMatch = file.content.match(/\bclaimed\s+(\d+)\b/i);
    if (claimedMatch) return claimedMatch[1];

    const issueMatch = file.content.match(/issues\/(\d+)\b/i);
    if (issueMatch) return issueMatch[1];
  }
  return null;
}

async function fetchIssue(number) {
  if (!token) {
    throw new Error(
      'GH_TOKEN, CRAWLER_CI_PAT, or GITHUB_TOKEN is required to fetch issue requirements',
    );
  }

  const response = await fetch(`https://api.github.com/repos/${repo}/issues/${number}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'crawler-goobers-hydrate-requirements',
    },
  });

  if (!response.ok) {
    throw new Error(
      `failed to fetch ${repo}#${number}: ${response.status} ${await response.text()}`,
    );
  }

  return response.json();
}

function renderMarkdown(issue) {
  const labels = (issue.labels ?? []).map((label) => label.name).join(', ') || 'none';
  return [
    `# Claimed issue requirements`,
    ``,
    `- Repository: ${repo}`,
    `- Issue: #${issue.number} ${issue.title}`,
    `- URL: ${issue.html_url}`,
    `- Labels: ${labels}`,
    ``,
    `## Body`,
    ``,
    issue.body || '(empty)',
    ``,
  ].join('\n');
}

const files = readContextFiles(contextRoot);
const issueNumber = findIssueNumber(files);
if (!issueNumber) {
  throw new Error(`could not find a claimed issue number in ${contextRoot}`);
}

const issue = await fetchIssue(issueNumber);
const body = renderMarkdown(issue);

mkdirSync(path.dirname(resultFile), { recursive: true });
writeFileSync('requirements.md', body);
writeFileSync(
  resultFile,
  JSON.stringify(
    {
      schema: 'crawler.goobers.requirements/v1',
      issueNumber: String(issue.number),
      issueTitle: issue.title,
      issueUrl: issue.html_url,
      requirementsFile: 'requirements.md',
      requirements: body,
    },
    null,
    2,
  ),
);

console.log(body);
