/**
 * Automated, lossless repair for a merge-train-quarantined restricted-branch
 * PR (see `reconcile.mjs`'s same-repo-restricted-branch 403 path and
 * `docs/knowledge/handoffs/2026-08-21-merge-train-fifo-deadlock.md`).
 *
 * Root cause this fixes: once `evaluateUnadvanceableStrike` ejects a PR and
 * applies `BLOCKED_LABEL`, the quarantine status comment tells a human to
 * "rebase the branch onto main out-of-band, then remove the label" -- but
 * nothing in the repository automated that. The one prior real-world attempt
 * (PR #3609, repairing PR #3594) shows exactly why that gap matters: it
 * recreated the SAME failure by pushing a new `copilot/*` branch (still
 * restricted) based on the OLD blocked branch (wrong base -- 60/64 files were
 * already on `main`, `mergeable_state: dirty`).
 *
 * This module performs the correct repair deterministically:
 *   1. Re-fetch the ORIGINAL PR live (never trust cached list/webhook data
 *      for the head SHA -- the branch may have moved since it was queued),
 *      and CONFIRM (via `isConfirmedRestrictedBranchQuarantine`, which reads
 *      the same `evaluateUnadvanceableStrike` status-comment marker the
 *      quarantine itself wrote) that `BLOCKED_LABEL` reflects THIS failure
 *      mode and not an unrelated validation failure or no-op de-admit that
 *      happens to share the label and a `copilot/*` head ref.
 *   2. Create a NEW branch at that EXACT commit, named outside the
 *      `copilot/*` namespace so it is writable by the automation identity
 *      (creating a brand-new ref is a plain `contents: write` operation --
 *      it is only *pushing to an existing* `copilot/*` ref that GitHub
 *      restricts to the Copilot App / branch owner).
 *   3. Open a replacement PR from that branch against `main` (never against
 *      the old blocked branch), carrying the original body verbatim (so any
 *      `Fixes #N` trailer still closes the same issue) plus a machine- and
 *      human-readable supersede marker naming the exact source SHA.
 *   4. Post a one-time linking comment on the ORIGINAL PR pointing at the
 *      replacement, then close the rejected original. Its commits are never
 *      touched -- nothing is lost; the writable replacement is the only PR
 *      left for the train to advance.
 *
 * Idempotency / concurrency safety: every step re-derives its own "already
 * done?" check from a REAL GitHub object (an existing ref, an existing PR for
 * that exact head branch, an existing marker comment) -- there is no separate
 * side-ledger that could go stale or be written before the object it
 * describes actually exists. A partial failure at any step (ref created, PR
 * creation failed; PR created, comment failed) is fully recoverable by
 * re-running: each step is a no-op if its target already exists, and a race
 * between two overlapping runs converges on the 422 "reference already
 * exists" / "pull request already exists" responses rather than duplicating
 * anything.
 *
 * Once a replacement PR exists, it OWNS the mutable branch's lifecycle, not
 * this function: the merge train's update-branch step will merge `main` into
 * it while advancing it (moving the tip away from the recorded `headSha`),
 * and GitHub may delete the branch once the replacement merges. A repair run
 * therefore always looks for an already-verified replacement BEFORE touching
 * the branch ref at all, and reacts explicitly to what it finds --
 * open (ensure the notice is posted), merged (terminal, nothing left to do),
 * or closed-without-merging (skip; recreating on this deterministic branch
 * name is a decision for a human, not this script) -- so a moved or deleted
 * branch is never mistaken for corruption, and a merged replacement is never
 * given a second, now-no-diff, sibling PR.
 *
 * "OWNS the mutable branch's lifecycle" is deliberately narrow, though: it
 * means the branch's tip is allowed to MOVE FORWARD from `headSha` (train
 * merges, then eventual merge/delete), not that ANY commit ever pushed to it
 * is trusted. `findVerifiedReplacementPr` therefore re-derives ancestry from
 * a live compare call for every non-merged replacement (open, or
 * closed-without-merging) before it is linked to, skipped, or reported as
 * repaired -- a force-push (accidental or hostile) that repoints an OPEN
 * replacement's branch at unrelated commits must never be accepted as
 * "linked-existing" just because it once carried the right marker and base.
 * A MERGED replacement is exempt from that ancestry re-check: it is terminal
 * by construction (see `finalizeExistingReplacement`), and by the time it
 * merges its tip has almost always already moved past `headSha` legitimately
 * (or the branch is gone), so re-deriving ancestry there would misfire on
 * the expected case, not the dangerous one.
 *
 * Every exported function is dependency-injected (`request`/`paginate` passed
 * in, mirroring `merge-train/reconcile-lib.mjs`) so tests exercise real
 * control flow against stub HTTP, never a live network call or a mocked
 * module import.
 */
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { encodeRefPath, paginate, request } from '../ci-recovery/github.mjs';
import {
  hasQuarantineRepairNoticeMarker,
  quarantineRepairNoticeMarker,
} from '../ci-recovery/markers.mjs';
import { TRUSTED_ASSOCIATIONS, TRUSTED_BOT_LOGINS } from '../ci-recovery/state.mjs';
import {
  UNADVANCEABLE_STRIKE_THRESHOLD,
  parseUnadvanceableStrike,
  resolveMergeTrainTokens,
} from './reconcile-lib.mjs';
import { BLOCKED_LABEL, STATUS_MARKER, hasLeadingMarker } from './state.mjs';

