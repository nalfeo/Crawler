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
//   * PR *review thread* replies (`/pulls/<n>/comments/<id>/replies`) — those
//     carry the `✅ Addressed in <sha>` markers the merge gate depends on.

import { isGh, normalizeCommand, tokenize } from '../lib/shell.mjs';

const REMEDIATION =
  'Publish it with the progress-report tool instead (progress summary + PR description) — ' +
  'that is the plan/status of record, and CI recovery mirrors it onto the issue. ' +
  'Never block a session waiting for issue-comment access.';

const WRITE_METHODS = new Set(['post', 'patch', 'put', 'delete']);
const GLOBAL_FLAGS_WITH_VALUE = new Set(['-r', '--repo', '--hostname']);
const FIELD_FLAGS = new Set(['-f', '--field', '--raw-field', '--input']);
const API_FLAGS_WITH_VALUE = new Set([
  ...FIELD_FLAGS,
  '-x',
  '--method',
  '-h',
  '--header',
  '-q',
  '--jq',
  '-t',
  '--template',
  '--cache',
  '--hostname',
]);

function hasAttachedValue(token, flag) {
  const lower = token.toLowerCase();
  if (flag.startsWith('--')) return lower.startsWith(`${flag}=`);
  return lower.startsWith(flag) && lower.length > flag.length;
}

function consumesFlagValue(token, flagsWithValue) {
  const lower = token.toLowerCase();
  if (flagsWithValue.has(lower)) return true;
  for (const flag of flagsWithValue) {
    if (hasAttachedValue(token, flag)) return false;
  }
  return false;
}

function readCommandWord(tokens, startIndex, flagsWithValue) {
  let i = startIndex;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (!tok.startsWith('-')) return { word: tok.toLowerCase(), index: i };
    i += consumesFlagValue(tok, flagsWithValue) ? 2 : 1;
  }
  return { word: null, index: tokens.length };
}

function parseGhApi(tokens, startIndex) {
  let endpoint = null;
  let method = null;
  let hasFields = false;
  let pendingFlag = null;

  for (let i = startIndex; i < tokens.length; i++) {
    const tok = tokens[i];
    const lower = tok.toLowerCase();

    if (pendingFlag) {
      if (pendingFlag === '-x' || pendingFlag === '--method') method = lower;
      if (pendingFlag === '-f' || pendingFlag === '--field' || pendingFlag === '--raw-field') {
        hasFields = true;
      }
      if (pendingFlag === '--input') hasFields = true;
      pendingFlag = null;
      continue;
    }

    if (/^-X.+$/i.test(tok)) {
      method = tok.slice(2).toLowerCase();
      continue;
    }
    if (lower.startsWith('--method=')) {
      method = lower.slice('--method='.length);
      continue;
    }
    if (/^-[fF].+/.test(tok) || lower.startsWith('--field=') || lower.startsWith('--raw-field=')) {
      hasFields = true;
      continue;
    }
    if (lower.startsWith('--input=')) {
      hasFields = true;
      continue;
    }

    if (API_FLAGS_WITH_VALUE.has(tok) || API_FLAGS_WITH_VALUE.has(lower)) {
      pendingFlag = lower;
      continue;
    }

    if (consumesFlagValue(tok, API_FLAGS_WITH_VALUE)) {
      continue;
    }

    if (tok.startsWith('-')) continue;
    if (!endpoint) endpoint = tok;
  }

  return { endpoint, method, hasFields };
}

function isWriteApiCall(api) {
  if (api.method) return WRITE_METHODS.has(api.method);
  // `gh api` implicitly switches to POST when any field/input is supplied.
  return api.hasFields;
}

function isIssueCommentEndpoint(endpoint) {
  const path = endpoint.split('?')[0];
  return (
    /(^|\/)issues\/[^/]+\/comments\/?$/i.test(path) ||
    /(^|\/)issues\/comments\/[^/]+\/?$/i.test(path)
  );
}

function isPullReviewCommentCreateEndpoint(endpoint) {
  const path = endpoint.split('?')[0];
  return /(^|\/)pulls\/[^/]+\/comments\/?$/i.test(path);
}

function isPullReviewReplyEndpoint(endpoint) {
  const path = endpoint.split('?')[0];
  return /(^|\/)pulls\/[^/]+\/comments\/[^/]+\/replies\/?$/i.test(path);
}

function segmentDeniesIssueComment(seg) {
  if (!isGh(seg)) return null;
  const tokens = tokenize(seg);
  const first = readCommandWord(tokens, 1, GLOBAL_FLAGS_WITH_VALUE);
  if (!first.word) return null;

  if (first.word === 'issue') {
    const second = readCommandWord(tokens, first.index + 1, GLOBAL_FLAGS_WITH_VALUE);
    if (second.word !== 'comment') return null;
    return `Refusing \`gh issue comment\`: this session has no issue-comment credentials. Segment: \`${seg}\`. ${REMEDIATION}`;
  }
  if (first.word === 'pr') {
    const second = readCommandWord(tokens, first.index + 1, GLOBAL_FLAGS_WITH_VALUE);
    if (second.word !== 'comment') return null;
    return `Refusing \`gh pr comment\`: this session has no PR-comment credentials. Segment: \`${seg}\`. ${REMEDIATION}`;
  }
  if (first.word !== 'api') return null;

  const api = parseGhApi(tokens, first.index + 1);
  if (!api.endpoint) return null;
  const isWrite = isWriteApiCall(api);

  if (api.endpoint === 'graphql') {
    if (tokens.some((tok) => /\b(addComment|updateIssueComment)\b/.test(tok))) {
      return `Refusing a GraphQL comment mutation. Segment: \`${seg}\`. ${REMEDIATION}`;
    }
    return null;
  }

  if (!isWrite) return null;
  if (isIssueCommentEndpoint(api.endpoint)) {
    return `Refusing a write to an issue-comment API endpoint. Segment: \`${seg}\`. ${REMEDIATION}`;
  }
  if (isPullReviewReplyEndpoint(api.endpoint)) return null;
  if (isPullReviewCommentCreateEndpoint(api.endpoint)) {
    return `Refusing a write to a PR review-comment create endpoint. Segment: \`${seg}\`. ${REMEDIATION}`;
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
    if (!/\bgh(?:\.exe)?\b/i.test(cmd)) return false;
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
