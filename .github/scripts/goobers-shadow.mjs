import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  extractAddressedMarkerSha,
  hasNotApplicableMarker,
  shouldResolveThread,
} from './ci-recovery/state.mjs';

function normalizeText(value, fallback = 'unknown') {
  const text = typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
  return text || fallback;
}

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, ordered(value[key])]),
    );
  }
  return value;
}

export function normalizeVerdict(value, fallback = 'unknown') {
  const verdict = normalizeText(value, fallback).toLowerCase();
  return ['recommended', 'risky', 'not-recommended', 'unknown'].includes(verdict)
    ? verdict
    : fallback;
}

export function parseMarkerState(body) {
  return extractAddressedMarkerSha(body) || hasNotApplicableMarker(body)
    ? 'resolved'
    : 'unresolved';
}

export function legacyMarkerState(reviewThreads = []) {
  if (!reviewThreads.length) return 'none';
  return reviewThreads.every((thread) => thread.isResolved === true) ? 'resolved' : 'unresolved';
}

export function shadowMarkerState(reviewThreads = [], headSha = '', reachableCommitShas = []) {
  if (!reviewThreads.length) return 'none';
  const reachable = new Set(reachableCommitShas);
  return reviewThreads.every(
    (thread) => thread.isResolved === true || shouldResolveThread(thread, headSha, reachable),
  )
    ? 'resolved'
    : 'unresolved';
}

export function normalizeDecision(rawDecision = {}) {
  const decision = Array.isArray(rawDecision) ? (rawDecision[0] ?? {}) : (rawDecision ?? {});
  return {
    workflowName: normalizeText(decision.workflowName ?? decision.workflow ?? 'legacy'),
    issueNumber: normalizeText(decision.issueNumber ?? decision.issue_number ?? 'n/a'),
    prNumber: normalizeText(decision.prNumber ?? decision.pr_number ?? 'n/a'),
    trigger: normalizeText(decision.trigger ?? decision.event, 'unknown'),
    verdict: normalizeVerdict(
      decision.verdict ?? decision.outcome ?? decision.result ?? decision.status,
    ),
    action: normalizeText(
      decision.action ?? decision.task ?? decision.nextAction ?? decision.decision,
      'noop',
    ),
    markerState: normalizeText(
      decision.markerState ?? decision.marker ?? decision.resolutionStatus,
      'unknown',
    ),
    mutates: Boolean(decision.mutates ?? decision.writes ?? decision.write === true),
    noOp: Boolean(decision.noOp ?? decision.isNoop ?? decision.action === 'noop'),
  };
}

export function makeIdempotencyKey(input = {}) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(ordered(input)))
    .digest('hex')
    .slice(0, 16);
}

export function replayLegacyDecision(trigger) {
  return normalizeDecision(trigger.legacyDecision);
}

const CI_RECOVERY_ACTION_BY_ROW = Object.freeze({
  R03: 'skip-active-shepherd',
  R04: 'release-expired-shepherd',
  R05: 'release-stale-automation-conflict',
  R06: 'skip-merge-train-owned',
  R07: 'skip-ci-conflict-order-wait',
  R08: 'dispatch-conflict-rebase',
  R09: 'wait-conflict-rebase-pending',
  R10: 'wait-conflict-rebase-backoff',
  R11: 'retry-conflict-rebase',
  R26: 'wait-admission',
  R27: 'queue-merge-train',
  R28: 'arm-auto-merge',
  'GC-EXHAUSTED-SKIP': 'skip-stale-automation-exhausted',
  R34: 'release-stale-automation-exhausted',
  'GC-DUPLICATE-WAIT': 'skip-duplicate-fingerprint',
  R33: 'release-stale-automation-retry',
  'GC-COPILOT-PROGRESS': 'skip-active-copilot-progress',
  DISPATCH: 'dispatch-copilot',
});

export function decideGoobersLifecycle(lifecycle = {}) {
  if (lifecycle.kind === 'ci-recovery') {
    const decision = lifecycle.decision ?? {};
    return {
      action: CI_RECOVERY_ACTION_BY_ROW[decision.row] ?? 'unknown',
      blocked: Number(decision.blockerCount) > 0,
    };
  }
  if (lifecycle.kind === 'merge-train') {
    const action = normalizeText(lifecycle.state);
    return { action, blocked: action === 'blocked' || action === 'failure' };
  }
  return { action: 'unknown', blocked: true };
}

export function replayGoobersDecision(trigger) {
  const reviewThreads = Array.isArray(trigger.reviewThreads) ? trigger.reviewThreads : [];
  const lifecycle = decideGoobersLifecycle(trigger.lifecycle);
  return normalizeDecision({
    workflowName: 'goobers-shadow',
    prNumber: trigger.prNumber,
    trigger: trigger.trigger,
    verdict: lifecycle.blocked ? 'risky' : 'recommended',
    action: lifecycle.action,
    markerState: shadowMarkerState(reviewThreads, trigger.headSha, trigger.reachableCommitShas),
    mutates: false,
    noOp: true,
  });
}

