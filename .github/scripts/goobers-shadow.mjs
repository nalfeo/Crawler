import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

/**
 * Recognizes only an unquoted, top-level thread-resolution marker. A marker
 * quoted as evidence or with an invalid SHA must not resolve a thread.
 */
export function parseMarkerState(body) {
  const text = normalizeText(body, '');
  if (!text) return 'unresolved';

  const trimmed = text.replace(/^\s+/, '');
  if (!trimmed || /^>/.test(trimmed) || /^["'`]/.test(trimmed)) {
    return 'unresolved';
  }

  if (/^✅\s+Not applicable:\s+\S.*$/i.test(trimmed)) return 'resolved';

  const addressedIn =
    /^✅\s+Addressed in\s+(?:`)?(?:[0-9a-f]{7,40}|https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/commit\/[0-9a-f]{7,40})(?:`)?(?:\s*:\s*|\s+|$)/i;
  if (addressedIn.test(trimmed)) return 'resolved';

  return 'unresolved';
}

function hasResolvedMarker(thread = {}) {
  return (thread.comments ?? []).some((comment) => parseMarkerState(comment.body) === 'resolved');
}

export function legacyMarkerState(reviewThreads = []) {
  if (!reviewThreads.length) return 'none';
  const allResolved = reviewThreads.every((thread) => thread.isResolved === true);
  if (!allResolved) return 'unresolved';
  return reviewThreads.some((thread) => hasResolvedMarker(thread)) ? 'resolved' : 'unresolved';
}

export function shadowMarkerState(reviewThreads = []) {
  if (!reviewThreads.length) return 'none';
  return reviewThreads.every((thread) => {
    if (thread.isResolved !== true) return false;
    return hasResolvedMarker(thread);
  })
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
  const reviewThreads = Array.isArray(trigger.reviewThreads) ? trigger.reviewThreads : [];
  return normalizeDecision({
    workflowName: trigger.workflowName,
    prNumber: trigger.prNumber,
    trigger: trigger.trigger,
    verdict: trigger.conclusion === 'success' ? 'recommended' : 'risky',
    action: trigger.workflowName === 'merge-train' ? 'reconcile-train' : 'reconcile',
    markerState: legacyMarkerState(reviewThreads),
    mutates: false,
    noOp: true,
  });
}

export function replayGoobersDecision(trigger) {
  const reviewThreads = Array.isArray(trigger.reviewThreads) ? trigger.reviewThreads : [];
  return normalizeDecision({
    workflowName: 'goobers-shadow',
    prNumber: trigger.prNumber,
    trigger: trigger.trigger,
    verdict: trigger.conclusion === 'success' ? 'recommended' : 'risky',
    action: trigger.workflowName === 'merge-train' ? 'reconcile-train' : 'reconcile',
    markerState: shadowMarkerState(reviewThreads),
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

export function buildShadowReport({ scope, reportDay, triggers }) {
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
  const decisions = selected.map((trigger) => {
    const comparison = compareLegacyAndGoobers(
      replayLegacyDecision(trigger),
      replayGoobersDecision(trigger),
    );
    return { sourceRunId: trigger.runId, ...comparison };
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
  const scope = normalizeText(
    args.scope ?? process.env.GOOBERS_SHADOW_SCOPE,
    'ci-recovery,merge-train',
  );
  const reportDay = normalizeText(
    args.reportDay ?? process.env.GOOBERS_SHADOW_REPORT_DAY,
    'unknown',
  );
  const report = buildShadowReport({ scope, reportDay, triggers: input.triggers ?? [] });
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
