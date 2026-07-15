import { createHash } from 'node:crypto';

export const QUEUE_LABEL = 'merge-train';
export const BLOCKED_LABEL = 'merge-train-blocked';
export const NOOP_LABEL = 'merge-train-noop';
// Durable, permanent marker that a PR's validated change actually reached
// `main` through the train. Unlike the transient QUEUE/BLOCKED labels (which
// are added and removed as a PR moves through admission and promotion), this
// label is only ever added and is never removed by the train. It carries the
// same meaning in two cases: (a) the normal path, where promotion adds it only
// AFTER the full post-merge proof passes and GitHub recorded the PR merged with
// a real merge commit (it doubles as the proof-complete recovery marker); and
// (b) the historical backfill (backfill-historical-landed.mjs), which adds it to
// force-push-era PRs whose commit reached `main` even though GitHub still
// records them `merged:false` -- those carry a truthful comment stating exactly
// that. So the label means "this PR's change is on main via the train", NOT by
// itself "GitHub records this PR merged"; consumers needing the latter must
// check GitHub's merged-state (which the normal path guarantees and the
// backfilled comment explicitly disclaims).
export const LANDED_LABEL = 'merge-train-landed';
export const CANDIDATE_CHECK_NAME = 'merge-train-candidate';
export const REQUIRED_CHECK_NAME = 'merge-train';
// The post-merge postcondition check is published on the ACTUAL landed commit
// (or the candidate, if no merge landed) when a sequential squash-merge
// promotion fails its proof. It is deliberately NOT named `merge-train`
// (REQUIRED_CHECK_NAME): a `merge-train` check on a real landed `main` commit
// would masquerade as the fast-path attestation `ci.yml`/`mainHealthReason`
// key on, and a squash-merged commit must instead earn ordinary push-CI
// evidence. This name is distinct so it never collides with that machinery.
export const PROMOTION_POSTCONDITION_CHECK_NAME = 'merge-train-promotion-postcondition';
export const STATUS_MARKER = '<!-- crawler-merge-train:v1 -->';
// Distinct sticky marker for the durable landed-completion comment. Kept
// separate from STATUS_MARKER so the permanent landed record is never
// overwritten by an ordinary queue-state update (renderStatus).
export const LANDED_MARKER = '<!-- crawler-merge-train-landed:v1 -->';
// Structured commit-message trailer keys. The exact same title/message are
// used both for the local candidate squash commits (buildCandidate) and for
// the real GitHub squash-merge commit_title/commit_message, so the durable
// PR<->commit mapping is identical no matter which path produced the commit.
export const MERGE_TRAIN_PR_TRAILER = 'Merge-Train-PR';
export const MERGE_TRAIN_ORIGINAL_HEAD_TRAILER = 'Merge-Train-Original-Head';
export const VALIDATION_FAILED_LABEL = 'merge-train-validation-failed';
export const DEFAULT_ADMISSION_CHECKS = ['ci', 'Security checks'];
export const MAX_TRAIN_SIZE = 6;

function compact(value) {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ');
}

export function parseEnabledFlag(value) {
  // Do not trim — exact match is required for consistency with workflow
  // expressions (vars.MERGE_TRAIN_ENABLED == 'true') and the shell guard
  // (case "$train_enabled" in true|false). Whitespace-padded values must
  // fail validation to prevent split-brain rollout.
  const normalized = String(value || 'false').replace(/\s+/g, ' ');
  if (!['true', 'false'].includes(normalized)) {
    throw new Error(`MERGE_TRAIN_ENABLED must be true or false, received: ${normalized}`);
  }
  return normalized === 'true';
}

export function hasLeadingMarker(body, marker) {
  return String(body || '')
    .trimStart()
    .startsWith(marker);
}

export function resolveAdmissionChecks(value, defaults = DEFAULT_ADMISSION_CHECKS) {
  const checks = Array.isArray(value)
    ? value
    : String(value || '')
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean);
  return checks.length > 0 ? checks : [...defaults];
}

export function queueEntries(pullRequests, repository) {
  return pullRequests
    .filter(
      (pr) =>
        pr.state === 'open' &&
        !pr.draft &&
        pr.base?.ref === 'main' &&
        pr.head?.repo?.full_name?.toLowerCase() === repository.toLowerCase() &&
        (pr.labels || []).some((label) => label.name === QUEUE_LABEL) &&
        !(pr.labels || []).some((label) => label.name === BLOCKED_LABEL),
    )
    .sort(
      (left, right) =>
        new Date(left.created_at).getTime() - new Date(right.created_at).getTime() ||
        left.number - right.number,
    );
}

export function candidateFingerprint(baseSha, entries) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        baseSha: compact(baseSha),
        entries: entries.map((entry) => ({
          number: entry.number,
          headSha: compact(entry.head?.sha),
          title: compact(entry.title),
        })),
      }),
    )
    .digest('hex');
}

