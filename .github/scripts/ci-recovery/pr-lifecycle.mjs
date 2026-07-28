/**
 * pr-lifecycle.mjs — Authoritative PR-lifecycle state machine.
 *
 * This is the sole writer of PR phase (repairing/queued/ordering/merging/done/
 * quarantined/abandoned) via labels and the lifecycle state comment.
 *
 * The merge-train and conflict-coordinator machines are demoted to pure
 * predicates (isAdmissible, whoMustLandFirst) that answer questions without
 * independently mutating PR state. This lifecycle owner is the single writer.
 *
 * Design source: docs/knowledge/ci-recovery/2026-07-20-harness-holistic-review.md §7.1
 * Fixes: D1 (admission deadlock), D5 (release unreachable), D9 (stale cluster),
 *        D11 (quarantined dead-heads the train).
 */

import {
  LIFECYCLE_PHASES,
  NON_BLOCKING_PHASES,
  QUARANTINE_COMMENT_MARKER,
  TERMINAL_PHASES,
  evaluateAdmission,
} from './state.mjs';
import { isAdmissible } from '../merge-train/state.mjs';
import { whoMustLandFirst } from '../ci-conflict-coordinator/state.mjs';
import { LIFECYCLE_DATA_PREFIX, LIFECYCLE_MARKER } from './markers.mjs';

export { LIFECYCLE_MARKER, LIFECYCLE_DATA_PREFIX };

// Phase enum (mirrors LIFECYCLE_PHASES in state.mjs).
export const PHASE = { ...LIFECYCLE_PHASES };

// The single label that encodes each phase. The lifecycle owner is the only
// writer of these; every other machine reads them.
//
// NOTE: PHASE.ORDERING maps to 'ci-lifecycle-ordering', NOT 'ci-conflict-order-wait'.
// The conflict-coordinator uses 'ci-conflict-order-wait' (ORDER_WAIT_LABEL) as its
// own fence label; that is a coordinator sub-phase signal written via applyRawLabelDecision.
// Using different labels prevents two-writer conflicts where the coordinator removes
// ORDER_WAIT_LABEL without the lifecycle FSM knowing — the lifecycle comment would
// then disagree with the actual label state.
export const PHASE_LABELS = {
  [PHASE.REPAIRING]: 'ci-recovery-waiting',
  [PHASE.QUEUED]: 'merge-train',
  [PHASE.ORDERING]: 'ci-lifecycle-ordering',
  [PHASE.MERGING]: 'merge-train',
  [PHASE.DONE]: 'merge-train-landed',
  [PHASE.QUARANTINED]: 'ci-lifecycle-quarantined',
  [PHASE.ABANDONED]: 'ci-lifecycle-abandoned',
};

export { isAdmissible, whoMustLandFirst, evaluateAdmission };

function compact(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Returns true for phases that are structurally non-blocking:
 * isAdmissible() returns false, whoMustLandFirst() never returns them as leader,
 * they are never emitted as order predecessors.
 * Structural guarantee: a PR in these phases can never dead-head another PR (D11).
 */
export function isNonBlocking(phase) {
  return phase === PHASE.QUARANTINED || phase === PHASE.ABANDONED;
}

export function isTerminal(phase) {
  return TERMINAL_PHASES.has(phase);
}

/** The non-blocking phase names, for passing into whoMustLandFirst(). */
export function nonBlockingPhases() {
  return [...NON_BLOCKING_PHASES];
}

/**
 * Pure lifecycle record factory.
 */
export function makeLifecycleRecord({ prNumber, phase, blockReason = null, headSha, updatedAt }) {
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`Invalid PR number: ${prNumber}`);
  }
  if (!Object.values(PHASE).includes(phase)) {
    throw new Error(`Invalid lifecycle phase: ${phase}`);
  }
  const record = {
    version: 1,
    prNumber,
    phase,
    blockReason: blockReason ? compact(blockReason) : null,
    headSha: compact(headSha),
    updatedAt: compact(updatedAt),
  };
  if (!record.headSha) throw new Error('Lifecycle record requires a head SHA');
  if (Number.isNaN(Date.parse(record.updatedAt))) {
    throw new Error('Lifecycle record timestamp is invalid');
  }
  return record;
}

