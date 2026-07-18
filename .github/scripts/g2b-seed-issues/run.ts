import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  FLOOR2_EQUIPMENT_ART_DEFINITIONS,
  type Floor2EquipmentArtDefinition,
} from '../../../src/shared/data/floor2-equipment-art.js';

const REPO_OWNER = 'nalfeo';
const REPO_NAME = 'Crawler';
const ASSET_REQUEST_LABEL = 'asset-request';
const AGGREGATE_ISSUE_NUMBER = 1303;
const EXPECTED_WAVE_COUNT = 15;

interface GitHubLabel {
  name?: string;
}

interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  labels: GitHubLabel[];
  pull_request?: unknown;
}

interface IssueSpec {
  slug: string;
  title: string;
  body: string;
  stableId: string;
  productionWaveId: string;
}

interface ValidationResult {
  problems: string[];
  waveCounts: Map<string, number>;
}

interface ExistingIssueSyncPlan {
  needsLabel: boolean;
  needsBodyUpdate: boolean;
}

function slugFromStableId(stableId: string): string {
  const separator = stableId.indexOf('.');
  return separator >= 0 ? stableId.slice(separator + 1) : stableId;
}

export function buildIssueBody(definition: Floor2EquipmentArtDefinition): string {
  return [
    '### Name',
    slugFromStableId(definition.stableId),
    '',
    '### Brief',
    definition.briefInput.description,
    '',
    '### Type (optional)',
    definition.briefInput.type,
    '',
    '### Floor (optional)',
    '',
    '_No response_',
    '',
    '### Size (optional)',
    '',
    '_No response_',
    '',
    '---',
    '**Floor 2 equipment manifest metadata** (generated from `FLOOR2_EQUIPMENT_ART_DEFINITIONS`, do not edit):',
    `- Stable ID: \`${definition.stableId}\``,
    `- Runtime key: \`${definition.runtimeKey}\``,
    `- Production wave: \`${definition.productionWaveId}\``,
    `- Aggregate tracking issue: #${AGGREGATE_ISSUE_NUMBER}`,
  ].join('\n');
}

export function buildExpectedIssueSpecs(
  definitions: readonly Floor2EquipmentArtDefinition[] = FLOOR2_EQUIPMENT_ART_DEFINITIONS,
): IssueSpec[] {
  return definitions.map((definition) => {
    const slug = slugFromStableId(definition.stableId);
    return {
      slug,
      title: `Asset request: ${slug}`,
      body: buildIssueBody(definition),
      stableId: definition.stableId,
      productionWaveId: definition.productionWaveId,
    };
  });
}

function issueLabels(issue: GitHubIssue): string[] {
  return issue.labels.map((label) => label.name ?? '').filter((name) => name.length > 0);
}

export function planExistingIssueSync(issue: GitHubIssue, spec: IssueSpec): ExistingIssueSyncPlan {
  return {
    needsLabel: !issueLabels(issue).includes(ASSET_REQUEST_LABEL),
    needsBodyUpdate: issue.body !== spec.body,
  };
}

