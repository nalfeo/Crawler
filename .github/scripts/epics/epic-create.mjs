/**
 * epic-create.mjs — Turn a committed `*.epic.json` file into real GitHub
 * issues, always gated behind a human-reviewed root issue.
 *
 * Why this exists: cloud coding-agent sessions cannot create GitHub issues
 * themselves (no issue-create permission). An agent instead authors a
 * declarative `*.epic.json` file describing the epic's issue layout and
 * dependency graph and commits it through a normal PR. Once that file lands
 * on `main`, the `epic-create` workflow runs this script with a token that
 * *can* create issues.
 *
 * Contract:
 *   - The FIRST issue created for any epic is always the human-review issue.
 *     No slice/node issue is ever created while the review issue is missing
 *     or still open — this is the "plan is human reviewed before
 *     implementation begins" gate from the epic-creation-workflow request.
 *   - The review issue must be closed with reason "completed" to count as
 *     approval. Closing it as "not planned" is treated as a rejection: no
 *     node issues are ever created for that epic (it is not a no-op that a
 *     later push can silently retry into existence).
 *   - The review issue is itself scoped to a content hash of the reviewed
 *     `title`+`nodes`, embedded directly in its marker. If the `.epic.json`
 *     file changes (title or nodes) after the review issue is filed or
 *     closed, no existing issue matches the new hash, so the workflow files
 *     a brand-new review issue for the new revision instead of silently
 *     materializing node issues nobody reviewed against this content — a
 *     human cannot be asked to approve (or reject) revision A and have
 *     revision B materialize. The old review issue is left untouched as
 *     history; it is never edited, reused, or auto-closed.
 *   - Once approved, node issues are created in dependency order. Every node
 *     issue body lists "Blocked by #N" for the review issue itself plus every
 *     declared `depends_on` entry, so the dependency graph is visible
 *     directly on GitHub without any extra control-plane file.
 *   - Idempotent: every managed issue carries an HTML-comment marker in its
 *     body. Re-running this script (e.g. on every push, on the review
 *     issue's `closed`/`reopened` events, or via workflow_dispatch) only ever
 *     creates issues that do not already exist; it never edits or duplicates
 *     one that does.
 *
 * This is intentionally simpler than, and independent of, the bespoke
 * `docs/knowledge/epics/floor-2-equipment/epic-state.json` control plane
 * (`scripts/agent/epics/epic-status.ts` / `epic-materialize.ts`), which is a
 * human-operated CLI for one specific, already-in-flight epic. epic-create.mjs
 * is the generic, CI-driven on-ramp for *new* epics going forward.
 */

import process from 'node:process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { request, paginate } from '../ci-recovery/github.mjs';

export const EPIC_LABEL = 'epic';
export const EPIC_REVIEW_LABEL = 'epic-review';

export function nodeMarker(epicId, nodeId) {
  return `<!-- crawler-epic-node:${epicId}:${nodeId} -->`;
}

export function epicLabel(epicId) {
  return `epic:${epicId}`;
}

/**
 * Content hash of the reviewable surface of an epic (title + nodes, not the
 * free-form description/review prose). Embedded directly in the review
 * marker (below) so a review issue only ever matches the exact plan
 * revision it reviewed: if the file changes after a review issue is filed
 * or closed, no existing issue matches the new hash, and a fresh review
 * issue is created for the new revision automatically instead of silently
 * materializing node issues nobody actually reviewed against this content.
 */