/**
 * Evaluate the current lifecycle phase from PR facts.
 * Pure function — no async, no side effects.
 *
 * Golden fixture: a PR with status=waiting, owner=none, blockers=[], current head,
 * and green required CI must transition to QUEUED (not remain in waiting).
 * Golden fixture: a PR that lacks the merge-train label but is green+mergeable+
 * non-draft must evaluate to QUEUED and trigger re-admission.
 *
 * @param {object} prFacts
 * @param {object} [trainState] - {queued, promoting, landed}
 * @param {object} [clusterState] - {inCluster, leaderNumber, members, proofs}
 * @returns {{ phase: string, blockReason: string|null, reasons: string[],
 *            admission: {eligible: boolean, reasons: string[]}, readmit: boolean }}
 */
export function evaluatePhase(prFacts, trainState = {}, clusterState = {}) {
  const facts = prFacts || {};
  const train = trainState || {};
  const cluster = clusterState || {};

  const declared = facts.disposition || facts.lifecyclePhase || null;
  if (isNonBlocking(declared)) {
    return {
      phase: declared,
      blockReason: facts.blockReason ? compact(facts.blockReason) : `disposition:${declared}`,
      reasons: [`lifecycle-phase:${declared}`],
      admission: { eligible: false, reasons: [`lifecycle-phase:${declared}`] },
      readmit: false,
    };
  }

  if (facts.merged === true || facts.state === 'merged' || train.landed === true) {
    return {
      phase: PHASE.DONE,
      blockReason: null,
      reasons: [],
      admission: { eligible: false, reasons: ['pr-not-open'] },
      readmit: false,
    };
  }

  if (facts.state && facts.state !== 'open') {
    return {
      phase: PHASE.ABANDONED,
      blockReason: `pr-${facts.state}`,
      reasons: ['pr-not-open'],
      admission: { eligible: false, reasons: ['pr-not-open'] },
      readmit: false,
    };
  }

  const admission = evaluateAdmission(facts);
  if (!admission.eligible) {
    return {
      phase: PHASE.REPAIRING,
      blockReason: admission.reasons.join(','),
      reasons: admission.reasons,
      admission,
      readmit: false,
    };
  }

  // Admissible. Ordering only applies when a live cluster actually names a
  // different PR as the one that must land first. A cluster snapshot that no
  // longer contains this PR can never pin it in ORDERING (D9).
  const members = cluster.members || cluster.cluster || [];
  const inCluster =
    cluster.inCluster === true ||
    members.some((member) => Number(member?.number) === Number(facts.prNumber));
  if (inCluster) {
    const { leader } = whoMustLandFirst(members, cluster.proofs || [], nonBlockingPhases());
    const leaderNumber = Number(cluster.leaderNumber ?? leader?.number ?? facts.prNumber);
    if (Number.isFinite(leaderNumber) && leaderNumber !== Number(facts.prNumber)) {
      return {
        phase: PHASE.ORDERING,
        blockReason: `ordering-behind:${leaderNumber}`,
        reasons: [`ordering-behind:${leaderNumber}`],
        admission,
        readmit: false,
      };
    }
  }

  if (train.promoting === true || Number(train.promoting) === Number(facts.prNumber)) {
    return {
      phase: PHASE.MERGING,
      blockReason: null,
      reasons: [],
      admission,
      readmit: false,
    };
  }

  return {
    phase: PHASE.QUEUED,
    blockReason: null,
    reasons: [],
    admission,
    // An admissible PR that is not currently enrolled must be re-admitted.
    // Reporting "train empty" for such a PR is the D1 admission deadlock.
    readmit: train.queued !== true,
  };
}

/**
 * Render the lifecycle comment.
 */
export function renderLifecycleComment(record) {
  const encoded = Buffer.from(JSON.stringify(record), 'utf8').toString('base64url');
  return [
    LIFECYCLE_MARKER,
    `${LIFECYCLE_DATA_PREFIX}${encoded} -->`,
    '## Crawler PR lifecycle',
    '',
    `- Phase: \`${record.phase}\``,
    `- Head: \`${record.headSha}\``,
    `- Blocked by: ${record.blockReason || 'nothing'}`,
    `- Updated: ${record.updatedAt}`,
    '',
    '_This comment is managed by the authoritative PR-lifecycle owner._',
  ].join('\n');
}

/**
 * Parse the lifecycle comment. Returns null when the marker is absent.
 */
