import { TRUSTED_ASSOCIATIONS, TRUSTED_BOT_LOGINS } from './state.mjs';
import { ISSUE_INTAKE_MARKER, ISSUE_RECOVERY_PLAN_MARKER } from './markers.mjs';

export { ISSUE_INTAKE_MARKER, ISSUE_RECOVERY_PLAN_MARKER };
export const GITHUB_ACTIONS_LOGIN = 'github-actions[bot]';
const RECOVERY_PLAN_APPROACH_MAX_LENGTH = 20_000;
const RECOVERY_PLAN_CHECKLIST_MAX_ITEMS = 20;
const RECOVERY_PLAN_CHECKLIST_ITEM_MAX_LENGTH = 500;
const COPILOT_OPENER_LOGINS = new Set([
  'copilot',
  'copilot[bot]',
  'app/copilot',
  'copilot-swe-agent',
  'copilot-swe-agent[bot]',
  'app/copilot-swe-agent',
]);
const PLAN_REQUIREMENT_REVIEWER_LOGINS = new Set([
  'copilot-pull-request-reviewer',
  'copilot-pull-request-reviewer[bot]',
]);

// Exported so callers (e.g. nightly-balance-issue.mjs) can recognize a completed
// Copilot assignment as durable proof of finished intake without duplicating this
// login list.
export function isCopilotLogin(login) {
  return COPILOT_OPENER_LOGINS.has(String(login || '').toLowerCase());
}

function hasTrustedCommentAuthor(comment) {
  return (
    TRUSTED_ASSOCIATIONS.has(String(comment.author_association || '').toUpperCase()) ||
    TRUSTED_BOT_LOGINS.has(String(comment.user?.login || '').toLowerCase())
  );
}

function stripHtmlComments(value) {
  return String(value || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractMarkdownSection(body, heading) {
  const match = stripHtmlComments(body).match(
    new RegExp(`(?:^|\\n)##+\\s*${escapeRegExp(heading)}\\s*\\n([\\s\\S]*?)(?=\\n##+\\s|$)`, 'i'),
  );
  return match?.[1]?.trim() || '';
}

function extractLeadParagraph(body) {
  const paragraphs = stripHtmlComments(body)
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .filter((paragraph) => !paragraph.startsWith('#'));
  return paragraphs[0] || '';
}

function extractBulletLines(body) {
  return String(body || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^- /.test(line))
    .map((line) => line.replace(/^- /, '').trim());
}

function truncatePlanContent(value, maxLength) {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 2).trimEnd()}…`;
}

function planHeading(line) {
  const normalized = String(line || '')
    .trim()
    .replace(/^#{1,6}\s*/, '')
    .replace(/^\*\*(.+)\*\*$/, '$1')
    .trim()
    .toLowerCase();
  if (['high-level design', 'high-level design and approach'].includes(normalized)) {
    return 'design';
  }
  if (['key decisions', 'key decisions and alternatives'].includes(normalized)) {
    return 'decisions';
  }
  if (normalized === 'checklist') return 'checklist';
  return null;
}

function isStandaloneHeading(line) {
  const trimmed = String(line || '').trim();
  return /^#{1,6}\s+\S/.test(trimmed) || /^\*\*[^*]+\*\*$/.test(trimmed);
}

function hasStructuredPlanContent(body) {
  const sections = { design: [], decisions: [], checklist: [] };
  let currentSection = null;
  for (const line of stripHtmlComments(body).split('\n')) {
    const heading = planHeading(line);
    if (heading) {
      currentSection = heading;
      continue;
    }
    if (isStandaloneHeading(line)) {
      currentSection = null;
      continue;
    }
    const content = line.trim();
    if (currentSection && content) sections[currentSection].push(content);
  }
  return (
    sections.design.length > 0 &&
    sections.decisions.length > 0 &&
    sections.checklist.some((line) => /^-\s*(?:\[[ x]\]\s*)?\S+/i.test(line))
  );
}

function buildRetroactiveChecklist(prBody) {
  const changeBullets = extractBulletLines(extractMarkdownSection(prBody, 'Changes'));
  if (changeBullets.length > 0) {
    return changeBullets.map((entry) => `- [x] ${entry}`);
  }
  return [
    '- [x] Confirm the linked issue still has the intake-plan requirement and lacks trusted plan evidence.',
    '- [x] Post a trusted retroactive implementation plan on the source issue before dispatching repair work.',
    '- [x] Keep the recovery path idempotent and covered by targeted regression tests.',
  ];
}

export const ISSUE_INTAKE_BODY = [
  ISSUE_INTAKE_MARKER,
  '@copilot',
  '',
  "Please handle this issue under the repository's normal development rules with no shortcuts:",
  '- Follow `AGENTS.md` and `.github/copilot-instructions.md` exactly.',
  '- Keep all required verification/review-harness/ledger steps for code-touching work.',
  '- Do not weaken gates, policy checks, or explicit human requirements to get green.',
  '',
  '**Before writing any code**, post a detailed plan comment on this issue that covers:',
  '- High-level design and approach for the work.',
  '- Key decisions made (e.g. which systems, skills, or libraries are involved; alternatives considered).',
  '- A checklist of the concrete steps you will take.',
  '',
  'Post this plan comment on the issue itself so the maintainer can review it before you open a PR.',
  'Then, when you open the PR, include the same high-level summary in the PR description.',
].join('\n');

export function issueIntakeEligibility(issue, maintainerLogin = 'nalfeo') {
  if (!issue || issue.pull_request) {
    return { eligible: false, reason: 'event has no eligible issue payload' };
  }

  const opener = String(issue.user?.login || '').toLowerCase();
  const maintainer = String(maintainerLogin || '').toLowerCase();
  const trustedOpener =
    opener === maintainer || opener === GITHUB_ACTIONS_LOGIN || isCopilotLogin(opener);

  if (!trustedOpener) {
    return { eligible: false, reason: `opener @${opener || 'unknown'} is not trusted` };
  }

  const labels = (issue.labels || []).map((label) => String(label.name || '').toLowerCase());
  if (labels.includes('automation') && opener !== GITHUB_ACTIONS_LOGIN) {
    return {
      eligible: false,
      reason: `issue #${issue.number} has automation label and was not opened by GitHub Actions`,
    };
  }

  return { eligible: true, reason: 'trusted issue opener' };
}