export const REPAIR_BRANCH_PREFIX = 'crawler-quarantine-repair/';
const REPAIR_MARKER_PREFIX = '<!-- crawler:quarantine-repair-of:';
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export function hasLabelNamed(pr, labelName) {
  return (pr?.labels || []).some(
    (label) => String(label?.name || label || '').toLowerCase() === String(labelName).toLowerCase(),
  );
}

export function isSameRepository(pr, repositoryFullName) {
  return (
    String(pr?.head?.repo?.full_name || '').toLowerCase() ===
    String(repositoryFullName || '').toLowerCase()
  );
}

/** Deterministic replacement-branch name: same PR + same head SHA always maps
 * to the same branch, so re-running the repair never creates duplicates. */
export function repairBranchName(prNumber, headSha) {
  return `${REPAIR_BRANCH_PREFIX}pr-${prNumber}-${String(headSha).slice(0, 12)}`;
}

export function renderRepairMarker(originalPrNumber, headSha) {
  return `${REPAIR_MARKER_PREFIX}${originalPrNumber}:${headSha} -->`;
}

export function parseRepairMarker(body) {
  const text = String(body || '');
  const start = text.indexOf(REPAIR_MARKER_PREFIX);
  if (start === -1) return null;
  const rest = text.slice(start + REPAIR_MARKER_PREFIX.length);
  const end = rest.indexOf('-->');
  if (end === -1) return null;
  const [prNumberText, shaText] = rest.slice(0, end).trim().split(':');
  const prNumber = Number.parseInt(prNumberText, 10);
  if (!Number.isInteger(prNumber) || !SHA_PATTERN.test(String(shaText || ''))) return null;
  return { prNumber, sha: shaText };
}

/**
 * Eligibility gate, re-evaluated against a FRESH fetch of the PR (never the
 * cached listing used to enumerate candidates) so a PR that was un-quarantined
 * or moved between listing and repair is never repaired based on stale state.
 *
 * `BLOCKED_LABEL` (`merge-train-blocked`) is NOT specific to the restricted-
 * branch 403 quarantine this module repairs -- `reconcile.mjs` applies the
 * SAME label to a validation failure (`blockEntry`) and to a no-op diff
 * de-admit (`deAdmitNoop`). This function checks only the label/repo/sha shape;
 * callers MUST additionally call `isConfirmedRestrictedBranchQuarantine`
 * (which reads the authoritative `evaluateUnadvanceableStrike` marker) before
 * treating a PR as eligible, or a validation-failure/no-op PR would get a
 * pointless sibling PR carrying the same bad diff. The branch name is
 * intentionally not used as a proxy for restricted ownership: GitHub can
 * restrict same-repository branches outside the `copilot/*` namespace.
 */
export function repairEligibility(pr, repositoryFullName) {
  if (String(pr?.state || '').toLowerCase() !== 'open') {
    return { eligible: false, reason: `PR #${pr?.number} is no longer open` };
  }
  if (!hasLabelNamed(pr, BLOCKED_LABEL)) {
    return {
      eligible: false,
      reason: `PR #${pr?.number} is no longer quarantined (missing ${BLOCKED_LABEL})`,
    };
  }
  if (!isSameRepository(pr, repositoryFullName)) {
    return { eligible: false, reason: `PR #${pr?.number} head is a fork; not eligible for repair` };
  }
  if (!SHA_PATTERN.test(String(pr?.head?.sha || ''))) {
    return { eligible: false, reason: `PR #${pr?.number} returned an invalid head sha` };
  }
  return { eligible: true, reason: 'quarantined restricted-branch PR' };
}