export function parseLifecycleComment(body) {
  if (!String(body ?? '').includes(LIFECYCLE_MARKER)) return null;
  const escaped = LIFECYCLE_DATA_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(body).match(new RegExp(`${escaped}([A-Za-z0-9_-]+)\\s*-->`));
  if (!match) throw new Error('PR lifecycle marker has no encoded payload');
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
  } catch (error) {
    throw new Error(`PR lifecycle payload is invalid: ${error.message}`);
  }
  return makeLifecycleRecord(parsed);
}

/**
 * Apply a lifecycle decision. In dry-run mode, logs the decision without writing.
 * Returns { acted, noOp, phase, reason }.
 *
 * Acted-vs-no-op contract: every call returns an explicit { acted, noOp } signal.
 * A successful no-op never shares an indistinguishable "success" signal with a
 * completed action, so a disabled/dry-run sweep can never look like a completed
 * action (D-class: "green means two things").
 *
 * No-op requires phase AND headSha to match the current record. A force-push that
 * keeps the same phase must still update the lifecycle comment to reflect the new
 * head SHA, so it is treated as acted, not no-op.
 */
export async function applyLifecycleDecision({
  prNumber,
  currentPhase,
  currentHeadSha = null,
  targetPhase,
  blockReason = null,
  headSha,
  mode,
  writeComment,
  addLabel,
  removeLabel,
  now = new Date(),
}) {
  // True no-op: same phase AND the caller explicitly provided the current head SHA and it
  // matches the target. Callers that omit currentHeadSha cannot know whether the comment
  // is already current for this head, so they are treated as "changed" and the record is
  // always rewritten. This prevents a wired caller from inadvertently leaving the lifecycle
  // comment bound to a stale head after a force-push when it forgets to pass currentHeadSha.
  const samePhase = currentPhase === targetPhase;
  const headShaChanged =
    currentHeadSha == null || compact(currentHeadSha) !== compact(headSha);
  if (samePhase && !headShaChanged) {
    return { acted: false, noOp: true, phase: currentPhase, reason: 'already-in-phase' };
  }

  if (mode === 'dry-run') {
    return { acted: false, noOp: false, dryRun: true, phase: targetPhase, reason: 'dry-run' };
  }

  const record = Object.values(PHASE).includes(targetPhase)
    ? makeLifecycleRecord({
        prNumber,
        phase: targetPhase,
        blockReason,
        headSha,
        updatedAt: now.toISOString(),
      })
    : null;

  // A phase resolves to its canonical label; a raw label name (used by callers
  // that delegate a single fence label to the lifecycle owner) passes through.
  const previousLabel = currentPhase ? (PHASE_LABELS[currentPhase] ?? currentPhase) : null;
  const nextLabel = targetPhase ? (PHASE_LABELS[targetPhase] ?? targetPhase) : null;

  if (previousLabel && previousLabel !== nextLabel && typeof removeLabel === 'function') {
    await removeLabel(prNumber, previousLabel);
  }
  if (nextLabel && typeof addLabel === 'function' && (!samePhase || headShaChanged)) {
    await addLabel(prNumber, nextLabel);
  }
  if (record && typeof writeComment === 'function') {
    await writeComment(prNumber, renderLifecycleComment(record));
  }

  return { acted: true, noOp: false, phase: targetPhase, record };
}

/**
 * Apply a coordinator-level raw label decision.
 * Used by the conflict-coordinator for fence labels (e.g. ci-conflict-order-wait)
 * that are NOT lifecycle phase transitions. These writes have the same
 * acted-vs-no-op contract as applyLifecycleDecision but explicitly do NOT
 * update the lifecycle comment — coordinator fence labels are sub-phase signals,
 * not authoritative lifecycle phase changes.
 *
 * Returns { acted, noOp, label }.
 */
export async function applyRawLabelDecision({
  prNumber,
  label,
  desired,
  currentlyPresent,
  addLabel,
  removeLabel,
}) {
  if (desired === currentlyPresent) {
    return { acted: false, noOp: true, label, reason: `already-${desired ? 'present' : 'absent'}` };
  }
  if (desired && typeof addLabel === 'function') {
    await addLabel(prNumber, label);
  } else if (!desired && typeof removeLabel === 'function') {
    await removeLabel(prNumber, label);
  }
  return { acted: true, noOp: false, label };
}

/**
 * Format acted-vs-no-op log line. Must be grep-provable.
 * "lifecycle acted: pr=#N phase=queued" or "lifecycle no-op: pr=#N reason=already-in-phase"
 */