export function reviewThreadPlanIssueNumbers(thread, closingIssues) {
  const rootComment = thread?.comments?.nodes?.[0];
  const rootLogin = String(rootComment?.author?.login || '').toLowerCase();
  const rootAssociation = String(rootComment?.authorAssociation || '').toUpperCase();
  if (
    !PLAN_REQUIREMENT_REVIEWER_LOGINS.has(rootLogin) &&
    !TRUSTED_ASSOCIATIONS.has(rootAssociation)
  ) {
    return [];
  }

  const text = String(rootComment?.body || '').toLowerCase();
  const planSubject = '(?:plan comment|implementation plan|issue comment itself)';
  const mentionsMissingPlanRequirement = new RegExp(
    `(?:\\b(?:missing|required|requires?)\\s+(?:(?:an?|the)\\s+)?${planSubject}\\b|` +
      `\\b${planSubject}\\b\\s+(?:(?:is|was|remains?)\\s+)?(?:missing|required)\\b|` +
      `\\b(?:missing|required|requires?)\\b[^.!?]{0,60}?\\bplan\\s+to\\s+be\\s+posted\\b)`,
    'i',
  ).test(text);
  if (!mentionsMissingPlanRequirement) return [];

  const issueNumbers = (closingIssues || []).map((issue) => issue.number).filter(Number.isInteger);
  const explicitReferences = [...text.matchAll(/(?:\bissue\s+#?|#)(\d+)\b/gi)].map((match) =>
    Number.parseInt(match[1], 10),
  );
  if (explicitReferences.length === 0) return [];
  if (explicitReferences.some((issueNumber) => !issueNumbers.includes(issueNumber))) return [];
  return [...new Set(explicitReferences)];
}

export async function getCopilotIssueAssignmentContext({
  graphql,
  token,
  owner,
  repo,
  issueNumber,
}) {
  const actors = await graphql(
    token,
    `
      query ($owner: String!, $repo: String!, $issueNumber: Int!) {
        repository(owner: $owner, name: $repo) {
          suggestedActors(capabilities: [CAN_BE_ASSIGNED], first: 100) {
            nodes {
              login
              __typename
              ... on Bot {
                id
              }
              ... on User {
                id
              }
            }
          }
          issue(number: $issueNumber) {
            id
            state
            assignees(first: 50) {
              nodes {
                id
                login
              }
            }
          }
        }
      }
    `,
    { owner, repo, issueNumber },
  );

  const copilot = (actors.repository?.suggestedActors?.nodes || []).find((actor) => {
    return isCopilotLogin(actor.login);
  });

  if (!copilot?.id) {
    throw new Error('CRAWLER_CI_PAT cannot discover an assignable Copilot actor');
  }

  const issueData = actors.repository?.issue;
  if (!issueData?.id) {
    throw new Error(`Issue #${issueNumber} could not be loaded for assignment`);
  }

  return {
    copilot,
    issueId: issueData.id,
    issueState: issueData.state,
    assignees: issueData.assignees?.nodes || [],
  };
}

export function buildIssueActorIds({ assignees, copilotActorId, includeCopilot }) {
  const allAssignees = Array.isArray(assignees) ? assignees : [];
  const nonCopilotActorIds = allAssignees
    .filter((assignee) => !isCopilotLogin(assignee?.login))
    .map((assignee) => assignee.id)
    .filter(Boolean);
  const copilotActorIds = allAssignees
    .filter((assignee) => isCopilotLogin(assignee?.login))
    .map((assignee) => assignee.id)
    .filter(Boolean);
  const actorIds = [...nonCopilotActorIds];
  if (includeCopilot) {
    if (copilotActorIds.length > 0) {
      actorIds.push(...copilotActorIds);
    } else if (copilotActorId) {
      actorIds.push(copilotActorId);
    }
  }
  return [...new Set(actorIds)];
}

export async function replaceIssueAssignees({ graphql, token, assignableId, actorIds }) {
  const assignment = await graphql(
    token,
    `
      mutation ($assignableId: ID!, $actorIds: [ID!]!) {
        replaceActorsForAssignable(input: { assignableId: $assignableId, actorIds: $actorIds }) {
          assignable {
            ... on Issue {
              assignees(first: 20) {
                nodes {
                  login
                }
              }
            }
          }
        }
      }
    `,
    { assignableId, actorIds },
  );
  return (
    assignment.replaceActorsForAssignable?.assignable?.assignees?.nodes?.map((assignee) =>
      String(assignee.login || '').toLowerCase(),
    ) || []
  );
}

async function mutateIssueAssignees({ graphql, token, mutationField, assignableId, actorIds }) {
  const assignment = await graphql(
    token,
    `
      mutation ($assignableId: ID!, $assigneeIds: [ID!]!) {
        ${mutationField}(input: { assignableId: $assignableId, assigneeIds: $assigneeIds }) {
          assignable {
            ... on Issue {
              assignees(first: 20) {
                nodes {
                  login
                }
              }
            }
          }
        }
      }
    `,
    {
      assignableId,
      assigneeIds: actorIds,
    },
  );
  return (
    assignment?.[mutationField]?.assignable?.assignees?.nodes?.map((assignee) =>
      String(assignee.login || '').toLowerCase(),
    ) || []
  );
}

export async function addIssueAssignees({ graphql, token, assignableId, actorIds }) {
  return mutateIssueAssignees({
    graphql,
    token,
    mutationField: 'addAssigneesToAssignable',
    assignableId,
    actorIds,
  });
}

export async function removeIssueAssignees({ graphql, token, assignableId, actorIds }) {
  return mutateIssueAssignees({
    graphql,
    token,
    mutationField: 'removeAssigneesFromAssignable',
    assignableId,
    actorIds,
  });
}

function isTrustedMarkerComment(comment) {
  return (
    String(comment.body || '').includes(ISSUE_INTAKE_MARKER) && hasTrustedCommentAuthor(comment)
  );
}

/**
 * Returns true if `issueComments` contains a trusted intake-marker comment,
 * meaning the issue was assigned via the intake workflow and has a standing
 * plan-comment requirement.
 *
 * Comments fetched from the REST `/issues/{number}/comments` endpoint have
 * `user.login` and `author_association` fields.
 */
export function hasIntakeRequirementComment(issueComments) {
  return (issueComments || []).some((comment) => {
    return (
      String(comment.body || '').includes(ISSUE_INTAKE_MARKER) && hasTrustedCommentAuthor(comment)
    );
  });
}

/**
 * Returns true if `issueComments` already contains dedicated, trusted plan
 * evidence: either a trusted retroactive recovery-plan comment from a prior
 * reconciler run or a Copilot-authored comment with explicit plan sections.
 *
 * This intentionally does NOT treat arbitrary non-intake Copilot comments as
 * plans; status updates and failure notes must not suppress the retroactive
 * recovery comment.
 */
export function hasCopilotPlanComment(issueComments) {
  return (issueComments || []).some((comment) => {
    const body = String(comment.body || '');
    // A prior retroactive plan from CI recovery satisfies the requirement.
    if (body.includes(ISSUE_RECOVERY_PLAN_MARKER) && hasTrustedCommentAuthor(comment)) return true;
    return (
      isCopilotLogin(comment.user?.login) &&
      !body.includes(ISSUE_INTAKE_MARKER) &&
      hasStructuredPlanContent(body)
    );
  });
}

/**
 * Builds the body of a retroactive plan comment to be posted on a source
 * issue whose linked PR was opened without the required pre-PR plan comment.
 *
 * Embeds `ISSUE_RECOVERY_PLAN_MARKER` so future reconciler runs skip the post
 * (idempotency) and includes the concrete design / decisions / checklist
 * content that the intake workflow requires on the issue itself.
 */
export function buildRetroactivePlanComment(prNumber, prTitle, prHtmlUrl, prBody = '') {
  const safeTitle = truncatePlanContent(stripHtmlComments(prTitle), 500);
  const rawApproachLead =
    extractMarkdownSection(prBody, 'Fix') ||
    extractLeadParagraph(prBody) ||
    'Use the trusted CI recovery reconciler to satisfy the missing issue-side plan requirement before repair-thread follow-up runs.';
  const approachLead = truncatePlanContent(rawApproachLead, RECOVERY_PLAN_APPROACH_MAX_LENGTH);
  const rawChecklist = buildRetroactiveChecklist(prBody);
  const checklist = rawChecklist
    .slice(0, RECOVERY_PLAN_CHECKLIST_MAX_ITEMS)
    .map((item) => truncatePlanContent(item, RECOVERY_PLAN_CHECKLIST_ITEM_MAX_LENGTH));
  if (
    rawChecklist.length > checklist.length ||
    rawChecklist.some((item, index) => item !== checklist[index])
  ) {
    checklist.push(
      `- [ ] Review remaining implementation details in ${prHtmlUrl || `PR #${prNumber}`}.`,
    );
  }
  return [
    ISSUE_RECOVERY_PLAN_MARKER,
    '',
    '**Retroactive implementation plan** _(filed by CI recovery pipeline)_',
    '',
    `The agent that opened PR #${prNumber} did not post an implementation plan before opening the PR. The CI recovery pipeline is posting this retroactive plan to satisfy the pre-PR planning requirement so the review thread can be resolved.`,
    '',
    `**PR:** ${prHtmlUrl || `#${prNumber}`}`,
    ...(safeTitle ? [`**Title:** ${safeTitle}`] : []),
    '',
    '**High-level design and approach**',
    approachLead,
    '',
    '**Key decisions and alternatives**',
    '- Post the issue comment from the trusted CI recovery reconciler instead of the repair agent, because the repair agent may lack `issues: write` permission.',
    '- Treat only trusted, dedicated plan evidence as satisfied so unrelated Copilot status comments cannot suppress the recovery post.',
    `- Keep the retroactive recovery comment idempotent with \`${ISSUE_RECOVERY_PLAN_MARKER}\` so repeated reconciliations do not duplicate the plan.`,
    '',
    '**Checklist**',
    ...checklist,
  ].join('\n');
}

async function deleteCommentIfCreated(request, token, owner, repo, commentId) {
  if (typeof commentId === 'number' && commentId > 0) {
    await request(token, `/repos/${owner}/${repo}/issues/comments/${commentId}`, {
      method: 'DELETE',
    });
  }
}

/**
 * Fetches the issues that block `issueNumber` from being worked (GitHub's
 * `blocked_by` dependency direction). Errors are intentionally NOT swallowed:
 * callers must never assign Copilot unless they positively confirmed there is
 * no open blocker, and a network/API failure (or an unexpected non-array
 * response shape) must fail loud rather than silently behave as "no
 * blockers". Uses `paginate` so a dependency list beyond a single page can
 * never be silently truncated into a false "unblocked" verdict.
 */
export async function getBlockedByDependencies({ paginate, token, owner, repo, issueNumber }) {
  return paginate(token, `/repos/${owner}/${repo}/issues/${issueNumber}/dependencies/blocked_by`);
}

/**
 * Fetches the issues that `issueNumber` blocks (GitHub's `blocking` dependency
 * direction), i.e. its dependents. Same fail-loud, fully-paginated contract as
 * `getBlockedByDependencies`.
 */
export async function getBlockingDependents({ paginate, token, owner, repo, issueNumber }) {
  return paginate(token, `/repos/${owner}/${repo}/issues/${issueNumber}/dependencies/blocking`);
}

/** Filters a dependency list down to the entries that are still open. */
export function openBlockingIssues(dependencies) {
  return (dependencies || []).filter(
    (dep) => String(dep?.state || '').toLowerCase() === 'open',
  );
}

/**
 * Intake entry point for a newly-opened issue. Gates on both trusted-opener
 * eligibility AND open `blocked_by` dependencies: Copilot is never assigned
 * and the kickoff comment is never posted while any blocker issue is still
 * open.
 *
 * When `fromUnblockSweep` is true (called from `intakeUnblockedDependents`)
 * the automation-label gate is bypassed: if a human deliberately set up a
 * `blocked_by` dependency chain the intent is for Copilot to pick up the
 * dependent once the blocker clears, regardless of its labels.  The
 * trusted-opener check (no arbitrary bots) still applies.
 */
export async function intakeOpenedIssue({
  graphql,
  paginate,
  request,
  token,
  owner,
  repo,
  issue,
  maintainerLogin = 'nalfeo',
  fromUnblockSweep = false,
}) {
  let eligibilityReason;
  if (fromUnblockSweep) {
    // Automation-label restriction is intentionally skipped here — see JSDoc.
    // We still reject non-issues (PR payloads) and untrusted openers.
    if (!issue || issue.pull_request) {
      return { assigned: false, reason: 'event has no eligible issue payload' };
    }
    const opener = String(issue.user?.login || '').toLowerCase();
    const maintainer = String(maintainerLogin || '').toLowerCase();
    const trustedOpener =
      opener === maintainer || opener === GITHUB_ACTIONS_LOGIN || isCopilotLogin(opener);
    if (!trustedOpener) {
      return { assigned: false, reason: `opener @${opener || 'unknown'} is not trusted` };
    }
    eligibilityReason = 'unblocked dependent';
  } else {
    const eligibility = issueIntakeEligibility(issue, maintainerLogin);
    if (!eligibility.eligible) {
      return { assigned: false, reason: eligibility.reason };
    }
    eligibilityReason = eligibility.reason;
  }

  const blockers = openBlockingIssues(
    await getBlockedByDependencies({ paginate, token, owner, repo, issueNumber: issue.number }),
  );
  if (blockers.length > 0) {
    return {
      assigned: false,
      reason: `blocked by open ${blockers.map((blocker) => `#${blocker.number}`).join(', ')}`,
    };
  }

  const result = await runIssueIntake({ graphql, paginate, request, token, owner, repo, issue });
  return {
    assigned: true,
    reason: eligibilityReason,
    assignee: result.assignee,
    comment: result.comment,
  };
}

/**
 * Re-runs intake for every dependent of a just-closed issue, so that a
 * dependent whose last blocker just closed gets picked up automatically
 * instead of waiting for a human to notice. Dependent issue payloads returned
 * by the `blocking` dependency endpoint are full issue payloads, so they are
 * passed straight through to `intakeOpenedIssue` without a re-fetch.
 */
export async function intakeUnblockedDependents({
  graphql,
  paginate,
  request,
  token,
  owner,
  repo,
  closedIssue,
  maintainerLogin = 'nalfeo',
}) {
  const dependents = await getBlockingDependents({
    paginate,
    token,
    owner,
    repo,
    issueNumber: closedIssue.number,
  });

  const repoFullName = `${owner}/${repo}`.toLowerCase();
  const results = [];
  for (const dependent of dependents) {
    if (String(dependent?.state || '').toLowerCase() !== 'open') {
      results.push({ number: dependent?.number, assigned: false, reason: 'dependent not open' });
      continue;
    }
    if (String(dependent?.repository?.full_name || '').toLowerCase() !== repoFullName) {
      results.push({
        number: dependent?.number,
        assigned: false,
        reason: 'dependent in a different repository',
      });
      continue;
    }
    try {
      const outcome = await intakeOpenedIssue({
        graphql,
        paginate,
        request,
        token,
        owner,
        repo,
        issue: dependent,
        maintainerLogin,
        fromUnblockSweep: true,
      });
      results.push({ number: dependent.number, ...outcome });
    } catch (err) {
      // A dependent closing between our `open` check above and the live
      // assignment mutation is a benign race, not an infra failure — report it
      // as a skip so the sweep doesn't flag the workflow run red for it.
      if (err instanceof IssueNoLongerOpenError) {
        results.push({ number: dependent.number, assigned: false, reason: 'dependent closed during processing' });
        continue;
      }
      results.push({ number: dependent.number, assigned: false, error: String(err?.message || err) });
    }
  }
  return results;
}

/**
 * Thrown by `runIssueIntake` when the issue's live GraphQL state is no longer
 * OPEN. Exported (and used as a marker via `instanceof`) so callers like
 * `intakeUnblockedDependents` can distinguish this benign race — the issue
 * closed between eligibility/blocked_by checks and the assignment mutation —
 * from a genuine API/infra failure, and report it as a skip rather than an
 * error.
 */
export class IssueNoLongerOpenError extends Error {
  constructor(issueNumber) {
    super(`Issue #${issueNumber} is no longer open; skipping intake`);
    this.name = 'IssueNoLongerOpenError';
  }
}

export async function runIssueIntake({ graphql, paginate, request, token, owner, repo, issue }) {
  const assignmentContext = await getCopilotIssueAssignmentContext({
    graphql,
    token,
    owner,
    repo,
    issueNumber: issue.number,
  });

  // Guard against a moment-in-time race: the issue may have been closed between
  // when the caller last observed it as eligible/unblocked and this live GraphQL
  // fetch. Never post a kickoff comment or assign Copilot to an issue that is no
  // longer open.
  if (String(assignmentContext.issueState || '').toUpperCase() !== 'OPEN') {
    throw new IssueNoLongerOpenError(issue.number);
  }

  const actorIds = buildIssueActorIds({
    assignees: assignmentContext.assignees,
    copilotActorId: assignmentContext.copilot.id,
    includeCopilot: true,
  });

  // Post the kickoff comment BEFORE assigning Copilot so the instructions are present
  // when the agent session starts. Clean up the new comment if assignment fails.
  const comments = await paginate(token, `/repos/${owner}/${repo}/issues/${issue.number}/comments`);
  const existingKickoff = comments.find(isTrustedMarkerComment);

  let newCommentId = null;
  if (existingKickoff) {
    if (String(existingKickoff.body || '') !== ISSUE_INTAKE_BODY) {
      await request(token, `/repos/${owner}/${repo}/issues/comments/${existingKickoff.id}`, {
        method: 'PATCH',
        body: { body: ISSUE_INTAKE_BODY },
      });
    }
  } else {
    const created = await request(
      token,
      `/repos/${owner}/${repo}/issues/${issue.number}/comments`,
      {
        method: 'POST',
        body: { body: ISSUE_INTAKE_BODY },
      },
    );
    newCommentId = typeof created?.data?.id === 'number' ? created.data.id : null;
  }

  let assignment;
  try {
    assignment = await replaceIssueAssignees({
      graphql,
      token,
      assignableId: issue.node_id,
      actorIds,
    });
  } catch (err) {
    await deleteCommentIfCreated(request, token, owner, repo, newCommentId);
    throw err;
  }

  const assignedLogins = assignment;
  if (!assignedLogins.some(isCopilotLogin)) {
    await deleteCommentIfCreated(request, token, owner, repo, newCommentId);
    throw new Error(`Copilot assignment did not persist on issue #${issue.number}`);
  }

  return {
    assignee: assignmentContext.copilot.login,
    comment: existingKickoff ? 'existing' : 'posted',
  };
}