/**
 * The authoritative confirmation that a quarantined PR was actually ejected
 * via the same-repo-restricted-branch 403 path (`evaluateUnadvanceableStrike`
 * in `reconcile-lib.mjs`), not merely carrying `BLOCKED_LABEL` for an
 * unrelated reason (validation failure, no-op diff). The strike marker
 * records the head sha it was recorded against, so this also rejects a stale
 * record left over from a PREVIOUS head sha (the branch moved since
 * quarantine -- e.g. a human force-pushed a fix -- and may no longer be
 * un-advanceable at all).
 *
 * The status comment is matched to a TRUSTED author (`isTrustedNoticeAuthor`
 * -- the same GitHub App / bot-login / association allowlist already used for
 * the repair-notice comment below) before its strike record is trusted at
 * all. Without that check, any public commenter could pre-seed a leading
 * `STATUS_MARKER` comment carrying a threshold-reaching strike record for the
 * PR's visible head sha; if the PR were later given `BLOCKED_LABEL` for an
 * unrelated reason (a validation failure or no-op de-admit), this function
 * would otherwise treat the forged comment as proof of a restricted-branch
 * quarantine it never actually underwent, and repair would open a live
 * sibling PR carrying that same untrusted diff.
 */
export async function isConfirmedRestrictedBranchQuarantine({
  paginateFn,
  token,
  owner,
  repo,
  pr,
}) {
  const comments = await paginateFn(token, `/repos/${owner}/${repo}/issues/${pr.number}/comments`);
  const statusComment = comments.find(
    (comment) => hasLeadingMarker(comment.body, STATUS_MARKER) && isTrustedNoticeAuthor(comment),
  );
  const strike = parseUnadvanceableStrike(statusComment?.body || '');
  if (strike.strikes < UNADVANCEABLE_STRIKE_THRESHOLD) {
    return {
      confirmed: false,
      reason: `PR #${pr.number} carries ${BLOCKED_LABEL} but no confirmed restricted-branch quarantine record (strikes=${strike.strikes}); likely blocked for a different reason (validation failure or no-op diff)`,
    };
  }
  if (strike.headSha !== pr.head.sha) {
    return {
      confirmed: false,
      reason: `PR #${pr.number}'s quarantine record is for head \`${strike.headSha}\`, but the live head is now \`${pr.head.sha}\`; re-evaluate on the next merge-train pass`,
    };
  }
  return { confirmed: true, reason: 'confirmed restricted-branch quarantine record' };
}

function isTrustedNoticeAuthor(comment) {
  if (!comment) return false;
  if (comment.performed_via_github_app != null) return true;
  return (
    TRUSTED_ASSOCIATIONS.has(String(comment.author_association || '').toUpperCase()) ||
    TRUSTED_BOT_LOGINS.has(String(comment.user?.login || '').toLowerCase())
  );
}

export function buildReplacementBody({ original, headSha }) {
  return [
    `Automated quarantine repair for #${original.number}.`,
    '',
    `#${original.number}'s head branch \`${original.head.ref}\` is a restricted ` +
      'coding-agent branch that the merge train cannot push to (repeated update-branch ' +
      '403; see the merge-train-blocked status comment on that PR). This PR carries the ' +
      `exact same commits (head \`${headSha}\`) on a writable branch against \`main\` so ` +
      'the train can advance it.',
    '',
    `Supersedes #${original.number}.`,
    '',
    '---',
    '',
    String(original.body || ''),
    '',
    renderRepairMarker(original.number, headSha),
  ].join('\n');
}

/**
 * The notice marker MUST be the leading text of the comment body (not merely
 * present in it) so the ci-recovery-router workflow's `startsWith(comment.body,
 * '<!-- crawler-')` job guard recognizes this as a managed comment and skips
 * dispatching an unnecessary recovery run for it (see `markers.mjs`).
 */
export function buildSupersedeNoticeBody({ replacementPrNumber, headSha }) {
  return [
    quarantineRepairNoticeMarker(replacementPrNumber),
    '',
    `Quarantine repair: this PR's head branch cannot be updated by the merge train ` +
      `(repeated update-branch 403 -- \`${BLOCKED_LABEL}\`).`,
    `Replacement PR #${replacementPrNumber} carries the exact same commits ` +
      `(head \`${headSha}\`) on a writable branch against \`main\`.`,
    `This PR is closed after repair; land the work via #${replacementPrNumber}.`,
  ].join('\n');
}