export function candidateRef(slot, fingerprint) {
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_TRAIN_SIZE) {
    throw new Error(`Invalid merge-train slot: ${slot}`);
  }
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new Error('Candidate fingerprint must be a SHA-256 hex digest');
  }
  return `merge-train/candidate-${slot}-${fingerprint.slice(0, 16)}`;
}

export function admissionFingerprint({
  headSha,
  title,
  baseRef,
  checkRuns,
  requiredNames = DEFAULT_ADMISSION_CHECKS,
  reviewThreads,
}) {
  const checks = latestChecksByName(checkRuns);
  const requiredChecks = requiredNames
    .map((name) => {
      const check = checks.get(name.toLowerCase());
      return {
        name: name.toLowerCase(),
        id: Number(check?.id || 0),
        status: compact(check?.status),
        conclusion: compact(check?.conclusion),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  const threads = (reviewThreads || [])
    .map((thread) => ({
      id: compact(thread.id),
      resolved: Boolean(thread.isResolved),
      comments: (thread.comments?.nodes || []).map((comment) => ({
        id: compact(comment.id),
        body: String(comment.body || ''),
        author: compact(comment.author?.login),
      })),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return createHash('sha256')
    .update(
      JSON.stringify({
        headSha: compact(headSha),
        title: compact(title),
        baseRef: compact(baseRef),
        requiredChecks,
        threads,
      }),
    )
    .digest('hex');
}

export function nextBisectStep(prefixStates) {
  if (!Array.isArray(prefixStates) || prefixStates.length === 0) {
    throw new Error('At least one prefix state is required');
  }
  const total = prefixStates.length;
  if (prefixStates[total - 1] !== 'failure') {
    return { type: 'validate', prefixLength: total };
  }
  let red = total;
  let green = 0;
  for (let index = 0; index < total - 1; index += 1) {
    if (prefixStates[index] === 'success') {
      green = Math.max(green, index + 1);
    }
  }
  for (let index = green; index < total - 1; index += 1) {
    if (prefixStates[index] === 'failure') {
      red = Math.min(red, index + 1);
    }
  }
  if (red - green === 1) {
    return { type: 'isolate', greenPrefixLength: green, failingPrefixLength: red };
  }
  return { type: 'validate', prefixLength: Math.floor((green + red) / 2) };
}

// Decide the next promotion action under the "every promoted prefix is validated
// before it is exposed on main" invariant (ADR 0063). `prefixStates[i]` is the
// candidate-validation state of cumulative prefix T_(i+1) (one of
// 'missing' | 'pending' | 'success' | 'failure').
//
// The intended green prefix to promote is [0, target) where `target` is the
// earliest failing prefix (or the whole batch if none fails); prefixes at/after
// the earliest failure contain the culprit and are irrelevant. Every prefix in
// that target range must have terminal SUCCESS evidence before any merge:
//   - if any target-range prefix is still 'missing' -> validate them (the
//     caller dispatches all of them in parallel);
//   - else if any is still 'pending' -> wait for the validators;
//   - else the whole [0, target) is proven green -> promote it, and localize
//     the earliest failing PR (target) directly (no bisection needed).
export function planPrefixPromotion(prefixStates) {
  if (!Array.isArray(prefixStates) || prefixStates.length === 0) {
    return { action: 'noop' };
  }
  const firstFailure = prefixStates.indexOf('failure');
  const target = firstFailure === -1 ? prefixStates.length : firstFailure;
  const relevant = prefixStates.slice(0, target);
  const missing = [];
  let pending = false;
  relevant.forEach((state, index) => {
    if (state === 'missing') missing.push(index);
    else if (state === 'pending') pending = true;
  });
  if (missing.length > 0) return { action: 'validate', prefixes: missing, firstFailure };
  if (pending) return { action: 'wait', firstFailure };
  return { action: 'promote', greenPrefixLength: target, firstFailure };
}

export function commitTimestamp(entry) {
  const digest = createHash('sha256')
    .update(`${entry.number}\0${compact(entry.head?.sha)}\0${compact(entry.title)}`)
    .digest();
  const seconds = 1735689600 + (digest.readUInt32BE(0) % 31536000);
  return `@${seconds}`;
}

export function latestChecksByName(checkRuns) {
  const checks = new Map();
  for (const check of checkRuns) {
    const name = compact(check.name).toLowerCase();
    const existing = checks.get(name);
    if (!existing || Number(check.id) > Number(existing.id)) {
      checks.set(name, check);
    }
  }
  return checks;
}

export function unsatisfiedChecks(checkRuns, requiredNames = DEFAULT_ADMISSION_CHECKS) {
  const checks = latestChecksByName(checkRuns);
  return requiredNames.filter((name) => {
    const check = checks.get(name.toLowerCase());
    return check?.status !== 'completed' || check.conclusion !== 'success';
  });
}

export function successfulChecks(checkRuns, requiredNames = DEFAULT_ADMISSION_CHECKS) {
  return unsatisfiedChecks(checkRuns, requiredNames).length === 0;
}

// A candidate check normally completes within the validator's own
// `verify` timeout (20 minutes) plus the trivial time the `publish` job
// needs to mint an App token and post the completed check. If the
// `publish` job's app-token/checks.create step itself fails (secrets
// misconfigured, transient API error), no completed check is ever posted
// and the candidate would otherwise stay "pending" forever. Past this
// bound, treat the stale pending check the same as "missing" so the next
// reconciliation redispatches validation instead of waiting indefinitely.
export const CANDIDATE_VALIDATION_STALE_MS = 40 * 60 * 1000;

export function trainCheckState(checkRuns, fingerprint, trustedAppId, now = new Date()) {
  const check = latestChecksByName(
    checkRuns.filter(
      (candidate) =>
        compact(candidate.name).toLowerCase() === CANDIDATE_CHECK_NAME &&
        candidate.external_id === fingerprint &&
        Number(candidate.app?.id) === Number(trustedAppId),
    ),
  ).get(CANDIDATE_CHECK_NAME);
  if (!check) return 'missing';
  if (check.status !== 'completed') {
    const startedAt = Date.parse(check.started_at || check.created_at || '');
    if (Number.isFinite(startedAt) && now.getTime() - startedAt >= CANDIDATE_VALIDATION_STALE_MS) {
      return 'missing';
    }
    return 'pending';
  }
  // A dispatch/API failure to *reach* the validator is an infrastructure
  // problem, not a candidate code defect. It is recorded as a `cancelled`
  // conclusion (see reconcile.mjs dispatchValidation) so it is retried on
  // the next reconciliation instead of being bisected as a real failure.
  if (check.conclusion === 'cancelled') return 'missing';
  return check.conclusion === 'success' ? 'success' : 'failure';
}

export function renderStatus({ position, candidateSha, state, detail }) {
  return [
    STATUS_MARKER,
    '## Merge train',
    '',
    `- Position: ${position}`,
    `- Candidate: \`${candidateSha || 'not built'}\``,
    `- State: \`${state}\``,
    `- Detail: ${compact(detail)}`,
    '',
    '_Managed by the trusted repository merge-train workflow._',
  ].join('\n');
}

// The one-line squash commit subject for a promoted PR. Newlines in the PR
// title are collapsed so the subject stays a single line (mirrors the
// sanitization buildCandidate applied inline before this was shared). The
// trailing `(#<n>)` keeps GitHub's PR autolink and matches the local
// candidate commit subject exactly.
export function squashCommitTitle(entry) {
  const title = String(entry.title ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
  return `${title} (#${entry.number})`;
}

// The squash commit body carrying the durable PR<->commit trailer. Emitted
// identically for the local candidate commit and the real GitHub squash
// merge, so `parseMergeTrainPrNumber` resolves the origin PR from either.
export function squashCommitMessage(entry) {
  const headSha = String(entry.head?.sha ?? '').trim();
  return `${MERGE_TRAIN_PR_TRAILER}: ${entry.number}\n${MERGE_TRAIN_ORIGINAL_HEAD_TRAILER}: ${headSha}`;
}

// Resolve the origin PR number from a landed commit's full message via the
// durable trailer. Returns null when absent so callers can fall back to
// GitHub's commit-to-PR inference. Anchored to a full line and requires the
// exact `Merge-Train-PR: <digits>` shape so an unrelated mention in a body
// cannot be misread as the mapping.
export function parseMergeTrainPrNumber(commitMessage) {
  const match = String(commitMessage ?? '').match(/^Merge-Train-PR:[ \t]*(\d+)[ \t]*$/m);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isInteger(number) && number > 0 ? number : null;
}

// The durable landed-completion comment. Records the REAL GitHub merge commit
// and the validated candidate SHA it reproduced, under LANDED_MARKER so it is
// a permanent standalone record (never overwritten by renderStatus). Only
// posted after GitHub has recorded the PR as merged and every post-merge proof
// has passed.
export function renderLandedComment({ landedSha, candidateSha }) {
  return [
    LANDED_MARKER,
    '## Landed on `main` via the merge train ✅',
    '',
    `- Landed commit: \`${compact(landedSha)}\``,
    `- Validated candidate: \`${compact(candidateSha)}\``,
    '',
    'GitHub recorded this PR as **merged** with the landed commit above. Its',
    'tree was proven identical to the validated merge-train candidate before',
    'this record was written.',
    '',
    '_Managed by the trusted repository merge-train workflow._',
  ].join('\n');
}
