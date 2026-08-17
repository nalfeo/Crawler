import { createHash } from 'node:crypto';

import { evaluateAdmission } from '../ci-recovery/state.mjs';

export const QUEUE_LABEL = 'merge-train';
export const BLOCKED_LABEL = 'merge-train-blocked';
export const RECOVERY_PENDING_LABEL = 'merge-train-recovery-pending';
export const NOOP_LABEL = 'merge-train-noop';
export const CI_CONFLICT_ORDER_WAIT_LABEL = 'ci-conflict-order-wait';
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
// would masquerade as the fast-path attestation `ci.yml`/`mainAttributionVerdict`
// key on, and a squash-merged commit must instead earn ordinary push-CI
// evidence. This name is distinct so it never collides with that machinery.
export const PROMOTION_POSTCONDITION_CHECK_NAME = 'merge-train-promotion-postcondition';
import {
  MERGE_TRAIN_STATUS_MARKER as STATUS_MARKER,
  MERGE_TRAIN_LANDED_MARKER as LANDED_MARKER,
} from '../ci-recovery/markers.mjs';
export { STATUS_MARKER, LANDED_MARKER };
// Distinct sticky marker for the durable landed-completion comment. Kept
// separate from STATUS_MARKER so the permanent landed record is never
// overwritten by an ordinary queue-state update (renderStatus).
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
        !(pr.labels || []).some((label) => label.name === BLOCKED_LABEL) &&
        !(pr.labels || []).some((label) => label.name === CI_CONFLICT_ORDER_WAIT_LABEL),
    )
    .sort(
      (left, right) =>
        new Date(left.created_at).getTime() - new Date(right.created_at).getTime() ||
        left.number - right.number,
    );
}

export function shouldWaitForCiConflictOrder(labels) {
  return (labels || []).some((label) => label.name === CI_CONFLICT_ORDER_WAIT_LABEL);
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
  return `refs/merge-train-candidates/candidate-${slot}-${fingerprint.slice(0, 16)}`;
}

