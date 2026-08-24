// shell-issue-comment: block agents from posting issue / PR conversation
// comments from the shell.
//
// Rationale: cloud coding-agent sessions have no issue-comment credentials.
// Every attempt costs a round trip and, worse, agents have repeatedly *stopped
// working* — declaring themselves blocked on "please grant issue-comment
// access" — when an issue asked for a pre-code plan comment. The plan of record
// is the progress-report tool (progress summary + PR description); CI recovery
// mirrors it back onto the issue with a token that actually has write access.
//
// What is denied:
//   gh issue comment ... | gh pr comment ...
//   gh api ... /issues/<n>/comments with a write method (POST/PATCH/PUT) or
//     implicit-POST fields (-f/-F/--field/--raw-field/--input)
//   gh api graphql with an addComment / updateIssueComment mutation
//
// What is NOT denied:
//   * Reads: `gh issue view --comments`, `gh api repos/o/r/issues/1/comments`
//     (GET is the `gh api` default).
//   * PR *review thread* replies (`/pulls/<n>/comments`, `.../replies`) — those
//     carry the `✅ Addressed in <sha>` markers the merge gate depends on.

import { isGh, normalizeCommand, tokenize } from '../lib/shell.mjs';

const REMEDIATION =
  'Publish it with the progress-report tool instead (progress summary + PR description) — ' +
  'that is the plan/status of record, and CI recovery mirrors it onto the issue. ' +
  'Never block a session waiting for issue-comment access.';

const WRITE_METHODS = new Set(['post', 'patch', 'put']);
const FIELD_FLAGS = new Set(['-f', '-F', '--field', '--raw-field', '--input']);

function isWriteApiCall(tokens) {
  let method = null;
  let hasFields = false;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (FIELD_FLAGS.has(tok)) {
      hasFields = true;
      continue;
    }
    if (/^-[fF].+/.test(tok)) {
      hasFields = true;
      continue;
    }
    if (tok === '-X' || tok === '--method') {
      method = String(tokens[i + 1] || '').toLowerCase();
      continue;
    }
    const attached = /^(?:--method=|-X)(.+)$/.exec(tok);
    if (attached) method = attached[1].toLowerCase();
  }
  if (method) return WRITE_METHODS.has(method);
  // `gh api` implicitly switches to POST when any field is supplied.
  return hasFields;
}

function segmentDeniesIssueComment(seg) {
  if (!isGh(seg)) return null;
  const tokens = tokenize(seg);
  const args = tokens.slice(1).filter((tok) => !tok.startsWith('-'));

  if (args[0] === 'issue' && args[1] === 'comment') {
    return `Refusing \`gh issue comment\`: this session has no issue-comment credentials. Segment: \`${seg}\`. ${REMEDIATION}`;
  }
  if (args[0] === 'pr' && args[1] === 'comment') {
    return `Refusing \`gh pr comment\`: this session has no PR-comment credentials. Segment: \`${seg}\`. ${REMEDIATION}`;
  }
  if (args[0] !== 'api') return null;

  if (!isWriteApiCall(tokens)) return null;

  if (args.some((arg) => /(^|\/)issues\/\d+\/comments\/?$/.test(arg.split('?')[0]))) {
    return `Refusing a POST to an issue-comment API endpoint. Segment: \`${seg}\`. ${REMEDIATION}`;
  }
  if (
    args.includes('graphql') &&
    tokens.some((tok) => /\b(addComment|updateIssueComment)\b/.test(tok))
  ) {
    return `Refusing a GraphQL comment mutation. Segment: \`${seg}\`. ${REMEDIATION}`;
  }
  return null;
}

export default {
  id: 'shell-issue-comment',
  category: 'shell',
  failClosed: false,
  matches(toolName, toolArgs) {
    if (toolName !== 'powershell' && toolName !== 'bash') return false;
    const cmd = String(toolArgs?.command || '');
    if (!/\bgh\b/.test(cmd)) return false;
    return /comment/i.test(cmd);
  },
  check(toolArgs) {
    const cmd = String(toolArgs?.command || '');
    for (const seg of normalizeCommand(cmd)) {
      const reason = segmentDeniesIssueComment(seg);
      if (reason) return { decision: 'deny', reason };
    }
    return { decision: 'allow' };
  },
};
