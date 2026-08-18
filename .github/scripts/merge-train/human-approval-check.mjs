import { listClosingIssues, paginate, request } from '../ci-recovery/github.mjs';
import { requiresHumanApproval, resolveHumanApprovalRejection } from './human-approval.mjs';

const repository = process.env.GITHUB_REPOSITORY || '';
const [owner, repo] = repository.split('/');
const prNumber = Number.parseInt(process.env.PR_NUMBER || '', 10);
const token = process.env.GITHUB_TOKEN || '';

if (!Number.isInteger(prNumber)) {
  process.stdout.write('Human approval gate is not applicable outside pull requests\n');
  process.exit(0);
}
if (!owner || !repo || !token) {
  throw new Error('Human approval gate requires repository context and GITHUB_TOKEN');
}

const pullRequest = (await request(token, `/repos/${owner}/${repo}/pulls/${prNumber}`)).data;
const [comments, closingIssues] = await Promise.all([
  paginate(token, `/repos/${owner}/${repo}/issues/${prNumber}/comments`),
  listClosingIssues(token, owner, repo, prNumber),
]);
const rejection = await resolveHumanApprovalRejection({
  pullRequest,
  closingIssues,
  comments,
  ownerLogin: owner,
  fetchReviews: () => paginate(token, `/repos/${owner}/${repo}/pulls/${prNumber}/reviews`),
});

if (rejection) {
  throw new Error(`PR #${prNumber} is blocked: ${rejection}`);
}

process.stdout.write(
  requiresHumanApproval(pullRequest, closingIssues)
    ? `PR #${prNumber} has explicit repository-owner approval\n`
    : `PR #${prNumber} does not require explicit repository-owner approval\n`,
);