export function epicContentHash(epic) {
  const canonical = JSON.stringify({ title: epic.title, nodes: epic.nodes });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * The review marker is scoped to both the epic id AND the content hash of
 * the reviewed revision, so distinct revisions of the same epic never
 * collide on the same marker (and thus the same review issue).
 */
export function reviewMarker(epicId, hash) {
  return `<!-- crawler-epic-review:${epicId}:${hash} -->`;
}

const NODE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Validate the shape of a parsed `*.epic.json` document. Returns an array of
 * human-readable error strings; empty means valid.
 */
export function validateEpicFile(epic) {
  const errors = [];
  if (!epic || typeof epic !== 'object' || Array.isArray(epic)) {
    return ['epic file must be a JSON object'];
  }
  if (typeof epic.epic_id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(epic.epic_id)) {
    errors.push('epic_id must be a lowercase kebab-case string');
  }
  if (typeof epic.title !== 'string' || epic.title.trim().length === 0) {
    errors.push('title must be a non-empty string');
  }
  if (epic.description !== undefined && typeof epic.description !== 'string') {
    errors.push('description must be a string when present');
  }
  if (
    epic.review !== undefined &&
    (typeof epic.review !== 'object' || Array.isArray(epic.review))
  ) {
    errors.push('review must be an object when present');
  } else if (epic.review) {
    if (epic.review.title_prefix !== undefined && typeof epic.review.title_prefix !== 'string') {
      errors.push('review.title_prefix must be a string when present');
    }
    if (epic.review.body !== undefined && typeof epic.review.body !== 'string') {
      errors.push('review.body must be a string when present');
    }
  }
  if (epic.labels !== undefined) {
    if (!Array.isArray(epic.labels) || epic.labels.some((l) => typeof l !== 'string')) {
      errors.push('labels must be an array of strings when present');
    }
  }
  if (!Array.isArray(epic.nodes) || epic.nodes.length === 0) {
    errors.push('nodes must be a non-empty array');
    return errors;
  }

  const seenIds = new Set();
  for (const [index, node] of epic.nodes.entries()) {
    const where = `nodes[${index}]`;
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      errors.push(`${where} must be an object`);
      continue;
    }
    if (typeof node.id !== 'string' || node.id.trim().length === 0) {
      errors.push(`${where}.id must be a non-empty string`);
    } else if (!NODE_ID_PATTERN.test(node.id)) {
      errors.push(
        `${where}.id "${node.id}" must be lowercase kebab-case (matches ${NODE_ID_PATTERN})`,
      );
    } else if (seenIds.has(node.id)) {
      errors.push(`duplicate node id "${node.id}"`);
    } else {
      seenIds.add(node.id);
    }
    if (typeof node.title !== 'string' || node.title.trim().length === 0) {
      errors.push(`${where}.title must be a non-empty string`);
    }
    if (node.body !== undefined && typeof node.body !== 'string') {
      errors.push(`${where}.body must be a string when present`);
    }
    if (node.labels !== undefined) {
      if (!Array.isArray(node.labels) || node.labels.some((l) => typeof l !== 'string')) {
        errors.push(`${where}.labels must be an array of strings when present`);
      }
    }
    if (node.depends_on !== undefined) {
      if (!Array.isArray(node.depends_on) || node.depends_on.some((d) => typeof d !== 'string')) {
        errors.push(`${where}.depends_on must be an array of strings when present`);
      }
    }
  }

  for (const node of epic.nodes) {
    for (const dep of node?.depends_on || []) {
      if (!seenIds.has(dep)) {
        errors.push(`node "${node.id}" depends_on unknown node "${dep}"`);
      }
    }
  }

  return errors;
}

/**
 * Topologically sort nodes so every dependency is created before its
 * dependents. Throws if a cycle is detected.
 */
export function topoSortNodes(nodes) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const order = [];
  const visiting = new Set();
  const visited = new Set();

  function visit(id, chain) {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw new Error(`epic node dependency cycle detected: ${[...chain, id].join(' -> ')}`);
    }
    visiting.add(id);
    const node = byId.get(id);
    for (const dep of node?.depends_on || []) {
      visit(dep, [...chain, id]);
    }
    visiting.delete(id);
    visited.add(id);
    order.push(node);
  }

  for (const node of nodes) {
    visit(node.id, []);
  }
  return order;
}

function reviewIssueTitle(epic) {
  const prefix = epic.review?.title_prefix || '[Epic Review]';
  return `${prefix} ${epic.title}`;
}

function buildReviewIssueBody(epic) {
  const lines = [
    reviewMarker(epic.epic_id, epicContentHash(epic)),
    '',
    `This issue gates the **${epic.title}** epic. No implementation-slice issue`,
    'will be created until this issue is closed (as **completed**, not "not',
    'planned") by a human, confirming the plan below has been reviewed.',
    '',
  ];
  if (epic.description) {
    lines.push(epic.description, '');
  }
  lines.push('## Planned issues', '');
  for (const node of epic.nodes) {
    const deps = node.depends_on?.length ? ` (depends on: ${node.depends_on.join(', ')})` : '';
    lines.push(`- \`${node.id}\`: ${node.title}${deps}`);
  }
  lines.push(
    '',
    'Close this issue as **completed** to approve the plan and let the',
    '`epic-create` workflow materialize the remaining issues. Close it as',
    '**not planned** to reject the plan. This issue reviews one specific',
    'revision of `docs/knowledge/epics/**/*.epic.json`: if the file changes',
    '(title or nodes) after this issue is filed or closed, this issue no',
    'longer matches the new revision and the workflow files a fresh review',
    'issue for it automatically — this issue itself is never edited or',
    'reused for a different revision.',
  );
  if (epic.review?.body) {
    lines.push('', epic.review.body);
  }
  return lines.join('\n');
}