async function getRefSha({ requestFn, token, owner, repo, branchName }) {
  try {
    const response = await requestFn(
      token,
      `/repos/${owner}/${repo}/git/ref/${encodeRefPath(`heads/${branchName}`)}`,
    );
    return response.data?.object?.sha || null;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

/**
 * Verifies a candidate replacement PR's CURRENT head sha still legitimately
 * descends from (or equals) the original quarantined PR's `headSha`, using
 * the same compare-API ancestry pattern `backfill-historical-landed.mjs`
 * uses to confirm a commit reached `main`. This is the check that closes the
 * force-push gap: the marker/base checks in `findVerifiedReplacementPr` only
 * prove the replacement PR was ONCE opened correctly against the right
 * branch name -- they say nothing about what commits that branch carries
 * NOW, and nothing stops a force-push (malicious or accidental) from
 * repointing an OPEN or CLOSED-unmerged replacement's branch at unrelated
 * commits after the fact. A MERGED replacement is intentionally exempt (see
 * the `replacementLifecycleState` check at the call site): the merge train
 * legitimately advances an open replacement's tip by merging `main` into it
 * while advancing, and once merged the branch may be moved further or
 * deleted entirely, so `headSha` no longer being its tip is the expected,
 * safe, idempotent case, not corruption.
 *
 * `identical` (branch tip unchanged) and `ahead` (branch tip advanced with
 * `headSha` still an ancestor -- e.g. `main` was merged in) are both
 * legitimate outcomes of the compare `headSha...replacementHeadSha`;
 * anything else (`diverged`/`behind`, or an unreadable/deleted commit) means
 * the branch no longer provably carries the original quarantined commit, so
 * it is refused rather than silently linked to or reported as already
 * repaired.
 */
async function verifyReplacementHeadDescendsFromOriginal({
  requestFn,
  token,
  owner,
  repo,
  candidate,
  headSha,
}) {
  const replacementHeadSha = candidate.head?.sha;
  if (!SHA_PATTERN.test(String(replacementHeadSha || ''))) {
    throw new Error(
      `PR #${candidate.number} on branch \`${candidate.head?.ref ?? '<unknown>'}\` has no ` +
        'readable head sha; refusing to link to it',
    );
  }
  if (replacementHeadSha === headSha) return;
  let comparison;
  try {
    comparison = (
      await requestFn(
        token,
        `/repos/${owner}/${repo}/compare/${encodeURIComponent(headSha)}...${encodeURIComponent(replacementHeadSha)}`,
      )
    ).data;
  } catch (error) {
    throw new Error(
      `Could not verify PR #${candidate.number}'s head \`${replacementHeadSha}\` descends from the ` +
        `original quarantined head \`${headSha}\` (${error?.status ?? 'network'}); refusing to link to it`,
    );
  }
  if (comparison?.status !== 'ahead' && comparison?.status !== 'identical') {
    throw new Error(
      `PR #${candidate.number}'s head \`${replacementHeadSha}\` does not descend from the original ` +
        `quarantined head \`${headSha}\` (compare status: ${comparison?.status}); refusing to link to it`,
    );
  }
}

/**
 * Finds a previously-created replacement PR for this exact branch, verifying
 * it against the repair marker (not merely its existence) before it is ever
 * reused: the branch name is entirely ours (derived from `prNumber`+`headSha`
 * and never used by anything else in the repository), so a PR on it that
 * does NOT carry our marker for this exact `(originalPrNumber, headSha)` pair
 * indicates a corrupted or unexpected prior state -- fail loud rather than
 * silently link the original PR to the wrong replacement.
 *
 * Looks across every state (open, merged, closed), not just open: once a
 * replacement PR exists it owns the mutable branch's lifecycle (see
 * `finalizeExistingReplacement`), and a merged or closed replacement is a
 * REAL prior outcome that must be recognized, never re-discovered as "no
 * replacement yet" and repaired a second time. Prefers an open PR if one
 * exists, then a merged one, then falls back to the most recently listed
 * closed-unmerged one -- GitHub allows only one open PR per head+base pair,
 * but history can accumulate more than one closed/merged entry over time.
 *
 * The marker and base checks alone only prove what was true when the
 * replacement was ORIGINALLY opened -- they are silent about the branch's
 * CURRENT tip. So for every state except `merged` (which legitimately owns
 * the branch's mutable lifecycle -- see `verifyReplacementHeadDescendsFromOriginal`),
 * this additionally re-derives ancestry from a live compare call before the
 * candidate is ever returned to a caller that might link, skip, or report it
 * as already repaired.
 */
async function findVerifiedReplacementPr({
  requestFn,
  token,
  owner,
  repo,
  branchName,
  baseBranch,
  originalPrNumber,
  headSha,
}) {
  const response = await requestFn(
    token,
    `/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branchName}`)}&state=all&per_page=10`,
  );
  const candidates = Array.isArray(response.data) ? response.data : [];
  if (candidates.length === 0) return null;
  const candidate =
    candidates.find((pr) => String(pr?.state || '').toLowerCase() === 'open') ??
    candidates.find((pr) => pr?.merged === true || pr?.merged_at) ??
    candidates[0];
  const marker = parseRepairMarker(candidate.body);
  if (!marker || marker.prNumber !== originalPrNumber || marker.sha !== headSha) {
    throw new Error(
      `Branch ${branchName} already has PR #${candidate.number}, but its body does not carry ` +
        `the expected repair marker for #${originalPrNumber}@${headSha}; refusing to link to it`,
    );
  }
  if (String(candidate.base?.ref || '') !== baseBranch) {
    throw new Error(
      `Branch ${branchName}'s PR #${candidate.number} targets base \`${candidate.base?.ref}\`, expected \`${baseBranch}\`; refusing to link to it`,
    );
  }
  if (replacementLifecycleState(candidate) !== 'merged') {
    await verifyReplacementHeadDescendsFromOriginal({
      requestFn,
      token,
      owner,
      repo,
      candidate,
      headSha,
    });
  }
  return candidate;
}