export function candidateEvidenceId(fingerprint, candidateSha) {
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new Error('Candidate fingerprint must be a SHA-256 hex digest');
  }
  if (!/^[0-9a-f]{40}$/i.test(candidateSha)) {
    throw new Error('Candidate evidence requires a Git commit SHA');
  }
  // Hash the combined value so external_id stays within GitHub's 100-char limit
  // (fingerprint is 64 chars + ':' + 40-char SHA = 105 chars; SHA-256 hex = 64 chars).
  return createHash('sha256').update(`${fingerprint}:${candidateSha.toLowerCase()}`).digest('hex');
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
  // Semantic digest, not identity digest: only { name, status, conclusion }
  // participate. The raw check-run `id` is intentionally excluded -- GitHub
  // assigns a new id on every re-run even when the conclusion is unchanged,
  // so hashing it made the fingerprint drift on benign check-run churn (a
  // stale-but-still-green PR would flip from admissible to
  // "CI recovery admission evidence is stale" for no semantic reason).
  const requiredChecks = requiredNames
    .map((name) => {
      const check = checks.get(name.toLowerCase());
      return {
        name: name.toLowerCase(),
        status: compact(check?.status),
        conclusion: compact(check?.conclusion),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  // Collapse review threads to a single unresolved count instead of hashing
  // full thread/comment content. Lossless for both callers of this function:
  // eligible() itself rejects on `threads.some(t => !t.isResolved)` BEFORE
  // computing the fingerprint, and ci-recovery only persists a converged
  // fingerprint when it has already confirmed zero unresolved threads -- so
  // any unresolved thread is already a distinct blocker upstream, and a new
  // reply/comment on an already-resolved thread carries no admission-relevant
  // signal. Collapsing avoids fingerprint drift from thread content churn
  // (new replies, edited bodies) that doesn't change admission eligibility.
  const unresolvedThreadCount = (reviewThreads || []).filter((thread) => !thread.isResolved).length;
  return createHash('sha256')
    .update(
      JSON.stringify({
        headSha: compact(headSha),
        title: compact(title),
        baseRef: compact(baseRef),
        requiredChecks,
        unresolvedThreadCount,
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

// Validate the maximal FIFO prefix first. A successful maximal candidate proves
// the batch in one round. Only a genuine terminal failure enters bisection;
// cancelled, stale, and infrastructure outcomes are represented as `missing`
// and retry the same candidate instead of shrinking the batch.
export function planPrefixPromotion(prefixStates) {
  if (!Array.isArray(prefixStates) || prefixStates.length === 0) {
    return { action: 'noop' };
  }
  const maximalIndex = prefixStates.length - 1;
  const maximalState = prefixStates[maximalIndex];
  if (maximalState === 'missing') {
    return { action: 'validate', prefixes: [maximalIndex], firstFailure: -1 };
  }
  if (maximalState === 'pending') return { action: 'wait', firstFailure: -1 };
  if (maximalState === 'success') {
    return {
      action: 'promote',
      greenPrefixLength: prefixStates.length,
      firstFailure: -1,
      validationIndex: maximalIndex,
    };
  }

  const step = nextBisectStep(prefixStates);
  if (step.type === 'isolate') {
    return {
      action: 'promote',
      greenPrefixLength: step.greenPrefixLength,
      firstFailure: step.failingPrefixLength - 1,
      validationIndex: step.greenPrefixLength - 1,
    };
  }
  const index = step.prefixLength - 1;
  if (prefixStates[index] === 'pending') {
    return { action: 'wait', firstFailure: maximalIndex };
  }
  return { action: 'validate', prefixes: [index], firstFailure: maximalIndex };
}

/**
 * Attribution-aware wrapper around `planPrefixPromotion`.
 *
 * A RED maximal composite has two possible causes -- a queued PR broke it, or
 * `main` was already broken -- and the composite result alone cannot tell them
 * apart. Because a validation failure EJECTS the first failing addition, a
 * `main` that is red for an unrelated reason makes every prefix (including
 * prefix 1) fail, bisection converges on green=0/red=1, and the train ejects
 * innocent PRs one per round down the whole queue. So when, and ONLY when, the
 * maximal composite failed, `main`'s own health is consulted as an ATTRIBUTION
 * signal (ADR 0077):
 *
 *   - maximal success              -> promote. `mainVerdict` is never consulted.
 *   - maximal failure + not 'red'  -> unchanged bisect/isolate/eject.
 *   - maximal failure + 'red'      -> nothing is ever ejected. The largest
 *                                     already-proven green prefix STILL
 *                                     promotes (that is how a queued PR that
 *                                     FIXES `main` lands) with `firstFailure`
 *                                     suppressed to -1. Only when NO prefix is
 *                                     proven green does this return
 *                                     `action: 'pause'`, so no rounds are spent
 *                                     isolating an unattributable failure.
 *
 * `mainVerdict` is a zero-arg (optionally async) probe so that the
 * "never consulted on the promotion path" property is directly observable; it
 * returns `{ verdict }` from `mainAttributionVerdict`. Only a POSITIVE `'red'`
 * pauses: `'unknown'` attributes nothing and must not stall ejection.
 */
export async function planAttributedPrefixPromotion({ prefixStates, mainVerdict }) {
  if (!Array.isArray(prefixStates) || prefixStates.length === 0) {
    return { action: 'noop' };
  }
  const plan = planPrefixPromotion(prefixStates);
  if (prefixStates[prefixStates.length - 1] !== 'failure') return plan;

  // Any probe error fails open: treat it as `unknown` so a transient API failure
  // does not abort reconciliation (ADR 0077 — unavailable evidence attributes nothing).
  let verdictResult;
  try {
    verdictResult = (await mainVerdict()) || {};
  } catch (err) {
    const msg = err?.message || String(err);
    process.stderr.write(`[merge-train] mainVerdict probe failed (treating as unknown): ${msg}\n`);
    verdictResult = { verdict: 'unknown', reason: `attribution probe failed: ${msg}` };
  }
  const { verdict, reason } = verdictResult;
  if (verdict !== 'red') return plan;

  const attribution = reason || 'main is red';
  // An already-proven green prefix STILL promotes -- that is how a queued PR
  // which FIXES `main` lands. Only the ejection index is suppressed. This is
  // computed directly from `prefixStates` rather than read off `plan`, because
  // mid-bisection states such as ['success','missing','missing','failure']
  // return `action: 'validate'` (another round) even though prefix 1 is already
  // proven green -- pausing there would strand the repair and deadlock the
  // train, since `main` cannot go green until the repair lands.
  let greenPrefixLength = 0;
  for (let index = 0; index < prefixStates.length - 1; index += 1) {
    if (prefixStates[index] === 'success') greenPrefixLength = index + 1;
  }
  if (greenPrefixLength > 0) {
    return {
      action: 'promote',
      greenPrefixLength,
      firstFailure: -1,
      validationIndex: greenPrefixLength - 1,
      attribution,
    };
  }
  // Nothing is proven green, so there is nothing to promote and nothing that can
  // be honestly attributed. Any further bisection round would only spend rounds
  // narrowing a failure no queued PR is responsible for.
  return { action: 'pause', reason: attribution, greenPrefixLength: 0, firstFailure: -1 };
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

/**
 * Pure admission predicate for the merge train.
 * Delegates to evaluateAdmission (ci-recovery/state.mjs) so there is one
 * canonical admission policy that cannot drift between the merge-train and the
 * lifecycle FSM.  The `requiredChecks` argument is forwarded through the config
 * object so evaluateAdmission's existing signature is unaffected.
 *
 * @param {object} prFacts - current PR facts
 * @param {string[]} requiredChecks - required check names
 * @returns {{ eligible: boolean, reasons: string[] }}
 */
export function isAdmissible(prFacts, requiredChecks = DEFAULT_ADMISSION_CHECKS) {
  return evaluateAdmission(prFacts, { requiredChecks });
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

// The durable landed-completion comment, under LANDED_MARKER so it is a
// permanent standalone record (never overwritten by renderStatus).
//
// Two truthful modes:
//   - Normal (recovered=false): posted by promotion only after the full
//     post-merge proof passed, so it records the REAL merge commit AND the
//     validated candidate whose tree was proven identical.
//   - Recovered (recovered=true): posted by crash recovery, which finishes an
//     interrupted landing ONLY when the durable proof-complete marker (the
//     merge-train-landed label) is present. Promotion writes that marker
//     exclusively AFTER the full post-merge tree proof passed, so its presence
//     attests the proof ran and passed at merge time. Recovery also corroborates
//     GitHub's merged-state, the Merge-Train-PR trailer, a single (linear)
//     parent, and no promotion-postcondition failure, but does NOT re-run the
//     tree proof (the candidate is not reconstructable after main advances). It
//     therefore does NOT cite a validated candidate -- it reports only the
//     marker-attested merge-time proof plus the facts it actually re-verified.
export function renderLandedComment({ landedSha, candidateSha, recovered = false }) {
  if (recovered) {
    return [
      LANDED_MARKER,
      '## Landed on `main` via the merge train ✅ (recovered)',
      '',
      `- Landed commit: \`${compact(landedSha)}\``,
      '- Recovery status: durable proof revalidated',
      '',
      'Crash recovery revalidated the durable proof-complete record for this merged commit.',
      '',
      '_Managed by the trusted repository merge-train workflow._',
    ].join('\n');
  }
  return [
    LANDED_MARKER,
    '## Landed on `main` via the merge train ✅',
    '',
    `- Landed commit: \`${compact(landedSha)}\``,
    `- Validated batch candidate: \`${compact(candidateSha)}\``,
    '',
    'GitHub recorded this PR as **merged** with the landed commit above. Its',
    "tree was proven identical to this batch candidate's deterministic cumulative",
    'prefix before this record was written.',
    '',
    '_Managed by the trusted repository merge-train workflow._',
  ].join('\n');
}