function buildNodeIssueBody(epic, node, reviewIssueNumber, issueNumberByNodeId) {
  const blockedBy = [
    reviewIssueNumber,
    ...(node.depends_on || []).map((dep) => issueNumberByNodeId.get(dep)),
  ];
  const lines = [nodeMarker(epic.epic_id, node.id), ''];
  if (node.body) {
    lines.push(node.body, '');
  }
  // GitHub has no native "blocked by" relationship; this is human-readable
  // documentation of the dependency graph only, not an enforced gate.
  lines.push(`Blocked by ${blockedBy.map((n) => `#${n}`).join(', ')}`);
  return lines.join('\n');
}

function findManagedIssue(issues, marker) {
  return issues.find((issue) => String(issue.body || '').includes(marker));
}

/**
 * Fetch every issue (any state) already labeled for this epic, so managed
 * issues can be found by marker without scanning the whole repo.
 */
async function fetchEpicIssues({ paginateFn, token, owner, repo, epicId }) {
  // paginate() owns pagination and appends its own `per_page`/`page` query
  // params; do not set `per_page` here or a future change to it would be
  // silently clobbered.
  return paginateFn(
    token,
    `/repos/${owner}/${repo}/issues?state=all&labels=${encodeURIComponent(epicLabel(epicId))}`,
  );
}

/**
 * Ensure every label this run is about to attach to an issue already exists
 * in the repo. The GitHub issues API silently DROPS any label name that
 * doesn't already exist (it neither errors nor auto-creates the label) —
 * without this, a brand-new epic's dynamic `epic:<epic_id>` label would
 * never actually attach to the review issue, so `fetchEpicIssues` (which
 * filters by that exact label) would never find it again on a later run,
 * and every run would create a duplicate review issue forever.
 */
export async function ensureLabelsExist({ requestFn, paginateFn, token, owner, repo, labelNames }) {
  const existing = await paginateFn(token, `/repos/${owner}/${repo}/labels`);
  const existingNames = new Set(existing.map((label) => label.name));
  for (const name of new Set(labelNames)) {
    if (existingNames.has(name)) {
      continue;
    }
    try {
      await requestFn(token, `/repos/${owner}/${repo}/labels`, {
        method: 'POST',
        body: { name },
      });
    } catch (error) {
      // 422 means the label already exists (e.g. created by a concurrent
      // run between our list and our create) — safe to ignore.
      if (error?.status !== 422) {
        throw error;
      }
    }
  }
}

/**
 * Core orchestration: given a parsed+validated epic and injected GitHub
 * request/paginate functions, create whatever issues are safe to create on
 * this run and report the outcome. Never mutates existing issues.
 */
export async function planAndCreateEpic({ requestFn, paginateFn, token, owner, repo, epic }) {
  const errors = validateEpicFile(epic);
  if (errors.length > 0) {
    throw new Error(`invalid epic file:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }

  const sharedLabels = [EPIC_LABEL, epicLabel(epic.epic_id), ...(epic.labels || [])];
  const allLabelNames = [
    ...sharedLabels,
    EPIC_REVIEW_LABEL,
    ...epic.nodes.flatMap((node) => node.labels || []),
  ];
  await ensureLabelsExist({ requestFn, paginateFn, token, owner, repo, labelNames: allLabelNames });

  const existingIssues = await fetchEpicIssues({
    paginateFn,
    token,
    owner,
    repo,
    epicId: epic.epic_id,
  });

  const outcomes = [];

  let reviewIssue = findManagedIssue(
    existingIssues,
    reviewMarker(epic.epic_id, epicContentHash(epic)),
  );
  if (!reviewIssue) {
    const response = await requestFn(token, `/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      body: {
        title: reviewIssueTitle(epic),
        body: buildReviewIssueBody(epic),
        labels: [...sharedLabels, EPIC_REVIEW_LABEL],
      },
    });
    reviewIssue = response.data;
    outcomes.push({ kind: 'review', action: 'created', issueNumber: reviewIssue.number });
    return {
      epicId: epic.epic_id,
      reviewIssueNumber: reviewIssue.number,
      reviewApproved: false,
      outcomes,
    };
  }

  outcomes.push({ kind: 'review', action: 'exists', issueNumber: reviewIssue.number });

  const state = String(reviewIssue.state || '').toLowerCase();
  const stateReason = String(reviewIssue.state_reason || '').toLowerCase();

  if (state !== 'closed') {
    return {
      epicId: epic.epic_id,
      reviewIssueNumber: reviewIssue.number,
      reviewApproved: false,
      outcomes,
    };
  }

  if (stateReason === 'not_planned') {
    // Closing as "not planned" is an explicit human rejection of this exact
    // plan revision (the review issue is hash-scoped, so it can only ever be
    // found again for the same revision — any file edit creates a new review
    // issue instead of reopening this question).
    return {
      epicId: epic.epic_id,
      reviewIssueNumber: reviewIssue.number,
      reviewApproved: false,
      reviewRejected: true,
      outcomes,
    };
  }

  if (stateReason !== 'completed') {
    // Only an explicit "completed" reason counts as approval. This excludes
    // `state_reason: null` (e.g. an issue auto-closed by a PR's "Closes #N"
    // keyword, or closed via the API without a reason), which is not a human
    // confirming the plan was reviewed.
    return {
      epicId: epic.epic_id,
      reviewIssueNumber: reviewIssue.number,
      reviewApproved: false,
      outcomes,
    };
  }

  const issueNumberByNodeId = new Map();
  for (const issue of existingIssues) {
    for (const node of epic.nodes) {
      if (String(issue.body || '').includes(nodeMarker(epic.epic_id, node.id))) {
        issueNumberByNodeId.set(node.id, issue.number);
      }
    }
  }

  const orderedNodes = topoSortNodes(epic.nodes);
  for (const node of orderedNodes) {
    if (issueNumberByNodeId.has(node.id)) {
      outcomes.push({
        kind: 'node',
        nodeId: node.id,
        action: 'exists',
        issueNumber: issueNumberByNodeId.get(node.id),
      });
      continue;
    }
    const response = await requestFn(token, `/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      body: {
        title: node.title,
        body: buildNodeIssueBody(epic, node, reviewIssue.number, issueNumberByNodeId),
        labels: [...sharedLabels, ...(node.labels || [])],
      },
    });
    issueNumberByNodeId.set(node.id, response.data.number);
    outcomes.push({
      kind: 'node',
      nodeId: node.id,
      action: 'created',
      issueNumber: response.data.number,
    });
  }

  return {
    epicId: epic.epic_id,
    reviewIssueNumber: reviewIssue.number,
    reviewApproved: true,
    outcomes,
  };
}

/**
 * Throws if two entries in `epics` (each `{ path, epic }`) claim the same
 * `epic_id` — each would independently believe it owns that id's
 * review/node issues, and could race to create duplicate ones.
 */
export function assertUniqueEpicIds(epics) {
  const pathsByEpicId = new Map();
  for (const { path, epic } of epics) {
    const existing = pathsByEpicId.get(epic?.epic_id);
    if (existing) {
      throw new Error(
        `epic_id "${epic.epic_id}" is claimed by both ${existing} and ${path}; each epic_id must have exactly one *.epic.json file`,
      );
    }
    pathsByEpicId.set(epic?.epic_id, path);
  }
}

async function main() {
  const epicPaths = process.argv.slice(2);
  if (epicPaths.length === 0) {
    throw new Error(
      'Usage: node .github/scripts/epics/epic-create.mjs <path-to-epic.json> [more paths...]',
    );
  }
  const token = process.env.GITHUB_TOKEN || '';
  const repository = process.env.GITHUB_REPOSITORY || '';
  const [owner, repo] = repository.split('/');
  if (!token || !owner || !repo) {
    throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are required');
  }

  const epics = epicPaths.map((path) => ({
    path,
    epic: JSON.parse(readFileSync(path, 'utf8')),
  }));

  assertUniqueEpicIds(epics);

  let hadFailure = false;
  for (const { path, epic } of epics) {
    try {
      const result = await planAndCreateEpic({
        requestFn: request,
        paginateFn: paginate,
        token,
        owner,
        repo,
        epic,
      });
      process.stdout.write(`${path}:\n${JSON.stringify(result, null, 2)}\n`);
      if (result.reviewRejected) {
        process.stdout.write(
          `epic-create: review issue #${result.reviewIssueNumber} was closed as "not planned"; this exact epic revision will never materialize node issues (edit the file to file a new review).\n`,
        );
      } else if (!result.reviewApproved) {
        process.stdout.write(
          `epic-create: waiting on human review issue #${result.reviewIssueNumber} to be closed (as completed) before creating node issues.\n`,
        );
      }
    } catch (error) {
      hadFailure = true;
      process.stderr.write(
        `epic-create: ${path} failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  if (hadFailure) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(
      `epic-create failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