/**
 * Classifies a verified replacement PR's lifecycle so the caller can react
 * explicitly instead of assuming "open" is the only possible state (see
 * `finalizeExistingReplacement`). GitHub's list-pulls response includes
 * `merged_at` (and the single-PR "get" response also includes a `merged`
 * boolean) for merged PRs, but never both a `state: 'open'` AND a `merged_at`
 * together, so checking `state` first is sufficient to distinguish the two
 * non-open outcomes.
 */
function replacementLifecycleState(pr) {
  if (String(pr?.state || '').toLowerCase() === 'open') return 'open';
  if (pr?.merged === true || pr?.merged_at) return 'merged';
  return 'closed';
}

async function postSupersedeNoticeOnce({
  requestFn,
  paginateFn,
  token,
  owner,
  repo,
  originalPrNumber,
  replacementPrNumber,
  headSha,
}) {
  const marker = quarantineRepairNoticeMarker(replacementPrNumber);
  const comments = await paginateFn(
    token,
    `/repos/${owner}/${repo}/issues/${originalPrNumber}/comments`,
  );
  // Only a comment posted by the trusted automation identity (or another
  // trusted association/bot) can suppress re-posting -- otherwise any
  // collaborator or third-party bot commenting with the literal marker text
  // could permanently silence the audit notice.
  if (
    comments.some(
      (comment) =>
        isTrustedNoticeAuthor(comment) &&
        hasQuarantineRepairNoticeMarker(comment.body, replacementPrNumber),
    )
  ) {
    return false;
  }
  await requestFn(token, `/repos/${owner}/${repo}/issues/${originalPrNumber}/comments`, {
    method: 'POST',
    body: { body: buildSupersedeNoticeBody({ replacementPrNumber, headSha }) },
  });
  return true;
}

/**
 * Finalizes repair for a branch that ALREADY has a verified replacement PR
 * (any lifecycle state), reacting explicitly to each outcome instead of
 * assuming "open" is the only possibility:
 *
 *   - open: the normal steady state -- ensure the one-time linking notice is
 *     posted, then close the rejected original.
 *   - merged: the replacement already landed the work on `main`. This is
 *     terminal -- there is nothing left to repair, and the branch's tip
 *     almost always no longer equals the original's `headSha` (the merge
 *     train's update-branch step merges `main` into it while advancing it,
 *     and GitHub may have auto-deleted the branch after merge). Neither is a
 *     corruption to refuse; treating this PR's existence as sufficient
 *     (rather than re-deriving from the branch ref) is what keeps re-running
 *     the repair idempotent instead of throwing or fabricating a second,
 *     now-no-diff, replacement PR.
 *   - closed (not merged): a human (or a previous automated attempt) closed
 *     the replacement without landing it. Recreating a PR on this exact
 *     deterministic branch name automatically would either reopen work a
 *     human already rejected, or -- if the branch was since deleted --
 *     silently fabricate a fresh PR carrying commits that may already be on
 *     `main` via some other path. That decision needs a human, so this is
 *     reported as a skip rather than acted on.
 */