export function validateIssueSet(
  issues: readonly GitHubIssue[],
  expectedSpecs: readonly IssueSpec[] = buildExpectedIssueSpecs(),
): ValidationResult {
  const byTitle = new Map<string, GitHubIssue[]>();
  for (const issue of issues) {
    const existing = byTitle.get(issue.title);
    if (existing) {
      existing.push(issue);
    } else {
      byTitle.set(issue.title, [issue]);
    }
  }

  const problems: string[] = [];
  const waveCounts = new Map<string, number>();

  for (const spec of expectedSpecs) {
    const matches = byTitle.get(spec.title) ?? [];
    if (matches.length === 0) {
      problems.push(`Missing expected issue: ${spec.title}`);
      continue;
    }
    if (matches.length > 1) {
      const numbers = matches.map((issue) => `#${issue.number}`).join(', ');
      problems.push(`Duplicate open issues for ${spec.title}: ${numbers}`);
      continue;
    }

    const issue = matches[0]!;
    if (issue.body !== spec.body) {
      problems.push(`Metadata/body mismatch for ${spec.title} (#${issue.number})`);
    }
    if (!issueLabels(issue).includes(ASSET_REQUEST_LABEL)) {
      problems.push(`Missing ${ASSET_REQUEST_LABEL} label on ${spec.title} (#${issue.number})`);
    }
    waveCounts.set(spec.productionWaveId, (waveCounts.get(spec.productionWaveId) ?? 0) + 1);
  }

  if (waveCounts.size !== EXPECTED_WAVE_COUNT) {
    problems.push(`Expected ${EXPECTED_WAVE_COUNT} production waves, validated ${waveCounts.size}`);
  }

  return { problems, waveCounts };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function githubRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const token = requiredEnv('GH_TOKEN');
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      'User-Agent': 'crawler-g2b-seed-issues',
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `GitHub API ${init?.method ?? 'GET'} ${path} failed: ${response.status} ${text}`,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function listOpenIssues(): Promise<GitHubIssue[]> {
  const issues: GitHubIssue[] = [];
  for (let page = 1; ; page += 1) {
    const pageItems = await githubRequest<GitHubIssue[]>(
      `/repos/${REPO_OWNER}/${REPO_NAME}/issues?state=open&per_page=100&page=${page}`,
    );
    const openIssues = pageItems.filter((issue) => issue.pull_request === undefined);
    issues.push(...openIssues);
    if (pageItems.length < 100) {
      return issues;
    }
  }
}

async function addAssetRequestLabel(issueNumber: number): Promise<void> {
  await githubRequest(`/repos/${REPO_OWNER}/${REPO_NAME}/issues/${issueNumber}/labels`, {
    method: 'POST',
    body: JSON.stringify({ labels: [ASSET_REQUEST_LABEL] }),
  });
}

async function updateIssueBody(issueNumber: number, body: string): Promise<void> {
  await githubRequest(`/repos/${REPO_OWNER}/${REPO_NAME}/issues/${issueNumber}`, {
    method: 'PATCH',
    body: JSON.stringify({ body }),
  });
}

async function createIssue(spec: IssueSpec): Promise<GitHubIssue> {
  return githubRequest<GitHubIssue>(`/repos/${REPO_OWNER}/${REPO_NAME}/issues`, {
    method: 'POST',
    body: JSON.stringify({
      title: spec.title,
      body: spec.body,
      labels: [ASSET_REQUEST_LABEL],
    }),
  });
}

function writeSummary(lines: string[]): void {
  const summaryPath = process.env['GITHUB_STEP_SUMMARY'];
  const payload = `${lines.join('\n')}\n`;
  if (!summaryPath) {
    process.stdout.write(payload);
    return;
  }
  appendFileSync(summaryPath, payload, 'utf8');
}

async function main(): Promise<void> {
  const expectedSpecs = buildExpectedIssueSpecs();
  const existingIssues = await listOpenIssues();
  const byTitle = new Map<string, GitHubIssue[]>();
  for (const issue of existingIssues) {
    const list = byTitle.get(issue.title);
    if (list) {
      list.push(issue);
    } else {
      byTitle.set(issue.title, [issue]);
    }
  }

  let createdCount = 0;
  let labeledCount = 0;
  let updatedBodyCount = 0;

  for (const spec of expectedSpecs) {
    const matches = byTitle.get(spec.title) ?? [];
    if (matches.length > 1) {
      const numbers = matches.map((issue) => `#${issue.number}`).join(', ');
      throw new Error(`Duplicate open issues already exist for ${spec.title}: ${numbers}`);
    }
    if (matches.length === 1) {
      const issue = matches[0]!;
      const syncPlan = planExistingIssueSync(issue, spec);
      if (syncPlan.needsBodyUpdate) {
        await updateIssueBody(issue.number, spec.body);
        updatedBodyCount += 1;
      }
      if (syncPlan.needsLabel) {
        await addAssetRequestLabel(issue.number);
        labeledCount += 1;
      }
      continue;
    }

    const created = await createIssue(spec);
    createdCount += 1;
    console.log(`Created #${created.number}: ${spec.title}`);
  }

  const finalIssues = await listOpenIssues();
  const validation = validateIssueSet(finalIssues, expectedSpecs);
  if (validation.problems.length > 0) {
    throw new Error(validation.problems.join('\n'));
  }

  const expectedWaveCounts = new Map<string, number>();
  for (const spec of expectedSpecs) {
    expectedWaveCounts.set(
      spec.productionWaveId,
      (expectedWaveCounts.get(spec.productionWaveId) ?? 0) + 1,
    );
  }

  const waveLines = Array.from(expectedWaveCounts.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([waveId, count]) =>
        `- ${waveId}: ${validation.waveCounts.get(waveId) ?? 0}/${count} validated`,
    );

  writeSummary([
    '### G2-B Issue Seeding Complete',
    `- Created: **${createdCount}**`,
    `- Labeled existing issues: **${labeledCount}**`,
    `- Updated stale issue bodies: **${updatedBodyCount}**`,
    `- Validated identities: **${expectedSpecs.length}/${expectedSpecs.length}**`,
    `- Validated production waves: **${validation.waveCounts.size}/${EXPECTED_WAVE_COUNT}**`,
    '',
    'Validated waves:',
    ...waveLines,
  ]);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