export function formatLifecycleOutcome(prNumber, outcome) {
  if (outcome.dryRun) {
    return `lifecycle dry-run: pr=#${prNumber} would-transition-to=${outcome.phase}`;
  }
  if (outcome.noOp) {
    return `lifecycle no-op: pr=#${prNumber} reason=${outcome.reason}`;
  }
  return `lifecycle acted: pr=#${prNumber} phase=${outcome.phase}`;
}

/**
 * Format a raw-label acted-vs-no-op log line. Must be grep-provable.
 */
export function formatRawLabelOutcome(prNumber, outcome) {
  if (outcome.noOp) {
    return `coordinator no-op: pr=#${prNumber} label=${outcome.label} reason=${outcome.reason}`;
  }
  return `coordinator acted: pr=#${prNumber} label=${outcome.label}`;
}

// ---------------------------------------------------------------------------
// Disposition comment rendering helpers
// ---------------------------------------------------------------------------

/**
 * Render the human-decision quarantine comment body.
 *
 * This comment is posted when a PR transitions to QUARANTINED.  It:
 *   - carries QUARANTINE_COMMENT_MARKER so the revival handler can find it;
 *   - summarises the evidence that triggered quarantine;
 *   - gives the PR owner an exact resolve path: comment "KEEP" or "ABANDON".
 *
 * @param {number} prNumber
 * @param {{ reason: string, lastActivity?: string, thresholdDays?: number }} evidence
 * @returns {string} comment body
 */
export function makeQuarantineComment(prNumber, evidence) {
  const reason = compact(evidence?.reason || 'no-activity');
  const lastActivity = evidence?.lastActivity ? ` (last activity: \`${evidence.lastActivity}\`)` : '';
  const thresholdDays = Number(evidence?.thresholdDays) > 0 ? evidence.thresholdDays : null;
  const thresholdNote = thresholdDays ? ` for more than ${thresholdDays} days` : '';

  return [
    QUARANTINE_COMMENT_MARKER,
    `## ⚠ PR #${prNumber} — quarantined pending human decision`,
    '',
    `This PR has been quarantined${thresholdNote}${lastActivity} because it appears likely-superfluous but the redundancy is not deterministically provable.`,
    '',
    `**Evidence:** \`${reason}\``,
    '',
    '**While quarantined, this PR:**',
    '- Is **excluded from all train-blocking positions** (cluster leader, order predecessor, train head)',
    '- Will **not** receive automated repair dispatches',
    '- **Will not** be auto-closed — this waits for you',
    '',
    '**To resolve, the PR owner must post an exact standalone comment:**',
    '- `KEEP` — revive this PR: it re-enters the normal lifecycle as `queued`',
    '- `ABANDON` — close this PR permanently',
    '',
    '_No other text, no quoted text, no other authors, no green CI — only the exact `KEEP` or `ABANDON` command from the PR owner counts._',
    '',
    '_This comment is managed by the authoritative PR-lifecycle owner (D11)._',
  ].join('\n');
}

/**
 * Render the auto-close comment body for a provable duplicate.
 *
 * @param {number} prNumber
 * @param {{ proofRule: string, supersederPr: number|null, reason: string }} proof
 * @returns {string} comment body
 */
export function makeDuplicateCloseComment(prNumber, proof) {
  const ruleLabel = compact(proof?.proofRule || 'unknown');
  const reason = compact(proof?.reason || '');
  const superseder = proof?.supersederPr ? `#${proof.supersederPr}` : 'a previously merged PR';

  const ruleExplanation = {
    'linked-issue-closed-by-sibling':
      `A closing issue of this PR was already closed by ${superseder}, which merged first.`,
    'sibling-merged':
      `A sibling PR (${superseder}) that closes the same issue has already merged.`,
    'empty-diff':
      'This PR\'s diff against its base is empty — all changes are already on `main`.',
  }[ruleLabel] || `Proof rule \`${ruleLabel}\` fired.`;

  return [
    '<!-- crawler-ci-disposition:v1 -->',
    `## PR #${prNumber} — closed as provable duplicate`,
    '',
    `**Reason:** ${ruleExplanation}`,
    ...(reason ? [`**Proof detail:** \`${reason}\``] : []),
    ...(proof?.supersederPr ? [`**Superseded by:** #${proof.supersederPr}`] : []),
    '',
    `Closing automatically via deterministic proof rule \`${ruleLabel}\`.`,
    '_No heuristics were used. If this is incorrect, please re-open and add context._',
  ].join('\n');
}