async function finalizeExistingReplacement({
  requestFn,
  paginateFn,
  token,
  owner,
  repo,
  originalPrNumber,
  replacement,
  branchName,
  headSha,
}) {
  const state = replacementLifecycleState(replacement);
  if (state === 'closed') {
    return {
      action: 'skip',
      originalPrNumber,
      replacementPrNumber: replacement.number,
      branchName,
      headSha,
      reason:
        `Replacement PR #${replacement.number} for #${originalPrNumber} was closed without ` +
        `merging; not auto-recreating a replacement on ${branchName} -- resolve manually`,
    };
  }

  const noticePosted = await postSupersedeNoticeOnce({
    requestFn,
    paginateFn,
    token,
    owner,
    repo,
    originalPrNumber,
    replacementPrNumber: replacement.number,
    headSha,
  });
  await closeOriginalPr({ requestFn, token, owner, repo, originalPrNumber });

  return {
    action: state === 'merged' ? 'already-repaired' : 'linked-existing',
    originalPrNumber,
    replacementPrNumber: replacement.number,
    branchName,
    headSha,
    noticePosted,
  };
}

async function closeOriginalPr({ requestFn, token, owner, repo, originalPrNumber }) {
  await requestFn(token, `/repos/${owner}/${repo}/pulls/${originalPrNumber}`, {
    method: 'PATCH',
    body: { state: 'closed' },
  });
}

/**
 * Repairs a single quarantined PR. Safe to call repeatedly (and, given the
 * fresh-fetch + real-object idempotency checks throughout, safe to call
 * concurrently from overlapping runs): every step is a no-op once its target
 * already exists.
 */
export async function repairQuarantinedPr({
  requestFn,
  paginateFn,
  token,
  owner,
  repo,
  originalPrNumber,
  baseBranch = 'main',
}) {
  const repositoryFullName = `${owner}/${repo}`;
  const original = (await requestFn(token, `/repos/${owner}/${repo}/pulls/${originalPrNumber}`))
    .data;
  const eligibility = repairEligibility(original, repositoryFullName);
  if (!eligibility.eligible) {
    return { action: 'skip', originalPrNumber, reason: eligibility.reason };
  }
  const confirmation = await isConfirmedRestrictedBranchQuarantine({
    paginateFn,
    token,
    owner,
    repo,
    pr: original,
  });
  if (!confirmation.confirmed) {
    return { action: 'skip', originalPrNumber, reason: confirmation.reason };
  }

  const headSha = original.head.sha;
  const branchName = repairBranchName(originalPrNumber, headSha);

  // Look for an already-verified replacement FIRST, before ever touching the
  // branch ref. Once a replacement PR exists it owns the branch's mutable
  // lifecycle (the merge train's update-branch step moves its tip merging in
  // `main`, and GitHub may delete it after merge) -- neither is a corruption
  // this function should refuse or repair around. Only the very-first repair
  // pass (no replacement anywhere yet) legitimately owns comparing/creating
  // the branch ref itself.
  const existingReplacement = await findVerifiedReplacementPr({
    requestFn,
    token,
    owner,
    repo,
    branchName,
    baseBranch,
    originalPrNumber,
    headSha,
  });
  if (existingReplacement) {
    return finalizeExistingReplacement({
      requestFn,
      paginateFn,
      token,
      owner,
      repo,
      originalPrNumber,
      replacement: existingReplacement,
      branchName,
      headSha,
    });
  }

  const existingBranchSha = await getRefSha({ requestFn, token, owner, repo, branchName });
  if (existingBranchSha && existingBranchSha !== headSha) {
    // The branch name is derived from (prNumber, headSha) with a 12-hex-char
    // truncation. A mismatch here means either an extraordinarily unlikely
    // truncation collision or a corrupted prior run -- refuse to overwrite an
    // existing ref rather than silently repointing (and possibly orphaning)
    // whatever commits it currently carries.
    throw new Error(
      `Repair branch ${branchName} exists at ${existingBranchSha}, expected ${headSha}; refusing to overwrite`,
    );
  }
  if (!existingBranchSha) {
    try {
      await requestFn(token, `/repos/${owner}/${repo}/git/refs`, {
        method: 'POST',
        body: { ref: `refs/heads/${branchName}`, sha: headSha },
      });
    } catch (error) {
      if (error.status === 422 && /already exists/i.test(String(error.message))) {
        // Race: another run created the ref between our GET and this POST.
        const racedSha = await getRefSha({ requestFn, token, owner, repo, branchName });
        if (racedSha !== headSha) {
          throw new Error(
            `Repair branch ${branchName} was concurrently created at ${racedSha}, expected ${headSha}; refusing to overwrite`,
          );
        }
      } else {
        throw error;
      }
    }
  }

  let replacement;
  let created = false;
  try {
    const response = await requestFn(token, `/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      body: {
        title: `${original.title} (quarantine repair of #${originalPrNumber})`,
        head: branchName,
        base: baseBranch,
        body: buildReplacementBody({ original, headSha }),
        maintainer_can_modify: true,
      },
    });
    replacement = response.data;
    created = true;
  } catch (error) {
    if (error.status === 422 && /already exists/i.test(String(error.message))) {
      // Race: another run created the PR between our check and this POST.
      replacement = await findVerifiedReplacementPr({
        requestFn,
        token,
        owner,
        repo,
        branchName,
        baseBranch,
        originalPrNumber,
        headSha,
      });
      if (!replacement) throw error;
    } else {
      throw error;
    }
  }

  const noticePosted = await postSupersedeNoticeOnce({
    requestFn,
    paginateFn,
    token,
    owner,
    repo,
    originalPrNumber,
    replacementPrNumber: replacement.number,
    headSha,
  });
  await closeOriginalPr({ requestFn, token, owner, repo, originalPrNumber });

  return {
    action: created ? 'repaired' : 'linked-existing',
    originalPrNumber,
    replacementPrNumber: replacement.number,
    branchName,
    headSha,
    noticePosted,
  };
}