export function compareLegacyAndGoobers(legacyDecision, shadowDecision) {
  const legacy = normalizeDecision(legacyDecision);
  const shadow = normalizeDecision(shadowDecision);
  const divergences = ['verdict', 'action', 'markerState', 'mutates']
    .filter((field) => legacy[field] !== shadow[field])
    .map((field) => {
      const label = field === 'markerState' ? 'marker' : field;
      return `${label} mismatch legacy=${legacy[field]} shadow=${shadow[field]}`;
    });

  return {
    parityPassed: divergences.length === 0,
    divergences,
    legacyDecision: legacy,
    shadowDecision: shadow,
    idempotencyKey: makeIdempotencyKey({ legacy, shadow }),
  };
}

export function emitGoobersShadowDecisions(triggers) {
  return triggers.map((trigger) => ({
    sourceRunId: normalizeText(trigger.runId),
    prNumber: normalizeText(trigger.prNumber),
    shadowDecision: replayGoobersDecision(trigger),
  }));
}

export function buildShadowReport({ scope, reportDay, triggers, shadowDecisions = [] }) {
  const requestedWorkflows = scope
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const selected = triggers
    .filter((trigger) => requestedWorkflows.includes(trigger.workflowName))
    .sort((left, right) =>
      [left.workflowName, left.runId, left.prNumber]
        .join(':')
        .localeCompare([right.workflowName, right.runId, right.prNumber].join(':')),
    );
  const coveredWorkflows = [...new Set(selected.map((trigger) => trigger.workflowName))];
  const missingCoverage = requestedWorkflows.filter(
    (workflow) => !coveredWorkflows.includes(workflow),
  );
  const shadowBySource = new Map(
    shadowDecisions.map((decision) => [
      `${normalizeText(decision.sourceRunId)}:${normalizeText(decision.prNumber)}`,
      decision.shadowDecision,
    ]),
  );
  const decisions = selected.map((trigger) => {
    const shadowDecision = shadowBySource.get(
      `${normalizeText(trigger.runId)}:${normalizeText(trigger.prNumber)}`,
    );
    const comparison = compareLegacyAndGoobers(replayLegacyDecision(trigger), shadowDecision ?? {});
    if (!shadowDecision) comparison.divergences.unshift('missing Goobers dry-run decision');
    comparison.parityPassed = comparison.divergences.length === 0;
    return { sourceRunId: trigger.runId, prNumber: trigger.prNumber, ...comparison };
  });
  const divergences = decisions.flatMap((decision) =>
    decision.divergences.map((message) => `run=${decision.sourceRunId} ${message}`),
  );

  return {
    contractVersion: 'v1',
    workflowName: 'goobers-shadow',
    scope,
    reportDay,
    idempotencyKey: makeIdempotencyKey({ scope, reportDay, triggers: selected }),
    parityStatus: divergences.length === 0 && missingCoverage.length === 0 ? 'clean' : 'divergence',
    isReadOnly: true,
    writesAllowed: false,
    representativeCoverage: { requestedWorkflows, coveredWorkflows, missingCoverage },
    decisions,
    divergences: [
      ...missingCoverage.map((workflow) => `missing representative coverage for ${workflow}`),
      ...divergences,
    ],
  };
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    options[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return options;
}

function writeJson(outputPath, payload) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args.input !== 'string') throw new Error('--input is required');
  const input = JSON.parse(fs.readFileSync(args.input, 'utf8'));
  if (args.emitShadow === true) {
    const payload = {
      decisions: JSON.stringify(emitGoobersShadowDecisions(input.triggers ?? [])),
      writesAllowed: false,
    };
    writeJson(normalizeText(args.output ?? 'lifecycle-shadow-result.json'), payload);
    console.log(JSON.stringify({ decisionCount: input.triggers?.length ?? 0 }));
    process.exit(0);
  }
  if (typeof args.shadowInput !== 'string') throw new Error('--shadowInput is required');
  const shadowInput = JSON.parse(fs.readFileSync(args.shadowInput, 'utf8'));
  const scope = normalizeText(
    args.scope ?? process.env.GOOBERS_SHADOW_SCOPE,
    'ci-recovery,merge-train',
  );
  const reportDay = normalizeText(
    args.reportDay ?? process.env.GOOBERS_SHADOW_REPORT_DAY,
    'unknown',
  );
  const report = buildShadowReport({
    scope,
    reportDay,
    triggers: input.triggers ?? [],
    shadowDecisions: shadowInput.decisions ?? [],
  });
  const outputPath = normalizeText(args.output ?? '.goobers-shadow/report.json');
  writeJson(outputPath, report);
  writeJson(path.join(path.dirname(outputPath), 'daily-report.json'), report);
  console.log(
    JSON.stringify({
      outputPath,
      parityStatus: report.parityStatus,
      idempotencyKey: report.idempotencyKey,
    }),
  );
  if (report.parityStatus !== 'clean') process.exitCode = 1;
}