/** Enumerates every open, quarantined PR (labels API, mirroring the pattern
 * `epic-reprocess.mjs` uses for `labels=epic`), then attempts repair on each. */
export async function repairAllQuarantinedPrs({
  requestFn,
  paginateFn,
  token,
  owner,
  repo,
  baseBranch = 'main',
}) {
  const labeled = await paginateFn(
    token,
    `/repos/${owner}/${repo}/issues?state=open&labels=${encodeURIComponent(BLOCKED_LABEL)}`,
  );
  const candidateNumbers = labeled
    .filter((issue) => issue.pull_request)
    .map((issue) => issue.number);
  const results = [];
  for (const originalPrNumber of candidateNumbers) {
    try {
      results.push(
        await repairQuarantinedPr({
          requestFn,
          paginateFn,
          token,
          owner,
          repo,
          originalPrNumber,
          baseBranch,
        }),
      );
    } catch (error) {
      results.push({
        action: 'error',
        originalPrNumber,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

async function main() {
  const { promotionToken } = resolveMergeTrainTokens(process.env);
  const repository = process.env.GITHUB_REPOSITORY || '';
  const [owner, repo] = repository.split('/');
  if (!owner || !repo) {
    throw new Error('GITHUB_REPOSITORY is required');
  }

  const results = await repairAllQuarantinedPrs({
    requestFn: request,
    paginateFn: paginate,
    token: promotionToken,
    owner,
    repo,
  });
  let errors = 0;
  for (const result of results) {
    if (result.action === 'error') {
      errors += 1;
      process.stdout.write(
        `quarantine-repair pr=#${result.originalPrNumber} error=${result.reason}\n`,
      );
    } else if (result.action === 'skip') {
      process.stdout.write(
        `quarantine-repair pr=#${result.originalPrNumber} skip: ${result.reason}\n`,
      );
    } else {
      process.stdout.write(
        `quarantine-repair pr=#${result.originalPrNumber} ${result.action} replacement=#${result.replacementPrNumber} branch=${result.branchName} head=${result.headSha}\n`,
      );
    }
  }
  process.stdout.write(`quarantine-repair candidates=${results.length} errors=${errors}\n`);
  if (errors > 0) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(
      `quarantine-repair failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
